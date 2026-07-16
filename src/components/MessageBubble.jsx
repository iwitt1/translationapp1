import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { CHAT_APP_TENANT_ID } from '../lib/config';
import { PROMPT_VERSION } from '../../lib/translatePrompt.js';
import { API_URL, INFER_API_URL, PROFILE_INFERENCE_ENABLED, normalizeLang, apiFetch } from '../lib/translation';
import { initials } from './ConversationList';

/*
========================================================
💬 MESSAGE BUBBLE
========================================================
Renders one message. Two display modes:

  • SENT (isSender): the viewer wrote it — show the original text as-is, no
    translation and no "Original:" sub-line (they don't need their own words
    echoed back). Optimistic state (pending / failed + retry) lives here.

  • RECEIVED + translated: the big bubble is the TRANSLATION (into the viewer's
    preferred language); a secondary caret-toggled line shows the source text
    (no "Original" label — the caret is the affordance), CSS-truncated to a
    single line, expandable on tap (full text on hover via title). If no
    translation was needed (same language / no source), the sub-line is omitted.

The translate + cache + server-side profile-inference logic is unchanged from the
pre-Phase-3 app (it already worked); only the display markup and the optimistic
states are new.

Props:
  message           — message row (or an optimistic temp row: { pending } | { failed })
  linguisticProfile — viewer's user_linguistic_profiles row (for targetLanguage)
  userId            — viewer's auth.uid() (uuid)
  contextType       — 'casual'|'dating'|'professional'|'academic'
  history           — last N messages before this one (context injection)
  showSenderName    — true in group conversations for received messages
  senderName        — display name to show above the bubble when showSenderName
  senderColor       — { bg, text } Tailwind classes for this sender's avatar + name
                      (from the per-conversation de-collided palette; group only)
  isRunStart        — true when this message starts a new run from its sender; the
                      avatar + name render only on run starts, continuations indent
  onRetry           — () => void; called when the user taps a failed send to resend
  onTranslated      — (messageId, translatedText) => void; fired when a received
                      message's translation resolves (cache hit or fresh), so the
                      list can show the translated text as the conversation preview
*/
export default function MessageBubble({
  message,
  linguisticProfile,
  userId,
  contextType,
  history,
  showSenderName = false,
  senderName = '',
  senderColor = null,
  isRunStart = true,
  onRetry,
  onTranslated,
}) {
  const [translatedText, setTranslatedText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  const origRef = useRef(null);

  const targetLanguage = linguisticProfile?.preferred_language || 'en';
  const isSender = message.sender_id === userId;

  useEffect(() => {
    // Optimistic rows (no real id yet) and the viewer's own messages never get
    // translated — short-circuit so we don't fire the API for them.
    if (isSender) {
      setTranslatedText(message.original_text);
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function run() {
      try {
        setLoading(true);
        setError(false);

        const sourceLang = message.source_language;

        // ── 1. No translation needed ──────────────────────────────────────
        const normSource = normalizeLang(sourceLang);
        const normTarget = normalizeLang(targetLanguage);
        if (!sourceLang || normSource === normTarget) {
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
          onTranslated?.(message.id, cached.translated_text);
          return;
        }

        // ── 3. Fetch sender's linguistic profile (for context injection) ──
        const { data: senderProfile } = await supabase
          .from('user_linguistic_profiles')
          .select('*')
          .eq('user_id', message.sender_id)
          .eq('tenant_id', CHAT_APP_TENANT_ID)
          .maybeSingle();

        const userContext = {};
        if (senderProfile?.dialect_region)       userContext.dialect         = senderProfile.dialect_region;
        if (senderProfile?.formality_preference) userContext.formality       = senderProfile.formality_preference;
        if (senderProfile?.gender_signal)        userContext.gender          = senderProfile.gender_signal;
        if (senderProfile?.known_languages?.length) userContext.known_languages = senderProfile.known_languages;

        const context = Object.keys(userContext).length > 0
          ? { user: userContext }
          : null;

        // ── 4. Translate ──────────────────────────────────────────────────
        const res = await apiFetch(API_URL, {
          text: message.original_text,
          targetLanguage,
          mode: 'translate',
          context_type: contextType,
          context,
          history,
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
        onTranslated?.(message.id, finalText);

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
        if (PROFILE_INFERENCE_ENABLED && result?.inferences) {
          apiFetch(INFER_API_URL, {
            message_id: message.id,
            inferences: result.inferences,
            detected_language: normalizeLang(result.detected_language),
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

  // The "Original:" sub-line shows the source text only when a translation
  // actually replaced it (received messages that were translated).
  const showOriginal =
    !isSender && !loading && !error && translatedText !== message.original_text;

  // Only offer the expand caret when the single-line preview is actually clipped
  // — a caret that reveals nothing is a dead control. Measure the collapsed line
  // and re-check on width changes (the bubble is percentage-width). While
  // expanded we keep the last-known truncation (the collapsed line isn't mounted).
  useLayoutEffect(() => {
    if (!showOriginal || expanded) return;
    const el = origRef.current;
    if (!el) return;
    const measure = () => setIsTruncated(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showOriginal, expanded, translatedText, message.original_text]);

  const attributed = showSenderName && !isSender;
  const avatarBg = senderColor?.bg || 'bg-slate-400';
  const nameText = senderColor?.text || 'text-slate-500';

  const bubbleBlock = (
    <>
        <div
          className={`rounded-2xl px-3.5 py-2 ${
            isSender
              ? 'bg-violet-600 text-white rounded-br-md'
              : 'bg-white border border-slate-200 rounded-bl-md'
          }${message.pending ? ' opacity-60' : ''}${message.failed ? ' opacity-70' : ''}`}
        >
          <div className="text-sm whitespace-pre-wrap break-words">
            {isSender ? message.original_text : (loading ? '…' : translatedText)}
          </div>

          {error && (
            <div className="mt-1 text-[11px] italic opacity-70">
              ⚠ Translation failed — showing original
            </div>
          )}

          {/* Original-text preview — the caret is the affordance (no label) and
              only appears when the collapsed line is truncated: right when
              collapsed, down when expanded (disclosure convention). If the
              original fits on one line, it's shown plain with no caret. */}
          {showOriginal && (
            expanded ? (
              <div
                className="mt-1 text-[11px] text-slate-400 cursor-pointer select-none"
                onClick={() => setExpanded(false)}
                title={message.original_text}
                role="button"
                tabIndex={0}
                aria-label="Collapse original text"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(false); }
                }}
              >
                <div className="flex items-start gap-1">
                  <ChevronDown size={12} strokeWidth={2.2} className="shrink-0 mt-0.5" />
                  <div className="min-w-0">{message.original_text}</div>
                </div>
              </div>
            ) : (
              <div
                className={`mt-1 text-[11px] text-slate-400 select-none ${isTruncated ? 'cursor-pointer' : ''}`}
                onClick={isTruncated ? () => setExpanded(true) : undefined}
                title={message.original_text}
                role={isTruncated ? 'button' : undefined}
                tabIndex={isTruncated ? 0 : undefined}
                aria-label={isTruncated ? 'Show original text' : undefined}
                onKeyDown={isTruncated ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(true); }
                } : undefined}
              >
                <div className="flex items-baseline gap-1">
                  {isTruncated && <ChevronRight size={12} strokeWidth={2.2} className="shrink-0 self-center" />}
                  <span ref={origRef} className="min-w-0 truncate">{message.original_text}</span>
                </div>
              </div>
            )
          )}
        </div>

        {/* timestamp + send-state / retry */}
        <div className={`text-[10px] text-slate-400 mt-0.5 ${isSender ? 'text-right mr-1' : 'ml-1'}`}>
          {message.failed ? (
            <button
              className="text-rose-500 hover:underline"
              onClick={onRetry}
            >
              ⚠ Failed — tap to retry
            </button>
          ) : (
            <>
              {formatTime(message.created_at)}
              {isSender && (
                <span className="ml-1">{message.pending ? '· sending…' : '· sent'}</span>
              )}
            </>
          )}
        </div>
    </>
  );

  // Group-received: colored initials avatar + colored name, rendered only on the
  // first message of a run; continuation messages indent past the avatar column so
  // they align under the run. Sent + direct-received keep the original layout.
  if (attributed) {
    return (
      <div className="flex justify-start">
        <div className="flex gap-2 max-w-[85%] md:max-w-[70%]">
          <div className="w-7 shrink-0">
            {isRunStart && (
              <div className={`h-7 w-7 rounded-full grid place-items-center text-white text-[11px] font-semibold ${avatarBg}`}>
                {initials(senderName)}
              </div>
            )}
          </div>
          <div className="min-w-0">
            {isRunStart && (
              <div className={`text-[11px] mb-0.5 ml-1 font-medium ${nameText}`}>{senderName}</div>
            )}
            {bubbleBlock}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isSender ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[78%] md:max-w-[65%]">
        {bubbleBlock}
      </div>
    </div>
  );
}

// Short, locale-aware clock time. Optimistic rows carry a real ISO created_at
// too, so this works before the DB row lands.
function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
