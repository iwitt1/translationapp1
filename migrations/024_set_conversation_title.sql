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
--
-- No schema/table change — function only. Staging first, then prod replay before the
-- frontend merge (the UI calls this RPC; deploy-order-safe since old UI ignores it).
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

  update public.conversations
  set title = v_clean, updated_at = now()
  where id = p_conversation_id and tenant_id = v_tenant;
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
