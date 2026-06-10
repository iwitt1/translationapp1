/**
 * server/lib/events.js — Event log helpers for translation_events and agent_events.
 *
 * Both helpers are non-blocking: errors are logged and swallowed. A write failure
 * must never surface to the end user or interrupt the translation response.
 *
 * Connection: DATABASE_URL_PROD_WRITER (INSERT-only on translation_events and
 * agent_events; no SELECT privilege). Client is initialised lazily so a missing
 * env var doesn't crash the server on startup.
 *
 * Per Spec 4b / hermes.md §7.2–§7.3.
 */

import pg from 'pg';

const { Client } = pg;

// ── Connection string helper ───────────────────────────────────────────────────
// Returns the connection string, or null if it isn't set.
// We use a single Client per write (connect → query → end) rather than a Pool.
// Pools are efficient for long-lived servers but cause connection-timeout failures
// in Vercel serverless functions, where each invocation is short-lived and the pool
// never has time to fully initialise before the function is torn down.

function getConnectionString() {
  return process.env.DATABASE_URL_PROD_WRITER || null;
}

// ── logTranslationEvent ────────────────────────────────────────────────────────

/**
 * Append one row to translation_events. Non-blocking: errors are logged, never thrown.
 *
 * Required fields (all others are nullable/defaulted in the schema):
 *   tenant_id, target_language, was_cached, model_used, prompt_version,
 *   latency_ms, character_count, event_source
 *
 * @param {object} fields
 * @param {string}  fields.tenant_id        UUID string
 * @param {string|null} fields.task_id      UUID string or null
 * @param {string|null} fields.user_id      User identifier or null
 * @param {string}  fields.target_language  BCP 47
 * @param {boolean} fields.was_cached
 * @param {string}  fields.model_used       e.g. 'gpt-4o-mini'
 * @param {string}  fields.prompt_version   e.g. '1.2.1'
 * @param {number}  fields.latency_ms       Integer milliseconds
 * @param {number}  fields.character_count  Integer
 * @param {number|null} fields.input_tokens
 * @param {number|null} fields.output_tokens
 * @param {string}  fields.event_source     'chat_app' | 'hermes_test' | 'api_external'
 */
export async function logTranslationEvent(fields) {
  const connectionString = getConnectionString();
  if (!connectionString) {
    console.warn('[events] DATABASE_URL_PROD_WRITER not set — skipping translation_events write');
    return;
  }

  const {
    tenant_id,
    task_id = null,
    user_id = null,
    target_language,
    was_cached,
    model_used,
    prompt_version,
    latency_ms,
    character_count,
    input_tokens = null,
    output_tokens = null,
    event_source = 'chat_app',
  } = fields;

  const sql = `
    INSERT INTO public.translation_events (
      schema_version,
      tenant_id,
      task_id,
      user_id,
      timestamp,
      target_language,
      was_cached,
      model_used,
      prompt_version,
      latency_ms,
      character_count,
      input_tokens,
      output_tokens,
      event_source
    ) VALUES (
      1, $1, $2, $3, now(), $4, $5, $6, $7, $8, $9, $10, $11, $12
    )
  `;

  const values = [
    tenant_id,
    task_id,
    user_id,
    target_language,
    was_cached,
    model_used,
    prompt_version,
    latency_ms,
    character_count,
    input_tokens,
    output_tokens,
    event_source,
  ];

  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query(sql, values);
  } catch (err) {
    // Non-blocking: log the error but do NOT re-throw.
    console.error('[events] translation_events INSERT failed (non-fatal):', err.message);
  } finally {
    await client.end().catch(() => {});
  }
}

// ── logAgentEvent ──────────────────────────────────────────────────────────────

/**
 * Append one row to agent_events. Non-blocking: errors are logged, never thrown.
 *
 * Called by the Python hook handler at agent:end (via the Node helper script
 * ~/.hermes/hooks/agent-event-logger/log_agent_event.js) and may also be called
 * directly from Node code in future test harnesses.
 *
 * Required fields per hermes.md §7.3:
 *   task_id, tenant_id, started_at, status, task_summary, gateway,
 *   model_tier, model_used
 *
 * @param {object} fields
 * @param {string}  fields.task_id           UUID generated at agent:start
 * @param {string|null} fields.parent_task_id  null for top-level tasks
 * @param {string|null} fields.idempotency_key  for retry-safe inserts
 * @param {string}  fields.tenant_id         UUID (hardcoded to chat-app tenant)
 * @param {string}  fields.started_at        ISO 8601 UTC timestamp
 * @param {string|null} fields.completed_at  ISO 8601 UTC timestamp or null
 * @param {string}  fields.status            'completed'|'failed'|'escalated'|'aborted'
 * @param {string}  fields.task_summary      Plain-English one-liner
 * @param {string}  fields.gateway           'discord'|'cli'|'scheduled'
 * @param {string|null} fields.channel_id    Discord channel snowflake ID
 * @param {string|null} fields.channel_name  Human-readable channel name
 * @param {string|null} fields.thread_id     Discord thread ID if applicable
 * @param {string|null} fields.triggered_by  Display name of requester
 * @param {string}  fields.model_tier        'sonnet'|'opus'
 * @param {string}  fields.model_used        e.g. 'claude-sonnet-4-6'
 * @param {number|null} fields.tokens_in
 * @param {number|null} fields.tokens_out
 * @param {string[]|null} fields.files_changed
 * @param {string[]|null} fields.commits
 * @param {string[]|null} fields.deploys
 * @param {object|null} fields.errors        [{type, message, timestamp}]
 * @param {object|null} fields.approval_log  [{asked_at, question, response, responded_at}]
 * @param {string|null} fields.raw_report    Full §8.1 end-of-task report
 */
export async function logAgentEvent(fields) {
  const connectionString = getConnectionString();
  if (!connectionString) {
    console.warn('[events] DATABASE_URL_PROD_WRITER not set — skipping agent_events write');
    return;
  }

  const {
    task_id,
    parent_task_id = null,
    idempotency_key = null,
    tenant_id,
    started_at,
    completed_at = null,
    status,
    task_summary,
    gateway,
    channel_id = null,
    channel_name = null,
    thread_id = null,
    triggered_by = null,
    model_tier,
    model_used,
    tokens_in = null,
    tokens_out = null,
    files_changed = null,
    commits = null,
    deploys = null,
    errors = null,
    approval_log = null,
    raw_report = null,
  } = fields;

  const sql = `
    INSERT INTO public.agent_events (
      schema_version,
      task_id,
      parent_task_id,
      idempotency_key,
      tenant_id,
      started_at,
      completed_at,
      status,
      task_summary,
      gateway,
      channel_id,
      channel_name,
      thread_id,
      triggered_by,
      model_tier,
      model_used,
      tokens_in,
      tokens_out,
      files_changed,
      commits,
      deploys,
      errors,
      approval_log,
      raw_report
    ) VALUES (
      1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
      $16, $17, $18, $19, $20, $21, $22, $23
    )
    ON CONFLICT (idempotency_key) DO NOTHING
  `;

  const values = [
    task_id,
    parent_task_id,
    idempotency_key,
    tenant_id,
    started_at,
    completed_at,
    status,
    task_summary,
    gateway,
    channel_id,
    channel_name,
    thread_id,
    triggered_by,
    model_tier,
    model_used,
    tokens_in,
    tokens_out,
    files_changed,
    commits,
    deploys,
    errors ? JSON.stringify(errors) : null,
    approval_log ? JSON.stringify(approval_log) : null,
    raw_report,
  ];

  const client = new Client({ connectionString });
  try {
    await client.connect();
    await client.query(sql, values);
  } catch (err) {
    // Non-blocking: log the error but do NOT re-throw.
    console.error('[events] agent_events INSERT failed (non-fatal):', err.message);
  } finally {
    await client.end().catch(() => {});
  }
}
