# Translation App — Cowork ↔ Hermes Handoff

> **Read this first at every Cowork session start** (after `git pull --ff-only`).
> Format per `hermes.md` §17: reverse chronological, weekly sections.
> Maintained by Hermes. Last written: 2026-06-10.

---

## Week of 2026-06-09

### Completed this week

- **Spec 4b shipped** — commits `8cfa0a2`, `a4131b2`, `2dd38df` on `main`
  Event log wiring complete and verified on staging. `translation_events` writes appear in the DB with `event_source = 'chat_app'` after every translate call. Two key bugs found and fixed during verification: (1) `pg.Pool` causes connection-timeout failures in Vercel serverless — switched to `pg.Client`; (2) fire-and-forget writes are killed when Vercel freezes the process at `res.json()` — added `await`. Full details in `verification.md` "Event log wiring — Spec 4b".

### Open escalations

- **Vercel Production env var must use port 6543 before prod deploy.** `DATABASE_URL_PROD_WRITER` in Vercel's Production environment needs to be set to port 6543 (transaction pooler). The `.env` copy on the VPS uses 5432 (fine for the VPS). This must be done before running `vercel --prod`. See verification.md Known gaps table.

- **`hermes_writer_user` staging JS-client quirk unresolved.** The restricted role works via `psql` but fails via the `pg` JS client with "permission denied" even though `has_table_privilege` returns true. Staging Vercel Preview currently uses the `postgres` superuser URL as a workaround. Low urgency — staging is not user-facing. Options: investigate Supabase role trust config, or accept superuser credential on staging only.

- **`agent_events` end-to-end via Vercel not yet verified.** The VPS hook was smoke-tested via direct INSERT in a previous session. The full Vercel → DB path for `agent_events` hasn't been walked through. Will self-verify on the next Hermes task that completes normally.

- **Cowork ↔ Hermes git-pull auth gap still open.** Same as previous week.

### Costs spent

- Spec 4b verification session: higher than normal due to multiple redeploy cycles diagnosing the Vercel serverless + pg.Pool/await issues. No budget breach; within Sonnet-tier bounds.

### Skills created / changed

- `translation-app-dev` skill updated with new pitfalls: Pool→Client pattern for serverless, await requirement for Vercel, URL-encoding for passwords, port 5432 vs 6543 distinction.

### For strategic attention

- **Spec 4b is the last Phase 1.5 infrastructure spec.** With 4a + 4b shipped, the event log is live. Phase 1.5 checklist items still open: Cowork git-pull auth gap, Spec 2.1 (Opus tier override), parking-lot promotions, open questions in hermes.md §13. Worth a Cowork session to triage which of these block Phase 2.

---

## Week of 2026-06-02

### Completed this week

- **Spec 4a shipped (by Cowork, 2026-06-02)** — `commit 0f909a7`
  `translation_events` and `agent_events` tables created via migrations 005 and 006. Run on staging and prod. `hermes_writer` Postgres role provisioned with INSERT-only on both event tables. `DATABASE_URL_PROD_WRITER` stored in `~/.hermes/.env` on the VPS. Verification record: `verification.md` "Event log schema — Spec 4a".

- **Spec 3 shipped (by Hermes, 2026-06-03)** — `commit 73835e5`
  Hermes given end-to-end access credentials: GitHub PAT (Contents + PRs, scoped to `translationapp1`, expires 2026-09-01), Supabase CLI + `hermes_readonly_user` on prod + full read/write on staging, Vercel CLI with prod-deploy gating. Repo cloned to `/home/hermes/work/translation-app/`. `terminal.cwd` set. All six smoke tests passed or passed with documented caveats. Full details in `verification.md` "Hermes access credentials — Spec 3 (2026-06-03)".

- **Spec 4b in-flight (by Hermes, 2026-06-03)** — `commit d237e16`, branch `hermes/event-log-wiring`, [Draft PR #2](https://github.com/iwitt1/translationapp1/pull/2)
  Event log wiring complete. `translation_events` write wired into both `api/v1/translate.js` (Vercel/prod path) and `server/index.js` (local Express path). New `server/lib/events.js` module with `logTranslationEvent()` and `logAgentEvent()` helpers — non-blocking, lazy pool, errors logged and swallowed. `agent_events` write wired via a Python hook at `~/.hermes/hooks/agent-event-logger/` using the Hermes gateway `agent:start` / `agent:end` lifecycle events. Both verified on staging via direct INSERT smoke tests. Awaiting Isaac's testing + prod merge approval.

### Known gaps surfaced during testing

- **`hermes_writer` role not provisioned on staging.** Spec 4a provisioned the restricted INSERT-only `hermes_writer_user` role on prod only. Staging has no equivalent — only the full `postgres` admin connection string exists there. This means the Vercel Preview environment can't use a least-privilege write credential pointing at staging the way prod does. During Spec 4b testing, the Preview deploy was configured with the staging admin URL as a workaround, but that's not the right posture. Fix: provision a `hermes_writer` role on staging (same SQL as migration 005's prod step) and store the connection string as `DATABASE_URL_STAGING_WRITER` in `~/.hermes/.env` and in the Vercel Preview env vars. Low urgency — staging is not user-facing — but should be done before the next spec that touches event log wiring. **`recommend`**

- **Vercel serverless requires port 6543 (transaction pooler), not 5432 (session pooler).** `DATABASE_URL_PROD_WRITER` in `~/.hermes/.env` uses port 5432, which works from the persistent VPS but silently fails in Vercel serverless functions. The Production Vercel env var will need to be set to port 6543 when the branch merges to main. Flagged here so it's not forgotten at merge time. **`flag`**

- **Stray test row in prod `translation_events`.** During Spec 4b testing, a `hermes_test` row was accidentally written to prod (`id = 0f1ff660-33df-4bbc-a44f-bbde739bec11`, timestamp 2026-06-03 04:12:42 UTC). The `hermes_writer_user` role is INSERT-only so Hermes can't delete it. Isaac to remove via Supabase prod SQL editor: `DELETE FROM translation_events WHERE id = '0f1ff660-33df-4bbc-a44f-bbde739bec11';` **`flag`**

### Open escalations

- **Spec 4b — awaiting Isaac's test + merge approval.**
  Testing checklist is in the Spec 4b §8.1 report (sent via Discord). Key steps: send a translation via the staging UI → verify `translation_events` row; send a Discord message to Hermes → verify `agent_events` row; restart `hermes-gateway` first so the new hook loads.

- **Spec 4b — `psycopg2-binary` install requires Isaac's explicit §6.7 approval.**
  Installed `psycopg2-binary` (v2.9.12) into the Hermes venv on the VPS. This is the Postgres driver used by the `agent-event-logger` hook. Flagged per `hermes.md` §6.7 — needs Isaac's "yes, keep it." Rationale: no Postgres client existed in the Hermes venv; `psycopg2-binary` is the standard zero-compilation Python driver; alternatives (asyncpg, Supabase REST) were worse fits. If Isaac says no, the hook falls back cleanly (logs a warning, skips the write).

- **Cowork ↔ Hermes git-pull auth gap still open.**
  The Cowork sandbox session-start `git pull --ff-only` still fails with `fatal: could not read Username` because the sandbox has no GitHub credentials. This means Cowork may load a stale `/docs/` at session start and miss Hermes's pushes (including this handoff doc). Roadmap item: `Phase 1.5 → "Cowork ↔ Hermes interface follow-ups"`. Until fixed, Isaac can manually run `git pull` in the Cowork sandbox before starting a session, or ask Hermes to summarize recent activity at session start.

### Costs spent

- Spec 4b execution (this session): within normal Sonnet-tier bounds. No cost anomalies. Exact token counts not yet available (agent_events wiring not yet active at task start; will self-report from next task onward).

### Skills created / changed

- None created this task. No new skills introduced.

### For strategic attention

- **Cowork git-pull auth gap is blocking the handoff mechanism.** This doc exists now, but Cowork can't reliably load it until the sandbox auth issue is resolved. Worth addressing before the next Cowork session that involves Hermes-produced work. Options outlined in `roadmap.md` Phase 1.5 "Cowork ↔ Hermes interface follow-ups."

- **Spec 2.1 (Opus tier override, browser tools, cost caps) still queued.** Was carved out of Spec 2 pending 24-72h of Discord usage signal. That signal should now exist. If cost/usage data looks reasonable, this is ready to schedule.

- **`agent_events.status` gap.** The `agent:end` hook always writes `status = 'completed'` because the hook only fires on normal completion. Crash / timeout / escalation leaves no row. This is by design per `hermes.md §7.3` ("gaps in the log are the signal"), but it means the status column can't be queried to distinguish completion types. If Spec 2.1 adds per-session model metadata to the hook context, this is a natural time to revisit what else the hook can capture.

---

*(Sections older than ~4 weeks will be archived to `/docs/cowork-handoff-archive.md`.)*
