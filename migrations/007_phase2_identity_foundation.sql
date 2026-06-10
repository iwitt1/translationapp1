-- Migration 007 — Phase 2 Step 1: Identity Foundation
-- Date: 2026-06-09
-- Phase: 2 (Multi-user safety — Step 1)
--
-- What this migration builds:
--   tenants.dm_initiation_policy   — per-tenant DM-initiation override column
--   public.auth_tenant_id()        — SECURITY DEFINER helper for RLS (avoids policy recursion)
--   public.profiles                — replaces user_profiles; id = auth.users.id (uuid)
--   public.account_identifiers     — normalized discovery handles + reserved-word seeds
--   public.account_settings        — per-user privacy preferences (1:1 with profiles)
--   public.handle_new_user()       — trigger function: creates pending profile on auth.users INSERT
--   trigger on_auth_user_created   — fires handle_new_user() on auth.users INSERT
--
-- RLS: enabled deny-by-default on all three new tables.
--   profiles             — SELECT any same-tenant authenticated user; UPDATE own row only
--   account_identifiers  — SELECT own rows only (email is private; handle minimization)
--   account_settings     — SELECT + UPDATE own row only
--   No INSERT/DELETE policies → denied for authenticated users on all three tables
--
-- What this migration does NOT change:
--   messages.sender_id          — still text; changes in Step 2 coordinated cutover
--   user_linguistic_profiles    — user_id still text; Step 2
--   user_profile_events         — user_id still text; Step 2
--   user_profiles               — kept until Step 2 frontend update drops it
--   RLS on existing tables      — messages, user_profiles, etc. get RLS in Step 3
--
-- Migration workflow (operations.md §3):
--   Run on STAGING → verify Step 1 gate (verification.md) → run on PROD.
--   Do NOT run on prod until the Step 1 gate passes on staging.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- REVISION NOTE — 2026-06-09, Opus (Cowork) pre-run review. READ BEFORE CONTINUING.
-- ═════════════════════════════════════════════════════════════════════════════
-- Sonnet drafted this migration; Opus reviewed it before its first run and made
-- three changes. Each change site is tagged "[OPUS-FIX #n]" inline — search for
-- that tag to find them. Context so the Sonnet session is fully caught up:
--
-- [OPUS-FIX #1] gen_random_bytes() schema-qualified in handle_new_user().
--   pgcrypto lives in the `extensions` schema on Supabase — CONFIRMED:
--     SELECT extnamespace::regnamespace FROM pg_extension WHERE extname='pgcrypto';
--     → extensions
--   This function pins SET search_path = public (correct hardening for a SECURITY
--   DEFINER function). With that pin, an UNqualified gen_random_bytes() resolves to
--   nothing → "function gen_random_bytes(integer) does not exist" → the trigger
--   raises → because it's an AFTER INSERT trigger in the same txn, the auth.users
--   INSERT rolls back → EVERY signup fails. Fix: call extensions.gen_random_bytes(4)
--   fully-qualified, and KEEP search_path = public (we qualify the one cross-schema
--   call rather than widening the path, which would expose other extension funcs).
--   Note: gen_random_uuid() in the account_identifiers DEFAULT is core Postgres
--   (pg_catalog), NOT pgcrypto — it needs no change.
--
-- [OPUS-FIX #2] profiles UPDATE was column-unrestricted → privilege escalation.
--   RLS scopes the ROW, never the COLUMNS. The original FOR UPDATE policy
--   (USING id = auth.uid()) let an authenticated user PATCH ANY column on their own
--   row directly via PostgREST: is_verified=true (self-verify), status='active'
--   (skip onboarding), or username='admin' (reserved words live in
--   account_identifiers, NOT profiles, so a direct profile UPDATE never checks them
--   — and it desyncs profiles.username from account_identifiers). Fix: COLUMN-LEVEL
--   GRANTs — REVOKE UPDATE on profiles from `authenticated`, then GRANT UPDATE
--   (display_name) only. The RLS policy still scopes which row; the grant scopes
--   which columns. status / username / verification go through SECURITY DEFINER
--   RPCs in Steps 2/4 (already the plan).
--   ACTION FOR SONNET: extend the Step 3 adversarial gate with a SELF-WRITE test —
--   as an authenticated user, PATCH your own is_verified / status / username and
--   assert it is REJECTED. The current Step 3 plan only tests cross-user READS,
--   which would NOT have caught this self-write escalation.
--
-- [OPUS-FIX #3] CREATE POLICY statements made idempotent. The rest of the file is
--   safely re-runnable (IF NOT EXISTS / ON CONFLICT DO NOTHING / CREATE OR REPLACE),
--   but a bare CREATE POLICY errors on re-run after a partial failure. Each policy
--   is now preceded by DROP POLICY IF EXISTS to match the file's idempotent style.
--
-- [OPUS-FIX #4] auth_tenant_id() relocated (added 2026-06-09 after the first run on
--   staging failed with ERROR 42P01 "relation public.profiles does not exist"). The
--   function was defined in section 2, BEFORE the profiles table in section 3, but
--   its body selects from profiles. SQL-language functions are validated at CREATE
--   time (check_function_bodies = on), so the table must exist first. Moved the
--   definition to just after the profiles table/index, before the policies that use
--   it. Pure reorder — no logic change. Section 2's header is kept as a breadcrumb.
--
-- NOT changed (logged for awareness, no action needed now):
--   • The username loop still hard-fails a signup if gen_random_bytes ever collides
--     with an existing value (~1 in 4.3e9 per attempt) instead of retrying — the
--     INSERT would hit the unique constraint and raise. Accepted as negligible.
--   • status includes 'deactivated' (beyond policies.md §6's pending/active). Fine
--     for Step 7 soft-delete; add a one-line note to policies.md §6 so doc/DB agree.
-- ═════════════════════════════════════════════════════════════════════════════


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. tenants — add dm_initiation_policy column
-- ─────────────────────────────────────────────────────────────────────────────
-- Sole tenant launches with {} → no overrides → mutual-acceptance-only default.
-- Global defaults are read from lib/policies.js DM_INITIATION.DEFAULTS.
-- Per-tenant overrides slot in here for future API customers.
-- Ref: architecture.md §7 / policies.md §3 / lib/policies.js

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS dm_initiation_policy jsonb NOT NULL DEFAULT '{}';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. auth_tenant_id() — RLS helper function  [MOVED — see [OPUS-FIX #4]]
-- ─────────────────────────────────────────────────────────────────────────────
-- [OPUS-FIX #4] This function's body selects from public.profiles, so it cannot be
-- created before that table exists. SQL-language functions are validated at CREATE
-- time (check_function_bodies = on by default), which is exactly why running it in
-- this position raised: ERROR 42P01 "relation public.profiles does not exist".
-- The definition has been MOVED to directly after the profiles table is created
-- (section 3), before the policies that call it. Nothing references it earlier, so
-- the move is safe. This header is left as a breadcrumb.


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. profiles table
-- ─────────────────────────────────────────────────────────────────────────────
-- 1:1 with auth.users. id = auth.users.id (uuid PK, FK with ON DELETE CASCADE).
-- Adopts Model A — one tenant per user (decisions.md 2026-06-09).
-- Language/dialect preferences live in user_linguistic_profiles, not here.
-- display_name defaults to '' at P1 (trigger); set explicitly at P3 onboarding.
-- Ref: architecture.md §7 / decisions.md 2026-06-09 / policies.md §1 §6

CREATE TABLE IF NOT EXISTS public.profiles (
  -- Identity
  id                        uuid         PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id                 uuid         NOT NULL REFERENCES public.tenants(id),

  -- Public-facing display info
  display_name              text         NOT NULL DEFAULT '',
  username                  text         NOT NULL,
  username_source           text         NOT NULL DEFAULT 'system_generated'
    CONSTRAINT profiles_username_source_check
      CHECK (username_source IN ('system_generated', 'user_set')),
  username_last_changed_at  timestamptz,               -- null until first user-chosen change

  -- Verification (placeholder; no verification feature yet)
  is_verified               boolean      NOT NULL DEFAULT false,
  verification_method       text,                      -- nullable; may become enum/array later

  -- Account lifecycle (policies.md §6)
  status                    text         NOT NULL DEFAULT 'pending'
    CONSTRAINT profiles_status_check
      CHECK (status IN ('pending', 'active', 'deactivated')),
  onboarding_completed_at   timestamptz,               -- null until P3

  -- Timestamps
  created_at                timestamptz  NOT NULL DEFAULT now(),
  updated_at                timestamptz  NOT NULL DEFAULT now(),

  -- Within-tenant username uniqueness for current username.
  -- Historical non-reuse is enforced separately via account_identifiers
  -- (retired rows are never deleted, permanently blocking reuse).
  CONSTRAINT profiles_unique_username UNIQUE (tenant_id, username)
);

-- Index: abandonment job needs to find pending accounts older than N days cheaply
CREATE INDEX IF NOT EXISTS profiles_tenant_status_created_idx
  ON public.profiles (tenant_id, status, created_at)
  WHERE status = 'pending';

-- ── auth_tenant_id() — RLS helper function ───────────────────────────────────
-- [OPUS-FIX #4] Relocated here from section 2: the body selects from public.profiles,
-- so it must be created AFTER the table exists but BEFORE the policies below that
-- call it. SQL functions are validated at CREATE time, so the original ordering
-- (function before table) raised "relation public.profiles does not exist".
--
-- Returns the tenant_id for the currently authenticated user.
-- Why SECURITY DEFINER: the profiles SELECT policy compares tenant_id against the
-- current user's tenant. If the policy read profiles directly as the calling user,
-- it would re-trigger itself → infinite recursion. SECURITY DEFINER runs the
-- function as its owner, bypassing RLS on profiles.
-- Returns NULL for unauthenticated callers or users without a profile row → any
-- policy doing `tenant_id = auth_tenant_id()` evaluates to NULL → access denied.
CREATE OR REPLACE FUNCTION public.auth_tenant_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT tenant_id FROM public.profiles WHERE id = auth.uid()
$$;

COMMENT ON FUNCTION public.auth_tenant_id() IS
  'Returns the tenant_id for the current authenticated user. '
  'SECURITY DEFINER bypasses RLS on profiles to prevent infinite policy recursion. '
  'Returns NULL for unauthenticated users or users without a profile row.';

-- ── RLS on profiles ──────────────────────────────────────────────────────────
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- SELECT: any authenticated user in the same tenant.
-- display_name and username are public-facing (needed to show sender names in chat).
-- Private info (email) lives only in account_identifiers (own-rows-only policy there).
-- [OPUS-FIX #3] DROP ... IF EXISTS makes the policy re-runnable (idempotent).
DROP POLICY IF EXISTS "profiles_select_same_tenant" ON public.profiles;
CREATE POLICY "profiles_select_same_tenant" ON public.profiles
  FOR SELECT TO authenticated
  USING (tenant_id = public.auth_tenant_id());

-- UPDATE: owner only (ROW scope). display_name is set here at onboarding.
-- Status transitions (pending → active), username changes, and verification go
-- through SECURITY DEFINER RPCs in Steps 2/4 — NOT this policy. tenant_id and id
-- are immutable: enforced by WITH CHECK matching auth.uid().
--
-- [OPUS-FIX #2] RLS scopes the ROW; it cannot scope COLUMNS. This policy alone
-- would let a user PATCH is_verified / status / username on their own row via
-- PostgREST (privilege escalation). The column GRANTs below are the actual guard.
-- [OPUS-FIX #3] DROP ... IF EXISTS for idempotency.
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (
    id        = auth.uid()
    AND tenant_id = public.auth_tenant_id()
  );

-- [OPUS-FIX #2] Column-level write restriction — the escalation guard.
-- Revoke the blanket UPDATE the `authenticated` role gets by default, then grant
-- UPDATE on display_name ONLY. Combined with the row-scoping policy above, an
-- authenticated user can change only their own display_name directly. status,
-- username, username_source, username_last_changed_at, is_verified, and
-- verification_method are then writable solely by SECURITY DEFINER functions
-- (which run as the function owner and bypass both RLS and these column grants).
REVOKE UPDATE ON public.profiles FROM authenticated;
GRANT  UPDATE (display_name) ON public.profiles TO authenticated;

-- INSERT: no policy → denied for authenticated users. Created by trigger (runs as definer).
-- DELETE: no policy → denied. Use status='deactivated'. Hard delete via job in Step 7.


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. account_identifiers table
-- ─────────────────────────────────────────────────────────────────────────────
-- Normalized discovery handles (email, username, phone, friend_code).
-- Rows are NEVER hard-deleted — retired rows stay to enforce username non-reuse.
-- Exception: system_generated username of a DELETED ABANDONED account is released
-- (Step 6 scheduled job deletes the identifier row, freeing the value).
--
-- account_id is nullable to support 'reserved' rows (reserved words have no owner).
-- FK with ON DELETE CASCADE handles cleanup when a real user's profile is deleted.
--
-- Unique constraint (tenant_id, type, value) covers active + retired + reserved,
-- enforcing non-reuse across all states.
--
-- Handle minimization (policies.md §2): SELECT is restricted to own rows here.
-- Discovery queries (Step 4) use a SECURITY DEFINER function that returns only the
-- matched handle — never the target's other identifiers.
-- Ref: architecture.md §7 / policies.md §1 §2

CREATE TABLE IF NOT EXISTS public.account_identifiers (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid         REFERENCES public.profiles(id) ON DELETE CASCADE, -- nullable for reserved rows
  tenant_id   uuid         NOT NULL REFERENCES public.tenants(id),
  type        text         NOT NULL
    CONSTRAINT account_identifiers_type_check
      CHECK (type IN ('email', 'username', 'phone', 'friend_code')),
  value       text         NOT NULL,   -- canonical: lowercased email or username
  status      text         NOT NULL DEFAULT 'active'
    CONSTRAINT account_identifiers_status_check
      CHECK (status IN ('active', 'retired', 'reserved')),
  verified    boolean      NOT NULL DEFAULT false,
  created_at  timestamptz  NOT NULL DEFAULT now(),

  -- Global uniqueness per (tenant, type, value) — covers active + retired + reserved.
  -- This is the primary mechanism for username non-reuse.
  CONSTRAINT account_identifiers_unique_value UNIQUE (tenant_id, type, value)
);

CREATE INDEX IF NOT EXISTS account_identifiers_account_type_idx
  ON public.account_identifiers (account_id, type, status);

-- ── RLS on account_identifiers ───────────────────────────────────────────────
ALTER TABLE public.account_identifiers ENABLE ROW LEVEL SECURITY;

-- SELECT: own rows only. Email is private; username autocomplete and exact-match
-- add will go through a SECURITY DEFINER discovery function in Step 4.
-- [OPUS-FIX #3] DROP ... IF EXISTS for idempotency.
DROP POLICY IF EXISTS "account_identifiers_select_own" ON public.account_identifiers;
CREATE POLICY "account_identifiers_select_own" ON public.account_identifiers
  FOR SELECT TO authenticated
  USING (account_id = auth.uid());

-- INSERT/UPDATE/DELETE: no policies → denied for authenticated users.
-- Rows created by trigger; status changes (retire old username on change)
-- via SECURITY DEFINER function to be added in Step 4.


-- ── Reserved-word seeds ──────────────────────────────────────────────────────
-- Seeded as status='reserved' with account_id = NULL (no owner).
-- The unique constraint (tenant_id, type, value) blocks any user from claiming these.
-- ON CONFLICT DO NOTHING makes this idempotent (safe to re-run).
-- Extend the profanity list before launch — these are placeholders only.
-- Source of truth: lib/policies.js USERNAME.RESERVED_WORDS
-- Ref: policies.md §1

INSERT INTO public.account_identifiers
  (account_id, tenant_id, type, value, status, created_at)
SELECT
  NULL,
  '00000000-0000-0000-0000-000000000001',
  'username',
  word,
  'reserved',
  now()
FROM unnest(ARRAY[
  -- Role / system terms
  'admin', 'root', 'support', 'help', 'official', 'mod', 'moderator',
  'staff', 'system', 'api', 'billing', 'security', 'service', 'bot',
  'operator', 'ops', 'devops', 'sysadmin', 'superuser', 'sudo',
  -- Product / brand — replace with actual brand name before launch
  'translationapp', 'transapp',
  -- Profanity — extend with a complete list before launch (placeholders only)
  'fuck', 'shit', 'cunt', 'nigger', 'faggot'
]) AS t(word)
ON CONFLICT (tenant_id, type, value) DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. account_settings table
-- ─────────────────────────────────────────────────────────────────────────────
-- Per-user privacy preferences. 1:1 with profiles (account_id is PK).
-- Created by trigger with defaults; user can update via the settings UI (Step 2+).
-- Ref: architecture.md §7 / policies.md §2 §3

CREATE TABLE IF NOT EXISTS public.account_settings (
  account_id               uuid         PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  tenant_id                uuid         NOT NULL REFERENCES public.tenants(id),
  discoverable_by_email    boolean      NOT NULL DEFAULT true,
  discoverable_by_username boolean      NOT NULL DEFAULT true,
  allow_dms_from           text         NOT NULL DEFAULT 'contacts'
    CONSTRAINT account_settings_dms_from_check
      CHECK (allow_dms_from IN ('everyone', 'contacts', 'nobody')),
  updated_at               timestamptz  NOT NULL DEFAULT now()
);

-- ── RLS on account_settings ───────────────────────────────────────────────────
ALTER TABLE public.account_settings ENABLE ROW LEVEL SECURITY;

-- SELECT: own row only.
-- [OPUS-FIX #3] DROP ... IF EXISTS for idempotency.
DROP POLICY IF EXISTS "account_settings_select_own" ON public.account_settings;
CREATE POLICY "account_settings_select_own" ON public.account_settings
  FOR SELECT TO authenticated
  USING (account_id = auth.uid());

-- UPDATE: owner only.
-- [OPUS-FIX #3] DROP ... IF EXISTS for idempotency.
DROP POLICY IF EXISTS "account_settings_update_own" ON public.account_settings;
CREATE POLICY "account_settings_update_own" ON public.account_settings
  FOR UPDATE TO authenticated
  USING (account_id = auth.uid())
  WITH CHECK (account_id = auth.uid());

-- INSERT: no policy → denied (trigger creates the row).
-- DELETE: no policy → denied (cascades from profiles deletion).


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. handle_new_user() trigger function + trigger
-- ─────────────────────────────────────────────────────────────────────────────
-- Fires AFTER INSERT on auth.users.
-- Atomically creates: profiles row (pending) + email identifier + username identifier
--                     + account_settings row.
-- If the function raises an exception, the auth.users INSERT is rolled back.
-- No orphaned auth.users rows without profiles are possible.
--
-- System username format: 'user_' + 8 random hex chars = 13 chars (within 3–20 limit).
-- Uniqueness: checked against account_identifiers before use (covers reserved/retired/active).
-- Retry loop: up to 10 attempts. Collision probability per attempt ≈ 1/4,294,967,296.
--
-- v_tenant_id is hardcoded for the sole-tenant MVP. Multi-tenant onboarding would
-- pass tenant context via signup metadata (auth.users.raw_user_meta_data) and read
-- it here — deferred to Phase 6.
--
-- [OPUS-FIX #1] Requires pgcrypto for gen_random_bytes(). On Supabase pgcrypto is in
-- the `extensions` schema, and this function pins search_path=public, so the call is
-- schema-qualified below as extensions.gen_random_bytes(4). (gen_random_uuid(), used
-- as a table DEFAULT, is core Postgres and needs no qualification.)
-- SECURITY DEFINER: runs as the function owner, bypassing RLS on all public tables.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_tenant_id  uuid    := '00000000-0000-0000-0000-000000000001';
  v_username   text;
  v_is_taken   boolean;
  v_attempts   integer := 0;
BEGIN
  -- Guard: skip non-email rows (e.g., anonymous auth users have no email)
  IF NEW.email IS NULL THEN
    RETURN NEW;
  END IF;

  -- Generate a unique system-generated username
  LOOP
    v_attempts := v_attempts + 1;
    IF v_attempts > 10 THEN
      RAISE EXCEPTION
        'handle_new_user: failed to generate unique username after 10 attempts (user_id: %)',
        NEW.id;
    END IF;

    -- 'user_' + encode(4 random bytes, 'hex') = 'user_' + 8 hex chars = 13 chars total
    -- [OPUS-FIX #1] schema-qualified: pgcrypto is in `extensions`, search_path is public.
    v_username := 'user_' || encode(extensions.gen_random_bytes(4), 'hex');

    -- Check account_identifiers — covers active, retired, AND reserved in one query
    SELECT EXISTS (
      SELECT 1
      FROM public.account_identifiers
      WHERE tenant_id = v_tenant_id
        AND type      = 'username'
        AND value     = v_username
    ) INTO v_is_taken;

    EXIT WHEN NOT v_is_taken;
  END LOOP;

  -- Create pending profile (P1 lifecycle state)
  INSERT INTO public.profiles (
    id, tenant_id, display_name, username, username_source,
    status, created_at, updated_at
  ) VALUES (
    NEW.id, v_tenant_id, '', v_username, 'system_generated',
    'pending', now(), now()
  );

  -- Record email identifier (private; exact-match add only per policies.md §2)
  INSERT INTO public.account_identifiers (
    account_id, tenant_id, type, value, status, verified, created_at
  ) VALUES (
    NEW.id, v_tenant_id, 'email', lower(NEW.email), 'active', false, now()
  );

  -- Record username identifier (public-facing discovery handle)
  INSERT INTO public.account_identifiers (
    account_id, tenant_id, type, value, status, verified, created_at
  ) VALUES (
    NEW.id, v_tenant_id, 'username', v_username, 'active', false, now()
  );

  -- Create default account settings
  INSERT INTO public.account_settings (
    account_id, tenant_id,
    discoverable_by_email, discoverable_by_username, allow_dms_from,
    updated_at
  ) VALUES (
    NEW.id, v_tenant_id,
    true, true, 'contacts',
    now()
  );

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user() IS
  'Fires AFTER INSERT on auth.users. Creates a pending profiles row, '
  'email + username identifiers in account_identifiers, and default account_settings. '
  'System username: ''user_'' + 8 random hex chars. Requires pgcrypto (extensions.gen_random_bytes). '
  'Tenant hardcoded to sole-tenant UUID (00000000-0000-0000-0000-000000000001). '
  'If this function raises, the auth.users INSERT is rolled back — no orphaned auth rows.';

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();


-- ─────────────────────────────────────────────────────────────────────────────
-- Verification queries (run after migration, before calling gate passed)
-- Full checklist in verification.md "Phase 2 — Step 1"
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. New tables present
--    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
--    Expect: profiles, account_identifiers, account_settings now in list.

-- 2. dm_initiation_policy column on tenants
--    SELECT id, name, dm_initiation_policy FROM public.tenants;
--    Expect: 1 row, dm_initiation_policy = {}

-- 3. auth_tenant_id() function exists
--    SELECT routine_name FROM information_schema.routines
--    WHERE routine_schema = 'public' AND routine_name = 'auth_tenant_id';

-- 4. Trigger exists on auth.users
--    SELECT trigger_name FROM information_schema.triggers
--    WHERE event_object_schema = 'auth'
--      AND event_object_table  = 'users'
--      AND trigger_name        = 'on_auth_user_created';

-- 5. Reserved words seeded (expect 27 rows)
--    SELECT count(*) FROM public.account_identifiers WHERE status = 'reserved';

-- 6. RLS enabled on all three new tables
--    SELECT relname, relrowsecurity FROM pg_class
--    WHERE relnamespace = 'public'::regnamespace
--      AND relname IN ('profiles', 'account_identifiers', 'account_settings')
--      AND relkind = 'r';
--    Expect: relrowsecurity = true for all three.

-- 7. Trigger smoke test — see verification.md Step 1 for the full flow.
--    Short version: Supabase Auth dashboard → Add user (any email) → then:
--    SELECT id, status, username, username_source FROM public.profiles;
--    Expect: 1 row, status='pending', username like 'user_xxxxxxxx', source='system_generated'
--    SELECT type, value, status FROM public.account_identifiers
--    WHERE account_id = (SELECT id FROM public.profiles LIMIT 1);
--    Expect: 2 rows — ('email', the_email, 'active') and ('username', 'user_xxxx', 'active')
--    SELECT * FROM public.account_settings
--    WHERE account_id = (SELECT id FROM public.profiles LIMIT 1);
--    Expect: 1 row, discoverable defaults true, allow_dms_from = 'contacts'

-- 8. [OPUS-FIX #2] Column-write restriction — `authenticated` can UPDATE display_name only.
--    SELECT grantee, privilege_type, column_name
--    FROM information_schema.column_privileges
--    WHERE table_schema = 'public' AND table_name = 'profiles'
--      AND grantee = 'authenticated' AND privilege_type = 'UPDATE';
--    Expect: exactly one row → column_name = 'display_name'. (No row for status,
--    username, is_verified, etc.)
--    The full self-escalation NEGATIVE test belongs in the Step 3 adversarial gate:
--    authenticate as a user and PATCH own is_verified / status / username → expect denied.
