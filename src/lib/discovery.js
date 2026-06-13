// ============================================================================
// discovery.js — data-access layer for account discovery (people picker).
// ============================================================================
// Wraps the two discovery RPCs the "New conversation" people-picker uses. Same
// pattern as conversations.js: one place that knows the server contract (arg
// names, return shape, tenant scoping) so UI components don't call supabase.rpc
// directly. Both RPCs are SECURITY DEFINER and return ONLY public handles
// (account_id, display_name, username) — never email/phone — and already enforce
// tenant scoping, discoverability settings, active-only, exclude-self, and
// block-hiding (migrations 010 + 011). The UI does no filtering of its own.
//
// Returns the raw Supabase `{ data, error }` (no throwing), matching the rest of
// the data layer.
// ============================================================================

import { supabase } from './supabase';

// find_account_by_email(p_email) → setof (account_id, display_name, username).
// EXACT canonical-email match only (a prefix returns 0 rows). 0 or 1 row.
export async function findAccountByEmail(email) {
  return supabase.rpc('find_account_by_email', { p_email: email });
}

// search_accounts_by_username(p_prefix, p_limit) → setof (account_id, display_name, username).
// Prefix autocomplete; the RPC itself requires prefix length ≥ 3 (returns 0 rows
// below that) and caps p_limit at 20. We pass the prefix verbatim and let the
// server enforce the minimum.
export async function searchAccountsByUsername(prefix, limit = 8) {
  return supabase.rpc('search_accounts_by_username', {
    p_prefix: prefix,
    p_limit: limit,
  });
}
