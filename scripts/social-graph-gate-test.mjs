#!/usr/bin/env node
/**
 * scripts/social-graph-gate-test.mjs — Phase 2 Step 5: Social-graph + safety gate.
 *
 * Proves the migration-011 contact graph, blocks, reports, and invites behave per
 * policies.md §2–§6 and decisions.md (2026-06-10), driving the SECURITY DEFINER RPCs
 * AS real authenticated users (their own JWT) — never the service-role key for
 * assertions (it bypasses RLS and would mask a leak). The service key is used only
 * for one-time fixture setup and for resetting the graph between phases so the gate
 * is re-runnable.
 *
 * Why RPCs and direct-write-denial: every social table is RLS SELECT-only (or no
 * policy), so authenticated clients cannot INSERT/UPDATE the graph directly. All
 * mutation goes through the definer RPCs, which re-impose the rules in code. This
 * gate proves both halves: the RPCs enforce the policy, and the raw tables reject a
 * direct client write.
 *
 * Coverage (maps to migration 011 verification block §6 a–k):
 *   1. Mutual-accept happy path — request→pending, duplicate→error, B sees incoming,
 *      respond(accept)→accepted, exactly one canonical-pair row
 *   2. Reverse-request shortcut (glare) — A→B pending then B→A → accepted, still ONE row
 *   3. Blocks — block gates request + accept both directions; blocker sees the block,
 *      blocked does NOT; symmetric discovery hide; unblock restores
 *   4. Report — report_account is atomic report + active block (both land)
 *   5. Invites — create→token, redeem→accepted (via=invite_link, initiator=creator),
 *      re-redeem→error, redeem-own→error, revoked/expired rejected
 *   6. Cross-tenant isolation — tenant-2 user cannot request or redeem into tenant 1
 *   7. RLS hardening — direct client write to relationships denied; email_hash_abuse
 *      fully denied to authenticated clients
 *
 * Run:  node scripts/social-graph-gate-test.mjs
 *   Reuses ./.env.rls-test (same vars as the Step 3/4 gates). See .env.rls-test.example.
 *   Exit 0 = all assertions passed (gate GREEN). Exit 1 = at least one failed (HARD STOP).
 *
 * SAFETY: mutates the target DB (wipes + rebuilds the social graph for the test
 * users, sets passwords, ensures a throwaway tenant 2 + user C). Refuses to run
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

// RPC expected to succeed and return an exact scalar.
async function rpcReturns(cat, name, client, fn, args, expected) {
  const { data, error } = await client.rpc(fn, args);
  rec(cat, name, !error && data === expected,
    error ? `ERROR ${error.message}` : `returned ${JSON.stringify(data)} (want ${JSON.stringify(expected)})`);
  return data;
}
// RPC expected to succeed; assert via a predicate on the returned value.
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
// RPC returning a row set: assert it does NOT contain a target account_id.
async function rpcLacksAccount(cat, name, client, fn, args, targetId) {
  const { data, error } = await client.rpc(fn, args);
  const rows = Array.isArray(data) ? data : [];
  rec(cat, name, !error && !rows.some((r) => r.account_id === targetId),
    error ? `ERROR ${error.message}` : `${rows.length} rows; target ${targetId.slice(0, 8)} ${rows.some((r) => r.account_id === targetId) ? 'PRESENT (bad)' : 'absent'}`);
  return rows;
}
// RPC returning a row set: assert it DOES contain a target account_id.
async function rpcHasAccount(cat, name, client, fn, args, targetId) {
  const { data, error } = await client.rpc(fn, args);
  const rows = Array.isArray(data) ? data : [];
  rec(cat, name, !error && rows.some((r) => r.account_id === targetId),
    error ? `ERROR ${error.message}` : `${rows.length} rows; ids=[${rows.map((r) => r.account_id?.slice(0, 8)).join(',')}]`);
  return rows;
}

// Canonical pair (lo<hi) for two uuids — JS string compare matches Postgres uuid order.
const pair = (x, y) => (x < y ? [x, y] : [y, x]);

// Wipe all Step-5 graph state for the given account ids (FK-safe order). Service role.
async function resetGraph(ids) {
  await svc.from('invite_redemptions').delete().in('redeemed_by', ids);
  // also clear redemptions of invites these users created
  const { data: inv } = await svc.from('invites').select('id').in('created_by', ids);
  if (inv?.length) await svc.from('invite_redemptions').delete().in('invite_id', inv.map((r) => r.id));
  await svc.from('invites').delete().in('created_by', ids);
  await svc.from('reports').delete().in('reporter_id', ids);
  await svc.from('reports').delete().in('reported_id', ids);
  await svc.from('blocks').delete().in('blocker_id', ids);
  await svc.from('blocks').delete().in('blocked_id', ids);
  await svc.from('relationships').delete().in('account_lo', ids);
  await svc.from('relationships').delete().in('account_hi', ids);
}

// Read the single relationships row for a pair (service role; bypasses RLS).
async function pairRow(a, b) {
  const [lo, hi] = pair(a, b);
  const { data } = await svc.from('relationships').select('*')
    .eq('account_lo', lo).eq('account_hi', hi);
  return data || [];
}

// ── fixtures (service role; idempotent) ──────────────────────────────────────
async function ensureFixtures() {
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

  // A and B active + discoverable (so the discovery-hide assertions are meaningful).
  for (const id of [ids.A, ids.B]) {
    await svc.from('profiles').update({ status: 'active', tenant_id: TENANT_1 }).eq('id', id);
    await svc.from('account_settings')
      .update({ discoverable_by_email: true, discoverable_by_username: true }).eq('account_id', id);
  }

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
  ids.C = cUser.id;

  // Usernames + emails for the discovery-hide assertions.
  const { data: profs, error: pErr } = await svc.from('profiles')
    .select('id, username').in('id', [ids.A, ids.B]);
  if (pErr) throw new Error(`read usernames failed: ${pErr.message}`);
  ids.aUsername = profs.find((p) => p.id === ids.A)?.username;
  ids.bUsername = profs.find((p) => p.id === ids.B)?.username;
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
  console.log(`\nSocial-graph gate (Step 5) → ${SB_URL}\n`);
  console.log('Setting up fixtures…');
  const fx = await ensureFixtures();

  console.log('Signing in as A, B, C…');
  const A = await signIn(A_EMAIL);
  const B = await signIn(B_EMAIL);
  const C = await signIn(C_EMAIL);
  if (A.id !== fx.A || B.id !== fx.B || C.id !== fx.C) throw new Error('id mismatch between fixture and sign-in');

  const aPrefix = (fx.aUsername || '').slice(0, 4);
  const bPrefix = (fx.bUsername || '').slice(0, 4);

  // ═══ 1. Mutual-accept happy path ═══════════════════════════════════════════
  await resetGraph([A.id, B.id, C.id]);
  const C1 = '1. mutual accept';

  await rpcReturns(C1, 'A requests B (via username) → pending', A.client,
    'request_contact', { p_target: B.id, p_via: 'username' }, 'pending');

  // B can SELECT the incoming pending row (RLS: either party sees it).
  {
    const { data, error } = await B.client.from('relationships')
      .select('state, initiator_id, account_lo, account_hi');
    const r = (data || [])[0];
    rec(C1, 'B sees the incoming pending row (RLS party-visible)',
      !error && (data || []).length === 1 && r?.state === 'pending' && r?.initiator_id === A.id,
      error ? `ERROR ${error.message}` : `rows=${(data || []).length} state=${r?.state} initiator=${r?.initiator_id?.slice(0, 8)}`);
  }

  await rpcErrors(C1, 'A requests B again → error (already pending)', A.client,
    'request_contact', { p_target: B.id, p_via: 'username' });

  await rpcReturns(C1, 'B accepts A → accepted', B.client,
    'respond_to_contact', { p_other: A.id, p_accept: true }, 'accepted');

  {
    const rows = await pairRow(A.id, B.id);
    rec(C1, 'exactly one canonical-pair row, state=accepted',
      rows.length === 1 && rows[0].state === 'accepted',
      `rows=${rows.length} state=${rows[0]?.state}`);
  }

  // ═══ 2. Reverse-request shortcut (glare) ═══════════════════════════════════
  await resetGraph([A.id, B.id, C.id]);
  const C2 = '2. reverse-request (glare)';

  await rpcReturns(C2, 'A requests B → pending', A.client,
    'request_contact', { p_target: B.id, p_via: 'email' }, 'pending');
  await rpcReturns(C2, 'B requests A (reverse) → accepted (shortcut)', B.client,
    'request_contact', { p_target: A.id, p_via: 'username' }, 'accepted');
  {
    const rows = await pairRow(A.id, B.id);
    rec(C2, 'still exactly ONE row (canonical pair, no glare dup)',
      rows.length === 1 && rows[0].state === 'accepted',
      `rows=${rows.length} state=${rows[0]?.state}`);
  }

  // ═══ 3. Blocks ─ gate + visibility + symmetric discovery hide ══════════════
  await resetGraph([A.id, B.id, C.id]);
  const C3 = '3. blocks';

  // Set up a pending request, then A blocks B.
  await rpcReturns(C3, 'A requests B → pending (pre-block)', A.client,
    'request_contact', { p_target: B.id, p_via: 'username' }, 'pending');
  await rpcReturns(C3, 'A blocks B → blocked', A.client,
    'block_account', { p_target: B.id }, 'blocked');
  await rpcReturns(C3, 'A blocks B again → already_blocked (idempotent)', A.client,
    'block_account', { p_target: B.id }, 'already_blocked');

  // Block gate, both directions.
  await rpcErrors(C3, 'A cannot re-request B while blocked', A.client,
    'request_contact', { p_target: B.id, p_via: 'username' });
  await rpcErrors(C3, 'B cannot accept A while blocked', B.client,
    'respond_to_contact', { p_other: A.id, p_accept: true });
  await rpcErrors(C3, 'B cannot request A while blocked (reverse)', B.client,
    'request_contact', { p_target: A.id, p_via: 'username' });

  // Block visibility: blocker sees own block; blocked sees nothing.
  {
    const { data: aSees } = await A.client.from('blocks').select('blocked_id');
    rec(C3, 'blocker (A) sees own block row',
      (aSees || []).some((r) => r.blocked_id === B.id),
      `A block rows=${(aSees || []).length}`);
    const { data: bSees } = await B.client.from('blocks').select('id');
    rec(C3, 'blocked (B) sees NO block row (privacy)',
      (bSees || []).length === 0, `B block rows=${(bSees || []).length}`);
  }

  // Symmetric discovery hide (both directions invisible while blocked).
  await rpcLacksAccount(C3, 'A cannot find B by email (hidden by block)', A.client,
    'find_account_by_email', { p_email: B_EMAIL }, B.id);
  await rpcLacksAccount(C3, 'B cannot find A by email (symmetric hide)', B.client,
    'find_account_by_email', { p_email: A_EMAIL }, A.id);
  if (bPrefix.length >= 3) {
    await rpcLacksAccount(C3, 'A cannot find B by username (hidden by block)', A.client,
      'search_accounts_by_username', { p_prefix: bPrefix, p_limit: 10 }, B.id);
  }

  // Unblock restores discovery.
  await rpcReturns(C3, 'A unblocks B → unblocked', A.client,
    'unblock_account', { p_target: B.id }, 'unblocked');
  await rpcReturns(C3, 'A unblocks B again → not_blocked', A.client,
    'unblock_account', { p_target: B.id }, 'not_blocked');
  await rpcHasAccount(C3, 'A can find B by email again after unblock', A.client,
    'find_account_by_email', { p_email: B_EMAIL }, B.id);

  // ═══ 4. Report = atomic report + block ═════════════════════════════════════
  await resetGraph([A.id, B.id, C.id]);
  const C4 = '4. report (atomic block)';

  await rpcOk(C4, 'A reports B (spam) → returns a report id', A.client,
    'report_account', { p_target: B.id, p_reason: 'spam', p_details: 'gate test' },
    (d) => typeof d === 'string' && d.length > 0);
  {
    const { data: rep } = await svc.from('reports').select('status')
      .eq('reporter_id', A.id).eq('reported_id', B.id);
    rec(C4, 'report row recorded at status=open',
      (rep || []).length === 1 && rep[0].status === 'open', `reports=${(rep || []).length}`);
    const { data: blk } = await svc.from('blocks').select('id')
      .eq('blocker_id', A.id).eq('blocked_id', B.id).is('unblocked_at', null);
    rec(C4, 'active block auto-created in same transaction',
      (blk || []).length === 1, `active blocks=${(blk || []).length}`);
  }

  // ═══ 5. Invites ════════════════════════════════════════════════════════════
  await resetGraph([A.id, B.id, C.id]);
  const C5 = '5. invites';

  const token = await rpcOk(C5, 'A creates a contact invite → token', A.client,
    'create_invite', { p_kind: 'contact', p_max_uses: null, p_expires_at: null },
    (d) => typeof d === 'string' && d.length >= 16);

  await rpcErrors(C5, 'A cannot redeem own invite', A.client,
    'redeem_invite', { p_token: token });
  await rpcReturns(C5, 'B redeems invite → accepted', B.client,
    'redeem_invite', { p_token: token }, 'accepted');
  {
    const rows = await pairRow(A.id, B.id);
    rec(C5, 'contact auto-accepted via invite_link, initiator=creator(A)',
      rows.length === 1 && rows[0].state === 'accepted'
        && rows[0].via_identifier_type === 'invite_link' && rows[0].initiator_id === A.id,
      `state=${rows[0]?.state} via=${rows[0]?.via_identifier_type} initiator=${rows[0]?.initiator_id?.slice(0, 8)}`);
  }
  await rpcErrors(C5, 'B re-redeems same invite → error (already redeemed)', B.client,
    'redeem_invite', { p_token: token });

  // Revoked invite rejected.
  await resetGraph([A.id, B.id, C.id]);
  const token2 = await rpcOk(C5, 'A creates a second invite', A.client,
    'create_invite', { p_kind: 'contact' }, (d) => typeof d === 'string');
  {
    const { data: inv } = await A.client.from('invites').select('id').eq('token', token2).single();
    await rpcReturns(C5, 'A revokes the invite → revoked', A.client,
      'revoke_invite', { p_invite_id: inv.id }, 'revoked');
  }
  await rpcErrors(C5, 'B cannot redeem a revoked invite', B.client,
    'redeem_invite', { p_token: token2 });

  // Expired invite rejected.
  const token3 = await rpcOk(C5, 'A creates an already-expired invite', A.client,
    'create_invite', { p_kind: 'contact', p_max_uses: null, p_expires_at: '2000-01-01T00:00:00Z' },
    (d) => typeof d === 'string');
  await rpcErrors(C5, 'B cannot redeem an expired invite', B.client,
    'redeem_invite', { p_token: token3 });

  // conversation-kind invite rejected in Phase 2.
  await rpcErrors(C5, "create_invite kind='conversation' rejected (Phase 3)", A.client,
    'create_invite', { p_kind: 'conversation' });

  // ═══ 6. Cross-tenant isolation ═════════════════════════════════════════════
  await resetGraph([A.id, B.id, C.id]);
  const C6 = '6. cross-tenant';

  await rpcErrors(C6, 'C (tenant 2) cannot request A (tenant 1) → not found', C.client,
    'request_contact', { p_target: A.id, p_via: 'username' });
  {
    const tok = await A.client.rpc('create_invite', { p_kind: 'contact' });
    await rpcErrors(C6, 'C cannot redeem a tenant-1 invite (opaque not-found)', C.client,
      'redeem_invite', { p_token: tok.data });
  }

  // ═══ 7. RLS hardening — direct writes denied ═══════════════════════════════
  const C7 = '7. RLS hardening';
  {
    const [lo, hi] = pair(A.id, B.id);
    const { error } = await A.client.from('relationships').insert({
      tenant_id: TENANT_1, account_lo: lo, account_hi: hi,
      initiator_id: A.id, state: 'accepted', via_identifier_type: 'username',
    });
    rec(C7, 'direct client INSERT into relationships denied (RPC-only writes)',
      !!error, error ? `denied: ${error.message}` : 'UNEXPECTED SUCCESS');
  }
  {
    const { data, error } = await A.client.from('email_hash_abuse').select('id');
    rec(C7, 'email_hash_abuse fully denied to authenticated clients',
      !!error || (data || []).length === 0,
      error ? `denied: ${error.message}` : `rows=${(data || []).length}`);
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
  await resetGraph([A.id, B.id, C.id]);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(`\n✗ Harness error (not an assertion failure): ${err.message}\n`);
  process.exitCode = 2;
});
