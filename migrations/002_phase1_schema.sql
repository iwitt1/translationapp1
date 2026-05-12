-- Migration 002: Phase 1 schema additions
-- Run in Supabase SQL editor after 001_tenants_and_tenant_id.sql
--
-- Creates:
--   user_linguistic_profiles   — per-user linguistic model, built up from inferences
--   conversation_contexts      — per-conversation register/closeness signals
--   user_profile_events        — append-only event log of profile changes
--
-- NOTE: user_id is TEXT in Phase 1 to match user_profiles.user_id (username string).
-- This will be migrated to UUID in Phase 2 when Supabase Auth (real identities) is adopted.

-- ─────────────────────────────────────────────────────────────────────────────
-- user_linguistic_profiles
-- ─────────────────────────────────────────────────────────────────────────────
-- Primary key is (user_id, tenant_id) — one profile per user per tenant.
-- _source columns track whether a value was set explicitly by the user or
-- inferred from translations. Explicit always wins (app enforces this).

create table if not exists user_linguistic_profiles (
  user_id              text        not null,
  tenant_id            uuid        not null references tenants(id),

  preferred_language   text,                        -- e.g. "es"

  dialect_region       text,                        -- e.g. "es-AR", "pt-BR"
  dialect_confidence   float       default 0.0,     -- 0.0–1.0
  dialect_source       text        default 'inferred'
    check (dialect_source in ('explicit', 'inferred')),

  formality_preference text
    check (formality_preference in ('formal', 'neutral', 'casual')),
  formality_source     text        default 'inferred'
    check (formality_source in ('explicit', 'inferred')),

  gender_signal        text
    check (gender_signal in ('masculine', 'feminine', 'neutral', 'unknown')),
  gender_source        text        default 'inferred'
    check (gender_source in ('explicit', 'inferred')),

  script_preference    text,                        -- e.g. "latin", "traditional", "simplified"
  script_source        text        default 'inferred'
    check (script_source in ('explicit', 'inferred')),

  known_languages      text[],                      -- e.g. '{"es","en"}'

  updated_at           timestamptz default now(),

  primary key (user_id, tenant_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- conversation_contexts
-- ─────────────────────────────────────────────────────────────────────────────
-- Stores the inferred register and closeness for a conversation.
-- In Phase 1 there are no real conversation rows yet (that's Phase 3).
-- The table is created now so the schema is stable. Phase 3 adds the FK
-- to conversations.id and populates rows properly.
-- participant_ids is text[] in Phase 1 to match text user_ids.

create table if not exists conversation_contexts (
  conversation_id         uuid        not null,
  tenant_id               uuid        not null references tenants(id),

  participant_ids         text[],                   -- text in Phase 1; uuid[] in Phase 2

  detected_register       text
    check (detected_register in ('professional','casual','romantic','family','support')),
  register_confidence     float       default 0.0,

  relationship_closeness  text
    check (relationship_closeness in ('new','acquainted','close')),
  closeness_signals       jsonb,                    -- {message_count, days_active, avg_response_time}

  dominant_topics         text[],                   -- e.g. '{"medical","legal"}'

  updated_at              timestamptz default now(),

  primary key (conversation_id, tenant_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- user_profile_events
-- ─────────────────────────────────────────────────────────────────────────────
-- Append-only event log. NEVER UPDATE OR DELETE rows in this table.
-- Records every inference and explicit change to user_linguistic_profiles.
-- Lets you reconstruct what the system believed about a user at any point in time.

create table if not exists user_profile_events (
  id              uuid        primary key default gen_random_uuid(),
  user_id         text        not null,
  tenant_id       uuid        not null references tenants(id),

  event_type      text        not null,             -- e.g. "dialect_region_inferred"
  previous_value  jsonb,
  new_value       jsonb,

  source          text        not null
    check (source in ('explicit', 'inference', 'correction_analysis')),

  created_at      timestamptz default now()
);
