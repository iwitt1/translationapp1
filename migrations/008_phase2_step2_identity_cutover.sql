-- Migration 008 — Phase 2 Step 2: Identity cutover + onboarding RPC + message RLS
-- Date: 2026-06-10
-- Phase: 2 (Multi-user safety — Step 2)
--
-- What this migration does:
--   1. DROP user_profiles            — replaced by profiles (migration 007)
--   2. RECREATE user_linguistic_profiles — user_id promoted text → uuid (FK to profiles)
--   3. RECREATE user_profile_events  — user_id promoted text → uuid (FK to profiles)
--   4. ALTER messages.sender_id      — text → uuid, FK → auth.users ON DELETE SET NULL
--   5. RLS on messages               — SELECT same tenant; INSERT own sender_id + tenant
--   6. RLS on message_translations   — SELECT/INSERT/UPDATE same tenant
--   7. complete_onboarding()         — SECURITY DEFINER RPC: P1 → P3 transition
--
-- Why this is a coordinated breaking cutover:
--   The old frontend stored sender_id as a plain text username string; the new frontend
--   stores auth.users.id (uuid). RLS on messages enforces sender_id = auth.uid() on INSERT.
--   This migration and the new App.jsx must ship together: once this migration runs, the
--   old frontend can no longer insert messages (sender_id text won't cast to uuid).
--   Staging is wiped at Phase 2 start — no data migration needed.
--
-- NOT changed in this migration:
--   conversation_contexts.participant_ids  — still text[]; updated when conversations built
--   profiles                               — unchanged (migration 007)
--   account_identifiers, account_settings  — unchanged (migration 007)
--
-- Migration workflow (operations.md §3):
--   Run on STAGING → verify Step 2 gate (verification.md) → app changes → smoke test
--   → only then replay on PROD.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Drop user_profiles (replaced by profiles from migration 007)
-- ═════════════════════════════════════════════════════════════════════════════
-- CASCADE drops any FK references pointing at user_profiles. There are none in
-- the Phase 1 schema (user_linguistic_profiles.user_id was text, no FK), but
-- CASCADE is defensive in case future migrations introduced any.

DROP TABLE IF EXISTS public.user_profiles CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Recreate user_linguistic_profiles with uuid user_id
-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 1 had user_id text (the username string). Now user_id is uuid,
-- referencing profiles.id (= auth.users.id). ON DELETE CASCADE: deleting a
-- profile wipes the linguistic profile (consistent with Step 7 anonymization).
--
-- preferred_language has no explicit _source column — being set during onboarding
-- is implicitly "explicit". The dialect/formality/gender _source columns track
-- inference vs explicit for those inferred fields only.
--
-- No INSERT policy for authenticated users: the row is created exclusively by
-- complete_onboarding() (SECURITY DEFINER). Subsequent inference updates go
-- through UPDATE own row (allowed by policy). This enforces the onboarding gate.
--
-- RLS:
--   SELECT  — same-tenant authenticated users (needed for translation context injection:
--             MessageBubble reads the SENDER's linguistic profile to build context for the
--             translate API call. Restricting to own-row-only would break this.)
--   UPDATE  — own row only (user_id = auth.uid())
--   INSERT  — no policy (SECURITY DEFINER only via complete_onboarding)
--   DELETE  — no policy (cascades from profiles deletion)

DROP TABLE IF EXISTS public.user_linguistic_profiles;

CREATE TABLE public.user_linguistic_profiles (
  user_id              uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tenant_id            uuid        NOT NULL REFERENCES public.tenants(id),

  preferred_language   text,                        -- e.g. "es"; set explicitly at onboarding

  dialect_region       text,                        -- e.g. "es-AR", "pt-BR"
  dialect_confidence   float       DEFAULT 0.0,     -- 0.0–1.0
  dialect_source       text        DEFAULT 'inferred'
    CONSTRAINT ulp_dialect_source_check
      CHECK (dialect_source IN ('explicit', 'inferred')),

  formality_preference text
    CONSTRAINT ulp_formality_check
      CHECK (formality_preference IN ('formal', 'neutral', 'casual')),
  formality_source     text        DEFAULT 'inferred'
    CONSTRAINT ulp_formality_source_check
      CHECK (formality_source IN ('explicit', 'inferred')),

  gender_signal        text
    CONSTRAINT ulp_gender_check
      CHECK (gender_signal IN ('masculine', 'feminine', 'neutral', 'unknown')),
  gender_source        text        DEFAULT 'inferred'
    CONSTRAINT ulp_gender_source_check
      CHECK (gender_source IN ('explicit', 'inferred')),

  script_preference    text,                        -- e.g. "latin", "traditional", "simplified"
  script_source        text        DEFAULT 'inferred'
    CONSTRAINT ulp_script_source_check
      CHECK (script_source IN ('explicit', 'inferred')),

  known_languages      text[],                      -- e.g. '{"es","en"}'

  updated_at           timestamptz DEFAULT now(),

  PRIMARY KEY (user_id, tenant_id)
);

ALTER TABLE public.user_linguistic_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ulp_select_same_tenant" ON public.user_linguistic_profiles;
CREATE POLICY "ulp_select_same_tenant" ON public.user_linguistic_profiles
  FOR SELECT TO authenticated
  USING (tenant_id = public.auth_tenant_id());

DROP POLICY IF EXISTS "ulp_update_own" ON public.user_linguistic_profiles;
CREATE POLICY "ulp_update_own" ON public.user_linguistic_profiles
  FOR UPDATE TO authenticated
  USING  (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND tenant_id = public.auth_tenant_id());


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Recreate user_profile_events with uuid user_id
-- ═════════════════════════════════════════════════════════════════════════════
-- Append-only event log. Phase 1 had user_id text. Now uuid FK to profiles.
-- ON DELETE CASCADE: deleting a profile cascades to event rows (anonymization
-- in Step 7 sets user_id to NULL before triggering cascade — revisit then).
--
-- NOTE: applyInferences() in the client writes events for the sender's profile.
-- With RLS (INSERT requires user_id = auth.uid()), this only succeeds when the
-- INSERT is for the authenticated user's own row. Since MessageBubble skips
-- translation for the sender's own messages (isSender check), applyInferences
-- is only called for OTHER users' messages — so the INSERT will be blocked by
-- RLS and fail silently. This is expected; the inference pipeline moves
-- server-side in the "server-side profile inference" workstream (parking-lot.md).
--
-- RLS:
--   SELECT  — own rows only (event log is private)
--   INSERT  — own rows only (user_id = auth.uid())
--   UPDATE/DELETE — no policies (append-only; hard deletes are admin-only)

DROP TABLE IF EXISTS public.user_profile_events;

CREATE TABLE public.user_profile_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tenant_id       uuid        NOT NULL REFERENCES public.tenants(id),

  event_type      text        NOT NULL,             -- e.g. "dialect_region_inferred"
  previous_value  jsonb,
  new_value       jsonb,

  source          text        NOT NULL
    CONSTRAINT upe_source_check
      CHECK (source IN ('explicit', 'inference', 'correction_analysis')),

  -- task_id from migration 006 (Hermes agent task that caused the event)
  task_id         text,

  created_at      timestamptz DEFAULT now()
);

ALTER TABLE public.user_profile_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "upe_select_own" ON public.user_profile_events;
CREATE POLICY "upe_select_own" ON public.user_profile_events
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "upe_insert_own" ON public.user_profile_events;
CREATE POLICY "upe_insert_own" ON public.user_profile_events
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND tenant_id = public.auth_tenant_id());


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. ALTER messages.sender_id: text → uuid + FK to auth.users
-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 1: sender_id was text (plain username string).
-- Phase 2: sender_id is uuid matching auth.users.id.
-- ON DELETE SET NULL: when a user hard-deletes their account (Step 7), their
-- messages become "deleted user" rows — content and translation pairs are
-- retained per the data-deletion spec ("strip user_id/PII, keep translation pairs").
--
-- Staging is wiped (no rows exist), so the TYPE change is safe. USING NULL::uuid
-- converts all existing values to NULL — there are none, this is defensive.

ALTER TABLE public.messages
  ALTER COLUMN sender_id TYPE uuid USING NULL::uuid;

ALTER TABLE public.messages
  ADD CONSTRAINT messages_sender_id_fk
    FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE SET NULL;


-- ═════════════════════════════════════════════════════════════════════════════
-- 5. RLS on messages
-- ═════════════════════════════════════════════════════════════════════════════
-- The chat room is shared within a tenant: all tenant members can read all
-- messages in their tenant. Inserts must come from the authenticated sender.
-- No UPDATE/DELETE for users — messages are immutable once sent.
--
-- Note: message_translations.tenant_id was added by migration 001. The tenant_id
-- column on messages was also added by migration 001.

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "messages_select_same_tenant" ON public.messages;
CREATE POLICY "messages_select_same_tenant" ON public.messages
  FOR SELECT TO authenticated
  USING (tenant_id = public.auth_tenant_id());

DROP POLICY IF EXISTS "messages_insert_own" ON public.messages;
CREATE POLICY "messages_insert_own" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND tenant_id = public.auth_tenant_id()
  );

-- No UPDATE or DELETE policies → denied for authenticated users.


-- ═════════════════════════════════════════════════════════════════════════════
-- 6. RLS on message_translations
-- ═════════════════════════════════════════════════════════════════════════════
-- Translation cache is tenant-scoped (tied to tenant's messages). Any authenticated
-- user in the tenant can read and write the cache. Upsert with onConflict issues
-- an INSERT ... ON CONFLICT DO UPDATE — both the INSERT and UPDATE policies must
-- pass. We use tenant_id = auth_tenant_id() for both.
--
-- No DELETE policy: cache entries are never deleted by users. Orphaned entries
-- (when a message is deleted) are handled by the message FK cascade in message_translations.

ALTER TABLE public.message_translations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mt_select_same_tenant" ON public.message_translations;
CREATE POLICY "mt_select_same_tenant" ON public.message_translations
  FOR SELECT TO authenticated
  USING (tenant_id = public.auth_tenant_id());

DROP POLICY IF EXISTS "mt_insert_same_tenant" ON public.message_translations;
CREATE POLICY "mt_insert_same_tenant" ON public.message_translations
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = public.auth_tenant_id());

DROP POLICY IF EXISTS "mt_update_same_tenant" ON public.message_translations;
CREATE POLICY "mt_update_same_tenant" ON public.message_translations
  FOR UPDATE TO authenticated
  USING  (tenant_id = public.auth_tenant_id())
  WITH CHECK (tenant_id = public.auth_tenant_id());


-- ═════════════════════════════════════════════════════════════════════════════
-- 7. complete_onboarding() — SECURITY DEFINER RPC for P1 → P3 status transition
-- ═════════════════════════════════════════════════════════════════════════════
-- Called by the frontend after the user submits their display name + language.
-- Must be SECURITY DEFINER because:
--   (a) it writes profiles.status, which authenticated users cannot UPDATE directly
--       (column grant restricts them to display_name only — see migration 007 [OPUS-FIX #2])
--   (b) it INSERTs into user_linguistic_profiles, which has no INSERT policy for
--       authenticated users (row created here and only here).
--
-- Idempotent: calling it on an already-active account is a no-op (the guard
-- returns early). This is safe and covers the edge case where the magic link
-- is clicked twice.
--
-- Validation:
--   - display_name: 1–50 chars after trimming, per policies.md §1
--   - preferred_language: must be a non-empty string (BCP 47 code like 'en', 'es')
--     The LANGUAGES list in the frontend is the UI-layer allowlist; the DB stores
--     whatever code the RPC receives. Extend to a CHECK constraint if needed later.
--
-- Exposed via PostgREST as: supabase.rpc('complete_onboarding', { p_display_name, p_preferred_language })

CREATE OR REPLACE FUNCTION public.complete_onboarding(
  p_display_name       text,
  p_preferred_language text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
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

  -- Validate preferred_language (non-empty)
  IF p_preferred_language IS NULL OR length(trim(p_preferred_language)) = 0 THEN
    RAISE EXCEPTION 'complete_onboarding: preferred_language is required';
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

COMMENT ON FUNCTION public.complete_onboarding(text, text) IS
  'P1 → P3 status transition. Updates profiles.status to active, sets display_name and '
  'onboarding_completed_at, and creates the user_linguistic_profiles row with the chosen language. '
  'SECURITY DEFINER — bypasses column grant restriction on profiles.status. '
  'Idempotent: no-op if user is already active. '
  'Called by the frontend onboarding screen after magic-link sign-in.';

-- Grant EXECUTE to the authenticated role so PostgREST exposes it via supabase.rpc()
GRANT EXECUTE ON FUNCTION public.complete_onboarding(text, text) TO authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- Verification queries (run after migration, before calling Step 2 gate passed)
-- Full checklist in verification.md "Phase 2 — Step 2"
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. user_profiles is gone
--    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'user_profiles';
--    Expect: 0 rows

-- 2. user_linguistic_profiles.user_id is now uuid
--    SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'user_linguistic_profiles'
--      AND column_name = 'user_id';
--    Expect: data_type = 'uuid'

-- 3. user_profile_events.user_id is now uuid
--    SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'user_profile_events'
--      AND column_name = 'user_id';
--    Expect: data_type = 'uuid'

-- 4. messages.sender_id is now uuid with FK
--    SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'messages'
--      AND column_name = 'sender_id';
--    Expect: data_type = 'uuid'
--
--    SELECT constraint_name FROM information_schema.table_constraints
--    WHERE table_schema = 'public' AND table_name = 'messages'
--      AND constraint_type = 'FOREIGN KEY';
--    Expect: messages_sender_id_fk present

-- 5. RLS enabled on messages and message_translations
--    SELECT relname, relrowsecurity FROM pg_class
--    WHERE relnamespace = 'public'::regnamespace
--      AND relname IN ('messages', 'message_translations')
--      AND relkind = 'r';
--    Expect: relrowsecurity = true for both

-- 6. complete_onboarding() function exists and is executable
--    SELECT routine_name FROM information_schema.routines
--    WHERE routine_schema = 'public' AND routine_name = 'complete_onboarding';
--    Expect: 1 row

-- 7. Trigger smoke test — full signup → onboarding → active flow (see verification.md Step 2)
