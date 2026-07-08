-- ============================================================================
-- 021_settings_screen.sql
-- Phase: 2.4 — Demo-readiness polish (account settings screen)
--
-- WHAT THIS DOES, IN PLAIN ENGLISH
-- Adds the server-side pieces the new account settings screen needs, and makes
-- the discoverability default more private.
--
--   1. set_preferred_language(p_language) — the settings screen's path to change
--      the user's translation target language. Single validated enforcement
--      point (mirrors change_username): validates non-empty, writes
--      user_linguistic_profiles.preferred_language for the caller, stamps
--      updated_at. Onboarding still seeds the row via complete_onboarding();
--      this is the *change-later* path.
--
--   2. set_display_name(p_display_name) — the settings screen's path to change
--      the display name. Reuses complete_onboarding()'s exact validation
--      (1–50 chars after trim + control-char / bidi denylist) so a display name
--      changed later is held to the same rules as one set at onboarding. This
--      closes the gap where a raw client UPDATE (allowed by profiles_update_own
--      + the display_name column grant) would bypass the denylist.
--
--   3. Discoverability default → username-only. account_settings.discoverable_by_email
--      default flips true→false and the handle_new_user() trigger inserts false,
--      so new accounts are NOT findable by email unless they opt in. Existing
--      rows are backfilled to false (decisions.md 2026-07-08). discoverable_by_
--      username stays true. Reversible: any user can re-enable email discovery in
--      the settings screen.
--
-- STAGING-FIRST: run on translationapp1-staging, run the verification block,
-- exercise the settings gate (verification.md), then replay on prod.
-- Idempotent: safe to re-run (CREATE OR REPLACE + idempotent ALTER/UPDATE).
-- ALTER not recreate — no table is dropped (operations.md §3).
-- ============================================================================

BEGIN;

-- ── 1. set_preferred_language ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_preferred_language(p_language text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_tenant uuid := public.auth_tenant_id();
  v_lang   text := trim(p_language);
BEGIN
  IF v_uid IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'set_preferred_language: not authenticated' USING ERRCODE = '28000';
  END IF;

  IF v_lang IS NULL OR length(v_lang) = 0 THEN
    RAISE EXCEPTION 'set_preferred_language: language is required';
  END IF;
  IF length(v_lang) > 35 THEN
    -- BCP 47 tags are short; guard against junk. (Longest realistic tags are well under this.)
    RAISE EXCEPTION 'set_preferred_language: language code too long';
  END IF;

  UPDATE public.user_linguistic_profiles
     SET preferred_language = v_lang,
         updated_at         = now()
   WHERE user_id = v_uid AND tenant_id = v_tenant;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'set_preferred_language: no linguistic profile for caller';
  END IF;

  RETURN v_lang;
END;
$$;

COMMENT ON FUNCTION public.set_preferred_language(text) IS
  'Phase 2.4 settings screen: change the caller''s translation target language '
  '(user_linguistic_profiles.preferred_language). Validated single enforcement '
  'point; onboarding seeds the row via complete_onboarding(), this changes it later.';

REVOKE ALL ON FUNCTION public.set_preferred_language(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_preferred_language(text) TO authenticated;

-- ── 2. set_display_name ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_display_name(p_display_name text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_trimmed_name text := trim(p_display_name);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'set_display_name: not authenticated' USING ERRCODE = '28000';
  END IF;

  -- Same rules as complete_onboarding (policies.md §1): 1–50 chars after trim,
  -- plus a control-char / bidi-override denylist (allowlist would break
  -- international names like "José", "Nguyễn", "李").
  IF length(v_trimmed_name) = 0 THEN
    RAISE EXCEPTION 'set_display_name: display_name cannot be empty';
  END IF;
  IF length(v_trimmed_name) > 50 THEN
    RAISE EXCEPTION 'set_display_name: display_name exceeds 50 characters';
  END IF;
  IF v_trimmed_name ~ ('[' || chr(1) || '-' || chr(31) || chr(127)
                        || chr(8234) || '-' || chr(8238)
                        || chr(8294) || '-' || chr(8297) || ']') THEN
    RAISE EXCEPTION 'set_display_name: display_name contains invalid control characters';
  END IF;

  UPDATE public.profiles
     SET display_name = v_trimmed_name,
         updated_at   = now()
   WHERE id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'set_display_name: no profile for caller';
  END IF;

  RETURN v_trimmed_name;
END;
$$;

COMMENT ON FUNCTION public.set_display_name(text) IS
  'Phase 2.4 settings screen: change the caller''s display_name with the same '
  'validation as complete_onboarding (1–50 chars + control-char/bidi denylist). '
  'SECURITY DEFINER so the denylist can''t be bypassed by a raw client UPDATE.';

REVOKE ALL ON FUNCTION public.set_display_name(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_display_name(text) TO authenticated;

-- ── 3. Discoverability default → username-only ──────────────────────────────

-- 3a. Column default (applies to any future insert that omits the column).
ALTER TABLE public.account_settings
  ALTER COLUMN discoverable_by_email SET DEFAULT false;

-- 3b. Backfill existing rows (decisions.md 2026-07-08 — pre-launch, reversible).
UPDATE public.account_settings
   SET discoverable_by_email = false,
       updated_at            = now()
 WHERE discoverable_by_email = true;

-- 3c. handle_new_user() trigger — insert discoverable_by_email = false for new
--     accounts. Full body replicated from migration 007 with ONLY the
--     account_settings insert value changed (true → false); everything else is
--     byte-for-byte the same (username generation, profile/identifier inserts).
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
  IF NEW.email IS NULL THEN
    RETURN NEW;
  END IF;

  LOOP
    v_attempts := v_attempts + 1;
    IF v_attempts > 10 THEN
      RAISE EXCEPTION
        'handle_new_user: failed to generate unique username after 10 attempts (user_id: %)',
        NEW.id;
    END IF;

    v_username := 'user_' || encode(extensions.gen_random_bytes(4), 'hex');

    SELECT EXISTS (
      SELECT 1
      FROM public.account_identifiers
      WHERE tenant_id = v_tenant_id
        AND type      = 'username'
        AND value     = v_username
    ) INTO v_is_taken;

    EXIT WHEN NOT v_is_taken;
  END LOOP;

  INSERT INTO public.profiles (
    id, tenant_id, display_name, username, username_source,
    status, created_at, updated_at
  ) VALUES (
    NEW.id, v_tenant_id, '', v_username, 'system_generated',
    'pending', now(), now()
  );

  INSERT INTO public.account_identifiers (
    account_id, tenant_id, type, value, status, verified, created_at
  ) VALUES (
    NEW.id, v_tenant_id, 'email', lower(NEW.email), 'active', false, now()
  );

  INSERT INTO public.account_identifiers (
    account_id, tenant_id, type, value, status, verified, created_at
  ) VALUES (
    NEW.id, v_tenant_id, 'username', v_username, 'active', false, now()
  );

  -- Default account settings — discoverable_by_email now FALSE (021).
  INSERT INTO public.account_settings (
    account_id, tenant_id,
    discoverable_by_email, discoverable_by_username, allow_dms_from,
    updated_at
  ) VALUES (
    NEW.id, v_tenant_id,
    false, true, 'contacts',
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
  '(021) discoverable_by_email now defaults FALSE — new accounts are username-discoverable only. '
  'If this function raises, the auth.users INSERT is rolled back — no orphaned auth rows.';

COMMIT;

-- ============================================================================
-- VERIFICATION (run after applying; all must hold)
-- ============================================================================
-- 1. Both RPCs exist with the expected signature + grants:
--    SELECT proname, pg_get_function_identity_arguments(oid)
--      FROM pg_proc WHERE proname IN ('set_preferred_language','set_display_name');
--    -- expect: set_preferred_language(p_language text), set_display_name(p_display_name text)
--    SELECT routine_name, grantee, privilege_type FROM information_schema.routine_privileges
--     WHERE routine_name IN ('set_preferred_language','set_display_name');
--    -- expect: authenticated has EXECUTE; no anon, no PUBLIC
--
-- 2. Column default flipped:
--    SELECT column_default FROM information_schema.columns
--     WHERE table_name = 'account_settings' AND column_name = 'discoverable_by_email';
--    -- expect: false
--
-- 3. Backfill complete:
--    SELECT count(*) FROM public.account_settings WHERE discoverable_by_email = true;
--    -- expect: 0
--
-- 4. Trigger inserts false — smoke via a fresh signup on staging, then:
--    SELECT discoverable_by_email, discoverable_by_username
--      FROM public.account_settings
--     WHERE account_id = (SELECT id FROM public.profiles ORDER BY created_at DESC LIMIT 1);
--    -- expect: (false, true)
--
-- 5. set_preferred_language happy path (as an authenticated active test user):
--    SELECT public.set_preferred_language('es');  -- returns 'es'
--    SELECT preferred_language FROM public.user_linguistic_profiles WHERE user_id = auth.uid();
--    -- expect: 'es'
--
-- 6. set_display_name denylist — a bidi-override char is rejected:
--    SELECT public.set_display_name(E'Isaac‮');  -- expect: invalid control characters
--    SELECT public.set_display_name('Isaac W.');      -- expect: returns 'Isaac W.'
-- ============================================================================
