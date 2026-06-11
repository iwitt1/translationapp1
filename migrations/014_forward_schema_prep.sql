-- Migration 014 — Forward-schema prep (pre-cutover structural hardening)
--
-- Purpose: Bake in structure that is free to add while prod is empty (about to be
-- wiped + replayed) but would cost a destructive migration or a backfill once real
-- traffic accumulates. Surfaced by the 2026-06-11 forward-looking schema review
-- (decisions.md 2026-06-11 "Forward-schema prep before prod cutover").
--
-- Four independent changes, all ALTER (no recreate), all idempotent:
--   1. messages.conversation_id — nullable now, defaulted to the global-conversation
--      sentinel, so Phase 3 can add the conversations table + FK + NOT NULL with ZERO
--      backfill (every row already carries a valid id). Mirrors the 001 tenant_id pattern.
--   2. Drop the 7 vestigial columns on messages — all accounted for elsewhere
--      (conversation_id / message_translations / conversation_contexts / translation_events;
--      see architecture.md §7 + decisions.md 2026-06-11).
--   3. timestamp -> timestamptz on the four surviving naive-timestamp columns. Postgres
--      runs UTC on Supabase and the app writes now(); interpret the naive values AS UTC.
--   4. Missing FK indexes (Postgres does NOT auto-index FK columns; RLS filters on these).
--
-- Staging-first: run on translationapp1-staging, verify with the queries at the bottom,
-- then this file is part of the prod replay sequence (007 -> 015).
--
-- ⚠️ Pre-flight before running: confirm `src/App.jsx` `.select('translated_text')`
--    reads `message_translations` (the cache), NOT `messages` — the column names collide.
--    The messages.translated_text being dropped here is the vestigial one. (Verified
--    2026-06-11: code references resolve to message_translations / translation_events
--    / local vars, not the messages vestigial columns.)

begin;

-- ---------------------------------------------------------------------------
-- 1. messages.conversation_id  (forward-prep for Phase 3 conversations model)
-- ---------------------------------------------------------------------------
-- Global-conversation sentinel: 00000000-0000-0000-0000-000000000002
--   (mirrors the tenant sentinel ...0001 from migration 001).
-- DEFAULT keeps the column non-NULL even if the frontend lags in writing it.
-- Phase 3 will: CREATE TABLE conversations; INSERT the ...0002 row; ADD the FK;
-- ALTER COLUMN ... SET NOT NULL; then DROP the default (real conversation ids take over).
-- No FK is added here on purpose — the conversations table does not exist yet.
alter table public.messages
    add column if not exists conversation_id uuid
    default '00000000-0000-0000-0000-000000000002';

-- Backfill any pre-existing rows (staging test data) that predate the default.
update public.messages
    set conversation_id = '00000000-0000-0000-0000-000000000002'
    where conversation_id is null;

-- ---------------------------------------------------------------------------
-- 2. Drop vestigial columns on messages (all superseded — architecture.md §7)
--    room_id, context_id   -> conversation_id (above) + conversation_contexts (Phase 3)
--    translated_text       -> message_translations.translated_text
--    target_language       -> message_translations.language
--    tone                  -> per-call context_type + conversation_contexts.detected_register
--    model_version         -> translation_events.model_used
--    latency_ms            -> translation_events.latency_ms
-- ---------------------------------------------------------------------------
alter table public.messages drop column if exists room_id;
alter table public.messages drop column if exists translated_text;
alter table public.messages drop column if exists target_language;
alter table public.messages drop column if exists tone;
alter table public.messages drop column if exists context_id;
alter table public.messages drop column if exists model_version;
alter table public.messages drop column if exists latency_ms;

-- ---------------------------------------------------------------------------
-- 3. timestamp without time zone -> timestamptz  (interpret naive values AS UTC)
--    Guarded so the migration is a no-op if a column is already timestamptz
--    (e.g. on a fresh replay where a future base schema already uses tz).
-- ---------------------------------------------------------------------------
do $$
declare
    r record;
begin
    for r in
        select t.table_name, c.column_name
        from (values
            ('message_translations', 'created_at'),
            ('conversation_contexts', 'updated_at'),
            ('tenants',               'created_at'),
            ('user_profile_events',   'created_at')
        ) as t(table_name, column_name)
        join information_schema.columns c
            on c.table_schema = 'public'
           and c.table_name  = t.table_name
           and c.column_name = t.column_name
           and c.data_type   = 'timestamp without time zone'
    loop
        execute format(
            'alter table public.%I alter column %I type timestamptz using %I at time zone ''UTC''',
            r.table_name, r.column_name, r.column_name
        );
    end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. FK indexes (Postgres does not auto-index FK columns; RLS predicates use these)
--    message_translations(message_id) is already covered by the unique
--    (message_id, language) index, so it is not repeated here.
-- ---------------------------------------------------------------------------
create index if not exists idx_messages_conversation_id on public.messages (conversation_id);
create index if not exists idx_messages_sender_id       on public.messages (sender_id);
create index if not exists idx_messages_tenant_id       on public.messages (tenant_id);
create index if not exists idx_msg_translations_tenant_id on public.message_translations (tenant_id);

commit;

-- ===========================================================================
-- Verification (run after, expect the noted results):
-- ---------------------------------------------------------------------------
-- 1. conversation_id present, defaulted, no NULLs:
--    select count(*) filter (where conversation_id is null) as nulls,
--           count(*) as total
--      from public.messages;                    -- expect nulls = 0
--    select column_default from information_schema.columns
--      where table_name='messages' and column_name='conversation_id';
--                                               -- expect the ...0002 sentinel
--
-- 2. Vestigial columns gone:
--    select column_name from information_schema.columns
--      where table_schema='public' and table_name='messages'
--        and column_name in ('room_id','translated_text','target_language',
--                            'tone','context_id','model_version','latency_ms');
--                                               -- expect 0 rows
--
-- 3. All four converted to timestamptz:
--    select table_name, column_name, data_type from information_schema.columns
--      where table_schema='public'
--        and (table_name,column_name) in
--            (('message_translations','created_at'),('conversation_contexts','updated_at'),
--             ('tenants','created_at'),('user_profile_events','created_at'));
--                                               -- expect data_type = 'timestamp with time zone' for all
--
-- 4. Indexes exist:
--    select indexname from pg_indexes where schemaname='public'
--      and indexname in ('idx_messages_conversation_id','idx_messages_sender_id',
--                        'idx_messages_tenant_id','idx_msg_translations_tenant_id');
--                                               -- expect 4 rows
-- ===========================================================================
