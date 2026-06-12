-- Migration 018 — Phase 3 Step 2: Membership-scoped messages RLS (Spec 7)
-- Date: 2026-06-12
-- Phase: 3 (Real conversation model)
--
-- Ends the "one global room" model at the AUTHORIZATION layer. Migration 017 (Spec 6)
-- ended it at the schema layer (conversations + conversation_members + the FK promotion);
-- this migration flips the read/write boundary on the message tables from TENANT-scoped
-- to MEMBERSHIP-scoped: a user may read or post a message, and read or write its cached
-- translation, only if they are an ACTIVE member of that message's conversation.
--
-- This is the highest-blast-radius change in the system (it governs every message read,
-- write, and realtime push), which is exactly why it is a SEPARATE migration and a SEPARATE
-- adversarial gate from 017 — isolate it, verify it alone.
--
-- What this migration does (single transaction): drops + recreates exactly FIVE policies.
--   messages              SELECT  → tenant + is_active_member(conversation_id, auth.uid())
--   messages              INSERT  → sender + tenant + is_active_member(conversation_id, auth.uid())
--   message_translations  SELECT  → membership of the PARENT message's conversation (EXISTS)
--   message_translations  INSERT  → membership of the PARENT message's conversation (EXISTS)
--   message_translations  UPDATE  → membership of the PARENT message's conversation (EXISTS)
--
-- Policy names are kept identical to migration 008 (drop-and-recreate in place) so no orphan
-- policy survives. The "_same_tenant" suffix is now a slight misnomer — the predicate is
-- tenant AND membership — but renaming buys nothing and risks leaving a stale policy behind.
--
-- Design notes (see decisions.md / specs.md Spec 7, 2026-06-12):
--   • is_active_member() is from 017 — STABLE SECURITY DEFINER SET search_path = public. Because
--     it is SECURITY DEFINER, the policy reads conversation_members under the FUNCTION's privilege:
--     the calling user needs NO direct SELECT on conversation_members, and the policy does not
--     recurse through conversation_members' own RLS.
--   • message_translations is the easy-to-miss half. The cache is keyed by message_id; without
--     mirroring the membership check onto the parent message, a non-member could read a
--     conversation's translations even though they cannot read its source messages. The EXISTS
--     subquery re-imposes the exact same boundary as the messages SELECT policy.
--   • messages stays IMMUTABLE — no UPDATE or DELETE policy is created (unchanged from 008).
--   • Realtime: Supabase postgres_changes applies the SELECT policy for the authenticated role,
--     so the new membership predicate governs realtime delivery too. This is verified explicitly
--     in the gate (realtime-RLS is a known footgun, not something to assume).
--
-- Idempotent + policies-only: re-running is a no-op. NO DDL beyond policies, NO data change,
-- no table recreate (operations.md §3 not triggered).
-- Sequencing: 018 runs AFTER 017 (the is_active_member helper + conversations tables must exist).
-- Staging-first: run on translationapp1-staging, gate (scripts/messages-rls-gate-test.mjs) GREEN,
-- then replay to prod in order 017 → 018. 018 must NEVER reach prod before 017.
--
-- Legacy global-room data: after this migration, messages on the global-conversation sentinel
-- (…0002) are visible only to active members of that conversation — of which there are none —
-- so they go dark. Intended (decisions.md 2026-06-12 "Retire the global-room sentinel data").
-- The read-only inventory query at the foot of this file shows exactly what falls dark; purge it
-- (delete the messages; message_translations cascade) before the prod replay for a clean cutover.

begin;

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. messages — membership-scoped SELECT + INSERT
-- ═════════════════════════════════════════════════════════════════════════════
-- SELECT: tenant scope is retained as a cheap first filter (and a defense-in-depth
-- belt-and-suspenders), AND-ed with active membership of the row's conversation.
DROP POLICY IF EXISTS "messages_select_same_tenant" ON public.messages;
CREATE POLICY "messages_select_same_tenant" ON public.messages
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.auth_tenant_id()
    AND public.is_active_member(conversation_id, auth.uid())
  );

-- INSERT: you may only post AS yourself, INTO your tenant, and only into a
-- conversation you are an active member of.
DROP POLICY IF EXISTS "messages_insert_own" ON public.messages;
CREATE POLICY "messages_insert_own" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND tenant_id = public.auth_tenant_id()
    AND public.is_active_member(conversation_id, auth.uid())
  );

-- No UPDATE or DELETE policy → messages remain immutable for authenticated users (unchanged).


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. message_translations — follow the parent message's membership (cache-leak fix)
-- ═════════════════════════════════════════════════════════════════════════════
-- The translation cache must inherit the exact read/write boundary of the message it
-- caches. We resolve membership through the parent messages row rather than re-deriving
-- a conversation_id on message_translations (the cache has no conversation_id column).
-- The frontend upserts via INSERT ... ON CONFLICT DO UPDATE, so BOTH the INSERT WITH CHECK
-- and the UPDATE USING/WITH CHECK must pass — all three carry the same predicate.

DROP POLICY IF EXISTS "mt_select_same_tenant" ON public.message_translations;
CREATE POLICY "mt_select_same_tenant" ON public.message_translations
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_translations.message_id
        AND m.tenant_id = public.auth_tenant_id()
        AND public.is_active_member(m.conversation_id, auth.uid())
    )
  );

DROP POLICY IF EXISTS "mt_insert_same_tenant" ON public.message_translations;
CREATE POLICY "mt_insert_same_tenant" ON public.message_translations
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_translations.message_id
        AND m.tenant_id = public.auth_tenant_id()
        AND public.is_active_member(m.conversation_id, auth.uid())
    )
  );

DROP POLICY IF EXISTS "mt_update_same_tenant" ON public.message_translations;
CREATE POLICY "mt_update_same_tenant" ON public.message_translations
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_translations.message_id
        AND m.tenant_id = public.auth_tenant_id()
        AND public.is_active_member(m.conversation_id, auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_translations.message_id
        AND m.tenant_id = public.auth_tenant_id()
        AND public.is_active_member(m.conversation_id, auth.uid())
    )
  );

-- No DELETE policy on message_translations (unchanged): cache rows are never deleted by
-- users; orphan cleanup is via the message_id FK cascade (migration 016).

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Verification (run after; expect the noted results)
-- ---------------------------------------------------------------------------
-- 1. Exactly the five expected policies exist with the new predicate. Confirm each
--    policy's qual/with_check now references is_active_member:
--    select tablename, policyname, cmd,
--           (qual ilike '%is_active_member%') as qual_has_member,
--           (with_check ilike '%is_active_member%') as check_has_member
--      from pg_policies
--     where schemaname='public'
--       and tablename in ('messages','message_translations')
--     order by tablename, cmd;
--      -- expect: messages SELECT (qual_has_member=t), messages INSERT (check_has_member=t),
--      --         message_translations SELECT (qual t), INSERT (check t), UPDATE (qual t, check t)
--
-- 2. messages is still immutable (no UPDATE/DELETE policy):
--    select count(*) from pg_policies
--      where schemaname='public' and tablename='messages' and cmd in ('UPDATE','DELETE');
--                                              -- expect 0
--
-- 3. RLS still enabled on both tables:
--    select relname, relrowsecurity from pg_class
--      where relnamespace='public'::regnamespace
--        and relname in ('messages','message_translations');   -- expect relrowsecurity=true for both
--
-- 4. is_active_member() prerequisite present (from 017) and SECURITY DEFINER + STABLE:
--    select proname, prosecdef, provolatile from pg_proc
--      where pronamespace='public'::regnamespace and proname='is_active_member';
--                                              -- expect 1 row, prosecdef=true, provolatile='s'
--
-- ---------------------------------------------------------------------------
-- READ-ONLY sentinel inventory — "what goes dark after 018" (Spec 7 open-question).
-- Run on BOTH staging and prod BEFORE the prod replay to see exactly what becomes
-- unreachable, then purge (decisions.md 2026-06-12 "Retire the global-room sentinel data").
-- ---------------------------------------------------------------------------
-- 5. Count of messages on the global-conversation sentinel (these go dark — no members):
--    select count(*) as sentinel_messages
--      from public.messages
--     where conversation_id = '00000000-0000-0000-0000-000000000002';
--
-- 6. Their cached translations (cascade-delete with the messages when purged):
--    select count(*) as sentinel_translations
--      from public.message_translations mt
--      join public.messages m on m.id = mt.message_id
--     where m.conversation_id = '00000000-0000-0000-0000-000000000002';
--
-- 7. Sanity: any messages on a NON-sentinel conversation with zero active members would
--    also be dark — at this point there should be none outside the sentinel:
--    select m.conversation_id, count(*)
--      from public.messages m
--     where not exists (select 1 from public.conversation_members cm
--                        where cm.conversation_id = m.conversation_id and cm.left_at is null)
--     group by m.conversation_id;
--      -- expect: only the sentinel …0002 row (or nothing, if already purged)
--
-- PURGE (run ONLY after reviewing 5–7; messages delete cascades to message_translations):
--    -- delete from public.messages where conversation_id = '00000000-0000-0000-0000-000000000002';
-- ═══════════════════════════════════════════════════════════════════════════
