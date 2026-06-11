#!/usr/bin/env node
/**
 * scripts/deletion-gate-test.mjs — Phase 2 Step 7: data-deletion (GDPR erasure) gate.
 *
 * Proves the Step 7 flow (migration 013 + server/lib/deletion.js) behaves per
 * architecture.md §7/§11, policies.md §6, and decisions.md 2026-06-11:
 *
 *   REQUEST (user-authed):
 *     - request_account_deletion() soft-deletes (profile → 'deactivated') and enqueues a
 *       pending request with a grace window; it is idempotent (no duplicate open request);
 *     - a user can SELECT only their OWN request (RLS) and CANNOT write the table directly.
 *   CANCEL:
 *     - cancel_account_deletion() reverses a pending request within grace (profile → 'active',
 *       request → 'cancelled'); it is a no-op (false) when nothing is pending.
 *   SWEEP (processor):
 *     - a DRY RUN deletes nothing;
 *     - a due request (grace elapsed) is HARD-deleted: auth.users + profile + identifiers +
 *       settings cascade away;
 *     - a message from the deleted user SURVIVES with sender_id = NULL (de-identify, retain) —
 *       the load-bearing assertion;
 *     - the data_deletion_requests row SURVIVES as audit trail: status='completed',
 *       completed_at set, user_id NULL, deleted_fields populated (messages_anonymized >= 1);
 *     - a keyed email HMAC is recorded in email_hash_abuse (matches HMAC(email,pepper), is
 *       NOT a plain SHA-256) — reusing the Step 6 table/RPC;
 *     - a NOT-due request (grace not elapsed) and a CANCELLED account are left UNTOUCHED.
 *   AUTHORIZATION:
 *     - the sweep RPCs (list_due/claim/complete) are service_role-only;
 *     - the user RPCs reject an unauthenticated caller.
 *
 * It drives the REAL sweep function against staging, planting fixtures via the admin API
 * (so the P1 auth.users trigger runs) and calling the user RPCs as a signed-in user.
 *
 * Run:  node scripts/deletion-gate-test.mjs
 *   Reuses ./.env.rls-test. Needs STAGING_SUPABASE_URL, STAGING_SUPABASE_SERVICE_ROLE_KEY,
 *   STAGING_SUPABASE_ANON_KEY (for the user-authed flow + deny checks), and
 *   ABANDONMENT_EMAIL_HASH_PEPPER (shared with Step 6). Exit 0 = GREEN, 1 = a failure.
 *
 * SAFETY: mutates the target DB (creates throwaway accounts, deletes due ones). The LIVE
 * sweep deletes ALL due erasure requests on the target — fine on staging, never prod.
 * Refuses to run unless RLS_TEST_CONFIRM_STAGING=yes.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHmac, createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { runDeletionSweep } from '../server/lib/deletion.js';

// ── tiny .env loader (matches the other gates) ───────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env.rls-test');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
  }
}

const {
  STAGING_SUPABASE_URL: SB_URL,
  STAGING_SUPABASE_ANON_KEY: ANON_KEY,
  STAGING_SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  ABANDONMENT_EMAIL_HASH_PEPPER: PEPPER,
  ABANDONMENT_EMAIL_HASH_KEY_VERSION: KV_ENV,
  RLS_TEST_PASSWORD: PASSWORD_ENV,
  RLS_TEST_CONFIRM_STAGING: CONFIRM,
} = process.env;

const KEY_VERSION = Number(KV_ENV ?? 1);
const PASSWORD = PASSWORD_ENV || 'deletion-gate-pw-123456';

// ── env + safety guards ──────────────────────────────────────────────────────
const required = {
  STAGING_SUPABASE_URL: SB_URL,
  STAGING_SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  ABANDONMENT_EMAIL_HASH_PEPPER: PEPPER,
};
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`\n✗ Missing required env vars: ${missing.join(', ')}`);
  console.error('  Copy .env.rls-test.example → .env.rls-test and fill it in.\n');
  process.exit(2);
}
if (!ANON_KEY) {
  console.error('\n✗ STAGING_SUPABASE_ANON_KEY is required for this gate (user-authed request/cancel flow).\n');
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

// ── result collection ────────────────────────────────────────────────────────
const results = [];
const rec = (cat, name, passed, detail) => results.push({ cat, name, passed, detail });

// ── helpers ──────────────────────────────────────────────────────────────────
const RUN = Date.now();
const EMAIL_PREFIX = 'deletion-gate-';
const mkEmail = (tag) => `${EMAIL_PREFIX}${tag}-${RUN}@example.com`;
const canonical = (e) => e.trim().toLowerCase();
const hmacHex = (email) => createHmac('sha256', PEPPER).update(canonical(email), 'utf8').digest('hex');
const plainSha256Hex = (email) => createHash('sha256').update(canonical(email), 'utf8').digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function byteaToHex(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.startsWith('\\x')) return s.slice(2).toLowerCase();
  try { return Buffer.from(s, 'base64').toString('hex').toLowerCase(); } catch { return s.toLowerCase(); }
}

// Create an account via the admin API (fires the P1 trigger), wait for the profile row,
// then promote it to an ACTIVE account (only real/active accounts use Step 7 erasure).
async function createActive(email) {
  const { data, error } = await svc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw new Error(`createUser(${email}) failed: ${error.message}`);
  const id = data.user.id;
  let prof = null;
  for (let i = 0; i < 10 && !prof; i++) {
    const { data: p } = await svc.from('profiles').select('id, tenant_id, status').eq('id', id).maybeSingle();
    prof = p; if (!prof) await sleep(200);
  }
  if (!prof) throw new Error(`profile row never appeared for ${email} (${id}) — trigger?`);
  const { error: upErr } = await svc.from('profiles')
    .update({ status: 'active', onboarding_completed_at: new Date().toISOString() }).eq('id', id);
  if (upErr) throw new Error(`activate(${id}) failed: ${upErr.message}`);
  return { id, tenant_id: prof.tenant_id, email };
}

// Sign a fixture user in via the anon key → a client whose JWT carries auth.uid().
async function signIn(email) {
  const c = createClient(SB_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`signIn(${email}) failed: ${error.message}`);
  return c;
}

async function plantMessage(senderId, tenantId, text) {
  const { data, error } = await svc.from('messages')
    .insert({ sender_id: senderId, tenant_id: tenantId, original_text: text, source_language: 'en' })
    .select('id').single();
  if (error) throw new Error(`plantMessage failed: ${error.message}`);
  return data.id;
}

async function profileRow(id) {
  const { data } = await svc.from('profiles').select('id, status').eq('id', id).maybeSingle();
  return data || null;
}
async function authUserExists(id) {
  const { data, error } = await svc.auth.admin.getUserById(id);
  return !error && !!data?.user;
}
async function requestRow(id) {
  const { data } = await svc.from('data_deletion_requests').select('*').eq('id', id).maybeSingle();
  return data || null;
}
async function openRequestsFor(userId) {
  const { data } = await svc.from('data_deletion_requests').select('id, status')
    .eq('user_id', userId).in('status', ['pending', 'processing']);
  return data || [];
}
async function messageRow(id) {
  const { data } = await svc.from('messages').select('id, sender_id').eq('id', id).maybeSingle();
  return data || null;
}
async function abuseRowFor(email, tenantId) {
  const want = hmacHex(email);
  const { data } = await svc.from('email_hash_abuse').select('*')
    .eq('tenant_id', tenantId).eq('key_version', KEY_VERSION);
  return (data || []).find((r) => byteaToHex(r.email_hash) === want) || null;
}

const createdUserIds = []; // survivors for teardown
const plantedMessageIds = [];
const testStartIso = new Date().toISOString();

// ── teardown ─────────────────────────────────────────────────────────────────
async function teardown() {
  for (const id of plantedMessageIds) {
    try { await svc.from('messages').delete().eq('id', id); } catch {}
  }
  for (const id of createdUserIds) {
    try { await svc.auth.admin.deleteUser(id); } catch {}
  }
  // request rows from this run (survive the cascade via SET NULL) + abuse rows
  try { await svc.from('data_deletion_requests').delete().gte('requested_at', testStartIso); } catch {}
  try { await svc.from('email_hash_abuse').delete().gte('first_seen', testStartIso); } catch {}
  // belt-and-suspenders: sweep leftover deletion-gate-* accounts from prior runs
  try {
    const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
    for (const u of data?.users ?? []) {
      if (u.email?.startsWith(EMAIL_PREFIX)) { try { await svc.auth.admin.deleteUser(u.id); } catch {} }
    }
  } catch {}
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n▶ Step 7 data-deletion gate → ${SB_URL}  (key_version=${KEY_VERSION})\n`);
  const silent = { info() {}, warn() {}, error() {} };

  // Phase 0 — clean leftovers from a prior aborted run.
  {
    const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
    for (const u of data?.users ?? []) {
      if (u.email?.startsWith(EMAIL_PREFIX)) { try { await svc.auth.admin.deleteUser(u.id); } catch {} }
    }
  }

  // ── Phase 1 — REQUEST: soft-delete + enqueue (user-authed), idempotent, RLS ──
  const dueEmail = mkEmail('due');
  const due = await createActive(dueEmail);
  const dueClient = await signIn(dueEmail);

  // Request with a zero grace → immediately due for the sweep.
  const { data: reqRow, error: reqErr } = await dueClient.rpc('request_account_deletion', { p_grace: '0 seconds' });
  rec('1 Request', 'request_account_deletion succeeds for the caller', !reqErr && !!reqRow?.id, reqErr ? reqErr.message : `request_id=${reqRow?.id}`);
  const dueReqId = reqRow?.id;

  rec('1 Request', 'profile soft-deleted (status=deactivated)', (await profileRow(due.id))?.status === 'deactivated', `status=${(await profileRow(due.id))?.status}`);
  rec('1 Request', 'request enqueued pending, requested_by=user', reqRow?.status === 'pending' && reqRow?.requested_by === 'user', `status=${reqRow?.status} by=${reqRow?.requested_by}`);

  // Idempotent: a second request returns the same open row (no duplicate, grace not reset).
  const { data: reqRow2 } = await dueClient.rpc('request_account_deletion', { p_grace: '30 days' });
  rec('1 Request', 'second request is idempotent (same row id)', reqRow2?.id === dueReqId, `id2=${reqRow2?.id}`);
  rec('1 Request', 'no duplicate open request in the table', (await openRequestsFor(due.id)).length === 1, `open=${(await openRequestsFor(due.id)).length}`);
  rec('1 Request', 'idempotent call did not reset grace_until', reqRow2?.grace_until === reqRow?.grace_until, 'grace unchanged');

  // RLS: caller sees only their own request; cannot write the table directly.
  {
    const { data: own } = await dueClient.from('data_deletion_requests').select('id');
    rec('1 Request', 'RLS: caller SELECTs only own request', (own?.length ?? 0) === 1 && own[0].id === dueReqId, `rows=${own?.length ?? 0}`);
  }
  {
    const { error } = await dueClient.from('data_deletion_requests')
      .insert({ user_id: due.id, tenant_id: due.tenant_id, grace_until: new Date().toISOString() });
    rec('1 Request', 'RLS: direct INSERT denied', !!error, error ? 'denied' : 'UNEXPECTED SUCCESS');
  }
  {
    const { error, data } = await dueClient.from('data_deletion_requests')
      .update({ status: 'cancelled' }).eq('id', dueReqId).select('id');
    rec('1 Request', 'RLS: direct UPDATE denied (no rows affected)', !!error || (data?.length ?? 0) === 0, error ? 'denied' : `rows=${data?.length ?? 0}`);
  }

  // ── Phase 2 — CANCEL: reverse within grace ─────────────────────────────────
  const cancelEmail = mkEmail('cancel');
  const cancel = await createActive(cancelEmail);
  createdUserIds.push(cancel.id);
  const cancelClient = await signIn(cancelEmail);
  await cancelClient.rpc('request_account_deletion', { p_grace: '30 days' });
  rec('2 Cancel', 'pre-cancel profile is deactivated', (await profileRow(cancel.id))?.status === 'deactivated', `status=${(await profileRow(cancel.id))?.status}`);

  const { data: cancelled, error: cancelErr } = await cancelClient.rpc('cancel_account_deletion');
  rec('2 Cancel', 'cancel_account_deletion returns true', !cancelErr && cancelled === true, cancelErr ? cancelErr.message : `returned=${cancelled}`);
  rec('2 Cancel', 'profile restored to active', (await profileRow(cancel.id))?.status === 'active', `status=${(await profileRow(cancel.id))?.status}`);
  {
    const { data } = await svc.from('data_deletion_requests').select('status').eq('user_id', cancel.id).maybeSingle();
    rec('2 Cancel', 'request marked cancelled', data?.status === 'cancelled', `status=${data?.status}`);
  }
  // No-op cancel when nothing pending.
  {
    const { data: noop } = await cancelClient.rpc('cancel_account_deletion');
    rec('2 Cancel', 'cancel is a no-op (false) when nothing pending', noop === false, `returned=${noop}`);
  }

  // ── Phase 3 — a NOT-due request must survive the sweep ──────────────────────
  const notDueEmail = mkEmail('notdue');
  const notDue = await createActive(notDueEmail);
  createdUserIds.push(notDue.id);
  const notDueClient = await signIn(notDueEmail);
  const { data: notDueReq } = await notDueClient.rpc('request_account_deletion', { p_grace: '30 days' });

  // ── Phase 4 — SWEEP ─────────────────────────────────────────────────────────
  // Plant a message from the due user BEFORE deletion to prove content survives (SET NULL).
  const dueMsgId = await plantMessage(due.id, due.tenant_id, 'gate: retain-after-erasure');

  // Dry run deletes nothing.
  const dry = await runDeletionSweep({ supabaseClient: svc, pepper: PEPPER, keyVersion: KEY_VERSION, dryRun: true, logger: silent });
  rec('4 Sweep', 'dry run deletes nothing', dry.deleted === 0, `deleted=${dry.deleted} scanned=${dry.scanned}`);
  rec('4 Sweep', 'due account survives a dry run', await authUserExists(due.id), 'expected present');

  // Live sweep.
  const live = await runDeletionSweep({ supabaseClient: svc, pepper: PEPPER, keyVersion: KEY_VERSION, dryRun: false, logger: silent });
  rec('4 Sweep', 'live sweep reported a deletion', live.deleted >= 1, `deleted=${live.deleted} hashed=${live.hashed}`);

  // Due account fully gone (cascade).
  rec('4 Sweep', 'due auth.users row deleted', !(await authUserExists(due.id)), `present=${await authUserExists(due.id)}`);
  rec('4 Sweep', 'due profile cascade-deleted', !(await profileRow(due.id)), 'expected gone');
  {
    const { data: ids } = await svc.from('account_identifiers').select('id').eq('account_id', due.id);
    rec('4 Sweep', 'due identifiers cascade-deleted', (ids?.length ?? 0) === 0, `rows=${ids?.length ?? 0}`);
  }
  {
    const { data: s } = await svc.from('account_settings').select('account_id').eq('account_id', due.id);
    rec('4 Sweep', 'due account_settings cascade-deleted', (s?.length ?? 0) === 0, `rows=${s?.length ?? 0}`);
  }

  // LOAD-BEARING: message content retained, author link severed (sender_id → NULL).
  {
    const msg = await messageRow(dueMsgId);
    rec('4 Sweep', 'message survives the deletion (content retained)', !!msg, msg ? 'present' : 'MISSING');
    rec('4 Sweep', 'message sender_id de-identified to NULL', msg ? msg.sender_id === null : false, `sender_id=${msg?.sender_id ?? 'gone'}`);
  }

  // Audit row SURVIVES with the erasure recorded.
  {
    const audit = await requestRow(dueReqId);
    rec('4 Sweep', 'deletion request row survives as audit trail', !!audit, audit ? `status=${audit.status}` : 'MISSING');
    if (audit) {
      rec('4 Sweep', 'audit status=completed + completed_at set', audit.status === 'completed' && !!audit.completed_at, `status=${audit.status} completed_at=${!!audit.completed_at}`);
      rec('4 Sweep', 'audit user_id nulled (anonymized)', audit.user_id === null, `user_id=${audit.user_id}`);
      rec('4 Sweep', 'audit deleted_fields logged (messages_anonymized >= 1)', !!audit.deleted_fields && (audit.deleted_fields.messages_anonymized ?? 0) >= 1, `fields=${JSON.stringify(audit.deleted_fields)}`);
    }
  }

  // Abuse hash recorded — keyed, not plaintext.
  {
    const abuse = await abuseRowFor(dueEmail, due.tenant_id);
    rec('4 Sweep', 'abuse hash recorded for erased email', !!abuse, abuse ? `count=${abuse.abandon_count}` : 'MISSING');
    if (abuse) {
      const storedHex = byteaToHex(abuse.email_hash);
      rec('4 Sweep', 'stored hash equals HMAC(email,pepper)', storedHex === hmacHex(dueEmail), 'keyed HMAC match');
      rec('4 Sweep', 'stored hash is NOT a plain SHA-256 (keyed)', storedHex !== plainSha256Hex(dueEmail), 'differs from unkeyed digest');
    }
  }

  // Negatives: not-due request + its account untouched.
  rec('4 Sweep', 'NOT-due account UNTOUCHED', !!(await profileRow(notDue.id)), 'expected present');
  rec('4 Sweep', 'NOT-due request still pending', (await requestRow(notDueReq?.id))?.status === 'pending', `status=${(await requestRow(notDueReq?.id))?.status}`);
  // Cancelled account untouched + active.
  rec('4 Sweep', 'CANCELLED account UNTOUCHED + active', (await profileRow(cancel.id))?.status === 'active', `status=${(await profileRow(cancel.id))?.status}`);

  // ── Phase 5 — AUTHORIZATION ────────────────────────────────────────────────
  const anon = createClient(SB_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  {
    const { error } = await anon.rpc('list_due_deletion_requests');
    rec('5 Authz', 'list_due_deletion_requests denied to anon/authenticated', !!error, error ? 'denied' : 'UNEXPECTED SUCCESS');
  }
  {
    const { error } = await anon.rpc('claim_deletion_request', { p_id: notDueReq?.id });
    rec('5 Authz', 'claim_deletion_request denied to anon/authenticated', !!error, error ? 'denied' : 'UNEXPECTED SUCCESS');
  }
  {
    const { error } = await anon.rpc('complete_deletion_request', { p_id: notDueReq?.id, p_deleted_fields: {} });
    rec('5 Authz', 'complete_deletion_request denied to anon/authenticated', !!error, error ? 'denied' : 'UNEXPECTED SUCCESS');
  }
  {
    // Unauthenticated caller (no JWT) → user RPC raises (auth.uid() is NULL).
    const { error } = await anon.rpc('request_account_deletion', { p_grace: '30 days' });
    rec('5 Authz', 'request_account_deletion rejects unauthenticated caller', !!error, error ? 'rejected' : 'UNEXPECTED SUCCESS');
  }
}

// ── run ──────────────────────────────────────────────────────────────────────
main()
  .catch((err) => { rec('FATAL', 'unhandled error', false, err.message); })
  .finally(async () => {
    await teardown();

    let cat = '';
    let pass = 0;
    for (const r of results) {
      if (r.cat !== cat) { cat = r.cat; console.log(`\n${cat}`); }
      const mark = r.passed ? '✓' : '✗';
      if (r.passed) pass++;
      console.log(`  ${mark} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
    }
    const total = results.length;
    const green = pass === total;
    console.log(
      `\n${green ? '✅' : '❌'} ${pass}/${total} PASSED` +
        (green ? ' — GREEN' : ` — ${total - pass} FAILED`) +
        '\n',
    );
    process.exit(green ? 0 : 1);
  });
