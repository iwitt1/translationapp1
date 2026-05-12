-- Migration 003: prompt versioning + nonbinary gender signal
-- Run in Supabase SQL editor after 002_phase1_schema.sql
--
-- Changes:
--   1. message_translations       — add prompt_version column (nullable text)
--   2. user_linguistic_profiles   — add 'nonbinary' to gender_signal check constraint

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. message_translations: add prompt_version
-- ─────────────────────────────────────────────────────────────────────────────
-- Stamps each cached translation with the prompt version that produced it.
-- Null for translations cached before this migration (pre-versioning).
-- Used in Phase 4+ corrections analysis to correlate quality shifts with
-- prompt changes. See architecture.md §9 for versioning convention.

alter table message_translations
  add column if not exists prompt_version text;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. user_linguistic_profiles: add 'nonbinary' to gender_signal
-- ─────────────────────────────────────────────────────────────────────────────
-- Postgres check constraints cannot be extended in place — drop and recreate.
-- 'nonbinary' means the speaker actively uses gender-inclusive or nonbinary
-- language forms (Spanish -e / "elle", French "iel", Portuguese -x/-@, German
-- gender star). This is distinct from 'neutral', which means the source language
-- has no grammatical gender (Finnish, Turkish, Hungarian, etc.).

alter table user_linguistic_profiles
  drop constraint if exists user_linguistic_profiles_gender_signal_check;

alter table user_linguistic_profiles
  add constraint user_linguistic_profiles_gender_signal_check
  check (gender_signal in ('masculine', 'feminine', 'neutral', 'nonbinary', 'unknown'));
