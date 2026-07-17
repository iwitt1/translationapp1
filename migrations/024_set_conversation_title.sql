-- ═════════════════════════════════════════════════════════════════════════════
-- 024_set_conversation_title.sql — Spec 13 (Phase 2.5 follow-on: group naming)
-- ═════════════════════════════════════════════════════════════════════════════
-- Adds set_conversation_title() so a member can name / rename a conversation after
-- creation. conversations.title already exists (set only at create time until now);
-- conversations has no UPDATE RLS policy by design (writes go through RPCs), so this
-- is the sanctioned write path — mirrors set_conversation_context_type() (017).
--
--   - Member-gated (is_active_member) + tenant-scoped.
--   - Trims the input; an empty/whitespace title becomes NULL, which clears the name
--     and lets the frontend fall back to the member-list default ("Ana, Kenji …").
--   - Length-capped (100 chars).
--   - On an actual change (groups only), posts a 'group_renamed' / 'group_name_cleared'
--     system message (kind='system', migration 023) — so a rename shows in the thread
--     AND propagates to other members live via the messages realtime channel.
--
-- No schema/table change — function only. Requires 023 (messages.kind/payload). Staging
-- first, then prod replay before the frontend merge (deploy-order-safe: old UI ignores it).
-- ═════════════════════════════════════════════════════════════════════════════

begin;

create or replace function public.set_conversation_title(
  p_conversation_id uuid,
  p_title           text
) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_tenant uuid := public.auth_tenant_id();
  v_clean  text;
  v_old    text;
  v_kind   text;
begin
  if v_uid is null or v_tenant is null then
    raise exception 'set_conversation_title: not authenticated' using errcode = '28000';
  end if;
  if not public.is_active_member(p_conversation_id, v_uid) then
    raise exception 'set_conversation_title: not a member';
  end if;

  -- Trim; empty → NULL (clears the name → member-list fallback in the UI).
  v_clean := nullif(btrim(coalesce(p_title, '')), '');
  if v_clean is not null and length(v_clean) > 100 then
    raise exception 'set_conversation_title: title too long (max 100)';
  end if;

  select title, kind into v_old, v_kind
  from public.conversations
  where id = p_conversation_id and tenant_id = v_tenant;

  update public.conversations
  set title = v_clean, updated_at = now()
  where id = p_conversation_id and tenant_id = v_tenant;

  -- System message on an actual change (groups only). `is distinct from` treats NULLs
  -- correctly, so a no-op save posts nothing. Rides the messages realtime channel, so
  -- other members see the rename live (not just on reload).
  if v_kind = 'group' and v_clean is distinct from v_old then
    insert into public.messages
      (conversation_id, sender_id, original_text, source_language, tenant_id, kind, payload)
    values
      (p_conversation_id, null, null, null, v_tenant, 'system',
       case when v_clean is not null
         then jsonb_build_object('event', 'group_renamed', 'actor_account_id', v_uid, 'title', v_clean)
         else jsonb_build_object('event', 'group_name_cleared', 'actor_account_id', v_uid)
       end);
  end if;
end;
$$;

comment on function public.set_conversation_title(uuid, text) is
  'Set/clear a conversation title. Caller must be an active member. Empty → NULL '
  '(UI falls back to the member-list name). Tenant-scoped; SECURITY DEFINER. (024, Spec 13.)';

revoke all on function public.set_conversation_title(uuid, text) from public, anon;
grant execute on function public.set_conversation_title(uuid, text) to authenticated;

-- ── In-transaction verification (raises → rolls back) ─────────────────────────
do $$
begin
  if not has_function_privilege('authenticated', 'public.set_conversation_title(uuid,text)', 'execute') then
    raise exception 'verify: set_conversation_title not executable by authenticated';
  end if;
  if has_function_privilege('anon', 'public.set_conversation_title(uuid,text)', 'execute') then
    raise exception 'verify: set_conversation_title should NOT be executable by anon';
  end if;
  raise notice 'migration 024 verification passed';
end $$;

commit;
