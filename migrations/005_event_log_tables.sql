-- Migration 005 — Event log tables
-- Date: 2026-06-02
-- Phase: 1.5 (Spec 4a)
--
-- Creates:
--   agent_events       — Hermes-level audit log; one row per Hermes task
--   translation_events — Per-call instrumentation for every translation pipeline invocation
--
-- Order matters: agent_events first so translation_events.task_id can reference it
-- logically. No FK constraint is enforced on task_id (loose reference) — Hermes-driven
-- translations are a small subset and we don't want INSERT ordering constraints.
--
-- Both tables are append-only. Never UPDATE. Never DELETE (except GDPR anonymisation
-- pipeline per architecture.md §10, which anonymises rather than deletes).
--
-- How to run: Paste into the Supabase SQL editor (Dashboard → SQL → New query).
-- Run against STAGING first, verify with the queries at the bottom, then run against PROD.

-- ─────────────────────────────────────────────────────────────────────────────
-- agent_events
-- ─────────────────────────────────────────────────────────────────────────────
-- Hermes generates task_id at task start (before any DB write), threads it through
-- all tool calls, and writes ONE row at task completion. Crashed tasks leave no row —
-- gaps are the signal. Written via hermes_writer role (INSERT-only).

create table if not exists public.agent_events (
  -- Identity
  id                    uuid        primary key default gen_random_uuid(),
  task_id               uuid        not null unique,
  parent_task_id        uuid,                               -- loose self-reference; no FK constraint
  schema_version        integer     not null default 1,
  idempotency_key       text        unique,                 -- prevents double-execution on retry

  -- Tenant (required per architecture.md §3.4)
  tenant_id             uuid        not null references public.tenants(id),

  -- Timing
  started_at            timestamptz not null,
  completed_at          timestamptz,                        -- null if task crashed

  -- Status
  status                text        not null
    check (status in ('completed', 'failed', 'escalated', 'aborted')),

  -- Task description
  task_summary          text        not null,

  -- Source / gateway
  gateway               text        not null
    check (gateway in ('discord', 'cli', 'scheduled')),
  channel_id            text,                               -- Discord channel snowflake ID
  channel_name          text,                               -- snapshot at task time
  thread_id             text,                               -- Discord thread ID if applicable
  initiating_message_id text,                               -- Discord message that triggered the task
  triggered_by          text,                               -- display name of requester
  conversation_turns    integer,                            -- back-and-forth count

  -- Model + cost
  model_tier            text        not null
    check (model_tier in ('sonnet', 'opus')),
  model_used            text        not null,               -- e.g. 'claude-sonnet-4-6'
  tokens_in             integer,
  tokens_out            integer,
  cost_cents            integer,

  -- Outputs
  files_changed         text[],
  commits               text[],
  deploys               text[],
  decisions_drafted     integer     default 0,
  skills_created        integer     default 0,

  -- Audit
  errors                jsonb,                              -- [{type, message, timestamp}, ...]
  approval_log          jsonb,                              -- [{asked_at, question, response, responded_at}, ...]
  raw_report            text,                               -- full §8.1 end-of-task report

  created_at            timestamptz not null default now()
);

-- Indexes
create index if not exists agent_events_tenant_channel
  on public.agent_events (tenant_id, channel_id, started_at desc);

create index if not exists agent_events_task_id
  on public.agent_events (task_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- translation_events
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per translation pipeline invocation. Written server-side in
-- api/v1/translate.js (Spec 4b). Write failure is non-blocking — translation
-- response is returned to the user regardless.
-- task_id is a loose reference to agent_events.task_id (no FK constraint).

create table if not exists public.translation_events (
  id              uuid        primary key default gen_random_uuid(),
  schema_version  integer     not null default 1,

  -- Tenant + task linkage
  tenant_id       uuid        not null references public.tenants(id),
  task_id         uuid,                                     -- loose ref to agent_events.task_id; null for user-initiated calls

  -- User
  user_id         text,                                     -- sender's id when known

  -- Timing
  timestamp       timestamptz not null default now(),

  -- Translation fields
  source_language text,                                     -- BCP 47; nullable if detect-only
  target_language text        not null,                     -- BCP 47
  was_cached      boolean     not null,
  model_used      text        not null,                     -- e.g. 'gpt-4o-mini'
  prompt_version  text        not null,                     -- mirrors architecture.md §9 versioning
  latency_ms      integer     not null,
  character_count integer     not null,

  -- Cost
  input_tokens    integer,                                  -- provider-reported
  output_tokens   integer,                                  -- provider-reported
  cost_cents      integer,                                  -- computed from tokens × rate

  -- Error tracking
  retry_count     integer     not null default 0,
  error_type      text,                                     -- e.g. 'rate_limit', 'parse_failure', 'timeout'

  -- Source classification
  event_source    text        not null default 'chat_app'
    check (event_source in ('chat_app', 'hermes_test', 'api_external')),

  created_at      timestamptz not null default now()
);

-- Indexes
create index if not exists translation_events_tenant_timestamp
  on public.translation_events (tenant_id, timestamp desc);

create index if not exists translation_events_task_id
  on public.translation_events (task_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification queries — run after migration to confirm
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1. Confirm agent_events columns:
--    select column_name, data_type, is_nullable
--      from information_schema.columns
--      where table_schema = 'public' and table_name = 'agent_events'
--      order by ordinal_position;
--    -- expect 29 columns
--
-- 2. Confirm translation_events columns:
--    select column_name, data_type, is_nullable
--      from information_schema.columns
--      where table_schema = 'public' and table_name = 'translation_events'
--      order by ordinal_position;
--    -- expect 21 columns
--
-- 3. Confirm indexes:
--    select indexname, tablename from pg_indexes
--      where tablename in ('agent_events', 'translation_events')
--      order by tablename, indexname;
--    -- expect 4 rows: 2 per table
--
-- 4. Quick insert + read smoke test (staging only — delete row after):
--    insert into public.agent_events
--      (task_id, tenant_id, started_at, status, task_summary, gateway, model_tier, model_used)
--    values
--      (gen_random_uuid(), '00000000-0000-0000-0000-000000000001',
--       now(), 'completed', 'migration smoke test', 'cli', 'sonnet', 'claude-sonnet-4-6');
--    select task_summary, status, gateway from public.agent_events order by created_at desc limit 1;
--    -- expect 1 row with task_summary = 'migration smoke test'
--    delete from public.agent_events where task_summary = 'migration smoke test';
