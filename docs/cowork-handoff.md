# Translation App — Cowork ↔ Hermes Handoff

> **Read this first at every Cowork session start** (after `git pull --ff-only`).
> Format per `hermes.md` §17: reverse chronological, weekly sections.
> Maintained by Hermes. Last written: 2026-06-03.

---

## Week of 2026-06-02

### Completed this week

- **Spec 4a shipped (by Cowork, 2026-06-02)** — `commit 0f909a7`
  `translation_events` and `agent_events` tables created via migrations 005 and 006. Run on staging and prod. `hermes_writer` Postgres role provisioned with INSERT-only on both event tables. `DATABASE_URL_PROD_WRITER` stored in `~/.hermes/.env` on the VPS. Verification record: `verification.md` "Event log schema — Spec 4a".

- **Spec 3 shipped (by Hermes, 2026-06-03)** — `commit 73835e5`
  Hermes given end-to-end access credentials: GitHub PAT (Contents + PRs, scoped to `translationapp1`, expires 2026-09-01), Supabase CLI + `hermes_readonly_user` on prod + full read/write on staging, Vercel CLI with prod-deploy gating. Repo cloned to `/home/hermes/work/translation-app/`. `terminal.cwd` set. All six smoke tests passed or passed with documented caveats. Full details in `verification.md` "Hermes access credentials — Spec 3 (2026-06-03)".

- **Spec 4b in-flight (by Hermes, 2026-06-03)** — `commit d237e16`, branch `hermes/event-log-wiring`, [Draft PR #2](https://github.com/iwitt1/translationapp1/pull/2)
  Event log wiring complete. `translation_events` write wired into both `api/v1/translate.js` (Vercel/prod path) and `server/index.js` (local Express path). New `server/lib/events.js` module with `logTranslationEvent()` and `logAgentEvent()` helpers — non-blocking, lazy pool, errors logged and swallowed. `agent_events` write wired via a Python hook at `~/.hermes/hooks/agent-event-logger/` using the Hermes gateway `agent:start` / `agent:end` lifecycle events. Both verified on staging via direct INSERT smoke tests. Awaiting Isaac's testing + prod merge approval.

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
