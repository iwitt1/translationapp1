-- Migration 010 — Phase 2 Step 4: Discovery + username-change RPCs
-- Date: 2026-06-10
-- Phase: 2 (Multi-user safety — Step 4)
--
-- What this migration builds (ADDITIVE ONLY — no table/column changes):
--   public.find_account_by_email(text)            — exact-match email add (no enumeration)
--   public.search_accounts_by_username(text,int)  — username autocomplete (prefix)
--   public.change_username(text)                  — validated, atomic username change
--   account_identifiers_username_prefix_idx       — index supporting prefix autocomplete
--
-- Why this is the whole of Step 4:
--   The Step 4 identity tables (profiles, account_identifiers, account_settings),
--   their RLS, and the reserved-word seeds already shipped in migration 007.
--   account_identifiers SELECT is OWN-ROWS-ONLY by design (007), so cross-user
--   discovery CANNOT be a client query — it must run through SECURITY DEFINER
--   functions that deliberately bypass RLS and enforce the rules in code. 007
--   explicitly deferred these to "a SECURITY DEFINER discovery function in Step 4."
--
-- Scope (decisions.md 2026-06-10 "Phase 2 Step 4 scope"):
--   Step 4 is SEARCH-ONLY. These RPCs find/resolve a user and let a user change
--   their own username. The *add* (which writes a `relationships` row) is Step 5,
--   where `blocks` exists to gate it — so autocomplete here cannot yet filter
--   blocked users, and that's acceptable because you can't act on a result until
--   Step 5 ships the add path.
--
-- Handle minimization (policies.md §2; decisions.md 2026-06-10 "return shape"):
--   Every discovery RPC returns ONLY (account_id, display_name, username) — the
--   public handles. It NEVER returns the target's email / phone / friend_code, nor
--   any retired username. On an exact email match we DO return the username
--   (decision 2026-06-10): the username is itself a public, searchable handle, so
--   exposing it is not a leak; emails/phones/other handles remain hidden.
--
-- Security posture:
--   - All three functions are SECURITY DEFINER, owned by the migration runner
--     (postgres), with SET search_path = public. They bypass RLS intentionally.
--   - EXECUTE is REVOKEd from public/anon and GRANTed to `authenticated` only.
--   - Every function is tenant-scoped via public.auth_tenant_id(); an
--     unauthenticated caller (auth.uid() NULL → auth_tenant_id() NULL) matches
--     nothing and can change nothing → deny-by-default.
--   - Discovery surfaces only status='active' profiles (pending/abandoned accounts
--     are invisible) and respects the target's account_settings discoverability.
--
-- Migration workflow (operations.md §3):
--   Run on STAGING → pass the Step 4 gate (verification.md) → only then run on PROD.
--   Do NOT run on prod until the Step 4 gate passes on staging.
-- ─────────────────────────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Prefix-search index for username autocomplete
-- ─────────────────────────────────────────────────────────────────────────────
-- The existing UNIQUE (tenant_id, type, value) btree uses the default collation,
-- which Postgres will NOT use for `LIKE 'prefix%'` outside the C locale. This
-- partial index with text_pattern_ops makes the autocomplete prefix scan
-- index-backed. Partial (active usernames only) keeps it small.
CREATE INDEX IF NOT EXISTS account_identifiers_username_prefix_idx
  ON public.account_identifiers (tenant_id, value text_pattern_ops)
  WHERE type = 'username' AND status = 'active';


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. find_account_by_email(p_email) — exact-match add by email
-- ─────────────────────────────────────────────────────────────────────────────
-- EXACT EQUALITY ONLY on the canonical (lowercased/trimmed) email. No prefix, no
-- ILIKE, no enumeration — you must already know the full address (policies.md §2,
-- "No open search by email"). Honors the target's discoverable_by_email setting.
-- Returns at most one row; excludes the caller (you can't add yourself).
CREATE OR REPLACE FUNCTION public.find_account_by_email(p_email text)
RETURNS TABLE (account_id uuid, display_name text, username text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p.id, p.display_name, p.username
  FROM public.account_identifiers ai
  JOIN public.profiles p          ON p.id = ai.account_id
  JOIN public.account_settings s  ON s.account_id = p.id
  WHERE ai.tenant_id = public.auth_tenant_id()   -- tenant-scoped; NULL → no rows
    AND ai.type      = 'email'
    AND ai.status    = 'active'
    AND ai.value     = lower(btrim(p_email))      -- canonical exact match
    AND p.status     = 'active'                   -- only onboarded accounts discoverable
    AND p.id        <> auth.uid()                 -- never return self
    AND s.discoverable_by_email = true            -- target opted in
  LIMIT 1
$$;

COMMENT ON FUNCTION public.find_account_by_email(text) IS
  'Phase 2 Step 4 discovery: exact-match add by email. SECURITY DEFINER (bypasses '
  'RLS on account_identifiers to read another user''s row) but returns only public '
  'handles (id, display_name, username) — never the target''s email/phone/other '
  'identifiers. Exact canonical equality only (no enumeration). Tenant-scoped; '
  'respects discoverable_by_email; only active profiles; excludes the caller.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. search_accounts_by_username(p_prefix, p_limit) — username autocomplete
-- ─────────────────────────────────────────────────────────────────────────────
-- Prefix match on the canonical username. Honors discoverable_by_username.
-- Anti-enumeration guards: minimum prefix length 3, result cap 20. The prefix is
-- escaped for LIKE so a caller cannot inject '%' / '_' wildcards to widen the scan.
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
  -- Minimum prefix length blunts enumeration. Shorter prefix → empty result.
  IF length(v_prefix) < 3 THEN
    RETURN;
  END IF;

  -- Escape LIKE metacharacters so the prefix is treated literally.
  v_like := replace(replace(replace(v_prefix, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  RETURN QUERY
  SELECT p.id, p.display_name, p.username
  FROM public.account_identifiers ai
  JOIN public.profiles p          ON p.id = ai.account_id
  JOIN public.account_settings s  ON s.account_id = p.id
  WHERE ai.tenant_id = public.auth_tenant_id()   -- tenant-scoped; NULL → no rows
    AND ai.type      = 'username'
    AND ai.status    = 'active'
    AND ai.value LIKE v_like ESCAPE '\'           -- index-backed prefix match
    AND p.status     = 'active'
    AND p.id        <> auth.uid()                 -- never return self
    AND s.discoverable_by_username = true
  ORDER BY ai.value
  LIMIT v_limit;
END;
$$;

COMMENT ON FUNCTION public.search_accounts_by_username(text, integer) IS
  'Phase 2 Step 4 discovery: username autocomplete (prefix). SECURITY DEFINER; '
  'returns only public handles (id, display_name, username). Min prefix length 3, '
  'result cap 20, LIKE metacharacters escaped (no wildcard injection). Tenant-scoped; '
  'respects discoverable_by_username; only active profiles; excludes the caller. '
  'Does NOT filter blocked users — blocks are Step 5, where the add path is gated.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. change_username(p_new_username) — validated, atomic username change
-- ─────────────────────────────────────────────────────────────────────────────
-- profiles.username is REVOKEd from `authenticated` (007 OPUS-FIX #2), so this is
-- the ONLY path to change a username. Validates charset/length/reserved/uniqueness
-- and the 1/365-day cadence (first change from a system_generated handle is FREE
-- and starts the clock), then atomically retires the old identifier row, inserts
-- the new one, and updates profiles — all in one transaction.
--
-- Non-reuse (policies.md §1): a value that exists in ANY status (active/retired/
-- reserved) for this tenant cannot be claimed — even a value the caller previously
-- retired. Enforced here AND by the unique constraints as a backstop.
--
-- Errors use SQLSTATE 'P0001' (raise_exception) with a stable, client-parseable
-- message prefix. Returns the new canonical username on success.
CREATE OR REPLACE FUNCTION public.change_username(p_new_username text)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid          uuid    := auth.uid();
  v_tenant       uuid    := public.auth_tenant_id();
  v_new          text    := lower(btrim(p_new_username));
  v_cur_username text;
  v_cur_source   text;
  v_cur_changed  timestamptz;
  v_existing     text;     -- status of any existing row with this value
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
  -- clock; thereafter at most one change per 365 days.
  IF v_cur_source = 'user_set'
     AND v_cur_changed IS NOT NULL
     AND v_cur_changed > now() - interval '365 days' THEN
    RAISE EXCEPTION
      'change_username: can be changed at most once per 365 days (last change %)',
      v_cur_changed;
  END IF;

  -- Reserved + non-reuse: reject if the value exists in ANY status for this tenant.
  SELECT status INTO v_existing
  FROM public.account_identifiers
  WHERE tenant_id = v_tenant AND type = 'username' AND value = v_new
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    -- 'reserved' / 'retired' / 'active' all mean unavailable.
    RAISE EXCEPTION 'change_username: username unavailable';
  END IF;

  -- Atomic swap ---------------------------------------------------------------
  -- 1. Retire the caller's current active username identifier (never deleted).
  UPDATE public.account_identifiers
     SET status = 'retired'
   WHERE account_id = v_uid
     AND type       = 'username'
     AND value      = v_cur_username
     AND status     = 'active';

  -- 2. Insert the new active username identifier. The unique constraint
  --    (tenant_id, type, value) is the backstop against a concurrent claim.
  INSERT INTO public.account_identifiers
    (account_id, tenant_id, type, value, status, verified, created_at)
  VALUES
    (v_uid, v_tenant, 'username', v_new, 'active', false, now());

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
  'from authenticated). Validates charset/length/reserved/non-reuse and the 1/365-day '
  'cadence (first system_generated→user_set change is free), then atomically retires '
  'the old account_identifiers row, inserts the new active row, and updates profiles. '
  'SECURITY DEFINER; tenant-scoped via auth_tenant_id().';


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Grants — authenticated only; deny public/anon
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.find_account_by_email(text)               FROM public, anon;
REVOKE ALL ON FUNCTION public.search_accounts_by_username(text, integer) FROM public, anon;
REVOKE ALL ON FUNCTION public.change_username(text)                      FROM public, anon;

GRANT EXECUTE ON FUNCTION public.find_account_by_email(text)               TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_accounts_by_username(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.change_username(text)                      TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- Verification queries (run on staging after migration; full gate in verification.md)
-- ─────────────────────────────────────────────────────────────────────────────
-- The cross-user / RLS-bypass behavior must be verified as REAL authenticated
-- users (anon key + JWT), the same way the Step 3 adversarial gate runs — not as
-- the postgres superuser, which bypasses RLS and would mask leaks. The structural
-- checks below can run in the SQL editor; the behavioral gate is the .mjs script.
--
-- 1. Functions exist with the right security + grants
--    SELECT proname, prosecdef,
--           pg_get_function_identity_arguments(oid) AS args
--    FROM pg_proc
--    WHERE pronamespace = 'public'::regnamespace
--      AND proname IN ('find_account_by_email','search_accounts_by_username','change_username');
--    Expect: 3 rows, prosecdef = true (SECURITY DEFINER) for all.
--
-- 2. EXECUTE granted to authenticated, not anon
--    SELECT routine_name, grantee, privilege_type
--    FROM information_schema.routine_privileges
--    WHERE routine_schema = 'public'
--      AND routine_name IN ('find_account_by_email','search_accounts_by_username','change_username')
--    ORDER BY routine_name, grantee;
--    Expect: 'authenticated' has EXECUTE; no 'anon' row.
--
-- 3. Prefix index present
--    SELECT indexname FROM pg_indexes
--    WHERE schemaname = 'public' AND tablename = 'account_identifiers'
--      AND indexname = 'account_identifiers_username_prefix_idx';
--
-- 4. Behavioral gate (as authenticated users A and B in the sole tenant):
--    a. find_account_by_email(B_email)        → returns B's (id, display_name, username); never B's other identifiers.
--    b. find_account_by_email('prefix')       → exact only: a partial/prefix email returns 0 rows.
--    c. set B.discoverable_by_email = false    → find_account_by_email(B_email) returns 0 rows.
--    d. search_accounts_by_username(B_prefix)  → returns B; returns 0 rows for a <3-char prefix; '%' is literal (no enumeration).
--    e. set B.discoverable_by_username = false → search returns 0 rows for B.
--    f. change_username('Admin')               → rejected (reserved; case-folds to 'admin').
--    g. change_username(<B's current name>)    → rejected (unavailable / unique).
--    h. change_username('newname') as A        → succeeds; old A username row now 'retired'; profiles.username updated;
--                                                username_source='user_set'; username_last_changed_at set.
--    i. change_username('another') again as A   → rejected (1/365-day cadence).
--    j. change_username('newname') as B        → rejected (non-reuse: A retired it).
--    k. direct client SELECT on account_identifiers (B's token) → still own-rows-only (RLS unchanged).
