#!/usr/bin/env node
/**
 * scripts/rls-adversarial-test.mjs — Phase 2 Step 3: RLS adversarial gate.
 *
 * The hard-stop security gate for Phase 2. Proves that row-level security on the
 * Phase 2 tables actually isolates users and tenants, by driving real PostgREST
 * requests AS each user (with their own JWT) and asserting what they can and
 * cannot do. RLS only applies to the `authenticated` role via a user JWT — the
 * service-role key bypasses it — so this test signs in as real users; it does NOT
 * use the service key for the assertions (only for one-time fixture setup).
 *
 * How RLS denial surfaces (this is why each assertion checks a specific shape):
 *   - Blocked SELECT  → row is filtered out → empty array, NO error (HTTP 200).
 *   - Blocked UPDATE via row policy (USING) → 0 rows changed, NO error.
 *   - Blocked UPDATE via column GRANT (e.g. is_verified) → ERROR (permission denied).
 *   - Blocked INSERT via WITH CHECK (e.g. spoofed sender_id) → ERROR (RLS violation).
 * A test that expected an error but got an empty result (or vice-versa) is a real
 * failure worth investigating, not a wording quibble — the mechanism matters.
 *
 * Coverage:
 *   1. Cross-user reads of own-only tables (account_identifiers/_settings/profile_events) → empty
 *   2. Intended same-tenant reads (profiles, linguistic profiles) → succeed (not over-locked)
 *   3. Self-write privilege escalation (is_verified/status/username) → denied   [migration 007 OPUS-FIX #2]
 *   4. Allowed self-write (display_name) → succeeds (positive control)
 *   5. Cross-user writes (edit/insert as another user) → denied
 *   6. Cross-tenant isolation: a user in tenant 2 cannot see tenant-1 data → empty
 *   7. Defense-in-depth: re-read escalation targets as service role, confirm unchanged
 *
 * Run:  node scripts/rls-adversarial-test.mjs
 *   Reads config from ./.env.rls-test (gitignored via .env*) or the process env.
 *   See .env.rls-test.example for the required variables.
 *   Exit 0 = all assertions passed (gate GREEN). Exit 1 = at least one failed (HARD STOP).
 *
 * SAFETY: this script mutates the target DB (sets test-user passwords, creates a
 * throwaway tenant 2 + user C, inserts/deletes RLS-TEST messages). It refuses to
 * run unless RLS_TEST_CONFIRM_STAGING=yes. NEVER point it at production.
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

// Blocked read → expect empty array, no error.
async function readEmpty(cat, name, client, table, col, val) {
  const { data, error } = await client.from(table).select('*').eq(col, val);
  rec(cat, name, !error && Array.isArray(data) && data.length === 0,
    error ? `ERROR ${error.message}` : `${data?.length ?? '?'} rows (want 0)`);
}
// Intended read → expect ≥1 row.
async function readHasRows(cat, name, client, table, col, val) {
  const { data, error } = await client.from(table).select('*').eq(col, val);
  rec(cat, name, !error && Array.isArray(data) && data.length >= 1,
    error ? `ERROR ${error.message}` : `${data?.length ?? '?'} rows (want ≥1)`);
}
// Blocked write by row policy → expect 0 rows changed, no error.
async function updateBlockedEmpty(cat, name, client, table, patch, col, val) {
  const { data, error } = await client.from(table).update(patch).eq(col, val).select();
  rec(cat, name, !error && Array.isArray(data) && data.length === 0,
    error ? `also denied via ERROR ${error.message}` : `${data?.length ?? '?'} rows changed (want 0)`);
}
// Blocked write by column grant / WITH CHECK → expect an error.
async function writeErrors(cat, name, fn) {
  const { data, error } = await fn();
  rec(cat, name, !!error,
    error ? `denied: ${error.message}` : `UNEXPECTED SUCCESS: ${JSON.stringify(data)}`);
}
// Allowed write → expect ≥1 row changed/inserted.
async function writeOk(cat, name, fn) {
  const { data, error } = await fn();
  rec(cat, name, !error && Array.isArray(data) && data.length >= 1,
    error ? `ERROR ${error.message}` : `${data?.length ?? '?'} rows`);
}

// ── fixture setup (service role; idempotent) ─────────────────────────────────
async function ensureFixtures() {
  // throwaway tenant 2
  const { error: tErr } = await svc.from('tenants')
    .upsert({ id: TENANT_2, name: 'RLS Test Tenant 2' }, { onConflict: 'id' });
  if (tErr) throw new Error(`tenant 2 upsert failed: ${tErr.message}`);

  // look up existing auth users
  const { data: list, error: lErr } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (lErr) throw new Error(`admin.listUsers failed: ${lErr.message}`);
  const byEmail = (e) => list.users.find((u) => u.email?.toLowerCase() === e.toLowerCase());

  // A and B must already exist (created via the magic-link flow). Give them known passwords.
  for (const e of [A_EMAIL, B_EMAIL]) {
    const u = byEmail(e);
    if (!u) throw new Error(`expected existing staging user not found: ${e} — create it via the app first`);
    const { error } = await svc.auth.admin.updateUserById(u.id, { password: PASSWORD, email_confirm: true });
    if (error) throw new Error(`set password for ${e} failed: ${error.message}`);
  }

  // C: create if absent (trigger makes a tenant-1 pending profile), then re-point to tenant 2.
  let cUser = byEmail(C_EMAIL);
  if (!cUser) {
    const { data, error } = await svc.auth.admin.createUser({
      email: C_EMAIL, password: PASSWORD, email_confirm: true,
    });
    if (error) throw new Error(`create user C failed: ${error.message}`);
    cUser = data.user;
  } else {
    await svc.auth.admin.updateUserById(cUser.id, { password: PASSWORD, email_confirm: true });
  }
  // Re-point C's identity rows into tenant 2 so auth_tenant_id(C) = tenant 2.
  for (const [table, col] of [
    ['profiles', 'id'],
    ['account_identifiers', 'account_id'],
    ['account_settings', 'account_id'],
  ]) {
    const { error } = await svc.from(table).update({ tenant_id: TENANT_2 }).eq(col, cUser.id);
    if (error) throw new Error(`re-point ${table} for C failed: ${error.message}`);
  }
  return cUser.id;
}

async function signIn(email) {
  const client = userClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) {
    throw new Error(
      `sign-in failed for ${email}: ${error.message}\n` +
      `  (Ensure the Email/Password provider is enabled on the staging Supabase project.)`
    );
  }
  return { client, id: data.user.id };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nRLS adversarial gate → ${SB_URL}\n`);

  console.log('Setting up fixtures (tenant 2 + test users)…');
  const cId = await ensureFixtures();

  console.log('Signing in as A, B, C…');
  const A = await signIn(A_EMAIL);
  const B = await signIn(B_EMAIL);
  const C = await signIn(C_EMAIL);
  if (C.id !== cId) throw new Error('C id mismatch between fixture and sign-in');

  // 1. Cross-user reads of own-only tables → MUST be empty
  await readEmpty('1. cross-user read (deny)', 'A cannot read B email/identifiers', A.client, 'account_identifiers', 'account_id', B.id);
  await readEmpty('1. cross-user read (deny)', 'A cannot read B account_settings', A.client, 'account_settings', 'account_id', B.id);
  await readEmpty('1. cross-user read (deny)', 'A cannot read B profile events', A.client, 'user_profile_events', 'user_id', B.id);
  await readEmpty('1. cross-user read (deny)', 'B cannot read A email/identifiers', B.client, 'account_identifiers', 'account_id', A.id);

  // 2. Intended same-tenant reads → MUST succeed (catch over-locking)
  await readHasRows('2. same-tenant read (allow)', 'A reads own identifiers', A.client, 'account_identifiers', 'account_id', A.id);
  await readHasRows('2. same-tenant read (allow)', 'A reads B public profile', A.client, 'profiles', 'id', B.id);
  await readHasRows('2. same-tenant read (allow)', 'A reads B linguistic profile (xlation context)', A.client, 'user_linguistic_profiles', 'user_id', B.id);

  // 3. Self-write privilege escalation → MUST be denied (column grant)  [007 OPUS-FIX #2]
  await writeErrors('3. self-escalation (deny)', 'A cannot self-set is_verified=true',
    () => A.client.from('profiles').update({ is_verified: true }).eq('id', A.id).select());
  await writeErrors('3. self-escalation (deny)', 'A cannot self-change username',
    () => A.client.from('profiles').update({ username: `hacked_${Date.now()}` }).eq('id', A.id).select());
  await writeErrors('3. self-escalation (deny)', 'A cannot self-change status',
    () => A.client.from('profiles').update({ status: 'deactivated' }).eq('id', A.id).select());

  // 4. Allowed self-write → MUST succeed (positive control)
  await writeOk('4. self-write (allow)', 'A can change own display_name',
    () => A.client.from('profiles').update({ display_name: 'User A' }).eq('id', A.id).select());

  // 5. Cross-user writes → MUST be denied
  await updateBlockedEmpty('5. cross-user write (deny)', 'A cannot edit B display_name (row scope)', A.client, 'profiles', { display_name: 'pwned' }, 'id', B.id);
  await updateBlockedEmpty('5. cross-user write (deny)', 'A cannot edit B linguistic profile', A.client, 'user_linguistic_profiles', { formality_preference: 'formal' }, 'user_id', B.id);
  await writeErrors('5. cross-user write (deny)', 'A cannot insert message spoofing B as sender',
    () => A.client.from('messages').insert({ sender_id: B.id, tenant_id: TENANT_1, original_text: 'RLS-TEST spoof', source_language: 'en' }).select());

  // Positive control: A CAN insert a message as itself
  await writeOk('5. cross-user write (allow self)', 'A can insert own message',
    () => A.client.from('messages').insert({ sender_id: A.id, tenant_id: TENANT_1, original_text: 'RLS-TEST own', source_language: 'en' }).select());

  // 6. Cross-tenant isolation → user C (tenant 2) MUST NOT see tenant-1 data
  await readEmpty('6. cross-tenant (deny)', 'C cannot read A profile', C.client, 'profiles', 'id', A.id);
  await readEmpty('6. cross-tenant (deny)', 'C cannot read A linguistic profile', C.client, 'user_linguistic_profiles', 'user_id', A.id);
  await readEmpty('6. cross-tenant (deny)', 'C cannot read tenant-1 messages', C.client, 'messages', 'tenant_id', TENANT_1);
  await readEmpty('6. cross-tenant (deny)', 'A cannot read C profile (other tenant)', A.client, 'profiles', 'id', C.id);
  await readHasRows('6. cross-tenant (allow own)', 'C can read own profile (token valid)', C.client, 'profiles', 'id', C.id);

  // 7. Defense-in-depth: confirm escalation attempts left no trace (read as service role)
  const { data: aProf, error: aErr } = await svc.from('profiles')
    .select('is_verified, status, username').eq('id', A.id).single();
  rec('7. defense-in-depth', 'A profile unchanged after escalation attempts',
    !aErr && aProf.is_verified === false && aProf.status === 'active' && aProf.username?.startsWith('user_'),
    aErr ? `ERROR ${aErr.message}` : `is_verified=${aProf.is_verified}, status=${aProf.status}, username=${aProf.username}`);

  // cleanup test messages
  await svc.from('messages').delete().like('original_text', 'RLS-TEST%');

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
