#!/usr/bin/env node
/**
 * scripts/auth-refresh-gate-test.mjs — Phase 2.1: token-auth + refresh/rotation gate.
 *
 * Closes two Phase 2.1 checklist items with one script:
 *   • "Refresh / rotation behavior verified" (the last open 2.1 item), and
 *   • the previously-proposed `api-auth-gate-test.mjs` negative/positive auth paths
 *     (see verification.md "Phase 2.1 — Token auth"). This script supersedes it.
 *
 * WHAT IT PROVES
 *   Auth boundary (needs STAGING_API_BASE_URL — a running Vercel Preview on staging):
 *     A1. No Authorization header            → 401
 *     A2. Garbage bearer token               → 401
 *     A3. Valid access token                 → 200   (mode:'detect', gpt-4o-mini, ~cents)
 *   Refresh / rotation (Supabase side, always runs):
 *     R1. refreshSession(refresh1) rotates    → new access AND new refresh token
 *     R2. the rotated (fresh) access token    → 200 at the endpoint   (if API base set)
 *     R3. reuse of the OLD refresh token, after the reuse interval, is rejected
 *         (refresh-token rotation / reuse detection is on)
 *
 * WHY THIS SHAPE: the frontend's apiFetch() reads supabase.auth.getSession() on every
 * call, and the browser client auto-refreshes in the background — so the load-bearing
 * guarantee is "a rotated token still authenticates, and a replayed old refresh token
 * does not." This script forces that rotation explicitly instead of waiting ~1h for
 * natural access-token expiry.
 *
 * Run:  node scripts/auth-refresh-gate-test.mjs
 *   Reuses ./.env.rls-test (same file as the other gates). Needs:
 *     STAGING_SUPABASE_URL, STAGING_SUPABASE_ANON_KEY,
 *     RLS_TEST_A_EMAIL, RLS_TEST_PASSWORD,
 *     RLS_TEST_CONFIRM_STAGING=yes
 *   Optional:
 *     STAGING_API_BASE_URL   — Vercel Preview base (e.g. https://<branch>.vercel.app).
 *                              If unset, the A1–A3 / R2 endpoint checks are SKIPPED and
 *                              only the Supabase-side rotation (R1, R3) runs.
 *     STAGING_SUPABASE_SERVICE_ROLE_KEY — if set, ensures the test user has a password
 *                              (so the gate is standalone-runnable); otherwise the user
 *                              must already have a password (any prior RLS gate sets one).
 *
 * Exit 0 = all assertions passed (gate GREEN). Exit 1 = at least one failed. Exit 2 = misconfig.
 *
 * SAFETY: never point this at production. Refuses unless RLS_TEST_CONFIRM_STAGING=yes,
 * and hard-refuses if the Supabase URL or API base looks like prod (app.jistchat.com).
 * It signs in as a staging test user and rotates that user's refresh token (which may
 * end the current session by design) — harmless on staging.
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
  RLS_TEST_PASSWORD: PASSWORD,
  RLS_TEST_CONFIRM_STAGING: CONFIRM,
  STAGING_API_BASE_URL: API_BASE_RAW,
} = process.env;

const API_BASE = (API_BASE_RAW || '').replace(/\/+$/, '');

// ── env + safety guards ──────────────────────────────────────────────────────
const required = {
  STAGING_SUPABASE_URL: SB_URL,
  STAGING_SUPABASE_ANON_KEY: ANON_KEY,
  RLS_TEST_A_EMAIL: A_EMAIL,
  RLS_TEST_PASSWORD: PASSWORD,
};
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`\n✗ Missing required env vars: ${missing.join(', ')}`);
  console.error('  Copy .env.rls-test.example → .env.rls-test and fill it in.\n');
  process.exit(2);
}
if (CONFIRM !== 'yes') {
  console.error('\n✗ Refusing to run: this script signs in + rotates a session token.');
  console.error('  Set RLS_TEST_CONFIRM_STAGING=yes ONLY when pointed at staging.');
  console.error(`  Current Supabase target: ${SB_URL}\n`);
  process.exit(2);
}
const prodMarker = /app\.jistchat\.com/i;
if (prodMarker.test(SB_URL) || prodMarker.test(API_BASE)) {
  console.error('\n✗ Refusing to run: target looks like PRODUCTION (app.jistchat.com).');
  console.error('  This gate is staging-only. Never point it at prod.\n');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (label) => { pass++; console.log(`  ✓ ${label}`); };
const bad = (label, extra) => { fail++; console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`); };

// POST to the translate endpoint with an optional bearer token; return HTTP status.
async function callTranslate(token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== undefined && token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/api/v1/translate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'hi', mode: 'detect' }),
  });
  return res.status;
}

async function main() {
  console.log('\n=== Phase 2.1 auth + refresh/rotation gate (staging) ===');
  console.log(`Supabase: ${SB_URL}`);
  console.log(`API base: ${API_BASE || '(unset — endpoint checks A1–A3/R2 SKIPPED)'}\n`);

  // Optional: ensure the test user has a password so the gate is standalone-runnable.
  if (SERVICE_KEY) {
    const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
    let page = 1, uid = null;
    while (page <= 20 && !uid) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) break;
      uid = data.users.find((u) => u.email?.toLowerCase() === A_EMAIL.toLowerCase())?.id ?? null;
      if (data.users.length < 200) break;
      page++;
    }
    if (uid) {
      await admin.auth.admin.updateUserById(uid, { password: PASSWORD, email_confirm: true });
      console.log('· ensured test-user password via service role\n');
    }
  }

  // Manual-refresh client: we drive rotation ourselves.
  const client = createClient(SB_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── Sign in ────────────────────────────────────────────────────────────────
  const { data: s1, error: signInErr } = await client.auth.signInWithPassword({
    email: A_EMAIL, password: PASSWORD,
  });
  if (signInErr || !s1?.session?.access_token) {
    console.error(`\n✗ Sign-in failed: ${signInErr?.message || 'no session'}`);
    console.error('  Ensure the test user has a password (set STAGING_SUPABASE_SERVICE_ROLE_KEY,');
    console.error('  or run any existing RLS gate once — they set passwords), and that');
    console.error('  email+password sign-in is enabled on staging Auth.\n');
    process.exit(2);
  }
  const access1 = s1.session.access_token;
  const refresh1 = s1.session.refresh_token;
  console.log('· signed in as test user A\n');

  // ── A. Auth boundary (needs a live Preview endpoint) ─────────────────────────
  if (API_BASE) {
    console.log('A. Auth boundary at /api/v1/translate');
    try {
      const s = await callTranslate(undefined);
      s === 401 ? ok(`A1 no token → 401`) : bad('A1 no token → 401', `got ${s}`);
    } catch (e) { bad('A1 no token → 401', e.message); }
    try {
      const s = await callTranslate('not.a.jwt');
      s === 401 ? ok(`A2 garbage token → 401`) : bad('A2 garbage token → 401', `got ${s}`);
    } catch (e) { bad('A2 garbage token → 401', e.message); }
    try {
      const s = await callTranslate(access1);
      s === 200 ? ok(`A3 valid token → 200`) : bad('A3 valid token → 200', `got ${s}`);
    } catch (e) { bad('A3 valid token → 200', e.message); }
    console.log('');
  }

  // ── R. Refresh / rotation ────────────────────────────────────────────────────
  console.log('R. Refresh / rotation');
  const { data: s2, error: refErr } = await client.auth.refreshSession({ refresh_token: refresh1 });
  if (refErr || !s2?.session?.access_token) {
    bad('R1 refresh rotates tokens', refErr?.message || 'no session returned');
  } else {
    const access2 = s2.session.access_token;
    const refresh2 = s2.session.refresh_token;
    (access2 && access2 !== access1)
      ? ok('R1a refresh issues a NEW access token')
      : bad('R1a refresh issues a NEW access token', 'access token unchanged');
    (refresh2 && refresh2 !== refresh1)
      ? ok('R1b refresh ROTATES the refresh token')
      : bad('R1b refresh rotates the refresh token', 'refresh token unchanged');

    if (API_BASE) {
      try {
        const s = await callTranslate(access2);
        s === 200 ? ok('R2 rotated access token → 200') : bad('R2 rotated access token → 200', `got ${s}`);
      } catch (e) { bad('R2 rotated access token → 200', e.message); }
    }
  }

  // R3: replay the OLD refresh token after the reuse interval (default ~10s) → rejected.
  // Done last: reuse detection may revoke the session by design.
  console.log('· waiting 12s past the refresh-token reuse interval …');
  await sleep(12000);
  const { data: s3, error: reuseErr } = await client.auth.refreshSession({ refresh_token: refresh1 });
  if (reuseErr || !s3?.session?.access_token) {
    ok('R3 replayed OLD refresh token → rejected (rotation/reuse detection on)');
  } else {
    bad('R3 replayed OLD refresh token → rejected', 'old refresh token was still accepted');
  }

  await client.auth.signOut().catch(() => {});

  // ── Result ───────────────────────────────────────────────────────────────────
  console.log(`\n=== ${fail === 0 ? 'GREEN' : 'RED'} — ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\n✗ Unexpected error:', e); process.exit(1); });
