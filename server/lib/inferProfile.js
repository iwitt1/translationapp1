/**
 * server/lib/inferProfile.js — server-side profile inference.
 *
 * Lifted verbatim (logic-wise) from the client `applyInferences` helper that used
 * to live in src/App.jsx. Moved server-side because:
 *   1. RLS on user_linguistic_profiles / user_profile_events restricts writes to
 *      user_id = auth.uid(), but inference only ever runs for OTHER users' messages
 *      (your own messages skip translation) — so every client-side write was denied.
 *   2. Concurrent viewers translating the same message fired simultaneous client
 *      writes to the same profile row with no coordination (last-write-wins race).
 *
 * This module fixes both: it connects as the dedicated least-privilege `profile_writer`
 * role (migration 015), which does NOT bypass RLS — instead it holds column-scoped grants
 * plus RLS policies targeted `TO profile_writer` that permit exactly the three operations
 * below (USING/ WITH CHECK true). The DB authorizes the *operation*; this module authorizes
 * the *row* via the trust boundary above. It also serialises the read+write with
 * SELECT ... FOR UPDATE inside a single transaction so concurrent inferences for the same
 * sender can't clobber each other.
 *
 * TRUST BOUNDARY (decisions.md 2026-06-10): the caller sends `message_id`, NOT a
 * sender id. We look up the message row ourselves and derive the authoritative
 * sender_id + tenant_id + source_language from it, ignoring any client-supplied
 * identity. This closes profile-spoofing (a malicious client can't write to an
 * arbitrary user's profile). We still trust the `inferences` payload itself — a
 * forged inference is low-stakes (gated by the confidence threshold + guards,
 * affects only a derived field, single tenant).
 *
 * Connection: DATABASE_URL_PROFILE_WRITER. Needs SELECT + UPDATE on
 * user_linguistic_profiles, SELECT on messages, and INSERT on user_profile_events.
 * Distinct from DATABASE_URL_PROD_WRITER (events.js), which is INSERT-only on the
 * event tables. Lazy-init so a missing env var doesn't crash the server on startup.
 * NEVER VITE_-prefixed — that would ship a privileged DB credential to the browser.
 */

import pg from 'pg';

const { Client } = pg;

// Only apply inferences above this confidence to the sender's profile.
// (Was INFERENCE_CONFIDENCE_THRESHOLD in App.jsx.)
const INFERENCE_CONFIDENCE_THRESHOLD = 0.6;

// register (from the translate model) → formality_preference (our column domain)
const REGISTER_TO_FORMALITY = {
  formal: 'formal', professional: 'formal', academic: 'formal',
  casual: 'casual', romantic: 'casual', family: 'casual', support: 'neutral',
};

// Minimal language-name → BCP 47 normaliser. The model's detected_language is
// usually already a code, but can occasionally be a full name; source_language is
// stored normalised at send time. We normalise before comparing dialect prefixes.
const LANG_NAME_TO_CODE = {
  english: 'en', spanish: 'es', french: 'fr', german: 'de',
  japanese: 'ja', korean: 'ko', portuguese: 'pt', arabic: 'ar',
  russian: 'ru', chinese: 'zh', italian: 'it', dutch: 'nl',
  hindi: 'hi', turkish: 'tr', polish: 'pl', swedish: 'sv',
};

function normalizeLang(lang) {
  if (!lang) return lang;
  const lower = String(lang).toLowerCase();
  return LANG_NAME_TO_CODE[lower] ?? lower;
}

function getConnectionString() {
  return process.env.DATABASE_URL_PROFILE_WRITER || null;
}

/**
 * Compute the profile updates + event rows from an inference payload, given the
 * sender's current profile row. Pure function — no I/O. Mirrors the old
 * client-side applyInferences guard logic exactly.
 *
 * @param {object} prev          current user_linguistic_profiles row (or {})
 * @param {object} inferences    translate response `inferences` object
 * @param {string} anchorLang    authoritative source language (BCP 47) used to
 *                               gate dialect inference (the dialect-consistency guard)
 * @returns {{updates: object, events: Array}}
 */
function computeInferenceUpdates(prev, inferences, anchorLang) {
  const updates = {};
  const events = [];

  // ── Dialect ──
  // Guard: only apply a dialect signal if it's linguistically consistent with the
  // message's source language. Prevents e.g. 'es-AR' being written to an English
  // speaker's profile. The anchor is the AUTHORITATIVE source language we read from
  // the message row (not a client-supplied value) — this is the trust-boundary +
  // dialect-guard fix in one: the old client guard trusted whatever language the
  // viewer's screen had set; the server reads the stored, send-time-detected code.
  const dialectLangPrefix = inferences.detected_dialect?.split('-')[0];
  const anchorPrefix = anchorLang ? normalizeLang(anchorLang).split('-')[0] : null;
  const dialectConsistent = !!anchorPrefix && dialectLangPrefix === anchorPrefix;

  if (
    inferences.detected_dialect &&
    dialectConsistent &&
    inferences.dialect_confidence >= INFERENCE_CONFIDENCE_THRESHOLD &&
    prev.dialect_source !== 'explicit' &&
    inferences.dialect_confidence > (prev.dialect_confidence ?? 0)
  ) {
    updates.dialect_region = inferences.detected_dialect;
    updates.dialect_confidence = inferences.dialect_confidence;
    updates.dialect_source = 'inferred';
    events.push({
      event_type: 'dialect_region_inferred',
      previous_value: { value: prev.dialect_region ?? null },
      new_value: { value: inferences.detected_dialect },
    });
  }

  // ── Formality (mapped from register) ──
  if (
    inferences.detected_register &&
    inferences.register_confidence >= INFERENCE_CONFIDENCE_THRESHOLD &&
    prev.formality_source !== 'explicit'
  ) {
    const mapped = REGISTER_TO_FORMALITY[inferences.detected_register] ?? 'neutral';
    if (mapped !== prev.formality_preference) {
      updates.formality_preference = mapped;
      updates.formality_source = 'inferred';
      events.push({
        event_type: 'formality_preference_inferred',
        previous_value: { value: prev.formality_preference ?? null },
        new_value: { value: mapped },
      });
    }
  }

  // ── Gender ──
  if (
    inferences.gender_signal &&
    inferences.gender_confidence >= INFERENCE_CONFIDENCE_THRESHOLD &&
    prev.gender_source !== 'explicit'
  ) {
    if (inferences.gender_signal !== prev.gender_signal) {
      updates.gender_signal = inferences.gender_signal;
      updates.gender_source = 'inferred';
      events.push({
        event_type: 'gender_signal_inferred',
        previous_value: { value: prev.gender_signal ?? null },
        new_value: { value: inferences.gender_signal },
      });
    }
  }

  return { updates, events };
}

// Columns computeInferenceUpdates may set — used to build the UPDATE safely
// (parameterised values; column identifiers come from this fixed allowlist only).
const UPDATABLE_COLUMNS = [
  'dialect_region', 'dialect_confidence', 'dialect_source',
  'formality_preference', 'formality_source',
  'gender_signal', 'gender_source',
];

/**
 * Apply an inference payload to the sender's linguistic profile, atomically.
 *
 * @param {object} params
 * @param {string} params.messageId         message row id (authoritative identity source)
 * @param {object} params.inferences        translate response `inferences` object
 * @param {string} [params.detectedLanguage] live detected_language from the translate
 *                                            response — used only as the dialect-guard
 *                                            anchor when the stored source_language is
 *                                            missing/'unknown' (resolves the legacy
 *                                            'unknown'-blocks-all-dialect edge case).
 * @returns {Promise<{status: string, reason?: string, fields?: string[]}>}
 *   status: 'updated' | 'noop' | 'skipped' | 'disabled'
 */
export async function inferProfile({ messageId, inferences, detectedLanguage }) {
  if (!inferences) return { status: 'noop', reason: 'no_inferences' };
  if (!messageId)  return { status: 'skipped', reason: 'no_message_id' };

  const connectionString = getConnectionString();
  if (!connectionString) {
    console.warn('[inferProfile] DATABASE_URL_PROFILE_WRITER not set — skipping inference write');
    return { status: 'disabled', reason: 'no_connection_string' };
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query('BEGIN');

    // 1. Authoritative identity: derive sender + tenant + source language from the
    //    message row. We do NOT trust any client-supplied sender id.
    const msgRes = await client.query(
      'SELECT sender_id, tenant_id, source_language FROM public.messages WHERE id = $1',
      [messageId]
    );
    if (msgRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return { status: 'skipped', reason: 'message_not_found' };
    }
    const { sender_id, tenant_id, source_language } = msgRes.rows[0];
    if (!sender_id) {
      // Sender account was deleted (sender_id SET NULL on delete) — nothing to update.
      await client.query('ROLLBACK');
      return { status: 'skipped', reason: 'sender_null' };
    }

    // 2. Lock the sender's profile row for the duration of the transaction so
    //    concurrent inferences for the same sender serialise instead of racing.
    const profRes = await client.query(
      `SELECT * FROM public.user_linguistic_profiles
        WHERE user_id = $1 AND tenant_id = $2
        FOR UPDATE`,
      [sender_id, tenant_id]
    );
    if (profRes.rowCount === 0) {
      // Profile row is created at onboarding; absence means the sender never
      // completed onboarding (shouldn't happen for a message author). Skip rather
      // than fabricate a row.
      await client.query('ROLLBACK');
      return { status: 'skipped', reason: 'no_profile_row' };
    }
    const prev = profRes.rows[0];

    // 3. Dialect-guard anchor: prefer the authoritative stored source_language;
    //    fall back to the live translate-time detection when it's missing/'unknown'.
    const anchorLang =
      (source_language && source_language !== 'unknown')
        ? source_language
        : (detectedLanguage ?? null);

    const { updates, events } = computeInferenceUpdates(prev, inferences, anchorLang);

    if (Object.keys(updates).length === 0) {
      await client.query('COMMIT');
      return { status: 'noop', reason: 'no_qualifying_inferences' };
    }

    // 4. UPDATE profile (allowlisted columns only; values parameterised).
    const setCols = Object.keys(updates).filter((c) => UPDATABLE_COLUMNS.includes(c));
    const setClauses = setCols.map((c, i) => `${c} = $${i + 1}`);
    const setValues = setCols.map((c) => updates[c]);
    setClauses.push('updated_at = now()');
    const updateSql =
      `UPDATE public.user_linguistic_profiles
          SET ${setClauses.join(', ')}
        WHERE user_id = $${setCols.length + 1} AND tenant_id = $${setCols.length + 2}`;
    await client.query(updateSql, [...setValues, sender_id, tenant_id]);

    // 5. Append event rows (append-only log).
    for (const evt of events) {
      await client.query(
        `INSERT INTO public.user_profile_events
           (user_id, tenant_id, event_type, previous_value, new_value, source)
         VALUES ($1, $2, $3, $4, $5, 'inference')`,
        [
          sender_id,
          tenant_id,
          evt.event_type,
          JSON.stringify(evt.previous_value),
          JSON.stringify(evt.new_value),
        ]
      );
    }

    await client.query('COMMIT');
    return { status: 'updated', fields: setCols };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

// Exported for unit testing the guard logic without a DB connection.
export { computeInferenceUpdates };
