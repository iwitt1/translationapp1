import { runAbandonmentSweep } from '../../../server/lib/abandonment.js';

/**
 * GET /api/v1/jobs/abandonment — Vercel cron entry point for the Step 6 abandonment sweep.
 *
 * Scheduled daily via vercel.json `crons`. Vercel automatically attaches
 * `Authorization: Bearer $CRON_SECRET` to cron invocations when CRON_SECRET is set in the
 * project env, so we hard-require that header — this endpoint DELETES accounts and must not
 * be publicly triggerable. (Same guard works for a manual curl with the secret.)
 *
 * Env (Preview → staging, Production → prod):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — service-role client (admin delete + RPCs)
 *   ABANDONMENT_EMAIL_HASH_PEPPER            — HMAC pepper (NEVER VITE_-prefixed; never in DB)
 *   ABANDONMENT_EMAIL_HASH_KEY_VERSION       — pepper version (default 1)
 *   ABANDONMENT_MAX_AGE_DAYS                 — window in days (default 30, policies.md §6)
 *   CRON_SECRET                              — shared secret Vercel sends on cron calls
 *
 * Manual dry run (no writes/deletes):  GET /api/v1/jobs/abandonment?dryRun=1  with the
 * Authorization header. Returns the would-be summary.
 *
 * Ref: server/lib/abandonment.js · migration 012 · policies.md §6 · decisions.md 2026-06-10
 */
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth guard — refuse unless the cron secret matches. Fail closed if it isn't configured.
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[abandonment] CRON_SECRET not set — refusing to run');
    return res.status(500).json({ error: 'CRON_SECRET not configured' });
  }
  if (req.headers.authorization !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true';

  try {
    const summary = await runAbandonmentSweep({
      supabaseUrl: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      pepper: process.env.ABANDONMENT_EMAIL_HASH_PEPPER,
      keyVersion: Number(process.env.ABANDONMENT_EMAIL_HASH_KEY_VERSION ?? 1),
      maxAgeDays: Number(process.env.ABANDONMENT_MAX_AGE_DAYS ?? 30),
      dryRun,
    });
    return res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    console.error('[abandonment] sweep failed:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
