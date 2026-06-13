import { useState, useEffect } from 'react';
import { createConversationInvite } from '../lib/conversations';

/*
========================================================
🔗 INVITE MODAL
========================================================
Mints a conversation-kind invite (create_invite via conversations.js) and shows a
copyable join link. Redemption happens elsewhere: a recipient opening
`?join=<token>` triggers redeem_invite in App, which adds them as a member.

The token is minted once, lazily, when the modal opens — so we don't create
dangling invites for conversations the user never actually shares.

Props:
  open             — boolean
  conversationId   — id to mint the invite against
  conversationName — display name for the heading
  onClose          — () => void
*/
export default function InviteModal({ open, conversationId, conversationName, onClose }) {
  const [link, setLink] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open || !conversationId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setLink('');
    setCopied(false);

    createConversationInvite(conversationId).then(({ data, error }) => {
      if (cancelled) return;
      setLoading(false);
      if (error || !data) {
        console.error('create_invite failed:', error);
        setError('Could not create an invite link. Try again.');
        return;
      }
      // `data` is the token text (RPC returns text).
      setLink(`${window.location.origin}/?join=${data}`);
    });

    return () => { cancelled = true; };
  }, [open, conversationId]);

  if (!open) return null;

  function copy() {
    if (!link) return;
    navigator.clipboard?.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="fixed inset-0 z-40 bg-slate-900/40 flex items-end md:items-center justify-center">
      <div className="bg-white w-full md:max-w-sm rounded-t-2xl md:rounded-2xl md:shadow-2xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Invite to {conversationName}</h2>
          <button onClick={onClose} className="h-8 w-8 grid place-items-center rounded-full hover:bg-slate-100" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="text-sm text-slate-500 mb-3">
          Anyone in your space with this link can join.
        </p>

        <div className="flex gap-2">
          <input
            readOnly
            value={loading ? 'Generating link…' : (error || link)}
            className="flex-1 rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-600"
          />
          <button
            onClick={copy}
            disabled={!link}
            className="px-3 rounded-xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:bg-slate-300"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
