#!/usr/bin/env node
/**
 * scripts/messages-rls-gate-test.mjs — Phase 3 Step 2: membership-scoped messages RLS gate (Spec 7).
 *
 * The hard-stop security gate for migration 018. Proves that the read/write boundary on
 * the message tables has moved from TENANT-scoped to MEMBERSHIP-scoped: a user may read
 * or post a message, and read or write its cached translation, ONLY if they are an ACTIVE
 * member of that message's conversation. This is the highest-blast-radius change in the
 * system (it governs every message read, write, and realtime push), so it gets its own
 * adversarial gate, separate from the 017 conversations gate.
 *
 * Like the other RLS gates, every assertion is driven AS a real authenticated user (their
 * own JWT) — NEVER the service-role key (it bypasses RLS and would mask a leak). The
 * service key is used only for fixture setup (seeding an A-only conversation, which the
 * create_conversation RPC deliberately cannot do since it requires a second member) and
 * for resetting state between runs.
 *
 * How RLS denial surfaces (the mechanism matters — each assertion checks a specific shape):
 *   - Blocked SELECT (messages / message_translations) → row filtered out → empty array, NO error.
 *   - Blocked INSERT via WITH CHECK (non-member posts) → ERROR (RLS violation).
 *   - Blocked realtime (postgres_changes applies the SELECT policy for `authenticated`) →
 *     the INSERT is simply never delivered → 0 events received. (realtime-RLS is a known
 *     footgun — this is checked EXPLICITLY, not assumed.)
 *
 * Adversarial matrix (Spec 7): two users in one tenant; a conversation with ONLY user A.
 *   Phase 2 — B is a NON-member → B canNOT: SELECT A's message, INSERT into the conversation,
 *             read the cached translation, or receive anything on realtime.   (+ cross-tenant C)
 *   Phase 3 — B joins (A mints a conversation invite, B redeems) → B now CAN all four,
 *             and can UPDATE (upsert) the cached translation.
 *   Phase 4 — B soft-leaves (leave_conversation) → all four revoked again.
 *   Phase 5 — immutability sanity: messages remain immutable (no UPDATE/DELETE policy);
 *             an active member's UPDATE/DELETE changes 0 rows.
 *
 * Run:  node scripts/messages-rls-gate-test.mjs
 *   Reuses ./.env.rls-test (same vars as the Step 1/3 gates). See .env.rls-test.example.
 *   Exit 0 = all assertions passed (gate GREEN). Exit 1 = at least one failed (HARD STOP).
 *
 * SAFETY: mutates the target DB (sets test-user passwords, ensures throwaway tenant 2 +
 * user C, seeds + tears down RLS-TEST conversations/messages/translations). Refuses to run
 * unless RLS_TEST_CONFIRM_STAGING=yes. NEVER point it at production.
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

// ── shape helpers (denial mechanism matters — see header) ─────────────────────
// Blocked SELECT → expect empty array, no error.
async function selectEmpty(cat, name, client, table, col, val) {
  const { data, error } = await client.from(table).select('*').eq(col, val);
  rec(cat, name, !error && Array.isArray(data) && data.length === 0,
    error ? `ERROR ${error.message}` : `${data?.length ?? '?'} rows (want 0)`);
}
// Allowed SELECT → expect ≥1 row.
async function selectHasRows(cat, name, client, table, col, val) {
  const { data, error } = await client.from(table).select('*').eq(col, val);
  rec(cat, name, !error && Array.isArray(data) && data.length >= 1,
    error ? `ERROR ${error.message}` : `${data?.length ?? '?'} rows (want ≥1)`);
}
// Write expected to be denied (WITH CHECK) → expect an error.
async function writeErrors(cat, name, fn) {
  const { data, error } = await fn();
  rec(cat, name, !!error,
    error ? `denied: ${error.message}` : `UNEXPECTED SUCCESS: ${JSON.stringify(data)}`);
}
// Write expected to succeed → expect ≥1 row back.
async function writeOk(cat, name, fn) {
  const { data, error } = await fn();
  rec(cat, name, !error && Array.isArray(data) && data.length >= 1,
    error ? `ERROR ${error.message}` : `${data?.length ?? '?'} rows`);
}
// Update/delete that the policy set makes a no-op (immutable) → 0 rows changed, no error.
async function mutateNoop(cat, name, fn) {
  const { data, error } = await fn();
  rec(cat, name, !error && Array.isArray(data) && data.length === 0,
    error ? `also blocked via ERROR ${error.message}` : `${data?.length ?? '?'} rows changed (want 0)`);
}

// Insert a message AS the given user client into a conversation.
function postMessage(client, senderId, convId, text) {
  return client.from('messages').insert({
    sender_id: senderId, tenant_id: TENANT_1, conversation_id: convId,
    original_text: text, source_language: 'en',
  }).select();
}

// Realtime: subscribe `client` (with its own JWT) to message INSERTs on `convId`, fire
// `trigger`, and count delivered events. postgres_changes runs the SELECT policy for the
// `authenticated` role, so a non-member receives 0. Returns the number of events received.
async function realtimeDelivered(client, accessToken, convId, trigger, waitMs = 3500) {
  client.realtime.setAuth(accessToken); // ensure realtime uses the user's token, not anon
  const received = [];
  const channel = client.channel(`gate-${convId}-${Math.random().toString(36).slice(2)}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${convId}` },
      (payload) => received.push(payload));
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('realtime subscribe timeout')), 12000);
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') { clearTimeout(t); res(); }
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(t); rej(err || new Error(status)); }
    });
  });
  await trigger();                                   // A posts AFTER B is confirmed subscribed
  await new Promise((r) => setTimeout(r, waitMs));    // give realtime time to deliver (or not)
  await client.removeChannel(channel);
  return received.length;
}

// ── reset: drop every RLS-TEST conversation A/B/C belong to (never the sentinel) ──────
async function resetConversations(ids) {
  const { data: inv } = await svc.from('invites').select('id')
    .in('created_by', ids).eq('kind', 'conversation');
  if (inv?.length) await svc.from('invite_redemptions').delete().in('invite_id', inv.map((r) => r.id));
  await svc.from('invites').delete().in('created_by', ids).eq('kind', 'conversation');

  const { data: mem } = await svc.from('conversation_members').select('conversation_id').in('account_id', ids);
  const convIds = [...new Set((mem || []).map((r) => r.conversation_id))].filter((c) => c !== GLOBAL_CONVERSATION);
  if (convIds.length) {
    // messages + message_translations + conversation_members cascade on conversation delete.
    await svc.from('conversations').delete().in('id', convIds);
  }
  await svc.from('conversation_members').delete().in('account_id', ids).neq('conversation_id', GLOBAL_CONVERSATION);
  await svc.from('messages').delete().like('original_text', 'RLS-TEST%');
}

// Seed a group conversation whose ONLY active member is A. The create_conversation RPC
// can't make this (it requires a second member), so we go through the service role.
async function seedSoloConversation(aId) {
  const { data, error } = await svc.from('conversations')
    .insert({ tenant_id: TENANT_1, kind: 'group', context_type: 'casual' })
    .select('id').single();
  if (error) throw new Error(`seed conversation failed: ${error.message}`);
  const convId = data.id;
  const { error: mErr } = await svc.from('conversation_members')
    .insert({ conversation_id: convId, account_id: aId, tenant_id: TENANT_1 });
  if (mErr) throw new Error(`seed A membership failed: ${mErr.message}`);
  return convId;
}

// ── fixtures (service role; idempotent) — A,B in tenant 1 active; C in tenant 2 ───────
async function ensureFixtures() {
  const { error: tErr } = await svc.from('tenants')
    .upsert({ id: TENANT_2, name: 'RLS Test Tenant 2' }, { onConflict: 'id' });
  if (tErr) throw new Error(`tenant 2 upsert failed: ${tErr.message}`);

  const { data: list, error: lErr } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (lErr) throw new Error(`admin.listUsers failed: ${lErr.message}`);
  const byEmail = (e) => list.users.find((u) => u.email?.toLowerCase() === e.toLowerCase());

  const ids = {};
  for (const [key, e] of [['A', A_EMAIL], ['B', B_EMAIL]]) {
    const u = byEmail(e);
    if (!u) throw new Error(`expected existing staging user not found: ${e} — create it via the app first`);
    const { error } = await svc.auth.admin.updateUserById(u.id, { password: PASSWORD, email_confirm: true });
    if (error) throw new Error(`set password for ${e} failed: ${error.message}`);
    await svc.from('profiles').update({ status: 'active', tenant_id: TENANT_1 }).eq('id', u.id);
    ids[key] = u.id;
  }

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
  return { client, id: data.user.id, token: data.session.access_token };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nMessages RLS gate (Phase 3 Step 2 / Spec 7) → ${SB_URL}\n`);
  console.log('Setting up fixtures…');
  const fx = await ensureFixtures();

  console.log('Signing in as A, B, C…');
  const A = await signIn(A_EMAIL);
  const B = await signIn(B_EMAIL);
  const C = await signIn(C_EMAIL);
  if (A.id !== fx.A || B.id !== fx.B || C.id !== fx.C) throw new Error('id mismatch between fixture and sign-in');

  await resetConversations([A.id, B.id, C.id]);

  // ═══ 1. Seed an A-only conversation; A posts + caches a translation (positive controls) ═══
  const C1 = '1. setup (A-only conversation)';
  const conv = await seedSoloConversation(A.id);
  rec(C1, 'service role seeds an A-only conversation', isUuid(conv), `conv ${conv.slice(0, 8)}`);

  let msgId;
  {
    const { data, error } = await postMessage(A.client, A.id, conv, 'RLS-TEST A msg 1');
    rec(C1, 'A (member) CAN post into the conversation', !error && (data || []).length === 1,
      error ? `ERROR ${error.message}` : `msg ${data?.[0]?.id?.slice(0, 8)}`);
    msgId = data?.[0]?.id;
  }
  {
    const { data, error } = await A.client.from('message_translations')
      .insert({ message_id: msgId, tenant_id: TENANT_1, language: 'es', translated_text: 'RLS-TEST cache es' }).select();
    rec(C1, 'A (member) CAN cache a translation for the message', !error && (data || []).length === 1,
      error ? `ERROR ${error.message}` : 'cached');
  }
  await selectHasRows(C1, 'A (member) CAN read the message', A.client, 'messages', 'id', msgId);
  await selectHasRows(C1, 'A (member) CAN read the cached translation', A.client, 'message_translations', 'message_id', msgId);

  // ═══ 2. B is a NON-member → all four denied; C is cross-tenant → also denied ═══════════
  const C2 = '2. non-member B (deny all four)';
  await selectEmpty(C2, 'B canNOT read A\'s message', B.client, 'messages', 'id', msgId);
  await writeErrors(C2, 'B canNOT post into the conversation',
    () => postMessage(B.client, B.id, conv, 'RLS-TEST B intrusion'));
  await selectEmpty(C2, 'B canNOT read the cached translation', B.client, 'message_translations', 'message_id', msgId);
  await writeErrors(C2, 'B canNOT write the cached translation (upsert blocked)',
    () => B.client.from('message_translations')
      .insert({ message_id: msgId, tenant_id: TENANT_1, language: 'fr', translated_text: 'RLS-TEST B fr' }).select());
  {
    const got = await realtimeDelivered(B.client, B.token, conv,
      () => postMessage(A.client, A.id, conv, 'RLS-TEST A realtime probe (non-member)'));
    rec(C2, 'B (non-member) receives NOTHING on realtime', got === 0, `events received=${got} (want 0)`);
  }
  // cross-tenant defense-in-depth: even tenant scope alone keeps C out.
  await selectEmpty(C2, 'C (other tenant) canNOT read the message', C.client, 'messages', 'id', msgId);
  await selectEmpty(C2, 'C (other tenant) canNOT read the cached translation', C.client, 'message_translations', 'message_id', msgId);

  // ═══ 3. B joins (A mints a conversation invite, B redeems) → all four now allowed ═══════
  const C3 = '3. B joins → allow all four';
  const token = await (async () => {
    const { data, error } = await A.client.rpc('create_invite',
      { p_kind: 'conversation', p_target_conversation_id: conv });
    rec(C3, 'A mints a conversation invite to the conversation', !error && typeof data === 'string',
      error ? `ERROR ${error.message}` : 'token minted');
    return data;
  })();
  {
    const { data, error } = await B.client.rpc('redeem_invite', { p_token: token });
    rec(C3, 'B redeems the invite → joined', !error && data === 'joined',
      error ? `ERROR ${error.message}` : `result=${data}`);
  }
  await selectHasRows(C3, 'B (now member) CAN read A\'s message', B.client, 'messages', 'id', msgId);
  await selectHasRows(C3, 'B (now member) CAN read the cached translation', B.client, 'message_translations', 'message_id', msgId);
  await writeOk(C3, 'B (now member) CAN post into the conversation',
    () => postMessage(B.client, B.id, conv, 'RLS-TEST B msg (member)'));
  await writeOk(C3, 'B (now member) CAN cache a new translation',
    () => B.client.from('message_translations')
      .insert({ message_id: msgId, tenant_id: TENANT_1, language: 'fr', translated_text: 'RLS-TEST B fr (member)' }).select());
  await writeOk(C3, 'B (now member) CAN upsert/UPDATE an existing cached translation',
    () => B.client.from('message_translations')
      .update({ translated_text: 'RLS-TEST B es updated' }).eq('message_id', msgId).eq('language', 'es').select());
  {
    const got = await realtimeDelivered(B.client, B.token, conv,
      () => postMessage(A.client, A.id, conv, 'RLS-TEST A realtime probe (member)'));
    rec(C3, 'B (member) DOES receive realtime when A posts', got >= 1, `events received=${got} (want ≥1)`);
  }

  // ═══ 4. B soft-leaves → all four revoked again ════════════════════════════════════════
  const C4 = '4. B soft-leaves → revoke all four';
  {
    const { data, error } = await B.client.rpc('leave_conversation', { p_conversation_id: conv });
    rec(C4, 'B leaves the conversation → ok', !error && data === null,
      error ? `ERROR ${error.message}` : 'left');
  }
  await selectEmpty(C4, 'B (left) canNOT read the message again', B.client, 'messages', 'id', msgId);
  await writeErrors(C4, 'B (left) canNOT post again',
    () => postMessage(B.client, B.id, conv, 'RLS-TEST B post after leave'));
  await selectEmpty(C4, 'B (left) canNOT read the cached translation again', B.client, 'message_translations', 'message_id', msgId);
  {
    const got = await realtimeDelivered(B.client, B.token, conv,
      () => postMessage(A.client, A.id, conv, 'RLS-TEST A realtime probe (after leave)'));
    rec(C4, 'B (left) receives NOTHING on realtime again', got === 0, `events received=${got} (want 0)`);
  }

  // ═══ 5. messages immutability sanity (no UPDATE/DELETE policy → member no-op) ══════════
  const C5 = '5. messages immutable';
  await mutateNoop(C5, 'A (member) UPDATE of own message changes 0 rows',
    () => A.client.from('messages').update({ original_text: 'RLS-TEST tampered' }).eq('id', msgId).select());
  await mutateNoop(C5, 'A (member) DELETE of own message changes 0 rows',
    () => A.client.from('messages').delete().eq('id', msgId).select());

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
