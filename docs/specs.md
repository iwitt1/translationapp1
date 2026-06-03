# Translation App — Specs

> Living document. Holds active and recent feature specs in the format described in `/docs/hermes.md` §9.1. One file rather than one-per-spec until volume justifies splitting (estimated ~10-15 specs before needing a `/docs/specs/` folder).
>
> Spec lifecycle: **draft** → **approved** → **in-flight** → **shipped** → **archived**. When a spec ships, mark it `shipped` here with the commit reference and move the verification details to `/docs/verification.md`. Archive specs after one cycle of "shipped" review (typically 2-4 weeks) — move them to a future `/docs/specs-archive.md` if/when this file exceeds ~600 lines.

**Last updated:** 2026-06-03 (Spec 3 shipped — access credentials for GitHub / Supabase / Vercel. Six smoke tests run; all passed or partial-passed with known caveats. Side-effects: Docker Engine + Node.js v20 installed on VPS; DATABASE_URL_STAGING added; terminal.cwd set in config.yaml. Spec 2 shipped narrowed; Spec 2.1 drafted for the deferred follow-ups. Section order: draft → approved → shipped.)

---

## Spec 3 — Hermes Agent access credentials (GitHub / Supabase / Vercel)

**Linked roadmap item:** Phase 1.5 → Infrastructure (checkbox 5 — Hermes access credentials)
**Author:** Isaac (drafted with Cowork/Opus, 2026-06-02)
**Status:** **shipped 2026-06-03** (73835e5). All six smoke tests passed or partial-passed with known caveats. Verification record: `/docs/verification.md` "Hermes access credentials — Spec 3 (2026-06-03)". Decisions: 2026-06-03 entries in `/docs/decisions.md` (GitHub PAT scope; Supabase readonly role; Vercel prod-deploy gating). Side-effects noted: Docker Engine installed on VPS (required by `supabase db diff`); Node.js v20 + npm-global config installed (required by Vercel CLI); `DATABASE_URL_STAGING` added to `.env` (gap discovered during ST4); `terminal.cwd` set in `config.yaml` (`MESSAGING_CWD` env var is not a real Hermes variable).
**Estimated time:** ~75 min (branch protection step removed; readonly Postgres role still in scope per OQ2)

### Goal
Give Hermes the access it needs to actually touch the Translation App project end-to-end: clone the repo, branch, commit, push, open a PR, run migrations against staging, deploy to staging. End state: Isaac sends Hermes a spec via Discord; Hermes can take it from "read the brief" through "branch + code + test + staging deploy + PR + report per §8.1" without any further infra setup. Prod merges and prod migrations still require Isaac's explicit "yes" each time — same two-confirm pattern that already governs every destructive op, leveraging the framework's native dangerous-command approval (per Hermes Agent security docs §3.2) plus charter §6.2.

### Acceptance criteria

**GitHub access**
- Fine-grained Personal Access Token created in Isaac's GitHub account, scoped to the single Translation App repository (not "all repositories"), with permissions: *Contents: read+write, Pull requests: read+write, Metadata: read* (auto). No admin, no workflows, no actions, no repository secrets. **Created 2026-06-02; expires 2026-09-01.** Rotation reminder set; rotation event documented in operations.md ritual.
- Token stored as `GITHUB_TOKEN` in `~/.hermes/.env` (mode 600). Never in tracked files; verified via `git status` clean + `grep -r GITHUB_TOKEN` showing only docs references.
- `gh` CLI installed on the droplet (`apt install gh` or distro equivalent; `gh --version` returns ≥ 2.x). Authenticated via `gh auth login --with-token` reading the same token; `gh auth status` returns green.
- Repo cloned to `/home/hermes/work/translation-app/` (HTTPS clone using PAT — no SSH key for the repo). `git config user.name "Hermes Agent"` and `git config user.email <Isaac decides: noreply or aliased>` set for the hermes user.
- **Smoke test 1 — clone + pull.** `git clone https://x-access-token:$GITHUB_TOKEN@github.com/<owner>/<repo>.git /home/hermes/work/translation-app` succeeds. `cd` in; `git pull` works; `git status` clean.
- **Smoke test 2 — branch, push, PR.** Hermes creates a `hermes-test-spec3` branch, makes a trivial change (touches `/tmp/throwaway.md` then reverts in working tree — no actual repo content modified), pushes via `git push --set-upstream origin hermes-test-spec3`, opens a draft PR via `gh pr create --draft --title "Spec 3 smoke test" --body "Verifies push + PR auth"`. PR appears in GitHub UI. Hermes closes the PR + deletes the branch (local and remote) at the end.
- **Branch protection: deferred.** Both Rulesets and legacy Branch protection rules require a paid GitHub tier (Pro/Team) for private repos — confirmed 2026-06-02. Decisions.md 2026-06-02 entry captures the deferral with revisit triggers. Behavior-enforcement only for now: charter §6.1 (no direct pushes to main) + the framework-level git wrapper described in charter §11.1 #7 (agent's git wrapper aborts on main without explicit authorization). One of two §11.1 #7 mitigations holds; the platform-level one waits until cost justification or a near-miss.

**Supabase access**
- Supabase personal access token created at `https://supabase.com/dashboard/account/tokens`, named "hermes-prod". **Created 2026-06-02; expires 2026-09-01.** Stored as `SUPABASE_ACCESS_TOKEN` in `~/.hermes/.env` (mode 600). Rotation reminder set.
- Supabase CLI installed on the droplet (`npm install -g supabase` or distro package; `supabase --version` ≥ current stable). `supabase login --token $SUPABASE_ACCESS_TOKEN` succeeds non-interactively. `supabase projects list` returns both `translationapp1` (prod) and `translationapp1-staging`.
- Both project refs added to `~/.hermes/.env` as `SUPABASE_PROJECT_REF_PROD=...` and `SUPABASE_PROJECT_REF_STAGING=...`.
- **Smoke test 3 — staging diff.** `supabase db diff --linked --project-ref $SUPABASE_PROJECT_REF_STAGING` runs cleanly (read-only; surfaces drift between `/V1/migrations/` and remote schema). Expected output: no drift, or minor expected drift that Isaac eyeballs.
- **Smoke test 4 — destructive prompt fires.** Hermes attempts a `DROP TABLE test_xyz` against staging via `supabase db execute`. Framework's dangerous-cmd approval (per security docs §3.2) prompts on Discord. Isaac replies "no" → command blocked. No table actually needs to exist; the prompt firing is what's being verified.
- *(If Open Question 2 = b or c)* Whichever read-isolation mechanism is chosen is implemented + smoke-tested: under (b), `DATABASE_URL_PROD_READONLY` connection string created with a SELECT-only Postgres role, stored in `~/.hermes/.env`, and `psql $DATABASE_URL_PROD_READONLY -c "SELECT count(*) FROM messages;"` returns a number; `INSERT` against the same role fails as expected. Under (c), Hermes's Supabase account has prod scoped to read-only via invitation, verified by attempting a staging-write (succeeds) and a prod-write (fails with permission error).

**Vercel access**
- Vercel personal access token created at `https://vercel.com/account/tokens`, named "hermes-prod". **Created 2026-06-02; expires 2026-08-31 (earliest expiry across the three — this is the rotation trigger date).** Stored as `VERCEL_TOKEN` in `~/.hermes/.env` (mode 600). Rotation reminder set.
- Vercel CLI installed on the droplet (`npm install -g vercel`; `vercel --version` ≥ current stable). `vercel whoami --token $VERCEL_TOKEN` returns Isaac's Vercel handle (or team if project lives under one).
- From inside `/home/hermes/work/translation-app/`, `vercel link --yes --token $VERCEL_TOKEN` connects to the existing Translation App Vercel project; `.vercel/project.json` written. (This file is per-clone, not committed.)
- **Smoke test 5 — preview deploy.** Hermes creates `hermes-test-spec3-deploy`, makes a no-op commit, runs `vercel deploy --token $VERCEL_TOKEN` (default = preview). Returns a `*.vercel.app` URL. Isaac visits → confirms it's pointed at staging Supabase (per Phase 2 staging env-var config from 2026-05-18). Branch deleted after.
- **Smoke test 6 — prod-deploy gating.** Hermes is asked to do a prod deploy. Per charter §6.2, Hermes posts a confirmation plan to Discord *before* running `vercel deploy --prod`. Isaac replies "no" → no deploy. Then test the positive path on a real (or trivially-no-op) prod-worthy change: Isaac replies "yes" → deploy happens → confirm via Vercel dashboard.

**Working directory + gateway**
- `MESSAGING_CWD=/home/hermes/work/translation-app` added to `~/.hermes/.env`. Gateway picks it up after `sudo systemctl restart hermes-gateway`. Verified by DM'ing Hermes "what is your current working directory?" → returns `/home/hermes/work/translation-app`.
- Reboot persistence from Spec 2 still passes: `sudo reboot`, SSH back in, `systemctl status hermes-gateway` shows active running, working directory still correct.

**Approval-mode posture preserved**
- `~/.hermes/config.yaml` `approvals` block remains: `mode: manual`, `cron_mode: deny`, `mcp_reload_confirm: true`, `destructive_slash_confirm: true`. No YOLO mode introduced anywhere. No new entries to `command_allowlist` unless a specific smoke test legitimately requires one (none anticipated).

**Docs hygiene**
- `decisions.md` entries drafted by Cowork for: (a) GitHub fine-grained-PAT scope choice; (b) Supabase auth model chosen per Open Question 2; (c) Vercel prod-deploy gating mechanism per Open Question 3. Per-entry approval per charter §2.
- `verification.md` gets a new "Hermes access credentials — Spec 3 (YYYY-MM-DD)" section: the six smoke tests above as a re-runnable checklist, a `~/.hermes/.env` variable-name inventory (names only, never values), a post-rotation checklist (re-run all six smokes after any PAT rotation), and a known-failure-modes table.
- `hermes.md` §10.7 updated to reflect actual mechanisms (currently aspirational; this spec operationalizes them).
- `roadmap.md` Phase 1.5 checkbox 5 marked done with commit reference; line updated.

### Out of scope (later specs)
- `translation_events` and `agent_events` schema → **Spec 4**
- First Hermes-touches-codebase real task → **Spec 5+**
- Supabase backups beyond DO's weekly snapshots → defer; staging restore drill is its own spec once Hermes is doing real work
- Secrets-management upgrade (Doppler / 1Password Connect / Vault) → defer; `~/.hermes/.env` is sufficient for single-VPS, single-operator
- GitHub Actions / CI integration → defer; no CI today
- Token rotation automation → manual rotation on 90-day calendar; automate later if it becomes painful

### Open questions (resolved 2026-06-02)

1. **Enable GitHub branch protection on `main`?** *Resolved: **yes intent → deferred in practice.*** Both Rulesets and legacy Branch protection rules require GitHub Pro/Team for private repos (Isaac verified 2026-06-02). Deferred to a future trigger (cost-justifiable upgrade or first agent-initiated near-miss). Behavior-enforcement only for now via charter §6.1 + framework git wrapper. Full reasoning + revisit triggers in decisions.md 2026-06-02 entry. Captured as a parking-lot item under Infrastructure.

2. **Supabase prod write-access model.** *Resolved: **(b)** — single PAT + separate read-only Postgres role + `DATABASE_URL_PROD_READONLY` for prod inspection.* Read/write separation at the connection-string layer; writes still go through PAT and §6.2 gating. Captures most of option (c)'s blast-radius story without the second-account overhead.

3. **Vercel prod-deploy gating mechanism.** *Resolved: **(a)** — operating-contract only.* Charter §2 + §6.2 require Hermes to post a confirmation plan to Discord before running `vercel deploy --prod`. Same enforcement layer as every other §6.2-gated op. Wrapper-script option (c) captured as a parking-lot item to add if (a) ever fails in practice.

4. **PAT expiry / rotation cadence.** *Resolved: **90 days** across all three (GitHub, Supabase, Vercel).* Actual creation dates 2026-06-02; expiry dates 2026-08-31 (Vercel) and 2026-09-01 (GitHub, Supabase). **Rotation trigger date: 2026-08-31** (earliest expiry; rotate all three in the same sitting to keep one calendar slot). Ritual added to `operations.md` and monthly digest. **PAT** = Personal Access Token; the GitHub-issued credential (and the equivalent in Supabase / Vercel) that acts like a scoped, revocable password for CLI + API access. Fine-grained PATs are scoped to specific repos with specific permission slices (Contents read+write, Pull requests read+write, etc.) — narrower blast radius than the classic per-account PAT.

### Technical sketch (fill out fully at execution; key sequencing only here)

1. **Open questions resolved with Isaac** (~10 min). Walk OQ 1–4, lock answers, mark spec **approved**, capture the resolution in the spec body.
2. **GitHub** (~20 min). PAT already created (token in Isaac's password manager); install `gh` on the droplet → `gh auth login --with-token` → store `GITHUB_TOKEN` in `~/.hermes/.env` → clone repo → set git config → smoke tests 1 + 2.
3. ~~Branch protection~~ — deferred per OQ1 resolution; no work this session.
4. **Supabase** (~25 min — OQ2 = b path). PAT already created; install supabase CLI → `supabase login --token` → store `SUPABASE_ACCESS_TOKEN` + both project refs in `~/.hermes/.env` → smoke tests 3 + 4. Then: create read-only Postgres role on prod via SQL editor (CREATE ROLE hermes_readonly with SELECT-only grants on app schemas), capture connection string, store as `DATABASE_URL_PROD_READONLY` in `~/.hermes/.env`, verify read works + write fails.
5. **Vercel** (~15 min). Token already created; install CLI → store `VERCEL_TOKEN` in `~/.hermes/.env` → `vercel link` → smoke test 5 → smoke test 6 (gating walkthrough negative path; positive path deferred until first real prod-worthy deploy is queued).
6. **Working directory + gateway restart** (~5 min). Set `MESSAGING_CWD` → restart `hermes-gateway` → verify cwd via DM.
7. **Docs cleanup** (~15–20 min). Decisions entries drafted + per-entry approval per charter §2 (entries a/b/c per Docs Hygiene below — note: branch-protection deferral entry already landed in this session's pre-execution commit, so not re-drafted at execution time); verification.md section created; hermes.md §10.7 updated; roadmap checkbox 5 done; spec status → shipped; one commit covers it.

### Verification plan
Full record lives in `/docs/verification.md` "Hermes access credentials — Spec 3 (YYYY-MM-DD)" after ship. Includes: the six smoke tests above as a re-runnable checklist, `~/.hermes/.env` inventory (names only), post-rotation checklist, known-failure-modes table seeded with the obvious candidates (token expired; PAT scoped wrong; supabase project ref typo; vercel project not linked; etc.).

---

## Spec 2.1 — Hermes Agent — Opus tier override, Hermes-internal cost caps, browser tools activation

**Linked roadmap item:** Phase 1.5 → Infrastructure (checkbox 3 follow-up — finish the *tiered* part of tiered model routing)
**Author:** Isaac (drafted with Cowork, 2026-06-02; carved out of Spec 2 on ship day)
**Status:** **draft** (not yet sequenced; will be scheduled after at least 24-72h of Hermes-on-Discord observation gives us actual usage signal)
**Estimated time:** ~45-60 min

### Goal
Close the residual items from Spec 2's narrowed scope: implement the per-agent tier override that routes specific Hermes-side tasks to Opus per `/docs/hermes.md` §3 escalation rules; layer Hermes-internal cost caps under the Anthropic console-side caps as defense-in-depth; activate the optional browser tools that warned at startup (`websockets` module + Playwright); minor operator-experience improvements like adding `hermes` to the `systemd-journal` group so debugging doesn't require `sudo`.

### Acceptance criteria
- Hermes's `~/.hermes/config.yaml` defines per-agent tier overrides that map the §3 escalation triggers (touches >3 files; touches translate prompt/API/schema; second-attempt failure; ambiguous task; pre-implementation checklist hit) to Opus 4.6 (`claude-opus-4-6` or current equivalent). Exact YAML structure resolved against the Hermes Agent docs at ship time.
- A deterministic smoke test exists: a known prompt or test agent triggers Opus on first turn, Sonnet on a follow-up turn. Verified via Anthropic console showing both models used in the smoke-test window.
- Hermes-internal `limits:` block (or equivalent — schema confirmed against docs) layered under the Anthropic vendor-side cap. Daily soft = $1, daily hard = $3 (returns to spec wording now that we can express this at the Hermes layer). Anthropic monthly cap stays at $64 as the outer safety net.
- Browser tools cleanly registered: `pip install websockets` in the venv eliminates the `browser_dialog_tool` import warning at startup. Playwright Python package installed in the venv and `playwright install chromium` run; system Chromium libs from Spec 1 Phase C are reused. `hermes acp --setup-browser` (or successor) runs cleanly. Smoke test: ask Hermes to fetch a known URL and summarize.
- `sudo usermod -aG systemd-journal hermes` so hermes user can `journalctl -u hermes-gateway` without sudo. Verified by a fresh shell.
- No regressions: Spec 2's verification record (`/docs/verification.md` "Hermes model routing + Discord gateway") still passes end-to-end after these changes.
- `decisions.md` entries drafted by Cowork for the non-trivial choices that surface (e.g. exact tier YAML structure if unusual; any Playwright/browser config that requires explanation). Per-entry approval per charter §2.

### Out of scope (later specs)
- Access credentials (GitHub PAT, Supabase CLI, Vercel CLI) → **Spec 3**
- `translation_events` / `agent_events` schema → **Spec 4**
- First Hermes-touches-codebase task → **Spec 5+**
- Multi-gateway expansion (Telegram/Slack/email alongside Discord) → deferred per Spec 2

### Open questions (resolve at execution)
1. Exact YAML structure for per-agent tier overrides in Hermes Agent v0.14.0 — read docs first, draft against schema.
2. Whether browser tools want the `pip install hermes-agent[browser]` extra or a manual `pip install websockets playwright` — confirm against docs.
3. Cost-cap config: env-var keys (`LIMITS_DAILY_SOFT_USD=...`) vs config.yaml `limits:` block — pick whichever matches v0.14.0's actual schema.

### Technical sketch (skeletal — fill out at execution)
1. Read Hermes Agent docs for tier overrides + limits + browser tools (~10 min).
2. Edit `~/.hermes/config.yaml` for tier overrides + Hermes-internal limits (~10 min).
3. `pip install websockets` and Playwright per docs (~10 min).
4. `hermes acp --setup-browser` (or equivalent) and verify browser tool registration (~5 min).
5. `sudo systemctl restart hermes-gateway` and verify clean startup with no warnings (~3 min).
6. Smoke tests: Opus escalation triggered + browser fetch + non-allowed user ignored (~10 min).
7. `sudo usermod -aG systemd-journal hermes` + verify (~2 min).
8. Docs cleanup: update spec status → shipped, append decisions entries, refresh verification.md "Hermes model routing + Discord gateway" with the new items, mark Phase 1.5 checkbox 3 fully done (~15 min).

### Verification plan
Will be merged into the existing `/docs/verification.md` "Hermes model routing + Discord gateway" section as a `2026-XX-XX update` paragraph rather than a fresh section — same shipped surface, just hardened.

---

## Spec 2 — Hermes Agent model routing + Discord gateway

**Linked roadmap item:** Phase 1.5 → Infrastructure (checkboxes 3 and 4 — configure tiered model routing; wire up one messaging gateway)
**Author:** Isaac (drafted with Cowork, 2026-06-01)
**Status:** **shipped 2026-06-02 (narrowed).** What shipped: Sonnet default routing, Discord gateway as a systemd service, allowlist enforcement, reboot persistence, vendor-side cost caps. What got carved out into **Spec 2.1**: per-agent Opus tier override; Hermes-internal cost-cap layer; full browser tools activation; `systemd-journal` group add for hermes. Verification record: `/docs/verification.md` "Hermes model routing + Discord gateway (2026-06-02)". Decisions: 2026-06-02 entries in `/docs/decisions.md` (Anthropic direct provider; vendor-side cost caps via Anthropic console).
**Estimated time:** 1.5–2 hours. Actual: ~2 hours for the execution session (browser prep + droplet config + reboot test); docs cleanup added ~25 min.

### Goal
Get Hermes responsive on Discord with Sonnet as the default model and Opus available via per-task escalation, gated by the rules in `/docs/hermes.md` §3. End state: Isaac sends a Discord DM (or channel message) to the Hermes bot from his phone; Hermes receives it, routes to Sonnet by default, responds with a §8.1-style task report; Anthropic billing reflects the call. No actual project work executed yet — that's Spec 3 (access credentials) and beyond.

### Acceptance criteria
- Discord bot application created in Isaac's Developer Portal account, bot user enabled, "Public Bot" disabled (single-user posture per `/docs/hermes.md` §6.3).
- Message Content Intent enabled on the bot (required for Hermes to read DMs and channel messages).
- Bot token saved in Isaac's password manager and exported on the droplet via `~/.hermes/.env` (mode 600), referenced from Hermes Agent's config — Option B per the 2026-06-01 spec-approval session.
- Private Discord server created by Isaac, dedicated channel (e.g. `#hermes-prod`) inside it, bot invited via OAuth2 URL with `bot` + `applications.commands` scopes and the minimum permissions Hermes Agent requires.
- `hermes gateway setup` run against Discord; gateway configured and able to start cleanly. Hermes Agent's slash-command registration succeeds on first start.
- Hermes's `config.yaml` (path TBD per Hermes Agent convention — likely `~/.hermes/config.yaml`) sets the default model to Sonnet 4.6 (exact provider string resolved at execution time per `hermes model`), with per-agent tier overrides defined for the escalation triggers in `/docs/hermes.md` §3 routing to Opus 4.6 or current equivalent.
- AI provider: **Anthropic direct** (decided 2026-06-01). Switching to OpenRouter remains a ~15-20 min config-only change plus a `decisions.md` entry if we ever want to A/B-test other providers; the abstraction boundary at `architecture.md` §3.10 makes this cheap.
- Anthropic API key stored in `~/.hermes/.env` only, never in committed config. Confirmed not present in any tracked file via `git status` and `grep -r ANTHROPIC_API_KEY .` (the latter should only show documentation references).
- **Conservative cost caps for first 72 hours:** $1/day Claude API soft cap / $3/day hard cap (vs charter §6.5 defaults of $5/$15). Auto-pause at hard cap. Caps raised to charter defaults via a follow-up `decisions.md` entry once we have signal on actual usage. Decided 2026-06-01.
- Charter §6.3 enforcement: Hermes is configured to treat *only* Isaac's Discord user ID as an authorized sender; messages from any other user ID are logged but not acted on. Mechanism is a Hermes Agent config setting; exact key confirmed during `hermes gateway setup`.
- Hermes Agent runs as a persistent systemd service (`/etc/systemd/system/hermes-agent.service`) configured to restart on boot, so the droplet rebooting doesn't take Hermes offline. Service status checks documented.
- End-to-end smoke test 1 (version check): Isaac DMs the bot "what's your version?" from his phone. Hermes responds with `hermes --version` output (or equivalent) within ~10 seconds. Anthropic dashboard shows one API call. No errors in `journalctl -u hermes-agent`.
- End-to-end smoke test 2 (escalation): Isaac issues a task that should trigger §3 Opus escalation rules (specific prompt TBD per open question 7 — resolved during execution). Hermes uses Opus for that turn; Sonnet for the next. Verified via Anthropic billing showing both models used.
- Cost telemetry: first 24 hours of Discord traffic totals under the tightened $1/day soft cap. Documented in the verification record.
- `decisions.md` entries drafted by Cowork for the non-trivial choices captured during execution (provider choice, cost-cap conservative posture, private-server posture, any model-string specifics that surface). Awaits Isaac's per-entry approval per charter §2.

### Out of scope (later specs)
- GitHub PAT, Supabase CLI auth, Vercel CLI auth → **Spec 3** (access credentials)
- `translation_events` and `agent_events` tables → **Spec 4**
- Hermes-touches-the-codebase tasks (first real spec executed by Hermes) → **Spec 5+**
- Multi-gateway (Slack/email/Telegram in addition to Discord) → deferred indefinitely; revisit after 30-day Discord operation
- Voice mode → not in scope; if interesting later, separate spec
- Skill installation / customization beyond what `hermes gateway setup` registers by default → deferred to a Hermes-operations spec post-Day 7

### Open questions (resolved 2026-06-01 / 2026-06-02)
1. **AI provider** — *Resolved (06-01):* **Anthropic direct**. Switching to OpenRouter remains a config-only change later if we want to A/B-test providers. See decisions.md 2026-06-02 entry.
2. **Cost caps** — *Resolved (06-02):* **Anthropic vendor-side caps**, not Hermes-internal. $1/day target + $64/month max with email warnings at $15 and $40 of monthly spend. Spec's original "$1 soft / $3 hard daily" wording doesn't translate well to monthly billing — captured in decisions.md 2026-06-02 entry. Hermes-internal layer of caps deferred to Spec 2.1.
3. **Where the API key lives** — *Resolved (06-01):* **Option B**, `~/.hermes/.env` (mode 600). Confirmed by Hermes Agent docs as the canonical location for `ANTHROPIC_API_KEY` (and `DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_USERS`).
4. **Private Discord server or DM-only** — *Resolved (06-01):* **Private server with a dedicated channel** (`#hermes-prod`). Bot configured with home channel ID for cron output / proactive messages.
5. **Exact model strings** — *Resolved (06-02):* Active model is `claude-sonnet-4-6` (hyphen-separated, no provider prefix in `hermes model` flow). Set via `hermes model` → Anthropic → "Use existing credentials" → model picker.
6. **Single-user identity verification config** — *Resolved (06-02):* `DISCORD_ALLOWED_USERS` in `~/.hermes/.env` (comma-separated user IDs). Gateway denies all users without this set. Verified enforcement: the wizard explicitly required setting this before completing.
7. **Smoke-test trigger for Opus escalation** — *Deferred to Spec 2.1.* The per-agent tier override mechanism needs more docs deep-dive than this session warranted; carving into a focused follow-up rather than improvising config schema.

### Technical sketch — as executed 2026-06-02 (status of each step)
1. **Anthropic API key obtained.** *Done.* Existing console account; new key tagged "hermes-prod" generated; saved to password manager. Billing already enabled.
2. **Discord bot created.** *Done.* Developer Portal → New Application → "Hermes-prod" → Bot tab → Public Bot OFF + Message Content Intent ON + Reset Token → token saved to password manager. **Note:** Installation tab also required Install Link → "None" to allow Public Bot OFF (newer Discord UI mechanic; documented in failure-mode table).
3. **Private Discord server created.** *Done.* "Hermes" server with `#hermes-prod` channel. OAuth2 URL Generator → `bot` + `applications.commands` scopes + read/send/history/slash perms → bot invited and member-listed (offline until gateway started).
4. **Env vars on droplet.** *Done.* `~/.hermes/.env` populated with `ANTHROPIC_API_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_USERS`. Mode 600, owner hermes. Auto-loaded by Hermes Agent (no extra config.yaml wiring needed — framework reads `~/.hermes/.env` natively).
5. **`hermes model`** *Done.* Anthropic provider detected from env (showed `Anthropic credentials: sk-ant-api03... ✓` and `(-)` against Anthropic in the picker). "Use existing credentials" → model picker → Sonnet 4.6 selected. Resolved model string: `claude-sonnet-4-6`.
6. **`hermes gateway setup` for Discord.** *Done.* Interactive wizard saved Discord token, allowlist (Isaac's user ID), and home channel ID (`#hermes-prod` channel) into `.env` and config.
7. **Cost caps.** *Done at Anthropic console layer (not Hermes-internal).* See decisions.md 2026-06-02 entry. Hermes-internal layer deferred to Spec 2.1.
8. **Persistent service via systemd.** *Done.* Service: `hermes-gateway.service` at `/etc/systemd/system/`. Installed via `sudo /home/hermes/.hermes/venv/bin/hermes gateway install --system --run-as-user hermes` (sudo strips PATH, hence the full path — captured in verification.md known failures). `systemctl status` shows active running with hermes as the service user. Enabled (auto-start on boot).
9. **Smoke test 1: version check.** *Done.* DM "@Hermes-prod what version are you running?" → Hermes responded by actually running `pip show hermes-agent` on the droplet and reporting "Hermes Agent v0.14.0 by Nous Research." End-to-end Discord → Sonnet → tool use → response chain validated.
10. **Configure Opus escalation tier.** *Carved out to Spec 2.1.*
11. **Smoke test 2: escalation.** *Carved out to Spec 2.1.*
12. **Reboot persistence test.** *Done (replaces the original "24-hour cost observation" item — observation continues passively post-ship).* `sudo reboot`, SSH back in, `systemctl status hermes-gateway` showed `active (running)` with newer `ActiveEnterTimestamp` (PID 3395 → 772). Bot Online in Discord without intervention. systemd `enabled` is doing its job.
13. **Document and decide.** *In flight as part of the ship commit.*

### Verification plan
Full verification record (run-after-any-change checklist, operational notes, known failure modes) lives in `/docs/verification.md` "Hermes model routing + Discord gateway (2026-06-02)". Re-run after any infra or config change.

### Failure-mode preview (rolled into the verification.md section above)
| Symptom | Likely cause | Fix |
|---|---|---|
| Bot shows online but never responds to DMs | Message Content Intent not enabled in Developer Portal | Bot page → Privileged Gateway Intents → toggle on, Save Changes, restart `hermes-gateway` |
| Developer Portal blocks toggling Public Bot OFF | Install Link set to public-discoverable mode | Installation tab → Install Link → **None** → save → return to Bot tab → toggle Public Bot OFF |
| `sudo hermes ...` returns "command not found" | sudo strips PATH; venv binary not in default sudo path | Use full path: `sudo /home/hermes/.hermes/venv/bin/hermes ...` |
| `journalctl -u hermes-gateway` shows no Discord connection logs (just one warning) | hermes user isn't in `systemd-journal` group; can only see process's own log lines | Use `sudo journalctl ...` for now; Spec 2.1 adds hermes to `systemd-journal` group |
| `hermes gateway setup` fails with "invalid token" | Token copied with trailing whitespace, or token was reset after copy | Reset Token in Developer Portal, recopy carefully, re-run `hermes gateway setup` and choose Reconfigure |
| 401 from Anthropic on first call | API key not in `~/.hermes/.env`; key has no billing enabled | Verify file contents + perms; check Anthropic console billing |
| Daily cost spike | Retry loop or runaway prompt | Anthropic console enforces cap (calls 4xx after limit); manual fallback: `sudo systemctl stop hermes-gateway` and investigate `journalctl -u hermes-gateway` |
| Slash commands missing in Discord | Gateway never registered them; another follower gateway took registration | Re-run `hermes gateway setup`; if running multiple gateways against the same bot, set `gateway.platforms.discord.extra.slash_commands: false` on the follower |
| Hermes drops offline after droplet reboot | systemd unit not enabled, or `EnvironmentFile` path wrong | `systemctl is-enabled hermes-gateway` should return `enabled`; verify `~/.hermes/.env` exists; check `journalctl -u hermes-gateway -b` for the failed startup |
| Startup warnings: "Opus codec not found" and "websockets module" | Optional voice + browser tool subsystems not provisioned | Both benign for current scope. Voice intentionally OOS forever (no plan to use). Browser tools activated in Spec 2.1 (`pip install websockets`, Playwright + `hermes acp --setup-browser`) |
| Wizard can't install systemd unit ("requires sudo") | Interactive TUI can't escalate cleanly | Wizard prints the exact `sudo …` commands to run; copy-paste them with the full venv path |

---

## Spec 1 — VPS provisioning + Hermes Agent install

**Linked roadmap item:** Phase 1.5 → Infrastructure (first two checkboxes — provision VPS, install Hermes Agent with version pin)
**Author:** Isaac (drafted with Cowork, 2026-05-18; execution 2026-05-21 / 2026-05-26 / 2026-06-01)
**Status:** **shipped 2026-06-01.** Verification record lives in `/docs/verification.md` "Hermes infrastructure — Spec 1 (2026-06-01)". Decisions logged in `/docs/decisions.md` (2026-06-01 entries: DigitalOcean as VPS provider; Pin Hermes Agent to v0.14.0).
**Time spent:** Original estimate 1-1.5 hours; actual ~4 hours across three sessions. Drivers of the overrun captured in the decisions entries and in `verification.md`'s SSH lockout debugging playbook.

### Goal
Stand up the VPS where Hermes will live, install the Hermes Agent framework on it, verify the install. End state: an SSH-able DigitalOcean droplet running an idle Hermes Agent process, ready for model routing + Discord gateway configuration in Spec 2.

### Acceptance criteria
- DigitalOcean droplet exists: **1GB RAM / 1 vCPU, Ubuntu 24.04 LTS, NYC region** (closest DigitalOcean region to Supabase's `us-east-1`), name `hermes-prod`.
- Weekly backup snapshots enabled at provisioning (~$1.60/mo additional). Cost added to `/docs/operations.md` §1 cost model once the first DigitalOcean invoice confirms the actual charge.
- SSH key auth set up — new key generated for this droplet (`~/.ssh/id_ed25519` or similar; Isaac has no existing key per 2026-05-18 check).
- UFW firewall enabled on the droplet with port 22 (SSH) open only.
- Root SSH login disabled; non-root `hermes` user owns the install and has sudo access.
- Root password set (saved in password manager) so DigitalOcean's web console retains a fallback auth path after `PermitRootLogin no`. *Added during session 2 after a misdiagnosed lockout — see verification.md "SSH lockout debugging playbook" for the full story.*
- Hermes Agent v0.14.0 (git tag `v2026.5.16`) installed at `/home/hermes/.hermes/venv/` via pip into a Python 3.12 virtualenv. Venv auto-activates on SSH login via `~/.bashrc`.
- `hermes --version` returns `Hermes Agent v0.14.0 (2026.5.16)`.
- Droplet IP address (`167.71.161.145`) documented in Isaac's password manager alongside SSH key passphrase, hermes user password, and root password.
- `decisions.md` entries drafted by Cowork capturing: provider (DigitalOcean) and version pin (v0.14.0). Both appended 2026-06-01 with Isaac's per-entry approval.

### Out of scope (these are later specs)
- Model routing configuration (Sonnet default / Opus escalation) → **Spec 2**
- Discord gateway setup → **Spec 2**
- Hermes credentials for GitHub / Supabase / Vercel → **Spec 3**
- `translation_events` and `agent_events` tables → **Spec 4**
- Any actual Hermes work against the codebase → **Spec 5**

### Open questions (answers below; carried in from session 2026-05-18)
1. ~~Supabase prod region?~~ **`us-east-1`.** Provision the droplet in DigitalOcean's NYC region (closest match) — NYC3 if available (newest hardware), otherwise NYC1/NYC2.
2. ~~SSH key already on Isaac's Mac?~~ **No.** Generate a fresh one during execution: `ssh-keygen -t ed25519 -C "isaac-hermes-2026-05-18"`. Save passphrase in password manager.
3. ~~Backup strategy?~~ **Yes, enable backups at provisioning.** ~$1.20/mo for weekly snapshots. Justified given Hermes will accumulate skill library state we'd rather not lose. Update `operations.md` §1 cost model once first invoice confirms the line item.

### Technical sketch (as executed across sessions 2026-05-21 / 2026-05-26 / 2026-06-01)
1. **DigitalOcean account setup** (~10 min). Sign up, add payment, create a project called "Translation App."
2. **Generate SSH key on Isaac's Mac** (~5 min). `ssh-keygen -t ed25519` with a passphrase. Save key + passphrase in password manager. Add public key to DigitalOcean account.
3. **Create droplet** (~10 min). Basic / Premium Intel, $8/mo (1GB RAM / 1 vCPU / 35 GB SSD), Ubuntu 24.04 LTS, NYC3 region, name `hermes-prod`, attach the SSH key, enable backups (~$1.60/mo, weekly).
4. **Initial server hardening** (~20 min). SSH in as root → create non-root `hermes` user with sudo → copy SSH key to hermes user → enable UFW with port 22 open → run `apt update && apt upgrade -y`.
5. **Set root password before locking root SSH** (~3 min). `sudo passwd root`, save to password manager. Required so DigitalOcean's web console (older Recovery Console, VNC-based) retains a fallback auth path after `PermitRootLogin no`. The newer Droplet Console (one-click, hypervisor-level) doesn't require this, but the fallback is belt-and-suspenders. *Added after the session-1 lockout misdiagnosis; see decisions.md 2026-06-01 entries and verification.md.*
6. **Disable root SSH** (~5 min). Set `PermitRootLogin no` in `/etc/ssh/sshd_config`, verify effective config with `sudo sshd -T | grep -i permitrootlogin`. Verify from a separate terminal that `ssh root@…` fails and `ssh hermes@…` still succeeds.
7. **Install dependencies** (~10 min). Python 3.12 (Noble default), pip, venv, build-essential, git, curl, ca-certificates, pkg-config. Plus Chromium runtime libs for future Playwright use (libnss3, libnspr4, libatk*-t64, libcups2t64, libgbm1, libxshmfence1, etc. — Noble uses `t64` variants). Chromium itself stays managed by Playwright inside the venv when Hermes browser tools are activated later.
8. **Install Hermes Agent v0.14.0** (~10 min). As hermes user: `python3 -m venv ~/.hermes/venv && source ~/.hermes/venv/bin/activate && pip install --upgrade pip && pip install hermes-agent==0.14.0`. Append `source ~/.hermes/venv/bin/activate` to `~/.bashrc` so the venv auto-activates on SSH login.
9. **Verify** (~5 min). `hermes --version` returns `Hermes Agent v0.14.0 (2026.5.16)`. SSH out and back in; confirm `(venv)` shows in prompt automatically. Walk the verification checklist in `/docs/verification.md` "Hermes infrastructure — Spec 1 (2026-06-01)".
10. **Document and decide** (~30 min). Draft the two `decisions.md` entries (DO provider; version pin) for Isaac's per-entry approval, draft the `verification.md` "Hermes infrastructure" section, update `roadmap.md` Phase 1.5 checkboxes, update `hermes.md` version references, mark this spec shipped. One commit covers all of it.

### Verification plan
Verification ran end-to-end 2026-06-01 against the droplet at `167.71.161.145`. Full checklist (including post-ship failure-mode table and SSH lockout debugging playbook) lives in `/docs/verification.md` "Hermes infrastructure — Spec 1 (2026-06-01)" — re-run after any infra change. Acceptance criteria above all met at ship time.

### Lessons baked into other docs (rather than living here)
- **SSH lockout debugging playbook + operational safeguards** (set root password before locking root SSH; `ssh -v` first when diagnosing) → `/docs/verification.md` "Hermes infrastructure" section.
- **Provider choice rationale + version pin rationale** → `/docs/decisions.md` 2026-06-01 entries.
- **Verify spec-stated facts before provisioning** (the meta-lesson from why we needed a v0.2.0→v0.14.0 correction at all) → Cowork auto-memory `feedback_verify_speculative_claims_early`.

### Out-of-date "Resume notes" — removed 2026-06-01
The earlier Resume notes section (session 1, 2026-05-21) was built on a misdiagnosed lockout. Session 2 (2026-05-26) established that the lockout was a passphrase-prompt fumble on Isaac's local SSH client, not a server-side auth break. The diagnostic steps and "fix the hermes auth issue" path the resume notes prescribed were therefore moot. Removed to avoid future readers following a broken trail. The misdiagnosis is preserved in `/docs/verification.md` as a teaching example in the SSH lockout debugging playbook.

---

*(Future specs will be added below as drafted. Newest at top within a section; section order: draft → approved → in-flight → shipped.)*
