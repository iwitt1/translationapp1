-- ════════════════════════════════════════════════════════════════════════════════
-- Migration 013 — Phase 2 Step 7: Data deletion (GDPR Right to Erasure)
-- ════════════════════════════════════════════════════════════════════════════════
-- Purpose: the table + RPCs behind the user-initiated account-deletion flow. A user
-- requests erasure → their account is SOFT-deleted immediately (status='deactivated',
-- reversible) → after a grace window a daily sweep HARD-deletes it. The hard delete is
-- the SAME mechanism Step 6 uses: server/lib/deletion.js calls auth.admin.deleteUser(),
-- and the FK chain built in 007/008 does the anonymization for free.
--
-- WHY the schema does the work (no per-table delete logic here):
--   auth.users  --ON DELETE CASCADE (007)-->  profiles
--   profiles    --ON DELETE CASCADE (007)-->  account_identifiers, account_settings
--   profiles    --ON DELETE CASCADE (008)-->  user_linguistic_profiles, user_profile_events
--   messages.sender_id  --ON DELETE SET NULL (008)-->  rows survive, author link severed
-- So deleting the auth.users row wipes all PII + the profile, while message CONTENT and
-- (future) translation pairs remain as de-identified "deleted user" rows. This is the
-- "de-identify, retain" disposition (decisions.md 2026-06-11; architecture.md §7, §11).
--
-- Two-phase with a 30-day grace (decisions.md 2026-06-11):
--   request_account_deletion()  — user RPC: flip status='deactivated', enqueue a request
--                                 with grace_until = now() + grace (default 30 days).
--   cancel_account_deletion()   — user RPC: reverse during the grace window (un-deactivate).
--   list_due_deletion_requests() / claim_deletion_request() / complete_deletion_request()
--                               — service_role helpers the sweep calls (mirror Step 6's
--                                 list/record split). The sweep is Node, not SQL, because
--                                 (a) admin.deleteUser is an auth-schema op owned by Supabase
--                                 and (b) the abuse HMAC's pepper must never enter Postgres.
--
-- Abuse signal (decisions.md 2026-06-11 "Step 7 records the vanished-account HMAC"):
--   On a voluntary erasure the sweep records the same keyed email HMAC as Step 6, REUSING
--   email_hash_abuse + record_abandoned_email_hash() (NO schema change to that table). The
--   abandon_count column therefore counts "times an account on this email hash vanished"
--   (abandonment OR voluntary deletion). Splitting the two signals via a `source` column is
--   parked (parking-lot.md "email_hash_abuse source split") — additive + backfillable later.
--
-- Schema extensions beyond architecture.md §7's sketch (decisions.md 2026-06-11):
--   §7 listed id/user_id/tenant_id/requested_at/completed_at/status/deleted_fields. This adds
--   grace_until (drives the two-phase window), requested_by ('user'|'admin', future admin
--   path), and a 'cancelled' status value (grace-window reversal). All additive.
--
-- What this migration deliberately does NOT do:
--   * No release-username logic and no deletion RPC — same reasons as migration 012.
--   * No corrections anonymization — translation_corrections is NOT BUILT YET (architecture.md
--     §7 "not built yet"). The sweep logs corrections_anonymized:0; wire the real strip-PII
--     pass when that table lands.
--
-- ALTER-over-recreate: data_deletion_requests is NET-NEW (CREATE) — no existing table is
-- recreated. email_hash_abuse is reused as-is (no ALTER).
--
-- Roles: the user RPCs run as the caller (auth.uid()/auth_tenant_id()), so a user can only
-- ever delete THEMSELVES. The sweep helpers are service_role-only (the sweep runs across all
-- tenants, bypassing RLS). Idempotent: CREATE OR REPLACE / IF NOT EXISTS; safe to replay.
-- Staging first; prod replay happens in the Phase 2 cutover (after this step).
-- Ref: architecture.md §7/§11 · policies.md §6 · decisions.md 2026-06-11 · migration 012
-- ════════════════════════════════════════════════════════════════════════════════


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. data_deletion_requests — GDPR erasure request log + audit trail
-- ═════════════════════════════════════════════════════════════════════════════
-- One row per erasure request. The row SURVIVES the hard delete as proof-of-erasure:
-- user_id is FK → profiles ON DELETE SET NULL, so when the cascade wipes the profile the
-- request row stays (status='completed', deleted_fields, tenant_id, timestamps) with a
-- NULL user_id — the null is itself part of the anonymization. If this FK cascaded, the
-- audit record would delete itself. (decisions.md 2026-06-11 "deletion audit row survives".)
CREATE TABLE IF NOT EXISTS public.data_deletion_requests (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SET NULL (not CASCADE): the audit row outlives the user it erased.
  user_id         uuid         REFERENCES public.profiles(id) ON DELETE SET NULL,
  tenant_id       uuid         NOT NULL REFERENCES public.tenants(id),

  requested_at    timestamptz  NOT NULL DEFAULT now(),
  grace_until     timestamptz  NOT NULL,              -- hard delete eligible once now() > this
  completed_at    timestamptz,                        -- set when the sweep finishes the delete

  status          text         NOT NULL DEFAULT 'pending'
    CONSTRAINT data_deletion_requests_status_check
      CHECK (status IN ('pending', 'processing', 'completed', 'cancelled')),
  requested_by    text         NOT NULL DEFAULT 'user'
    CONSTRAINT data_deletion_requests_requested_by_check
      CHECK (requested_by IN ('user', 'admin')),

  deleted_fields  jsonb,                              -- log of WHAT was removed (field names/counts)
  updated_at      timestamptz  NOT NULL DEFAULT now()
);

-- At most ONE open (pending|processing) request per user. Completed/cancelled are excluded,
-- so a user who deletes, is restored as a new signup, and deletes again is fine. NULL user_id
-- rows (post-erasure audit rows) are distinct in a unique index, so they never collide.
CREATE UNIQUE INDEX IF NOT EXISTS data_deletion_requests_one_open_per_user
  ON public.data_deletion_requests (user_id)
  WHERE status IN ('pending', 'processing');

-- Selection index for the sweep: due = pending AND grace elapsed.
CREATE INDEX IF NOT EXISTS data_deletion_requests_due_idx
  ON public.data_deletion_requests (status, grace_until)
  WHERE status = 'pending';

COMMENT ON TABLE public.data_deletion_requests IS
  'GDPR Right-to-Erasure requests (Phase 2 Step 7). Two-phase: deactivate now, hard-delete '
  'after grace_until via the daily sweep. Row survives the delete as audit trail (user_id '
  'SET NULL on cascade). architecture.md §7/§11; decisions.md 2026-06-11.';


-- ── RLS on data_deletion_requests ─────────────────────────────────────────────
-- A user may SEE their own request (to check status) but never write it directly — all
-- writes go through the SECURITY DEFINER RPCs below. Service role bypasses RLS (the sweep).
ALTER TABLE public.data_deletion_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ddr_select_own" ON public.data_deletion_requests;
CREATE POLICY "ddr_select_own" ON public.data_deletion_requests
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- No INSERT/UPDATE/DELETE policies → denied. Belt-and-suspenders: revoke the default
-- table-level write grants so even a policy mistake can't open a direct write path.
REVOKE INSERT, UPDATE, DELETE ON public.data_deletion_requests FROM anon, authenticated;
REVOKE ALL ON public.data_deletion_requests FROM anon;
GRANT  SELECT ON public.data_deletion_requests TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. request_account_deletion(p_grace) — user RPC (enqueue + soft-delete)
-- ═════════════════════════════════════════════════════════════════════════════
-- Caller-scoped: acts on auth.uid() ONLY, so a user can never request deletion of another
-- account. Flips the caller's profile to 'deactivated' (reversible) and enqueues a pending
-- request with grace_until = now() + p_grace. Idempotent: if an open request already exists
-- it is returned unchanged (no duplicate, grace window not reset).
CREATE OR REPLACE FUNCTION public.request_account_deletion(
  p_grace interval DEFAULT interval '30 days'
)
RETURNS public.data_deletion_requests
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_tenant uuid;
  v_row    public.data_deletion_requests;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'request_account_deletion: not authenticated';
  END IF;

  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id = v_uid;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'request_account_deletion: no profile for caller';
  END IF;

  -- Return any existing open request unchanged (idempotent; do not reset the grace clock).
  SELECT * INTO v_row
  FROM public.data_deletion_requests
  WHERE user_id = v_uid AND status IN ('pending', 'processing')
  LIMIT 1;
  IF FOUND THEN
    RETURN v_row;
  END IF;

  -- Soft-delete: account exists but is non-functional. Reversible via cancel within grace.
  UPDATE public.profiles
     SET status = 'deactivated', updated_at = now()
   WHERE id = v_uid;

  INSERT INTO public.data_deletion_requests (user_id, tenant_id, grace_until, requested_by)
  VALUES (v_uid, v_tenant, now() + p_grace, 'user')
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.request_account_deletion(interval) IS
  'Step 7: user requests erasure of THEIR OWN account (auth.uid()). Soft-deletes (status='
  '''deactivated'') and enqueues a pending data_deletion_requests row with a grace window. '
  'Idempotent — returns an existing open request. decisions.md 2026-06-11; policies.md §6.';

REVOKE ALL ON FUNCTION public.request_account_deletion(interval)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.request_account_deletion(interval)
  TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. cancel_account_deletion() — user RPC (reverse during grace)
-- ═════════════════════════════════════════════════════════════════════════════
-- Caller-scoped reversal. Only a 'pending' request can be cancelled — once the sweep has
-- claimed it ('processing') or finished ('completed') the data is already (being) destroyed
-- and there is nothing to restore. Restores the profile to 'active' if onboarding had
-- completed, else 'pending' (mirrors the lifecycle in policies.md §6). Returns true if a
-- request was cancelled, false if there was nothing open to cancel.
CREATE OR REPLACE FUNCTION public.cancel_account_deletion()
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_req_id    uuid;
  v_onboarded timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'cancel_account_deletion: not authenticated';
  END IF;

  SELECT id INTO v_req_id
  FROM public.data_deletion_requests
  WHERE user_id = v_uid AND status = 'pending'
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN false;  -- nothing pending (no request, or already processing/completed)
  END IF;

  UPDATE public.data_deletion_requests
     SET status = 'cancelled', updated_at = now()
   WHERE id = v_req_id;

  SELECT onboarding_completed_at INTO v_onboarded FROM public.profiles WHERE id = v_uid;
  UPDATE public.profiles
     SET status = CASE WHEN v_onboarded IS NOT NULL THEN 'active' ELSE 'pending' END,
         updated_at = now()
   WHERE id = v_uid;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.cancel_account_deletion() IS
  'Step 7: caller reverses their own pending erasure within the grace window — un-deactivates '
  'the profile and marks the request ''cancelled''. No-op (false) if nothing is pending. '
  'Cannot cancel once the sweep has claimed it. decisions.md 2026-06-11.';

REVOKE ALL ON FUNCTION public.cancel_account_deletion()
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.cancel_account_deletion()
  TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. list_due_deletion_requests() — selection (read; service_role)
-- ═════════════════════════════════════════════════════════════════════════════
-- Every pending request whose grace window has elapsed, with the canonical email the sweep
-- needs to hash (LEFT JOIN — may be NULL if the email identifier is already gone; the sweep
-- deletes anyway and skips the hash). request_id is returned so the sweep can claim/complete
-- by PK (user_id goes NULL mid-delete via the cascade). Backed by data_deletion_requests_due_idx.
CREATE OR REPLACE FUNCTION public.list_due_deletion_requests()
RETURNS TABLE (
  request_id      uuid,
  account_id      uuid,
  tenant_id       uuid,
  canonical_email text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    d.id                       AS request_id,
    d.user_id                  AS account_id,
    d.tenant_id                AS tenant_id,
    lower(trim(ai.value))      AS canonical_email
  FROM public.data_deletion_requests d
  LEFT JOIN public.account_identifiers ai
    ON ai.account_id = d.user_id
   AND ai.type   = 'email'
   AND ai.status = 'active'
  WHERE d.status = 'pending'
    AND d.user_id IS NOT NULL
    AND d.grace_until < now()
$$;

COMMENT ON FUNCTION public.list_due_deletion_requests() IS
  'Step 7 deletion sweep: pending erasure requests past their grace window, with canonical '
  'email for the abuse hash. System function — service_role only. decisions.md 2026-06-11.';

REVOKE ALL ON FUNCTION public.list_due_deletion_requests()
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_due_deletion_requests()
  TO service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- 5. claim_deletion_request(p_id) — atomic pending → processing (service_role)
-- ═════════════════════════════════════════════════════════════════════════════
-- Guards against double-processing if two sweeps overlap: the UPDATE only fires when the row
-- is still 'pending', and returns whether THIS call won the claim. Returns false if another
-- run already claimed it (or it was cancelled between selection and claim).
CREATE OR REPLACE FUNCTION public.claim_deletion_request(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_claimed boolean := false;
BEGIN
  UPDATE public.data_deletion_requests
     SET status = 'processing', updated_at = now()
   WHERE id = p_id AND status = 'pending';
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  RETURN v_claimed;
END;
$$;

COMMENT ON FUNCTION public.claim_deletion_request(uuid) IS
  'Step 7 deletion sweep: atomically move a request pending→processing; true if THIS call '
  'won the claim. Prevents double-processing across overlapping runs. service_role only.';

REVOKE ALL ON FUNCTION public.claim_deletion_request(uuid)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_deletion_request(uuid)
  TO service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- 6. complete_deletion_request(p_id, p_deleted_fields) — finalize (service_role)
-- ═════════════════════════════════════════════════════════════════════════════
-- Called after the admin delete succeeds. Stamps status='completed', completed_at, and the
-- deleted_fields audit log. Updated by PK because user_id is already NULL (cascade SET NULL).
CREATE OR REPLACE FUNCTION public.complete_deletion_request(
  p_id             uuid,
  p_deleted_fields jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
  UPDATE public.data_deletion_requests
     SET status         = 'completed',
         completed_at    = now(),
         deleted_fields  = p_deleted_fields,
         updated_at      = now()
   WHERE id = p_id;
$$;

COMMENT ON FUNCTION public.complete_deletion_request(uuid, jsonb) IS
  'Step 7 deletion sweep: finalize a request (completed + completed_at + deleted_fields audit '
  'log) after the hard delete. Updated by PK; user_id is NULL by now (cascade). service_role only.';

REVOKE ALL ON FUNCTION public.complete_deletion_request(uuid, jsonb)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_deletion_request(uuid, jsonb)
  TO service_role;


-- ════════════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after applying on staging)
-- ════════════════════════════════════════════════════════════════════════════════
-- 1. Table + RLS:
--      SELECT relrowsecurity FROM pg_class WHERE oid='public.data_deletion_requests'::regclass;
--      Expect: t (RLS enabled).
--      SELECT polname, cmd FROM pg_policies WHERE tablename='data_deletion_requests';
--      Expect: only ddr_select_own (SELECT). No INSERT/UPDATE/DELETE policy.
--
-- 2. user_id FK is ON DELETE SET NULL (audit row survives the cascade):
--      SELECT confdeltype FROM pg_constraint
--      WHERE conrelid='public.data_deletion_requests'::regclass AND contype='f'
--        AND conname LIKE '%user_id%';
--      Expect: 'n' (SET NULL).  [c=CASCADE would be WRONG here.]
--
-- 3. All six functions exist + SECURITY DEFINER:
--      SELECT proname, prosecdef FROM pg_proc WHERE pronamespace='public'::regnamespace
--        AND proname IN ('request_account_deletion','cancel_account_deletion',
--                        'list_due_deletion_requests','claim_deletion_request',
--                        'complete_deletion_request');
--      Expect: prosecdef=true for all.
--
-- 4. EXECUTE grants split correctly:
--      user RPCs (request/cancel) → authenticated; sweep RPCs (list_due/claim/complete)
--      → service_role only (NEVER anon/authenticated).
--
-- 5. End-to-end is exercised by scripts/deletion-gate-test.mjs (staging only).
-- ════════════════════════════════════════════════════════════════════════════════
