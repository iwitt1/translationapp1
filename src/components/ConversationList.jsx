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
// 12 distinct hues for avatars + group-chat sender attribution. Each pairs an avatar
// background (white initials on it) with a matching saturated text color for the
// sender-name label. Kept to ~12 deliberately: past this, hues stop being
// distinguishable, and because attribution always shows the name + initials too,
// color is reinforcement, not the sole identifier. (Spec 12, 2026-07-16.)
const PALETTE = [
  { bg: 'bg-rose-500',    text: 'text-rose-600' },
  { bg: 'bg-orange-500',  text: 'text-orange-600' },
  { bg: 'bg-amber-600',   text: 'text-amber-700' },
  { bg: 'bg-lime-600',    text: 'text-lime-700' },
  { bg: 'bg-emerald-500', text: 'text-emerald-600' },
  { bg: 'bg-teal-500',    text: 'text-teal-600' },
  { bg: 'bg-cyan-600',    text: 'text-cyan-700' },
  { bg: 'bg-sky-500',     text: 'text-sky-600' },
  { bg: 'bg-indigo-500',  text: 'text-indigo-600' },
  { bg: 'bg-violet-500',  text: 'text-violet-600' },
  { bg: 'bg-fuchsia-500', text: 'text-fuchsia-600' },
  { bg: 'bg-pink-500',    text: 'text-pink-600' },
];

function colorIndex(key = '') {
  const sum = [...String(key)].reduce((a, c) => a + c.charCodeAt(0), 0);
  return sum % PALETTE.length;
}

// Avatar background class for a stable key (a display name, or any string). Back-compat:
// existing callers pass a display name and get a single bg class back.
export function avatarColor(key = '') {
  return PALETTE[colorIndex(key)].bg;
}

// Per-conversation color map: { [account_id]: { bg, text } }, guaranteeing NO two
// members share a color (up to PALETTE.length members). Base color is a stable
// account_id hash; on a collision the later member (by sorted id) bumps to the next
// free slot. Deterministic + stable across reloads; no persistence needed. (Spec 12.)
export function assignConversationColors(memberIds = []) {
  const ids = [...memberIds].sort();
  const used = new Set();
  const map = {};
  for (const id of ids) {
    let idx = colorIndex(id);
    let guard = 0;
    while (used.has(idx) && guard < PALETTE.length) { idx = (idx + 1) % PALETTE.length; guard++; }
    used.add(idx);
    map[id] = PALETTE[idx];
  }
  return map;
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
