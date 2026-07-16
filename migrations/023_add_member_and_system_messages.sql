-- ═════════════════════════════════════════════════════════════════════════════
-- 023_add_member_and_system_messages.sql — Spec 11 (Phase 2.5)
-- ═════════════════════════════════════════════════════════════════════════════
-- Adds the backend for "add someone to a conversation by search" + the
-- "X was added to the conversation" system message.
--
--   1. messages.kind ('user' | 'system') + messages.payload jsonb.
--        - kind defaults 'user'; existing rows backfill via the default (ALTER,
--          not recreate — operations.md §3; ADD COLUMN … DEFAULT <const> is a
--          metadata-only change on PG11+, no table rewrite).
--        - system rows carry sender_id NULL, no text, and a structured payload,
--          e.g. {"event":"member_added","target_account_id":"…"}.
--        - They ride the EXISTING messages realtime publication + the 018
--          membership-scoped SELECT RLS (readable by all members), so no new
--          publication or policy is needed.
--
--   2. _member_added_finalize() — internal helper (SECURITY DEFINER, not granted):
--        promotes a direct thread to group (+ nulls dedupe_key) once it exceeds 2
--        active members, and posts the member_added system message. Shared by both
--        add paths so they behave identically.
--
--   3. add_conversation_member(conversation, account) — SECURITY DEFINER, tenant-
--        scoped, block-gated, idempotent. The new search-to-add path.
--
--   4. redeem_invite — amended (CREATE OR REPLACE) to run the same finalize on a
--        real join (the copy-link fallback path), closing the parking-lot
--        "direct→group promotion on invite" quirk via option (a).
--
-- Staging first; then prod replay BEFORE the frontend merge (deploy-order rule).
-- ═════════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. messages.kind + payload ───────────────────────────────────────────────
alter table public.messages
  add column if not exists kind text not null default 'user';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'messages_kind_check' and conrelid = 'public.messages'::regclass
  ) then
    alter table public.messages
      add constraint messages_kind_check check (kind in ('user', 'system'));
  end if;
end $$;

alter table public.messages
  add column if not exists payload jsonb;

comment on column public.messages.kind is
  'user = a person''s message (default); system = an event row (e.g. member_added) with '
  'sender_id NULL + structured payload. Rides the existing messages realtime + 018 '
  'membership-scoped SELECT RLS. (023, Spec 11.)';
comment on column public.messages.payload is
  'Structured body for kind=''system'' rows, e.g. {"event":"member_added","target_account_id":"…"}. '
  'NULL for user messages. (023, Spec 11.)';

-- ── 2. _member_added_finalize — promote direct→group + post system message ────
-- Called AFTER a new active membership is established (the callers guarantee it fires
-- once per real add). SECURITY DEFINER: writes conversations + messages under owner
-- rights (bypasses RLS); the calling RPCs already authorize the actor. NOT granted to
-- authenticated — internal use only.
create or replace function public._member_added_finalize(
  p_conversation_id uuid,
  p_added_account   uuid,
  p_tenant          uuid
) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_active int;
begin
  -- Promote a direct thread to group once it exceeds 2 active members, and null its
  -- dedupe_key so a later create_conversation(direct, original pair) can't dedupe back
  -- into the now-larger thread (parking-lot "direct→group promotion on invite", option a).
  select count(*) into v_active
  from public.conversation_members
  where conversation_id = p_conversation_id and left_at is null;

  update public.conversations
  set kind = 'group', dedupe_key = null
  where id = p_conversation_id and kind = 'direct' and v_active > 2;

  -- Post the member_added system message (sender_id NULL, no text; payload names who
  -- was added). Delivered to members via the existing messages realtime channel.
  insert into public.messages
    (conversation_id, sender_id, original_text, source_language, tenant_id, kind, payload)
  values
    (p_conversation_id, null, null, null, p_tenant, 'system',
     jsonb_build_object('event', 'member_added', 'target_account_id', p_added_account));
end;
$$;

comment on function public._member_added_finalize(uuid, uuid, uuid) is
  'Internal: promote direct→group (+ null dedupe_key) past 2 members and post the '
  'member_added system message. SECURITY DEFINER; invoked only by the add RPCs. (023.)';

revoke all on function public._member_added_finalize(uuid, uuid, uuid) from public, anon, authenticated;

-- ── 3. add_conversation_member — the search-to-add path ──────────────────────
create or replace function public.add_conversation_member(
  p_conversation_id uuid,
  p_account_id      uuid
) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_tenant uuid := public.auth_tenant_id();
  v_added  boolean := false;
begin
  if v_uid is null or v_tenant is null then
    raise exception 'add_conversation_member: not authenticated' using errcode = '28000';
  end if;
  if p_account_id is null then
    raise exception 'add_conversation_member: no account';
  end if;

  -- Caller must be an active member of the conversation.
  if not public.is_active_member(p_conversation_id, v_uid) then
    raise exception 'add_conversation_member: not a member';
  end if;

  -- Conversation must live in the caller's tenant (opaque otherwise).
  if not exists (
    select 1 from public.conversations
    where id = p_conversation_id and tenant_id = v_tenant
  ) then
    raise exception 'add_conversation_member: conversation not found';
  end if;

  -- Target must be an active profile in the same tenant (opaque; matches create_conversation).
  if not exists (
    select 1 from public.profiles
    where id = p_account_id and tenant_id = v_tenant and status = 'active'
  ) then
    raise exception 'add_conversation_member: member not found';
  end if;

  -- Block gate (either direction) between caller and target.
  if public.active_block_exists(v_uid, p_account_id) then
    raise exception 'add_conversation_member: cannot add this user';
  end if;

  -- Idempotent add. The partial unique index (conversation_id, account_id) WHERE
  -- left_at IS NULL guarantees one active row; a lost glare race is swallowed and the
  -- winner posts the system message.
  if not exists (
    select 1 from public.conversation_members
    where conversation_id = p_conversation_id and account_id = p_account_id and left_at is null
  ) then
    begin
      insert into public.conversation_members (conversation_id, account_id, tenant_id, role)
      values (p_conversation_id, p_account_id, v_tenant, 'member');
      v_added := true;
    exception
      when unique_violation then
        v_added := false;
    end;
  end if;

  if v_added then
    perform public._member_added_finalize(p_conversation_id, p_account_id, v_tenant);
  end if;
end;
$$;

comment on function public.add_conversation_member(uuid, uuid) is
  'Add an account to a conversation the caller is an active member of. Tenant-scoped, '
  'block-gated, idempotent; promotes direct→group (+ nulls dedupe_key) past 2 members and '
  'posts a member_added system message. SECURITY DEFINER. (023, Spec 11.)';

revoke all on function public.add_conversation_member(uuid, uuid) from public, anon;
grant execute on function public.add_conversation_member(uuid, uuid) to authenticated;

-- ── 4. redeem_invite (amended) — run finalize on a real conversation join ─────
-- Identical to migration 017 except: track whether THIS call established the active
-- membership (v_added) and, if so, run _member_added_finalize (promotion + system
-- message). Everything else (contact branch, all guards) is unchanged.
create or replace function public.redeem_invite(p_token text)
returns text
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_tenant uuid := public.auth_tenant_id();
  v_inv    public.invites%ROWTYPE;
  v_lo     uuid;
  v_hi     uuid;
  v_state  text;
  v_added  boolean := false;
begin
  if v_uid is null or v_tenant is null then
    raise exception 'redeem_invite: not authenticated' using errcode = '28000';
  end if;

  select * into v_inv from public.invites where token = p_token for update;
  if not found then
    raise exception 'redeem_invite: invalid invite';
  end if;
  if v_inv.tenant_id <> v_tenant then
    raise exception 'redeem_invite: invalid invite';
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

  if public.active_block_exists(v_uid, v_inv.created_by) then
    raise exception 'redeem_invite: cannot add this user';
  end if;

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
      raise exception 'redeem_invite: invalid invite';
    end if;
    if not exists (
      select 1 from public.conversations
      where id = v_inv.target_conversation_id and tenant_id = v_tenant
    ) then
      raise exception 'redeem_invite: invalid invite';
    end if;
    if not exists (
      select 1 from public.conversation_members
      where conversation_id = v_inv.target_conversation_id
        and account_id = v_uid and left_at is null
    ) then
      begin
        insert into public.conversation_members (conversation_id, account_id, tenant_id, role)
        values (v_inv.target_conversation_id, v_uid, v_tenant, 'member');
        v_added := true;
      exception
        when unique_violation then
          v_added := false;
      end;
    end if;
    if v_added then
      perform public._member_added_finalize(v_inv.target_conversation_id, v_uid, v_tenant);
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
  'conversation → add an active membership, promote direct→group + post member_added on a real '
  'join (023). Block-checked; SECURITY DEFINER; tenant-scoped.';

revoke all on function public.redeem_invite(text) from public, anon;
grant execute on function public.redeem_invite(text) to authenticated;

-- ── 5. In-transaction verification (raises → whole migration rolls back) ──────
do $$
declare
  v_default text;
  v_authed  boolean;
  v_finalize_authed boolean;
begin
  -- messages.kind default 'user' + CHECK present
  select column_default into v_default
  from information_schema.columns
  where table_schema = 'public' and table_name = 'messages' and column_name = 'kind';
  if v_default is null or v_default not like '%user%' then
    raise exception 'verify: messages.kind default missing (got %)', v_default;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'messages_kind_check' and conrelid = 'public.messages'::regclass
  ) then
    raise exception 'verify: messages_kind_check missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='messages' and column_name='payload'
  ) then
    raise exception 'verify: messages.payload missing';
  end if;

  -- add_conversation_member is executable by authenticated; _member_added_finalize is NOT.
  select has_function_privilege('authenticated', 'public.add_conversation_member(uuid,uuid)', 'execute')
    into v_authed;
  if not v_authed then
    raise exception 'verify: add_conversation_member not executable by authenticated';
  end if;
  select has_function_privilege('authenticated', 'public._member_added_finalize(uuid,uuid,uuid)', 'execute')
    into v_finalize_authed;
  if v_finalize_authed then
    raise exception 'verify: _member_added_finalize should NOT be granted to authenticated';
  end if;

  raise notice 'migration 023 verification passed';
end $$;

commit;

-- ═════════════════════════════════════════════════════════════════════════════
-- Post-apply spot checks (run manually in the SQL editor if you want extra proof;
-- these do NOT run automatically and are read-only):
--
--   -- kind column + constraint
--   select column_name, data_type, column_default
--     from information_schema.columns
--    where table_name='messages' and column_name in ('kind','payload');
--
--   -- functions present + grants
--   select proname, pg_get_function_identity_arguments(oid)
--     from pg_proc where proname in ('add_conversation_member','_member_added_finalize','redeem_invite');
-- ═════════════════════════════════════════════════════════════════════════════
