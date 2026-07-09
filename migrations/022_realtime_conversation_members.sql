-- ============================================================================
-- 022_realtime_conversation_members.sql
-- Phase: 2.4 — Demo-readiness polish (conversation-list realtime)
--
-- WHAT THIS DOES, IN PLAIN ENGLISH
-- Publishes `conversation_members` to the `supabase_realtime` publication so the
-- client can subscribe to it. This is what lets a conversation you're added to
-- (a direct someone starts with you, a group you're created into, an invite you
-- redeem on another device) appear in your list WITHOUT a manual reload: the
-- frontend subscribes to INSERTs on its own membership rows and reloads the list.
--
-- Realtime respects RLS: Supabase applies each table's SELECT policy for the
-- `authenticated` role to `postgres_changes`. `conversation_members`'s
-- `conversation_members_select_member` policy (migration 017) allows a user to
-- see rows where `account_id = auth.uid()`, so a user's own membership INSERTs
-- are delivered; other users' rows are not. Same membership-scoped guarantee the
-- `messages` channel already relies on (migration 018 / Spec 7).
--
-- Only `conversation_members` is added — NOT `conversations`. The client keys its
-- list refresh off "was I added to a conversation?", which is a membership-row
-- event; conversation *metadata*-change realtime (title/context_type live update)
-- has no subscriber yet and would just add replication load. Add `conversations`
-- to the publication when that feature exists. (decisions.md 2026-07-08.)
--
-- Mirrors migration 004 (messages publication): idempotent DO-block guard.
-- No RLS/DDL/data change — publication membership only.
--
-- STAGING-FIRST: run on translationapp1-staging, verify, then replay on prod.
-- ============================================================================

do $$
begin
    if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'conversation_members'
    ) then
        alter publication supabase_realtime add table public.conversation_members;
    end if;
end $$;

-- ============================================================================
-- VERIFICATION (run after applying)
-- ============================================================================
--   select schemaname, tablename
--   from pg_publication_tables
--   where pubname = 'supabase_realtime'
--   order by tablename;
--   -- expect rows including ('public','messages') AND ('public','conversation_members')
-- ============================================================================
