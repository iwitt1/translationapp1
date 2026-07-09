import { useState, useEffect, useRef, useMemo } from 'react';
import { Settings } from 'lucide-react';
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
import SettingsModal from './components/SettingsModal';

/*
========================================================
🚀 MAIN APP (Phase 3 — conversation-aware)
========================================================
Orchestrator only. It owns:
  • the auth state machine (loading / email_input / onboarding / chat)
  • the conversation list + the active conversation
  • the active thread's messages + the two realtime subscriptions (messages + memberships)
  • optimistic send + DB reconcile
  • the new-conversation / invite modals and leave/context-type actions

Everything that knows the server contract lives in the data layer (lib/conversations.js,
lib/discovery.js, lib/translation.js) and the presentational pieces are in components/.
This keeps the chat UI decoupled from the translation engine surface (the standing
layer-separation rule) and from the exact RPC shapes.

Realtime model: TWO membership-scoped subscriptions (migrations 018 + 022 make
realtime RLS-scoped, so a channel only ever delivers rows from conversations the
viewer is a member of — no client-side filtering).
  1. messages-INSERT — updates the active thread (if the row belongs to it) and
     refreshes the matching list row's snippet/time/unread. If the row's
     conversation isn't in the list yet (fresh, or previously an empty "ghost"),
     it reloads the list so the conversation appears live on its first message.
  2. conversation_members-INSERT (own rows) — fires when the viewer is added to a
     conversation; reloads the list so a created-with-you / invited-you thread
     shows up without a manual refresh.
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
  const [onboardingUsername, setOnboardingUsername] = useState('');
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
  const [showSettings, setShowSettings] = useState(false);

  const userId = session?.user?.id ?? null;
  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) || null,
    [conversations, activeId]
  );

  // activeId in a ref so the realtime callback (registered once) reads the latest.
  const activeIdRef = useRef(null);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  // Mirror the conversation list into a ref so the once-registered realtime
  // callbacks can tell whether an incoming row belongs to a conversation that's
  // already in the list (without re-registering on every list change).
  const conversationsRef = useRef([]);
  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);

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
        setShowSettings(false);
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

    // Username: required at onboarding (product call 2026-07-07). Client-side
    // pre-check mirrors change_username()'s rules for fast feedback; the RPC
    // remains the enforcement point (reserved words, taken handles, etc.).
    const username = onboardingUsername.trim();
    if (!username) { setOnboardingError('Username is required.'); return; }
    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      setOnboardingError('Username must be 3–20 characters: lowercase letters, numbers, and underscores only.');
      return;
    }

    setOnboardingLoading(true);
    const { error } = await supabase.rpc('complete_onboarding', {
      p_display_name: onboardingName.trim(),
      p_preferred_language: onboardingLang,
      p_username: username,
    });
    setOnboardingLoading(false);
    if (error) {
      console.error('complete_onboarding error:', error);
      // Map change_username()'s exceptions to friendly copy.
      const msg = error.message || '';
      if (msg.includes('username unavailable')) {
        setOnboardingError('That username is taken or reserved. Try another.');
      } else if (msg.includes('invalid characters') || msg.includes('length must be')) {
        setOnboardingError('Username must be 3–20 characters: lowercase letters, numbers, and underscores only.');
      } else {
        setOnboardingError(msg || 'Something went wrong. Please try again.');
      }
      return;
    }
    await loadProfile(session.user.id);
  }

  async function handleSignOut() {
    // Confirmation guard — a mis-tap (esp. on mobile, where this sits near the
    // conversation kebab) shouldn't force a logout + magic-link round-trip.
    // Cheap first step; relocating sign-out into a menu is still deferred
    // (roadmap Phase 2.2 / parking-lot "Sign-out control").
    if (!window.confirm('Sign out of jistchat?')) return;
    await supabase.auth.signOut();
  }

  /* ====================== CONVERSATIONS ====================== */
  // Load + enrich the conversation list. Each row gets a display name, member
  // names, a snippet from the latest message, and an activity timestamp.
  async function loadConversations(keepId = activeId) {
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
        hasMessages: !!last,
        unread: 0,
      };
    }));

    // Hide empty "ghost" conversations (created but no message sent yet) so they
    // don't clutter the other member's list — EXCEPT the one the user is actively
    // viewing (keepId), so a creator can still type into a fresh thread. Once a
    // message exists the conversation surfaces live: onRealtimeInsert reloads the
    // list when a message lands for a conversation not currently shown (migration
    // 022 + the conversation_members channel handle the being-added case).
    const visible = enriched
      .filter((c) => c.hasMessages || c.id === keepId)
      .sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
    setConversations(visible);
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

    // Two channels, both membership-scoped by RLS (migrations 018 + 022):
    //  1. messages     — new messages in conversations I'm in (drives the thread
    //     + list snippet/unread; also surfaces a NOT-yet-listed conversation on
    //     its first message via onRealtimeInsert's reload-on-unknown).
    //  2. conversation_members — I was added to a conversation (direct someone
    //     starts with me, group I'm created into, invite I redeem elsewhere);
    //     reload the list so it appears without a manual refresh.
    const messagesChannel = supabase
      .channel('messages-stream')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => onRealtimeInsert(payload.new))
      .subscribe();

    const membersChannel = supabase
      .channel('conversation-members-stream')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'conversation_members', filter: `account_id=eq.${userId}` },
        () => loadConversations(activeIdRef.current))
      .subscribe();

    return () => {
      supabase.removeChannel(messagesChannel);
      supabase.removeChannel(membersChannel);
    };
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
    // First message in a conversation I'm a member of but that isn't in my list
    // yet (a fresh conversation, or one previously hidden as an empty "ghost"):
    // pull the list so it appears live. The membership channel handles being
    // added; this handles the conversation becoming non-empty.
    if (!conversationsRef.current.some((c) => c.id === row.conversation_id)) {
      loadConversations(activeIdRef.current);
      return;
    }

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
    await loadConversations(newId); // keep the just-created (still empty) thread visible for the creator
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
                className="block w-full border border-slate-300 px-3 py-2 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
                type="email"
                placeholder="you@example.com"
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                autoFocus
              />
              {authError && <p className="text-xs text-rose-500">{authError}</p>}
              <button type="submit" className="w-full bg-violet-600 text-white px-4 py-2 rounded-xl text-sm hover:bg-violet-700">
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
                className="block w-full border border-slate-300 px-3 py-2 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
                type="text"
                placeholder="How others will see you"
                value={onboardingName}
                onChange={(e) => setOnboardingName(e.target.value)}
                maxLength={50}
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">Username</label>
              <input
                className="block w-full border border-slate-300 px-3 py-2 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
                type="text"
                placeholder="how_people_find_you"
                value={onboardingUsername}
                onChange={(e) => setOnboardingUsername(e.target.value.toLowerCase().replace(/\s/g, '_'))}
                maxLength={20}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <p className="text-[11px] text-slate-500 mt-1">Usernames can be changed once per year.</p>
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">Your language</label>
              <select
                className="block w-full border border-slate-300 px-3 py-2 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-500"
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
              className="w-full bg-violet-600 text-white px-4 py-2 rounded-xl text-sm hover:bg-violet-700 disabled:opacity-50"
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
    <main className="h-screen bg-slate-100 flex flex-col">
      {/* Persistent top app bar (mobile + desktop). The account entry (gear →
          Settings) lives here; the build/deploy marker was moved off the chat
          chrome into the Settings modal footer (no longer overlays the UI). */}
      <header className="shrink-0 flex items-center justify-between gap-2 px-4 h-12 bg-white border-b border-slate-200">
        <div className="flex items-center gap-1.5">
          <svg width="26" height="26" viewBox="0 0 512 512" aria-hidden="true" className="shrink-0">
            <defs>
              <clipPath id="app-bar-bubble-clip">
                <path d="M153.6,83.78c-46.27,0-83.78,37.51-83.78,83.78h0v93.09c0,46.27,37.51,83.78,83.78,83.78h204.8c46.27,0,83.78-37.51,83.78-83.78h0v-93.09c0-46.27-37.51-83.78-83.78-83.78h-204.8ZM225,344.44l-75,60.56,30,-60.56h45Z"/>
              </clipPath>
            </defs>
            <g clipPath="url(#app-bar-bubble-clip)">
              <path fill="#7C3AED" d="M-46.55,46.55l302.55,18.62c74.47,65.16,74.47,130.33,0,190.84s-74.47,125.67,0,209.45H-46.55V46.55Z"/>
              <path fill="#0D9488" d="M558.55,46.55l-302.55,18.62c74.47,65.16,74.47,130.33,0,190.84s-74.47,125.67,0,209.45h302.55V46.55Z"/>
            </g>
            <g fill="#EDE9FE">
              <path d="M116.48,128.67h95.1c4.63,0,8.39,3.13,8.39,6.98h0c0,3.86-3.76,6.98-8.39,6.98h-95.1c-4.63,0-8.39-3.13-8.39-6.98h0c0-3.86,3.76-6.98,8.39-6.98Z"/>
              <path d="M115.07,164.72h51.2c3.86,0,6.98,3.13,6.98,6.98h0c0,3.86-3.13,6.98-6.98,6.98h-51.2c-3.86,0-6.98-3.13-6.98-6.98h0c0-3.86,3.13-6.98,6.98-6.98Z"/>
              <path d="M113.86,200.76h76.98c3.19,0,5.77,3.13,5.77,6.98h0c0,3.86-2.58,6.98-5.77,6.98h-76.98c-3.19,0-5.77-3.13-5.77-6.98h0c0-3.86,2.58-6.98,5.77-6.98Z"/>
            </g>
            <g fill="#fff">
              <path d="M335.13,214.11h0c5.14,0,9.31,4.17,9.31,9.31v74.47c0,5.14-4.17,9.31-9.31,9.31h0c-5.14,0-9.31-4.17-9.31-9.31v-74.47c0-5.14,4.17-9.31,9.31-9.31Z"/>
              <path d="M371.17,240.03h0c5.14,0,9.31,5.34,9.31,11.92v59.62c0,6.58-4.17,11.92-9.31,11.92h0c-5.14,0-9.31-5.34-9.31-11.92v-59.62c0-6.58,4.17-11.92,9.31-11.92Z"/>
              <path d="M407.22,207.13h0c5.14,0,9.31,4.17,9.31,9.31v65.16c0,5.14-4.17,9.31-9.31,9.31h0c-5.14,0-9.31-4.17-9.31-9.31v-65.16c0-5.14,4.17-9.31,9.31-9.31Z"/>
            </g>
          </svg>
          <span className="hidden sm:inline font-bold text-sm" style={{ fontFamily: "'Outfit', sans-serif" }}>Jistchat</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="hidden sm:inline truncate max-w-[12rem]">{profile?.display_name}</span>
          <button
            onClick={() => setShowSettings(true)}
            className="h-8 w-8 grid place-items-center rounded-full hover:bg-slate-100 text-slate-500 hover:text-slate-800"
            title="Settings"
            aria-label="Settings"
          >
            <Settings size={18} strokeWidth={2.2} />
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 w-full max-w-6xl mx-auto bg-white overflow-hidden flex md:my-4 md:rounded-2xl md:shadow-xl">
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
      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        profile={profile}
        linguisticProfile={linguisticProfile}
        onSaved={() => loadProfile(userId)}
        onSignOut={handleSignOut}
      />
    </main>
  );
}
