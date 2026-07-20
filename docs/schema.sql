--
-- PostgreSQL database dump
--

\restrict X8D8B7RaZPD72UiZGYpKonEITQVmANgNHp6KnIHPb2QJlvR0MINgSRKW2aQRUOj

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.10 (Ubuntu 17.10-1.pgdg24.04+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: _member_added_finalize(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._member_added_finalize(p_conversation_id uuid, p_added_account uuid, p_tenant uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: FUNCTION _member_added_finalize(p_conversation_id uuid, p_added_account uuid, p_tenant uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public._member_added_finalize(p_conversation_id uuid, p_added_account uuid, p_tenant uuid) IS 'Internal: promote direct→group (+ null dedupe_key) past 2 members and post the member_added system message. SECURITY DEFINER; invoked only by the add RPCs. (023.)';


--
-- Name: active_block_exists(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.active_block_exists(p_a uuid, p_b uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.blocks
    WHERE tenant_id = public.auth_tenant_id()
      AND unblocked_at IS NULL
      AND ( (blocker_id = p_a AND blocked_id = p_b)
         OR (blocker_id = p_b AND blocked_id = p_a) )
  )
$$;


--
-- Name: FUNCTION active_block_exists(p_a uuid, p_b uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.active_block_exists(p_a uuid, p_b uuid) IS 'True iff an active block exists in either direction between two accounts in the caller''s tenant. SECURITY DEFINER (reads blocks past its blocker-only RLS). Used by request_contact/respond_to_contact/redeem_invite and the discovery RPCs.';


--
-- Name: add_conversation_member(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_conversation_member(p_conversation_id uuid, p_account_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: FUNCTION add_conversation_member(p_conversation_id uuid, p_account_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.add_conversation_member(p_conversation_id uuid, p_account_id uuid) IS 'Add an account to a conversation the caller is an active member of. Tenant-scoped, block-gated, idempotent; promotes direct→group (+ nulls dedupe_key) past 2 members and posts a member_added system message. SECURITY DEFINER. (023, Spec 11.)';


--
-- Name: auth_tenant_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_tenant_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT tenant_id FROM public.profiles WHERE id = auth.uid()
$$;


--
-- Name: FUNCTION auth_tenant_id(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.auth_tenant_id() IS 'Returns the tenant_id for the current authenticated user. SECURITY DEFINER bypasses RLS on profiles to prevent infinite policy recursion. Returns NULL for unauthenticated users or users without a profile row.';


--
-- Name: block_account(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.block_account(p_target uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_tenant uuid := public.auth_tenant_id();
BEGIN
  IF v_uid IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'block_account: not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_target IS NULL OR p_target = v_uid THEN
    RAISE EXCEPTION 'block_account: invalid target';
  END IF;
  PERFORM 1 FROM public.profiles WHERE id = p_target AND tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'block_account: target not found';
  END IF;

  -- No-op if already actively blocked (the partial unique index also backstops a race).
  IF EXISTS (
    SELECT 1 FROM public.blocks
    WHERE blocker_id = v_uid AND blocked_id = p_target AND unblocked_at IS NULL
  ) THEN
    RETURN 'already_blocked';
  END IF;

  INSERT INTO public.blocks (tenant_id, blocker_id, blocked_id)
  VALUES (v_tenant, v_uid, p_target);
  RETURN 'blocked';

EXCEPTION
  WHEN unique_violation THEN  -- lost race against a concurrent identical block
    RETURN 'already_blocked';
END;
$$;


--
-- Name: FUNCTION block_account(p_target uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.block_account(p_target uuid) IS 'Create an active block (caller → target), idempotent. Does not mutate the relationships row — a block is an override layer. SECURITY DEFINER; tenant-scoped.';


--
-- Name: cancel_account_deletion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_account_deletion() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_req_id    uuid;
  v_onboarded timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'cancel_account_deletion: not authenticated';
  END IF;

  SELECT id INTO v_req_id
  FROM public.data_deletion_requests
  WHERE user_id = v_uid AND status = 'pending'
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN false;  -- nothing pending (no request, or already processing/completed)
  END IF;

  UPDATE public.data_deletion_requests
     SET status = 'cancelled', updated_at = now()
   WHERE id = v_req_id;

  SELECT onboarding_completed_at INTO v_onboarded FROM public.profiles WHERE id = v_uid;
  UPDATE public.profiles
     SET status = CASE WHEN v_onboarded IS NOT NULL THEN 'active' ELSE 'pending' END,
         updated_at = now()
   WHERE id = v_uid;

  RETURN true;
END;
$$;


--
-- Name: FUNCTION cancel_account_deletion(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.cancel_account_deletion() IS 'Step 7: caller reverses their own pending erasure within the grace window — un-deactivates the profile and marks the request ''cancelled''. No-op (false) if nothing is pending. Cannot cancel once the sweep has claimed it. decisions.md 2026-06-11.';


--
-- Name: change_username(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.change_username(p_new_username text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_uid            uuid    := auth.uid();
  v_tenant         uuid    := public.auth_tenant_id();
  v_new            text    := lower(btrim(p_new_username));
  v_cur_username   text;
  v_cur_source     text;
  v_cur_changed    timestamptz;
  v_existing       text;    -- status of any existing row with this value
  v_existing_owner uuid;    -- owner of that row (null for reserved rows)
  v_reverting      boolean := false;
BEGIN
  -- Auth guard
  IF v_uid IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'change_username: not authenticated' USING ERRCODE = '28000';
  END IF;

  -- Charset + length (policies.md §1 / lib/policies.js USERNAME)
  IF v_new !~ '^[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'change_username: invalid characters (allowed: a-z 0-9 _)';
  END IF;
  IF length(v_new) < 3 OR length(v_new) > 20 THEN
    RAISE EXCEPTION 'change_username: length must be 3-20 characters';
  END IF;

  -- Load the caller's current username state (lock the row to serialize concurrent changes)
  SELECT username, username_source, username_last_changed_at
    INTO v_cur_username, v_cur_source, v_cur_changed
  FROM public.profiles
  WHERE id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'change_username: no profile for caller' USING ERRCODE = '28000';
  END IF;

  -- No-op guard
  IF v_new = v_cur_username THEN
    RAISE EXCEPTION 'change_username: new username is the same as current';
  END IF;

  -- Cadence: first change from a system_generated handle is free and starts the
  -- clock; thereafter at most one change per 365 days. Applies to reverts too.
  IF v_cur_source = 'user_set'
     AND v_cur_changed IS NOT NULL
     AND v_cur_changed > now() - interval '365 days' THEN
    RAISE EXCEPTION
      'change_username: can be changed at most once per 365 days (last change %)',
      v_cur_changed;
  END IF;

  -- Reserved + non-reuse, with the 020 self-revert exception: a value that
  -- exists is unavailable UNLESS it is the caller's own retired handle.
  SELECT status, account_id INTO v_existing, v_existing_owner
  FROM public.account_identifiers
  WHERE tenant_id = v_tenant AND type = 'username' AND value = v_new
  LIMIT 1;

  IF v_existing IS NOT NULL THEN
    IF v_existing = 'retired' AND v_existing_owner = v_uid THEN
      v_reverting := true;   -- reclaiming own prior handle: allowed
    ELSE
      -- 'reserved', someone else's 'retired', or anyone's 'active': unavailable.
      RAISE EXCEPTION 'change_username: username unavailable';
    END IF;
  END IF;

  -- Atomic swap ---------------------------------------------------------------
  -- 1. Retire the caller's current active username identifier (never deleted).
  UPDATE public.account_identifiers
     SET status = 'retired'
   WHERE account_id = v_uid
     AND type       = 'username'
     AND value      = v_cur_username
     AND status     = 'active';

  -- 2. Activate the target identifier: re-activate the caller's own retired
  --    row on a revert (an INSERT would hit the (tenant_id, type, value)
  --    unique constraint); otherwise insert a fresh active row as before.
  IF v_reverting THEN
    UPDATE public.account_identifiers
       SET status = 'active'
     WHERE account_id = v_uid
       AND tenant_id  = v_tenant
       AND type       = 'username'
       AND value      = v_new
       AND status     = 'retired';
  ELSE
    INSERT INTO public.account_identifiers
      (account_id, tenant_id, type, value, status, verified, created_at)
    VALUES
      (v_uid, v_tenant, 'username', v_new, 'active', false, now());
  END IF;

  -- 3. Update the profile. profiles_unique_username (tenant_id, username) backstops.
  UPDATE public.profiles
     SET username                 = v_new,
         username_source          = 'user_set',
         username_last_changed_at  = now(),
         updated_at               = now()
   WHERE id = v_uid;

  RETURN v_new;

EXCEPTION
  -- Translate a lost uniqueness race into the same friendly error as the pre-check.
  WHEN unique_violation THEN
    RAISE EXCEPTION 'change_username: username unavailable';
END;
$_$;


--
-- Name: FUNCTION change_username(p_new_username text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.change_username(p_new_username text) IS 'Phase 2 Step 4: the sole path to change a username (profiles.username is REVOKEd from authenticated). Enforces charset/length/reserved/non-reuse and the 1/365-day cadence (first system→user change free). Since 020: the caller may revert to their OWN retired username (re-activates the retired identifier row); non-reuse still blocks everyone else permanently. Called directly (future settings screen) and by complete_onboarding() (onboarding claim).';


--
-- Name: claim_deletion_request(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_deletion_request(p_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_claimed boolean := false;
BEGIN
  UPDATE public.data_deletion_requests
     SET status = 'processing', updated_at = now()
   WHERE id = p_id AND status = 'pending';
  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  RETURN v_claimed;
END;
$$;


--
-- Name: FUNCTION claim_deletion_request(p_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.claim_deletion_request(p_id uuid) IS 'Step 7 deletion sweep: atomically move a request pending→processing; true if THIS call won the claim. Prevents double-processing across overlapping runs. service_role only.';


--
-- Name: complete_deletion_request(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_deletion_request(p_id uuid, p_deleted_fields jsonb DEFAULT NULL::jsonb) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  UPDATE public.data_deletion_requests
     SET status         = 'completed',
         completed_at    = now(),
         deleted_fields  = p_deleted_fields,
         updated_at      = now()
   WHERE id = p_id;
$$;


--
-- Name: FUNCTION complete_deletion_request(p_id uuid, p_deleted_fields jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.complete_deletion_request(p_id uuid, p_deleted_fields jsonb) IS 'Step 7 deletion sweep: finalize a request (completed + completed_at + deleted_fields audit log) after the hard delete. Updated by PK; user_id is NULL by now (cascade). service_role only.';


--
-- Name: complete_onboarding(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.complete_onboarding(p_display_name text, p_preferred_language text, p_username text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_trimmed_name text := trim(p_display_name);
  v_tenant_id    uuid;
BEGIN
  -- Idempotency guard: if already active, nothing to do
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND status = 'active'
  ) THEN
    RETURN;
  END IF;

  -- Auth guard: caller must be authenticated and have a pending profile
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'complete_onboarding: caller is not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'complete_onboarding: no pending profile found for user %', auth.uid();
  END IF;

  -- Validate display_name (policies.md §1: 1–50 chars after trim)
  IF length(v_trimmed_name) = 0 THEN
    RAISE EXCEPTION 'complete_onboarding: display_name cannot be empty';
  END IF;
  IF length(v_trimmed_name) > 50 THEN
    RAISE EXCEPTION 'complete_onboarding: display_name exceeds 50 characters';
  END IF;

  -- NEW (020): display_name charset denylist — reject control characters,
  -- DEL, and Unicode bidi override/isolate characters (U+202A–U+202E,
  -- U+2066–U+2069). Denylist not allowlist: international names must pass.
  IF v_trimmed_name ~ ('[' || chr(1) || '-' || chr(31) || chr(127)
                        || chr(8234) || '-' || chr(8238)
                        || chr(8294) || '-' || chr(8297) || ']') THEN
    RAISE EXCEPTION 'complete_onboarding: display_name contains invalid control characters';
  END IF;

  -- Validate preferred_language (non-empty) — unchanged from 008
  IF p_preferred_language IS NULL OR length(trim(p_preferred_language)) = 0 THEN
    RAISE EXCEPTION 'complete_onboarding: preferred_language is required';
  END IF;

  -- NEW (020): claim the user-chosen username, if provided. Delegates ALL
  -- username policy (charset/length/reserved/non-reuse/cadence) to
  -- change_username() — the single enforcement point since 010. Any
  -- exception it raises aborts this whole transaction, so username claim
  -- and activation are atomic: a pending account can never end up holding
  -- a user-chosen handle.
  IF p_username IS NOT NULL AND length(trim(p_username)) > 0 THEN
    PERFORM public.change_username(trim(p_username));
  END IF;

  -- Fetch tenant_id (needed for the linguistic profile upsert)
  SELECT tenant_id INTO v_tenant_id
  FROM public.profiles
  WHERE id = auth.uid();

  -- P1 → P3: update profile (status, display_name, onboarding_completed_at)
  -- This bypasses the column grant via SECURITY DEFINER — intentional.
  UPDATE public.profiles SET
    display_name            = v_trimmed_name,
    status                  = 'active',
    onboarding_completed_at = now(),
    updated_at              = now()
  WHERE id = auth.uid();

  -- Create linguistic profile with explicitly chosen language
  -- No INSERT policy exists for authenticated users on this table — the RPC creates
  -- the row on their behalf. ON CONFLICT handles the (unlikely) case of a duplicate call.
  INSERT INTO public.user_linguistic_profiles (
    user_id, tenant_id, preferred_language, updated_at
  ) VALUES (
    auth.uid(), v_tenant_id, trim(p_preferred_language), now()
  )
  ON CONFLICT (user_id, tenant_id) DO UPDATE SET
    preferred_language = EXCLUDED.preferred_language,
    updated_at         = now();
END;
$$;


--
-- Name: FUNCTION complete_onboarding(p_display_name text, p_preferred_language text, p_username text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.complete_onboarding(p_display_name text, p_preferred_language text, p_username text) IS 'P1 → P3 status transition. Sets profiles.status=active, display_name, onboarding_completed_at; creates the user_linguistic_profiles row with the chosen language; and (020) optionally claims a user-chosen username via change_username() in the same transaction — atomic with activation, so pending accounts never hold user-chosen handles (keeps the abandonment hard-delete safe). Also (020) enforces a display_name control-char/bidi denylist. SECURITY DEFINER — bypasses column grants on profiles.status/username. Idempotent: no-op if user is already active. Called by the frontend onboarding screen after magic-link sign-in.';


--
-- Name: create_conversation(text, uuid[], text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_conversation(p_kind text, p_member_ids uuid[], p_title text DEFAULT NULL::text, p_context_type text DEFAULT 'casual'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: FUNCTION create_conversation(p_kind text, p_member_ids uuid[], p_title text, p_context_type text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_conversation(p_kind text, p_member_ids uuid[], p_title text, p_context_type text) IS 'Create (or, for a deduped pair, return) a conversation and seed active memberships. SECURITY DEFINER; tenant-scoped; block-gated; dedupe policy-driven + race-safe via dedupe_key. context_type vocab unified with the translation engine in migration 019.';


--
-- Name: create_invite(text, integer, timestamp with time zone, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_invite(p_kind text DEFAULT 'contact'::text, p_max_uses integer DEFAULT NULL::integer, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_target_conversation_id uuid DEFAULT NULL::uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: FUNCTION create_invite(p_kind text, p_max_uses integer, p_expires_at timestamp with time zone, p_target_conversation_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_invite(p_kind text, p_max_uses integer, p_expires_at timestamp with time zone, p_target_conversation_id uuid) IS 'Mint a contact or conversation invite (opaque base64url token). Conversation invites require the caller be an active member of the target. Defaults multi-use, no expiry, revocable. SECURITY DEFINER; tenant-scoped.';


--
-- Name: find_account_by_email(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.find_account_by_email(p_email text) RETURNS TABLE(account_id uuid, display_name text, username text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT p.id, p.display_name, p.username
  FROM public.account_identifiers ai
  JOIN public.profiles p          ON p.id = ai.account_id
  JOIN public.account_settings s  ON s.account_id = p.id
  WHERE ai.tenant_id = public.auth_tenant_id()
    AND ai.type      = 'email'
    AND ai.status    = 'active'
    AND ai.value     = lower(btrim(p_email))
    AND p.status     = 'active'
    AND p.id        <> auth.uid()
    AND s.discoverable_by_email = true
    AND NOT public.active_block_exists(auth.uid(), p.id)   -- 011: hide blocked users
  LIMIT 1
$$;


--
-- Name: FUNCTION find_account_by_email(p_email text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.find_account_by_email(p_email text) IS 'Phase 2 Step 4 discovery (amended in 011): exact-match add by email. SECURITY DEFINER; returns only public handles (id, display_name, username) — never email/phone/other. Exact canonical equality only; tenant-scoped; respects discoverable_by_email; active profiles only; excludes the caller; excludes users with an active block (either direction).';


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_tenant_id  uuid    := '00000000-0000-0000-0000-000000000001';
  v_username   text;
  v_is_taken   boolean;
  v_attempts   integer := 0;
BEGIN
  IF NEW.email IS NULL THEN
    RETURN NEW;
  END IF;

  LOOP
    v_attempts := v_attempts + 1;
    IF v_attempts > 10 THEN
      RAISE EXCEPTION
        'handle_new_user: failed to generate unique username after 10 attempts (user_id: %)',
        NEW.id;
    END IF;

    v_username := 'user_' || encode(extensions.gen_random_bytes(4), 'hex');

    SELECT EXISTS (
      SELECT 1
      FROM public.account_identifiers
      WHERE tenant_id = v_tenant_id
        AND type      = 'username'
        AND value     = v_username
    ) INTO v_is_taken;

    EXIT WHEN NOT v_is_taken;
  END LOOP;

  INSERT INTO public.profiles (
    id, tenant_id, display_name, username, username_source,
    status, created_at, updated_at
  ) VALUES (
    NEW.id, v_tenant_id, '', v_username, 'system_generated',
    'pending', now(), now()
  );

  INSERT INTO public.account_identifiers (
    account_id, tenant_id, type, value, status, verified, created_at
  ) VALUES (
    NEW.id, v_tenant_id, 'email', lower(NEW.email), 'active', false, now()
  );

  INSERT INTO public.account_identifiers (
    account_id, tenant_id, type, value, status, verified, created_at
  ) VALUES (
    NEW.id, v_tenant_id, 'username', v_username, 'active', false, now()
  );

  -- Default account settings — discoverable_by_email now FALSE (021).
  INSERT INTO public.account_settings (
    account_id, tenant_id,
    discoverable_by_email, discoverable_by_username, allow_dms_from,
    updated_at
  ) VALUES (
    NEW.id, v_tenant_id,
    false, true, 'contacts',
    now()
  );

  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION handle_new_user(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_new_user() IS 'Fires AFTER INSERT on auth.users. Creates a pending profiles row, email + username identifiers in account_identifiers, and default account_settings. System username: ''user_'' + 8 random hex chars. Requires pgcrypto (extensions.gen_random_bytes). Tenant hardcoded to sole-tenant UUID (00000000-0000-0000-0000-000000000001). (021) discoverable_by_email now defaults FALSE — new accounts are username-discoverable only. If this function raises, the auth.users INSERT is rolled back — no orphaned auth rows.';


--
-- Name: is_active_member(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_active_member(p_conversation_id uuid, p_account_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1 from public.conversation_members
    where conversation_id = p_conversation_id
      and account_id      = p_account_id
      and left_at is null
  )
$$;


--
-- Name: FUNCTION is_active_member(p_conversation_id uuid, p_account_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_active_member(p_conversation_id uuid, p_account_id uuid) IS 'True iff account has an active (left_at IS NULL) membership of the conversation. STABLE SECURITY DEFINER so RLS policies can read conversation_members without recursion. Reused by conversations/conversation_members/conversation_contexts RLS, the write RPCs, and Spec 7.';


--
-- Name: leave_conversation(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.leave_conversation(p_conversation_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: FUNCTION leave_conversation(p_conversation_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.leave_conversation(p_conversation_id uuid) IS 'Soft-leave: set left_at on the caller''s active membership. No-op-safe. SECURITY DEFINER; tenant-scoped.';


--
-- Name: list_abandoned_pending_accounts(interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_abandoned_pending_accounts(p_max_age interval DEFAULT '30 days'::interval) RETURNS TABLE(account_id uuid, tenant_id uuid, canonical_email text, username_source text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT
    p.id                       AS account_id,
    p.tenant_id                AS tenant_id,
    lower(trim(ai.value))      AS canonical_email,
    p.username_source          AS username_source
  FROM public.profiles p
  LEFT JOIN public.account_identifiers ai
    ON ai.account_id = p.id
   AND ai.type   = 'email'
   AND ai.status = 'active'
  WHERE p.status = 'pending'
    AND p.created_at < (now() - p_max_age)
$$;


--
-- Name: FUNCTION list_abandoned_pending_accounts(p_max_age interval); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.list_abandoned_pending_accounts(p_max_age interval) IS 'Step 6 abandonment sweep: pending accounts older than p_max_age (default 30 days), with canonical email + username_source. System function — service_role only; not user-facing. Backed by profiles_tenant_status_created_idx. policies.md §6.';


--
-- Name: list_due_deletion_requests(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_due_deletion_requests() RETURNS TABLE(request_id uuid, account_id uuid, tenant_id uuid, canonical_email text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT
    d.id                       AS request_id,
    d.user_id                  AS account_id,
    d.tenant_id                AS tenant_id,
    lower(trim(ai.value))      AS canonical_email
  FROM public.data_deletion_requests d
  LEFT JOIN public.account_identifiers ai
    ON ai.account_id = d.user_id
   AND ai.type   = 'email'
   AND ai.status = 'active'
  WHERE d.status = 'pending'
    AND d.user_id IS NOT NULL
    AND d.grace_until < now()
$$;


--
-- Name: FUNCTION list_due_deletion_requests(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.list_due_deletion_requests() IS 'Step 7 deletion sweep: pending erasure requests past their grace window, with canonical email for the abuse hash. System function — service_role only. decisions.md 2026-06-11.';


--
-- Name: record_abandoned_email_hash(uuid, text, smallint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_abandoned_email_hash(p_tenant_id uuid, p_email_hash_hex text, p_key_version smallint DEFAULT 1) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  INSERT INTO public.email_hash_abuse (tenant_id, email_hash, key_version)
  VALUES (p_tenant_id, decode(p_email_hash_hex, 'hex'), p_key_version)
  ON CONFLICT (tenant_id, email_hash, key_version)
  DO UPDATE SET
    abandon_count = public.email_hash_abuse.abandon_count + 1,
    last_seen     = now();
$$;


--
-- Name: FUNCTION record_abandoned_email_hash(p_tenant_id uuid, p_email_hash_hex text, p_key_version smallint); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.record_abandoned_email_hash(p_tenant_id uuid, p_email_hash_hex text, p_key_version smallint) IS 'Step 6 abandonment sweep: atomic insert-or-increment of a keyed email HMAC (passed as hex) into email_hash_abuse. Repeat abandon bumps abandon_count + last_seen; first_seen preserved. System function — service_role only. decisions.md 2026-06-10; policies.md §6.';


--
-- Name: redeem_invite(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.redeem_invite(p_token text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: FUNCTION redeem_invite(p_token text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.redeem_invite(p_token text) IS 'Redeem a contact or conversation invite. contact → auto-accept the contact (canonical pair). conversation → add an active membership, promote direct→group + post member_added on a real join (023). Block-checked; SECURITY DEFINER; tenant-scoped.';


--
-- Name: report_account(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.report_account(p_target uuid, p_reason text, p_details text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_tenant uuid := public.auth_tenant_id();
  v_report uuid;
BEGIN
  IF v_uid IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'report_account: not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_target IS NULL OR p_target = v_uid THEN
    RAISE EXCEPTION 'report_account: invalid target';
  END IF;
  IF p_reason NOT IN ('spam', 'abuse', 'impersonation', 'other') THEN
    RAISE EXCEPTION 'report_account: invalid reason %', p_reason;
  END IF;
  PERFORM 1 FROM public.profiles WHERE id = p_target AND tenant_id = v_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'report_account: target not found';
  END IF;

  INSERT INTO public.reports (tenant_id, reporter_id, reported_id, reason, details)
  VALUES (v_tenant, v_uid, p_target, p_reason, p_details)
  RETURNING id INTO v_report;

  -- Auto-block (idempotent). Same transaction → report+block are atomic.
  IF NOT EXISTS (
    SELECT 1 FROM public.blocks
    WHERE blocker_id = v_uid AND blocked_id = p_target AND unblocked_at IS NULL
  ) THEN
    INSERT INTO public.blocks (tenant_id, blocker_id, blocked_id)
    VALUES (v_tenant, v_uid, p_target)
    ON CONFLICT DO NOTHING;  -- partial unique index; lost-race safety
  END IF;

  RETURN v_report;
END;
$$;


--
-- Name: FUNCTION report_account(p_target uuid, p_reason text, p_details text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.report_account(p_target uuid, p_reason text, p_details text) IS 'Record a report and ensure an active block in one transaction (atomic). Multiple reports of the same target are allowed. SECURITY DEFINER; tenant-scoped.';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: data_deletion_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.data_deletion_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    tenant_id uuid NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    grace_until timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    status text DEFAULT 'pending'::text NOT NULL,
    requested_by text DEFAULT 'user'::text NOT NULL,
    deleted_fields jsonb,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT data_deletion_requests_requested_by_check CHECK ((requested_by = ANY (ARRAY['user'::text, 'admin'::text]))),
    CONSTRAINT data_deletion_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'cancelled'::text])))
);


--
-- Name: TABLE data_deletion_requests; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.data_deletion_requests IS 'GDPR Right-to-Erasure requests (Phase 2 Step 7). Two-phase: deactivate now, hard-delete after grace_until via the daily sweep. Row survives the delete as audit trail (user_id SET NULL on cascade). architecture.md §7/§11; decisions.md 2026-06-11.';


--
-- Name: request_account_deletion(interval); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_account_deletion(p_grace interval DEFAULT '30 days'::interval) RETURNS public.data_deletion_requests
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_tenant uuid;
  v_row    public.data_deletion_requests;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'request_account_deletion: not authenticated';
  END IF;

  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id = v_uid;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'request_account_deletion: no profile for caller';
  END IF;

  -- Return any existing open request unchanged (idempotent; do not reset the grace clock).
  SELECT * INTO v_row
  FROM public.data_deletion_requests
  WHERE user_id = v_uid AND status IN ('pending', 'processing')
  LIMIT 1;
  IF FOUND THEN
    RETURN v_row;
  END IF;

  -- Soft-delete: account exists but is non-functional. Reversible via cancel within grace.
  UPDATE public.profiles
     SET status = 'deactivated', updated_at = now()
   WHERE id = v_uid;

  INSERT INTO public.data_deletion_requests (user_id, tenant_id, grace_until, requested_by)
  VALUES (v_uid, v_tenant, now() + p_grace, 'user')
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;


--
-- Name: FUNCTION request_account_deletion(p_grace interval); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.request_account_deletion(p_grace interval) IS 'Step 7: user requests erasure of THEIR OWN account (auth.uid()). Soft-deletes (status=''deactivated'') and enqueues a pending data_deletion_requests row with a grace window. Idempotent — returns an existing open request. decisions.md 2026-06-11; policies.md §6.';


--
-- Name: request_contact(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_contact(p_target uuid, p_via text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_tenant    uuid := public.auth_tenant_id();
  v_lo        uuid;
  v_hi        uuid;
  v_state     text;
  v_initiator uuid;
BEGIN
  IF v_uid IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'request_contact: not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_target IS NULL OR p_target = v_uid THEN
    RAISE EXCEPTION 'request_contact: invalid target';
  END IF;
  IF p_via NOT IN ('email', 'username', 'phone', 'friend_code') THEN
    RAISE EXCEPTION 'request_contact: invalid via_identifier_type %', p_via;
  END IF;

  -- Target must be an active profile in the caller's tenant (cross-tenant = not found).
  PERFORM 1 FROM public.profiles
   WHERE id = p_target AND tenant_id = v_tenant AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_contact: target not found';
  END IF;

  -- Block gate (either direction) — same opaque error so neither side leaks.
  IF public.active_block_exists(v_uid, p_target) THEN
    RAISE EXCEPTION 'request_contact: cannot add this user';
  END IF;

  v_lo := least(v_uid, p_target);
  v_hi := greatest(v_uid, p_target);

  -- Lock the pair row if it exists, so concurrent adds serialize on it.
  SELECT state, initiator_id INTO v_state, v_initiator
  FROM public.relationships
  WHERE tenant_id = v_tenant AND account_lo = v_lo AND account_hi = v_hi
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.relationships
      (tenant_id, account_lo, account_hi, initiator_id, state, via_identifier_type)
    VALUES
      (v_tenant, v_lo, v_hi, v_uid, 'pending', p_via);
    RETURN 'pending';
  END IF;

  IF v_state = 'accepted' THEN
    RAISE EXCEPTION 'request_contact: already contacts';
  ELSIF v_state = 'pending' THEN
    IF v_initiator = v_uid THEN
      RAISE EXCEPTION 'request_contact: request already pending';
    ELSE
      -- The target had already requested the caller → mutual → accept.
      UPDATE public.relationships
         SET state = 'accepted', updated_at = now()
       WHERE tenant_id = v_tenant AND account_lo = v_lo AND account_hi = v_hi;
      RETURN 'accepted';
    END IF;
  ELSE  -- 'declined' → allow a fresh request from the caller
    UPDATE public.relationships
       SET state = 'pending', initiator_id = v_uid,
           via_identifier_type = p_via, updated_at = now()
     WHERE tenant_id = v_tenant AND account_lo = v_lo AND account_hi = v_hi;
    RETURN 'pending';
  END IF;
END;
$$;


--
-- Name: FUNCTION request_contact(p_target uuid, p_via text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.request_contact(p_target uuid, p_via text) IS 'Add-a-contact entry point on the canonical-pair model. Inserts/updates the single pair row: new→pending, reverse-pending→accepted (mutual), declined→pending (re-request). Block-checked both directions; SECURITY DEFINER; tenant-scoped.';


--
-- Name: respond_to_contact(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.respond_to_contact(p_other uuid, p_accept boolean) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_tenant    uuid := public.auth_tenant_id();
  v_lo        uuid;
  v_hi        uuid;
  v_state     text;
  v_initiator uuid;
  v_new       text;
BEGIN
  IF v_uid IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'respond_to_contact: not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_other IS NULL OR p_other = v_uid THEN
    RAISE EXCEPTION 'respond_to_contact: invalid target';
  END IF;

  v_lo := least(v_uid, p_other);
  v_hi := greatest(v_uid, p_other);

  SELECT state, initiator_id INTO v_state, v_initiator
  FROM public.relationships
  WHERE tenant_id = v_tenant AND account_lo = v_lo AND account_hi = v_hi
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'respond_to_contact: no request to respond to';
  END IF;
  IF v_state <> 'pending' THEN
    RAISE EXCEPTION 'respond_to_contact: request is not pending (state=%)', v_state;
  END IF;
  IF v_initiator = v_uid THEN
    RAISE EXCEPTION 'respond_to_contact: cannot respond to your own request';
  END IF;

  IF p_accept THEN
    IF public.active_block_exists(v_uid, p_other) THEN
      RAISE EXCEPTION 'respond_to_contact: cannot accept this user';
    END IF;
    v_new := 'accepted';
  ELSE
    v_new := 'declined';
  END IF;

  UPDATE public.relationships
     SET state = v_new, updated_at = now()
   WHERE tenant_id = v_tenant AND account_lo = v_lo AND account_hi = v_hi;

  RETURN v_new;
END;
$$;


--
-- Name: FUNCTION respond_to_contact(p_other uuid, p_accept boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.respond_to_contact(p_other uuid, p_accept boolean) IS 'Accept or decline an incoming pending contact request (caller must be the addressee). Accept is block-checked; decline keeps the row soft. SECURITY DEFINER; tenant-scoped.';


--
-- Name: revoke_invite(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.revoke_invite(p_invite_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_n   integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'revoke_invite: not authenticated' USING ERRCODE = '28000';
  END IF;
  UPDATE public.invites SET revoked = true
   WHERE id = p_invite_id AND created_by = v_uid AND revoked = false;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN CASE WHEN v_n > 0 THEN 'revoked' ELSE 'noop' END;
END;
$$;


--
-- Name: FUNCTION revoke_invite(p_invite_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.revoke_invite(p_invite_id uuid) IS 'Revoke an invite the caller created (no further redemptions). SECURITY DEFINER.';


--
-- Name: search_accounts_by_username(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_accounts_by_username(p_prefix text, p_limit integer DEFAULT 10) RETURNS TABLE(account_id uuid, display_name text, username text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_prefix text := lower(btrim(p_prefix));
  v_like   text;
  v_limit  integer := least(greatest(coalesce(p_limit, 10), 1), 20);
BEGIN
  IF length(v_prefix) < 3 THEN
    RETURN;
  END IF;

  v_like := replace(replace(replace(v_prefix, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  RETURN QUERY
  SELECT p.id, p.display_name, p.username
  FROM public.account_identifiers ai
  JOIN public.profiles p          ON p.id = ai.account_id
  JOIN public.account_settings s  ON s.account_id = p.id
  WHERE ai.tenant_id = public.auth_tenant_id()
    AND ai.type      = 'username'
    AND ai.status    = 'active'
    AND ai.value LIKE v_like ESCAPE '\'
    AND p.status     = 'active'
    AND p.id        <> auth.uid()
    AND s.discoverable_by_username = true
    AND NOT public.active_block_exists(auth.uid(), p.id)   -- 011: hide blocked users
  ORDER BY ai.value
  LIMIT v_limit;
END;
$$;


--
-- Name: FUNCTION search_accounts_by_username(p_prefix text, p_limit integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.search_accounts_by_username(p_prefix text, p_limit integer) IS 'Phase 2 Step 4 discovery (amended in 011): username autocomplete (prefix). SECURITY DEFINER; returns only public handles. Min prefix 3, cap 20, LIKE escaped; tenant-scoped; respects discoverable_by_username; active profiles only; excludes the caller; excludes users with an active block (either direction).';


--
-- Name: set_conversation_context_type(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_conversation_context_type(p_conversation_id uuid, p_context_type text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: FUNCTION set_conversation_context_type(p_conversation_id uuid, p_context_type text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.set_conversation_context_type(p_conversation_id uuid, p_context_type text) IS 'Set a conversation''s context_type. Caller must be an active member. SECURITY DEFINER; tenant-scoped. context_type vocab unified with the translation engine in migration 019.';


--
-- Name: set_conversation_title(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_conversation_title(p_conversation_id uuid, p_title text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: FUNCTION set_conversation_title(p_conversation_id uuid, p_title text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.set_conversation_title(p_conversation_id uuid, p_title text) IS 'Set/clear a conversation title. Caller must be an active member. Empty → NULL (UI falls back to the member-list name). Tenant-scoped; SECURITY DEFINER. (024, Spec 13.)';


--
-- Name: set_display_name(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_display_name(p_display_name text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid          uuid := auth.uid();
  v_trimmed_name text := trim(p_display_name);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'set_display_name: not authenticated' USING ERRCODE = '28000';
  END IF;

  -- Same rules as complete_onboarding (policies.md §1): 1–50 chars after trim,
  -- plus a control-char / bidi-override denylist (allowlist would break
  -- international names like "José", "Nguyễn", "李").
  IF length(v_trimmed_name) = 0 THEN
    RAISE EXCEPTION 'set_display_name: display_name cannot be empty';
  END IF;
  IF length(v_trimmed_name) > 50 THEN
    RAISE EXCEPTION 'set_display_name: display_name exceeds 50 characters';
  END IF;
  IF v_trimmed_name ~ ('[' || chr(1) || '-' || chr(31) || chr(127)
                        || chr(8234) || '-' || chr(8238)
                        || chr(8294) || '-' || chr(8297) || ']') THEN
    RAISE EXCEPTION 'set_display_name: display_name contains invalid control characters';
  END IF;

  UPDATE public.profiles
     SET display_name = v_trimmed_name,
         updated_at   = now()
   WHERE id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'set_display_name: no profile for caller';
  END IF;

  RETURN v_trimmed_name;
END;
$$;


--
-- Name: FUNCTION set_display_name(p_display_name text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.set_display_name(p_display_name text) IS 'Phase 2.4 settings screen: change the caller''s display_name with the same validation as complete_onboarding (1–50 chars + control-char/bidi denylist). SECURITY DEFINER so the denylist can''t be bypassed by a raw client UPDATE.';


--
-- Name: set_preferred_language(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_preferred_language(p_language text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_tenant uuid := public.auth_tenant_id();
  v_lang   text := trim(p_language);
BEGIN
  IF v_uid IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'set_preferred_language: not authenticated' USING ERRCODE = '28000';
  END IF;

  IF v_lang IS NULL OR length(v_lang) = 0 THEN
    RAISE EXCEPTION 'set_preferred_language: language is required';
  END IF;
  IF length(v_lang) > 35 THEN
    -- BCP 47 tags are short; guard against junk. (Longest realistic tags are well under this.)
    RAISE EXCEPTION 'set_preferred_language: language code too long';
  END IF;

  UPDATE public.user_linguistic_profiles
     SET preferred_language = v_lang,
         updated_at         = now()
   WHERE user_id = v_uid AND tenant_id = v_tenant;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'set_preferred_language: no linguistic profile for caller';
  END IF;

  RETURN v_lang;
END;
$$;


--
-- Name: FUNCTION set_preferred_language(p_language text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.set_preferred_language(p_language text) IS 'Phase 2.4 settings screen: change the caller''s translation target language (user_linguistic_profiles.preferred_language). Validated single enforcement point; onboarding seeds the row via complete_onboarding(), this changes it later.';


--
-- Name: unblock_account(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.unblock_account(p_target uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_tenant uuid := public.auth_tenant_id();
  v_n      integer;
BEGIN
  IF v_uid IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'unblock_account: not authenticated' USING ERRCODE = '28000';
  END IF;

  UPDATE public.blocks
     SET unblocked_at = now()
   WHERE blocker_id = v_uid AND blocked_id = p_target AND unblocked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  RETURN CASE WHEN v_n > 0 THEN 'unblocked' ELSE 'not_blocked' END;
END;
$$;


--
-- Name: FUNCTION unblock_account(p_target uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.unblock_account(p_target uuid) IS 'Stamp unblocked_at on the caller''s active block of the target (history preserved). SECURITY DEFINER; tenant-scoped.';


--
-- Name: account_identifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_identifiers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid,
    tenant_id uuid NOT NULL,
    type text NOT NULL,
    value text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_identifiers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'retired'::text, 'reserved'::text]))),
    CONSTRAINT account_identifiers_type_check CHECK ((type = ANY (ARRAY['email'::text, 'username'::text, 'phone'::text, 'friend_code'::text])))
);


--
-- Name: account_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_settings (
    account_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    discoverable_by_email boolean DEFAULT false NOT NULL,
    discoverable_by_username boolean DEFAULT true NOT NULL,
    allow_dms_from text DEFAULT 'contacts'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT account_settings_dms_from_check CHECK ((allow_dms_from = ANY (ARRAY['everyone'::text, 'contacts'::text, 'nobody'::text])))
);


--
-- Name: agent_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    parent_task_id uuid,
    schema_version integer DEFAULT 1 NOT NULL,
    idempotency_key text,
    tenant_id uuid NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    status text NOT NULL,
    task_summary text NOT NULL,
    gateway text NOT NULL,
    channel_id text,
    channel_name text,
    thread_id text,
    initiating_message_id text,
    triggered_by text,
    conversation_turns integer,
    model_tier text NOT NULL,
    model_used text NOT NULL,
    tokens_in integer,
    tokens_out integer,
    cost_cents integer,
    files_changed text[],
    commits text[],
    deploys text[],
    decisions_drafted integer DEFAULT 0,
    skills_created integer DEFAULT 0,
    errors jsonb,
    approval_log jsonb,
    raw_report text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_events_gateway_check CHECK ((gateway = ANY (ARRAY['discord'::text, 'cli'::text, 'scheduled'::text]))),
    CONSTRAINT agent_events_model_tier_check CHECK ((model_tier = ANY (ARRAY['sonnet'::text, 'opus'::text]))),
    CONSTRAINT agent_events_status_check CHECK ((status = ANY (ARRAY['completed'::text, 'failed'::text, 'escalated'::text, 'aborted'::text])))
);


--
-- Name: blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    blocker_id uuid NOT NULL,
    blocked_id uuid NOT NULL,
    unblocked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT blocks_no_self CHECK ((blocker_id <> blocked_id))
);


--
-- Name: conversation_contexts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_contexts (
    conversation_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    participant_ids text[],
    detected_register text,
    register_confidence double precision DEFAULT 0.0,
    relationship_closeness text,
    closeness_signals jsonb,
    dominant_topics text[],
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT conversation_contexts_detected_register_check CHECK ((detected_register = ANY (ARRAY['professional'::text, 'casual'::text, 'romantic'::text, 'family'::text, 'support'::text]))),
    CONSTRAINT conversation_contexts_relationship_closeness_check CHECK ((relationship_closeness = ANY (ARRAY['new'::text, 'acquainted'::text, 'close'::text])))
);


--
-- Name: conversation_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    account_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    left_at timestamp with time zone,
    last_read_at timestamp with time zone,
    CONSTRAINT conversation_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'member'::text])))
);


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    kind text NOT NULL,
    title text,
    context_type text DEFAULT 'casual'::text NOT NULL,
    created_by uuid,
    dedupe_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conversations_context_type_check CHECK ((context_type = ANY (ARRAY['casual'::text, 'dating'::text, 'professional'::text, 'academic'::text]))),
    CONSTRAINT conversations_kind_check CHECK ((kind = ANY (ARRAY['direct'::text, 'group'::text])))
);


--
-- Name: email_hash_abuse; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_hash_abuse (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    email_hash bytea NOT NULL,
    key_version smallint DEFAULT 1 NOT NULL,
    first_seen timestamp with time zone DEFAULT now() NOT NULL,
    last_seen timestamp with time zone DEFAULT now() NOT NULL,
    abandon_count integer DEFAULT 1 NOT NULL,
    CONSTRAINT email_hash_abuse_count_positive CHECK ((abandon_count >= 1))
);


--
-- Name: invite_redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invite_redemptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    invite_id uuid NOT NULL,
    redeemed_by uuid NOT NULL,
    redeemed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    token text NOT NULL,
    kind text NOT NULL,
    created_by uuid NOT NULL,
    target_conversation_id uuid,
    max_uses integer,
    use_count integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone,
    revoked boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invites_kind_check CHECK ((kind = ANY (ARRAY['contact'::text, 'conversation'::text]))),
    CONSTRAINT invites_max_uses_positive CHECK (((max_uses IS NULL) OR (max_uses > 0))),
    CONSTRAINT invites_use_count_nonneg CHECK ((use_count >= 0))
);


--
-- Name: message_translations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_translations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid,
    language text NOT NULL,
    translated_text text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    tenant_id uuid NOT NULL,
    prompt_version text
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    sender_id uuid,
    original_text text,
    source_language text,
    tenant_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    kind text DEFAULT 'user'::text NOT NULL,
    payload jsonb,
    CONSTRAINT messages_kind_check CHECK ((kind = ANY (ARRAY['user'::text, 'system'::text])))
);


--
-- Name: COLUMN messages.kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.messages.kind IS 'user = a person''s message (default); system = an event row (e.g. member_added) with sender_id NULL + structured payload. Rides the existing messages realtime + 018 membership-scoped SELECT RLS. (023, Spec 11.)';


--
-- Name: COLUMN messages.payload; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.messages.payload IS 'Structured body for kind=''system'' rows, e.g. {"event":"member_added","target_account_id":"…"}. NULL for user messages. (023, Spec 11.)';


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    display_name text DEFAULT ''::text NOT NULL,
    username text NOT NULL,
    username_source text DEFAULT 'system_generated'::text NOT NULL,
    username_last_changed_at timestamp with time zone,
    is_verified boolean DEFAULT false NOT NULL,
    verification_method text,
    status text DEFAULT 'pending'::text NOT NULL,
    onboarding_completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT profiles_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'deactivated'::text]))),
    CONSTRAINT profiles_username_source_check CHECK ((username_source = ANY (ARRAY['system_generated'::text, 'user_set'::text])))
);


--
-- Name: relationships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.relationships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    account_lo uuid NOT NULL,
    account_hi uuid NOT NULL,
    initiator_id uuid NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    via_identifier_type text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT relationships_canonical_order CHECK ((account_lo < account_hi)),
    CONSTRAINT relationships_initiator_in_pair CHECK (((initiator_id = account_lo) OR (initiator_id = account_hi))),
    CONSTRAINT relationships_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text]))),
    CONSTRAINT relationships_via_check CHECK ((via_identifier_type = ANY (ARRAY['email'::text, 'username'::text, 'phone'::text, 'friend_code'::text, 'invite_link'::text])))
);


--
-- Name: reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    reporter_id uuid NOT NULL,
    reported_id uuid NOT NULL,
    reason text NOT NULL,
    details text,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reports_no_self CHECK ((reporter_id <> reported_id)),
    CONSTRAINT reports_reason_check CHECK ((reason = ANY (ARRAY['spam'::text, 'abuse'::text, 'impersonation'::text, 'other'::text]))),
    CONSTRAINT reports_status_check CHECK ((status = ANY (ARRAY['open'::text, 'reviewed'::text, 'actioned'::text, 'dismissed'::text])))
);


--
-- Name: tenants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    default_correction_ownership text DEFAULT 'platform'::text NOT NULL,
    training_data_agreement boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    dm_initiation_policy jsonb DEFAULT '{}'::jsonb NOT NULL,
    conversation_policy jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT tenants_default_correction_ownership_check CHECK ((default_correction_ownership = ANY (ARRAY['platform'::text, 'tenant'::text, 'shared'::text])))
);


--
-- Name: COLUMN tenants.conversation_policy; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tenants.conversation_policy IS 'Per-tenant conversation dedupe override (jsonb). Keys: direct, group → dedupe|always_new. Empty = fall through to lib/policies.js CONVERSATION.DEFAULTS. Read at creation time only.';


--
-- Name: translation_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.translation_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    schema_version integer DEFAULT 1 NOT NULL,
    tenant_id uuid NOT NULL,
    task_id uuid,
    user_id text,
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
    source_language text,
    target_language text NOT NULL,
    was_cached boolean NOT NULL,
    model_used text NOT NULL,
    prompt_version text NOT NULL,
    latency_ms integer NOT NULL,
    character_count integer NOT NULL,
    input_tokens integer,
    output_tokens integer,
    cost_cents integer,
    retry_count integer DEFAULT 0 NOT NULL,
    error_type text,
    event_source text DEFAULT 'chat_app'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT translation_events_event_source_check CHECK ((event_source = ANY (ARRAY['chat_app'::text, 'hermes_test'::text, 'api_external'::text])))
);


--
-- Name: user_linguistic_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_linguistic_profiles (
    user_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    preferred_language text,
    dialect_region text,
    dialect_confidence double precision DEFAULT 0.0,
    dialect_source text DEFAULT 'inferred'::text,
    formality_preference text,
    formality_source text DEFAULT 'inferred'::text,
    gender_signal text,
    gender_source text DEFAULT 'inferred'::text,
    script_preference text,
    script_source text DEFAULT 'inferred'::text,
    known_languages text[],
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT ulp_dialect_source_check CHECK ((dialect_source = ANY (ARRAY['explicit'::text, 'inferred'::text]))),
    CONSTRAINT ulp_formality_check CHECK ((formality_preference = ANY (ARRAY['formal'::text, 'neutral'::text, 'casual'::text]))),
    CONSTRAINT ulp_formality_source_check CHECK ((formality_source = ANY (ARRAY['explicit'::text, 'inferred'::text]))),
    CONSTRAINT ulp_gender_check CHECK ((gender_signal = ANY (ARRAY['masculine'::text, 'feminine'::text, 'neutral'::text, 'nonbinary'::text, 'unknown'::text]))),
    CONSTRAINT ulp_gender_source_check CHECK ((gender_source = ANY (ARRAY['explicit'::text, 'inferred'::text]))),
    CONSTRAINT ulp_script_source_check CHECK ((script_source = ANY (ARRAY['explicit'::text, 'inferred'::text])))
);


--
-- Name: user_profile_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_profile_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    event_type text NOT NULL,
    previous_value jsonb,
    new_value jsonb,
    source text NOT NULL,
    task_id text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT upe_source_check CHECK ((source = ANY (ARRAY['explicit'::text, 'inference'::text, 'correction_analysis'::text])))
);


--
-- Name: account_identifiers account_identifiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_identifiers
    ADD CONSTRAINT account_identifiers_pkey PRIMARY KEY (id);


--
-- Name: account_identifiers account_identifiers_unique_value; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_identifiers
    ADD CONSTRAINT account_identifiers_unique_value UNIQUE (tenant_id, type, value);


--
-- Name: account_settings account_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_settings
    ADD CONSTRAINT account_settings_pkey PRIMARY KEY (account_id);


--
-- Name: agent_events agent_events_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_events
    ADD CONSTRAINT agent_events_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: agent_events agent_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_events
    ADD CONSTRAINT agent_events_pkey PRIMARY KEY (id);


--
-- Name: agent_events agent_events_task_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_events
    ADD CONSTRAINT agent_events_task_id_key UNIQUE (task_id);


--
-- Name: blocks blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocks
    ADD CONSTRAINT blocks_pkey PRIMARY KEY (id);


--
-- Name: conversation_contexts conversation_contexts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_contexts
    ADD CONSTRAINT conversation_contexts_pkey PRIMARY KEY (conversation_id, tenant_id);


--
-- Name: conversation_members conversation_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_members
    ADD CONSTRAINT conversation_members_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: data_deletion_requests data_deletion_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_deletion_requests
    ADD CONSTRAINT data_deletion_requests_pkey PRIMARY KEY (id);


--
-- Name: email_hash_abuse email_hash_abuse_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_hash_abuse
    ADD CONSTRAINT email_hash_abuse_pkey PRIMARY KEY (id);


--
-- Name: email_hash_abuse email_hash_abuse_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_hash_abuse
    ADD CONSTRAINT email_hash_abuse_unique UNIQUE (tenant_id, email_hash, key_version);


--
-- Name: invite_redemptions invite_redemptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_redemptions
    ADD CONSTRAINT invite_redemptions_pkey PRIMARY KEY (id);


--
-- Name: invite_redemptions invite_redemptions_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_redemptions
    ADD CONSTRAINT invite_redemptions_unique UNIQUE (invite_id, redeemed_by);


--
-- Name: invites invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_pkey PRIMARY KEY (id);


--
-- Name: invites invites_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_token_unique UNIQUE (token);


--
-- Name: message_translations message_translations_message_id_language_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_translations
    ADD CONSTRAINT message_translations_message_id_language_key UNIQUE (message_id, language);


--
-- Name: message_translations message_translations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_translations
    ADD CONSTRAINT message_translations_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_unique_username; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_unique_username UNIQUE (tenant_id, username);


--
-- Name: relationships relationships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationships
    ADD CONSTRAINT relationships_pkey PRIMARY KEY (id);


--
-- Name: relationships relationships_unique_pair; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationships
    ADD CONSTRAINT relationships_unique_pair UNIQUE (tenant_id, account_lo, account_hi);


--
-- Name: reports reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_pkey PRIMARY KEY (id);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: translation_events translation_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.translation_events
    ADD CONSTRAINT translation_events_pkey PRIMARY KEY (id);


--
-- Name: user_linguistic_profiles user_linguistic_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_linguistic_profiles
    ADD CONSTRAINT user_linguistic_profiles_pkey PRIMARY KEY (user_id, tenant_id);


--
-- Name: user_profile_events user_profile_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profile_events
    ADD CONSTRAINT user_profile_events_pkey PRIMARY KEY (id);


--
-- Name: account_identifiers_account_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_identifiers_account_type_idx ON public.account_identifiers USING btree (account_id, type, status);


--
-- Name: account_identifiers_username_prefix_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_identifiers_username_prefix_idx ON public.account_identifiers USING btree (tenant_id, value text_pattern_ops) WHERE ((type = 'username'::text) AND (status = 'active'::text));


--
-- Name: agent_events_task_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_events_task_id ON public.agent_events USING btree (task_id);


--
-- Name: agent_events_tenant_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX agent_events_tenant_channel ON public.agent_events USING btree (tenant_id, channel_id, started_at DESC);


--
-- Name: blocks_active_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX blocks_active_unique ON public.blocks USING btree (blocker_id, blocked_id) WHERE (unblocked_at IS NULL);


--
-- Name: blocks_blocked_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX blocks_blocked_active_idx ON public.blocks USING btree (blocked_id) WHERE (unblocked_at IS NULL);


--
-- Name: conversation_members_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversation_members_account_id_idx ON public.conversation_members USING btree (account_id);


--
-- Name: conversation_members_active_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX conversation_members_active_unique ON public.conversation_members USING btree (conversation_id, account_id) WHERE (left_at IS NULL);


--
-- Name: conversation_members_conversation_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversation_members_conversation_id_idx ON public.conversation_members USING btree (conversation_id);


--
-- Name: conversations_dedupe_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX conversations_dedupe_unique ON public.conversations USING btree (tenant_id, dedupe_key) WHERE (dedupe_key IS NOT NULL);


--
-- Name: conversations_tenant_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX conversations_tenant_id_idx ON public.conversations USING btree (tenant_id);


--
-- Name: data_deletion_requests_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX data_deletion_requests_due_idx ON public.data_deletion_requests USING btree (status, grace_until) WHERE (status = 'pending'::text);


--
-- Name: data_deletion_requests_one_open_per_user; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX data_deletion_requests_one_open_per_user ON public.data_deletion_requests USING btree (user_id) WHERE (status = ANY (ARRAY['pending'::text, 'processing'::text]));


--
-- Name: idx_message_translations_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_translations_tenant_id ON public.message_translations USING btree (tenant_id);


--
-- Name: idx_messages_conversation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_conversation_id ON public.messages USING btree (conversation_id);


--
-- Name: idx_messages_sender_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_sender_id ON public.messages USING btree (sender_id);


--
-- Name: idx_messages_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_tenant_id ON public.messages USING btree (tenant_id);


--
-- Name: idx_msg_translations_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_msg_translations_tenant_id ON public.message_translations USING btree (tenant_id);


--
-- Name: invite_redemptions_redeemed_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invite_redemptions_redeemed_by_idx ON public.invite_redemptions USING btree (redeemed_by);


--
-- Name: invites_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX invites_created_by_idx ON public.invites USING btree (created_by);


--
-- Name: profiles_tenant_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profiles_tenant_status_created_idx ON public.profiles USING btree (tenant_id, status, created_at) WHERE (status = 'pending'::text);


--
-- Name: relationships_hi_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX relationships_hi_idx ON public.relationships USING btree (tenant_id, account_hi);


--
-- Name: reports_reported_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reports_reported_idx ON public.reports USING btree (tenant_id, reported_id);


--
-- Name: translation_events_task_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX translation_events_task_id ON public.translation_events USING btree (task_id);


--
-- Name: translation_events_tenant_timestamp; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX translation_events_tenant_timestamp ON public.translation_events USING btree (tenant_id, "timestamp" DESC);


--
-- Name: account_identifiers account_identifiers_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_identifiers
    ADD CONSTRAINT account_identifiers_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: account_identifiers account_identifiers_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_identifiers
    ADD CONSTRAINT account_identifiers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: account_settings account_settings_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_settings
    ADD CONSTRAINT account_settings_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: account_settings account_settings_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_settings
    ADD CONSTRAINT account_settings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: agent_events agent_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_events
    ADD CONSTRAINT agent_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: blocks blocks_blocked_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocks
    ADD CONSTRAINT blocks_blocked_id_fkey FOREIGN KEY (blocked_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: blocks blocks_blocker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocks
    ADD CONSTRAINT blocks_blocker_id_fkey FOREIGN KEY (blocker_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: blocks blocks_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocks
    ADD CONSTRAINT blocks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: conversation_contexts conversation_contexts_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_contexts
    ADD CONSTRAINT conversation_contexts_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE NOT VALID;


--
-- Name: conversation_contexts conversation_contexts_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_contexts
    ADD CONSTRAINT conversation_contexts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: conversation_members conversation_members_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_members
    ADD CONSTRAINT conversation_members_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: conversation_members conversation_members_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_members
    ADD CONSTRAINT conversation_members_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: conversation_members conversation_members_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_members
    ADD CONSTRAINT conversation_members_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: conversations conversations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: conversations conversations_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: data_deletion_requests data_deletion_requests_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_deletion_requests
    ADD CONSTRAINT data_deletion_requests_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: data_deletion_requests data_deletion_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_deletion_requests
    ADD CONSTRAINT data_deletion_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: email_hash_abuse email_hash_abuse_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_hash_abuse
    ADD CONSTRAINT email_hash_abuse_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: invite_redemptions invite_redemptions_invite_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_redemptions
    ADD CONSTRAINT invite_redemptions_invite_id_fkey FOREIGN KEY (invite_id) REFERENCES public.invites(id) ON DELETE CASCADE;


--
-- Name: invite_redemptions invite_redemptions_redeemed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invite_redemptions
    ADD CONSTRAINT invite_redemptions_redeemed_by_fkey FOREIGN KEY (redeemed_by) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: invites invites_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: invites invites_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: message_translations message_translations_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_translations
    ADD CONSTRAINT message_translations_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;


--
-- Name: message_translations message_translations_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_translations
    ADD CONSTRAINT message_translations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: messages messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id);


--
-- Name: messages messages_sender_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_sender_id_fk FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: messages messages_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: relationships relationships_account_hi_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationships
    ADD CONSTRAINT relationships_account_hi_fkey FOREIGN KEY (account_hi) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: relationships relationships_account_lo_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationships
    ADD CONSTRAINT relationships_account_lo_fkey FOREIGN KEY (account_lo) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: relationships relationships_initiator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationships
    ADD CONSTRAINT relationships_initiator_id_fkey FOREIGN KEY (initiator_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: relationships relationships_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relationships
    ADD CONSTRAINT relationships_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: reports reports_reported_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_reported_id_fkey FOREIGN KEY (reported_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: reports reports_reporter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: reports reports_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: translation_events translation_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.translation_events
    ADD CONSTRAINT translation_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: user_linguistic_profiles user_linguistic_profiles_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_linguistic_profiles
    ADD CONSTRAINT user_linguistic_profiles_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: user_linguistic_profiles user_linguistic_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_linguistic_profiles
    ADD CONSTRAINT user_linguistic_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_profile_events user_profile_events_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profile_events
    ADD CONSTRAINT user_profile_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- Name: user_profile_events user_profile_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profile_events
    ADD CONSTRAINT user_profile_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: account_identifiers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.account_identifiers ENABLE ROW LEVEL SECURITY;

--
-- Name: account_identifiers account_identifiers_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY account_identifiers_select_own ON public.account_identifiers FOR SELECT TO authenticated USING ((account_id = auth.uid()));


--
-- Name: account_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.account_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: account_settings account_settings_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY account_settings_select_own ON public.account_settings FOR SELECT TO authenticated USING ((account_id = auth.uid()));


--
-- Name: account_settings account_settings_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY account_settings_update_own ON public.account_settings FOR UPDATE TO authenticated USING ((account_id = auth.uid())) WITH CHECK ((account_id = auth.uid()));


--
-- Name: blocks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;

--
-- Name: blocks blocks_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY blocks_select_own ON public.blocks FOR SELECT TO authenticated USING (((tenant_id = public.auth_tenant_id()) AND (blocker_id = auth.uid())));


--
-- Name: conversation_contexts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversation_contexts ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation_contexts conversation_contexts_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY conversation_contexts_select_member ON public.conversation_contexts FOR SELECT TO authenticated USING (((tenant_id = public.auth_tenant_id()) AND public.is_active_member(conversation_id, auth.uid())));


--
-- Name: conversation_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversation_members ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation_members conversation_members_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY conversation_members_select_member ON public.conversation_members FOR SELECT TO authenticated USING (((tenant_id = public.auth_tenant_id()) AND ((account_id = auth.uid()) OR public.is_active_member(conversation_id, auth.uid()))));


--
-- Name: conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: conversations conversations_select_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY conversations_select_member ON public.conversations FOR SELECT TO authenticated USING (((tenant_id = public.auth_tenant_id()) AND public.is_active_member(id, auth.uid())));


--
-- Name: data_deletion_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.data_deletion_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: data_deletion_requests ddr_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ddr_select_own ON public.data_deletion_requests FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: email_hash_abuse; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_hash_abuse ENABLE ROW LEVEL SECURITY;

--
-- Name: invite_redemptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invite_redemptions ENABLE ROW LEVEL SECURITY;

--
-- Name: invite_redemptions invite_redemptions_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invite_redemptions_select_own ON public.invite_redemptions FOR SELECT TO authenticated USING ((redeemed_by = auth.uid()));


--
-- Name: invites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;

--
-- Name: invites invites_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY invites_select_own ON public.invites FOR SELECT TO authenticated USING (((tenant_id = public.auth_tenant_id()) AND (created_by = auth.uid())));


--
-- Name: message_translations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.message_translations ENABLE ROW LEVEL SECURITY;

--
-- Name: messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: messages messages_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY messages_insert_own ON public.messages FOR INSERT TO authenticated WITH CHECK (((sender_id = auth.uid()) AND (tenant_id = public.auth_tenant_id()) AND public.is_active_member(conversation_id, auth.uid())));


--
-- Name: messages messages_select_same_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY messages_select_same_tenant ON public.messages FOR SELECT TO authenticated USING (((tenant_id = public.auth_tenant_id()) AND public.is_active_member(conversation_id, auth.uid())));


--
-- Name: message_translations mt_insert_same_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY mt_insert_same_tenant ON public.message_translations FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.messages m
  WHERE ((m.id = message_translations.message_id) AND (m.tenant_id = public.auth_tenant_id()) AND public.is_active_member(m.conversation_id, auth.uid())))));


--
-- Name: message_translations mt_select_same_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY mt_select_same_tenant ON public.message_translations FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.messages m
  WHERE ((m.id = message_translations.message_id) AND (m.tenant_id = public.auth_tenant_id()) AND public.is_active_member(m.conversation_id, auth.uid())))));


--
-- Name: message_translations mt_update_same_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY mt_update_same_tenant ON public.message_translations FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.messages m
  WHERE ((m.id = message_translations.message_id) AND (m.tenant_id = public.auth_tenant_id()) AND public.is_active_member(m.conversation_id, auth.uid()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.messages m
  WHERE ((m.id = message_translations.message_id) AND (m.tenant_id = public.auth_tenant_id()) AND public.is_active_member(m.conversation_id, auth.uid())))));


--
-- Name: user_profile_events profile_writer_events_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profile_writer_events_insert ON public.user_profile_events FOR INSERT TO profile_writer WITH CHECK (true);


--
-- Name: messages profile_writer_messages_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profile_writer_messages_select ON public.messages FOR SELECT TO profile_writer USING (true);


--
-- Name: user_linguistic_profiles profile_writer_ulp_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profile_writer_ulp_select ON public.user_linguistic_profiles FOR SELECT TO profile_writer USING (true);


--
-- Name: user_linguistic_profiles profile_writer_ulp_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profile_writer_ulp_update ON public.user_linguistic_profiles FOR UPDATE TO profile_writer USING (true) WITH CHECK (true);


--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles_select_same_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_select_same_tenant ON public.profiles FOR SELECT TO authenticated USING ((tenant_id = public.auth_tenant_id()));


--
-- Name: profiles profiles_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_update_own ON public.profiles FOR UPDATE TO authenticated USING ((id = auth.uid())) WITH CHECK (((id = auth.uid()) AND (tenant_id = public.auth_tenant_id())));


--
-- Name: relationships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.relationships ENABLE ROW LEVEL SECURITY;

--
-- Name: relationships relationships_select_party; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY relationships_select_party ON public.relationships FOR SELECT TO authenticated USING (((tenant_id = public.auth_tenant_id()) AND ((account_lo = auth.uid()) OR (account_hi = auth.uid()))));


--
-- Name: reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

--
-- Name: reports reports_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reports_select_own ON public.reports FOR SELECT TO authenticated USING (((tenant_id = public.auth_tenant_id()) AND (reporter_id = auth.uid())));


--
-- Name: user_linguistic_profiles ulp_select_same_tenant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ulp_select_same_tenant ON public.user_linguistic_profiles FOR SELECT TO authenticated USING ((tenant_id = public.auth_tenant_id()));


--
-- Name: user_linguistic_profiles ulp_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ulp_update_own ON public.user_linguistic_profiles FOR UPDATE TO authenticated USING ((user_id = auth.uid())) WITH CHECK (((user_id = auth.uid()) AND (tenant_id = public.auth_tenant_id())));


--
-- Name: user_profile_events upe_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY upe_insert_own ON public.user_profile_events FOR INSERT TO authenticated WITH CHECK (((user_id = auth.uid()) AND (tenant_id = public.auth_tenant_id())));


--
-- Name: user_profile_events upe_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY upe_select_own ON public.user_profile_events FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: user_linguistic_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_linguistic_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: user_profile_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_profile_events ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;
GRANT USAGE ON SCHEMA public TO hermes_readonly;
GRANT USAGE ON SCHEMA public TO profile_writer;


--
-- Name: FUNCTION _member_added_finalize(p_conversation_id uuid, p_added_account uuid, p_tenant uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public._member_added_finalize(p_conversation_id uuid, p_added_account uuid, p_tenant uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public._member_added_finalize(p_conversation_id uuid, p_added_account uuid, p_tenant uuid) TO service_role;


--
-- Name: FUNCTION active_block_exists(p_a uuid, p_b uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.active_block_exists(p_a uuid, p_b uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.active_block_exists(p_a uuid, p_b uuid) TO authenticated;
GRANT ALL ON FUNCTION public.active_block_exists(p_a uuid, p_b uuid) TO service_role;


--
-- Name: FUNCTION add_conversation_member(p_conversation_id uuid, p_account_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.add_conversation_member(p_conversation_id uuid, p_account_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.add_conversation_member(p_conversation_id uuid, p_account_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.add_conversation_member(p_conversation_id uuid, p_account_id uuid) TO service_role;


--
-- Name: FUNCTION auth_tenant_id(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.auth_tenant_id() TO anon;
GRANT ALL ON FUNCTION public.auth_tenant_id() TO authenticated;
GRANT ALL ON FUNCTION public.auth_tenant_id() TO service_role;


--
-- Name: FUNCTION block_account(p_target uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.block_account(p_target uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.block_account(p_target uuid) TO authenticated;
GRANT ALL ON FUNCTION public.block_account(p_target uuid) TO service_role;


--
-- Name: FUNCTION cancel_account_deletion(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.cancel_account_deletion() FROM PUBLIC;
GRANT ALL ON FUNCTION public.cancel_account_deletion() TO authenticated;
GRANT ALL ON FUNCTION public.cancel_account_deletion() TO service_role;


--
-- Name: FUNCTION change_username(p_new_username text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.change_username(p_new_username text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.change_username(p_new_username text) TO authenticated;
GRANT ALL ON FUNCTION public.change_username(p_new_username text) TO service_role;


--
-- Name: FUNCTION claim_deletion_request(p_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_deletion_request(p_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_deletion_request(p_id uuid) TO service_role;


--
-- Name: FUNCTION complete_deletion_request(p_id uuid, p_deleted_fields jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.complete_deletion_request(p_id uuid, p_deleted_fields jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.complete_deletion_request(p_id uuid, p_deleted_fields jsonb) TO service_role;


--
-- Name: FUNCTION complete_onboarding(p_display_name text, p_preferred_language text, p_username text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.complete_onboarding(p_display_name text, p_preferred_language text, p_username text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.complete_onboarding(p_display_name text, p_preferred_language text, p_username text) TO authenticated;
GRANT ALL ON FUNCTION public.complete_onboarding(p_display_name text, p_preferred_language text, p_username text) TO service_role;


--
-- Name: FUNCTION create_conversation(p_kind text, p_member_ids uuid[], p_title text, p_context_type text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_conversation(p_kind text, p_member_ids uuid[], p_title text, p_context_type text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_conversation(p_kind text, p_member_ids uuid[], p_title text, p_context_type text) TO authenticated;
GRANT ALL ON FUNCTION public.create_conversation(p_kind text, p_member_ids uuid[], p_title text, p_context_type text) TO service_role;


--
-- Name: FUNCTION create_invite(p_kind text, p_max_uses integer, p_expires_at timestamp with time zone, p_target_conversation_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_invite(p_kind text, p_max_uses integer, p_expires_at timestamp with time zone, p_target_conversation_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_invite(p_kind text, p_max_uses integer, p_expires_at timestamp with time zone, p_target_conversation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.create_invite(p_kind text, p_max_uses integer, p_expires_at timestamp with time zone, p_target_conversation_id uuid) TO service_role;


--
-- Name: FUNCTION find_account_by_email(p_email text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.find_account_by_email(p_email text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.find_account_by_email(p_email text) TO authenticated;
GRANT ALL ON FUNCTION public.find_account_by_email(p_email text) TO service_role;


--
-- Name: FUNCTION handle_new_user(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.handle_new_user() TO anon;
GRANT ALL ON FUNCTION public.handle_new_user() TO authenticated;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;


--
-- Name: FUNCTION is_active_member(p_conversation_id uuid, p_account_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.is_active_member(p_conversation_id uuid, p_account_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_active_member(p_conversation_id uuid, p_account_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_active_member(p_conversation_id uuid, p_account_id uuid) TO service_role;


--
-- Name: FUNCTION leave_conversation(p_conversation_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.leave_conversation(p_conversation_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.leave_conversation(p_conversation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.leave_conversation(p_conversation_id uuid) TO service_role;


--
-- Name: FUNCTION list_abandoned_pending_accounts(p_max_age interval); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.list_abandoned_pending_accounts(p_max_age interval) FROM PUBLIC;
GRANT ALL ON FUNCTION public.list_abandoned_pending_accounts(p_max_age interval) TO service_role;


--
-- Name: FUNCTION list_due_deletion_requests(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.list_due_deletion_requests() FROM PUBLIC;
GRANT ALL ON FUNCTION public.list_due_deletion_requests() TO service_role;


--
-- Name: FUNCTION record_abandoned_email_hash(p_tenant_id uuid, p_email_hash_hex text, p_key_version smallint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_abandoned_email_hash(p_tenant_id uuid, p_email_hash_hex text, p_key_version smallint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_abandoned_email_hash(p_tenant_id uuid, p_email_hash_hex text, p_key_version smallint) TO service_role;


--
-- Name: FUNCTION redeem_invite(p_token text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.redeem_invite(p_token text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.redeem_invite(p_token text) TO authenticated;
GRANT ALL ON FUNCTION public.redeem_invite(p_token text) TO service_role;


--
-- Name: FUNCTION report_account(p_target uuid, p_reason text, p_details text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.report_account(p_target uuid, p_reason text, p_details text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.report_account(p_target uuid, p_reason text, p_details text) TO authenticated;
GRANT ALL ON FUNCTION public.report_account(p_target uuid, p_reason text, p_details text) TO service_role;


--
-- Name: TABLE data_deletion_requests; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.data_deletion_requests TO authenticated;
GRANT ALL ON TABLE public.data_deletion_requests TO service_role;
GRANT SELECT ON TABLE public.data_deletion_requests TO hermes_readonly;


--
-- Name: FUNCTION request_account_deletion(p_grace interval); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.request_account_deletion(p_grace interval) FROM PUBLIC;
GRANT ALL ON FUNCTION public.request_account_deletion(p_grace interval) TO authenticated;
GRANT ALL ON FUNCTION public.request_account_deletion(p_grace interval) TO service_role;


--
-- Name: FUNCTION request_contact(p_target uuid, p_via text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.request_contact(p_target uuid, p_via text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.request_contact(p_target uuid, p_via text) TO authenticated;
GRANT ALL ON FUNCTION public.request_contact(p_target uuid, p_via text) TO service_role;


--
-- Name: FUNCTION respond_to_contact(p_other uuid, p_accept boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.respond_to_contact(p_other uuid, p_accept boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.respond_to_contact(p_other uuid, p_accept boolean) TO authenticated;
GRANT ALL ON FUNCTION public.respond_to_contact(p_other uuid, p_accept boolean) TO service_role;


--
-- Name: FUNCTION revoke_invite(p_invite_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.revoke_invite(p_invite_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.revoke_invite(p_invite_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.revoke_invite(p_invite_id uuid) TO service_role;


--
-- Name: FUNCTION search_accounts_by_username(p_prefix text, p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.search_accounts_by_username(p_prefix text, p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.search_accounts_by_username(p_prefix text, p_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.search_accounts_by_username(p_prefix text, p_limit integer) TO service_role;


--
-- Name: FUNCTION set_conversation_context_type(p_conversation_id uuid, p_context_type text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_conversation_context_type(p_conversation_id uuid, p_context_type text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_conversation_context_type(p_conversation_id uuid, p_context_type text) TO authenticated;
GRANT ALL ON FUNCTION public.set_conversation_context_type(p_conversation_id uuid, p_context_type text) TO service_role;


--
-- Name: FUNCTION set_conversation_title(p_conversation_id uuid, p_title text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_conversation_title(p_conversation_id uuid, p_title text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_conversation_title(p_conversation_id uuid, p_title text) TO authenticated;
GRANT ALL ON FUNCTION public.set_conversation_title(p_conversation_id uuid, p_title text) TO service_role;


--
-- Name: FUNCTION set_display_name(p_display_name text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_display_name(p_display_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_display_name(p_display_name text) TO authenticated;
GRANT ALL ON FUNCTION public.set_display_name(p_display_name text) TO service_role;


--
-- Name: FUNCTION set_preferred_language(p_language text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_preferred_language(p_language text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_preferred_language(p_language text) TO authenticated;
GRANT ALL ON FUNCTION public.set_preferred_language(p_language text) TO service_role;


--
-- Name: FUNCTION unblock_account(p_target uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.unblock_account(p_target uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.unblock_account(p_target uuid) TO authenticated;
GRANT ALL ON FUNCTION public.unblock_account(p_target uuid) TO service_role;


--
-- Name: TABLE account_identifiers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.account_identifiers TO anon;
GRANT ALL ON TABLE public.account_identifiers TO authenticated;
GRANT ALL ON TABLE public.account_identifiers TO service_role;
GRANT SELECT ON TABLE public.account_identifiers TO hermes_readonly;


--
-- Name: TABLE account_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.account_settings TO anon;
GRANT ALL ON TABLE public.account_settings TO authenticated;
GRANT ALL ON TABLE public.account_settings TO service_role;
GRANT SELECT ON TABLE public.account_settings TO hermes_readonly;


--
-- Name: TABLE agent_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.agent_events TO anon;
GRANT ALL ON TABLE public.agent_events TO authenticated;
GRANT ALL ON TABLE public.agent_events TO service_role;
GRANT SELECT ON TABLE public.agent_events TO hermes_readonly;
GRANT INSERT ON TABLE public.agent_events TO hermes_writer;


--
-- Name: TABLE blocks; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.blocks TO anon;
GRANT ALL ON TABLE public.blocks TO authenticated;
GRANT ALL ON TABLE public.blocks TO service_role;
GRANT SELECT ON TABLE public.blocks TO hermes_readonly;


--
-- Name: TABLE conversation_contexts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.conversation_contexts TO anon;
GRANT ALL ON TABLE public.conversation_contexts TO authenticated;
GRANT ALL ON TABLE public.conversation_contexts TO service_role;
GRANT SELECT ON TABLE public.conversation_contexts TO hermes_readonly;


--
-- Name: TABLE conversation_members; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.conversation_members TO anon;
GRANT ALL ON TABLE public.conversation_members TO authenticated;
GRANT ALL ON TABLE public.conversation_members TO service_role;
GRANT SELECT ON TABLE public.conversation_members TO hermes_readonly;


--
-- Name: TABLE conversations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.conversations TO anon;
GRANT ALL ON TABLE public.conversations TO authenticated;
GRANT ALL ON TABLE public.conversations TO service_role;
GRANT SELECT ON TABLE public.conversations TO hermes_readonly;


--
-- Name: TABLE email_hash_abuse; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.email_hash_abuse TO service_role;
GRANT SELECT ON TABLE public.email_hash_abuse TO hermes_readonly;


--
-- Name: TABLE invite_redemptions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.invite_redemptions TO anon;
GRANT ALL ON TABLE public.invite_redemptions TO authenticated;
GRANT ALL ON TABLE public.invite_redemptions TO service_role;
GRANT SELECT ON TABLE public.invite_redemptions TO hermes_readonly;


--
-- Name: TABLE invites; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.invites TO anon;
GRANT ALL ON TABLE public.invites TO authenticated;
GRANT ALL ON TABLE public.invites TO service_role;
GRANT SELECT ON TABLE public.invites TO hermes_readonly;


--
-- Name: TABLE message_translations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.message_translations TO anon;
GRANT ALL ON TABLE public.message_translations TO authenticated;
GRANT ALL ON TABLE public.message_translations TO service_role;
GRANT SELECT ON TABLE public.message_translations TO hermes_readonly;


--
-- Name: TABLE messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.messages TO anon;
GRANT ALL ON TABLE public.messages TO authenticated;
GRANT ALL ON TABLE public.messages TO service_role;
GRANT SELECT ON TABLE public.messages TO hermes_readonly;


--
-- Name: COLUMN messages.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id) ON TABLE public.messages TO profile_writer;


--
-- Name: COLUMN messages.sender_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(sender_id) ON TABLE public.messages TO profile_writer;


--
-- Name: COLUMN messages.source_language; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(source_language) ON TABLE public.messages TO profile_writer;


--
-- Name: COLUMN messages.tenant_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(tenant_id) ON TABLE public.messages TO profile_writer;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.profiles TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;
GRANT SELECT ON TABLE public.profiles TO hermes_readonly;


--
-- Name: COLUMN profiles.display_name; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(display_name) ON TABLE public.profiles TO authenticated;


--
-- Name: TABLE relationships; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.relationships TO anon;
GRANT ALL ON TABLE public.relationships TO authenticated;
GRANT ALL ON TABLE public.relationships TO service_role;
GRANT SELECT ON TABLE public.relationships TO hermes_readonly;


--
-- Name: TABLE reports; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.reports TO anon;
GRANT ALL ON TABLE public.reports TO authenticated;
GRANT ALL ON TABLE public.reports TO service_role;
GRANT SELECT ON TABLE public.reports TO hermes_readonly;


--
-- Name: TABLE tenants; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.tenants TO anon;
GRANT ALL ON TABLE public.tenants TO authenticated;
GRANT ALL ON TABLE public.tenants TO service_role;
GRANT SELECT ON TABLE public.tenants TO hermes_readonly;


--
-- Name: TABLE translation_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.translation_events TO anon;
GRANT ALL ON TABLE public.translation_events TO authenticated;
GRANT ALL ON TABLE public.translation_events TO service_role;
GRANT SELECT ON TABLE public.translation_events TO hermes_readonly;
GRANT INSERT ON TABLE public.translation_events TO hermes_writer;


--
-- Name: TABLE user_linguistic_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_linguistic_profiles TO anon;
GRANT ALL ON TABLE public.user_linguistic_profiles TO authenticated;
GRANT ALL ON TABLE public.user_linguistic_profiles TO service_role;
GRANT SELECT ON TABLE public.user_linguistic_profiles TO hermes_readonly;
GRANT SELECT ON TABLE public.user_linguistic_profiles TO profile_writer;


--
-- Name: COLUMN user_linguistic_profiles.dialect_region; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(dialect_region) ON TABLE public.user_linguistic_profiles TO profile_writer;


--
-- Name: COLUMN user_linguistic_profiles.dialect_confidence; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(dialect_confidence) ON TABLE public.user_linguistic_profiles TO profile_writer;


--
-- Name: COLUMN user_linguistic_profiles.dialect_source; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(dialect_source) ON TABLE public.user_linguistic_profiles TO profile_writer;


--
-- Name: COLUMN user_linguistic_profiles.formality_preference; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(formality_preference) ON TABLE public.user_linguistic_profiles TO profile_writer;


--
-- Name: COLUMN user_linguistic_profiles.formality_source; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(formality_source) ON TABLE public.user_linguistic_profiles TO profile_writer;


--
-- Name: COLUMN user_linguistic_profiles.gender_signal; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(gender_signal) ON TABLE public.user_linguistic_profiles TO profile_writer;


--
-- Name: COLUMN user_linguistic_profiles.gender_source; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(gender_source) ON TABLE public.user_linguistic_profiles TO profile_writer;


--
-- Name: COLUMN user_linguistic_profiles.updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE public.user_linguistic_profiles TO profile_writer;


--
-- Name: TABLE user_profile_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_profile_events TO anon;
GRANT ALL ON TABLE public.user_profile_events TO authenticated;
GRANT ALL ON TABLE public.user_profile_events TO service_role;
GRANT SELECT ON TABLE public.user_profile_events TO hermes_readonly;


--
-- Name: COLUMN user_profile_events.user_id; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(user_id) ON TABLE public.user_profile_events TO profile_writer;


--
-- Name: COLUMN user_profile_events.tenant_id; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(tenant_id) ON TABLE public.user_profile_events TO profile_writer;


--
-- Name: COLUMN user_profile_events.event_type; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(event_type) ON TABLE public.user_profile_events TO profile_writer;


--
-- Name: COLUMN user_profile_events.previous_value; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(previous_value) ON TABLE public.user_profile_events TO profile_writer;


--
-- Name: COLUMN user_profile_events.new_value; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(new_value) ON TABLE public.user_profile_events TO profile_writer;


--
-- Name: COLUMN user_profile_events.source; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(source) ON TABLE public.user_profile_events TO profile_writer;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO hermes_readonly;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--

\unrestrict X8D8B7RaZPD72UiZGYpKonEITQVmANgNHp6KnIHPb2QJlvR0MINgSRKW2aQRUOj

