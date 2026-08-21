import { supabase } from './supabase';

/*
========================================================
✍️  CORRECTIONS CAPTURE (Phase 4)
========================================================
Thin wrappers over the two SECURITY DEFINER RPCs shipped in migration 025. The
server assembles the full snapshot (original text, model output, prompt version,
corrector known_languages, register, history window) from authoritative reads —
the client only passes ids + the corrected text / rating. Both are RLS SELECT-own
/ RPC-only-write, so these are the sole write path.

  • recordReview   — good/bad quality signal → translation_reviews (upsert; null clears)
  • recordCorrection — the user's suggested fix → translation_corrections (append-only)

The corrected text may be a FULL or PARTIAL correction — the user only needs to
fix what's wrong. corrected_text is stored as-is; the (model_output, corrected_text)
pair is enough for a later AI pass to locate the fix.
*/

// rating: 'good' | 'bad' | null (null clears the caller's review for this translation)
export async function recordReview(messageId, targetLanguage, rating) {
  const { data, error } = await supabase.rpc('record_review', {
    p_message_id: messageId,
    p_target_language: targetLanguage,
    p_rating: rating,
  });
  if (error) throw error;
  return data;
}

export async function recordCorrection(messageId, targetLanguage, correctedText) {
  const { data, error } = await supabase.rpc('record_correction', {
    p_message_id: messageId,
    p_target_language: targetLanguage,
    p_corrected_text: correctedText,
  });
  if (error) throw error;
  return data;
}
