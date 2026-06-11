-- ════════════════════════════════════════════════════════════════════════════════
-- Migration 012 — Phase 2 Step 6: Abandonment + abuse-monitoring support functions
-- ════════════════════════════════════════════════════════════════════════════════
-- Purpose: the two DB helpers the Step 6 abandonment sweep (server/lib/abandonment.js,
-- run by the Vercel cron at api/v1/jobs/abandonment.js) calls. The sweep itself lives
-- in Node because the abuse hash is a KEYED HMAC whose pepper must never enter Postgres
-- (decisions.md 2026-06-10 "email_hash_abuse: versioned HMAC computed in the job layer").
--
-- What this migration ADDS (additive only — no tables, no ALTERs):
--   public.list_abandoned_pending_accounts(interval)  — read: which pending accounts are
--       past the abandonment window, plus the canonical email the job needs to hash.
--   public.record_abandoned_email_hash(uuid, text, smallint) — write: atomic insert-or-
--       increment into email_hash_abuse (PostgREST can't express the +1 as a plain upsert).
--
-- What this migration deliberately does NOT do:
--   * No "release the username" logic. Releasing the system-generated handle is automatic:
--     the sweep deletes the auth.users row via the Supabase admin API, and the FK chain
--     auth.users → profiles (ON DELETE CASCADE, mig 007) → account_identifiers /
--     account_settings (ON DELETE CASCADE, mig 007) drops the username + email rows. With
--     the rows gone, the within-tenant uniqueness + historical-non-reuse checks no longer
--     see them, so the handle is reclaimable. No RPC needed. (policies.md §1: the
--     system-generated handle of a deleted abandoned signup IS the one username we release.)
--   * No deletion RPC. Deleting auth.users is an auth-schema operation owned by Supabase;
--     the sweep uses auth.admin.deleteUser() (cleans up sessions/identities too), not SQL.
--
-- Roles: these are SYSTEM functions called only by the sweep as the service_role (which
-- bypasses RLS). They are GRANTed to service_role and REVOKEd from anon/authenticated/
-- public. Unlike the Step 4/5 RPCs they do NOT use auth.uid()/auth_tenant_id() — the sweep
-- operates across ALL tenants/users, not as a logged-in user.
--
-- Idempotent: CREATE OR REPLACE; safe to replay. Staging first; prod replay happens in the
-- Phase 2 cutover (after Step 7), per architecture.md §10 / decisions.md.
-- Ref: policies.md §6 · architecture.md §7 (email_hash_abuse) · decisions.md 2026-06-10
-- ════════════════════════════════════════════════════════════════════════════════


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. list_abandoned_pending_accounts(p_max_age) — selection (read)
-- ═════════════════════════════════════════════════════════════════════════════
-- Returns every account that is still `pending` (never reached P3 onboarding) and was
-- created more than p_max_age ago, together with the canonical (lower(trim)) email the
-- sweep needs to compute the abuse hash, and username_source (a defensive guard — every
-- pending account is 'system_generated', and the sweep asserts it before deleting, so a
-- user-chosen / shared handle can never be released by this path).
--
-- canonical_email is LEFT JOINed and may be NULL in the pathological case of a pending
-- account with no active email identifier (shouldn't happen — email is mandatory at P1);
-- the sweep handles NULL by deleting the account but skipping the hash write.
--
-- Backed by the partial index profiles_tenant_status_created_idx (mig 007), built for
-- exactly this query. SECURITY DEFINER + STABLE; reads only.
CREATE OR REPLACE FUNCTION public.list_abandoned_pending_accounts(
  p_max_age interval DEFAULT interval '30 days'
)
RETURNS TABLE (
  account_id      uuid,
  tenant_id       uuid,
  canonical_email text,
  username_source text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    p.id                       AS account_id,
    p.tenant_id                AS tenant_id,
    lower(trim(ai.value))      AS canonical_email,
    p.username_source          AS username_source
  FROM public.profiles p
  LEFT JOIN public.account_identifiers ai
    ON ai.account_id = p.id
   AND ai.type   = 'email'
   AND ai.status = 'active'
  WHERE p.status = 'pending'
    AND p.created_at < (now() - p_max_age)
$$;

COMMENT ON FUNCTION public.list_abandoned_pending_accounts(interval) IS
  'Step 6 abandonment sweep: pending accounts older than p_max_age (default 30 days), with '
  'canonical email + username_source. System function — service_role only; not user-facing. '
  'Backed by profiles_tenant_status_created_idx. policies.md §6.';

REVOKE ALL ON FUNCTION public.list_abandoned_pending_accounts(interval)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_abandoned_pending_accounts(interval)
  TO service_role;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. record_abandoned_email_hash(p_tenant_id, p_email_hash_hex, p_key_version) — write
-- ═════════════════════════════════════════════════════════════════════════════
-- Atomic insert-or-increment into email_hash_abuse. The hash is computed in Node
-- (HMAC-SHA256(canonical_email, pepper)) and passed as a HEX string — passing bytea over
-- PostgREST is fiddly, so we take text and decode() it here. On a repeat abandon (same
-- tenant + hash + key_version) we bump abandon_count and stamp last_seen rather than
-- inserting a duplicate; first_seen is preserved (set once at insert).
--
-- key_version lets the pepper rotate without a rewrite (bump the version, key forward;
-- old-version rows stay readable within their version). The job tags each write with the
-- current version (starts at 1 — decisions.md 2026-06-10).
--
-- SECURITY DEFINER + VOLATILE. The unique constraint email_hash_abuse_unique
-- (tenant_id, email_hash, key_version) is the conflict target.
CREATE OR REPLACE FUNCTION public.record_abandoned_email_hash(
  p_tenant_id      uuid,
  p_email_hash_hex text,
  p_key_version    smallint DEFAULT 1
)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
  INSERT INTO public.email_hash_abuse (tenant_id, email_hash, key_version)
  VALUES (p_tenant_id, decode(p_email_hash_hex, 'hex'), p_key_version)
  ON CONFLICT (tenant_id, email_hash, key_version)
  DO UPDATE SET
    abandon_count = public.email_hash_abuse.abandon_count + 1,
    last_seen     = now();
$$;

COMMENT ON FUNCTION public.record_abandoned_email_hash(uuid, text, smallint) IS
  'Step 6 abandonment sweep: atomic insert-or-increment of a keyed email HMAC (passed as '
  'hex) into email_hash_abuse. Repeat abandon bumps abandon_count + last_seen; first_seen '
  'preserved. System function — service_role only. decisions.md 2026-06-10; policies.md §6.';

REVOKE ALL ON FUNCTION public.record_abandoned_email_hash(uuid, text, smallint)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_abandoned_email_hash(uuid, text, smallint)
  TO service_role;


-- ════════════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after applying on staging)
-- ════════════════════════════════════════════════════════════════════════════════
-- 1. Both functions exist + SECURITY DEFINER:
--      SELECT proname, prosecdef FROM pg_proc
--      WHERE pronamespace = 'public'::regnamespace
--        AND proname IN ('list_abandoned_pending_accounts','record_abandoned_email_hash');
--      Expect: 2 rows, prosecdef = true for both.
--
-- 2. EXECUTE granted to service_role only (not anon/authenticated):
--      SELECT p.proname, r.rolname
--      FROM pg_proc p
--      CROSS JOIN LATERAL aclexplode(p.proacl) a
--      JOIN pg_roles r ON r.oid = a.grantee
--      WHERE p.pronamespace='public'::regnamespace
--        AND p.proname IN ('list_abandoned_pending_accounts','record_abandoned_email_hash')
--        AND a.privilege_type='EXECUTE';
--      Expect: only service_role (plus the owner) — never anon/authenticated.
--
-- 3. Selection returns nothing for a fresh DB (no aged pending accounts):
--      SELECT count(*) FROM public.list_abandoned_pending_accounts(interval '30 days');
--      Expect: 0 on a clean staging (until the gate plants a backdated fixture).
--
-- 4. Record is idempotent-incrementing (run twice with the same hash):
--      SELECT public.record_abandoned_email_hash(
--        '00000000-0000-0000-0000-000000000001'::uuid,
--        encode(digest('probe','sha256'),'hex'), 1::smallint);  -- run 2x
--      SELECT abandon_count FROM public.email_hash_abuse
--      WHERE key_version=1 ORDER BY first_seen DESC LIMIT 1;
--      Expect: abandon_count = 2 after two calls; one row, not two.
--      (Then clean up the probe row. The Step 6 gate covers the full flow.)
-- ════════════════════════════════════════════════════════════════════════════════
