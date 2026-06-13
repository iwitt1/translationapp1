-- ═════════════════════════════════════════════════════════════════════════════
-- Migration 019 — Unify conversations.context_type vocabulary with the engine
-- ═════════════════════════════════════════════════════════════════════════════
-- WHAT
--   Change the allowed values of conversations.context_type from the Phase-3-original
--   set  (casual, professional, romantic, family, support)
--   to the translation-engine set  (casual, dating, professional, academic).
--   Three call sites move in lockstep:
--     1. the conversations_context_type_check table constraint
--     2. the create_conversation() inline guard
--     3. the set_conversation_context_type() inline guard
--
-- WHY
--   There were two divergent context_type vocabularies. The *conversation column*
--   accepted (casual/professional/romantic/family/support); the *translation engine*
--   (lib/translatePrompt.js CONTEXT_TYPE_MODIFIERS) only understands and changes its
--   behavior for (casual/dating/professional/academic). Only casual+professional
--   overlapped. The per-conversation register selector (Phase 3 frontend) writes the
--   conversation's context_type and that value then drives translation — so the two
--   MUST agree, or the user picks a register the engine silently ignores (falls back to
--   casual) or that the DB rejects outright. We unify on the engine set because that is
--   the vocabulary with real, reviewed behavior attached, and it already matches the
--   existing App.jsx CONTEXT_TYPES. See decisions.md 2026-06-12 "Unify context_type vocab".
--
-- NOT TOUCHED (deliberately): the `detected_register` enum
--   (casual/professional/romantic/family/support) on messages/inference output
--   (migration 002, translatePrompt.js, inferProfile.js). That is the inference OUTPUT
--   describing detected tone — a separate field from the user-chosen conversation
--   register. Conflating them is the trap; they stay decoupled.
--
-- INTERIM NOTE: this hardcoded CHECK + inline guards are the stop-gap. The deferred
--   tenant-scoped vocabulary registry (parking-lot.md "Tenant-scoped option registry")
--   will later replace this CHECK with table-driven, per-tenant validation. Until then,
--   adding/removing a register value still means a migration here + an edit to
--   src/lib/vocabularies.js + lib/translatePrompt.js.
--
-- SAFETY
--   Idempotent; single transaction; ALTER (not recreate) on the table; CREATE OR REPLACE
--   on the two functions (signatures unchanged → grants/policies preserved). Replay-safe.
-- ═════════════════════════════════════════════════════════════════════════════

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Defensive data migration — remap any pre-existing rows on the retired values
--    so the new CHECK can be added without violation. In practice nothing writes
--    romantic/family/support yet (the column shipped in 017 and only the global
--    sentinel — 'casual' — plus gate fixtures exist), so this should touch 0 rows;
--    it is here purely to make the migration safe to replay against any environment.
--    Mapping picks the nearest engine register; 'casual' is the catch-all.
-- ─────────────────────────────────────────────────────────────────────────────
update public.conversations set context_type = 'dating'
  where context_type = 'romantic';
update public.conversations set context_type = 'casual'
  where context_type in ('family', 'support');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Swap the table CHECK constraint to the engine set (default 'casual' unchanged).
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.conversations
  drop constraint if exists conversations_context_type_check;
alter table public.conversations
  add constraint conversations_context_type_check
    check (context_type in ('casual', 'dating', 'professional', 'academic'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. create_conversation() — inline guard updated to the engine set.
--    Full body reproduced verbatim from migration 017 (Postgres replaces functions
--    wholesale); ONLY the p_context_type check list on the marked line changed.
-- ─────────────────────────────────────────────────────────────────────────────
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
  if p_context_type not in ('casual', 'dating', 'professional', 'academic') then  -- 019: engine set
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
  'SECURITY DEFINER; tenant-scoped; block-gated; dedupe policy-driven + race-safe via dedupe_key. '
  'context_type vocab unified with the translation engine in migration 019.';

revoke all on function public.create_conversation(text, uuid[], text, text) from public, anon;
grant execute on function public.create_conversation(text, uuid[], text, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. set_conversation_context_type() — inline guard updated to the engine set.
--    Full body reproduced verbatim from migration 017; ONLY the check list changed.
-- ─────────────────────────────────────────────────────────────────────────────
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
  if p_context_type not in ('casual', 'dating', 'professional', 'academic') then  -- 019: engine set
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
  'Set a conversation''s context_type. Caller must be an active member. SECURITY DEFINER; tenant-scoped. '
  'context_type vocab unified with the translation engine in migration 019.';

revoke all on function public.set_conversation_context_type(uuid, text) from public, anon;
grant execute on function public.set_conversation_context_type(uuid, text) to authenticated;

commit;

-- ═════════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run by hand on staging after apply; not part of the transaction)
-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Constraint shows the engine set:
--      select pg_get_constraintdef(oid) from pg_constraint
--      where conname = 'conversations_context_type_check';
--      -- expect: CHECK (context_type = ANY (ARRAY['casual','dating','professional','academic']))
--
-- 2. No rows left on a retired value (expect 0):
--      select count(*) from public.conversations
--      where context_type in ('romantic','family','support');
--
-- 3. As an authenticated member, a 'dating'/'academic' register now succeeds and a
--    retired value now fails — exercised by the existing conversations gate
--    (scripts/conversations-gate-test.mjs Phase 5 still passes: 'professional' ok,
--    'nonsense' rejected). Optionally add a 'dating' ok / 'romantic' rejected assertion.
-- ═════════════════════════════════════════════════════════════════════════════
