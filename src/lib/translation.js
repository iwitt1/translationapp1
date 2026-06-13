// ============================================================================
// translation.js — client-side config + helpers for the translation engine API.
// ============================================================================
// Extracted from App.jsx so the chat UI and the translation surface stay layer-
// separated (the project's standing rule: the eventual B2B engine API must not be
// entangled with React chat code). Anything that knows the engine's HTTP contract
// or its language-code quirks lives here; components import from here.
// ============================================================================

/*
🌐 API endpoints (LOCAL + PROD SAFE).
In dev the Vite server proxies nothing — talk to the local engine on :3001.
In prod the engine is same-origin behind /api/v1/*.
*/
export const API_URL = import.meta.env.DEV
  ? 'http://localhost:3001/api/v1/translate'
  : '/api/v1/translate';

export const INFER_API_URL = import.meta.env.DEV
  ? 'http://localhost:3001/api/v1/infer-profile'
  : '/api/v1/infer-profile';

// Gates the fire-and-forget profile-inference POST. Flip to false to kill the
// call without a redeploy if the endpoint misbehaves. (Profile inference itself
// is server-side: api/v1/infer-profile + server/lib/inferProfile.js.)
export const PROFILE_INFERENCE_ENABLED = true;

// Confidence floor for trusting the detect API's language guess on send. Below
// this we fall back to the sender's preferred language (or 'unknown').
export const DETECT_CONFIDENCE_THRESHOLD = 0.85;

/*
🔤 Language-code normalizer.
The detect API sometimes returns full language NAMES ('English') instead of BCP-47
codes ('en'). Without normalising, the "same language → skip translation" check
(sourceLang === targetLanguage) always failed and every message hit the translate
path. Normalise both sides before comparing.
*/
const LANG_NAME_TO_CODE = {
  english: 'en', spanish: 'es', french: 'fr', german: 'de',
  japanese: 'ja', korean: 'ko', portuguese: 'pt', arabic: 'ar',
  russian: 'ru', chinese: 'zh', italian: 'it', dutch: 'nl',
  hindi: 'hi', turkish: 'tr', polish: 'pl', swedish: 'sv',
};

export function normalizeLang(lang) {
  if (!lang) return lang;
  const lower = lang.toLowerCase();
  return LANG_NAME_TO_CODE[lower] ?? lower;
}

// Detect the language of outgoing text via the engine's detect mode. Returns a
// normalised BCP-47 code if confident enough, else the provided fallback.
// Never throws — detection is best-effort and must not block a send.
export async function detectSourceLanguage(text, fallback = 'unknown') {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, mode: 'detect' }),
    });
    if (!res.ok) return fallback;
    const detection = await res.json();
    const lang = normalizeLang(detection?.detected_language);
    const conf = detection?.confidence ?? 1.0;
    return lang && conf >= DETECT_CONFIDENCE_THRESHOLD ? lang : fallback;
  } catch (err) {
    console.error('Language detect failed:', err);
    return fallback;
  }
}
