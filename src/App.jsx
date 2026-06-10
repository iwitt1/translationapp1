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

const INFER_API_URL = import.meta.env.DEV
  ? 'http://localhost:3001/api/v1/infer-profile'
  : '/api/v1/infer-profile';

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

// Profile inference is now SERVER-SIDE (api/v1/infer-profile + server/lib/inferProfile.js).
// The client fires the translate response's `inferences` to that endpoint, keyed by
// message_id; the server derives the authoritative sender, applies the guards, and
// writes the profile atomically under a privileged connection that bypasses RLS.
//
// This flag gates the fire-and-forget POST. It exists so the call can be killed
// without a redeploy if the endpoint misbehaves. (Was CLIENT_SIDE_INFERENCE_ENABLED,
// which gated a now-removed client-side write path that RLS blocked entirely.)
const PROFILE_INFERENCE_ENABLED = true;

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
💬 MESSAGE BUBBLE
========================================================
Props:
  message          — the message row from Supabase (sender_id is now uuid)
  linguisticProfile — logged-in user's user_linguistic_profiles row (for targetLanguage)
  userId           — logged-in user's auth.uid() (uuid)
  contextType      — 'casual'|'dating'|'professional'|'academic'
  history          — last N messages before this one (for context injection)
*/
function MessageBubble({ message, linguisticProfile, userId, contextType, history }) {
  const [translatedText, setTranslatedText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const targetLanguage = linguisticProfile?.preferred_language || 'en';
  const isSender = message.sender_id === userId;

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        setLoading(true);
        setError(false);

        const sourceLang = message.source_language;

        // ── 1. No translation needed ──────────────────────────────────────
        // Skip if: (a) source matches target (normalised), (b) no source
        // detected, or (c) this is the viewer's own message.
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

        // ── 6. Apply inferences to sender's profile (server-side) ─────────
        // Fire-and-forget POST to the inference endpoint. We send message_id (NOT
        // a sender id): the server looks up the message row and derives the
        // authoritative sender itself, so a client can't write to an arbitrary
        // user's profile (trust boundary — decisions.md 2026-06-10). detected_language
        // is the live translate-time detection, used by the server's dialect guard
        // as a fallback anchor when the stored source_language is 'unknown'.
        // We don't await or read the response — profile updates must never block
        // or affect message rendering.
        if (PROFILE_INFERENCE_ENABLED && result?.inferences) {
          fetch(INFER_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message_id: message.id,
              inferences: result.inferences,
              detected_language: normalizeLang(result.detected_language),
            }),
          }).catch((err) => console.error('infer-profile POST failed:', err));
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
Auth state machine (authView):
  'loading'     — initial; waiting for getSession() to resolve
  'email_input' — not authenticated; show magic-link email form. The
                  "check your email" confirmation is the same view gated on
                  the authSent boolean (not a separate authView state).
  'onboarding'  — authenticated + status='pending'; show onboarding form
  'chat'        — authenticated + status='active'; show chat UI

State notes:
  - session      — Supabase Auth session (null = not signed in)
  - profile      — profiles row for the current user
  - linguisticProfile — user_linguistic_profiles row (has preferred_language)
  - userId       — session.user.id alias for readability (uuid string)
*/
export default function App() {
  const [authView, setAuthView]           = useState('loading');
  const [session, setSession]             = useState(null);
  const [profile, setProfile]             = useState(null);
  const [linguisticProfile, setLinguistic] = useState(null);

  // Email input screen
  const [authEmail, setAuthEmail]         = useState('');
  const [authSent, setAuthSent]           = useState(false);
  const [authError, setAuthError]         = useState('');

  // Onboarding form
  const [onboardingName, setOnboardingName] = useState('');
  const [onboardingLang, setOnboardingLang] = useState('en');
  const [onboardingError, setOnboardingError] = useState('');
  const [onboardingLoading, setOnboardingLoading] = useState(false);

  // Chat state
  const [messages, setMessages]           = useState([]);
  const [input, setInput]                 = useState('');
  const [contextType, setContextType]     = useState('casual');

  /*
  ========================================================
  AUTH STATE LISTENER
  ========================================================
  */
  useEffect(() => {
    // Resolve initial session (handles page-load with existing session or
    // magic-link redirect — Supabase sets the session from the URL hash before
    // this fires, so SIGNED_IN fires via onAuthStateChange when the hash is consumed)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        setSession(session);
        loadProfile(session.user.id);
      } else {
        setAuthView('email_input');
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (session) {
          setSession(session);
          loadProfile(session.user.id);
        } else {
          // SIGNED_OUT
          setSession(null);
          setProfile(null);
          setLinguistic(null);
          setAuthView('email_input');
        }
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  /*
  ========================================================
  LOAD PROFILE
  ========================================================
  Fetches the profiles row and (if active) the linguistic profile.
  Routes to the appropriate auth view based on status.
  */
  async function loadProfile(userId) {
    const { data: p, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      console.error('loadProfile error:', error);
      setAuthView('email_input');
      return;
    }

    setProfile(p);

    if (!p || p.status === 'pending') {
      setAuthView('onboarding');
      return;
    }

    if (p.status === 'active') {
      const { data: lp } = await supabase
        .from('user_linguistic_profiles')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      setLinguistic(lp);
      setAuthView('chat');
    }
  }

  /*
  ========================================================
  MAGIC LINK
  ========================================================
  */
  async function handleMagicLink(e) {
    e.preventDefault();
    setAuthError('');
    if (!authEmail.trim()) return;

    const { error } = await supabase.auth.signInWithOtp({
      email: authEmail.trim(),
      options: {
        // Redirect back to wherever the app is hosted (works for localhost,
        // Vercel Preview, and production without hardcoding URLs).
        emailRedirectTo: window.location.origin,
        shouldCreateUser: true,
      },
    });

    if (error) {
      setAuthError(error.message);
    } else {
      setAuthSent(true);
    }
  }

  /*
  ========================================================
  ONBOARDING SUBMIT
  ========================================================
  Calls the complete_onboarding() SECURITY DEFINER RPC which:
    - sets profiles.status = 'active', profiles.display_name, profiles.onboarding_completed_at
    - creates the user_linguistic_profiles row with preferred_language
  Then re-loads the profile to transition to the chat view.
  */
  async function handleOnboarding(e) {
    e.preventDefault();
    setOnboardingError('');

    if (!onboardingName.trim()) {
      setOnboardingError('Display name is required.');
      return;
    }
    if (onboardingName.trim().length > 50) {
      setOnboardingError('Display name must be 50 characters or fewer.');
      return;
    }

    setOnboardingLoading(true);
    const { error } = await supabase.rpc('complete_onboarding', {
      p_display_name:       onboardingName.trim(),
      p_preferred_language: onboardingLang,
    });
    setOnboardingLoading(false);

    if (error) {
      console.error('complete_onboarding error:', error);
      setOnboardingError(error.message || 'Something went wrong. Please try again.');
      return;
    }

    // Re-load profile — this transitions authView to 'chat'
    await loadProfile(session.user.id);
  }

  /*
  ========================================================
  SIGN OUT
  ========================================================
  */
  async function handleSignOut() {
    await supabase.auth.signOut();
    // onAuthStateChange fires → clears state → routes to 'email_input'
  }

  /*
  ========================================================
  LOAD MESSAGES
  ========================================================
  */
  useEffect(() => {
    if (authView !== 'chat') return;

    supabase
      .from('messages')
      .select('*')
      .eq('tenant_id', CHAT_APP_TENANT_ID)
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
  }, [authView]);

  /*
  ========================================================
  SEND MESSAGE
  ========================================================
  */
  async function sendMessage() {
    if (!input.trim() || !session) return;

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: input, mode: 'detect' }),
      });

      const detection = res.ok ? await res.json() : null;

      const DETECT_CONFIDENCE_THRESHOLD = 0.85;
      const detectedLang = normalizeLang(detection?.detected_language);
      const detectedConf = detection?.confidence ?? 1.0;
      const sourceLang =
        detectedLang && detectedConf >= DETECT_CONFIDENCE_THRESHOLD
          ? detectedLang
          : (linguisticProfile?.preferred_language || 'unknown');

      await supabase.from('messages').insert([{
        sender_id:       session.user.id,  // uuid (auth.uid() on the server)
        original_text:   input,
        source_language: sourceLang,
        tenant_id:       CHAT_APP_TENANT_ID,
      }]);

      setInput('');
    } catch (err) {
      console.error('Send error:', err);
    }
  }

  // ── userId alias ─────────────────────────────────────────────────────────
  const userId = session?.user?.id ?? null;

  /*
  ========================================================
  LOADING SCREEN
  ========================================================
  */
  if (authView === 'loading') {
    return (
      <main className="min-h-screen flex items-center justify-center text-gray-400 text-sm">
        Loading…
      </main>
    );
  }

  /*
  ========================================================
  EMAIL INPUT (MAGIC LINK) SCREEN
  ========================================================
  */
  if (authView === 'email_input') {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="p-6 border rounded space-y-3 w-80">
          <h1 className="font-semibold text-lg">Sign in</h1>
          {authSent ? (
            <p className="text-sm text-gray-600">
              Check your email for a sign-in link. You can close this tab.
            </p>
          ) : (
            <form onSubmit={handleMagicLink} className="space-y-3">
              <input
                className="block w-full border px-2 py-1 rounded text-sm"
                type="email"
                placeholder="you@example.com"
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                autoFocus
              />
              {authError && (
                <p className="text-xs text-red-500">{authError}</p>
              )}
              <button
                type="submit"
                className="w-full bg-blue-500 text-white px-4 py-1.5 rounded text-sm"
              >
                Send sign-in link
              </button>
            </form>
          )}
        </div>
      </main>
    );
  }

  /*
  ========================================================
  ONBOARDING SCREEN
  ========================================================
  Shown when authenticated but status = 'pending'.
  Collects display name + preferred language.
  */
  if (authView === 'onboarding') {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="p-6 border rounded space-y-4 w-80">
          <h1 className="font-semibold text-lg">Set up your profile</h1>
          <form onSubmit={handleOnboarding} className="space-y-3">
            <div>
              <label className="block text-xs text-gray-600 mb-1">
                Display name
              </label>
              <input
                className="block w-full border px-2 py-1 rounded text-sm"
                type="text"
                placeholder="How others will see you"
                value={onboardingName}
                onChange={(e) => setOnboardingName(e.target.value)}
                maxLength={50}
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs text-gray-600 mb-1">
                Your language
              </label>
              <select
                className="block w-full border px-2 py-1 rounded text-sm"
                value={onboardingLang}
                onChange={(e) => setOnboardingLang(e.target.value)}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>
            {onboardingError && (
              <p className="text-xs text-red-500">{onboardingError}</p>
            )}
            <button
              type="submit"
              disabled={onboardingLoading}
              className="w-full bg-blue-500 text-white px-4 py-1.5 rounded text-sm disabled:opacity-50"
            >
              {onboardingLoading ? 'Saving…' : 'Continue'}
            </button>
          </form>
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

        {/* Header: display name + context type picker + sign out */}
        <div className="p-3 border-b flex items-center justify-between gap-2">
          <span className="font-medium text-sm truncate">
            {profile?.display_name || '…'}
          </span>
          <div className="flex gap-2 items-center">
            <select
              className="text-xs border rounded px-1 py-0.5"
              value={contextType}
              onChange={(e) => setContextType(e.target.value)}
            >
              {CONTEXT_TYPES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
            <button
              className="text-xs text-gray-400 hover:text-gray-700"
              onClick={handleSignOut}
              title="Sign out"
            >
              Sign out
            </button>
          </div>
        </div>

        {/* Message list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((msg, index) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              linguisticProfile={linguisticProfile}
              userId={userId}
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
