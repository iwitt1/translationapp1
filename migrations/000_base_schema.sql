-- Migration 000 — Base schema (pre-migrations baseline)
-- Date: 2026-05-18
-- Phase: -1 (predates the /migrations/ folder; reconstructed from prod inspection)
--
-- Purpose: Captures the state of public.messages, public.message_translations,
-- and public.user_profiles BEFORE migration 001 ran. These tables were created
-- via the Supabase Studio UI early in the project's life, before /migrations/
-- was adopted as the source of truth for schema changes. This file closes that
-- gap so a fresh empty Postgres can be brought to the current prod state by
-- running 000 → 001 → 002 → 003 in order.
--
-- NOTE: Some columns on `messages` (room_id, translated_text, target_language,
-- tone, context_id, model_version, latency_ms) are vestigial — they predate
-- the current architecture and are not read or written by the live code.
-- They are preserved here so staging exactly mirrors prod; see
-- /docs/parking-lot.md "Known technical debt → Vestigial columns on messages"
-- for the cleanup item.
--
-- How to run: Paste into the Supabase SQL editor (Dashboard → SQL → New query)
-- against the STAGING project and run. Idempotent — safe to re-run.

-- ─────────────────────────────────────────────────────────────────────────────
-- messages
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.messages (
    id              uuid                        primary key default gen_random_uuid(),
    created_at      timestamp with time zone    default now(),
    -- Active columns used by the live application
    sender_id       text,
    original_text   text,
    source_language text,
    -- Vestigial columns from pre-migrations era; preserved to mirror prod
    room_id         uuid,
    translated_text text,
    target_language text,
    tone            text,
    context_id      text,
    model_version   text                        default 'V1',
    latency_ms      numeric
    -- tenant_id added by migration 001
);

-- ─────────────────────────────────────────────────────────────────────────────
-- message_translations
-- ─────────────────────────────────────────────────────────────────────────────
-- Translation cache. One row per (message_id, language).

create table if not exists public.message_translations (
    id              uuid                        primary key default gen_random_uuid(),
    message_id      uuid                        references public.messages(id),
    language        text                        not null,
    translated_text text                        not null,
    created_at      timestamp without time zone default now(),
    unique (message_id, language)
    -- tenant_id added by migration 001
    -- prompt_version added by migration 003
);

-- ─────────────────────────────────────────────────────────────────────────────
-- user_profiles
-- ─────────────────────────────────────────────────────────────────────────────
-- Per-user profile. user_id is the typed username string (Phase 1).
-- Will migrate to uuid in Phase 2 when Supabase Auth is adopted.

create table if not exists public.user_profiles (
    id               uuid                        primary key default gen_random_uuid(),
    user_id          text                        unique,
    display_name     text,
    default_language text                        default 'en',
    created_at       timestamp without time zone default now()
    -- tenant_id added by migration 001
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification queries — run after the migration to confirm:
-- ─────────────────────────────────────────────────────────────────────────────
--
--   select count(*) from public.messages;              -- expect 0 (empty staging)
--   select count(*) from public.message_translations;  -- expect 0
--   select count(*) from public.user_profiles;         -- expect 0
--
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--     where table_schema = 'public' and table_name = 'messages'
--     order by ordinal_position;
--   -- expect 11 columns: id, created_at, sender_id, original_text, source_language,
--   -- room_id, translated_text, target_language, tone, context_id, model_version,
--   -- latency_ms — same as prod minus tenant_id (which 001 will add next).
