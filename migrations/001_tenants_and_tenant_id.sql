-- Migration 001 — Tenants table + tenant_id columns on existing tables
-- Date: 2026-05-12
-- Phase: 0 (Foundation)
--
-- Purpose: Establish the multi-tenant primitive ahead of the Phase 2 API opening.
-- Even with one tenant (this chat app), adding tenant_id to existing tables now
-- avoids one of the most painful retroactive migrations possible.
--
-- How to run: Paste the contents of this file into the Supabase SQL editor
-- (Supabase Dashboard → SQL → New query) and run. Idempotent — safe to re-run.

-- 1. Tenants table
create table if not exists public.tenants (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    default_correction_ownership text not null default 'platform'
        check (default_correction_ownership in ('platform', 'tenant', 'shared')),
    training_data_agreement boolean not null default false,
    created_at timestamp with time zone not null default now()
);

-- 2. Seed the chat app's tenant row
-- Fixed UUID so frontend can reference it without a lookup
insert into public.tenants (id, name, default_correction_ownership, training_data_agreement)
values (
    '00000000-0000-0000-0000-000000000001',
    'Translation Chat App',
    'platform',
    true
)
on conflict (id) do nothing;

-- 3. Add tenant_id columns to existing tables (nullable first so backfill can happen)
alter table public.messages
    add column if not exists tenant_id uuid references public.tenants(id);

alter table public.message_translations
    add column if not exists tenant_id uuid references public.tenants(id);

alter table public.user_profiles
    add column if not exists tenant_id uuid references public.tenants(id);

-- 4. Backfill existing rows with the chat app's tenant ID
update public.messages
    set tenant_id = '00000000-0000-0000-0000-000000000001'
    where tenant_id is null;

update public.message_translations
    set tenant_id = '00000000-0000-0000-0000-000000000001'
    where tenant_id is null;

update public.user_profiles
    set tenant_id = '00000000-0000-0000-0000-000000000001'
    where tenant_id is null;

-- 5. Make tenant_id NOT NULL now that backfill is complete
alter table public.messages alter column tenant_id set not null;
alter table public.message_translations alter column tenant_id set not null;
alter table public.user_profiles alter column tenant_id set not null;

-- 6. Indexes for tenant-scoped queries (foundation for RLS in Phase 2)
create index if not exists idx_messages_tenant_id on public.messages(tenant_id);
create index if not exists idx_message_translations_tenant_id on public.message_translations(tenant_id);
create index if not exists idx_user_profiles_tenant_id on public.user_profiles(tenant_id);

-- Verification queries (run these manually after the migration to confirm):
--   select * from public.tenants;
--   select count(*) from public.messages where tenant_id is null;             -- expect 0
--   select count(*) from public.message_translations where tenant_id is null; -- expect 0
--   select count(*) from public.user_profiles where tenant_id is null;        -- expect 0
