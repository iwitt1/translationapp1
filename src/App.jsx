import { useState, useEffect } from 'react';
import { supabase } from './lib/supabase';
import { CHAT_APP_TENANT_ID } from './lib/config';
import { PROMPT_VERSION } from '../lib/translatePrompt.js';

/*
========================================================
🌐 API CONFIG (LOCAL + PROD SAFE)
========================================================
*/
const API_URL = import.meta.env.DEV
  ? 'http://localhost:3001/api/v1/translate'
  : '/api/v1/translate';

/*
========================================================
🌍 SUPPORTED LANGUAGES
========================================================
*/
const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'ru', label: 'Russian' },
  { code: 'zh', label: 'Chinese' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ar', label: 'Arabic' },
];

const CONTEXT_TYPES = [
  { value: 'casual',       label: 'Casual' },
  { value: 'dating',       label: 'Dating' },
  { value: 'professional', label: 'Professional' },
  { value: 'academic',     label: 'Academic' },
];

// Confidence threshold: only apply inferences above this level to the sender profile.
const INFERENCE_CONFIDENCE_THRESHOLD = 0.6;

/*
========================================================
🔤 LANGUAGE CODE NORMALIZER
========================================================
The detect API sometimes returns full language names ('English', 'Spanish')
instead of BCP 47 codes ('en', 'es'). This caused the skip check
(sourceLang === targetLanguage) to always fail, sending every message through
the translate path even when source and target were the same language.
Normalise both sides before comparing so 'English' and 'en' are treated as equal.
*/
const LANG_NAME_TO_CODE = {
  english: 'en', spanish: 'es', french: 'fr', german: 'de',
  japanese: 'ja', korean: 'ko', portuguese: 'pt', arabic: 'ar',
  russian: 'ru', chinese: 'zh', italian: 'it', dutch: 'nl',
  hindi: 'hi', turkish: 'tr', polish: 'pl', swedish: 'sv',
};

function normalizeLang(lang) {
  if (!lang) return lang;
  const lower = lang.toLowerCase();
  return LANG_NAME_TO_CODE[lower] ?? lower;
}

/*
========================================================
🧠 PROFILE INFERENCE HELPER
========================================================
Applies inferences returned by the translate API to the sender's
user_linguistic_profiles row. Runs client-side because profile updates
are a chat-layer concern (translation layer knows nothing about chat).

Rules (per architecture.md §6):
  - Never overwrite explicit values (dialect_source/formality_source/gender_source = 'explicit').
  - For dialect: only update if new confidence > stored confidence.
  - For formality/gender: update any 'inferred' value if confidence >= threshold.
  - Logs each change to user_profile_events (append-only).
*/
async function applyInferences(senderId, inferences, currentProfile, detectedLanguage) {
  if (!inferences) return;

  const updates = {};
  const events = [];
  const prev = currentProfile ?? {};

  // ── Dialect ──
  // Guard: only apply a dialect signal if it's linguistically consistent with
  // the message's detected source language. Prevents e.g. 'es-AR' being written
  // to an English speaker's profile because their message was translated on a
  // viewer's screen that had a stale/wrong targetLanguage set.
  // 'es-AR'.split('-')[0] === 'es'; that must match 'en'.split('-')[0] === 'en'
  // before we proceed — if they don't match, skip the dialect block entirely.
  const dialectLangPrefix = inferences.detected_dialect?.split('-')[0];
  const detectedLangPrefix = detectedLanguage?.split('-')[0];
  // Require BOTH prefixes to be present and match.
  // If detectedLanguage is missing/null, err on the side of blocking — we can't
  // verify consistency so we must not write. The previous OR-based logic had the
  // opposite null-safety: !detectedLangPrefix === true allowed null to bypass.
  const dialectConsistent =
    !!detectedLangPrefix && dialectLangPrefix === detectedLangPrefix;

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
  const REGISTER_TO_FORMALITY = {
    formal: 'formal', professional: 'formal', academic: 'formal',
    casual: 'casual', romantic: 'casual', family: 'casual', support: 'neutral',
  };
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

  if (Object.keys(updates).length === 0) return;

  updates.updated_at = new Date().toISOString();

  // Upsert profile (fire and forget — don't block message rendering)
  supabase
    .from('user_linguistic_profiles')
    .upsert(
      { user_id: senderId, tenant_id: CHAT_APP_TENANT_ID, ...updates },
      { onConflict: 'user_id,tenant_id' }
    )
    .then(({ error }) => {
      if (error) console.error('Profile upsert error:', error);
    });

  // Log events (fire and forget)
  for (const evt of events) {
    supabase
      .from('user_profile_events')
      .insert({
        user_id: senderId,
        tenant_id: CHAT_APP_TENANT_ID,
        event_type: evt.event_type,
        previous_value: evt.previous_value,
        new_value: evt.new_value,
        source: 'inference',
      })
      .then(({ error }) => {
        if (error) console.error('Profile event insert error:', error);
      });
  }
}

/*
========================================================
💬 MESSAGE BUBBLE
========================================================
Props:
  message      — the message row from Supabase
  userProfile  — logged-in user's user_profiles row (for targetLanguage)
  userId       — logged-in user's ID
  contextType  — 'casual'|'dating'|'professional'|'academic'
  history      — last N messages before this one (for context injection)
*/
function MessageBubble({ message, userProfile, userId, contextType, history }) {
  const [translatedText, setTranslatedText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const targetLanguage = userProfile?.default_language || 'en';
  const isSender = message.sender_id === userId;

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        setLoading(true);
        setError(false);

        const sourceLang = message.source_language;

        // ── 1. No translation needed ──────────────────────────────────────
        // Skip if: (a) source matches target (normalised — 'English'==='en'),
        // (b) no source detected, or (c) this is the viewer's own message.
        const normSource = normalizeLang(sourceLang);
        const normTarget = normalizeLang(targetLanguage);
        if (!sourceLang || normSource === normTarget || isSender) {
          setTranslatedText(message.original_text);
          return;
        }

        // ── 2. Cache check ────────────────────────────────────────────────
        const { data: cached } = await supabase
          .from('message_translations')
          .select('translated_text')
          .eq('message_id', message.id)
          .eq('language', targetLanguage)
          .maybeSingle();

        if (cached?.translated_text) {
          setTranslatedText(cached.translated_text);
          return;
        }

        // ── 3. Fetch sender's linguistic profile (for context injection) ──
        const { data: senderProfile } = await supabase
          .from('user_linguistic_profiles')
          .select('*')
          .eq('user_id', message.sender_id)
          .eq('tenant_id', CHAT_APP_TENANT_ID)
          .maybeSingle();

        // Build context.user from sender's stored profile.
        // null fields are omitted so the model doesn't see empty noise.
        const userContext = {};
        if (senderProfile?.dialect_region)       userContext.dialect       = senderProfile.dialect_region;
        if (senderProfile?.formality_preference) userContext.formality     = senderProfile.formality_preference;
        if (senderProfile?.gender_signal)        userContext.gender        = senderProfile.gender_signal;
        if (senderProfile?.known_languages?.length) userContext.known_languages = senderProfile.known_languages;

        const context = Object.keys(userContext).length > 0
          ? { user: userContext }
          : null;

        // ── 4. Translate ──────────────────────────────────────────────────
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: message.original_text,
            targetLanguage,
            mode: 'translate',
            context_type: contextType,
            context,
            history,
          }),
        });

        if (cancelled) return;

        if (!res.ok) {
          console.error('Translate API failed:', await res.text());
          setError(true);
          setTranslatedText(message.original_text);
          return;
        }

        const result = await res.json();

        if (cancelled) return;

        const finalText = result?.translated_text || message.original_text;
        setTranslatedText(finalText);

        // ── 5. Cache result ───────────────────────────────────────────────
        supabase
          .from('message_translations')
          .upsert(
            {
              message_id: message.id,
              language: targetLanguage,
              translated_text: finalText,
              tenant_id: CHAT_APP_TENANT_ID,
              prompt_version: PROMPT_VERSION,
            },
            { onConflict: 'message_id,language' }
          )
          .then(({ error }) => {
            if (error) console.error('Cache upsert error:', error);
          });

        // ── 6. Apply inferences to sender's profile (fire and forget) ─────
        // Pass result.detected_language so the dialect consistency guard can
        // reject e.g. 'es-AR' being written to an English speaker's profile.
        if (result?.inferences) {
          applyInferences(message.sender_id, result.inferences, senderProfile, result.detected_language);
        }
      } catch (err) {
        console.error('Translation error:', err);
        if (!cancelled) {
          setError(true);
          setTranslatedText(message.original_text);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    run();
    return () => { cancelled = true; };
  }, [message.id, targetLanguage]);

  return (
    <div className={`flex ${isSender ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 ${
          isSender ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-900'
        }`}
      >
        <p className="text-sm">
          {loading ? '...' : translatedText}
        </p>

        {error && (
          <p className="mt-1 text-xs opacity-70 italic">
            ⚠ Translation failed — showing original
          </p>
        )}

        {translatedText !== message.original_text && (
          <p className="mt-1 text-xs opacity-60">
            {message.original_text}
          </p>
        )}
      </div>
    </div>
  );
}

/*
========================================================
🚀 MAIN APP
========================================================
*/
export default function App() {
  const [username, setUsername] = useState(
    localStorage.getItem('chat_username') || ''
  );
  const [userProfile, setUserProfile] = useState(() => {
    const stored = localStorage.getItem('chat_user_profile');
    return stored ? JSON.parse(stored) : null;
  });
  const [tempName, setTempName] = useState('');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [contextType, setContextType] = useState('casual');

  /*
  ========================================================
  LOGIN
  ========================================================
  */
  async function handleJoin() {
    if (!tempName.trim()) return;

    const user_id = tempName.trim();

    // Get or create user_profiles row
    let { data } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('user_id', user_id)
      .maybeSingle();

    if (!data) {
      const { data: inserted } = await supabase
        .from('user_profiles')
        .insert([{
          user_id,
          display_name: user_id,
          default_language: 'en',
          tenant_id: CHAT_APP_TENANT_ID,
        }])
        .select()
        .single();
      data = inserted;
    }

    // Ensure a linguistic profile row exists for this user.
    // On conflict (returning user) this is a no-op thanks to ignoreDuplicates.
    await supabase
      .from('user_linguistic_profiles')
      .upsert(
        { user_id, tenant_id: CHAT_APP_TENANT_ID },
        { onConflict: 'user_id,tenant_id', ignoreDuplicates: true }
      );

    localStorage.setItem('chat_username', user_id);
    localStorage.setItem('chat_user_profile', JSON.stringify(data));

    setUsername(user_id);
    setUserProfile(data);
  }

  /*
  ========================================================
  LOAD MESSAGES
  ========================================================
  */
  useEffect(() => {
    if (!username) return;

    supabase
      .from('messages')
      .select('*')
      .order('created_at', { ascending: true })
      .then(({ data }) => setMessages(data || []));

    const channel = supabase
      .channel('messages')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => setMessages((prev) => [...prev, payload.new])
      )
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [username]);

  /*
  ========================================================
  CHANGE PREFERRED LANGUAGE
  ========================================================
  */
  async function handleLanguageChange(e) {
    const newLang = e.target.value;
    await supabase
      .from('user_profiles')
      .update({ default_language: newLang })
      .eq('user_id', username);
    const updated = { ...userProfile, default_language: newLang };
    setUserProfile(updated);
    localStorage.setItem('chat_user_profile', JSON.stringify(updated));
  }

  /*
  ========================================================
  SEND MESSAGE
  ========================================================
  */
  async function sendMessage() {
    if (!input.trim()) return;

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: input, mode: 'detect' }),
      });

      const detection = res.ok ? await res.json() : null;

      // If detect confidence is low (Spanglish, mixed-language, ambiguous),
      // fall back to the sender's own preferred language rather than guessing.
      // Threshold 0.85: below this the detection is too uncertain to act on.
      const DETECT_CONFIDENCE_THRESHOLD = 0.85;
      const detectedLang = normalizeLang(detection?.detected_language);
      const detectedConf = detection?.confidence ?? 1.0; // legacy: if no confidence field, trust it
      const sourceLang =
        detectedLang && detectedConf >= DETECT_CONFIDENCE_THRESHOLD
          ? detectedLang
          : (userProfile?.default_language || 'unknown');

      await supabase.from('messages').insert([{
        sender_id: username,
        original_text: input,
        source_language: sourceLang,
        tenant_id: CHAT_APP_TENANT_ID,
      }]);

      setInput('');
    } catch (err) {
      console.error('Send error:', err);
    }
  }

  /*
  ========================================================
  LOGIN UI
  ========================================================
  */
  if (!username) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="p-6 border rounded space-y-3">
          <input
            className="block w-full border px-2 py-1"
            placeholder="Username"
            value={tempName}
            onChange={(e) => setTempName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
          />
          <button
            className="w-full bg-blue-500 text-white px-4 py-1 rounded"
            onClick={handleJoin}
          >
            Join
          </button>
        </div>
      </main>
    );
  }

  /*
  ========================================================
  CHAT UI
  ========================================================
  */
  return (
    <main className="min-h-screen flex items-center justify-center">
      {/* Build marker — bottom-left, shows git commit hash stamped at deploy time */}
      <div className="fixed bottom-2 left-2 text-xs text-gray-400 font-mono select-none">
        {__COMMIT_HASH__}
      </div>

      <div className="w-full max-w-md h-[80vh] flex flex-col border">

        {/* Header: username + language picker + context type picker */}
        <div className="p-3 border-b flex items-center justify-between gap-2">
          <span className="font-medium text-sm">{username}</span>
          <div className="flex gap-2">
            <select
              className="text-xs border rounded px-1 py-0.5"
              value={userProfile?.default_language || 'en'}
              onChange={handleLanguageChange}
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
            <select
              className="text-xs border rounded px-1 py-0.5"
              value={contextType}
              onChange={(e) => setContextType(e.target.value)}
            >
              {CONTEXT_TYPES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Message list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((msg, index) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              userProfile={userProfile}
              userId={username}
              contextType={contextType}
              history={messages.slice(Math.max(0, index - 3), index)}
            />
          ))}
        </div>

        {/* Input */}
        <div className="p-3 border-t flex gap-2">
          <input
            className="flex-1 border px-2"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
          />
          <button
            className="bg-blue-500 text-white px-3 py-1 rounded"
            onClick={sendMessage}
          >
            Send
          </button>
        </div>

      </div>
    </main>
  );
}
