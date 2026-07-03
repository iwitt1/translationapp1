import { useState, useEffect } from 'react';
import { findAccountByEmail, searchAccountsByUsername } from '../lib/discovery';
import { getContextTypes, DEFAULT_CONTEXT_TYPE } from '../lib/vocabularies';
import { avatarColor, initials } from './ConversationList';

/*
========================================================
➕ NEW CONVERSATION MODAL
========================================================
People-picker → create_conversation. One picked member = a 'direct' conversation
(server dedupes to one thread per pair); two or more = a 'group' (always new),
with an optional title.

Search hits the discovery RPCs (discovery.js): an input that looks like an email
goes to find_account_by_email (exact match); otherwise it's a username prefix
search (the RPC requires ≥3 chars). Both return ONLY public handles and already
filter cross-tenant / blocked / non-discoverable accounts server-side — the UI
shows whatever comes back, unmodified.

Props:
  open      — boolean
  onClose   — () => void
  onCreate  — ({ kind, memberIds, title, contextType }) => Promise<void>
              (App runs the RPC, refreshes the list, opens the new thread)
*/
export default function NewConversationModal({ open, onClose, onCreate }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [picked, setPicked] = useState([]);
  const [title, setTitle] = useState('');
  const [contextType, setContextType] = useState(DEFAULT_CONTEXT_TYPE);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  // Reset everything each time the modal opens.
  useEffect(() => {
    if (open) {
      setQuery(''); setResults([]); setPicked([]); setTitle('');
      setContextType(DEFAULT_CONTEXT_TYPE); setCreating(false); setError('');
    }
  }, [open]);

  // Debounced discovery search.
  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults([]); return; }

    let cancelled = false;
    const t = setTimeout(async () => {
      const looksLikeEmail = q.includes('@') && q.includes('.');
      const { data, error } = looksLikeEmail
        ? await findAccountByEmail(q)
        : await searchAccountsByUsername(q, 8);
      if (cancelled) return;
      if (error) { console.error('discovery search failed:', error); setResults([]); return; }
      // Drop anyone already picked.
      const pickedIds = new Set(picked.map((p) => p.account_id));
      setResults((data || []).filter((d) => !pickedIds.has(d.account_id)));
    }, 250);

    return () => { cancelled = true; clearTimeout(t); };
  }, [query, picked]);

  if (!open) return null;

  const isGroup = picked.length >= 2;

  function pick(d) {
    setPicked((p) => [...p, d]);
    setQuery('');
    setResults([]);
  }
  function unpick(id) {
    setPicked((p) => p.filter((x) => x.account_id !== id));
  }

  async function handleCreate() {
    if (picked.length < 1 || creating) return;
    setCreating(true);
    setError('');
    try {
      await onCreate({
        kind: isGroup ? 'group' : 'direct',
        memberIds: picked.map((p) => p.account_id),
        title: isGroup ? (title.trim() || null) : null,
        contextType,
      });
      // App closes the modal on success.
    } catch (err) {
      console.error('create_conversation failed:', err);
      setError(err?.message || 'Could not create the conversation. Try again.');
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-slate-900/40 flex md:items-center md:justify-center">
      <div className="bg-white w-full md:max-w-md md:rounded-2xl md:shadow-2xl flex flex-col h-full md:h-auto md:max-h-[88vh]">
        <header className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-700">Cancel</button>
          <h2 className="font-semibold">New conversation</h2>
          <button
            disabled={picked.length < 1 || creating}
            onClick={handleCreate}
            className="text-sm font-medium text-violet-600 disabled:text-slate-300"
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </header>

        <div className="p-4 space-y-4 overflow-y-auto">
          {/* picked chips */}
          <div>
            {picked.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {picked.map((p) => (
                  <span key={p.account_id} className="inline-flex items-center gap-1 bg-violet-50 text-violet-700 rounded-full pl-2 pr-1 py-0.5 text-xs">
                    {p.display_name}
                    <button onClick={() => unpick(p.account_id)} className="h-4 w-4 grid place-items-center rounded-full hover:bg-violet-100">×</button>
                  </span>
                ))}
              </div>
            )}

            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Add by username or email…"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
              autoFocus
            />

            {results.length > 0 && (
              <div className="mt-1 border border-slate-100 rounded-xl divide-y divide-slate-100 overflow-hidden">
                {results.map((d) => (
                  <button
                    key={d.account_id}
                    onClick={() => pick(d)}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2"
                  >
                    <span className={`h-7 w-7 rounded-full grid place-items-center text-white text-xs font-semibold ${avatarColor(d.display_name)}`}>
                      {initials(d.display_name)}
                    </span>
                    <span className="text-sm">
                      {d.display_name} <span className="text-slate-400">@{d.username}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}

            <p className="text-[11px] text-slate-400 mt-1">
              Username search needs 3+ characters; email must be exact. Only handles you're allowed to see appear.
            </p>
          </div>

          {/* group title (2+ members) */}
          {isGroup && (
            <div>
              <label className="text-xs font-medium text-slate-500">
                Group name <span className="text-slate-300">(optional)</span>
              </label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Trip planning"
                className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
              />
            </div>
          )}

          {/* starting register */}
          <div>
            <label className="text-xs font-medium text-slate-500">Starting register</label>
            <select
              value={contextType}
              onChange={(e) => setContextType(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-500"
            >
              {getContextTypes().map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>

          {picked.length > 0 && (
            <p className="text-xs text-slate-500">
              {isGroup
                ? `Group conversation · ${picked.length + 1} members`
                : 'Direct conversation · deduped to one thread per pair'}
            </p>
          )}
          {error && <p className="text-xs text-rose-500">{error}</p>}
        </div>
      </div>
    </div>
  );
}
