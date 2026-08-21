-- ════════════════════════════════════════════════════════════════════════════════
-- Migration 025 — Phase 4 (build-now): corrections capture
-- ════════════════════════════════════════════════════════════════════════════════
-- Purpose: stand up the corrections corpus — the data flywheel behind the Phase 2 (B2B
-- API) moat. This migration ships the CAPTURE half only: the two tables + RLS + the
-- server-authoritative write RPCs + the deletion-anonymization hook. The CONSUMPTION
-- half (weekly clustering, few-shot retrieval into live translation, ai_audit reviews,
-- spam/quality filtering) is deliberately DEFERRED until there's corpus volume
-- (roadmap Phase 4 "deferred activation"; parking-lot.md).
--
-- WHY a write RPC and not a client INSERT (decisions.md 2026-07-28):
--   A correction's value is its CONTEXT, and the highest-value / most-spoofable field
--   (corrector_known_languages — the bilingual-weight signal) must be assembled from
--   AUTHORITATIVE server reads, never asserted by the client. So both tables are RLS
--   SELECT-own / no client write policy, and the SECURITY DEFINER RPCs below are the sole
--   write path (same shape as the Phase 2 social-graph RPCs / server-side inference).
--
-- WHAT THE SNAPSHOT CAPTURES (and why — architecture.md §7):
--   The row is self-contained and REPLAYABLE. We copy (not reference) every field that
--   drifts, because the referenced rows mutate or vanish:
--     * model_output      ← message_translations.translated_text  (cache is upsertable)
--     * prompt_version    ← message_translations.prompt_version   (reproducibility anchor)
--     * register_context  ← conversation_contexts                 (updates every N msgs)
--     * conversation_history ← the N prior messages actually available as context
--                                                                  (messages get deleted)
--     * corrector_known_languages ← user_linguistic_profiles      (profile changes)
--   message_id/target_language are RETAINED as the anchor (cheap join + audit), but they
--   are NOT the source of truth — the snapshot is.
--
-- KNOWN GAP handled honestly (decisions.md 2026-07-28 + parking-lot.md):
--   message_translations stores prompt_version but NOT model; translation_events has
--   model_used but no message_id, so a translation's MODEL is not per-message
--   reconstructable from the DB today. → prompt_version is the reproducibility anchor;
--   `model` is a best-effort/nullable column (left NULL by the RPC). The follow-up
--   (add message_translations.model on the translate write path) is parked.
--
-- OWNERSHIP = provenance (tenant_id) vs. reach (ownership) (decisions.md 2026-07-28):
--   Every row keeps tenant_id (who it came from). `ownership` (platform|tenant|shared)
--   governs whether its LEARNING may flow to the global pool. The sole consumer tenant
--   defaults to `platform`, so its flywheel is global from day one; a future B2B tenant
--   can silo with `tenant`. The pool is a LOGICAL VIEW over ownership IN
--   ('platform','shared') AND tenants.training_data_agreement — not a separate table.
--   pool_status is the pre-built seam for the future spam/quality filter (unreviewed →
--   accepted/rejected/spam), so filtering lands with no migration.
--
-- ALTER-over-recreate: both tables are NET-NEW (CREATE). No existing table is recreated.
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, CREATE OR REPLACE, DROP POLICY IF EXISTS.
-- Staging first; prod replay is a normal deploy (additive — safe on populated tables).
-- Ref: architecture.md §7/§10 · roadmap.md Phase 4 · decisions.md 2026-07-28
-- ════════════════════════════════════════════════════════════════════════════════

begin;

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. translation_corrections — append-only corrections corpus
-- ═════════════════════════════════════════════════════════════════════════════
-- One row per submitted correction. APPEND-ONLY (architecture.md principle #8): never
-- mutated after insert, except the deletion-anonymization hook (nulls the corrector's
-- PII while keeping the translation pair). The canonical translation is NEVER overwritten
-- by corrected_text — corrected_text is stored feedback, the UI keeps showing model_output
-- (decisions.md 2026-07-28 "corrections never override the canonical rendering").
CREATE TABLE IF NOT EXISTS public.translation_corrections (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid        NOT NULL REFERENCES public.tenants(id),

  -- Anchor (retained for join/audit; NOT the source of truth — the snapshot is).
  -- SET NULL so a correction survives the corrected message being deleted/GC'd.
  message_id               uuid        REFERENCES public.messages(id) ON DELETE SET NULL,
  target_language          text        NOT NULL,   -- language of the translation corrected

  -- The triple (all snapshots).
  original_text            text,                    -- source message text at correction time
  model_output             text,                    -- the translation we produced (canonical)
  corrected_text           text        NOT NULL,    -- the user's fix (stored, never displayed as canonical)

  -- Reproducibility snapshots.
  source_language          text,
  dialect_region           text,                    -- corrector's dialect at correction time
  prompt_version           text,                    -- from message_translations — staleness anchor
  model                    text,                    -- best-effort; NULL today (see header "KNOWN GAP")
  register_context         jsonb,                   -- conversation_contexts snapshot
  conversation_history     jsonb,                   -- the N prior messages actually in context
  context_snapshot         jsonb,                   -- full assembled context object, if the client passes it

  -- Provenance + weight.
  correction_source        text        NOT NULL DEFAULT 'user_edit'
    CONSTRAINT translation_corrections_source_check
      CHECK (correction_source IN ('user_edit','thumbs_down','bilingual_review','ai_audit')),
  corrector_user_id        uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  corrector_known_languages text[],                 -- THE bilingual-weight signal (snapshot)

  -- Governance.
  ownership                text        NOT NULL DEFAULT 'platform'
    CONSTRAINT translation_corrections_ownership_check
      CHECK (ownership IN ('platform','tenant','shared')),
  pool_status              text        NOT NULL DEFAULT 'unreviewed'
    CONSTRAINT translation_corrections_pool_status_check
      CHECK (pool_status IN ('unreviewed','accepted','rejected','spam')),

  created_at               timestamptz NOT NULL DEFAULT now()
);

-- Retrieval / clustering indexes for the future pool query (pair + dialect + reach).
CREATE INDEX IF NOT EXISTS translation_corrections_pool_idx
  ON public.translation_corrections (tenant_id, source_language, target_language, ownership, pool_status);
CREATE INDEX IF NOT EXISTS translation_corrections_corrector_idx
  ON public.translation_corrections (corrector_user_id);
CREATE INDEX IF NOT EXISTS translation_corrections_message_idx
  ON public.translation_corrections (message_id, target_language);

COMMENT ON TABLE public.translation_corrections IS
  'Append-only corrections corpus (Phase 4). Server-RPC-written, self-contained snapshot. '
  'tenant_id = provenance; ownership = reach (platform poolable). Canonical translation is '
  'never overwritten by corrected_text. architecture.md §7; decisions.md 2026-07-28.';

-- ── RLS: SELECT own, writes RPC-only ──────────────────────────────────────────
-- A user may read their OWN submitted corrections (to render the "you suggested a
-- correction" marker) but never write directly. Service role bypasses RLS (deletion sweep).
ALTER TABLE public.translation_corrections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tc_select_own" ON public.translation_corrections;
CREATE POLICY "tc_select_own" ON public.translation_corrections
  FOR SELECT TO authenticated
  USING (corrector_user_id = auth.uid() AND tenant_id = public.auth_tenant_id());

REVOKE INSERT, UPDATE, DELETE ON public.translation_corrections FROM anon, authenticated;
REVOKE ALL ON public.translation_corrections FROM anon;
GRANT  SELECT ON public.translation_corrections TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 2. translation_reviews — quality signal (good/bad now; ai_audit later)
-- ═════════════════════════════════════════════════════════════════════════════
-- Lower-signal quality judgments. User "good/bad translation" writes here (the high-signal
-- inline EDIT writes to translation_corrections). ai_audit / human-review writers are
-- DEFERRED (consumption phase). DEVIATION from architecture.md §7's sketch (recorded in
-- decisions.md 2026-07-28): anchored on message_id + target_language (the client's unit),
-- NOT translation_events.id — the client never sees an event id, and translation_events
-- has no message_id. Upsertable (one review per person per translation; toggles on/off).
CREATE TABLE IF NOT EXISTS public.translation_reviews (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid        NOT NULL REFERENCES public.tenants(id),

  message_id               uuid        REFERENCES public.messages(id) ON DELETE SET NULL,
  target_language          text        NOT NULL,

  reviewer_id              uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewer_type            text        NOT NULL DEFAULT 'user'
    CONSTRAINT translation_reviews_reviewer_type_check
      CHECK (reviewer_type IN ('user','human','bilingual_user','ai_audit')),
  reviewer_known_languages text[],                  -- snapshot (bilingual weight, derived later)

  rating                   text
    CONSTRAINT translation_reviews_rating_check
      CHECK (rating IN ('good','bad')),             -- the user good/bad signal
  quality_score            double precision,        -- nullable; 0..1 for future ai_audit
  flags                    text[],                  -- nullable; e.g. {register_mismatch}
  suggested_fix            text,                    -- nullable

  prompt_version           text,
  model                    text,                    -- best-effort; NULL today (see 025 header)
  created_at               timestamptz NOT NULL DEFAULT now()
);

-- One active review per (message, language, reviewer) → upsert toggles good/bad/off.
CREATE UNIQUE INDEX IF NOT EXISTS translation_reviews_one_per_reviewer
  ON public.translation_reviews (message_id, target_language, reviewer_id)
  WHERE reviewer_id IS NOT NULL;

COMMENT ON TABLE public.translation_reviews IS
  'Translation quality signals (Phase 4). User good/bad now (reviewer_type=user); '
  'ai_audit/human deferred. Anchored on message_id+target_language, not translation_events. '
  'architecture.md §7; decisions.md 2026-07-28.';

ALTER TABLE public.translation_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tr_select_own" ON public.translation_reviews;
CREATE POLICY "tr_select_own" ON public.translation_reviews
  FOR SELECT TO authenticated
  USING (reviewer_id = auth.uid() AND tenant_id = public.auth_tenant_id());

REVOKE INSERT, UPDATE, DELETE ON public.translation_reviews FROM anon, authenticated;
REVOKE ALL ON public.translation_reviews FROM anon;
GRANT  SELECT ON public.translation_reviews TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 3. record_correction(...) — user RPC (assemble snapshot server-side, append)
-- ═════════════════════════════════════════════════════════════════════════════
-- Caller-scoped (auth.uid()). Membership-gated: you can only correct a translation of a
-- message in a conversation you're an active member of. Assembles the full snapshot from
-- authoritative reads — the client cannot forge original_text, model_output,
-- corrector_known_languages, register, or history. Append-only (plain INSERT). Optional
-- p_context lets the caller pass the exact assembled context object for a fuller snapshot.
CREATE OR REPLACE FUNCTION public.record_correction(
  p_message_id      uuid,
  p_target_language text,
  p_corrected_text  text,
  p_context         jsonb DEFAULT NULL,
  p_source          text  DEFAULT 'user_edit'
)
RETURNS public.translation_corrections
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_tenant    uuid := public.auth_tenant_id();
  v_conv      uuid;
  v_orig      text;
  v_srclang   text;
  v_created   timestamptz;
  v_output    text;
  v_prompt    text;
  v_known     text[];
  v_dialect   text;
  v_register  jsonb;
  v_history   jsonb;
  v_ownership text;
  v_clean     text;
  v_row       public.translation_corrections;
BEGIN
  IF v_uid IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'record_correction: not authenticated' USING errcode = '28000';
  END IF;

  v_clean := nullif(btrim(coalesce(p_corrected_text, '')), '');
  IF v_clean IS NULL THEN
    RAISE EXCEPTION 'record_correction: corrected_text is empty';
  END IF;
  IF length(v_clean) > 4000 THEN
    RAISE EXCEPTION 'record_correction: corrected_text too long (max 4000)';
  END IF;
  IF p_source NOT IN ('user_edit','thumbs_down','bilingual_review','ai_audit') THEN
    RAISE EXCEPTION 'record_correction: invalid correction_source %', p_source;
  END IF;

  -- The corrected message (tenant-scoped) + membership gate.
  SELECT m.conversation_id, m.original_text, m.source_language, m.created_at
    INTO v_conv, v_orig, v_srclang, v_created
  FROM public.messages m
  WHERE m.id = p_message_id AND m.tenant_id = v_tenant AND m.kind = 'user';
  IF v_conv IS NULL THEN
    RAISE EXCEPTION 'record_correction: message not found in tenant';
  END IF;
  IF NOT public.is_active_member(v_conv, v_uid) THEN
    RAISE EXCEPTION 'record_correction: not a member of the conversation';
  END IF;

  -- The translation being corrected (must exist — you can't correct a non-translation).
  SELECT mt.translated_text, mt.prompt_version
    INTO v_output, v_prompt
  FROM public.message_translations mt
  WHERE mt.message_id = p_message_id AND mt.language = p_target_language;
  IF v_output IS NULL THEN
    RAISE EXCEPTION 'record_correction: no cached translation for (message, %)', p_target_language;
  END IF;

  -- Corrector profile snapshot (bilingual-weight signal + dialect).
  SELECT ulp.known_languages, ulp.dialect_region
    INTO v_known, v_dialect
  FROM public.user_linguistic_profiles ulp
  WHERE ulp.user_id = v_uid AND ulp.tenant_id = v_tenant;

  -- Conversation register snapshot (may be absent → NULL).
  SELECT jsonb_build_object(
           'detected_register',      cc.detected_register,
           'register_confidence',    cc.register_confidence,
           'relationship_closeness', cc.relationship_closeness
         )
    INTO v_register
  FROM public.conversation_contexts cc
  WHERE cc.conversation_id = v_conv;

  -- Frozen history window: the (up to) 3 user messages that preceded this one — what the
  -- model actually had as context. Snapshotted, not re-derived (messages can be deleted).
  SELECT coalesce(jsonb_agg(h ORDER BY h_created), '[]'::jsonb)
    INTO v_history
  FROM (
    SELECT jsonb_build_object(
             'message_id',      m2.id,
             'sender_id',       m2.sender_id,
             'original_text',   m2.original_text,
             'source_language', m2.source_language,
             'created_at',      m2.created_at
           ) AS h,
           m2.created_at AS h_created
    FROM public.messages m2
    WHERE m2.conversation_id = v_conv
      AND m2.kind = 'user'
      AND m2.created_at < v_created
    ORDER BY m2.created_at DESC
    LIMIT 3
  ) sub;

  -- Reach: default from the tenant (sole consumer tenant = 'platform' → globally poolable).
  SELECT coalesce(t.default_correction_ownership, 'platform')
    INTO v_ownership
  FROM public.tenants t WHERE t.id = v_tenant;

  INSERT INTO public.translation_corrections (
    tenant_id, message_id, target_language,
    original_text, model_output, corrected_text,
    source_language, dialect_region, prompt_version, model,
    register_context, conversation_history, context_snapshot,
    correction_source, corrector_user_id, corrector_known_languages,
    ownership
  ) VALUES (
    v_tenant, p_message_id, p_target_language,
    v_orig, v_output, v_clean,
    v_srclang, v_dialect, v_prompt, NULL,
    v_register, v_history, p_context,
    p_source, v_uid, v_known,
    coalesce(v_ownership, 'platform')
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.record_correction(uuid, text, text, jsonb, text) IS
  'Phase 4: append a correction. Membership-gated; assembles the snapshot from authoritative '
  'reads (client cannot forge context). Append-only. decisions.md 2026-07-28.';

REVOKE ALL ON FUNCTION public.record_correction(uuid, text, text, jsonb, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.record_correction(uuid, text, text, jsonb, text) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 4. record_review(...) — user RPC (good/bad; upsert-toggle; NULL clears)
-- ═════════════════════════════════════════════════════════════════════════════
-- Membership-gated. p_rating IN ('good','bad') upserts the caller's review; p_rating NULL
-- clears it (toggle off). Returns the row, or NULL when cleared.
CREATE OR REPLACE FUNCTION public.record_review(
  p_message_id      uuid,
  p_target_language text,
  p_rating          text
)
RETURNS public.translation_reviews
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_tenant  uuid := public.auth_tenant_id();
  v_conv    uuid;
  v_prompt  text;
  v_known   text[];
  v_row     public.translation_reviews;
BEGIN
  IF v_uid IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'record_review: not authenticated' USING errcode = '28000';
  END IF;
  IF p_rating IS NOT NULL AND p_rating NOT IN ('good','bad') THEN
    RAISE EXCEPTION 'record_review: invalid rating %', p_rating;
  END IF;

  SELECT m.conversation_id INTO v_conv
  FROM public.messages m
  WHERE m.id = p_message_id AND m.tenant_id = v_tenant AND m.kind = 'user';
  IF v_conv IS NULL THEN
    RAISE EXCEPTION 'record_review: message not found in tenant';
  END IF;
  IF NOT public.is_active_member(v_conv, v_uid) THEN
    RAISE EXCEPTION 'record_review: not a member of the conversation';
  END IF;

  -- Clear (toggle off).
  IF p_rating IS NULL THEN
    DELETE FROM public.translation_reviews
    WHERE message_id = p_message_id AND target_language = p_target_language AND reviewer_id = v_uid;
    RETURN NULL;
  END IF;

  SELECT mt.prompt_version INTO v_prompt
  FROM public.message_translations mt
  WHERE mt.message_id = p_message_id AND mt.language = p_target_language;

  SELECT ulp.known_languages INTO v_known
  FROM public.user_linguistic_profiles ulp
  WHERE ulp.user_id = v_uid AND ulp.tenant_id = v_tenant;

  INSERT INTO public.translation_reviews (
    tenant_id, message_id, target_language,
    reviewer_id, reviewer_type, reviewer_known_languages,
    rating, prompt_version
  ) VALUES (
    v_tenant, p_message_id, p_target_language,
    v_uid, 'user', v_known,
    p_rating, v_prompt
  )
  ON CONFLICT (message_id, target_language, reviewer_id) WHERE reviewer_id IS NOT NULL
  DO UPDATE SET rating = EXCLUDED.rating,
                reviewer_known_languages = EXCLUDED.reviewer_known_languages,
                prompt_version = EXCLUDED.prompt_version,
                created_at = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.record_review(uuid, text, text) IS
  'Phase 4: upsert a good/bad translation review (NULL clears). Membership-gated. '
  'decisions.md 2026-07-28.';

REVOKE ALL ON FUNCTION public.record_review(uuid, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.record_review(uuid, text, text) TO authenticated;


-- ═════════════════════════════════════════════════════════════════════════════
-- 5. anonymize_corrections_for_account(p_account_id) — deletion hook (service_role)
-- ═════════════════════════════════════════════════════════════════════════════
-- Wires the Step 7 deletion sweep's corrections-anonymization (was a no-op stub while this
-- table didn't exist — architecture.md §10). Strips the corrector's PII (user_id +
-- known_languages) while KEEPING the translation pair (irreplaceable training data). Called
-- by server/lib/deletion.js BEFORE the auth.users hard delete (so rows are still findable
-- by corrector_user_id). Also clears reviewer PII on reviews. Returns rows touched.
-- (The FK ON DELETE SET NULL would null the *_id anyway, but known_languages is a plain
-- column the cascade won't touch — so this explicit pass is required for "strip PII".)
CREATE OR REPLACE FUNCTION public.anonymize_corrections_for_account(p_account_id uuid)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_n integer := 0;
  v_m integer := 0;
BEGIN
  UPDATE public.translation_corrections
     SET corrector_user_id = NULL,
         corrector_known_languages = NULL
   WHERE corrector_user_id = p_account_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE public.translation_reviews
     SET reviewer_id = NULL,
         reviewer_known_languages = NULL
   WHERE reviewer_id = p_account_id;
  GET DIAGNOSTICS v_m = ROW_COUNT;

  RETURN v_n + v_m;
END;
$$;

COMMENT ON FUNCTION public.anonymize_corrections_for_account(uuid) IS
  'Step 7 deletion sweep hook: strip a corrector/reviewer''s PII (user_id + known_languages) '
  'while retaining the translation pair. service_role only. decisions.md 2026-07-28.';

REVOKE ALL ON FUNCTION public.anonymize_corrections_for_account(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.anonymize_corrections_for_account(uuid) TO service_role;


-- ── In-transaction verification (raises → rolls back the whole migration) ──────
DO $$
BEGIN
  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.translation_corrections'::regclass) IS NOT TRUE THEN
    RAISE EXCEPTION 'verify: RLS not enabled on translation_corrections';
  END IF;
  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.translation_reviews'::regclass) IS NOT TRUE THEN
    RAISE EXCEPTION 'verify: RLS not enabled on translation_reviews';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'translation_corrections' AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION 'verify: translation_corrections has a non-SELECT policy (writes must be RPC-only)';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.record_correction(uuid,text,text,jsonb,text)', 'execute') THEN
    RAISE EXCEPTION 'verify: record_correction not executable by authenticated';
  END IF;
  IF has_function_privilege('anon', 'public.record_correction(uuid,text,text,jsonb,text)', 'execute') THEN
    RAISE EXCEPTION 'verify: record_correction must NOT be executable by anon';
  END IF;
  IF has_function_privilege('authenticated', 'public.anonymize_corrections_for_account(uuid)', 'execute') THEN
    RAISE EXCEPTION 'verify: anonymize_corrections_for_account must be service_role only';
  END IF;
  RAISE NOTICE 'migration 025 verification passed';
END $$;

commit;

-- ════════════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run on staging after applying; full behavior via the gate script)
-- ════════════════════════════════════════════════════════════════════════════════
-- 1. Tables + RLS on:
--      SELECT relname, relrowsecurity FROM pg_class
--      WHERE relname IN ('translation_corrections','translation_reviews');  -- expect t,t
-- 2. Policies are SELECT-own only (no INSERT/UPDATE/DELETE policy):
--      SELECT tablename, polname, cmd FROM pg_policies
--      WHERE tablename IN ('translation_corrections','translation_reviews');
-- 3. RPC grants: record_correction / record_review → authenticated;
--    anonymize_corrections_for_account → service_role only.
-- 4. End-to-end (happy + adversarial) → scripts/corrections-gate-test.mjs (staging only,
--    RLS_TEST_CONFIRM_STAGING=yes): member can correct → row lands with correct snapshot;
--    non-member/left-member denied; direct client INSERT denied; append-only (no UPDATE);
--    good/bad review upserts + clears; canonical translation unchanged in the DB.
-- ════════════════════════════════════════════════════════════════════════════════
