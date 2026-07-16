import { useState, useEffect } from 'react';
import { X, Search, Link as LinkIcon } from 'lucide-react';
import { addConversationMember, createConversationInvite } from '../lib/conversations';
import { findAccountByEmail, searchAccountsByUsername } from '../lib/discovery';
import { avatarColor, initials } from './ConversationList';

/*
========================================================
➕ ADD-TO-CONVERSATION MODAL  (formerly "invite by link")
========================================================
Primary path (Spec 11): search a username/email and add the person directly to the
conversation via add_conversation_member (migration 023) — server-side block-gated,
idempotent, promotes a direct chat to a group past 2 members, and posts an
"X was added to the conversation" system message that App renders in the thread.

Secondary path: a demoted "Copy invite link instead" text button that mints a
conversation-kind invite (create_invite) and copies the join link — for sharing with
someone the adder can't discover directly. Redemption (?join=<token>) is handled in App.

Search reuses the discovery RPCs (discovery.js): an email-looking input hits
find_account_by_email (exact match), otherwise a username prefix search (≥3 chars).
Both return only public handles and already filter cross-tenant / blocked / non-
discoverable accounts server-side.

Props:
  open              — boolean
  conversationId    — id to add into / mint the invite against
  conversationName  — display name for the heading
  existingMemberIds — account_ids already in the conversation (hidden from results)
  onAdded           — () => void; called after a successful add (App reloads the list)
  onClose           — () => void
*/
export default function InviteModal({
  open,
  conversationId,
  conversationName,
  existingMemberIds = [],
  onAdded,
  onClose,
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [picked, setPicked] = useState([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

  // Copy-link fallback (minted lazily on first use).
  const [link, setLink] = useState('');
  const [linkLoading, setLinkLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Reset on open.
  useEffect(() => {
    if (open) {
      setQuery(''); setResults([]); setPicked([]); setAdding(false); setError('');
      setLink(''); setLinkLoading(false); setCopied(false);
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
      // Drop anyone already in the conversation or already picked.
      const exclude = new Set([...existingMemberIds, ...picked.map((p) => p.account_id)]);
      setResults((data || []).filter((d) => !exclude.has(d.account_id)));
    }, 250);

    return () => { cancelled = true; clearTimeout(t); };
  }, [query, picked, existingMemberIds]);

  if (!open) return null;

  function pick(d) { setPicked((p) => [...p, d]); setQuery(''); setResults([]); }
  function unpick(id) { setPicked((p) => p.filter((x) => x.account_id !== id)); }

  async function handleAdd() {
    if (picked.length < 1 || adding || !conversationId) return;
    setAdding(true);
    setError('');
    try {
      for (const p of picked) {
        const { error } = await addConversationMember(conversationId, p.account_id);
        if (error) throw error;
      }
      onAdded?.();
      onClose();
    } catch (err) {
      console.error('add_conversation_member failed:', err);
      setError(err?.message || 'Could not add them. Try again.');
      setAdding(false);
    }
  }

  async function copyLink() {
    if (!conversationId) return;
    if (link) {
      navigator.clipboard?.writeText(link);
      setCopied(true); setTimeout(() => setCopied(false), 1200);
      return;
    }
    setLinkLoading(true);
    setError('');
    const { data, error } = await createConversationInvite(conversationId);
    setLinkLoading(false);
    if (error || !data) {
      console.error('create_invite failed:', error);
      setError('Could not create an invite link.');
      return;
    }
    const url = `${window.location.origin}/?join=${data}`;
    setLink(url);
    navigator.clipboard?.writeText(url);
    setCopied(true); setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="fixed inset-0 z-40 bg-slate-900/40 flex items-end md:items-center justify-center">
      <div className="bg-white w-full md:max-w-md rounded-t-2xl md:rounded-2xl md:shadow-2xl flex flex-col max-h-[88vh]">
        <header className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-700 flex items-center gap-1" title="Cancel">
            <X size={16} strokeWidth={2.2} />
            Cancel
          </button>
          <h2 className="font-semibold truncate px-2">Add to {conversationName}</h2>
          <button
            disabled={picked.length < 1 || adding}
            onClick={handleAdd}
            className="text-sm font-medium text-violet-600 disabled:text-slate-300"
          >
            {adding ? 'Adding…' : 'Add'}
          </button>
        </header>

        <div className="p-4 space-y-3 overflow-y-auto">
          {/* picked chips */}
          {picked.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {picked.map((p) => (
                <span key={p.account_id} className="inline-flex items-center gap-1 bg-violet-50 text-violet-700 rounded-full pl-2 pr-1 py-0.5 text-xs">
                  {p.display_name}
                  <button onClick={() => unpick(p.account_id)} className="h-4 w-4 grid place-items-center rounded-full hover:bg-violet-100">×</button>
                </span>
              ))}
            </div>
          )}

          <div className="relative">
            <Search size={16} strokeWidth={2.2} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Add by username or email…"
              aria-label="Search by username or email"
              className="w-full rounded-xl border border-slate-300 pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
              autoFocus
            />
          </div>

          {results.length > 0 && (
            <div className="border border-slate-100 rounded-xl divide-y divide-slate-100 overflow-hidden">
              {results.map((d) => (
                <button
                  key={d.account_id}
                  onClick={() => pick(d)}
                  className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-2"
                >
                  <span className={`h-7 w-7 rounded-full grid place-items-center text-white text-xs font-semibold ${avatarColor(d.account_id)}`}>
                    {initials(d.display_name)}
                  </span>
                  <span className="text-sm">
                    {d.display_name} <span className="text-slate-400">@{d.username}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          <p className="text-[11px] text-slate-400">
            Username search needs 3+ characters; email must be exact. Only handles you're allowed to see appear.
          </p>

          {error && <p className="text-xs text-rose-500">{error}</p>}

          {/* secondary: copy-link fallback */}
          <div className="pt-2 border-t border-slate-100">
            <button
              onClick={copyLink}
              disabled={linkLoading || !conversationId}
              className="text-sm text-violet-600 hover:text-violet-700 disabled:text-slate-300 inline-flex items-center gap-1.5"
            >
              <LinkIcon size={15} strokeWidth={2.2} />
              {linkLoading ? 'Creating link…' : copied ? 'Link copied' : 'Copy invite link instead'}
            </button>
            {link && (
              <p className="mt-1 text-[11px] text-slate-400 break-all">{link}</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
