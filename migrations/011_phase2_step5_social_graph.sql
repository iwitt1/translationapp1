-- Migration 011 — Phase 2 Step 5: Social graph + safety primitives
-- Date: 2026-06-10
-- Phase: 2 (Multi-user safety — Step 5)
--
-- What this migration builds:
--   public.relationships        — contact graph; CANONICAL-PAIR model (decisions.md 2026-06-10)
--   public.blocks               — directional block; unblocked_at history + partial unique index
--   public.reports              — spam/abuse/impersonation/other; report RPC auto-creates a block
--   public.invites              — deep-link primitive (contact now; conversation in Phase 3)
--   public.invite_redemptions   — redemption ledger; redeeming a contact invite AUTO-ACCEPTS
--   public.email_hash_abuse     — abandoned-signup abuse monitor (HMAC bytea + key_version);
--                                 WRITES land in Step 6, the TABLE + RLS land here
--   public.active_block_exists()        — bidirectional active-block helper (SECURITY DEFINER)
--   public.request_contact()            — send / re-request / auto-accept-on-reverse a contact
--   public.respond_to_contact()         — accept or decline an incoming pending request
--   public.block_account() / unblock_account()
--   public.report_account()             — atomic report + block (one transaction)
--   public.create_invite() / redeem_invite() / revoke_invite()
--   AMENDED: find_account_by_email(), search_accounts_by_username() (010) now exclude
--            users with an active block in EITHER direction.
--
-- RLS: enabled deny-by-default on every new table.
--   relationships       — SELECT rows where caller is account_lo or account_hi; writes via RPC
--   blocks              — SELECT own (blocker_id = caller) ONLY (the blocked never sees it); RPC writes
--   reports             — SELECT own (reporter_id = caller); RPC writes
--   invites             — SELECT own (created_by = caller); redemption-by-token via RPC; RPC writes
--   invite_redemptions  — SELECT own (redeemed_by = caller); RPC writes
--   email_hash_abuse    — NO authenticated/anon policy at all → fully denied. Service-role only.
--
-- Representation decision (decisions.md 2026-06-10 "Contact-graph representation: canonical pair"):
--   ONE row per unordered pair. account_lo < account_hi (CHECK), UNIQUE(tenant_id, lo, hi).
--   This makes the "one relationship per pair" invariant STRUCTURAL — the glare race (both
--   users hit "add" before either accepts) cannot create two rows, because both adds resolve
--   to the SAME pair row. initiator_id records who asked first (drives the DM-initiation
--   policy's "initiator's handle type" rule and the incoming-vs-outgoing UI distinction).
--
-- Block composition (policies.md §4; decisions.md 2026-06-10 "Symmetric block-hide"):
--   A block is an OVERRIDE LAYER, never a relationship mutation. Blocking an existing contact
--   leaves the relationships row 'accepted'; the block table overrides at query time, and an
--   unblock restores the contact with no resurrection logic. Every initiation path
--   (request_contact, respond_to_contact, redeem_invite) and the two discovery RPCs check
--   active_block_exists() FIRST. Hiding is SYMMETRIC: an active block in either direction
--   removes each user from the other's discovery results.
--
-- Security posture (same as 007/010):
--   - All write paths are SECURITY DEFINER functions owned by the migration runner (postgres),
--     SET search_path = public, EXECUTE granted to `authenticated` only (revoked from public/anon).
--   - The tables enable RLS with SELECT-only policies (or none) → authenticated users cannot
--     INSERT/UPDATE/DELETE directly; only the definer RPCs (which bypass RLS) mutate them.
--   - Every RPC is tenant-scoped via auth_tenant_id(); an unauthenticated caller
--     (auth.uid() NULL → auth_tenant_id() NULL) matches nothing and can mutate nothing.
--   - extensions.gen_random_bytes() is schema-qualified (pgcrypto lives in `extensions` on
--     Supabase; these functions pin search_path = public — see 007 OPUS-FIX #1).
--
-- Migration workflow (operations.md §3):
--   Run on STAGING → pass the Step 5 gate (scripts/social-graph-gate-test.mjs / verification.md)
--   → only then run on PROD. Do NOT run on prod until the staging gate is GREEN.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
--   DROP POLICY IF EXISTS before CREATE POLICY. Safe to re-run after a partial failure.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. relationships — contact graph (canonical-pair model)
-- ═════════════════════════════════════════════════════════════════════════════
-- ONE row per unordered pair {account_lo, account_hi} with account_lo < account_hi.
-- initiator_id is whichever of the two sent the request. state drives the
-- mutual-acceptance machine. via_identifier_type is the initiator's add-time
-- provenance, read by the DM-initiation policy (policies.md §3). 'declined' is kept
-- (soft) so a future re-request cooldown / harassment lever has the state to read.
-- Ref: architecture.md §7 / policies.md §3 / decisions.md 2026-06-10

CREATE TABLE IF NOT EXISTS public.relationships (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL REFERENCES public.tenants(id),
  account_lo           uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  account_hi           uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  initiator_id         uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  state                text        NOT NULL DEFAULT 'pending'
    CONSTRAINT relationships_state_check
      CHECK (state IN ('pending', 'accepted', 'declined')),
  via_identifier_type  text        NOT NULL
    CONSTRAINT relationships_via_check
      CHECK (via_identifier_type IN ('email', 'username', 'phone', 'friend_code', 'invite_link')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- Canonical ordering: the structural guarantee that makes a pair unambiguous.
  CONSTRAINT relationships_canonical_order CHECK (account_lo < account_hi),
  -- The initiator must be one of the two parties.
  CONSTRAINT relationships_initiator_in_pair CHECK (initiator_id IN (account_lo, account_hi)),
  -- One relationship per pair per tenant — the anti-glare guarantee.
  CONSTRAINT relationships_unique_pair UNIQUE (tenant_id, account_lo, account_hi)
);

-- account_lo is the leading column of the unique index (covers lo-side lookups).
-- A second index covers hi-side lookups so "all of X's contacts"
-- (WHERE account_lo = X OR account_hi = X) is index-backed in both positions.
CREATE INDEX IF NOT EXISTS relationships_hi_idx
  ON public.relationships (tenant_id, account_hi);

-- ── RLS on relationships ──────────────────────────────────────────────────────
ALTER TABLE public.relationships ENABLE ROW LEVEL SECURITY;

-- SELECT: either party can read the row (needed for contact list + incoming requests).
DROP POLICY IF EXISTS "relationships_select_party" ON public.relationships;
CREATE POLICY "relationships_select_party" ON public.relationships
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.auth_tenant_id()
    AND (account_lo = auth.uid() OR account_hi = auth.uid())
  );

-- INSERT/UPDATE/DELETE: no policy → denied. All writes go through the RPCs below.


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. blocks — directional block with history
-- ═════════════════════════════════════════════════════════════════════════════
-- Directional (blocker → blocked). unblocked_at NULL = currently active; a non-null
-- value preserves the history rather than deleting the row. The partial unique index
-- prevents a second ACTIVE block of the same target while allowing repeated
-- block/unblock cycles over time. A block is an override layer (see header) — it does
-- not touch the relationships row.
-- Ref: architecture.md §7 / policies.md §4 / decisions.md 2026-06-10

CREATE TABLE IF NOT EXISTS public.blocks (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES public.tenants(id),
  blocker_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  blocked_id    uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  unblocked_at  timestamptz,                 -- NULL = active block
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT blocks_no_self CHECK (blocker_id <> blocked_id)
);

-- No double-active-blocking; allows historical (unblocked) rows to coexist.
CREATE UNIQUE INDEX IF NOT EXISTS blocks_active_unique
  ON public.blocks (blocker_id, blocked_id)
  WHERE unblocked_at IS NULL;

-- Supports the reverse-direction leg of active_block_exists() and "who blocked me".
CREATE INDEX IF NOT EXISTS blocks_blocked_active_idx
  ON public.blocks (blocked_id)
  WHERE unblocked_at IS NULL;

-- ── RLS on blocks ─────────────────────────────────────────────────────────────
ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;

-- SELECT: the BLOCKER only. The blocked party must never be able to learn they were
-- blocked by reading this table (the symmetric-hide UX is enforced in the RPCs +
-- discovery; this policy keeps the raw fact private).
DROP POLICY IF EXISTS "blocks_select_own" ON public.blocks;
CREATE POLICY "blocks_select_own" ON public.blocks
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.auth_tenant_id()
    AND blocker_id = auth.uid()
  );

-- INSERT/UPDATE/DELETE: no policy → denied. block_account / unblock_account own writes.


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. reports
-- ═════════════════════════════════════════════════════════════════════════════
-- Records a report and (via report_account()) auto-creates a block in the same
-- transaction. No moderation-queue UI yet; rows accumulate at status='open' for
-- later review. Multiple reports of the same target are allowed (distinct incidents).
-- Ref: architecture.md §7 / policies.md §4

CREATE TABLE IF NOT EXISTS public.reports (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES public.tenants(id),
  reporter_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reported_id  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reason       text        NOT NULL
    CONSTRAINT reports_reason_check
      CHECK (reason IN ('spam', 'abuse', 'impersonation', 'other')),
  details      text,
  status       text        NOT NULL DEFAULT 'open'
    CONSTRAINT reports_status_check
      CHECK (status IN ('open', 'reviewed', 'actioned', 'dismissed')),
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT reports_no_self CHECK (reporter_id <> reported_id)
);

CREATE INDEX IF NOT EXISTS reports_reported_idx
  ON public.reports (tenant_id, reported_id);

-- ── RLS on reports ────────────────────────────────────────────────────────────
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

-- SELECT: the reporter only (a future moderation tool reads via service role).
DROP POLICY IF EXISTS "reports_select_own" ON public.reports;
CREATE POLICY "reports_select_own" ON public.reports
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.auth_tenant_id()
    AND reporter_id = auth.uid()
  );

-- INSERT/UPDATE/DELETE: no policy → denied. report_account() owns writes.


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. invites + invite_redemptions — deep-link primitive
-- ═════════════════════════════════════════════════════════════════════════════
-- A contact invite is an "add me" link. Redeeming it AUTO-ACCEPTS the contact
-- (decisions.md 2026-06-10): the creator consented by minting the link, the redeemer
-- by clicking — no separate accept handshake. Block checks still apply. The
-- conversation kind is reserved for Phase 3 (target_conversation_id) and rejected by
-- redeem_invite() for now. Defaults at launch: multi-use, no expiry, revocable.
-- Ref: architecture.md §7 / policies.md §2 / decisions.md 2026-06-10

CREATE TABLE IF NOT EXISTS public.invites (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid        NOT NULL REFERENCES public.tenants(id),
  token                  text        NOT NULL,         -- opaque, URL-safe, globally unique
  kind                   text        NOT NULL
    CONSTRAINT invites_kind_check
      CHECK (kind IN ('contact', 'conversation')),
  created_by             uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  target_conversation_id uuid,                          -- Phase 3 (conversation invites)
  max_uses               integer,                       -- NULL = unlimited
  use_count              integer     NOT NULL DEFAULT 0,
  expires_at             timestamptz,                   -- NULL = no expiry
  revoked                boolean     NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invites_token_unique UNIQUE (token),
  CONSTRAINT invites_use_count_nonneg CHECK (use_count >= 0),
  CONSTRAINT invites_max_uses_positive CHECK (max_uses IS NULL OR max_uses > 0)
);

CREATE INDEX IF NOT EXISTS invites_created_by_idx
  ON public.invites (created_by);

CREATE TABLE IF NOT EXISTS public.invite_redemptions (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_id    uuid        NOT NULL REFERENCES public.invites(id) ON DELETE CASCADE,
  redeemed_by  uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  redeemed_at  timestamptz NOT NULL DEFAULT now(),

  -- A given user redeems a given invite at most once (re-clicks are no-ops, not re-adds).
  CONSTRAINT invite_redemptions_unique UNIQUE (invite_id, redeemed_by)
);

CREATE INDEX IF NOT EXISTS invite_redemptions_redeemed_by_idx
  ON public.invite_redemptions (redeemed_by);

-- ── RLS on invites ────────────────────────────────────────────────────────────
ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;

-- SELECT: the creator only. Redemption is by TOKEN through redeem_invite() (definer),
-- so a redeemer never needs (and never gets) a direct SELECT on someone else's invite
-- — which also prevents token/invite enumeration via the table.
DROP POLICY IF EXISTS "invites_select_own" ON public.invites;
CREATE POLICY "invites_select_own" ON public.invites
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.auth_tenant_id()
    AND created_by = auth.uid()
  );

-- INSERT/UPDATE/DELETE: no policy → denied. create_invite / revoke_invite own writes.

-- ── RLS on invite_redemptions ─────────────────────────────────────────────────
ALTER TABLE public.invite_redemptions ENABLE ROW LEVEL SECURITY;

-- SELECT: the redeemer only (Phase-3 "who joined" for the creator can be added later).
DROP POLICY IF EXISTS "invite_redemptions_select_own" ON public.invite_redemptions;
CREATE POLICY "invite_redemptions_select_own" ON public.invite_redemptions
  FOR SELECT TO authenticated
  USING (redeemed_by = auth.uid());

-- INSERT/UPDATE/DELETE: no policy → denied. redeem_invite() owns writes.


-- ═════════════════════════════════════════════════════════════════════════════
-- 5. email_hash_abuse — abandoned-signup abuse monitor (table only; writes in Step 6)
-- ═════════════════════════════════════════════════════════════════════════════
-- Stores a KEYED hash (HMAC-SHA256) of an abandoned signup's canonical email — never
-- the plaintext — so repeat-abandon / signup-spam is detectable without retaining
-- deleted-user PII (policies.md §6). Decisions (decisions.md 2026-06-10 "email_hash:
-- versioned HMAC, computed in the job layer"):
--   - The HMAC is computed in the Step 6 ABANDONMENT JOB (Node `crypto`), with the
--     pepper read from an env secret. The pepper NEVER enters Postgres — the DB stores
--     only the resulting bytes. Even a full DB compromise does not expose the key.
--   - key_version supports pepper rotation: bump it and re-key forward; old rows stay
--     readable within their version. Losing the pepper is low-stakes here (this table
--     is advisory-only; nothing joins on it) — at worst the spam-correlation window
--     resets. Versioning makes rotation/partial-loss a non-event.
-- WRITES are wired in Step 6; this migration creates only the table + RLS so all the
-- safety tables live in one place (architecture.md "build the schema before features
-- fill it").
-- Ref: architecture.md §7 / policies.md §6 / decisions.md 2026-06-10

CREATE TABLE IF NOT EXISTS public.email_hash_abuse (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES public.tenants(id),
  email_hash    bytea       NOT NULL,                 -- HMAC-SHA256(canonical_email, pepper)
  key_version   smallint    NOT NULL DEFAULT 1,       -- supports pepper rotation
  first_seen    timestamptz NOT NULL DEFAULT now(),
  last_seen     timestamptz NOT NULL DEFAULT now(),
  abandon_count integer     NOT NULL DEFAULT 1,

  CONSTRAINT email_hash_abuse_count_positive CHECK (abandon_count >= 1),
  CONSTRAINT email_hash_abuse_unique UNIQUE (tenant_id, email_hash, key_version)
);

-- ── RLS on email_hash_abuse ───────────────────────────────────────────────────
-- Enabled with NO policy for authenticated/anon → every client read/write is denied.
-- Only the service role (which bypasses RLS) touches this table, via the Step 6 job.
ALTER TABLE public.email_hash_abuse ENABLE ROW LEVEL SECURITY;
-- Belt-and-suspenders: revoke any default table grants the client roles may hold, so
-- access is denied at the privilege layer too, not only by the absence of a policy.
REVOKE ALL ON public.email_hash_abuse FROM anon, authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 6. active_block_exists(a, b) — bidirectional active-block helper
-- ═════════════════════════════════════════════════════════════════════════════
-- Returns true iff an ACTIVE block (unblocked_at IS NULL) exists in EITHER direction
-- between two accounts in the caller's tenant. SECURITY DEFINER so it can read the
-- blocks table regardless of RLS (the blocks SELECT policy is blocker-only, but this
-- check must see both directions). Tenant-scoped via auth_tenant_id(); returns false
-- for an unauthenticated caller. Used by every initiation path and the discovery RPCs.
CREATE OR REPLACE FUNCTION public.active_block_exists(p_a uuid, p_b uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.blocks
    WHERE tenant_id = public.auth_tenant_id()
      AND unblocked_at IS NULL
      AND ( (blocker_id = p_a AND blocked_id = p_b)
         OR (blocker_id = p_b AND blocked_id = p_a) )
  )
$$;

COMMENT ON FUNCTION public.active_block_exists(uuid, uuid) IS
  'True iff an active block exists in either direction between two accounts in the '
  'caller''s tenant. SECURITY DEFINER (reads blocks past its blocker-only RLS). '
  'Used by request_contact/respond_to_contact/redeem_invite and the discovery RPCs.';

REVOKE ALL ON FUNCTION public.active_block_exists(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.active_block_exists(uuid, uuid) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 7. request_contact(p_target, p_via) — send / re-request / auto-accept-on-reverse
-- ═════════════════════════════════════════════════════════════════════════════
-- The single entry point for "add a contact." Resolves to the canonical pair row and:
--   - no row            → insert pending (initiator = caller)            → 'pending'
--   - pending by caller → error (already requested)
--   - pending by target → this is mutual interest → accept              → 'accepted'
--   - accepted          → error (already contacts)
--   - declined          → re-request: reset to pending (initiator=caller) → 'pending'
-- p_via is the discovery provenance (email/username/phone/friend_code). invite_link is
-- set only by redeem_invite(), never here. Block-checked first (both directions).
CREATE OR REPLACE FUNCTION public.request_contact(p_target uuid, p_via text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_tenant    uuid := public.auth_tenant_id();
  v_lo        uuid;
  v_hi        uuid;
  v_state     text;
  v_initiator uuid;
BEGIN
  IF v_uid IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'request_contact: not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_target IS NULL OR p_target = v_uid THEN
    RAISE EXCEPTION 'request_contact: invalid target';
  END IF;
  IF p_via NOT IN ('email', 'username', 'phone', 'friend_code') THEN
    RAISE EXCEPTION 'request_contact: invalid via_identifier_type %', p_via;
  END IF;

  -- Target must be an active profile in the caller's tenant (cross-tenant = not found).
  PERFORM 1 FROM public.profiles
   WHERE id = p_target AND tenant_id = v_tenant AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_contact: target not found';
  END IF;

  -- Block gate (either direction) — same opaque error so neither side leaks.
  IF public.active_block_exists(v_uid, p_target) THEN
    RAISE EXCEPTION 'request_contact: cannot add this user';
  END IF;

  v_lo := least(v_uid, p_target);
  v_hi := greatest(v_uid, p_target);

  -- Lock the pair row if it exists, so concurrent adds serialize on it.
  SELECT state, initiator_id INTO v_state, v_initiator
  FROM public.relationships
  WHERE tenant_id = v_tenant AND account_lo = v_lo AND account_hi = v_hi
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.relationships
      (tenant_id, account_lo, account_hi, initiator_id, state, via_identifier_type)
    VALUES
      (v_tenant, v_lo, v_hi, v_uid, 'pending', p_via);
    RETURN 'pending';
  END IF;

  IF v_state = 'accepted' THEN
    RAISE EXCEPTION 'request_contact: already contacts';
  ELSIF v_state = 'pending' THEN
    IF v_initiator = v_uid THEN
      RAISE EXCEPTION 'request_contact: request already pending';
    ELSE
      -- The target had already requested the caller → mutual → accept.
      UPDATE public.relationships
         SET state = 'accepted', updated_at = now()
       WHERE tenant_id = v_tenant AND account_lo = v_lo AND account_hi = v_hi;
      RETURN 'accepted';
    END IF;
  ELSE  -- 'declined' → allow a fresh request from the caller
    UPDATE public.relationships
       SET state = 'pending', initiator_id = v_uid,
           via_identifier_type = p_via, updated_at = now()
     WHERE tenant_id = v_tenant AND account_lo = v_lo AND account_hi = v_hi;
    RETURN 'pending';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.request_contact(uuid, text) IS
  'Add-a-contact entry point on the canonical-pair model. Inserts/updates the single '
  'pair row: new→pending, reverse-pending→accepted (mutual), declined→pending (re-request). '
  'Block-checked both directions; SECURITY DEFINER; tenant-scoped.';

REVOKE ALL ON FUNCTION public.request_contact(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.request_contact(uuid, text) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 8. respond_to_contact(p_other, p_accept) — accept/decline an incoming request
-- ═════════════════════════════════════════════════════════════════════════════
-- The explicit answer to a pending request the OTHER party initiated. Caller must be
-- the addressee (initiator <> caller) of a 'pending' row. Accept → 'accepted';
-- decline → 'declined' (kept soft). Block-checked (a blocked user cannot be accepted).
CREATE OR REPLACE FUNCTION public.respond_to_contact(p_other uuid, p_accept boolean)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_tenant    uuid := public.auth_tenant_id();
  v_lo        uuid;
  v_hi        uuid;
  v_state     text;
  v_initiator uuid;
  v_new       text;
BEGIN
  IF v_uid IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'respond_to_contact: not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_other IS NULL OR p_other = v_uid THEN
    RAISE EXCEPTION 'respond_to_contact: invalid target';
  END IF;

  v_lo := least(v_uid, p_other);
  v_hi := greatest(v_uid, p_other);

  SELECT state, initiator_id INTO v_state, v_initiator
  FROM public.relationships
  WHERE tenant_id = v_tenant AND account_lo = v_lo AND account_hi = v_hi
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'respond_to_contact: no request to respond to';
  END IF;
  IF v_state <> 'pending' THEN
    RAISE EXCEPTION 'respond_to_contact: request is not pending (state=%)', v_state;
  END IF;
  IF v_initiator = v_uid THEN
    RAISE EXCEPTION 'respond_to_contact: cannot respond to your own request';
  END IF;

  IF p_accept THEN
    IF public.active_block_exists(v_uid, p_other) THEN
      RAISE EXCEPTION 'respond_to_contact: cannot accept this user';
    END IF;
    v_new := 'accepted';
  ELSE
    v_new := 'declined';
  END IF;

  UPDATE public.relationships
     SET state = v_new, updated_at = now()
   WHERE tenant_id = v_tenant AND account_lo = v_lo AND account_hi = v_hi;

  RETURN v_new;
END;
$$;

COMMENT ON FUNCTION public.respond_to_contact(uuid, boolean) IS
  'Accept or decline an incoming pending contact request (caller must be the addressee). '
  'Accept is block-checked; decline keeps the row soft. SECURITY DEFINER; tenant-scoped.';

REVOKE ALL ON FUNCTION public.respond_to_contact(uuid, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.respond_to_contact(uuid, boolean) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 9. block_account(p_target) / unblock_account(p_target)
-- ═════════════════════════════════════════════════════════════════════════════
-- block_account is idempotent: a second call while a block is active is a no-op.
-- Blocking does NOT mutate the relationships row (override-layer semantics). unblock
-- stamps unblocked_at on the active row (history preserved), restoring contact/DM.
CREATE OR REPLACE FUNCTION public.block_account(p_target uuid)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_tenant uuid := public.auth_tenant_id();
BEGIN
  IF v_uid IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'block_account: not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_target IS NULL OR p_target = v_uid THEN
    RAISE EXCEPTION 'block_account: invalid target';
  END IF;
  PERFORM 1 FROM public.profiles WHERE id = p_target AND tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'block_account: target not found';
  END IF;

  -- No-op if already actively blocked (the partial unique index also backstops a race).
  IF EXISTS (
    SELECT 1 FROM public.blocks
    WHERE blocker_id = v_uid AND blocked_id = p_target AND unblocked_at IS NULL
  ) THEN
    RETURN 'already_blocked';
  END IF;

  INSERT INTO public.blocks (tenant_id, blocker_id, blocked_id)
  VALUES (v_tenant, v_uid, p_target);
  RETURN 'blocked';

EXCEPTION
  WHEN unique_violation THEN  -- lost race against a concurrent identical block
    RETURN 'already_blocked';
END;
$$;

COMMENT ON FUNCTION public.block_account(uuid) IS
  'Create an active block (caller → target), idempotent. Does not mutate the '
  'relationships row — a block is an override layer. SECURITY DEFINER; tenant-scoped.';

CREATE OR REPLACE FUNCTION public.unblock_account(p_target uuid)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_tenant uuid := public.auth_tenant_id();
  v_n      integer;
BEGIN
  IF v_uid IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'unblock_account: not authenticated' USING ERRCODE = '28000';
  END IF;

  UPDATE public.blocks
     SET unblocked_at = now()
   WHERE blocker_id = v_uid AND blocked_id = p_target AND unblocked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  RETURN CASE WHEN v_n > 0 THEN 'unblocked' ELSE 'not_blocked' END;
END;
$$;

COMMENT ON FUNCTION public.unblock_account(uuid) IS
  'Stamp unblocked_at on the caller''s active block of the target (history preserved). '
  'SECURITY DEFINER; tenant-scoped.';

REVOKE ALL ON FUNCTION public.block_account(uuid)   FROM public, anon;
REVOKE ALL ON FUNCTION public.unblock_account(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.block_account(uuid)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.unblock_account(uuid) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 10. report_account(p_target, p_reason, p_details) — atomic report + block
-- ═════════════════════════════════════════════════════════════════════════════
-- Records the report AND ensures an active block in ONE transaction (both or neither).
-- If a block is already active, the report still records and the block insert is a
-- no-op. The UI surfaces the "you are also blocking them" consequence (decisions.md).
CREATE OR REPLACE FUNCTION public.report_account(
  p_target  uuid,
  p_reason  text,
  p_details text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_tenant uuid := public.auth_tenant_id();
  v_report uuid;
BEGIN
  IF v_uid IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'report_account: not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_target IS NULL OR p_target = v_uid THEN
    RAISE EXCEPTION 'report_account: invalid target';
  END IF;
  IF p_reason NOT IN ('spam', 'abuse', 'impersonation', 'other') THEN
    RAISE EXCEPTION 'report_account: invalid reason %', p_reason;
  END IF;
  PERFORM 1 FROM public.profiles WHERE id = p_target AND tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'report_account: target not found';
  END IF;

  INSERT INTO public.reports (tenant_id, reporter_id, reported_id, reason, details)
  VALUES (v_tenant, v_uid, p_target, p_reason, p_details)
  RETURNING id INTO v_report;

  -- Auto-block (idempotent). Same transaction → report+block are atomic.
  IF NOT EXISTS (
    SELECT 1 FROM public.blocks
    WHERE blocker_id = v_uid AND blocked_id = p_target AND unblocked_at IS NULL
  ) THEN
    INSERT INTO public.blocks (tenant_id, blocker_id, blocked_id)
    VALUES (v_tenant, v_uid, p_target)
    ON CONFLICT DO NOTHING;  -- partial unique index; lost-race safety
  END IF;

  RETURN v_report;
END;
$$;

COMMENT ON FUNCTION public.report_account(uuid, text, text) IS
  'Record a report and ensure an active block in one transaction (atomic). '
  'Multiple reports of the same target are allowed. SECURITY DEFINER; tenant-scoped.';

REVOKE ALL ON FUNCTION public.report_account(uuid, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.report_account(uuid, text, text) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 11. create_invite / redeem_invite / revoke_invite
-- ═════════════════════════════════════════════════════════════════════════════
-- create_invite mints an opaque URL-safe token (base64url of 16 random bytes).
-- Defaults: multi-use (max_uses NULL), no expiry (expires_at NULL), revocable.
CREATE OR REPLACE FUNCTION public.create_invite(
  p_kind       text DEFAULT 'contact',
  p_max_uses   integer DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_tenant uuid := public.auth_tenant_id();
  v_token  text;
  v_try    integer := 0;
BEGIN
  IF v_uid IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'create_invite: not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_kind <> 'contact' THEN
    -- 'conversation' invites are Phase 3 (need target_conversation_id + membership).
    RAISE EXCEPTION 'create_invite: only contact invites are supported in Phase 2';
  END IF;
  IF p_max_uses IS NOT NULL AND p_max_uses < 1 THEN
    RAISE EXCEPTION 'create_invite: max_uses must be >= 1 or NULL';
  END IF;

  LOOP
    v_try := v_try + 1;
    IF v_try > 5 THEN
      RAISE EXCEPTION 'create_invite: failed to generate a unique token';
    END IF;
    -- base64url: base64 with +/ → -_ and '=' padding stripped.
    v_token := replace(replace(replace(
                 encode(extensions.gen_random_bytes(16), 'base64'),
                 '+', '-'), '/', '_'), '=', '');
    BEGIN
      INSERT INTO public.invites (tenant_id, token, kind, created_by, max_uses, expires_at)
      VALUES (v_tenant, v_token, 'contact', v_uid, p_max_uses, p_expires_at);
      EXIT;  -- success
    EXCEPTION
      WHEN unique_violation THEN
        CONTINUE;  -- token collision (astronomically rare) → retry
    END;
  END LOOP;

  RETURN v_token;
END;
$$;

COMMENT ON FUNCTION public.create_invite(text, integer, timestamptz) IS
  'Mint a contact invite with an opaque base64url token. Defaults multi-use, no expiry, '
  'revocable. Returns the token. SECURITY DEFINER; tenant-scoped.';

-- redeem_invite: validate the token, record the redemption, and AUTO-ACCEPT the
-- contact with the creator (via_identifier_type='invite_link'). Block-checked.
CREATE OR REPLACE FUNCTION public.redeem_invite(p_token text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_tenant  uuid := public.auth_tenant_id();
  v_inv     public.invites%ROWTYPE;
  v_lo      uuid;
  v_hi      uuid;
  v_state   text;
BEGIN
  IF v_uid IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'redeem_invite: not authenticated' USING ERRCODE = '28000';
  END IF;

  -- Look up + lock the invite by token (definer rights — bypasses invites RLS).
  SELECT * INTO v_inv FROM public.invites WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'redeem_invite: invalid invite';
  END IF;
  IF v_inv.tenant_id <> v_tenant THEN
    RAISE EXCEPTION 'redeem_invite: invalid invite';  -- cross-tenant = opaque not-found
  END IF;
  IF v_inv.kind <> 'contact' THEN
    RAISE EXCEPTION 'redeem_invite: only contact invites are supported in Phase 2';
  END IF;
  IF v_inv.revoked THEN
    RAISE EXCEPTION 'redeem_invite: invite revoked';
  END IF;
  IF v_inv.expires_at IS NOT NULL AND v_inv.expires_at <= now() THEN
    RAISE EXCEPTION 'redeem_invite: invite expired';
  END IF;
  IF v_inv.max_uses IS NOT NULL AND v_inv.use_count >= v_inv.max_uses THEN
    RAISE EXCEPTION 'redeem_invite: invite fully used';
  END IF;
  IF v_inv.created_by = v_uid THEN
    RAISE EXCEPTION 'redeem_invite: cannot redeem your own invite';
  END IF;

  -- Block gate (either direction) between redeemer and creator.
  IF public.active_block_exists(v_uid, v_inv.created_by) THEN
    RAISE EXCEPTION 'redeem_invite: cannot add this user';
  END IF;

  -- Record the redemption (one per user per invite). A re-click is a no-op, not a re-add.
  BEGIN
    INSERT INTO public.invite_redemptions (invite_id, redeemed_by)
    VALUES (v_inv.id, v_uid);
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'redeem_invite: already redeemed';
  END;

  UPDATE public.invites SET use_count = use_count + 1 WHERE id = v_inv.id;

  -- Auto-accept the contact with the creator (canonical pair).
  v_lo := least(v_uid, v_inv.created_by);
  v_hi := greatest(v_uid, v_inv.created_by);

  SELECT state INTO v_state FROM public.relationships
  WHERE tenant_id = v_tenant AND account_lo = v_lo AND account_hi = v_hi
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.relationships
      (tenant_id, account_lo, account_hi, initiator_id, state, via_identifier_type)
    VALUES
      (v_tenant, v_lo, v_hi, v_inv.created_by, 'accepted', 'invite_link');
  ELSIF v_state <> 'accepted' THEN
    -- pending or declined → minting+clicking is mutual consent → accept now.
    UPDATE public.relationships
       SET state = 'accepted', via_identifier_type = 'invite_link', updated_at = now()
     WHERE tenant_id = v_tenant AND account_lo = v_lo AND account_hi = v_hi;
  END IF;

  RETURN 'accepted';
END;
$$;

COMMENT ON FUNCTION public.redeem_invite(text) IS
  'Redeem a contact invite by token: records the redemption (one per user) and '
  'auto-accepts the contact with the creator (via_identifier_type=invite_link). '
  'Block-checked; SECURITY DEFINER; tenant-scoped.';

CREATE OR REPLACE FUNCTION public.revoke_invite(p_invite_id uuid)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_n   integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'revoke_invite: not authenticated' USING ERRCODE = '28000';
  END IF;
  UPDATE public.invites SET revoked = true
   WHERE id = p_invite_id AND created_by = v_uid AND revoked = false;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN CASE WHEN v_n > 0 THEN 'revoked' ELSE 'noop' END;
END;
$$;

COMMENT ON FUNCTION public.revoke_invite(uuid) IS
  'Revoke an invite the caller created (no further redemptions). SECURITY DEFINER.';

REVOKE ALL ON FUNCTION public.create_invite(text, integer, timestamptz) FROM public, anon;
REVOKE ALL ON FUNCTION public.redeem_invite(text)                        FROM public, anon;
REVOKE ALL ON FUNCTION public.revoke_invite(uuid)                        FROM public, anon;
GRANT EXECUTE ON FUNCTION public.create_invite(text, integer, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.redeem_invite(text)                       TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_invite(uuid)                       TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 12. AMEND 010 discovery RPCs — exclude blocked users (symmetric hide)
-- ═════════════════════════════════════════════════════════════════════════════
-- The Step 4 RPCs were built before blocks existed and returned blocked users. Now
-- that blocks land, discovery must hide any user with an active block in EITHER
-- direction (decisions.md 2026-06-10 "Symmetric block-hide"). This is a behavior
-- change to shipped functions → re-run the Step 4 gate after this migration to prove
-- no regression. The bodies are otherwise identical to 010; only the block clause is
-- added. (CREATE OR REPLACE keeps the existing grants intact, but we re-assert them.)

CREATE OR REPLACE FUNCTION public.find_account_by_email(p_email text)
RETURNS TABLE (account_id uuid, display_name text, username text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p.id, p.display_name, p.username
  FROM public.account_identifiers ai
  JOIN public.profiles p          ON p.id = ai.account_id
  JOIN public.account_settings s  ON s.account_id = p.id
  WHERE ai.tenant_id = public.auth_tenant_id()
    AND ai.type      = 'email'
    AND ai.status    = 'active'
    AND ai.value     = lower(btrim(p_email))
    AND p.status     = 'active'
    AND p.id        <> auth.uid()
    AND s.discoverable_by_email = true
    AND NOT public.active_block_exists(auth.uid(), p.id)   -- 011: hide blocked users
  LIMIT 1
$$;

COMMENT ON FUNCTION public.find_account_by_email(text) IS
  'Phase 2 Step 4 discovery (amended in 011): exact-match add by email. SECURITY DEFINER; '
  'returns only public handles (id, display_name, username) — never email/phone/other. '
  'Exact canonical equality only; tenant-scoped; respects discoverable_by_email; active '
  'profiles only; excludes the caller; excludes users with an active block (either direction).';

CREATE OR REPLACE FUNCTION public.search_accounts_by_username(
  p_prefix text,
  p_limit  integer DEFAULT 10
)
RETURNS TABLE (account_id uuid, display_name text, username text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_prefix text := lower(btrim(p_prefix));
  v_like   text;
  v_limit  integer := least(greatest(coalesce(p_limit, 10), 1), 20);
BEGIN
  IF length(v_prefix) < 3 THEN
    RETURN;
  END IF;

  v_like := replace(replace(replace(v_prefix, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  RETURN QUERY
  SELECT p.id, p.display_name, p.username
  FROM public.account_identifiers ai
  JOIN public.profiles p          ON p.id = ai.account_id
  JOIN public.account_settings s  ON s.account_id = p.id
  WHERE ai.tenant_id = public.auth_tenant_id()
    AND ai.type      = 'username'
    AND ai.status    = 'active'
    AND ai.value LIKE v_like ESCAPE '\'
    AND p.status     = 'active'
    AND p.id        <> auth.uid()
    AND s.discoverable_by_username = true
    AND NOT public.active_block_exists(auth.uid(), p.id)   -- 011: hide blocked users
  ORDER BY ai.value
  LIMIT v_limit;
END;
$$;

COMMENT ON FUNCTION public.search_accounts_by_username(text, integer) IS
  'Phase 2 Step 4 discovery (amended in 011): username autocomplete (prefix). SECURITY DEFINER; '
  'returns only public handles. Min prefix 3, cap 20, LIKE escaped; tenant-scoped; respects '
  'discoverable_by_username; active profiles only; excludes the caller; excludes users with an '
  'active block (either direction).';

-- Re-assert grants (CREATE OR REPLACE preserves them, but be explicit/idempotent).
REVOKE ALL ON FUNCTION public.find_account_by_email(text)                FROM public, anon;
REVOKE ALL ON FUNCTION public.search_accounts_by_username(text, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.find_account_by_email(text)                TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_accounts_by_username(text, integer) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- Verification queries (run on staging after migration; full gate in verification.md
-- + scripts/social-graph-gate-test.mjs)
-- ═════════════════════════════════════════════════════════════════════════════
-- The behavioral gate must run as REAL authenticated users (anon key + JWT), never the
-- postgres/service role (which bypasses RLS and would mask a leak). Structural checks
-- below can run in the SQL editor.
--
-- 1. New tables present + RLS enabled
--    SELECT relname, relrowsecurity FROM pg_class
--    WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
--      AND relname IN ('relationships','blocks','reports','invites',
--                      'invite_redemptions','email_hash_abuse');
--    Expect: 6 rows, relrowsecurity = true for all.
--
-- 2. RPCs exist + SECURITY DEFINER
--    SELECT proname, prosecdef FROM pg_proc
--    WHERE pronamespace = 'public'::regnamespace
--      AND proname IN ('active_block_exists','request_contact','respond_to_contact',
--                      'block_account','unblock_account','report_account',
--                      'create_invite','redeem_invite','revoke_invite');
--    Expect: 9 rows, prosecdef = true for all.
--
-- 3. EXECUTE granted to authenticated, not anon (spot-check)
--    SELECT routine_name, grantee, privilege_type FROM information_schema.routine_privileges
--    WHERE routine_schema = 'public'
--      AND routine_name IN ('request_contact','block_account','report_account',
--                           'create_invite','redeem_invite')
--    ORDER BY routine_name, grantee;
--    Expect: 'authenticated' has EXECUTE; no 'anon' row.
--
-- 4. Canonical-order + partial-unique constraints present
--    SELECT conname FROM pg_constraint
--    WHERE conrelid = 'public.relationships'::regclass
--      AND conname IN ('relationships_canonical_order','relationships_initiator_in_pair',
--                      'relationships_unique_pair');
--    SELECT indexname FROM pg_indexes
--    WHERE schemaname='public' AND tablename='blocks' AND indexname='blocks_active_unique';
--
-- 5. email_hash_abuse denied to clients
--    SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_schema='public' AND table_name='email_hash_abuse'
--      AND grantee IN ('anon','authenticated');
--    Expect: no rows (REVOKEd) — and RLS has no policy → fully denied.
--
-- 6. Behavioral gate (as authenticated users A, B in tenant 1; C in tenant 2):
--    a. request_contact(A→B,'username')      → 'pending'; B sees an incoming pending row.
--    b. request_contact(A→B) again as A      → error 'request already pending'.
--    c. respond_to_contact(B, accept=true)   → 'accepted'; one row, state accepted.
--    d. request_contact(B→A) when A→B pending → 'accepted' (reverse-request shortcut).
--    e. block_account(A→B) then request_contact / respond → denied both directions.
--    f. discovery: with A↔B active block, search/email return 0 rows for the other.
--    g. unblock_account(A→B) → discovery + add work again.
--    h. report_account(A→B,'spam') → report row open AND active block exists (atomic).
--    i. create_invite() as A → token; redeem_invite(token) as B → 'accepted' contact,
--       via_identifier_type='invite_link'; second redeem by B → 'already redeemed';
--       redeem own invite as A → error.
--    j. revoke_invite then redeem → 'invite revoked'. expired/max_uses likewise rejected.
--    k. cross-tenant: C cannot redeem A's invite; C cannot request_contact A (not found).
