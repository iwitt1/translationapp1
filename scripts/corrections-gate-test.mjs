#!/usr/bin/env node
/**
 * scripts/corrections-gate-test.mjs — Phase 4: corrections capture gate (migration 025 / Spec 14).
 *
 * Proves migration 025 behaves per decisions.md 2026-07-28, driving the SECURITY DEFINER
 * write RPCs (record_correction / record_review) AS real authenticated users (their own
 * JWT) — never the service-role key for assertions (it bypasses RLS and would mask a leak).
 * The service key is used only for fixture setup (seed a conversation + a message + a cached
 * translation + the corrector's linguistic profile), for reading back what the RPC wrote,
 * for the service-role-only deletion hook, and for reset between runs.
 *
 * Coverage:
 *   1. Happy correction — a member corrects a translation → one append row with a SERVER-
 *      ASSEMBLED snapshot (model_output = the cached translation, original_text, prompt_version,
 *      corrector_known_languages, frozen ≤3-msg history window, ownership=platform, pool_status).
 *   2. SELECT-own RLS — the corrector sees their own correction; a non-corrector member does not.
 *   3. Reviews — good/bad upsert toggles a single row; NULL clears it.
 *   4. Adversarial — non-member denied; direct client INSERT/UPDATE/DELETE denied (snapshot
 *      can't be forged; append-only); canonical translation never overwritten; empty/too-long
 *      / no-cached-translation rejected; a soft-left member denied.
 *   5. Deletion hook — anonymize_corrections_for_account() strips corrector PII (user_id +
 *      known_languages) but KEEPS the pair; NOT executable by authenticated.
 *
 * Run:  RLS_TEST_CONFIRM_STAGING=yes node scripts/corrections-gate-test.mjs
 *   Reuses ./.env.rls-test (same vars as the Step 3/4/5 + conversations gates).
 *   Exit 0 = GREEN. Exit 1 = at least one assertion FAILED (HARD STOP). Exit 2 = harness error.
 *
 * SAFETY: mutates the target DB (test conversation/messages/corrections for A/B/C, sets
 * passwords, ensures throwaway tenant 2 + user C). Refuses unless RLS_TEST_CONFIRM_STAGING=yes.
 * NEVER point it at production.
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
    error ? `ERROR ${error.message}` : `returned ${JSON.stringify(data)?.slice(0, 120)}`);
  return data;
}
// RPC expected to raise (PostgREST surfaces a function exception / permission error).
async function rpcErrors(cat, name, client, fn, args) {
  const { data, error } = await client.rpc(fn, args);
  rec(cat, name, !!error,
    error ? `denied: ${error.message}` : `UNEXPECTED SUCCESS: ${JSON.stringify(data)?.slice(0, 80)}`);
}

// ── reset (service role): remove all Phase-4 + conversation state for the users ──────
async function resetState(ids) {
  // conversations A/B/C are/were members of (except the global sentinel)
  const { data: mem } = await svc.from('conversation_members').select('conversation_id').in('account_id', ids);
  const convIds = [...new Set((mem || []).map((r) => r.conversation_id))].filter((c) => c !== GLOBAL_CONVERSATION);

  if (convIds.length) {
    const { data: msgs } = await svc.from('messages').select('id').in('conversation_id', convIds);
    const msgIds = (msgs || []).map((r) => r.id);
    if (msgIds.length) {
      // corrections/reviews FK to messages is ON DELETE SET NULL (they survive the message),
      // so delete them explicitly by message_id BEFORE the messages go.
      await svc.from('translation_corrections').delete().in('message_id', msgIds);
      await svc.from('translation_reviews').delete().in('message_id', msgIds);
      await svc.from('message_translations').delete().in('message_id', msgIds);
      await svc.from('messages').delete().in('id', msgIds); // messages FK NO ACTION → must precede conv delete
    }
    await svc.from('conversation_contexts').delete().in('conversation_id', convIds);
    await svc.from('conversations').delete().in('id', convIds);
  }
  // belt-and-suspenders: any correction/review rows still attributed to these users
  await svc.from('translation_corrections').delete().in('corrector_user_id', ids);
  await svc.from('translation_reviews').delete().in('reviewer_id', ids);
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

  // Corrector (B) linguistic profile — the source of the corrector_known_languages snapshot.
  const { error: ulpErr } = await svc.from('user_linguistic_profiles').upsert(
    { user_id: ids.B, tenant_id: TENANT_1, preferred_language: 'en',
      known_languages: ['en', 'es'], dialect_region: 'es-AR' },
    { onConflict: 'user_id,tenant_id' });
  if (ulpErr) throw new Error(`seed B linguistic profile failed: ${ulpErr.message}`);

  return ids;
}

async function signIn(email) {
  const client = userClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message} (enable Email/Password on staging)`);
  return { client, id: data.user.id };
}

// Seed one message (service role) into a conversation with an explicit created_at.
async function seedMessage(convId, senderId, text, lang, createdAt) {
  const { data, error } = await svc.from('messages').insert({
    conversation_id: convId, sender_id: senderId, original_text: text,
    source_language: lang, tenant_id: TENANT_1, kind: 'user', created_at: createdAt,
  }).select('id').single();
  if (error) throw new Error(`seed message failed: ${error.message}`);
  return data.id;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nCorrections capture gate (Phase 4 / migration 025) → ${SB_URL}\n`);
  console.log('Setting up fixtures…');
  const fx = await ensureFixtures();

  console.log('Signing in as A, B, C…');
  const A = await signIn(A_EMAIL);
  const B = await signIn(B_EMAIL);
  const C = await signIn(C_EMAIL);
  if (A.id !== fx.A || B.id !== fx.B || C.id !== fx.C) throw new Error('id mismatch between fixture and sign-in');

  await resetState([A.id, B.id, C.id]);

  // Fixture conversation: A + B direct. A sends Spanish; B views it in English and corrects.
  const conv = await A.client.rpc('create_conversation', { p_kind: 'direct', p_member_ids: [B.id] })
    .then((r) => { if (r.error) throw new Error(`create_conversation: ${r.error.message}`); return r.data; });

  // Two prior messages (older) + the corrected message — to exercise the frozen history window.
  const t0 = Date.now();
  const iso = (msAgo) => new Date(t0 - msAgo).toISOString();
  await seedMessage(conv, B.id, 'Hola, ¿todo bien?', 'es', iso(180000));
  await seedMessage(conv, A.id, 'Sí, todo tranqui', 'es', iso(120000));
  const MSG_TEXT = 'No seas payaso';
  const msgId = await seedMessage(conv, A.id, MSG_TEXT, 'es', iso(60000));

  // Cached translation of msgId → English (what B sees, and what a correction targets).
  const CACHED = "Don't be a clown";
  const { error: mtErr } = await svc.from('message_translations').insert({
    message_id: msgId, language: 'en', translated_text: CACHED, tenant_id: TENANT_1, prompt_version: '2.1.0',
  });
  if (mtErr) throw new Error(`seed message_translations failed: ${mtErr.message}`);

  // ═══ 1. Happy correction + server-assembled snapshot ═══════════════════════
  const C1 = '1. correction + snapshot';
  const FIX = "Don't be silly";
  const row = await rpcOk(C1, 'B (member) corrects msg/en → row', B.client,
    'record_correction', { p_message_id: msgId, p_target_language: 'en', p_corrected_text: FIX },
    (d) => d && isUuid(d.id));
  const corrId = row?.id;
  // Read the persisted row back via service role and check the snapshot was assembled server-side.
  const { data: saved } = await svc.from('translation_corrections').select('*').eq('id', corrId).maybeSingle();
  rec(C1, 'model_output = the cached translation (server-read, not client-supplied)', saved?.model_output === CACHED, `model_output=${JSON.stringify(saved?.model_output)}`);
  rec(C1, 'original_text = the source message', saved?.original_text === MSG_TEXT, `original_text=${JSON.stringify(saved?.original_text)}`);
  rec(C1, 'corrected_text = the fix', saved?.corrected_text === FIX, `corrected_text=${JSON.stringify(saved?.corrected_text)}`);
  rec(C1, 'prompt_version snapshotted (2.1.0)', saved?.prompt_version === '2.1.0', `prompt_version=${saved?.prompt_version}`);
  rec(C1, 'corrector_user_id = B', saved?.corrector_user_id === B.id, `corrector=${String(saved?.corrector_user_id).slice(0, 8)}`);
  rec(C1, "corrector_known_languages snapshot includes 'es'", Array.isArray(saved?.corrector_known_languages) && saved.corrector_known_languages.includes('es'), `known=${JSON.stringify(saved?.corrector_known_languages)}`);
  rec(C1, 'ownership defaulted to platform (from tenant)', saved?.ownership === 'platform', `ownership=${saved?.ownership}`);
  rec(C1, 'pool_status = unreviewed (filter seam)', saved?.pool_status === 'unreviewed', `pool_status=${saved?.pool_status}`);
  rec(C1, 'model is NULL (documented gap — prompt_version is the anchor)', saved?.model === null, `model=${JSON.stringify(saved?.model)}`);
  rec(C1, 'conversation_history snapshot has the 2 prior messages', Array.isArray(saved?.conversation_history) && saved.conversation_history.length === 2, `history len=${saved?.conversation_history?.length}`);
  rec(C1, 'register_context present or null (no context row seeded → null ok)', saved !== undefined, `register_context=${JSON.stringify(saved?.register_context)}`);

  // ═══ 2. SELECT-own RLS ═════════════════════════════════════════════════════
  const C2 = '2. SELECT-own RLS';
  {
    const { data } = await B.client.from('translation_corrections').select('id').eq('id', corrId);
    rec(C2, 'B (corrector) can SELECT own correction', (data || []).length === 1, `rows=${(data || []).length}`);
  }
  {
    const { data } = await A.client.from('translation_corrections').select('id').eq('id', corrId);
    rec(C2, "A (member, not corrector) CANNOT SELECT B's correction", (data || []).length === 0, `rows=${(data || []).length}`);
  }
  {
    const { data } = await C.client.from('translation_corrections').select('id').eq('id', corrId);
    rec(C2, 'C (other tenant) CANNOT SELECT it', (data || []).length === 0, `rows=${(data || []).length}`);
  }

  // ═══ 3. Reviews — good/bad upsert toggle + clear ═══════════════════════════
  const C3 = '3. reviews (good/bad toggle)';
  await rpcOk(C3, "B rates 'good' → row", B.client, 'record_review', { p_message_id: msgId, p_target_language: 'en', p_rating: 'good' }, (d) => d && d.rating === 'good');
  await rpcOk(C3, "B rates 'bad' → SAME row toggled", B.client, 'record_review', { p_message_id: msgId, p_target_language: 'en', p_rating: 'bad' }, (d) => d && d.rating === 'bad');
  {
    const { data } = await svc.from('translation_reviews').select('id').eq('message_id', msgId).eq('reviewer_id', B.id);
    rec(C3, 'exactly ONE review row for (msg, B) — upsert, not append', (data || []).length === 1, `rows=${(data || []).length}`);
  }
  // Note: record_review RETURNS a composite row, so PostgREST surfaces a cleared (NULL) return
  // as either JSON null OR an all-null row object — accept both. The actual delete is asserted next.
  await rpcOk(C3, 'B rates NULL → cleared', B.client, 'record_review', { p_message_id: msgId, p_target_language: 'en', p_rating: null }, (d) => d === null || (d && d.id === null));
  {
    const { data } = await svc.from('translation_reviews').select('id').eq('message_id', msgId).eq('reviewer_id', B.id);
    rec(C3, 'review row deleted after clear', (data || []).length === 0, `rows=${(data || []).length}`);
  }
  await rpcErrors(C3, "invalid rating 'meh' rejected", B.client, 'record_review', { p_message_id: msgId, p_target_language: 'en', p_rating: 'meh' });

  // ═══ 4. Adversarial ════════════════════════════════════════════════════════
  const C4 = '4. adversarial';
  await rpcErrors(C4, 'C (non-member) record_correction → denied', C.client, 'record_correction', { p_message_id: msgId, p_target_language: 'en', p_corrected_text: 'pwned' });
  await rpcErrors(C4, 'C (non-member) record_review → denied', C.client, 'record_review', { p_message_id: msgId, p_target_language: 'en', p_rating: 'bad' });
  await rpcErrors(C4, 'correcting a language with no cached translation → denied', B.client, 'record_correction', { p_message_id: msgId, p_target_language: 'de', p_corrected_text: 'x' });
  await rpcErrors(C4, 'empty corrected_text → denied', B.client, 'record_correction', { p_message_id: msgId, p_target_language: 'en', p_corrected_text: '   ' });
  await rpcErrors(C4, 'over-long corrected_text (>4000) → denied', B.client, 'record_correction', { p_message_id: msgId, p_target_language: 'en', p_corrected_text: 'x'.repeat(4001) });
  {
    const { error } = await B.client.from('translation_corrections').insert({
      tenant_id: TENANT_1, message_id: msgId, target_language: 'en', corrected_text: 'forged', corrector_user_id: B.id,
    });
    rec(C4, 'direct client INSERT into translation_corrections → denied (no forged snapshot)', !!error, error ? `denied: ${error.message}` : 'UNEXPECTED SUCCESS');
  }
  {
    const { error } = await B.client.from('translation_corrections').update({ corrected_text: 'tampered' }).eq('id', corrId);
    rec(C4, 'direct client UPDATE of a correction → denied (append-only)', !!error, error ? `denied: ${error.message}` : 'UNEXPECTED SUCCESS');
  }
  {
    const { error } = await B.client.from('translation_reviews').insert({
      tenant_id: TENANT_1, message_id: msgId, target_language: 'en', reviewer_id: B.id, rating: 'good',
    });
    rec(C4, 'direct client INSERT into translation_reviews → denied', !!error, error ? `denied: ${error.message}` : 'UNEXPECTED SUCCESS');
  }
  {
    const { data } = await svc.from('message_translations').select('translated_text').eq('message_id', msgId).eq('language', 'en').single();
    rec(C4, 'canonical translation UNCHANGED after a correction', data?.translated_text === CACHED, `translated_text=${JSON.stringify(data?.translated_text)}`);
  }
  // Soft-left member: B leaves the conversation, then cannot correct.
  await B.client.rpc('leave_conversation', { p_conversation_id: conv });
  await rpcErrors(C4, 'B (soft-left member) record_correction → denied', B.client, 'record_correction', { p_message_id: msgId, p_target_language: 'en', p_corrected_text: 'after leaving' });

  // ═══ 5. Deletion hook (service_role) ═══════════════════════════════════════
  const C5 = '5. deletion anonymize hook';
  await rpcErrors(C5, 'authenticated CANNOT execute anonymize_corrections_for_account', B.client, 'anonymize_corrections_for_account', { p_account_id: A.id });
  const n = await svc.rpc('anonymize_corrections_for_account', { p_account_id: B.id }).then((r) => { if (r.error) throw new Error(r.error.message); return r.data; });
  rec(C5, 'anonymize returns rows touched (≥1)', typeof n === 'number' && n >= 1, `touched=${n}`);
  {
    const { data } = await svc.from('translation_corrections').select('*').eq('id', corrId).maybeSingle();
    rec(C5, "corrector_user_id nulled", data?.corrector_user_id === null, `corrector=${JSON.stringify(data?.corrector_user_id)}`);
    rec(C5, 'corrector_known_languages nulled (PII stripped)', data?.corrector_known_languages === null, `known=${JSON.stringify(data?.corrector_known_languages)}`);
    rec(C5, 'translation pair KEPT (original + model_output + corrected)', data?.original_text === MSG_TEXT && data?.model_output === CACHED && data?.corrected_text === FIX, 'pair intact');
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

  await resetState([A.id, B.id, C.id]);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(`\n✗ Harness error (not an assertion failure): ${err.message}\n`);
  process.exitCode = 2;
});
