-- Migration 017 — Phase 3 Step 1: Conversations schema + write RPCs (Spec 6)
-- Date: 2026-06-12
-- Phase: 3 (Real conversation model)
--
-- Ends the "one global room" model at the SCHEMA layer (the membership-scoped
-- messages RLS — the security-sensitive half — is Spec 7 / migration 018, deliberately
-- separate). After this migration a user can belong to many distinct conversations.
--
-- What this migration does, in order (single transaction):
--   0. tenants.conversation_policy jsonb — per-tenant dedupe override seam (mirrors
--      tenants.dm_initiation_policy). Default '{}' → global defaults in lib/policies.js apply.
--   1. conversations table (+ canonical dedupe_key + RLS) and the global-room row.
--   2. conversation_members table (+ partial-unique active membership + FK indexes + RLS).
--   3. is_active_member() helper — STABLE SECURITY DEFINER; reused by the conversations /
--      conversation_members / conversation_contexts RLS, the three write RPCs, and Spec 7.
--   4. Promote messages.conversation_id: add FK → conversations(id), SET NOT NULL, DROP the
--      migration-014 sentinel default. Zero backfill (014 already defaulted every row to
--      the global-conversation sentinel …0002, inserted in step 1).
--   5. conversation_contexts: add the long-missing FK (NOT VALID — see note) and its first
--      RLS policy. Closes the Phase-1 RLS gap flagged in architecture.md §7.
--   6. Write RPCs: create_conversation / leave_conversation / set_conversation_context_type,
--      plus create_invite + redeem_invite amended to handle 'conversation'-kind invites.
--
-- Design decisions baked in here (see decisions.md 2026-06-12):
--   • Direct-dedupe is race-safe via a CANONICAL-KEY COLUMN, not a lock: conversations.dedupe_key
--     holds the sorted member-set when the resolved policy is "dedupe" (NULL = always-new), with a
--     partial unique index (tenant_id, dedupe_key). The DB itself is the arbiter — two simultaneous
--     "message X" taps resolve to one thread. Mirrors the relationships(account_lo, account_hi)
--     canonical-pair idiom. Generalizes to group-dedupe for free (a B2B tenant flips conversation_policy).
--   • Dedupe is POLICY-DRIVEN, not hardcoded to kind: default direct→dedupe, group→always-new
--     (lib/policies.js CONVERSATION.DEFAULTS), overridable per tenant via tenants.conversation_policy.
--     Consulted at creation time only; never merges or alters existing conversations.
--   • conversations.created_by is nullable ON DELETE SET NULL: hard-deleting a creator (Step-7 job)
--     must not nuke a conversation other people are still in.
--   • conversation_contexts FK added NOT VALID: the table predates a real conversations table and may
--     hold legacy Phase-1 inference rows. NOT VALID enforces the FK on all new/updated rows without
--     scanning legacy rows (which would risk the whole migration). A VALIDATE CONSTRAINT can follow
--     once the global-room context rows are confirmed resolvable/purged.
--
-- Idempotent + ALTER-only: re-running is a no-op; no table recreate (operations.md §3 not triggered).
-- Staging-first: run on translationapp1-staging, gate (scripts/conversations-gate-test.mjs) GREEN,
-- then prod replay. Mirrors migration 011 for all table/RLS/RPC idioms.

begin;

-- ═════════════════════════════════════════════════════════════════════════════
-- 0. tenants.conversation_policy — per-tenant dedupe override (Phase 6 seam)
-- ═════════════════════════════════════════════════════════════════════════════
-- jsonb shape: { "direct": "dedupe"|"always_new", "group": "dedupe"|"always_new" }.
-- '{}' = no override → lib/policies.js CONVERSATION.DEFAULTS (direct=dedupe, group=always_new).
alter table public.tenants
  add column if not exists conversation_policy jsonb not null default '{}';

comment on column public.tenants.conversation_policy is
  'Per-tenant conversation dedupe override (jsonb). Keys: direct, group → dedupe|always_new. '
  'Empty = fall through to lib/policies.js CONVERSATION.DEFAULTS. Read at creation time only.';


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. conversations
-- ═════════════════════════════════════════════════════════════════════════════
-- A conversation is a first-class object (not derived from its member set). dedupe_key
-- is the canonical sorted member-set, populated ONLY when the resolved policy is "dedupe"
-- (NULL otherwise) — the partial unique index then guarantees one thread per deduped set.
create table if not exists public.conversations (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references public.tenants(id),
  kind          text        not null
    constraint conversations_kind_check check (kind in ('direct', 'group')),
  title         text,                                  -- null for direct; optional for group
  context_type  text        not null default 'casual'
    constraint conversations_context_type_check
      check (context_type in ('professional', 'casual', 'romantic', 'family', 'support')),
  created_by    uuid        references public.profiles(id) on delete set null,  -- nullable: see header
  dedupe_key    text,                                  -- canonical member-set; null = always-new
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- RLS predicates filter on tenant_id; Postgres does not auto-index FK columns.
create index if not exists conversations_tenant_id_idx
  on public.conversations (tenant_id);

-- One conversation per (tenant, deduped member-set). Partial: groups/always-new rows
-- carry dedupe_key = NULL and are exempt. This is the race-safety arbiter for direct dedupe.
create unique index if not exists conversations_dedupe_unique
  on public.conversations (tenant_id, dedupe_key)
  where dedupe_key is not null;

-- Global-conversation row (sentinel …0002 from migration 014) — every pre-existing
-- message FK-resolves to it. created_by NULL (system row); dedupe_key NULL (never deduped).
insert into public.conversations (id, tenant_id, kind, title, context_type, created_by)
values (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'group',
  'Global (legacy, retired)',
  'casual',
  null
)
on conflict (id) do nothing;

alter table public.conversations enable row level security;
-- (SELECT policy created below, after is_active_member() exists.)


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. conversation_members
-- ═════════════════════════════════════════════════════════════════════════════
-- Soft-leave model (left_at) mirrors blocks.unblocked_at: a non-null left_at preserves
-- history; the partial unique index permits exactly one ACTIVE membership per pair while
-- historical rows coexist. last_read_at lands here for later unread counts (nothing reads it yet).
create table if not exists public.conversation_members (
  id              uuid        primary key default gen_random_uuid(),
  conversation_id uuid        not null references public.conversations(id) on delete cascade,
  account_id      uuid        not null references public.profiles(id) on delete cascade,
  tenant_id       uuid        not null references public.tenants(id),
  role            text        not null default 'member'
    constraint conversation_members_role_check check (role in ('owner', 'member')),
  joined_at       timestamptz not null default now(),
  left_at         timestamptz,                         -- null = active member
  last_read_at    timestamptz                          -- Phase 3 later: unread counts
);

-- One active membership per (conversation, account); leave/re-join history coexists.
create unique index if not exists conversation_members_active_unique
  on public.conversation_members (conversation_id, account_id)
  where left_at is null;

-- FK indexes (RLS predicates + the is_active_member lookup read these).
create index if not exists conversation_members_account_id_idx
  on public.conversation_members (account_id);
create index if not exists conversation_members_conversation_id_idx
  on public.conversation_members (conversation_id);

alter table public.conversation_members enable row level security;
-- (SELECT policy created below, after is_active_member() exists.)


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. is_active_member(conversation, account) — membership helper
-- ═════════════════════════════════════════════════════════════════════════════
-- True iff the account has an ACTIVE (left_at IS NULL) membership of the conversation.
-- STABLE SECURITY DEFINER: RLS policies on conversations / conversation_members /
-- conversation_contexts call it, so it must read conversation_members under its OWN
-- privilege (the caller needs no direct SELECT, and the policy does not recurse — same
-- reasoning as auth_tenant_id()). Tenant scoping is applied by the callers (they AND in
-- tenant_id = auth_tenant_id()); a conversation belongs to exactly one tenant.
create or replace function public.is_active_member(
  p_conversation_id uuid,
  p_account_id      uuid
)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.conversation_members
    where conversation_id = p_conversation_id
      and account_id      = p_account_id
      and left_at is null
  )
$$;

comment on function public.is_active_member(uuid, uuid) is
  'True iff account has an active (left_at IS NULL) membership of the conversation. '
  'STABLE SECURITY DEFINER so RLS policies can read conversation_members without recursion. '
  'Reused by conversations/conversation_members/conversation_contexts RLS, the write RPCs, and Spec 7.';

revoke all on function public.is_active_member(uuid, uuid) from public, anon;
grant execute on function public.is_active_member(uuid, uuid) to authenticated;


-- ── RLS: conversations SELECT — active members of the conversation ────────────
drop policy if exists "conversations_select_member" on public.conversations;
create policy "conversations_select_member" on public.conversations
  for select to authenticated
  using (
    tenant_id = public.auth_tenant_id()
    and public.is_active_member(id, auth.uid())
  );
-- INSERT/UPDATE/DELETE: no policy → denied. create_conversation / set_conversation_context_type own writes.

-- ── RLS: conversation_members SELECT — own rows + co-members of your conversations ─
drop policy if exists "conversation_members_select_member" on public.conversation_members;
create policy "conversation_members_select_member" on public.conversation_members
  for select to authenticated
  using (
    tenant_id = public.auth_tenant_id()
    and (
      account_id = auth.uid()                                  -- always see your own membership rows
      or public.is_active_member(conversation_id, auth.uid())  -- and co-members of conversations you're in
    )
  );
-- INSERT/UPDATE/DELETE: no policy → denied. The RPCs own all membership writes.


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Promote messages.conversation_id (forward-prep from migration 014 → real FK)
-- ═════════════════════════════════════════════════════════════════════════════
-- Runs AFTER the global row insert (step 1) so the FK validates against pre-existing
-- sentinel rows. No ON DELETE: conversations are never hard-deleted in this model
-- (soft-leave only); NO ACTION blocks an accidental delete while messages exist.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'messages_conversation_id_fkey'
      and conrelid = 'public.messages'::regclass
  ) then
    alter table public.messages
      add constraint messages_conversation_id_fkey
      foreign key (conversation_id) references public.conversations(id);
  end if;
end $$;

-- No NULLs after migration 014's backfill+default → SET NOT NULL is safe. Idempotent (no-op if already set).
alter table public.messages alter column conversation_id set not null;

-- Real conversation ids take over from here; drop the sentinel default. Idempotent.
alter table public.messages alter column conversation_id drop default;


-- ═════════════════════════════════════════════════════════════════════════════
-- 5. conversation_contexts — add the long-missing FK + first RLS policy
-- ═════════════════════════════════════════════════════════════════════════════
-- FK added NOT VALID (see header): enforces on new/updated rows without scanning legacy
-- Phase-1 inference rows. on delete cascade — a context row is derived data for its conversation.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'conversation_contexts_conversation_id_fkey'
      and conrelid = 'public.conversation_contexts'::regclass
  ) then
    alter table public.conversation_contexts
      add constraint conversation_contexts_conversation_id_fkey
      foreign key (conversation_id) references public.conversations(id) on delete cascade
      not valid;
  end if;
end $$;

-- This table had NO RLS (Phase-1 gap, architecture.md §7). Enable it and gate SELECT to
-- active members. Writes are by the background context job (service role, bypasses RLS) →
-- no INSERT/UPDATE/DELETE policy.
alter table public.conversation_contexts enable row level security;

drop policy if exists "conversation_contexts_select_member" on public.conversation_contexts;
create policy "conversation_contexts_select_member" on public.conversation_contexts
  for select to authenticated
  using (
    tenant_id = public.auth_tenant_id()
    and public.is_active_member(conversation_id, auth.uid())
  );


-- ═════════════════════════════════════════════════════════════════════════════
-- 6. Write RPCs
-- ═════════════════════════════════════════════════════════════════════════════

-- ── create_conversation ──────────────────────────────────────────────────────
-- Inserts the conversation (caller = created_by, role='owner' on a NEW row) and active
-- memberships for the caller + each member. Single-tenant invariant: every member must be
-- an active profile in the caller's tenant (else opaque "member not found"). Block-gated.
-- kind='direct' requires exactly 2 distinct members; self-only is rejected. Dedupe is
-- policy-driven + race-safe (canonical dedupe_key + the partial unique index): a dedupe-hit
-- returns the existing thread and reactivates any member who had left.
create or replace function public.create_conversation(
  p_kind         text,
  p_member_ids   uuid[],
  p_title        text DEFAULT NULL,
  p_context_type text DEFAULT 'casual'
)
returns uuid
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_tenant  uuid := public.auth_tenant_id();
  v_members uuid[];
  v_valid   integer;
  v_policy  jsonb;
  v_mode    text;
  v_dedupe  boolean;
  v_key     text;
  v_conv_id uuid;
  v_new     boolean := false;
  m         uuid;
begin
  if v_uid is null or v_tenant is null then
    raise exception 'create_conversation: not authenticated' using errcode = '28000';
  end if;
  if p_kind not in ('direct', 'group') then
    raise exception 'create_conversation: invalid kind %', p_kind;
  end if;
  if p_context_type not in ('professional', 'casual', 'romantic', 'family', 'support') then
    raise exception 'create_conversation: invalid context_type %', p_context_type;
  end if;

  -- Distinct member set including the caller (drop NULLs / dups / caller-in-list).
  v_members := array(
    select distinct x
    from unnest(coalesce(p_member_ids, '{}'::uuid[]) || v_uid) as x
    where x is not null
  );

  if cardinality(v_members) < 2 then
    raise exception 'create_conversation: a conversation needs at least one other member';
  end if;
  if p_kind = 'direct' and cardinality(v_members) <> 2 then
    raise exception 'create_conversation: direct conversations are exactly 2 members';
  end if;

  -- Single-tenant invariant: every member is an active profile in the caller's tenant.
  -- Opaque error (cross-tenant / unknown member = "not found"), matching request_contact.
  select count(*) into v_valid
  from public.profiles
  where id = any(v_members) and tenant_id = v_tenant and status = 'active';
  if v_valid <> cardinality(v_members) then
    raise exception 'create_conversation: member not found';
  end if;

  -- Block gate (either direction) between the caller and each other member.
  foreach m in array v_members loop
    if m <> v_uid and public.active_block_exists(v_uid, m) then
      raise exception 'create_conversation: cannot add this user';
    end if;
  end loop;

  -- Resolve dedupe policy: tenant override (tenants.conversation_policy) on top of the
  -- global default (direct→dedupe, group→always_new). Mirrors lib/policies.js resolve().
  select conversation_policy into v_policy from public.tenants where id = v_tenant;
  v_mode := coalesce(
    v_policy ->> p_kind,
    case when p_kind = 'direct' then 'dedupe' else 'always_new' end
  );
  v_dedupe := (v_mode = 'dedupe');

  -- Canonical key = sorted member-set, only when deduping (NULL → exempt from the unique index).
  if v_dedupe then
    select string_agg(x::text, ',' order by x) into v_key from unnest(v_members) x;
  end if;

  -- Find-or-create. The partial unique index on (tenant_id, dedupe_key) is the arbiter:
  -- a concurrent insert of the same key loses the race and we re-SELECT the winner's row.
  if v_dedupe then
    begin
      insert into public.conversations (tenant_id, kind, title, context_type, created_by, dedupe_key)
      values (v_tenant, p_kind, p_title, p_context_type, v_uid, v_key)
      returning id into v_conv_id;
      v_new := true;
    exception
      when unique_violation then
        select id into v_conv_id
        from public.conversations
        where tenant_id = v_tenant and dedupe_key = v_key;
        v_new := false;
    end;
  else
    insert into public.conversations (tenant_id, kind, title, context_type, created_by, dedupe_key)
    values (v_tenant, p_kind, p_title, p_context_type, v_uid, null)
    returning id into v_conv_id;
    v_new := true;
  end if;

  -- Ensure an active membership for every member. On a dedupe-hit this reactivates anyone
  -- who had left (re-opening the thread). The per-row sub-block swallows the glare race
  -- against a concurrent identical insert (the partial unique index already guarantees one).
  foreach m in array v_members loop
    if not exists (
      select 1 from public.conversation_members
      where conversation_id = v_conv_id and account_id = m and left_at is null
    ) then
      begin
        insert into public.conversation_members (conversation_id, account_id, tenant_id, role)
        values (
          v_conv_id, m, v_tenant,
          case when m = v_uid and v_new then 'owner' else 'member' end
        );
      exception
        when unique_violation then
          null;  -- a concurrent call already added an active membership; fine
      end;
    end if;
  end loop;

  return v_conv_id;
end;
$$;

comment on function public.create_conversation(text, uuid[], text, text) is
  'Create (or, for a deduped pair, return) a conversation and seed active memberships. '
  'SECURITY DEFINER; tenant-scoped; block-gated; dedupe policy-driven + race-safe via dedupe_key.';

revoke all on function public.create_conversation(text, uuid[], text, text) from public, anon;
grant execute on function public.create_conversation(text, uuid[], text, text) to authenticated;


-- ── leave_conversation ───────────────────────────────────────────────────────
-- Soft-leave: set left_at on the caller's active membership. No-op-safe (already left /
-- never a member → nothing updated, no error).
create or replace function public.leave_conversation(p_conversation_id uuid)
returns void
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_tenant uuid := public.auth_tenant_id();
begin
  if v_uid is null or v_tenant is null then
    raise exception 'leave_conversation: not authenticated' using errcode = '28000';
  end if;

  update public.conversation_members
  set left_at = now()
  where conversation_id = p_conversation_id
    and account_id = v_uid
    and tenant_id = v_tenant
    and left_at is null;
end;
$$;

comment on function public.leave_conversation(uuid) is
  'Soft-leave: set left_at on the caller''s active membership. No-op-safe. SECURITY DEFINER; tenant-scoped.';

revoke all on function public.leave_conversation(uuid) from public, anon;
grant execute on function public.leave_conversation(uuid) to authenticated;


-- ── set_conversation_context_type ────────────────────────────────────────────
-- Caller must be an active member. Validates against the CHECK set. Writes conversations.context_type.
create or replace function public.set_conversation_context_type(
  p_conversation_id uuid,
  p_context_type    text
)
returns void
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_tenant uuid := public.auth_tenant_id();
begin
  if v_uid is null or v_tenant is null then
    raise exception 'set_conversation_context_type: not authenticated' using errcode = '28000';
  end if;
  if p_context_type not in ('professional', 'casual', 'romantic', 'family', 'support') then
    raise exception 'set_conversation_context_type: invalid context_type %', p_context_type;
  end if;
  if not public.is_active_member(p_conversation_id, v_uid) then
    raise exception 'set_conversation_context_type: not a member';
  end if;

  update public.conversations
  set context_type = p_context_type, updated_at = now()
  where id = p_conversation_id and tenant_id = v_tenant;
end;
$$;

comment on function public.set_conversation_context_type(uuid, text) is
  'Set a conversation''s context_type. Caller must be an active member. SECURITY DEFINER; tenant-scoped.';

revoke all on function public.set_conversation_context_type(uuid, text) from public, anon;
grant execute on function public.set_conversation_context_type(uuid, text) to authenticated;


-- ── create_invite (amended) — accept 'conversation'-kind invites ─────────────
-- Adds p_target_conversation_id (4th arg). The signature changes, so DROP the old 3-arg
-- form first (CREATE OR REPLACE would overload, not replace). Named-arg callers in the
-- frontend are unaffected. 'contact'-kind behavior is unchanged.
drop function if exists public.create_invite(text, integer, timestamptz);

create or replace function public.create_invite(
  p_kind                  text DEFAULT 'contact',
  p_max_uses              integer DEFAULT NULL,
  p_expires_at            timestamptz DEFAULT NULL,
  p_target_conversation_id uuid DEFAULT NULL
)
returns text
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_tenant uuid := public.auth_tenant_id();
  v_token  text;
  v_try    integer := 0;
begin
  if v_uid is null or v_tenant is null then
    raise exception 'create_invite: not authenticated' using errcode = '28000';
  end if;
  if p_kind not in ('contact', 'conversation') then
    raise exception 'create_invite: invalid kind %', p_kind;
  end if;
  if p_max_uses is not null and p_max_uses < 1 then
    raise exception 'create_invite: max_uses must be >= 1 or NULL';
  end if;

  if p_kind = 'conversation' then
    -- A conversation invite requires a target the caller is an active member of (single-tenant).
    if p_target_conversation_id is null then
      raise exception 'create_invite: conversation invite needs a target conversation';
    end if;
    if not public.is_active_member(p_target_conversation_id, v_uid) then
      raise exception 'create_invite: not a member of the target conversation';
    end if;
    if not exists (
      select 1 from public.conversations
      where id = p_target_conversation_id and tenant_id = v_tenant
    ) then
      raise exception 'create_invite: invalid invite';  -- cross-tenant = opaque
    end if;
  else
    -- contact invites carry no target conversation.
    p_target_conversation_id := null;
  end if;

  loop
    v_try := v_try + 1;
    if v_try > 5 then
      raise exception 'create_invite: failed to generate a unique token';
    end if;
    -- base64url: base64 with +/ → -_ and '=' padding stripped.
    v_token := replace(replace(replace(
                 encode(extensions.gen_random_bytes(16), 'base64'),
                 '+', '-'), '/', '_'), '=', '');
    begin
      insert into public.invites (tenant_id, token, kind, created_by, target_conversation_id, max_uses, expires_at)
      values (v_tenant, v_token, p_kind, v_uid, p_target_conversation_id, p_max_uses, p_expires_at);
      exit;  -- success
    exception
      when unique_violation then
        continue;  -- token collision (astronomically rare) → retry
    end;
  end loop;

  return v_token;
end;
$$;

comment on function public.create_invite(text, integer, timestamptz, uuid) is
  'Mint a contact or conversation invite (opaque base64url token). Conversation invites require '
  'the caller be an active member of the target. Defaults multi-use, no expiry, revocable. SECURITY DEFINER; tenant-scoped.';

revoke all on function public.create_invite(text, integer, timestamptz, uuid) from public, anon;
grant execute on function public.create_invite(text, integer, timestamptz, uuid) to authenticated;


-- ── redeem_invite (amended) — un-reject 'conversation'-kind ──────────────────
-- contact behavior unchanged. conversation-kind: record the redemption, increment use_count,
-- and add an active conversation_members row for the redeemer on target_conversation_id
-- (single-tenant + block checks first, reusing the existing invite/redemption plumbing).
create or replace function public.redeem_invite(p_token text)
returns text
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_tenant  uuid := public.auth_tenant_id();
  v_inv     public.invites%ROWTYPE;
  v_lo      uuid;
  v_hi      uuid;
  v_state   text;
begin
  if v_uid is null or v_tenant is null then
    raise exception 'redeem_invite: not authenticated' using errcode = '28000';
  end if;

  -- Look up + lock the invite by token (definer rights — bypasses invites RLS).
  select * into v_inv from public.invites where token = p_token for update;
  if not found then
    raise exception 'redeem_invite: invalid invite';
  end if;
  if v_inv.tenant_id <> v_tenant then
    raise exception 'redeem_invite: invalid invite';  -- cross-tenant = opaque not-found
  end if;
  if v_inv.kind not in ('contact', 'conversation') then
    raise exception 'redeem_invite: unsupported invite kind';
  end if;
  if v_inv.revoked then
    raise exception 'redeem_invite: invite revoked';
  end if;
  if v_inv.expires_at is not null and v_inv.expires_at <= now() then
    raise exception 'redeem_invite: invite expired';
  end if;
  if v_inv.max_uses is not null and v_inv.use_count >= v_inv.max_uses then
    raise exception 'redeem_invite: invite fully used';
  end if;
  if v_inv.created_by = v_uid then
    raise exception 'redeem_invite: cannot redeem your own invite';
  end if;

  -- Block gate (either direction) between redeemer and creator.
  if public.active_block_exists(v_uid, v_inv.created_by) then
    raise exception 'redeem_invite: cannot add this user';
  end if;

  -- Record the redemption (one per user per invite). A re-click is a no-op, not a re-add.
  begin
    insert into public.invite_redemptions (invite_id, redeemed_by)
    values (v_inv.id, v_uid);
  exception
    when unique_violation then
      raise exception 'redeem_invite: already redeemed';
  end;

  update public.invites set use_count = use_count + 1 where id = v_inv.id;

  -- ── conversation-kind: join the target conversation ────────────────────────
  if v_inv.kind = 'conversation' then
    if v_inv.target_conversation_id is null then
      raise exception 'redeem_invite: invalid invite';  -- malformed conversation invite
    end if;
    -- Target must be in the redeemer's tenant (single-tenant invariant; opaque otherwise).
    if not exists (
      select 1 from public.conversations
      where id = v_inv.target_conversation_id and tenant_id = v_tenant
    ) then
      raise exception 'redeem_invite: invalid invite';
    end if;
    -- Add an active membership if not already active (idempotent; glare-safe).
    if not exists (
      select 1 from public.conversation_members
      where conversation_id = v_inv.target_conversation_id
        and account_id = v_uid and left_at is null
    ) then
      begin
        insert into public.conversation_members (conversation_id, account_id, tenant_id, role)
        values (v_inv.target_conversation_id, v_uid, v_tenant, 'member');
      exception
        when unique_violation then
          null;
      end;
    end if;
    return 'joined';
  end if;

  -- ── contact-kind: auto-accept the contact with the creator (canonical pair) ─
  v_lo := least(v_uid, v_inv.created_by);
  v_hi := greatest(v_uid, v_inv.created_by);

  select state into v_state from public.relationships
  where tenant_id = v_tenant and account_lo = v_lo and account_hi = v_hi
  for update;

  if not found then
    insert into public.relationships
      (tenant_id, account_lo, account_hi, initiator_id, state, via_identifier_type)
    values
      (v_tenant, v_lo, v_hi, v_inv.created_by, 'accepted', 'invite_link');
  elsif v_state <> 'accepted' then
    update public.relationships
    set state = 'accepted'
    where tenant_id = v_tenant and account_lo = v_lo and account_hi = v_hi;
  end if;

  return 'accepted';
end;
$$;

comment on function public.redeem_invite(text) is
  'Redeem a contact or conversation invite. contact → auto-accept the contact (canonical pair). '
  'conversation → add an active membership on the target conversation. Block-checked; SECURITY DEFINER; tenant-scoped.';

revoke all on function public.redeem_invite(text) from public, anon;
grant execute on function public.redeem_invite(text) to authenticated;

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- Verification (run after; expect the noted results)
-- ---------------------------------------------------------------------------
-- 1. New tables + RLS enabled:
--    select relname, relrowsecurity from pg_class
--      where relnamespace='public'::regnamespace
--        and relname in ('conversations','conversation_members');
--                                              -- expect relrowsecurity = true for both
--
-- 2. Global conversation row present:
--    select id, kind, tenant_id from public.conversations
--      where id = '00000000-0000-0000-0000-000000000002';   -- expect 1 row, kind='group'
--
-- 3. Partial unique + active-membership indexes exist:
--    select indexname from pg_indexes where schemaname='public'
--      and indexname in ('conversations_dedupe_unique','conversation_members_active_unique',
--                        'conversation_members_account_id_idx','conversation_members_conversation_id_idx',
--                        'conversations_tenant_id_idx');             -- expect 5 rows
--
-- 4. messages.conversation_id promoted (FK + NOT NULL + no default):
--    select is_nullable, column_default from information_schema.columns
--      where table_schema='public' and table_name='messages' and column_name='conversation_id';
--                                              -- expect is_nullable='NO', column_default IS NULL
--    select conname, confdeltype from pg_constraint where conname='messages_conversation_id_fkey';
--                                              -- expect 1 row (confdeltype='a' / NO ACTION)
--    select count(*) filter (where conversation_id is null) as nulls,
--           count(*) filter (where c.id is null) as unresolved
--      from public.messages m left join public.conversations c on c.id = m.conversation_id;
--                                              -- expect nulls=0, unresolved=0
--
-- 5. conversation_contexts: FK present + RLS enabled:
--    select conname, convalidated from pg_constraint
--      where conname='conversation_contexts_conversation_id_fkey';  -- expect 1 row (convalidated=false; NOT VALID)
--    select relrowsecurity from pg_class
--      where relname='conversation_contexts' and relnamespace='public'::regnamespace;  -- expect true
--
-- 6. tenants.conversation_policy column:
--    select id, conversation_policy from public.tenants;            -- expect jsonb '{}' default
--
-- 7. Functions exist + are locked down (no anon/public EXECUTE):
--    select proname from pg_proc where pronamespace='public'::regnamespace
--      and proname in ('is_active_member','create_conversation','leave_conversation',
--                      'set_conversation_context_type','create_invite','redeem_invite');
--                                              -- expect 6 rows
-- ═══════════════════════════════════════════════════════════════════════════
