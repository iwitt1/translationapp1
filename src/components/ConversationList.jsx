import { SquarePen } from 'lucide-react';
import { contextTypeLabel } from '../lib/vocabularies';

/*
========================================================
🗂  CONVERSATION LIST (sidebar)
========================================================
The left pane: the viewer's conversations, newest-activity first. On mobile this
is the whole screen until a conversation is opened; on desktop it's a fixed-width
rail beside the thread.

Props:
  conversations — array of enriched rows:
      { id, kind, title, context_type, displayName, otherMembers, memberCount,
        snippet, lastActivity (ISO|null), unread }
  activeId      — currently-open conversation id (highlighted on desktop)
  onSelect      — (id) => void
  onNew         — () => void  (open the New-conversation modal)
*/
export default function ConversationList({ conversations, activeId, onSelect, onNew, className = '' }) {
  return (
    <aside className={`w-full md:w-[360px] md:border-r border-slate-200 flex-col shrink-0 h-full ${className}`}>
      <header className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Messages</h1>
        <button
          onClick={onNew}
          className="h-9 w-9 grid place-items-center rounded-full bg-violet-600 text-white hover:bg-violet-700"
          title="New conversation"
          aria-label="New conversation"
        >
          <SquarePen size={18} strokeWidth={2.2} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        {conversations.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-400">
            No conversations yet. Tap + to start one.
          </p>
        ) : (
          conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={`w-full text-left px-3 py-3 flex gap-3 items-center hover:bg-slate-50 ${
                c.id === activeId ? 'md:bg-violet-50' : ''
              }`}
            >
              <div className="relative shrink-0">
                <div className={`h-11 w-11 rounded-full grid place-items-center text-white font-semibold ${avatarColor(c.displayName)}`}>
                  {c.kind === 'group' ? '#' : initials(c.displayName)}
                </div>
                {c.kind === 'group' && (
                  <span className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-white grid place-items-center text-[9px] text-slate-500 border border-slate-200">
                    {c.memberCount}
                  </span>
                )}
              </div>

              <div className="min-w-0 flex-1">
                {/* No read/unread marker by design — a reliable one needs a
                    persistent read cursor (parking-lot "Unread state"). */}
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium truncate">{c.displayName}</span>
                  <span className="text-[11px] text-slate-400 shrink-0">{shortTime(c.lastActivity)}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-slate-500 truncate">{c.snippet || 'No messages yet'}</span>
                </div>
                <span className="inline-block mt-1 text-[10px] uppercase tracking-wide text-slate-400">
                  {contextTypeLabel(c.context_type) || c.context_type}
                </span>
              </div>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}

// ── small presentational helpers (shared shape with the mockup) ──────────────
const PALETTE = ['bg-rose-500', 'bg-violet-500', 'bg-emerald-500', 'bg-amber-500', 'bg-sky-500', 'bg-fuchsia-500'];

export function avatarColor(s = '') {
  const sum = [...s].reduce((a, c) => a + c.charCodeAt(0), 0);
  return PALETTE[sum % PALETTE.length];
}

export function initials(s = '') {
  return s.split(' ').map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
}

// Compact relative-ish label for the list (today → clock time, else date).
function shortTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
