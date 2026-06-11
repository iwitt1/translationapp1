import { runDeletionSweep } from '../../../server/lib/deletion.js';

/**
 * GET /api/v1/jobs/deletion — Vercel cron entry point for the Step 7 data-deletion sweep.
 *
 * Scheduled daily via vercel.json `crons` (09:00 UTC — an hour after the abandonment sweep,
 * so the two destructive jobs don't overlap). Vercel attaches `Authorization: Bearer
 * $CRON_SECRET` to cron invocations, so we hard-require that header — this endpoint DELETES
 * accounts and must not be publicly triggerable.
 *
 * Env (Preview → staging, Production → prod):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — service-role client (admin delete + RPCs)
 *   ABANDONMENT_EMAIL_HASH_PEPPER            — HMAC pepper. SHARED with the abandonment job
 *                                              ON PURPOSE: both feed email_hash_abuse, so the
 *                                              pepper + key_version MUST match or a
 *                                              delete-then-resignup won't correlate. Never
 *                                              VITE_-prefixed; never in the DB.
 *   ABANDONMENT_EMAIL_HASH_KEY_VERSION       — pepper version (default 1; shared)
 *   CRON_SECRET                              — shared secret Vercel sends on cron calls
 *
 * The grace window lives on each request (grace_until, set at request time) — there is no
 * max-age env here; the sweep only ever picks up requests whose grace has already elapsed.
 *
 * Manual dry run (no claims/writes/deletes):  GET /api/v1/jobs/deletion?dryRun=1  with the
 * Authorization header. Returns the would-be summary.
 *
 * Ref: server/lib/deletion.js · migration 013 · policies.md §6 · decisions.md 2026-06-11
 */
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth guard — refuse unless the cron secret matches. Fail closed if it isn't configured.
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[deletion] CRON_SECRET not set — refusing to run');
    return res.status(500).json({ error: 'CRON_SECRET not configured' });
  }
  if (req.headers.authorization !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true';

  try {
    const summary = await runDeletionSweep({
      supabaseUrl: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      pepper: process.env.ABANDONMENT_EMAIL_HASH_PEPPER,
      keyVersion: Number(process.env.ABANDONMENT_EMAIL_HASH_KEY_VERSION ?? 1),
      dryRun,
    });
    return res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    console.error('[deletion] sweep failed:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
