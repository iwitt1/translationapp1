/**
 * server/lib/deletion.js — Phase 2 Step 7: data-deletion (GDPR erasure) sweep.
 *
 * Processes user-requested account deletions whose grace window has elapsed. Each due
 * request is hard-deleted via the Supabase admin API; the FK chain from 007/008 does the
 * anonymization (profiles + identifiers + settings + linguistic profile + events CASCADE
 * away; messages.sender_id SET NULL keeps content as de-identified "deleted user" rows).
 * The data_deletion_requests row SURVIVES (user_id → NULL via SET NULL) as proof-of-erasure.
 *
 * Why Node (not pg_cron / pure SQL), same as Step 6:
 *   - auth.admin.deleteUser() is an auth-schema operation owned by Supabase (cleans up
 *     sessions/identities), not something SQL should reach into.
 *   - the abuse hash is a KEYED HMAC whose pepper must NEVER enter Postgres
 *     (decisions.md 2026-06-10 / 2026-06-11). Computed here with node:crypto.
 *
 * Abuse signal: on a voluntary erasure we record the SAME keyed email HMAC as Step 6,
 * REUSING email_hash_abuse + record_abandoned_email_hash() (no schema change). So we MUST
 * use the SAME pepper + key_version as the abandonment job, or the two signals won't
 * correlate on a delete-then-resignup. The cron passes the shared ABANDONMENT_* pepper.
 *
 * Flow per due request (claim → record-then-delete → complete):
 *   1. list_due_deletion_requests() → {request_id, account_id, tenant_id, canonical_email}
 *   2. claim_deletion_request(request_id) → pending→processing; skip if another run won it
 *   3. snapshot what will be removed (pre-delete counts) for the deleted_fields audit log
 *   4. HMAC-SHA256(canonical_email, pepper) → record_abandoned_email_hash(...)  (before delete)
 *   5. auth.admin.deleteUser(account_id) → cascade anonymizes; messages.sender_id → NULL
 *   6. complete_deletion_request(request_id, deleted_fields) → completed + audit log
 *
 * Identity is injected via config (not module-level env) so the same function runs from the
 * Vercel handler and the staging gate. NEVER expose the service-role key or pepper to the
 * browser.
 *
 * Ref: architecture.md §7/§11 · policies.md §6 · decisions.md 2026-06-11 · migration 013
 */

import { createHmac } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

/**
 * @typedef {Object} DeletionConfig
 * @property {string}  [supabaseUrl]      Supabase project URL (required unless supabaseClient given)
 * @property {string}  [serviceRoleKey]   service_role key (required unless supabaseClient given)
 * @property {object}  [supabaseClient]   pre-built service-role client (tests may inject one)
 * @property {string}  [pepper]           HMAC pepper (shared with the abandonment job); req. unless dryRun
 * @property {number}  [keyVersion=1]     pepper key version stamped on each hash row
 * @property {boolean} [dryRun=false]     when true: scan + log only, no claim/hash/delete
 * @property {object}  [logger=console]   logger with .info/.warn/.error
 */

/**
 * Run one data-deletion sweep across ALL tenants.
 * @param {DeletionConfig} config
 * @returns {Promise<{scanned:number, deleted:number, hashed:number, skipped:number,
 *                     errors:number, dryRun:boolean, keyVersion:number}>}
 */
export async function runDeletionSweep(config = {}) {
  const {
    supabaseUrl,
    serviceRoleKey,
    supabaseClient,
    pepper,
    keyVersion = 1,
    dryRun = false,
    logger = console,
  } = config;

  const svc =
    supabaseClient ||
    (() => {
      if (!supabaseUrl || !serviceRoleKey) {
        throw new Error(
          'runDeletionSweep: supabaseUrl + serviceRoleKey (or supabaseClient) are required',
        );
      }
      return createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    })();

  // A destructive sweep must never run without the hash key — otherwise we'd delete
  // accounts and silently lose the abuse signal. Dry runs may omit it.
  if (!dryRun && !pepper) {
    throw new Error('runDeletionSweep: pepper is required for a live (non-dry-run) sweep');
  }
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new Error(`runDeletionSweep: keyVersion must be a positive integer (got ${keyVersion})`);
  }

  const summary = {
    scanned: 0, deleted: 0, hashed: 0, skipped: 0, errors: 0,
    dryRun, keyVersion,
  };

  const { data: due, error: listErr } = await svc.rpc('list_due_deletion_requests');
  if (listErr) {
    throw new Error(`list_due_deletion_requests failed: ${listErr.message}`);
  }

  summary.scanned = due?.length ?? 0;
  logger.info(
    `[deletion] scanned ${summary.scanned} due erasure request(s)` +
      (dryRun ? ' (DRY RUN — no claims/writes/deletes)' : ''),
  );

  for (const req of due ?? []) {
    const { request_id, account_id, tenant_id, canonical_email } = req;

    // A dry run reports what WOULD be swept and stops — no claim, no hash, no delete.
    if (dryRun) continue;

    try {
      // 1. Claim the request (pending → processing). If another overlapping run already
      //    claimed it, skip — we must not double-process.
      const { data: claimed, error: claimErr } = await svc.rpc('claim_deletion_request', {
        p_id: request_id,
      });
      if (claimErr) {
        throw new Error(`claim_deletion_request failed: ${claimErr.message}`);
      }
      if (!claimed) {
        summary.skipped += 1;
        logger.warn(`[deletion] skip ${request_id}: already claimed by another run`);
        continue;
      }

      // 2. Snapshot what we're about to remove, for the deleted_fields audit log. Cheap
      //    counts (low-volume daily job). messages_anonymized = rows whose author link we
      //    sever (content retained). corrections_anonymized is 0 until translation_corrections
      //    is built (architecture.md §7 "not built yet").
      const deletedFields = await snapshotDeletedFields(svc, account_id);

      // 3. Record the abuse hash BEFORE deleting, so an account is never destroyed with its
      //    abuse signal unrecorded. Same keyed-HMAC mechanism + table as Step 6.
      if (canonical_email) {
        const emailHashHex = createHmac('sha256', pepper || '')
          .update(canonical_email, 'utf8')
          .digest('hex');
        const { error: hashErr } = await svc.rpc('record_abandoned_email_hash', {
          p_tenant_id: tenant_id,
          p_email_hash_hex: emailHashHex,
          p_key_version: keyVersion,
        });
        if (hashErr) {
          throw new Error(`record_abandoned_email_hash failed: ${hashErr.message}`);
        }
        summary.hashed += 1;
        deletedFields.email_hash_recorded = true;
      } else {
        logger.warn(`[deletion] ${account_id}: no active email identifier — deleting without hash`);
        deletedFields.email_hash_recorded = false;
      }

      // 4. Delete the auth.users row → cascade anonymizes; messages.sender_id → NULL.
      const { error: delErr } = await svc.auth.admin.deleteUser(account_id);
      if (delErr) {
        throw new Error(`admin.deleteUser failed: ${delErr.message}`);
      }
      summary.deleted += 1;

      // 5. Finalize the audit row (status=completed + completed_at + deleted_fields). The
      //    row's user_id is already NULL from the cascade; complete_* updates by PK.
      const { error: doneErr } = await svc.rpc('complete_deletion_request', {
        p_id: request_id,
        p_deleted_fields: deletedFields,
      });
      if (doneErr) {
        // The account is already deleted; failing to stamp the audit row is loud but not
        // catastrophic (the row stays 'processing' for a human to reconcile).
        throw new Error(`complete_deletion_request failed (account already deleted): ${doneErr.message}`);
      }
    } catch (err) {
      summary.errors += 1;
      logger.error(`[deletion] error processing request ${request_id} (account ${account_id}): ${err.message}`);
      // Continue the sweep; one bad request shouldn't abort the rest.
    }
  }

  logger.info(
    `[deletion] done — deleted=${summary.deleted} hashed=${summary.hashed} ` +
      `skipped=${summary.skipped} errors=${summary.errors}${dryRun ? ' (dry run)' : ''}`,
  );
  return summary;
}

/**
 * Pre-delete snapshot of what the cascade will remove, for the deleted_fields audit log.
 * Counts are best-effort (a failed count must not block the erasure) — on error we log a
 * null for that field rather than throwing.
 * @param {object} svc  service-role Supabase client
 * @param {string} accountId
 */
async function snapshotDeletedFields(svc, accountId) {
  const countOf = async (table, col = 'account_id') => {
    const { count, error } = await svc
      .from(table)
      .select('*', { count: 'exact', head: true })
      .eq(col, accountId);
    return error ? null : (count ?? 0);
  };

  return {
    profile: true,
    account_identifiers: await countOf('account_identifiers', 'account_id'),
    account_settings: await countOf('account_settings', 'account_id'),
    user_linguistic_profiles: await countOf('user_linguistic_profiles', 'user_id'),
    user_profile_events: await countOf('user_profile_events', 'user_id'),
    messages_anonymized: await countOf('messages', 'sender_id'),
    corrections_anonymized: 0, // translation_corrections not built yet (architecture.md §7)
    email_hash_recorded: false, // set true above when the hash is written
  };
}
