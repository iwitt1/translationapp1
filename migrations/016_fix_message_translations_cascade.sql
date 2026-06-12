-- Migration 016 — Reconcile message_translations → messages FK to ON DELETE CASCADE
-- Date: 2026-06-12
-- Phase: 3 (schema hygiene; precedes the Phase 3 conversations work in 017/018)
--
-- Purpose: Fix an environment drift discovered 2026-06-12 while purging the
-- retired global-room sentinel data. The translation-cache FK
-- message_translations.message_id → messages(id) is ON DELETE CASCADE on PROD
-- (pg_constraint.confdeltype = 'c') but NO ACTION on STAGING (confdeltype = 'a').
--
-- Root cause: migration 000 is a hand-reconstruction of the pre-migrations base
-- tables (messages / message_translations / user_profiles), which were originally
-- created in the Supabase Studio UI before /migrations/ existed. Prod carries the
-- ON DELETE CASCADE the UI set; the reconstruction in 000 wrote the FK WITHOUT the
-- clause. Staging, built by replaying 000+ from scratch, faithfully reproduced the
-- inaccurate reconstruction — so staging diverged while prod stayed correct.
-- A full FK/default/nullability audit of the three 000-era tables (2026-06-12)
-- found THIS to be the only drift; everything else matched across environments.
-- See decisions.md 2026-06-12 "FK drift: message_translations → messages cascade".
--
-- Intended behavior is CASCADE: the cache is a strict child of its message, so
-- deleting a message must delete its cached translations (Spec 7 / migration 018
-- relies on this child relationship). This migration aligns the constraint to
-- ON DELETE CASCADE on BOTH environments:
--   - On staging it is the actual fix (a → c).
--   - On prod it drops the cascade FK and re-adds an identical one — a no-op in
--     effect, safe to replay.
-- migration 000 is corrected in the same commit so future fresh builds (000 → …)
-- no longer reintroduce the drift.
--
-- ALTER-only, idempotent, no table recreate (operations.md §3 recreate checklist
-- not triggered). No data change. Re-adding the FK re-validates existing rows; all
-- message_translations rows already satisfied the prior NO ACTION FK, so validation
-- passes.
--
-- How to run: paste into the Supabase SQL editor against STAGING first, verify with
-- the query at the foot, then replay against prod. Expect confdeltype = 'c' on both.

begin;

alter table public.message_translations
  drop constraint if exists message_translations_message_id_fkey;

alter table public.message_translations
  add constraint message_translations_message_id_fkey
  foreign key (message_id) references public.messages(id) on delete cascade;

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification — run after; expect ONE row, confdeltype = 'c', on BOTH staging
-- and prod:
-- ─────────────────────────────────────────────────────────────────────────────
--   select conname, confdeltype
--     from pg_constraint
--    where conname = 'message_translations_message_id_fkey';
--   -- confdeltype: 'c' = cascade (expected), 'a' = no action, 'r' = restrict
