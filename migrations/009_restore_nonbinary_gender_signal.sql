-- Migration 009 — Restore 'nonbinary' to user_linguistic_profiles.gender_signal
-- Date: 2026-06-10
-- Phase: 2 (Multi-user safety — post Step 2 fix)
--
-- What this migration does:
--   Re-adds 'nonbinary' to the gender_signal CHECK on user_linguistic_profiles.
--
-- Why:
--   Migration 003 (003_prompt_version_and_gender_nonbinary.sql) deliberately added
--   'nonbinary' as a fifth gender_signal value, distinct from 'neutral'. See
--   decisions.md 2026-05-12 — 'nonbinary' means the speaker actively uses
--   gender-inclusive forms (Spanish -e/elle, French iel, etc.) and signals the model
--   to translate with inclusive target-language forms; 'neutral' means the SOURCE
--   language has no grammatical gender (Finnish, Turkish, …). They are not the same.
--
--   When migration 008 RECREATED user_linguistic_profiles during the identity cutover,
--   the rewritten CHECK (ulp_gender_check) was
--       gender_signal IN ('masculine', 'feminine', 'neutral', 'unknown')
--   i.e. 'nonbinary' was silently dropped — an oversight in the 008 rewrite, not an
--   intentional reversal of the 003 decision. This migration restores the intended set
--   so writing gender_signal='nonbinary' no longer violates the CHECK.
--
--   Surfaced in the 2026-06-10 docs audit; tracked in parking-lot.md
--   "`nonbinary` gender signal regressed out of the schema in migration 008".
--
-- Safe to run:
--   Staging ulp is empty (wiped at Phase 2 start), so no existing rows can violate the
--   new constraint. The change only WIDENS the allowed set, so even with data present it
--   cannot fail on existing rows. Idempotent: drops the constraint by name first.
--
-- Migration workflow (operations.md §3):
--   Run on STAGING → verify (below) → replay on PROD as part of / before the Phase 2 cutover.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.user_linguistic_profiles
  DROP CONSTRAINT IF EXISTS ulp_gender_check;

ALTER TABLE public.user_linguistic_profiles
  ADD CONSTRAINT ulp_gender_check
    CHECK (gender_signal IN ('masculine', 'feminine', 'neutral', 'nonbinary', 'unknown'));


-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (run after migration, before calling this done)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Constraint definition now includes 'nonbinary'
--    SELECT pg_get_constraintdef(oid)
--    FROM pg_constraint
--    WHERE conrelid = 'public.user_linguistic_profiles'::regclass
--      AND conname  = 'ulp_gender_check';
--    Expect: CHECK ((gender_signal = ANY (ARRAY['masculine'::text, 'feminine'::text,
--            'neutral'::text, 'nonbinary'::text, 'unknown'::text])))

-- 2. A 'nonbinary' write is now accepted (rolled back so it leaves no data).
--    Run as a quick check in the SQL editor against an existing profile id:
--      BEGIN;
--        UPDATE public.user_linguistic_profiles
--          SET gender_signal = 'nonbinary'
--          WHERE user_id = (SELECT id FROM public.profiles LIMIT 1);
--      ROLLBACK;
--    Expect: UPDATE succeeds (0 or 1 rows) with NO check-constraint violation.
