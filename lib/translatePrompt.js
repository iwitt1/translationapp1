/**
 * translatePrompt.js — shared prompt builder for the translation API.
 *
 * Imported by both api/v1/translate.js (Vercel serverless) and server/index.js (Express).
 * Also imported by src/App.jsx for PROMPT_VERSION (used to stamp cached translations).
 * Single source of truth for all prompt logic — no prompt drift between environments.
 *
 * Public API:
 *   PROMPT_VERSION  — semver string; increment on any meaningful prompt change
 *   buildMessages({ mode, text, targetLanguage, contextType, context, history })
 *     → OpenAI messages array ready to pass to chat.completions.create
 *
 * Versioning convention:
 *   Increment PROMPT_VERSION when the change could meaningfully affect output quality
 *   or response shape (new fields, changed instructions, new modifiers).
 *   Do NOT increment for cosmetic rewording that doesn't change model behaviour.
 *   Stamped on message_translations.prompt_version so corrections analysis can
 *   correlate quality shifts with prompt changes.
 */

// ── Prompt version ────────────────────────────────────────────────────────────
export const PROMPT_VERSION = '2.0.0'; // 2.0.0: gpt-5.4 + naturalness-first prompt rewrite (persona, idiom/cultural-item/texting-convention rules)

// ── Model config ──────────────────────────────────────────────────────────────
// Single source of truth for both call sites (api/v1/translate.js + server/index.js).
// TRANSLATE: gpt-5.4 with reasoning effort. 'medium' to start (Isaac's call,
// decisions.md 2026-07-05); drop to 'low'/'none' if chat latency hurts —
// OpenAI's guidance is low/none for latency-sensitive paths.
// DETECT: stays on gpt-4o-mini — trivial task, runs on every send; a reasoning
// model here would add cost + latency for no quality gain.
// NOTE: no `temperature` on gpt-5.4 reasoning calls — the param isn't supported;
// naturalness now comes from the prompt, not sampling.
export const TRANSLATE_MODEL = 'gpt-5.4';
export const TRANSLATE_REASONING_EFFORT = 'medium';
export const DETECT_MODEL = 'gpt-4o-mini';

// ── Context-type system-prompt modifiers ─────────────────────────────────────
// Each string is appended to the system prompt after the core translation rules.
// Keeps the token cost small (one short sentence) while meaningfully shifting register.

const CONTEXT_TYPE_MODIFIERS = {
  casual:
    'This is a casual conversation between friends. Match the informal, relaxed energy.',
  dating:
    'This is a romantic conversation. Preserve flirtation, intimacy, and emotional subtext carefully. Handle terms of endearment precisely — do not flatten them into generic equivalents.',
  professional:
    'This is a professional context. Maintain formal register and workplace-appropriate tone throughout.',
  academic:
    'This is an academic or formal context. Precision and formal register take priority over naturalness.',
};

// ── JSON schema shown to the model ───────────────────────────────────────────
// Shown inline in the system prompt so the model knows exactly what shape to return.
// JSON mode (response_format: json_object) enforces valid JSON; the schema here
// guides field names and value formats.

const TRANSLATE_RESPONSE_SCHEMA = `{
  "translated_text": "...",
  "detected_language": "...",
  "inferences": {
    "detected_dialect": null,
    "dialect_confidence": 0.0,
    "detected_register": null,
    "register_confidence": 0.0,
    "gender_signal": null,
    "gender_confidence": 0.0,
    "domain_signal": null,
    "idiomatic_elements": []
  },
  "ambiguity": {
    "detected": false,
    "confidence": 0.0,
    "alternatives": []
  }
}`;

// ── buildMessages ─────────────────────────────────────────────────────────────

/**
 * Build the OpenAI `messages` array for a translate or detect call.
 *
 * @param {object}  params
 * @param {'detect'|'translate'} params.mode
 * @param {string}  params.text             The message to detect or translate.
 * @param {string}  [params.targetLanguage] Required for mode=translate.
 * @param {string}  [params.contextType]    'casual'|'dating'|'professional'|'academic'. Default 'casual'.
 * @param {object}  [params.context]        Speaker + conversation context object:
 *                                          { user: { dialect, formality, gender, known_languages },
 *                                            conversation: { register, closeness } }
 * @param {Array}   [params.history]        Last N messages for context:
 *                                          [{ sender_id, original_text, source_language }]
 * @returns {Array} OpenAI messages array.
 */
export function buildMessages({
  mode,
  text,
  targetLanguage,
  contextType = 'casual',
  context,
  history,
}) {
  // ── Detect mode: simple, no inferences needed ────────────────────────────
  if (mode === 'detect') {
    return [
      {
        role: 'system',
        content:
          'Detect the language of the message.\n\n' +
          'Return detected_language as a BCP 47 language code (e.g. "en", "es", "fr", "pt", "de", "ja", "ko", "ru", "zh", "ar"). ' +
          'Never return a full language name like "English" or "Spanish" — always use the short code.\n\n' +
          'If the message is primarily in one language but contains words from another (code-switching or borrowings), ' +
          'classify by the dominant language and reflect the ambiguity in a lower confidence score ' +
          'rather than classifying by the minority language.\n\n' +
          'Return ONLY JSON: { "detected_language": "...", "confidence": 0.0 }',
      },
      { role: 'user', content: text },
    ];
  }

  // ── Translate mode ───────────────────────────────────────────────────────

  const modifier =
    CONTEXT_TYPE_MODIFIERS[contextType] ?? CONTEXT_TYPE_MODIFIERS.casual;

  // Context block: compact JSON injected into the system prompt.
  // Kept under ~100 tokens by design (see architecture.md §6).
  const contextBlock = context
    ? `\nSpeaker context (use to guide dialect, register, and gender-sensitive translation):\n${JSON.stringify(context)}\n`
    : '';

  const systemPrompt = `You are a bilingual native speaker translating a live chat conversation into ${targetLanguage}.

Your goal: produce what the sender would have typed if ${targetLanguage} were their native language. Natural phrasing takes priority over word-for-word fidelity. Meaning, tone, and intent must survive; individual words do not have to.
${modifier}
${contextBlock}
Translation rules:
- Idioms, slang, teasing, and figurative language: translate the meaning and energy, never the literal words. If ${targetLanguage} has an equivalent expression, use it; if not, express the intent naturally. (Example: Spanish "no seas payaso" said teasingly is "stop clowning around" or "don't be ridiculous" in English — never "don't be a clown".)
- Culturally specific items (foods, dishes, places, customs): keep the original name, or use the name the target culture actually uses for that thing. Never invent a literal gloss. (Example: "tacos de canasta" stays "tacos de canasta" — not "basket tacos".)
- Mirror the sender's texting conventions in the target language: if they skip final periods and capital letters, so do you; casual laughter converts to its target-language equivalent ("jajaja" ↔ "lol"/"haha"); emoji pass through unchanged. Never make a message look more formal, complete, or "correct" than the original.
- Match register and formality precisely, including T-V distinctions (tú/usted, du/Sie, tu/vous) — follow the speaker context and the conversation history.
- Use dialect and register signals from the speaker context when present.
- When a phrase has multiple plausible interpretations (sarcasm vs literal, idiom collision, pronoun ambiguity), set ambiguity.detected to true and populate alternatives.
- When the speaker context includes gender: nonbinary, use the most established gender-inclusive forms available in the target language (e.g. Spanish -e endings and "elle", French "iel", Portuguese -x forms, German gender star). Where no established inclusive form exists in the target language, prefer the most neutral available phrasing.

Return ONLY valid JSON. No markdown, no code fences. Use this exact schema:

${TRANSLATE_RESPONSE_SCHEMA}

Field notes:
- detected_language: BCP 47 tag (e.g. "es", "ru", "zh-TW").
- detected_dialect: regional variant if detectable (e.g. "es-AR", "pt-BR"), otherwise null.
- detected_register: one of formal | casual | professional | romantic | academic | support, or null.
- gender_signal: one of masculine | feminine | neutral | nonbinary | unknown, or null.
  "neutral" means the source language has no grammatical gender (e.g. Finnish, Turkish, Hungarian).
  "nonbinary" means the speaker is actively using gender-inclusive or nonbinary language forms
  (e.g. Spanish -e endings / "elle", French "iel", Portuguese -x/-@ forms, German gender star/colon).
  These are distinct — do not conflate them.
- domain_signal: domain if detectable (e.g. "medical", "legal"), otherwise null.
- idiomatic_elements: list any idioms, slang, or culturally specific phrases found.
- For ambiguous cases: alternatives is an array of { translated_text, interpretation, confidence }.
- All confidence values: floats 0.0–1.0. Use null for undetectable string fields, 0.0 for undetectable confidence.
- IMPORTANT: All inferences (dialect, register, gender) must reflect the sender of the message being translated only — infer from their own message text and writing style. Do not attribute dialect or register signals that appear in the conversation history to the current sender. History is provided for translation context only.`.trim();

  // ── User turn: optional history block + message to translate ────────────
  let userContent;

  if (history && history.length > 0) {
    const historyLines = history
      .map(
        (m, i) =>
          `[${i + 1}] ${m.sender_id}: "${m.original_text}" (${m.source_language ?? 'unknown'})`
      )
      .join('\n');
    userContent =
      `Conversation history — for context only, do not translate:\n${historyLines}\n\nMessage to translate:\n"${text}"`;
  } else {
    userContent = text;
  }

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
}
