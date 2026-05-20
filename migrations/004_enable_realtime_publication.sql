-- Migration 004 — Enable Supabase Realtime on messages table
-- Date: 2026-05-18
-- Phase: 0 (Foundation, retroactive — captures state that previously existed in prod
-- only via Supabase Studio UI clicks, not in any migration file).
--
-- Purpose: When tables are created via SQL, they are NOT automatically published
-- to the `supabase_realtime` publication. Subscribers receive no events until the
-- table is explicitly added. Prod's `messages` table was added to the publication
-- via the Supabase Studio UI early in the project's life, before the /migrations/
-- folder existed. Without this migration, a fresh Postgres (e.g. staging) would
-- skip realtime entirely, breaking the live-chat UX even though the data layer
-- works correctly.
--
-- This migration captures that step so any fresh deploy gets it for free.
--
-- Surfaced 2026-05-18 during the initial staging environment smoke test: sent
-- messages landed in the staging DB but didn't appear in the client without a
-- page refresh. See /docs/parking-lot.md "Known technical debt → Realtime
-- publication not captured in migrations" for the broader debt context.
--
-- How to run: Paste into the Supabase SQL editor and run. Idempotent — uses a
-- guard clause that no-ops if the table is already in the publication.

do $$
begin
    if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'messages'
    ) then
        alter publication supabase_realtime add table public.messages;
    end if;
end $$;

-- Verification (run after the migration to confirm):
--   select schemaname, tablename
--   from pg_publication_tables
--   where pubname = 'supabase_realtime'
--   order by tablename;
--   -- expect at least one row: ('public', 'messages')
