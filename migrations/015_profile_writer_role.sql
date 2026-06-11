-- Migration 015 — Least-privilege `profile_writer` role (server-side inference)
--
-- Purpose: Give `server/lib/inferProfile.js` (the server-side profile-inference module,
-- connected via DATABASE_URL_PROFILE_WRITER) its own dedicated Postgres login role with
-- the *minimum* privilege needed to do its job, instead of reusing a broad role.
--
-- Posture (decisions.md 2026-06-11 "profile_writer role: scoped RLS, not BYPASSRLS"):
--   We do NOT use BYPASSRLS. Even though Supabase now permits granting BYPASSRLS without
--   superuser on PG 16+, that path is version- and supautils-config-dependent and is
--   coarse (a BYPASSRLS role skips RLS on EVERY table). Instead this role:
--     1. gets column-scoped table GRANTs for exactly the columns inferProfile touches, and
--     2. gets RLS policies targeted `TO profile_writer` that permit exactly those ops.
--   Net effect: the role is *deny-by-default everywhere else* — on any table without an
--   explicit `TO profile_writer` policy, RLS still blocks it even if a GRANT leaked in.
--   Per-row scoping (which user/tenant) is enforced in application code via the
--   message-derived trust boundary (decisions.md 2026-06-10): inferProfile reads the
--   message row and derives sender_id/tenant_id itself, never trusting client input.
--   The policies below are therefore `USING (true)` for this role — the DB authorizes the
--   *operation*, the app authorizes the *row*.
--
-- Exact privilege surface (mirrors inferProfile.js precisely):
--   messages                  SELECT (id, sender_id, tenant_id, source_language)   -- identity lookup
--   user_linguistic_profiles  SELECT (whole table — code does SELECT *)            -- read current profile
--                             UPDATE (the 7 allowlisted columns + updated_at)      -- also satisfies SELECT … FOR UPDATE
--   user_profile_events       INSERT (user_id, tenant_id, event_type,
--                                     previous_value, new_value, source)           -- append event log
--   (id / created_at on events are defaulted and omitted → no privilege needed on them.)
--   (Column-level UPDATE satisfies the FOR UPDATE row lock — verified 2026-06-11.)
--
-- ⚠️ SECRET / LOGIN — NOT in this file. The role is created NOLOGIN here so the committed
--    migration carries no password. Before the role can be used (and before the Step-2
--    inference gate can run), an operator must enable login with a real secret, OUT OF BAND
--    (Supabase SQL editor), and store it ONLY in the Vercel env var DATABASE_URL_PROFILE_WRITER
--    — never committed, never VITE_-prefixed (that would ship a privileged DB credential to
--    the browser). One-time step:
--        ALTER ROLE profile_writer WITH LOGIN PASSWORD '<strong-random-secret>';
--    Connection string form (direct connection or session pooler, port 5432):
--        postgres://profile_writer:<secret>@<project-host>:5432/postgres
--
-- Staging-first: run on translationapp1-staging, set the password out of band, run the
-- inference gate, then this file joins the prod replay (007 → 015).

begin;

-- ---------------------------------------------------------------------------
-- 1. The role — created NOLOGIN (no secret in the repo; operator enables login).
--    NOINHERIT so it never picks up privileges via incidental role membership.
-- ---------------------------------------------------------------------------
do $$
begin
    if not exists (select 1 from pg_roles where rolname = 'profile_writer') then
        create role profile_writer nologin noinherit;
    end if;
end $$;

-- Schema access (no object privileges come with this — just the ability to resolve names).
grant usage on schema public to profile_writer;

-- ---------------------------------------------------------------------------
-- 2. Column-scoped table GRANTs (the *operation* surface). GRANT is idempotent.
-- ---------------------------------------------------------------------------
-- messages: identity lookup only — exactly the four columns inferProfile reads.
grant select (id, sender_id, tenant_id, source_language)
    on public.messages to profile_writer;

-- user_linguistic_profiles: SELECT whole table (code does SELECT *); UPDATE only the
-- allowlisted columns + updated_at. The column-level UPDATE also satisfies FOR UPDATE.
grant select on public.user_linguistic_profiles to profile_writer;
grant update (
        dialect_region, dialect_confidence, dialect_source,
        formality_preference, formality_source,
        gender_signal, gender_source,
        updated_at
    ) on public.user_linguistic_profiles to profile_writer;

-- user_profile_events: INSERT only the six columns inferProfile supplies (id/created_at
-- are defaulted and omitted, so no privilege is needed on them).
grant insert (user_id, tenant_id, event_type, previous_value, new_value, source)
    on public.user_profile_events to profile_writer;

-- ---------------------------------------------------------------------------
-- 3. RLS policies targeted TO profile_writer (the *row* gate is left to app code,
--    so these are USING (true) / WITH CHECK (true)). Role-targeted policies apply
--    ONLY when current_user = profile_writer — they do not affect anon/authenticated.
--    All three tables already have RLS enabled (migration 008).
-- ---------------------------------------------------------------------------
drop policy if exists profile_writer_messages_select on public.messages;
create policy profile_writer_messages_select on public.messages
    for select to profile_writer using (true);

drop policy if exists profile_writer_ulp_select on public.user_linguistic_profiles;
create policy profile_writer_ulp_select on public.user_linguistic_profiles
    for select to profile_writer using (true);

drop policy if exists profile_writer_ulp_update on public.user_linguistic_profiles;
create policy profile_writer_ulp_update on public.user_linguistic_profiles
    for update to profile_writer using (true) with check (true);

drop policy if exists profile_writer_events_insert on public.user_profile_events;
create policy profile_writer_events_insert on public.user_profile_events
    for insert to profile_writer with check (true);

commit;

-- ===========================================================================
-- Verification (run after; expect the noted results):
-- ---------------------------------------------------------------------------
-- 1. Role exists, NOLOGIN until the operator enables it, not a superuser/bypassrls:
--    select rolname, rolcanlogin, rolsuper, rolbypassrls
--      from pg_roles where rolname = 'profile_writer';
--                                  -- expect rolcanlogin=f (until ALTER), rolsuper=f, rolbypassrls=f
--
-- 2. Exactly the intended table-level privileges (and nothing else):
--    select table_name, privilege_type
--      from information_schema.role_table_grants
--     where grantee = 'profile_writer' order by table_name, privilege_type;
--                                  -- expect: messages SELECT (via column grant it may show here too),
--                                  --         user_linguistic_profiles SELECT
--                                  -- (UPDATE/INSERT are column-level → see role_column_grants)
--
-- 3. Column-level grants are scoped to the allowlist:
--    select table_name, column_name, privilege_type
--      from information_schema.role_column_grants
--     where grantee = 'profile_writer' order by table_name, privilege_type, column_name;
--                                  -- expect: messages/SELECT × (id,sender_id,tenant_id,source_language);
--                                  --         user_linguistic_profiles/UPDATE × (7 cols + updated_at);
--                                  --         user_profile_events/INSERT × (6 cols)
--
-- 4. The four role-targeted policies exist:
--    select tablename, policyname, cmd
--      from pg_policies
--     where schemaname='public' and policyname like 'profile_writer_%'
--     order by tablename, policyname;        -- expect 4 rows
--
-- 5. Negative check (after enabling login): connecting AS profile_writer, a
--    SELECT on any table without a profile_writer policy (e.g. profiles, account_settings)
--    must return permission-denied / zero rows. Covered by scripts (inference gate, task #12).
-- ===========================================================================
