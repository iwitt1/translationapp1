// ============================================================================
// settings.js — data-access layer for the account settings screen.
// ============================================================================
// One place that knows the server contract for everything the SettingsModal
// edits: the user's account_settings row (privacy/discoverability), their
// display name, username, and preferred language. Same pattern as
// conversations.js / discovery.js — UI components never call supabase.rpc /
// .from() directly.
//
// Split of enforcement:
//   • account_settings — direct table read/UPDATE, gated by the own-row RLS
//     policies from migration 007 (account_settings_select_own / _update_own).
//   • display name / language / username — go through SECURITY DEFINER RPCs
//     (set_display_name, set_preferred_language, change_username) so validation
//     lives server-side in a single enforcement point.
//
// Each fn returns the raw Supabase `{ data, error }` (no throwing), matching the
// rest of the data layer.
// ============================================================================

import { supabase } from './supabase';

// account_settings own row: { discoverable_by_email, discoverable_by_username, allow_dms_from, ... }
export async function getAccountSettings() {
  return supabase
    .from('account_settings')
    .select('discoverable_by_email, discoverable_by_username, allow_dms_from')
    .eq('account_id', (await supabase.auth.getUser()).data.user?.id)
    .maybeSingle();
}

// Patch the discoverability toggles. RLS (account_settings_update_own) scopes
// the write to the caller's own row; we still filter by account_id so the
// update targets exactly one row.
export async function updateDiscoverability({ discoverable_by_username, discoverable_by_email }) {
  const uid = (await supabase.auth.getUser()).data.user?.id;
  return supabase
    .from('account_settings')
    .update({
      discoverable_by_username,
      discoverable_by_email,
      updated_at: new Date().toISOString(),
    })
    .eq('account_id', uid);
}

// change_username(p_new_username) — the sole username-change path (migration
// 020/010). Enforces charset/length/reserved/non-reuse + the 1/365-day cadence
// and self-revert. Errors surface as { error } with a .message we map to copy.
export async function changeUsername(newUsername) {
  return supabase.rpc('change_username', { p_new_username: newUsername });
}

// set_display_name(p_display_name) — validated display-name change (migration 021).
export async function setDisplayName(name) {
  return supabase.rpc('set_display_name', { p_display_name: name });
}

// set_preferred_language(p_language) — validated translation-target change (migration 021).
export async function setPreferredLanguage(code) {
  return supabase.rpc('set_preferred_language', { p_language: code });
}

// Is the caller allowed to change their username right now? Mirrors
// change_username()'s cadence rule so the UI can grey the control out before a
// round-trip: the first change from a system_generated handle is free; after a
// user_set change, at most one per 365 days.
//
// Returns { eligible: boolean, availableOn: Date|null }.
export function usernameChangeEligibility(profile) {
  if (!profile || profile.username_source !== 'user_set') {
    return { eligible: true, availableOn: null };
  }
  const last = profile.username_last_changed_at
    ? new Date(profile.username_last_changed_at)
    : null;
  if (!last) return { eligible: true, availableOn: null };

  const availableOn = new Date(last.getTime());
  availableOn.setDate(availableOn.getDate() + 365);
  return { eligible: Date.now() >= availableOn.getTime(), availableOn };
}
