#!/usr/bin/env node
/**
 * scripts/abandonment-gate-test.mjs — Phase 2 Step 6: abandonment + abuse-monitoring gate.
 *
 * Proves the Step 6 sweep (server/lib/abandonment.js + migration 012) behaves per
 * policies.md §6:
 *   - a pending account older than the window is DELETED, and its system-generated
 *     username is RELEASED (cascade drops the account_identifiers rows → reuse unblocked);
 *   - a de-identified KEYED HMAC of the email is recorded in email_hash_abuse — never the
 *     plaintext (the stored hash matches HMAC(email,pepper) and is NOT a plain SHA-256);
 *   - repeat abandon increments abandon_count (atomic upsert), no duplicate row;
 *   - a fresh (in-window) pending account and an aged-but-ACTIVE account are left UNTOUCHED;
 *   - a DRY RUN deletes/writes nothing;
 *   - the two support RPCs are service_role-only (anon/authenticated EXECUTE denied).
 *
 * It drives the REAL sweep function against staging, planting fixtures via the admin API
 * (so the P1 auth.users trigger runs) and backdating created_at with the service role.
 *
 * Run:  node scripts/abandonment-gate-test.mjs
 *   Reuses ./.env.rls-test. Needs STAGING_SUPABASE_URL, STAGING_SUPABASE_SERVICE_ROLE_KEY,
 *   ABANDONMENT_EMAIL_HASH_PEPPER (+ optional ABANDONMENT_EMAIL_HASH_KEY_VERSION, and
 *   STAGING_SUPABASE_ANON_KEY for the deny checks). Exit 0 = GREEN, 1 = a failure (HARD STOP).
 *
 * SAFETY: mutates the target DB (creates throwaway accounts, deletes aged-pending ones).
 * The LIVE sweep deletes ALL qualifying aged-pending accounts on the target — fine on
 * staging, never prod. Refuses to run unless RLS_TEST_CONFIRM_STAGING=yes.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHmac, createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { runAbandonmentSweep } from '../server/lib/abandonment.js';

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
const PASSWORD = PASSWORD_ENV || 'abandon-gate-pw-123456';
const MAX_AGE_DAYS = 30;

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
const EMAIL_PREFIX = 'abandon-gate-';
const mkEmail = (tag) => `${EMAIL_PREFIX}${tag}-${RUN}@example.com`;
const canonical = (e) => e.trim().toLowerCase();
const hmacHex = (email) => createHmac('sha256', PEPPER).update(canonical(email), 'utf8').digest('hex');
const plainSha256Hex = (email) => createHash('sha256').update(canonical(email), 'utf8').digest('hex');

// Normalize whatever shape PostgREST returns for a bytea column to lowercase hex.
function byteaToHex(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.startsWith('\\x')) return s.slice(2).toLowerCase();
  // base64 fallback
  try { return Buffer.from(s, 'base64').toString('hex').toLowerCase(); } catch { return s.toLowerCase(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Create a pending account via the admin API (fires the P1 trigger), then return its
// profile (id, tenant_id, username). Retries briefly for the AFTER-INSERT trigger.
async function createPending(email) {
  const { data, error } = await svc.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw new Error(`createUser(${email}) failed: ${error.message}`);
  const id = data.user.id;
  for (let i = 0; i < 10; i++) {
    const { data: prof } = await svc.from('profiles').select('id, tenant_id, username, status').eq('id', id).maybeSingle();
    if (prof) return prof;
    await sleep(200);
  }
  throw new Error(`profile row never appeared for ${email} (${id}) — trigger?`);
}

async function backdate(id, days, { status } = {}) {
  const patch = { created_at: new Date(Date.now() - days * 864e5).toISOString() };
  if (status) {
    patch.status = status;
    if (status === 'active') patch.onboarding_completed_at = new Date().toISOString();
  }
  const { error } = await svc.from('profiles').update(patch).eq('id', id);
  if (error) throw new Error(`backdate(${id}) failed: ${error.message}`);
}

async function profileExists(id) {
  const { data } = await svc.from('profiles').select('id, status').eq('id', id).maybeSingle();
  return data || null;
}
async function authUserExists(id) {
  const { data, error } = await svc.auth.admin.getUserById(id);
  return !error && !!data?.user;
}
async function usernameRow(tenantId, username) {
  const { data } = await svc.from('account_identifiers').select('id')
    .eq('tenant_id', tenantId).eq('type', 'username').eq('value', username);
  return data || [];
}
// Find the email_hash_abuse row for an email (match by recomputing the HMAC).
async function abuseRowFor(email, tenantId) {
  const want = hmacHex(email);
  const { data } = await svc.from('email_hash_abuse').select('*')
    .eq('tenant_id', tenantId).eq('key_version', KEY_VERSION);
  return (data || []).find((r) => byteaToHex(r.email_hash) === want) || null;
}

const createdUserIds = []; // for teardown of survivors
const testStartIso = new Date().toISOString();

// ── teardown ─────────────────────────────────────────────────────────────────
async function teardown() {
  // delete any survivor fixtures we created
  for (const id of createdUserIds) {
    try { await svc.auth.admin.deleteUser(id); } catch { /* may already be swept */ }
  }
  // remove email_hash_abuse rows created during this run, to keep the gate re-runnable
  try { await svc.from('email_hash_abuse').delete().gte('first_seen', testStartIso); } catch { /* noop */ }
  // belt-and-suspenders: sweep any leftover abandon-gate-* accounts from prior runs
  try {
    const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
    for (const u of data?.users ?? []) {
      if (u.email?.startsWith(EMAIL_PREFIX)) { try { await svc.auth.admin.deleteUser(u.id); } catch {} }
    }
  } catch { /* noop */ }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n▶ Step 6 abandonment gate → ${SB_URL}  (key_version=${KEY_VERSION}, window=${MAX_AGE_DAYS}d)\n`);

  const silent = { info() {}, warn() {}, error() {} };

  // Phase 0 — clean any leftovers from a prior aborted run.
  {
    const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
    for (const u of data?.users ?? []) {
      if (u.email?.startsWith(EMAIL_PREFIX)) { try { await svc.auth.admin.deleteUser(u.id); } catch {} }
    }
  }

  // ── Phase 1 — DRY RUN deletes/writes nothing ───────────────────────────────
  const dry = await createPending(mkEmail('dry'));
  await backdate(dry.id, 31);
  const drySummary = await runAbandonmentSweep({
    supabaseClient: svc, pepper: PEPPER, keyVersion: KEY_VERSION, maxAgeDays: MAX_AGE_DAYS,
    dryRun: true, logger: silent,
  });
  rec('1 Dry run', 'dry-run sweep deletes nothing', drySummary.deleted === 0, `deleted=${drySummary.deleted}`);
  rec('1 Dry run', 'aged pending account survives a dry run', !!(await profileExists(dry.id)), `profile present=${!!(await profileExists(dry.id))}`);
  rec('1 Dry run', 'no abuse row written on a dry run', !(await abuseRowFor(mkEmail('dry'), dry.tenant_id)), 'expected none');

  // ── Phase 2 — LIVE sweep ───────────────────────────────────────────────────
  const abandon = await createPending(mkEmail('abandon'));
  await backdate(abandon.id, 31);
  const fresh = await createPending(mkEmail('fresh')); // recent → must survive
  createdUserIds.push(fresh.id);
  const active = await createPending(mkEmail('active'));
  await backdate(active.id, 31, { status: 'active' }); // aged but ACTIVE → must survive
  createdUserIds.push(active.id);

  const abandonEmail = mkEmail('abandon');
  const abandonUsername = abandon.username;

  const live = await runAbandonmentSweep({
    supabaseClient: svc, pepper: PEPPER, keyVersion: KEY_VERSION, maxAgeDays: MAX_AGE_DAYS,
    dryRun: false, logger: silent,
  });
  rec('2 Live sweep', 'sweep reported deletions', live.deleted >= 2, `deleted=${live.deleted} hashed=${live.hashed}`);

  // Abandoned account: fully gone
  rec('2 Live sweep', 'abandoned auth.users row deleted', !(await authUserExists(abandon.id)), `present=${await authUserExists(abandon.id)}`);
  rec('2 Live sweep', 'abandoned profile cascade-deleted', !(await profileExists(abandon.id)), 'expected gone');
  {
    const { data: ids } = await svc.from('account_identifiers').select('id').eq('account_id', abandon.id);
    rec('2 Live sweep', 'abandoned identifiers cascade-deleted', (ids?.length ?? 0) === 0, `rows=${ids?.length ?? 0}`);
  }
  // Username released (reuse no longer blocked)
  rec('2 Live sweep', 'system username released (reclaimable)', (await usernameRow(abandon.tenant_id, abandonUsername)).length === 0, `username='${abandonUsername}'`);

  // Abuse hash recorded — keyed, not plaintext, count >= 1
  const abuse = await abuseRowFor(abandonEmail, abandon.tenant_id);
  rec('2 Live sweep', 'abuse hash recorded for abandoned email', !!abuse, abuse ? `count=${abuse.abandon_count}` : 'MISSING');
  if (abuse) {
    const storedHex = byteaToHex(abuse.email_hash);
    rec('2 Live sweep', 'stored hash equals HMAC(email,pepper)', storedHex === hmacHex(abandonEmail), 'keyed HMAC match');
    rec('2 Live sweep', 'stored hash is NOT a plain SHA-256 (keyed)', storedHex !== plainSha256Hex(abandonEmail), 'differs from unkeyed digest');
    rec('2 Live sweep', 'no plaintext email column exists on the row', !('email' in abuse) && !('value' in abuse), `cols=${Object.keys(abuse).join(',')}`);
  }

  // DRY fixture (aged pending) is now caught by the LIVE sweep
  rec('2 Live sweep', 'dry-run fixture deleted by the live sweep', !(await profileExists(dry.id)), 'expected gone');

  // Negatives: survivors
  rec('2 Live sweep', 'fresh in-window pending account UNTOUCHED', !!(await profileExists(fresh.id)), 'expected present');
  rec('2 Live sweep', 'aged ACTIVE account UNTOUCHED', !!(await profileExists(active.id)), 'expected present');

  // ── Phase 3 — repeat-abandon increments, no duplicate ──────────────────────
  if (abuse) {
    const before = abuse.abandon_count;
    const { error } = await svc.rpc('record_abandoned_email_hash', {
      p_tenant_id: abandon.tenant_id, p_email_hash_hex: hmacHex(abandonEmail), p_key_version: KEY_VERSION,
    });
    const after = await abuseRowFor(abandonEmail, abandon.tenant_id);
    rec('3 Repeat', 'repeat record increments abandon_count', !error && after?.abandon_count === before + 1, `${before} → ${after?.abandon_count}`);
    // count matching rows in JS (avoid unreliable PostgREST bytea equality filter)
    const want = hmacHex(abandonEmail);
    const { data: allRows } = await svc.from('email_hash_abuse').select('email_hash')
      .eq('tenant_id', abandon.tenant_id).eq('key_version', KEY_VERSION);
    const dupeCount = (allRows || []).filter((r) => byteaToHex(r.email_hash) === want).length;
    rec('3 Repeat', 'no duplicate row on conflict', dupeCount === 1, `rows=${dupeCount}`);
  }

  // ── Phase 4 — support RPCs are service_role-only ───────────────────────────
  if (ANON_KEY) {
    const anon = createClient(SB_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    {
      const { error } = await anon.rpc('list_abandoned_pending_accounts', { p_max_age: '30 days' });
      rec('4 RLS', 'list_abandoned_pending_accounts denied to anon/authenticated', !!error, error ? `denied: ${error.message}` : 'UNEXPECTED SUCCESS');
    }
    {
      const { error } = await anon.rpc('record_abandoned_email_hash', {
        p_tenant_id: abandon.tenant_id, p_email_hash_hex: hmacHex('x@example.com'), p_key_version: KEY_VERSION,
      });
      rec('4 RLS', 'record_abandoned_email_hash denied to anon/authenticated', !!error, error ? `denied: ${error.message}` : 'UNEXPECTED SUCCESS');
    }
  } else {
    rec('4 RLS', 'anon deny checks (skipped — no STAGING_SUPABASE_ANON_KEY)', true, 'skipped');
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
