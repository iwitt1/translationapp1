#!/usr/bin/env node
/**
 * scripts/conversations-gate-test.mjs — Phase 3 Step 1: Conversations schema + RPC gate (Spec 6).
 *
 * Proves migration 017 behaves per Spec 6 / decisions.md (2026-06-12), driving the
 * SECURITY DEFINER write RPCs AS real authenticated users (their own JWT) — never the
 * service-role key for assertions (it bypasses RLS and would mask a leak). The service
 * key is used only for one-time fixture setup, for inserting a conversation_contexts row
 * (writes are service-role only by design), and for resetting state between phases so the
 * gate is re-runnable.
 *
 * Coverage (maps to migration 017 acceptance criteria):
 *   1. create_conversation direct — returns a uuid; both accounts are active members (RLS SELECT)
 *   2. Direct dedupe + race-safety — re-create / reverse-create resolve to the SAME conversation
 *   3. create_conversation group — always-new (two creates → two distinct ids)
 *   4. Rejections — single-tenant invariant (cross-tenant member), self-only, opaque errors
 *   5. set_conversation_context_type — member may, non-member may not; value actually changes
 *   6. conversation_contexts RLS — member SELECTs the row; a soft-left member loses it; re-join restores
 *      (this phase also exercises soft-leave + re-join end to end)
 *   7. conversation-kind invite — create_invite(conversation) + redeem → joins; cross-tenant redeem denied
 *   8. messages.conversation_id promotion — 0 NULLs, 0 unresolved FKs (data-level; DDL-level checks
 *      live in the migration's embedded verification block, run in the SQL editor)
 *   9. RLS hardening — direct client INSERT into conversations / conversation_members denied
 *
 * Run:  node scripts/conversations-gate-test.mjs
 *   Reuses ./.env.rls-test (same vars as the Step 3/4/5 gates). See .env.rls-test.example.
 *   Exit 0 = all assertions passed (gate GREEN). Exit 1 = at least one failed (HARD STOP).
 *
 * SAFETY: mutates the target DB (wipes + rebuilds conversation state for the test users,
 * sets passwords, ensures a throwaway tenant 2 + user C). Refuses to run unless
 * RLS_TEST_CONFIRM_STAGING=yes. NEVER point it at production.
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
const GLOBAL_CONVERSATION = '00000000-0000-0000-0000-000000000002'; // sentinel; never delete

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

const isUuid = (s) => typeof s === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// RPC expected to succeed; assert via predicate; returns the data.
async function rpcOk(cat, name, client, fn, args, pred = () => true) {
  const { data, error } = await client.rpc(fn, args);
  rec(cat, name, !error && pred(data),
    error ? `ERROR ${error.message}` : `returned ${JSON.stringify(data)}`);
  return data;
}
// RPC expected to raise (PostgREST surfaces a function exception as error).
async function rpcErrors(cat, name, client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  rec(cat, name, !!error,
    error ? `denied: ${error.message}` : `UNEXPECTED SUCCESS: ${JSON.stringify(data)}`);
}

// True iff the user client can SELECT a given conversation id (RLS member check).
async function canSeeConversation(client, convId) {
  const { data, error } = await client.from('conversations').select('id').eq('id', convId);
  return !error && (data || []).length === 1;
}
// Count conversation_contexts rows a user client can SELECT for a conversation.
async function contextRowsVisible(client, convId) {
  const { data, error } = await client.from('conversation_contexts')
    .select('conversation_id').eq('conversation_id', convId);
  return error ? -1 : (data || []).length;
}

// Wipe all Step-1 conversation state for the given account ids (FK-safe; service role).
// Never touches the global sentinel conversation.
async function resetConversations(ids) {
  // conversation invites + their redemptions
  const { data: inv } = await svc.from('invites').select('id')
    .in('created_by', ids).eq('kind', 'conversation');
  if (inv?.length) await svc.from('invite_redemptions').delete().in('invite_id', inv.map((r) => r.id));
  await svc.from('invites').delete().in('created_by', ids).eq('kind', 'conversation');

  // every conversation these users are/were members of (except the global sentinel)
  const { data: mem } = await svc.from('conversation_members').select('conversation_id').in('account_id', ids);
  const convIds = [...new Set((mem || []).map((r) => r.conversation_id))].filter((c) => c !== GLOBAL_CONVERSATION);
  if (convIds.length) {
    // conversation_contexts + conversation_members cascade on conversation delete,
    // but clear contexts explicitly too (defensive; FK is NOT VALID).
    await svc.from('conversation_contexts').delete().in('conversation_id', convIds);
    await svc.from('conversations').delete().in('id', convIds);
  }
  // sweep any stray membership rows for these users (e.g. on undeleted convos)
  await svc.from('conversation_members').delete().in('account_id', ids).neq('conversation_id', GLOBAL_CONVERSATION);
}

// ── fixtures (service role; idempotent) ──────────────────────────────────────
async function ensureFixtures() {
  const { error: tErr } = await svc.from('tenants')
    .upsert({ id: TENANT_2, name: 'RLS Test Tenant 2' }, { onConflict: 'id' });
  if (tErr) throw new Error(`tenant 2 upsert failed: ${tErr.message}`);

  const { data: list, error: lErr } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (lErr) throw new Error(`admin.listUsers failed: ${lErr.message}`);
  const byEmail = (e) => list.users.find((u) => u.email?.toLowerCase() === e.toLowerCase());

  const ids = {};
  // A and B must already exist (created via the magic-link flow). Known passwords. Tenant 1, active.
  for (const [key, e] of [['A', A_EMAIL], ['B', B_EMAIL]]) {
    const u = byEmail(e);
    if (!u) throw new Error(`expected existing staging user not found: ${e} — create it via the app first`);
    const { error } = await svc.auth.admin.updateUserById(u.id, { password: PASSWORD, email_confirm: true });
    if (error) throw new Error(`set password for ${e} failed: ${error.message}`);
    await svc.from('profiles').update({ status: 'active', tenant_id: TENANT_1 }).eq('id', u.id);
    ids[key] = u.id;
  }

  // C: create if absent (trigger makes a tenant-1 pending profile), re-point to tenant 2, active.
  let cUser = byEmail(C_EMAIL);
  if (!cUser) {
    const { data, error } = await svc.auth.admin.createUser({ email: C_EMAIL, password: PASSWORD, email_confirm: true });
    if (error) throw new Error(`create user C failed: ${error.message}`);
    cUser = data.user;
  } else {
    await svc.auth.admin.updateUserById(cUser.id, { password: PASSWORD, email_confirm: true });
  }
  for (const [table, col] of [['profiles', 'id'], ['account_identifiers', 'account_id'], ['account_settings', 'account_id']]) {
    await svc.from(table).update({ tenant_id: TENANT_2 }).eq(col, cUser.id);
  }
  await svc.from('profiles').update({ status: 'active' }).eq('id', cUser.id);
  ids.C = cUser.id;
  return ids;
}

async function signIn(email) {
  const client = userClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message} (enable Email/Password on staging)`);
  return { client, id: data.user.id };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nConversations gate (Phase 3 Step 1 / Spec 6) → ${SB_URL}\n`);
  console.log('Setting up fixtures…');
  const fx = await ensureFixtures();

  console.log('Signing in as A, B, C…');
  const A = await signIn(A_EMAIL);
  const B = await signIn(B_EMAIL);
  const C = await signIn(C_EMAIL);
  if (A.id !== fx.A || B.id !== fx.B || C.id !== fx.C) throw new Error('id mismatch between fixture and sign-in');

  await resetConversations([A.id, B.id, C.id]);

  // ═══ 1. create_conversation direct + membership visibility ═════════════════
  const C1 = '1. direct create + membership';
  const dm1 = await rpcOk(C1, 'A creates direct with B → uuid', A.client,
    'create_conversation', { p_kind: 'direct', p_member_ids: [B.id] }, isUuid);
  rec(C1, 'A (member) can SELECT the conversation', await canSeeConversation(A.client, dm1), `conv ${String(dm1).slice(0, 8)}`);
  rec(C1, 'B (member) can SELECT the conversation', await canSeeConversation(B.client, dm1), `conv ${String(dm1).slice(0, 8)}`);
  rec(C1, 'C (non-member, other tenant) CANNOT SELECT it', !(await canSeeConversation(C.client, dm1)), 'denied');

  // ═══ 2. Direct dedupe + race-safety ════════════════════════════════════════
  const C2 = '2. direct dedupe (one thread per pair)';
  const dm2 = await rpcOk(C2, 'A creates direct with B again → SAME id', A.client,
    'create_conversation', { p_kind: 'direct', p_member_ids: [B.id] }, (d) => d === dm1);
  const dm3 = await rpcOk(C2, 'B creates direct with A (reverse) → SAME id', B.client,
    'create_conversation', { p_kind: 'direct', p_member_ids: [A.id] }, (d) => d === dm1);
  {
    const { data } = await svc.from('conversations').select('id')
      .eq('tenant_id', TENANT_1).eq('kind', 'direct').not('dedupe_key', 'is', null);
    rec(C2, 'exactly ONE direct conversation row for the pair (no glare dup)',
      (data || []).length === 1, `direct deduped rows=${(data || []).length} (ids: ${String(dm2).slice(0, 8)}/${String(dm3).slice(0, 8)})`);
  }

  // ═══ 3. create_conversation group — always-new ═════════════════════════════
  const C3 = '3. group always-new';
  const g1 = await rpcOk(C3, 'A creates group with B → uuid', A.client,
    'create_conversation', { p_kind: 'group', p_member_ids: [B.id], p_title: 'G1' }, isUuid);
  const g2 = await rpcOk(C3, 'A creates group with B again → DIFFERENT uuid', A.client,
    'create_conversation', { p_kind: 'group', p_member_ids: [B.id], p_title: 'G2' }, (d) => isUuid(d) && d !== g1);

  // ═══ 4. Rejections — single-tenant invariant + self-only ═══════════════════
  const C4 = '4. rejections';
  await rpcErrors(C4, 'A creates direct with C (other tenant) → denied (opaque)', A.client,
    'create_conversation', { p_kind: 'direct', p_member_ids: [C.id] });
  await rpcErrors(C4, 'A creates group including C (other tenant) → denied', A.client,
    'create_conversation', { p_kind: 'group', p_member_ids: [B.id, C.id] });
  await rpcErrors(C4, 'A creates conversation with no other members → denied', A.client,
    'create_conversation', { p_kind: 'group', p_member_ids: [] });

  // ═══ 5. set_conversation_context_type ══════════════════════════════════════
  const C5 = '5. set context_type';
  await rpcOk(C5, 'A (member) sets g1 context_type=professional → ok', A.client,
    'set_conversation_context_type', { p_conversation_id: g1, p_context_type: 'professional' }, (d) => d === null);
  {
    const { data } = await svc.from('conversations').select('context_type').eq('id', g1).single();
    rec(C5, 'context_type actually changed to professional', data?.context_type === 'professional', `value=${data?.context_type}`);
  }
  await rpcErrors(C5, 'C (non-member) cannot set g1 context_type', C.client,
    'set_conversation_context_type', { p_conversation_id: g1, p_context_type: 'casual' });
  await rpcErrors(C5, 'invalid context_type rejected', A.client,
    'set_conversation_context_type', { p_conversation_id: g1, p_context_type: 'nonsense' });

  // ═══ 6. conversation_contexts RLS + soft-leave + re-join ═══════════════════
  const C6 = '6. context RLS + soft-leave/re-join';
  // Insert a context row for g1 via service role (writes are service-role only by design).
  await svc.from('conversation_contexts').delete().eq('conversation_id', g1);
  const { error: ctxErr } = await svc.from('conversation_contexts').insert({
    conversation_id: g1, tenant_id: TENANT_1, detected_register: 'professional', register_confidence: 0.9,
  });
  rec(C6, 'service role seeds a conversation_contexts row', !ctxErr, ctxErr ? `ERROR ${ctxErr.message}` : 'inserted');
  rec(C6, 'A (member) SELECTs the context row', (await contextRowsVisible(A.client, g1)) === 1, 'visible');
  rec(C6, 'C (non-member) sees NO context row', (await contextRowsVisible(C.client, g1)) === 0, 'denied');
  rec(C6, 'B (member) SELECTs the context row', (await contextRowsVisible(B.client, g1)) === 1, 'visible');

  // B soft-leaves g1 → loses conversation + context access.
  await rpcOk(C6, 'B leaves g1 → ok', B.client, 'leave_conversation', { p_conversation_id: g1 }, (d) => d === null);
  rec(C6, 'B (left) can no longer SELECT g1', !(await canSeeConversation(B.client, g1)), 'denied after leave');
  rec(C6, 'B (left) sees NO context row', (await contextRowsVisible(B.client, g1)) === 0, 'denied after leave');
  await rpcOk(C6, 'B leaves g1 again → no-op (no error)', B.client, 'leave_conversation', { p_conversation_id: g1 }, (d) => d === null);

  // ═══ 7. conversation-kind invite ═══════════════════════════════════════════
  const C7 = '7. conversation invite';
  // A mints an invite to g1; B (who left) redeems → re-joins.
  const token = await rpcOk(C7, 'A mints a conversation invite to g1 → token', A.client,
    'create_invite', { p_kind: 'conversation', p_target_conversation_id: g1 }, (d) => typeof d === 'string' && d.length > 10);
  await rpcOk(C7, 'B redeems → joined', B.client, 'redeem_invite', { p_token: token }, (d) => d === 'joined');
  rec(C7, 'B (re-joined) can SELECT g1 again', await canSeeConversation(B.client, g1), 'visible after re-join');
  rec(C7, 'B (re-joined) SELECTs the context row again', (await contextRowsVisible(B.client, g1)) === 1, 'visible after re-join');
  await rpcErrors(C7, 'C (other tenant) cannot redeem the invite → opaque', C.client,
    'redeem_invite', { p_token: token });
  await rpcErrors(C7, 'non-member cannot mint an invite to a conversation they are not in', C.client,
    'create_invite', { p_kind: 'conversation', p_target_conversation_id: g1 });

  // ═══ 8. messages.conversation_id promotion (data-level) ════════════════════
  const C8 = '8. messages.conversation_id promotion';
  {
    const { data, error } = await svc.from('messages').select('id, conversation_id');
    const rows = data || [];
    const nulls = rows.filter((r) => !r.conversation_id).length;
    rec(C8, 'no messages with NULL conversation_id', !error && nulls === 0, error ? `ERROR ${error.message}` : `nulls=${nulls}/${rows.length}`);
    // unresolved-FK check: every conversation_id must exist in conversations
    const convIds = [...new Set(rows.map((r) => r.conversation_id).filter(Boolean))];
    let unresolved = 0;
    if (convIds.length) {
      const { data: cv } = await svc.from('conversations').select('id').in('id', convIds);
      const have = new Set((cv || []).map((r) => r.id));
      unresolved = convIds.filter((c) => !have.has(c)).length;
    }
    rec(C8, 'every message conversation_id resolves to a conversation (0 unresolved FKs)', unresolved === 0, `unresolved=${unresolved}`);
  }
  rec(C8, 'NOTE: NOT NULL constraint + default-dropped + FK existence verified via the migration SQL block',
    true, 'see 017 embedded verification (run in SQL editor)');

  // ═══ 9. RLS hardening — direct client writes denied ════════════════════════
  const C9 = '9. RLS hardening (direct writes denied)';
  {
    const { error } = await A.client.from('conversations')
      .insert({ tenant_id: TENANT_1, kind: 'group', context_type: 'casual' });
    rec(C9, 'direct client INSERT into conversations denied', !!error, error ? `denied: ${error.message}` : 'UNEXPECTED SUCCESS');
  }
  {
    const { error } = await A.client.from('conversation_members')
      .insert({ conversation_id: g1, account_id: A.id, tenant_id: TENANT_1 });
    rec(C9, 'direct client INSERT into conversation_members denied', !!error, error ? `denied: ${error.message}` : 'UNEXPECTED SUCCESS');
  }

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

  // Leave the DB clean for the next run.
  await resetConversations([A.id, B.id, C.id]);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(`\n✗ Harness error (not an assertion failure): ${err.message}\n`);
  process.exitCode = 2;
});
