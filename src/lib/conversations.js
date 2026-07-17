// ============================================================================
// conversations.js — data-access layer for Phase 3 conversations.
// ============================================================================
// One place that knows the shape of the conversation RPCs and tables. UI components
// import these instead of calling supabase.rpc / .from('conversations') directly, so
// the exact server contract (arg names, return values, tenant scoping) lives in a
// single auditable spot. Mirrors the project's chat/translation layer-separation rule
// and keeps the eventual B2B surface (these RPCs) decoupled from React.
//
// Every function returns the raw Supabase result `{ data, error }` (no throwing) so
// callers handle failures explicitly — matching the existing App.jsx convention.
//
// RLS does the authorization: conversations / messages SELECT is membership-scoped
// (migrations 017/018), so the list/read queries below need no manual tenant or
// membership filter beyond ordering — the policies return only rows the caller may see.
// ============================================================================

import { supabase } from './supabase';
import { CHAT_APP_TENANT_ID } from './config';

// ── RPC wrappers ────────────────────────────────────────────────────────────
// Signatures verified against migration 017 (amended by 019). Arg names are the
// Postgres parameter names; getting these wrong is a silent no-op or an error.

// create_conversation(p_kind, p_member_ids, p_title, p_context_type) → uuid
// kind: 'direct' (exactly one other member, deduped) | 'group' (always-new).
// Returns the conversation id (existing one on a direct dedupe-hit).
export async function createConversation({ kind, memberIds, title = null, contextType = 'casual' }) {
  return supabase.rpc('create_conversation', {
    p_kind: kind,
    p_member_ids: memberIds,
    p_title: title,
    p_context_type: contextType,
  });
}

// leave_conversation(p_conversation_id) → void. Soft-leave (sets left_at); no-op-safe.
export async function leaveConversation(conversationId) {
  return supabase.rpc('leave_conversation', { p_conversation_id: conversationId });
}

// set_conversation_context_type(p_conversation_id, p_context_type) → void.
// Caller must be an active member. p_context_type ∈ engine set (migration 019).
export async function setConversationContextType(conversationId, contextType) {
  return supabase.rpc('set_conversation_context_type', {
    p_conversation_id: conversationId,
    p_context_type: contextType,
  });
}

// set_conversation_title(p_conversation_id, p_title) → void (migration 024).
// Caller must be an active member; empty/whitespace clears the title (NULL), and the
// UI falls back to the member-list name.
export async function setConversationTitle(conversationId, title) {
  return supabase.rpc('set_conversation_title', {
    p_conversation_id: conversationId,
    p_title: title,
  });
}

// create_invite(p_kind, p_max_uses, p_expires_at, p_target_conversation_id) → token text.
// We always mint 'conversation'-kind invites here. Defaults: multi-use, no expiry.
export async function createConversationInvite(conversationId, { maxUses = null, expiresAt = null } = {}) {
  return supabase.rpc('create_invite', {
    p_kind: 'conversation',
    p_max_uses: maxUses,
    p_expires_at: expiresAt,
    p_target_conversation_id: conversationId,
  });
}

// redeem_invite(p_token) → 'joined' (conversation invite) | 'accepted' (contact invite).
export async function redeemInvite(token) {
  return supabase.rpc('redeem_invite', { p_token: token });
}

// add_conversation_member(p_conversation_id, p_account_id) → void. Adds a discovered
// account to a conversation the caller is an active member of (migration 023). Server-
// side: block-gated, idempotent, promotes direct→group past 2 members + posts a
// 'member_added' system message. The search-to-add path (vs the copy-link invite).
export async function addConversationMember(conversationId, accountId) {
  return supabase.rpc('add_conversation_member', {
    p_conversation_id: conversationId,
    p_account_id: accountId,
  });
}

// ── Queries ───────────────────────────────────────────────────────────────

// Conversations the caller is an active member of (RLS-scoped), newest activity first.
export async function listConversations() {
  return supabase
    .from('conversations')
    .select('id, kind, title, context_type, created_by, created_at, updated_at')
    .order('updated_at', { ascending: false });
}

// Active members of a conversation, joined to their profile display info.
// RLS lets a member read co-members of conversations they're in (migration 017).
export async function listConversationMembers(conversationId) {
  return supabase
    .from('conversation_members')
    .select('account_id, role, joined_at, left_at, profiles:account_id (display_name)')
    .eq('conversation_id', conversationId)
    .is('left_at', null);
}

// Messages in a conversation, oldest→newest (RLS-scoped to members; migration 018).
export async function listMessages(conversationId) {
  return supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
}

// Insert a message INTO a conversation. The conversation_id is the Phase 3 fix — the
// old global-room insert omitted it. Returns the inserted row (.select().single()) so
// the optimistic-send path can swap its temp row for the real one and dedupe the
// realtime echo by id (no client_id column needed).
export async function insertMessage({ conversationId, senderId, originalText, sourceLanguage }) {
  return supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_id: senderId,
      original_text: originalText,
      source_language: sourceLanguage,
      tenant_id: CHAT_APP_TENANT_ID,
    })
    .select()
    .single();
}
