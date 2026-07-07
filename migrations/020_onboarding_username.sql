-- ============================================================================
-- 020_onboarding_username.sql
-- Phase: post-2.x follow-on (username chosen at onboarding)
--
-- WHAT THIS DOES, IN PLAIN ENGLISH
-- Users now pick their username on the onboarding screen (alongside display
-- name + language) instead of silently keeping the random system-generated
-- handle forever. This migration extends complete_onboarding() with an
-- optional p_username parameter. When provided, the function claims the
-- username and activates the account IN THE SAME TRANSACTION — so a pending
-- (never-onboarded) account can never hold a user-chosen username, which
-- keeps the abandonment sweep's hard-delete + handle-release logic safe
-- exactly as designed (decisions.md 2026-06-10 "Step 6 abandonment";
-- revisit-trigger consciously evaluated 2026-07-07).
--
-- MECHANICS
--   1. DROP the old 2-arg complete_onboarding(text, text) and CREATE the
--      3-arg version with p_username DEFAULT NULL.
--      * DROP-then-CREATE (not overload) is deliberate: PostgREST resolves
--        rpc() calls by named-argument matching, and two overloads whose
--        argument sets differ only by an optional param are ambiguous.
--      * Old callers passing 2 named args still work — the default fills in.
--      * Grants do NOT survive a DROP: re-REVOKE + re-GRANT below (010 style).
--   2. Username claim is delegated to change_username() (010) — single
--      enforcement point for charset/length/reserved/non-reuse/365-day
--      cadence. Its exceptions abort the whole transaction (atomicity).
--   3. NEW: display_name charset guard (closes parking-lot "Phase 2 RLS /
--      validation gaps" item 3). Implemented as a DENYLIST (control chars,
--      DEL, bidi override/isolate chars) rather than policies.md §1's strict
--      allowlist, so international names ("José", "Nguyễn", "李") keep
--      working; the dangerous invisibles are what the debt item actually
--      worried about. policies.md §1 updated in the same commit.
--   4. change_username() REPLACED (same signature, grants survive) to allow
--      SELF-REVERT: a user may reclaim their OWN retired username (the row
--      flips retired→active); everyone else stays blocked forever. The
--      365-day cadence applies to reverts like any other change.
--
-- STAGING-FIRST: run on translationapp1-staging, run the verification block,
-- exercise the onboarding gate (verification.md), then replay on prod.
-- Idempotent: safe to re-run (DROP IF EXISTS + CREATE OR REPLACE).
-- ============================================================================

BEGIN;

-- ── 1. Replace complete_onboarding ──────────────────────────────────────────

DROP FUNCTION IF EXISTS public.complete_onboarding(text, text);

CREATE OR REPLACE FUNCTION public.complete_onboarding(
  p_display_name       text,
  p_preferred_language text,
  p_username           text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_trimmed_name text := trim(p_display_name);
  v_tenant_id    uuid;
BEGIN
  -- Idempotency guard: if already active, nothing to do
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND status = 'active'
  ) THEN
    RETURN;
  END IF;

  -- Auth guard: caller must be authenticated and have a pending profile
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'complete_onboarding: caller is not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'complete_onboarding: no pending profile found for user %', auth.uid();
  END IF;

  -- Validate display_name (policies.md §1: 1–50 chars after trim)
  IF length(v_trimmed_name) = 0 THEN
    RAISE EXCEPTION 'complete_onboarding: display_name cannot be empty';
  END IF;
  IF length(v_trimmed_name) > 50 THEN
    RAISE EXCEPTION 'complete_onboarding: display_name exceeds 50 characters';
  END IF;

  -- NEW (020): display_name charset denylist — reject control characters,
  -- DEL, and Unicode bidi override/isolate characters (U+202A–U+202E,
  -- U+2066–U+2069). Denylist not allowlist: international names must pass.
  IF v_trimmed_name ~ ('[' || chr(1) || '-' || chr(31) || chr(127)
                        || chr(8234) || '-' || chr(8238)
                        || chr(8294) || '-' || chr(8297) || ']') THEN
    RAISE EXCEPTION 'complete_onboarding: display_name contains invalid control characters';
  END IF;

  -- Validate preferred_language (non-empty) — unchanged from 008
  IF p_preferred_language IS NULL OR length(trim(p_preferred_language)) = 0 THEN
    RAISE EXCEPTION 'complete_onboarding: preferred_language is required';
  END IF;

  -- NEW (020): claim the user-chosen username, if provided. Delegates ALL
  -- username policy (charset/length/reserved/non-reuse/cadence) to
  -- change_username() — the single enforcement point since 010. Any
  -- exception it raises aborts this whole transaction, so username claim
  -- and activation are atomic: a pending account can never end up holding
  -- a user-chosen handle.
  IF p_username IS NOT NULL AND length(trim(p_username)) > 0 THEN
    PERFORM public.change_username(trim(p_username));
  END IF;

  -- Fetch tenant_id (needed for the linguistic profile upsert)
  SELECT tenant_id INTO v_tenant_id
  FROM public.profiles
  WHERE id = auth.uid();

  -- P1 → P3: update profile (status, display_name, onboarding_completed_at)
  -- This bypasses the column grant via SECURITY DEFINER — intentional.
  UPDATE public.profiles SET
    display_name            = v_trimmed_name,
    status                  = 'active',
    onboarding_completed_at = now(),
    updated_at              = now()
  WHERE id = auth.uid();

  -- Create linguistic profile with explicitly chosen language
  -- No INSERT policy exists for authenticated users on this table — the RPC creates
  -- the row on their behalf. ON CONFLICT handles the (unlikely) case of a duplicate call.
  INSERT INTO public.user_linguistic_profiles (
    user_id, tenant_id, preferred_language, updated_at
  ) VALUES (
    auth.uid(), v_tenant_id, trim(p_preferred_language), now()
  )
  ON CONFLICT (user_id, tenant_id) DO UPDATE SET
    preferred_language = EXCLUDED.preferred_language,
    updated_at         = now();
END;
$$;

COMMENT ON FUNCTION public.complete_onboarding(text, text, text) IS
  'P1 → P3 status transition. Sets profiles.status=active, display_name, onboarding_completed_at; '
  'creates the user_linguistic_profiles row with the chosen language; and (020) optionally claims '
  'a user-chosen username via change_username() in the same transaction — atomic with activation, '
  'so pending accounts never hold user-chosen handles (keeps the abandonment hard-delete safe). '
  'Also (020) enforces a display_name control-char/bidi denylist. '
  'SECURITY DEFINER — bypasses column grants on profiles.status/username. '
  'Idempotent: no-op if user is already active. '
  'Called by the frontend onboarding screen after magic-link sign-in.';

-- ── 2. Grants (do not survive the DROP — reissue, 010 pattern) ──────────────

REVOKE ALL ON FUNCTION public.complete_onboarding(text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.complete_onboarding(text, text, text) TO authenticated;

-- ── 3. change_username: allow self-revert to a prior handle ─────────────────
-- Policy change (decisions.md 2026-07-07 "Self-revert"): non-reuse now means
-- "never reissued TO ANYONE ELSE" — the previous holder may reclaim their own
-- retired username. Nobody else ever can. The 365-day cadence still applies
-- to a revert (it is a change like any other).
-- CREATE OR REPLACE with an unchanged signature: grants + comment references
-- survive; only the body changes (availability check + swap step 2).

CREATE OR REPLACE FUNCTION public.change_username(p_new_username text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid            uuid    := auth.uid();
  v_tenant         uuid    := public.auth_tenant_id();
  v_new            text    := lower(btrim(p_new_username));
  v_cur_username   text;
  v_cur_source     text;
  v_cur_changed    timestamptz;
  v_existing       text;    -- status of any existing row with this value
  v_existing_owner uuid;    -- owner of that row (null for reserved rows)
  v_reverting      boolean := false;
BEGIN
  -- Auth guard
  IF v_uid IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'change_username: not authenticated' USING ERRCODE = '28000';
  END IF;

  -- Charset + length (policies.md §1 / lib/policies.js USERNAME)
  IF v_new !~ '^[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'change_username: invalid characters (allowed: a-z 0-9 _)';
  END IF;
  IF length(v_new) < 3 OR length(v_new) > 20 THEN
    RAISE EXCEPTION 'change_username: length must be 3-20 characters';
  END IF;

  -- Load the caller's current username state (lock the row to serialize concurrent changes)
  SELECT username, username_source, username_last_changed_at
    INTO v_cur_username, v_cur_source, v_cur_changed
  FROM public.profiles
  WHERE id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'change_username: no profile for caller' USING ERRCODE = '28000';
  END IF;

  -- No-op guard
  IF v_new = v_cur_username THEN
    RAISE EXCEPTION 'change_username: new username is the same as current';
  END IF;

  -- Cadence: first change from a system_generated handle is free and starts the
  -- clock; thereafter at most one change per 365 days. Applies to reverts too.
  IF v_cur_source = 'user_set'
     AND v_cur_changed IS NOT NULL
     AND v_cur_changed > now() - interval '365 days' THEN
    RAISE EXCEPTION
      'change_username: can be changed at most once per 365 days (last change %)',
      v_cur_changed;
  END IF;

  -- Reserved + non-reuse, with the 020 self-revert exception: a value that
  -- exists is unavailable UNLESS it is the caller's own retired handle.
  SELECT status, account_id INTO v_existing, v_existing_owner
  FROM public.account_identifiers
  WHERE tenant_id = v_tenant AND type = 'username' AND value = v_new
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    IF v_existing = 'retired' AND v_existing_owner = v_uid THEN
      v_reverting := true;   -- reclaiming own prior handle: allowed
    ELSE
      -- 'reserved', someone else's 'retired', or anyone's 'active': unavailable.
      RAISE EXCEPTION 'change_username: username unavailable';
    END IF;
  END IF;

  -- Atomic swap ---------------------------------------------------------------
  -- 1. Retire the caller's current active username identifier (never deleted).
  UPDATE public.account_identifiers
     SET status = 'retired'
   WHERE account_id = v_uid
     AND type       = 'username'
     AND value      = v_cur_username
     AND status     = 'active';

  -- 2. Activate the target identifier: re-activate the caller's own retired
  --    row on a revert (an INSERT would hit the (tenant_id, type, value)
  --    unique constraint); otherwise insert a fresh active row as before.
  IF v_reverting THEN
    UPDATE public.account_identifiers
       SET status = 'active'
     WHERE account_id = v_uid
       AND tenant_id  = v_tenant
       AND type       = 'username'
       AND value      = v_new
       AND status     = 'retired';
  ELSE
    INSERT INTO public.account_identifiers
      (account_id, tenant_id, type, value, status, verified, created_at)
    VALUES
      (v_uid, v_tenant, 'username', v_new, 'active', false, now());
  END IF;

  -- 3. Update the profile. profiles_unique_username (tenant_id, username) backstops.
  UPDATE public.profiles
     SET username                 = v_new,
         username_source          = 'user_set',
         username_last_changed_at  = now(),
         updated_at               = now()
   WHERE id = v_uid;

  RETURN v_new;

EXCEPTION
  -- Translate a lost uniqueness race into the same friendly error as the pre-check.
  WHEN unique_violation THEN
    RAISE EXCEPTION 'change_username: username unavailable';
END;
$$;

COMMENT ON FUNCTION public.change_username(text) IS
  'Phase 2 Step 4: the sole path to change a username (profiles.username is REVOKEd '
  'from authenticated). Enforces charset/length/reserved/non-reuse and the 1/365-day '
  'cadence (first system→user change free). Since 020: the caller may revert to their '
  'OWN retired username (re-activates the retired identifier row); non-reuse still '
  'blocks everyone else permanently. Called directly (future settings screen) and by '
  'complete_onboarding() (onboarding claim).';

COMMIT;

-- ============================================================================
-- VERIFICATION (run after applying; all four must hold)
-- ============================================================================
-- 1. Exactly one complete_onboarding, with 3 args:
--    SELECT proname, pg_get_function_identity_arguments(oid)
--      FROM pg_proc WHERE proname = 'complete_onboarding';
--    -- expect ONE row: (p_display_name text, p_preferred_language text, p_username text)
--
-- 2. Grants: authenticated has EXECUTE; anon/public do not:
--    SELECT grantee, privilege_type FROM information_schema.routine_privileges
--     WHERE routine_name = 'complete_onboarding';
--    -- expect authenticated (and owner/definer roles); no anon, no PUBLIC
--
-- 3. Old 2-arg call shape still works (PostgREST named-arg default fill):
--    from an authenticated test session:
--    SELECT public.complete_onboarding('Test Name', 'en');  -- no error (idempotent no-op if active)
--
-- 4. Atomicity probe (fresh pending test account): call with a RESERVED
--    username, e.g. complete_onboarding('Name','en','admin') → expect
--    'change_username: username unavailable' AND profile still status='pending'
--    (activation rolled back with the failed claim).
--
-- 5. Self-revert probe (any test account that has changed its username once —
--    clear the cadence first to simulate a year passing):
--      UPDATE profiles SET username_last_changed_at = now() - interval '400 days'
--       WHERE id = '<test-user-uuid>';
--    then as that user: SELECT change_username('<their previous handle>');
--    → succeeds; the identifier row flips retired→active (no new row);
--      profiles.username = the old handle.
--    Negative half: as a DIFFERENT user, change_username('<that same retired
--    handle>') while it is retired → 'username unavailable' (only the owner
--    can revert).
-- ============================================================================
