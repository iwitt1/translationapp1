import { useState, useRef, useEffect } from 'react';
import { ArrowLeft, MoreVertical, UserPlus, Send } from 'lucide-react';
import MessageBubble from './MessageBubble';
import { avatarColor, initials } from './ConversationList';
import { getContextTypes } from '../lib/vocabularies';

/*
========================================================
🧵 CONVERSATION VIEW (thread)
========================================================
Header + message list + composer for the active conversation.

The register/context selector lives in the overflow (⋯) menu (moved out of the
header per the Phase-3 mockup), with a "?" affordance explaining what register
means. Changing it calls back up to App (→ set_conversation_context_type RPC).

The composer is "dumb": it owns only the draft text and calls onSend(text). The
optimistic-insert + DB reconcile lives in App (which owns the messages array), so
that the realtime echo and the insert resolution can be deduped in one place.

Props:
  conversation      — enriched active conversation:
      { id, kind, title, context_type, displayName, otherMembers, memberCount }
  messages          — message rows (incl. optimistic temp rows) for this conversation
  linguisticProfile — viewer's linguistic profile (target language)
  userId            — viewer's auth.uid()
  memberNames       — { [account_id]: display_name } for group sender labels
  onBack            — () => void  (mobile: return to the list)
  onSend            — (text) => void
  onRetry           — (message) => void   (resend a failed optimistic message)
  onSetContextType  — (value) => void
  onInvite          — () => void
  onLeave           — () => void
  onMessageTranslated — (messageId, translatedText) => void; bubbles up from a
                        MessageBubble when its translation resolves (list preview)
*/
export default function ConversationView({
  conversation,
  messages,
  linguisticProfile,
  userId,
  memberNames = {},
  onBack,
  onSend,
  onRetry,
  onSetContextType,
  onInvite,
  onLeave,
  onMessageTranslated,
  className = '',
}) {
  const [draft, setDraft] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const scrollRef = useRef(null);

  // Close the overflow menu on any outside click.
  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  // Auto-scroll to the newest message whenever the thread changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, conversation.id]);

  const isGroup = conversation.kind === 'group';
  const subtitle = isGroup
    ? `${conversation.memberCount} members · ${conversation.otherMembers.join(', ')}`
    : (conversation.otherMembers[0] ? `${conversation.otherMembers[0]}` : 'Direct');

  function submit() {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  }

  return (
    <section className={`flex-1 flex-col min-w-0 h-full ${className}`}>
      {/* ── header ── */}
      <header className="px-3 md:px-4 py-2.5 border-b border-slate-200 flex items-center gap-2">
        <button
          onClick={onBack}
          className="md:hidden h-9 w-9 grid place-items-center rounded-full hover:bg-slate-100"
          aria-label="Back"
          title="Back"
        >
          <ArrowLeft size={20} strokeWidth={2.2} />
        </button>

        <div className={`h-9 w-9 rounded-full grid place-items-center text-sm font-semibold text-white shrink-0 ${avatarColor(conversation.displayName)}`}>
          {isGroup ? '#' : initials(conversation.displayName)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold leading-tight truncate">{conversation.displayName}</div>
          <div className="text-xs text-slate-500 truncate">{subtitle}</div>
        </div>

        {/* overflow menu (holds the register selector) */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="h-9 w-9 grid place-items-center rounded-full hover:bg-slate-100"
            aria-label="More"
            title="More options"
          >
            <MoreVertical size={20} strokeWidth={2.2} />
          </button>

          {menuOpen && (
            <div className="absolute right-0 mt-1 w-64 bg-white border border-slate-200 rounded-xl shadow-lg py-1 z-20 text-sm">
              {/* register / tone selector + explainer */}
              <div className="px-3 py-2">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-xs font-medium text-slate-500">Register</span>
                  <span className="relative group/help">
                    <button
                      className="h-4 w-4 grid place-items-center rounded-full border border-slate-300 text-[10px] text-slate-400 leading-none"
                      aria-label="What is register?"
                      type="button"
                    >
                      ?
                    </button>
                    <span className="invisible group-hover/help:visible group-focus-within/help:visible absolute left-0 top-5 z-30 w-56 bg-slate-900 text-white text-[11px] leading-snug rounded-lg p-2 shadow-lg">
                      Sets the tone the translation aims for — how formal or familiar it sounds.
                      {' '}<b>Casual</b> for friends, <b>Dating</b> warmer, <b>Professional</b> for work,
                      {' '}<b>Academic</b> most formal.
                    </span>
                  </span>
                </div>
                <select
                  value={conversation.context_type}
                  onChange={(e) => onSetContextType(e.target.value)}
                  className="w-full text-xs rounded-lg border border-slate-300 bg-slate-50 px-2.5 py-1.5 font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500"
                >
                  {getContextTypes(conversation.tenant_id).map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>

              <div className="border-t border-slate-100 my-1" />
              <button
                onClick={() => { setMenuOpen(false); onInvite(); }}
                className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2"
              >
                <UserPlus size={16} strokeWidth={2} />
                Invite to conversation
              </button>
              <div className="border-t border-slate-100 my-1" />
              <button
                onClick={() => { setMenuOpen(false); onLeave(); }}
                className="w-full text-left px-3 py-2 hover:bg-slate-50 text-rose-600"
              >
                Leave conversation
              </button>
            </div>
          )}
        </div>
      </header>

      {/* ── messages ── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-slate-50 px-3 md:px-6 py-4 space-y-3">
        {messages.map((m, i) => (
          <MessageBubble
            key={m.id}
            message={m}
            linguisticProfile={linguisticProfile}
            userId={userId}
            contextType={conversation.context_type}
            history={messages.slice(Math.max(0, i - 3), i)}
            showSenderName={isGroup}
            senderName={memberNames[m.sender_id] || ''}
            onRetry={() => onRetry(m)}
            onTranslated={onMessageTranslated}
          />
        ))}
      </div>

      {/* ── composer ── */}
      <div className="border-t border-slate-200 p-3 flex items-end gap-2">
        <textarea
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Message…"
          className="flex-1 resize-none rounded-2xl border border-slate-300 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
        />
        <button
          onClick={submit}
          className="h-10 px-4 rounded-2xl bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 flex items-center gap-1.5"
          aria-label="Send"
          title="Send"
        >
          <Send size={16} strokeWidth={2.2} />
          Send
        </button>
      </div>
    </section>
  );
}
