#!/usr/bin/env node
/**
 * scripts/discovery-gate-test.mjs — Phase 2 Step 4: Discovery gate.
 *
 * Proves the migration-010 discovery layer behaves per policies.md §1–§2, driving
 * the three SECURITY DEFINER RPCs AS real authenticated users (their own JWT) —
 * never the service-role key for assertions (it bypasses RLS and would mask a
 * leak). The service key is used only for one-time fixture setup/reset.
 *
 * Why RPCs and not table reads: account_identifiers SELECT is own-rows-only (007),
 * so cross-user discovery is impossible as a client query by design. The RPCs
 * bypass that RLS deliberately and re-impose the rules in code; this gate proves
 * they do.
 *
 * Coverage:
 *   1. Exact email add (allow) + handle minimization — returns only id/display_name/username
 *   2. Email enumeration impossible — partial email → empty; case-insensitive exact → hit
 *   3. discoverable_by_email respected — toggle off → empty
 *   4. Username autocomplete — prefix hit; <3 chars → empty; '%' is literal (no wildcard injection)
 *   5. discoverable_by_username respected — toggle off → empty
 *   6. Self excluded from discovery results
 *   7. change_username rejects reserved / taken / bad charset / bad length
 *   8. change_username success + side effects (old retired, profile updated, source/clock set)
 *   9. change_username cadence — second change within 365 days → rejected
 *  10. Cross-tenant isolation — a tenant-2 user discovers no tenant-1 accounts
 *
 * Run:  node scripts/discovery-gate-test.mjs
 *   Reuses ./.env.rls-test (same vars as the Step 3 gate). See .env.rls-test.example.
 *   Exit 0 = all assertions passed (gate GREEN). Exit 1 = at least one failed (HARD STOP).
 *
 * SAFETY: mutates the target DB (resets user A's username state, toggles B's
 * discoverability, sets passwords, ensures a throwaway tenant 2 + user C). Refuses
 * to run unless RLS_TEST_CONFIRM_STAGING=yes. NEVER point it at production.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

// ── tiny .env loader (no extra dependency) ───────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env.rls-test');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) {
      process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const {
  STAGING_SUPABASE_URL: SB_URL,
  STAGING_SUPABASE_ANON_KEY: ANON_KEY,
  STAGING_SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  RLS_TEST_A_EMAIL: A_EMAIL,
  RLS_TEST_B_EMAIL: B_EMAIL,
  RLS_TEST_C_EMAIL: C_EMAIL,
  RLS_TEST_PASSWORD: PASSWORD,
  RLS_TEST_CONFIRM_STAGING: CONFIRM,
} = process.env;

const TENANT_1 = '00000000-0000-0000-0000-000000000001'; // sole live tenant
const TENANT_2 = '00000000-0000-0000-0000-000000000002'; // throwaway, for cross-tenant test

// Deterministic test usernames for A so the gate is re-runnable.
const A_SYS    = 'user_testa';   // reset value (system_generated)
const A_CHOSEN = 'chosen_testa'; // the user-set value the change test claims

// ── env + safety guards ──────────────────────────────────────────────────────
const required = {
  STAGING_SUPABASE_URL: SB_URL,
  STAGING_SUPABASE_ANON_KEY: ANON_KEY,
  STAGING_SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  RLS_TEST_A_EMAIL: A_EMAIL,
  RLS_TEST_B_EMAIL: B_EMAIL,
  RLS_TEST_C_EMAIL: C_EMAIL,
  RLS_TEST_PASSWORD: PASSWORD,
};
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`\n✗ Missing required env vars: ${missing.join(', ')}`);
  console.error('  Copy .env.rls-test.example → .env.rls-test and fill it in.\n');
  process.exit(2);
}
if (CONFIRM !== 'yes') {
  console.error('\n✗ Refusing to run: this script mutates the target database.');
  console.error('  Set RLS_TEST_CONFIRM_STAGING=yes ONLY when pointed at staging.');
  console.error(`  Current target: ${SB_URL}\n`);
  process.exit(2);
}

const svc = createClient(SB_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
function userClient() {
  return createClient(SB_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ── result collection ────────────────────────────────────────────────────────
const results = [];
const rec = (cat, name, passed, detail) => results.push({ cat, name, passed, detail });

// RPC returning a row set: assert it contains a target account_id.
async function rpcHasAccount(cat, name, client, fn, args, targetId) {
  const { data, error } = await client.rpc(fn, args);
  const rows = Array.isArray(data) ? data : [];
  rec(cat, name, !error && rows.some((r) => r.account_id === targetId),
    error ? `ERROR ${error.message}` : `${rows.length} rows; ids=[${rows.map((r) => r.account_id?.slice(0, 8)).join(',')}]`);
  return rows;
}
// RPC returning a row set: assert it does NOT contain a target account_id.
async function rpcLacksAccount(cat, name, client, fn, args, targetId) {
  const { data, error } = await client.rpc(fn, args);
  const rows = Array.isArray(data) ? data : [];
  rec(cat, name, !error && !rows.some((r) => r.account_id === targetId),
    error ? `ERROR ${error.message}` : `${rows.length} rows; target ${targetId.slice(0, 8)} ${rows.some((r) => r.account_id === targetId) ? 'PRESENT (bad)' : 'absent'}`);
  return rows;
}
// RPC expected to raise (PostgREST surfaces a function exception as error).
async function rpcErrors(cat, name, client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  rec(cat, name, !!error,
    error ? `denied: ${error.message}` : `UNEXPECTED SUCCESS: ${JSON.stringify(data)}`);
}
// RPC expected to succeed and return an exact scalar.
async function rpcReturns(cat, name, client, fn, args, expected) {
  const { data, error } = await client.rpc(fn, args);
  rec(cat, name, !error && data === expected,
    error ? `ERROR ${error.message}` : `returned ${JSON.stringify(data)} (want ${JSON.stringify(expected)})`);
}

// ── fixtures (service role; idempotent) ──────────────────────────────────────
async function ensureFixtures() {
  // throwaway tenant 2
  const { error: tErr } = await svc.from('tenants')
    .upsert({ id: TENANT_2, name: 'RLS Test Tenant 2' }, { onConflict: 'id' });
  if (tErr) throw new Error(`tenant 2 upsert failed: ${tErr.message}`);

  const { data: list, error: lErr } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (lErr) throw new Error(`admin.listUsers failed: ${lErr.message}`);
  const byEmail = (e) => list.users.find((u) => u.email?.toLowerCase() === e.toLowerCase());

  // A and B must already exist (created via the magic-link flow). Known passwords.
  const ids = {};
  for (const [key, e] of [['A', A_EMAIL], ['B', B_EMAIL]]) {
    const u = byEmail(e);
    if (!u) throw new Error(`expected existing staging user not found: ${e} — create it via the app first`);
    const { error } = await svc.auth.admin.updateUserById(u.id, { password: PASSWORD, email_confirm: true });
    if (error) throw new Error(`set password for ${e} failed: ${error.message}`);
    ids[key] = u.id;
  }

  // A and B must be active + discoverable for discovery to surface them.
  for (const id of [ids.A, ids.B]) {
    await svc.from('profiles').update({ status: 'active' }).eq('id', id);
    await svc.from('account_settings')
      .update({ discoverable_by_email: true, discoverable_by_username: true }).eq('account_id', id);
  }

  // Reset A's username state so the change_username test is re-runnable:
  // wipe A's username identifier rows + any leftover A_CHOSEN, restore A_SYS as
  // a system_generated handle with a null change clock.
  await svc.from('account_identifiers').delete().eq('account_id', ids.A).eq('type', 'username');
  await svc.from('account_identifiers').delete()
    .eq('tenant_id', TENANT_1).eq('type', 'username').in('value', [A_SYS, A_CHOSEN]);
  const { error: insErr } = await svc.from('account_identifiers').insert({
    account_id: ids.A, tenant_id: TENANT_1, type: 'username', value: A_SYS, status: 'active', verified: false,
  });
  if (insErr) throw new Error(`seed A_SYS failed: ${insErr.message}`);
  await svc.from('profiles').update({
    username: A_SYS, username_source: 'system_generated', username_last_changed_at: null,
  }).eq('id', ids.A);

  // C: create if absent (trigger makes a tenant-1 pending profile), re-point to tenant 2.
  let cUser = byEmail(C_EMAIL);
  if (!cUser) {
    const { data, error } = await svc.auth.admin.createUser({ email: C_EMAIL, password: PASSWORD, email_confirm: true });
    if (error) throw new Error(`create user C failed: ${error.message}`);
    cUser = data.user;
  } else {
    await svc.auth.admin.updateUserById(cUser.id, { password: PASSWORD, email_confirm: true });
  }
  for (const [table, col] of [['profiles', 'id'], ['account_identifiers', 'account_id'], ['account_settings', 'account_id']]) {
    const { error } = await svc.from(table).update({ tenant_id: TENANT_2 }).eq(col, cUser.id);
    if (error) throw new Error(`re-point ${table} for C failed: ${error.message}`);
  }
  await svc.from('profiles').update({ status: 'active' }).eq('id', cUser.id);

  // B's current username (needed by the autocomplete + "taken" assertions).
  const { data: bProf, error: bErr } = await svc.from('profiles').select('username').eq('id', ids.B).single();
  if (bErr) throw new Error(`read B username failed: ${bErr.message}`);
  return { ...ids, C: cUser.id, bUsername: bProf.username };
}

async function signIn(email) {
  const client = userClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message} (enable Email/Password on staging)`);
  return { client, id: data.user.id };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nDiscovery gate (Step 4) → ${SB_URL}\n`);
  console.log('Setting up fixtures…');
  const fx = await ensureFixtures();

  console.log('Signing in as A, B, C…');
  const A = await signIn(A_EMAIL);
  const B = await signIn(B_EMAIL);
  const C = await signIn(C_EMAIL);
  if (A.id !== fx.A || B.id !== fx.B || C.id !== fx.C) throw new Error('id mismatch between fixture and sign-in');

  const bPrefix = fx.bUsername.slice(0, 4);

  // 1. Exact email add (allow) + handle minimization
  const r1 = await rpcHasAccount('1. email add (allow)', 'A finds B by exact email', A.client,
    'find_account_by_email', { p_email: B_EMAIL }, B.id);
  const row = r1.find((r) => r.account_id === B.id) || {};
  rec('1. email add (allow)', 'result is handle-minimized (only id/display_name/username)',
    Object.keys(row).sort().join(',') === 'account_id,display_name,username',
    `keys=[${Object.keys(row).join(',')}]`);
  rec('1. email add (allow)', 'result carries no email/phone/other identifier',
    !('email' in row) && !('value' in row) && !('phone' in row),
    `keys=[${Object.keys(row).join(',')}]`);

  // 2. Email enumeration impossible
  await rpcLacksAccount('2. email enumeration (deny)', 'partial email returns no match', A.client,
    'find_account_by_email', { p_email: B_EMAIL.slice(0, 4) }, B.id);
  await rpcHasAccount('2. email enumeration (deny)', 'UPPERCASE email still matches (canonical)', A.client,
    'find_account_by_email', { p_email: B_EMAIL.toUpperCase() }, B.id);

  // 3. discoverable_by_email respected
  await svc.from('account_settings').update({ discoverable_by_email: false }).eq('account_id', B.id);
  await rpcLacksAccount('3. discoverable_by_email', 'B opted out → not found by email', A.client,
    'find_account_by_email', { p_email: B_EMAIL }, B.id);
  await svc.from('account_settings').update({ discoverable_by_email: true }).eq('account_id', B.id);

  // 4. Username autocomplete
  await rpcHasAccount('4. username autocomplete', 'A finds B by username prefix', A.client,
    'search_accounts_by_username', { p_prefix: bPrefix, p_limit: 10 }, B.id);
  await rpcLacksAccount('4. username autocomplete', 'sub-3-char prefix returns nothing', A.client,
    'search_accounts_by_username', { p_prefix: bPrefix.slice(0, 2), p_limit: 10 }, B.id);
  await rpcLacksAccount('4. username autocomplete', "'%' wildcard is literal (no enumeration)", A.client,
    'search_accounts_by_username', { p_prefix: `${bPrefix.slice(0, 2)}%`, p_limit: 50 }, B.id);

  // 5. discoverable_by_username respected
  await svc.from('account_settings').update({ discoverable_by_username: false }).eq('account_id', B.id);
  await rpcLacksAccount('5. discoverable_by_username', 'B opted out → not in autocomplete', A.client,
    'search_accounts_by_username', { p_prefix: bPrefix, p_limit: 10 }, B.id);
  await svc.from('account_settings').update({ discoverable_by_username: true }).eq('account_id', B.id);

  // 6. Self excluded
  await rpcLacksAccount('6. self excluded', 'A does not surface itself in autocomplete', A.client,
    'search_accounts_by_username', { p_prefix: A_SYS.slice(0, 4), p_limit: 10 }, A.id);

  // 7. change_username rejects reserved / taken / bad input
  await rpcErrors('7. change_username (deny)', "'Admin' rejected (reserved; case-folds)", A.client,
    'change_username', { p_new_username: 'Admin' });
  await rpcErrors('7. change_username (deny)', "B's current username rejected (taken)", A.client,
    'change_username', { p_new_username: fx.bUsername });
  await rpcErrors('7. change_username (deny)', "too short (<3) rejected", A.client,
    'change_username', { p_new_username: 'ab' });
  await rpcErrors('7. change_username (deny)', "illegal charset rejected", A.client,
    'change_username', { p_new_username: 'has space' });

  // 8. change_username success + side effects
  await rpcReturns('8. change_username (allow)', 'A claims a free first username', A.client,
    'change_username', { p_new_username: A_CHOSEN }, A_CHOSEN);
  const { data: aProf } = await svc.from('profiles')
    .select('username, username_source, username_last_changed_at').eq('id', A.id).single();
  rec('8. change_username (allow)', 'profile updated (username/source/clock)',
    aProf?.username === A_CHOSEN && aProf?.username_source === 'user_set' && !!aProf?.username_last_changed_at,
    `username=${aProf?.username}, source=${aProf?.username_source}, changed=${aProf?.username_last_changed_at}`);
  const { data: aIds } = await svc.from('account_identifiers')
    .select('value, status').eq('account_id', A.id).eq('type', 'username');
  const oldRow = (aIds || []).find((r) => r.value === A_SYS);
  const newRow = (aIds || []).find((r) => r.value === A_CHOSEN);
  rec('8. change_username (allow)', 'old username retired (not deleted)',
    oldRow?.status === 'retired', `A_SYS row=${JSON.stringify(oldRow)}`);
  rec('8. change_username (allow)', 'new username active',
    newRow?.status === 'active', `A_CHOSEN row=${JSON.stringify(newRow)}`);

  // 9. Cadence — second change within 365 days denied
  await rpcErrors('9. change cadence (deny)', 'second change within 365 days rejected', A.client,
    'change_username', { p_new_username: 'another_testa' });

  // 10. Cross-tenant isolation — C (tenant 2) discovers no tenant-1 accounts
  await rpcLacksAccount('10. cross-tenant (deny)', 'C cannot find A by email', C.client,
    'find_account_by_email', { p_email: A_EMAIL }, A.id);
  await rpcLacksAccount('10. cross-tenant (deny)', 'C cannot find A by username', C.client,
    'search_accounts_by_username', { p_prefix: A_CHOSEN.slice(0, 4), p_limit: 10 }, A.id);

  // ── report ──
  let lastCat = '';
  let failed = 0;
  for (const r of results) {
    if (r.cat !== lastCat) { console.log(`\n${r.cat}`); lastCat = r.cat; }
    if (!r.passed) failed++;
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}  —  ${r.detail}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed.` +
    (failed ? `  ✗ ${failed} FAILED — HARD STOP, do not promote to prod.\n` : `  ✓ Gate GREEN.\n`));
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(`\n✗ Harness error (not an assertion failure): ${err.message}\n`);
  process.exitCode = 2;
});
