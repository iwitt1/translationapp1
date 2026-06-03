-- Migration 006 — Add task_id to user_profile_events
-- Date: 2026-06-02
-- Phase: 1.5 (Spec 4a)
--
-- Adds a nullable task_id column to user_profile_events so that profile inferences
-- triggered by a Hermes task can be traced back to the originating task.
-- No FK constraint — loose reference to agent_events.task_id. Most profile events
-- are user-triggered and will have task_id = null; Hermes-triggered ones will populate it.
--
-- How to run: Paste into the Supabase SQL editor (Dashboard → SQL → New query).
-- Run against STAGING first, verify, then run against PROD.

alter table public.user_profile_events
  add column if not exists task_id uuid;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification queries
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Confirm column exists:
--   select column_name, data_type, is_nullable
--     from information_schema.columns
--     where table_schema = 'public'
--       and table_name = 'user_profile_events'
--       and column_name = 'task_id';
--   -- expect 1 row: task_id | uuid | YES
