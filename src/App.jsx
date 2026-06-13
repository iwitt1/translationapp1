import { useState, useEffect, useRef, useMemo } from 'react';
import { supabase } from './lib/supabase';
import { LANGUAGES } from './lib/vocabularies';
import { detectSourceLanguage } from './lib/translation';
import {
  listConversations,
  listConversationMembers,
  listMessages,
  insertMessage,
  createConversation,
  leaveConversation,
  setConversationContextType,
  redeemInvite,
} from './lib/conversations';
import ConversationList from './components/ConversationList';
import ConversationView from './components/ConversationView';
import NewConversationModal from './components/NewConversationModal';
import InviteModal from './components/InviteModal';

/*
========================================================
🚀 MAIN APP (Phase 3 — conversation-aware)
========================================================
Orchestrator only. It owns:
  • the auth state machine (loading / email_input / onboarding / chat)
  • the conversation list + the active conversation
  • the active thread's messages + the single realtime subscription
  • optimistic send + DB reconcile
  • the new-conversation / invite modals and leave/context-type actions

Everything that knows the server contract lives in the data layer (lib/conversations.js,
lib/discovery.js, lib/translation.js) and the presentational pieces are in components/.
This keeps the chat UI decoupled from the translation engine surface (the standing
layer-separation rule) and from the exact RPC shapes.

Realtime model: ONE messages-INSERT subscription. Migration 018 made realtime
membership-scoped, so the channel only ever delivers rows from conversations the
viewer is a member of — we don't filter client-side. Each row updates the active
thread (if it belongs to it) and always refreshes the matching list row's
snippet/time/unread.
*/
export default function App() {
  // ── auth ──
  const [authView, setAuthView] = useState('loading');
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [linguisticProfile, setLinguistic] = useState(null);

  // ── email screen ──
  const [authEmail, setAuthEmail] = useState('');
  const [authSent, setAuthSent] = useState(false);
  const [authError, setAuthError] = useState('');

  // ── onboarding ──
  const [onboardingName, setOnboardingName] = useState('');
  const [onboardingLang, setOnboardingLang] = useState('en');
  const [onboardingError, setOnboardingError] = useState('');
  const [onboardingLoading, setOnboardingLoading] = useState(false);

  // ── chat ──
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [mobilePane, setMobilePane] = useState('list'); // 'list' | 'thread'

  // ── modals ──
  const [showNew, setShowNew] = useState(false);
  const [showInvite, setShowInvite] = useState(false);

  const userId = session?.user?.id ?? null;
  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) || null,
    [conversations, activeId]
  );

  // activeId in a ref so the realtime callback (registered once) reads the latest.
  const activeIdRef = useRef(null);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  /* ====================== AUTH ====================== */
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) { setSession(session); loadProfile(session.user.id); }
      else setAuthView('email_input');
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) { setSession(session); loadProfile(session.user.id); }
      else {
        setSession(null); setProfile(null); setLinguistic(null);
        setConversations([]); setActiveId(null); setMessages([]);
        setAuthView('email_input');
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  async function loadProfile(uid) {
    const { data: p, error } = await supabase
      .from('profiles').select('*').eq('id', uid).maybeSingle();

    if (error) { console.error('loadProfile error:', error); setAuthView('email_input'); return; }
    setProfile(p);

    if (!p || p.status === 'pending') { setAuthView('onboarding'); return; }

    if (p.status === 'active') {
      const { data: lp } = await supabase
        .from('user_linguistic_profiles').select('*').eq('user_id', uid).maybeSingle();
      setLinguistic(lp);
      setAuthView('chat');
    }
  }

  async function handleMagicLink(e) {
    e.preventDefault();
    setAuthError('');
    if (!authEmail.trim()) return;
    const { error } = await supabase.auth.signInWithOtp({
      email: authEmail.trim(),
      options: { emailRedirectTo: window.location.origin, shouldCreateUser: true },
    });
    if (error) setAuthError(error.message);
    else setAuthSent(true);
  }

  async function handleOnboarding(e) {
    e.preventDefault();
    setOnboardingError('');
    if (!onboardingName.trim()) { setOnboardingError('Display name is required.'); return; }
    if (onboardingName.trim().length > 50) { setOnboardingError('Display name must be 50 characters or fewer.'); return; }

    setOnboardingLoading(true);
    const { error } = await supabase.rpc('complete_onboarding', {
      p_display_name: onboardingName.trim(),
      p_preferred_language: onboardingLang,
    });
    setOnboardingLoading(false);
    if (error) { console.error('complete_onboarding error:', error); setOnboardingError(error.message || 'Something went wrong. Please try again.'); return; }
    await loadProfile(session.user.id);
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  /* ====================== CONVERSATIONS ====================== */
  // Load + enrich the conversation list. Each row gets a display name, member
  // names, a snippet from the latest message, and an activity timestamp.
  async function loadConversations() {
    const { data: convs, error } = await listConversations();
    if (error) { console.error('listConversations error:', error); return; }
    if (!convs?.length) { setConversations([]); return; }

    const enriched = await Promise.all(convs.map(async (c) => {
      const { data: members } = await listConversationMembers(c.id);
      const memberRows = members || [];
      const memberNames = {};
      memberRows.forEach((m) => { memberNames[m.account_id] = m.profiles?.display_name || 'Unknown'; });
      const otherNames = memberRows
        .filter((m) => m.account_id !== userId)
        .map((m) => m.profiles?.display_name || 'Unknown');

      const { data: last } = await supabase
        .from('messages')
        .select('original_text, created_at')
        .eq('conversation_id', c.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const displayName = c.kind === 'group'
        ? (c.title || 'Group')
        : (otherNames[0] || 'Conversation');

      return {
        ...c,
        displayName,
        otherMembers: otherNames,
        memberCount: memberRows.length,
        memberNames,
        snippet: last?.original_text || '',
        lastActivity: last?.created_at || c.updated_at,
        unread: 0,
      };
    }));

    enriched.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
    setConversations(enriched);
  }

  // On entering chat: load conversations, redeem a pending ?join invite, and open
  // the single realtime messages subscription.
  useEffect(() => {
    if (authView !== 'chat' || !userId) return;

    (async () => {
      // Redeem an invite link if present, then drop the param from the URL.
      const params = new URLSearchParams(window.location.search);
      const joinToken = params.get('join');
      if (joinToken) {
        const { error } = await redeemInvite(joinToken);
        if (error) console.error('redeem_invite failed:', error);
        params.delete('join');
        const qs = params.toString();
        window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
      }
      await loadConversations();
    })();

    const channel = supabase
      .channel('messages-stream')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => onRealtimeInsert(payload.new))
      .subscribe();

    return () => supabase.removeChannel(channel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authView, userId]);

  // Load the active thread's messages whenever the selection changes.
  useEffect(() => {
    if (!activeId) { setMessages([]); return; }
    let cancelled = false;
    listMessages(activeId).then(({ data, error }) => {
      if (cancelled) return;
      if (error) { console.error('listMessages error:', error); setMessages([]); return; }
      setMessages(data || []);
    });
    return () => { cancelled = true; };
  }, [activeId]);

  // Realtime INSERT handler — see the model note at the top of the file.
  function onRealtimeInsert(row) {
    if (row.conversation_id === activeIdRef.current) {
      setMessages((prev) => {
        if (prev.some((m) => m.id === row.id)) return prev; // dedupe by id
        // swap a matching pending optimistic temp (our own send echoed back)
        const idx = prev.findIndex(
          (m) => m.pending && m.sender_id === row.sender_id && m.original_text === row.original_text
        );
        if (idx !== -1) { const next = prev.slice(); next[idx] = row; return next; }
        return [...prev, row];
      });
    }

    setConversations((prev) => {
      const next = prev.map((c) => {
        if (c.id !== row.conversation_id) return c;
        const isActive = row.conversation_id === activeIdRef.current;
        const mine = row.sender_id === userId;
        return {
          ...c,
          snippet: row.original_text,
          lastActivity: row.created_at,
          unread: isActive || mine ? c.unread : (c.unread || 0) + 1,
        };
      });
      next.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
      return next;
    });
  }

  function openConversation(id) {
    setActiveId(id);
    setMobilePane('thread');
    // clear unread locally
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));
  }

  function backToList() {
    setMobilePane('list');
  }

  /* ====================== SEND (optimistic + reconcile) ====================== */
  async function handleSend(text) {
    if (!activeConversation || !userId) return;
    const convId = activeConversation.id;
    const tempId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const createdAt = new Date().toISOString();

    const optimistic = {
      id: tempId,
      conversation_id: convId,
      sender_id: userId,
      original_text: text,
      source_language: 'unknown',
      created_at: createdAt,
      pending: true,
    };

    // 1) show instantly + bump the list
    setMessages((prev) => [...prev, optimistic]);
    bumpConversation(convId, text, createdAt);

    // 2) detect language (best-effort), then insert
    const sourceLang = await detectSourceLanguage(text, linguisticProfile?.preferred_language || 'unknown');
    const { data: real, error } = await insertMessage({
      conversationId: convId,
      senderId: userId,
      originalText: text,
      sourceLanguage: sourceLang,
    });

    if (error || !real) {
      console.error('insertMessage failed:', error);
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, pending: false, failed: true } : m)));
      return;
    }

    // 3) reconcile: replace the temp with the DB row (unless realtime already added it)
    setMessages((prev) => {
      const withoutTemp = prev.filter((m) => m.id !== tempId);
      if (withoutTemp.some((m) => m.id === real.id)) return withoutTemp;
      return [...withoutTemp, real];
    });
  }

  async function handleRetry(message) {
    // Drop the failed bubble and resend its text through the normal path.
    setMessages((prev) => prev.filter((m) => m.id !== message.id));
    await handleSend(message.original_text);
  }

  // Optimistically move a conversation to the top with a new snippet/time.
  function bumpConversation(convId, snippet, ts) {
    setConversations((prev) => {
      const next = prev.map((c) => (c.id === convId ? { ...c, snippet, lastActivity: ts } : c));
      next.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
      return next;
    });
  }

  /* ====================== CONVERSATION ACTIONS ====================== */
  async function handleCreateConversation({ kind, memberIds, title, contextType }) {
    const { data: newId, error } = await createConversation({ kind, memberIds, title, contextType });
    if (error) throw error;
    setShowNew(false);
    await loadConversations();
    if (newId) openConversation(newId);
  }

  async function handleSetContextType(value) {
    if (!activeConversation) return;
    const convId = activeConversation.id;
    // optimistic local update
    setConversations((prev) => prev.map((c) => (c.id === convId ? { ...c, context_type: value } : c)));
    const { error } = await setConversationContextType(convId, value);
    if (error) {
      console.error('set_conversation_context_type failed:', error);
      // reload to resync on failure
      loadConversations();
    }
  }

  async function handleLeave() {
    if (!activeConversation) return;
    const convId = activeConversation.id;
    const { error } = await leaveConversation(convId);
    if (error) { console.error('leave_conversation failed:', error); return; }
    setActiveId(null);
    setMobilePane('list');
    setConversations((prev) => prev.filter((c) => c.id !== convId));
  }

  /* ====================== SCREENS ====================== */
  if (authView === 'loading') {
    return (
      <main className="min-h-screen flex items-center justify-center text-slate-400 text-sm">
        Loading…
      </main>
    );
  }

  if (authView === 'email_input') {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-100">
        <div className="p-6 bg-white border border-slate-200 rounded-2xl shadow-sm space-y-3 w-80">
          <h1 className="font-semibold text-lg">Sign in</h1>
          {authSent ? (
            <p className="text-sm text-slate-600">
              Check your email for a sign-in link. You can close this tab.
            </p>
          ) : (
            <form onSubmit={handleMagicLink} className="space-y-3">
              <input
                className="block w-full border border-slate-300 px-3 py-2 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                type="email"
                placeholder="you@example.com"
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                autoFocus
              />
              {authError && <p className="text-xs text-rose-500">{authError}</p>}
              <button type="submit" className="w-full bg-indigo-600 text-white px-4 py-2 rounded-xl text-sm hover:bg-indigo-700">
                Send sign-in link
              </button>
            </form>
          )}
        </div>
      </main>
    );
  }

  if (authView === 'onboarding') {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-100">
        <div className="p-6 bg-white border border-slate-200 rounded-2xl shadow-sm space-y-4 w-80">
          <h1 className="font-semibold text-lg">Set up your profile</h1>
          <form onSubmit={handleOnboarding} className="space-y-3">
            <div>
              <label className="block text-xs text-slate-600 mb-1">Display name</label>
              <input
                className="block w-full border border-slate-300 px-3 py-2 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                type="text"
                placeholder="How others will see you"
                value={onboardingName}
                onChange={(e) => setOnboardingName(e.target.value)}
                maxLength={50}
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">Your language</label>
              <select
                className="block w-full border border-slate-300 px-3 py-2 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                value={onboardingLang}
                onChange={(e) => setOnboardingLang(e.target.value)}
              >
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>
            {onboardingError && <p className="text-xs text-rose-500">{onboardingError}</p>}
            <button
              type="submit"
              disabled={onboardingLoading}
              className="w-full bg-indigo-600 text-white px-4 py-2 rounded-xl text-sm hover:bg-indigo-700 disabled:opacity-50"
            >
              {onboardingLoading ? 'Saving…' : 'Continue'}
            </button>
          </form>
        </div>
      </main>
    );
  }

  /* ====================== CHAT ====================== */
  return (
    <main className="min-h-screen bg-slate-100">
      {/* Build marker — git commit hash stamped at deploy time */}
      <div className="fixed bottom-2 left-2 z-50 text-xs text-slate-400 font-mono select-none">
        {__COMMIT_HASH__}
      </div>

      <div className="mx-auto max-w-6xl h-screen md:h-[92vh] md:my-[4vh] md:rounded-2xl md:shadow-xl bg-white overflow-hidden flex">
        <ConversationList
          conversations={conversations}
          activeId={activeId}
          onSelect={openConversation}
          onNew={() => setShowNew(true)}
          className={mobilePane === 'thread' ? 'hidden md:flex' : 'flex'}
        />

        {activeConversation ? (
          <ConversationView
            conversation={activeConversation}
            messages={messages}
            linguisticProfile={linguisticProfile}
            userId={userId}
            memberNames={activeConversation.memberNames}
            onBack={backToList}
            onSend={handleSend}
            onRetry={handleRetry}
            onSetContextType={handleSetContextType}
            onInvite={() => setShowInvite(true)}
            onLeave={handleLeave}
            className={mobilePane === 'list' ? 'hidden md:flex' : 'flex'}
          />
        ) : (
          <section className="hidden md:flex flex-1 items-center justify-center text-sm text-slate-400">
            Select a conversation, or start a new one.
          </section>
        )}
      </div>

      {/* signed-in identity + sign out, top-right corner */}
      <div className="fixed top-3 right-4 z-50 flex items-center gap-2 text-xs text-slate-500">
        <span className="hidden sm:inline truncate max-w-[12rem]">{profile?.display_name}</span>
        <button onClick={handleSignOut} className="hover:text-slate-800" title="Sign out">Sign out</button>
      </div>

      <NewConversationModal
        open={showNew}
        onClose={() => setShowNew(false)}
        onCreate={handleCreateConversation}
      />
      <InviteModal
        open={showInvite}
        conversationId={activeConversation?.id}
        conversationName={activeConversation?.displayName || 'this conversation'}
        onClose={() => setShowInvite(false)}
      />
    </main>
  );
}
