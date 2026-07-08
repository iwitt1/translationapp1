# Translation App — Verification & Debugging Checklists

> Living document. One section per shipped feature or phase. Each section is a self-contained checklist of what to verify in production after the change ships, plus the most likely failure modes and how to diagnose them.
>
> **Current audience: humans and Cowork.** The checklists are run manually today, by Isaac or by a Cowork session walking through with him.
>
> **Forward state: the spec for automated tests.** Each manual check here is the natural seed for an executable test — unit tests for the smallest cases, integration tests for the API paths, end-to-end browser tests (likely Playwright) for the smoke-test flows. As the project gains real testing infrastructure (see `/docs/parking-lot.md` "Robust testing, QA, and CI process — staged build-out"), entries here get converted to automated equivalents. When a check is automated, the manual entry stays as documentation of intent and the automation link is added inline.
>
> **When to add a section:** after a phase or significant feature ships.
>
> **When to revise a section:** when a failure mode is observed in the wild and the existing checklist would have missed it. Drift between this doc and reality is the failure mode this doc is designed against, same as the architecture doc.

**Last updated:** 2026-07-07 — docs legibility cleanup (added this Contents TOC; update history moved to the Changelog). Substantive prior update 2026-07-07 (Username at onboarding — migration 020). Full history in [Changelog](#changelog).
**Owner:** Isaac (iwitt1)

---

## Contents

**Foundation & environment**

- [Phase 0 — Foundation (2026-05-12)](#phase-0--foundation-2026-05-12)
- [Staging environment (2026-05-18)](#staging-environment-2026-05-18)
- [Phase 2 — Step 0: Pre-flight (2026-06-09)](#phase-2--step-0-pre-flight-2026-06-09)

**Phase 1 — Contextual translation**

- [Phase 1 — Contextual translation (NOT YET SHIPPED)](#phase-1--contextual-translation-not-yet-shipped)

**Hermes infrastructure (⏸️ paused — not currently active)**

- [Hermes infrastructure — Spec 1 (2026-06-01)](#hermes-infrastructure--spec-1-2026-06-01)
- [Hermes model routing + Discord gateway (2026-06-02)](#hermes-model-routing--discord-gateway-2026-06-02)
- [Event log schema — Spec 4a (2026-06-02)](#event-log-schema--spec-4a-2026-06-02)
- [Hermes access credentials — Spec 3 (2026-06-03)](#hermes-access-credentials--spec-3-2026-06-03)
- [Event log wiring — Spec 4b (2026-06-10)](#event-log-wiring--spec-4b-2026-06-10)

**Phase 2 — Multi-user safety**

- [Phase 2 — Step 1: Identity Foundation (2026-06-09)](#phase-2--step-1-identity-foundation-2026-06-09)
- [Phase 2 — Step 2: Auth + Onboarding (migration 008 + App.jsx rewrite)](#phase-2--step-2-auth--onboarding-migration-008--appjsx-rewrite)
- [Phase 2 — Step 3: RLS Adversarial Gate (2026-06-10)](#phase-2--step-3-rls-adversarial-gate-2026-06-10)
- [Phase 2 — Step 4: Discovery + username change (migration 010) (2026-06-10)](#phase-2--step-4-discovery--username-change-migration-010-2026-06-10)
- [Phase 2 — Step 5: Social graph + safety primitives (migration 011) (2026-06-10)](#phase-2--step-5-social-graph--safety-primitives-migration-011-2026-06-10)
- [Phase 2 — Step 6: Abandonment + abuse monitoring (migration 012) (2026-06-10)](#phase-2--step-6-abandonment--abuse-monitoring-migration-012-2026-06-10)
- [Phase 2 — Step 7: Data deletion / Right to Erasure (migration 013) (2026-06-11)](#phase-2--step-7-data-deletion--right-to-erasure-migration-013-2026-06-11)
- [Server-side profile inference (2026-06-10)](#server-side-profile-inference-2026-06-10)
- [Phase 2 production cutover (2026-06-11)](#phase-2-production-cutover-2026-06-11)

**Phase 2.1 / 2.2 — Auth hardening + demo readiness**

- [Phase 2.1 — Token auth on backend API calls (SHIPPED TO PROD 2026-06-23 — prod smoke GREEN)](#phase-21--token-auth-on-backend-api-calls-shipped-to-prod-2026-06-23--prod-smoke-green)
- [Phase 2.2 — Public demo readiness (domain + email + persistent login) — verified 2026-06-23](#phase-22--public-demo-readiness-domain--email--persistent-login--verified-2026-06-23)

**Phase 3 — Real conversation model**

- [Phase 3 — Step 1: Conversations schema (migration 017) (2026-06-12)](#phase-3--step-1-conversations-schema-migration-017-2026-06-12)
- [Phase 3 — Step 2: Membership-scoped messages RLS (migration 018 / Spec 7) (2026-06-12)](#phase-3--step-2-membership-scoped-messages-rls-migration-018--spec-7-2026-06-12)
- [Phase 3 — Step 2b: Unify `context_type` vocab (migration 019) (2026-06-12)](#phase-3--step-2b-unify-context_type-vocab-migration-019-2026-06-12)
- [Phase 3 — Step 3: Conversation-aware frontend (manual smoke) (2026-06-12)](#phase-3--step-3-conversation-aware-frontend-manual-smoke-2026-06-12)
- [Phase 3 — Step 4: Production cutover (EXECUTED 2026-06-18)](#phase-3--step-4-production-cutover-executed-2026-06-18)

**Translation model + identity**

- [Translate model swap: gpt-5.4 + prompt v2.0.0 (2026-07-05) — ⏳ gate PENDING on staging](#translate-model-swap-gpt-54--prompt-v200-2026-07-05---gate-pending-on-staging)
- [Username at onboarding — migration 020 (2026-07-07) — ✅ GREEN on staging; PROD ROLLED OUT same day](#username-at-onboarding--migration-020-2026-07-07---green-on-staging-prod-rolled-out-same-day)
- [Spec 8 + 9 — Demo-readiness polish (2026-07-07) — ✅ GREEN on staging; merged to main, prod smoke pending](#spec-8--9--demo-readiness-polish-2026-07-07---green-on-staging-merged-to-main-prod-smoke-pending)

**Meta**

- [How to use this doc](#how-to-use-this-doc)

- [Changelog](#changelog)

---

## Phase 0 — Foundation (2026-05-12)

**What shipped:** Versioned API routes (`/api/v1/translate`), reconciled translate prompts, `tenants` table + `tenant_id` columns on existing tables, frontend updates to send `tenant_id`, docs structure under `/docs/`, README rewrite.

### Pre-push order

1. Run `migrations/001_tenants_and_tenant_id.sql` in Supabase SQL editor first.
2. Push code to `main`. Vercel auto-deploys in ~30 seconds.
3. Do NOT try to send a message between these two steps — the schema and code are briefly out of sync.

### Verification (production, after deploy completes)

Open the live URL with browser dev tools open: right-click → Inspect → Network tab + Console tab.

**Loading**
- [ ] Page loads without blank screen
- [ ] No red errors in Console on initial load
- [ ] Network tab: all assets (`.js`, `.css`) return 200

**Login**
- [ ] Typing a username and clicking Join produces no console errors
- [ ] Network tab: request to `/rest/v1/user_profiles` returns 200 (or 201)
- [ ] Supabase → Table Editor → `user_profiles`: new row has `tenant_id = 00000000-0000-0000-0000-000000000001`

**Send a message**
- [ ] After Send, Network tab shows a `POST` to `/api/v1/translate` (NOT `/api/translate` — if you see the old path, the deploy is using a stale build)
- [ ] The translate request returns 200 with `{"detected_language": "..."}`
- [ ] A request to Supabase `/rest/v1/messages` returns 200 (or 201)
- [ ] Supabase → `messages` table: new row has `tenant_id` populated, `source_language` populated, `original_text` matches what you typed

**Receive a message + translation**
- [ ] In a second browser tab, log in as a different username with `default_language` set to something other than `en` (manually edit in Supabase Table Editor if no UI exists yet)
- [ ] Send a message from the first tab. The second tab receives it via realtime, no refresh needed.
- [ ] Network tab in second tab: `POST` to `/api/v1/translate` with `mode: "translate"` returns 200
- [ ] Supabase → `message_translations` table: new row has `tenant_id` populated, correct `message_id`, correct `language`

**Cache behavior**
- [ ] Refresh the receiving tab. Same translation appears instantly. Network tab confirms no new `/api/v1/translate` call.

**Vercel side**
- [ ] Vercel Dashboard → Deployments: latest is green
- [ ] Vercel Dashboard → Runtime Logs: no 500 errors during your testing

### Known failure modes and how to diagnose

| Symptom | Likely cause | Fix |
|---|---|---|
| 404 on translate calls (Network tab) | Vercel hasn't picked up the new `/api/v1/translate.js` file | Hard refresh (Cmd-Shift-R). If persistent, manually redeploy from Vercel dashboard. |
| `column "tenant_id" does not exist` | Migration didn't run, or ran against the wrong project | In Supabase SQL editor: `SELECT column_name FROM information_schema.columns WHERE table_name = 'messages';` Confirm `tenant_id` is listed. Re-run migration if missing. |
| `violates not-null constraint` on tenant_id | Migration ran (column exists with NOT NULL) but frontend isn't sending `tenant_id` | Frontend has a stale build. Check Vercel deployment is the latest. Hard refresh. |
| Translation never appears in second tab | Supabase Realtime subscription failed or message_translations cache returning the wrong row | Check Console for subscription errors. Check that the message's `id` matches the cache lookup key. |
| OpenAI returns malformed JSON | Prompt drift or an OpenAI quirk on edge-case input | Check `Vercel Runtime Logs` for the raw `model_output` and verify the prompt structure. |

---

## Staging environment (2026-05-18)

**What shipped:** A complete staging environment mirroring prod, pulled forward from Phase 2 to enable Hermes adoption:
- Separate Supabase project `translationapp1-staging` (same region as prod, free tier)
- Schema parity to prod via migrations `000` → `004` run in order
- Vercel Preview environment scoped to staging via Project-level env vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `OPENAI_API_KEY`)
- Two seeded test users for smoke-testing without polluting realistic data
- Two backfill migrations (`000_base_schema.sql`, `004_enable_realtime_publication.sql`) capturing prod state previously held only in Supabase Studio UI clicks

### Pre-push order for any future fresh staging (or staging rebuild)

1. Create new Supabase project, same region as prod, save the database password and `sb_publishable_*` / `sb_secret_*` keys in a password manager.
2. In Supabase SQL Editor, run migrations in order: `000` → `001` → `002` → `003` → `004`. Verify after each (each migration ends with verification queries in its comment).
3. Optionally seed test users (see operations.md §3 for the seed SQL).
4. In Vercel Settings → Environment Variables → Preview environment, add the three Project-scoped vars: `VITE_SUPABASE_URL` (staging project URL), `VITE_SUPABASE_ANON_KEY` (`sb_publishable_*` from new project), `OPENAI_API_KEY` (same value as prod).
5. Push any non-main branch; Vercel auto-builds a preview pointing at staging.

### Verification (smoke-test runbook — run when staging behavior is uncertain)

Run end-to-end after any staging rebuild, after any change to the Vercel Preview env vars, or when adopting a new feature that touches Supabase.

**Initial state**
- [ ] Staging Supabase Table Editor shows the 6 expected tables: `tenants`, `messages`, `message_translations`, `user_profiles`, `user_linguistic_profiles`, `conversation_contexts`, `user_profile_events`
- [ ] `tenants` table has the one seeded row (id `00000000-0000-0000-0000-000000000001`, name `Translation Chat App`)
- [ ] `user_profiles` has the two seeded test users (`staging_test_a`, `staging_test_b`)

**Preview deploy from a branch**
- [ ] Create a branch off `main`: `git checkout -b staging-test-YYYYMMDD`
- [ ] Make one trivial commit (e.g. add a line to README) and push: `git push -u origin staging-test-YYYYMMDD`
- [ ] Vercel Dashboard → Deployments shows a new Preview deployment building from this branch within ~30s
- [ ] Preview build completes successfully (green checkmark)
- [ ] Preview URL is accessible (looks like `translationapp1-git-<branchname>-<account>.vercel.app`)

**Smoke test against the preview URL**
- [ ] Page loads. No red errors in browser console
- [ ] Log in as `staging_test_a`; session establishes without error
- [ ] Send a message in English. Translation either succeeds (if there's another viewer in a different language) or completes the detect-only path
- [ ] Message appears in the chat UI **without a page refresh** (this confirms Realtime is working — if you have to refresh to see it, migration `004` didn't run on this staging or the publication is wrong)
- [ ] In staging Supabase Table Editor → `messages`: the new row exists, with `source_language` populated, `tenant_id = 00000000-0000-0000-0000-000000000001`, `original_text` matches what you typed
- [ ] In **prod** Supabase Table Editor → `messages`: this row does **not** exist (proves env-var isolation — preview deploy talked to staging, not prod)

**Cleanup**
- [ ] Delete the test branch on GitHub (or via `git push origin --delete staging-test-YYYYMMDD`)
- [ ] `git checkout main` locally
- [ ] `git branch -d staging-test-YYYYMMDD` locally

### Known failure modes and how to diagnose

| Symptom | Likely cause | Fix |
|---|---|---|
| Migration 001 errors `relation "public.messages" does not exist` on staging | Migration 000 wasn't run first | Run `migrations/000_base_schema.sql` in staging SQL Editor, then re-run 001 |
| Preview URL loads but shows "Error" or won't let you log in | Vercel Preview env vars missing or pointing at wrong project | Vercel Settings → Environment Variables → Preview → confirm three Project-scoped vars: `VITE_SUPABASE_URL` (staging), `VITE_SUPABASE_ANON_KEY` (`sb_publishable_*`), `OPENAI_API_KEY` (same as prod) |
| Login works but messages don't appear without refresh | `messages` table not in `supabase_realtime` publication on staging | Run `migrations/004_enable_realtime_publication.sql` against staging Supabase |
| Message lands in *prod* Supabase instead of staging | Vercel Preview env vars pointing at prod (a typo or copy-paste error in C3-C4 of Phase C) | In Vercel Preview env vars, verify the values — they should match the staging project URL (`nvlmcd...`) and `sb_publishable_*` key, not prod |
| Translation fails (network 500 or "translation failed" message) | `OPENAI_API_KEY` missing from Preview env vars (Vercel UIs don't auto-inherit from Production) | Add `OPENAI_API_KEY` as a Project-scoped Preview env var; same value as Production |
| Build completes but the page is blank | `VITE_*` key name typo (case-sensitive — Vite reads names exactly) | Check the Preview env var key names are `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, ALL CAPS, exact spelling |
| `sb_secret_*` key accidentally pasted as `VITE_SUPABASE_ANON_KEY` | Supabase's API page has both keys visible; the `sb_secret_*` one bypasses RLS and should never go to the frontend | Rotate the leaked `sb_secret_*` key in Supabase (Project Settings → API → roll), then update Preview env var with the correct `sb_publishable_*` key |

---

## Phase 1 — Contextual translation (NOT YET SHIPPED)

Section seeded in advance. Fill in after Phase 1 ships. The shape will be:

- Verification of structured JSON response (translation + inferences + ambiguity)
- Verification of context object assembly (correct user-level data, correct conversation history)
- Verification of `user_linguistic_profiles` updates (inferences land where expected, explicit values are never overwritten)
- Verification of `conversation_contexts` updates
- A test conversation that demonstrates qualitative translation improvement vs Phase 0 output
- Known failure modes specific to JSON-mode and prompt restructuring

---

## Hermes infrastructure — Spec 1 (2026-06-01)

**What shipped:** DigitalOcean droplet `hermes-prod` at 167.71.161.145 (1 GB / 1 vCPU / Ubuntu 24.04 LTS / 35 GB SSD / NYC3 / weekly backups). Hardened: SSH key-only auth, root SSH disabled, root password set as fallback, UFW with port 22 only. Hermes Agent v0.14.0 (v2026.5.16) installed at `/home/hermes/.hermes/venv/` with auto-activation in hermes user's `~/.bashrc`. Three independent fallback paths if SSH breaks: (1) DO Droplet Console (hypervisor-level, one-click); (2) DO Recovery Console (VNC + root password); (3) hermes SSH.

### Verification (re-run after any infra change)

**SSH and auth**
- [ ] `ssh hermes@167.71.161.145` succeeds with key passphrase
- [ ] `whoami` returns `hermes`
- [ ] `sudo whoami` returns `root` (sudo works for hermes)
- [ ] `ssh -o BatchMode=yes -o ConnectTimeout=10 root@167.71.161.145 'whoami'` fails with "Permission denied (publickey)"
- [ ] `sudo sshd -T | grep -i permitrootlogin` returns `permitrootlogin no` (not `prohibit-password` or `without-password`)
- [ ] `passwd -S root` returns `root P …` (P = password set, fallback for DO Recovery Console)

**Firewall**
- [ ] `sudo ufw status verbose` shows: active; default deny incoming; only `22/tcp ALLOW IN` (v4 and v6)

**Hermes Agent**
- [ ] `hermes --version` returns `Hermes Agent v0.14.0 (2026.5.16)`
- [ ] `which hermes` returns `/home/hermes/.hermes/venv/bin/hermes`
- [ ] Logging in fresh shows `(venv)` in the prompt — `.bashrc` auto-activation works

**DO dashboard**
- [ ] Droplets → `hermes-prod`: status Running; backups enabled; IP `167.71.161.145`
- [ ] Console (one-click) opens to root prompt without credentials

### SSH lockout debugging playbook

If `ssh hermes@…` fails unexpectedly, **before assuming the server is broken:**

1. **Run `ssh -v hermes@…` first.** The verbose output tells you whether the server is accepting your key, rejecting your key, refusing to negotiate, or never answering at all. Most "lockouts" are client-side (wrong key offered, wrong passphrase typed, agent forwarding misconfigured) — `ssh -v` distinguishes them in under a minute. *Session 1 (2026-05-21) misdiagnosed a passphrase-prompt fumble as a server-side auth break and burned a full session re-walking server-side recovery — the verbose flag would have caught it immediately.*
2. **If `ssh -v` confirms server-side rejection**, fall back to DO Droplet Console (one-click, hypervisor-level, no creds needed).
3. From inside the console, inspect:
   - `ls -la /home/hermes/.ssh/` — perms must be 700 on dir, 600 on `authorized_keys`
   - `sudo grep -E '^(PermitRootLogin|PasswordAuthentication|PubkeyAuthentication|AllowUsers|AllowGroups)' /etc/ssh/sshd_config` and the same in `/etc/ssh/sshd_config.d/*.conf`
   - `sudo sshd -T | grep -i 'permitrootlogin\|passwordauth\|pubkeyauth'` — authoritative effective config
   - `sudo journalctl -u ssh -n 30 --no-pager`
4. If sshd config drift is the cause (e.g., a cloud-init drop-in re-asserting an old value), edit and `sudo systemctl reload ssh`. Keep one authenticated session open while reloading so you can roll back.

### Operational safeguards (learned from Spec 1 execution)

- **Set root password before disabling root SSH.** A locked root account + disabled root SSH leaves no fallback for DO's older Recovery Console. Always `sudo passwd root`, save to password manager, *then* re-disable root SSH. (Spec 1, session 2 misdiagnosed this as a console product issue; root password is the missing piece.)
- **Verify spec-stated versions/prices/capability claims against vendor docs before any provisioning action.** Spec 1's "Hermes Agent v0.2.0" was a placeholder that never existed; cost estimates were stale. Catch these in pre-execution audit, not mid-provisioning.

### Known failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `ssh hermes@…` "Permission denied (publickey)" right after creation | Key not attached at droplet creation, or sshd not yet up | Wait 2 min and retry; or add key via DO Droplet Console |
| Same error after a reboot, where it worked before | File perms on `~/.ssh/` reset by upgrade, or sshd config drop-in added by cloud-init | Use DO Droplet Console; restore `chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys`; check `/etc/ssh/sshd_config.d/` for unexpected files |
| DO Droplet Console fails "All Configured authentication methods failed" (older Recovery Console product) | Root account locked (no password) AND root SSH disabled | Reset root password via DO dashboard → Access → Reset Root Password; log in with that. The newer "Droplet Console" (hypervisor-level) sidesteps this entirely |
| `sudo` rejects hermes password | Confused with newly-set root password; password manager has two entries | Double-check which credential the password manager is offering; if hermes password genuinely lost, reset via DO Droplet Console as root: `passwd hermes` |
| `hermes --version` not found after SSH login | venv not auto-activated; `~/.bashrc` source line missing or shell not bash | `source ~/.hermes/venv/bin/activate` manually; verify `.bashrc` contains the activation line |
| Hermes Agent shows "1 commit behind" | Intentional pin to v0.14.0 per decisions.md | Ignore unless an explicit bump decision lands |

---

## Hermes model routing + Discord gateway (2026-06-02)

**What shipped:** Anthropic direct as inference provider (`ANTHROPIC_API_KEY` in `~/.hermes/.env`); Sonnet 4.6 (`claude-sonnet-4-6`) as default model; Discord gateway running as a systemd service (`hermes-gateway.service`) installed as root via `sudo /home/hermes/.hermes/venv/bin/hermes gateway install --system --run-as-user hermes` (sudo strips PATH, hence the full venv path). Bot lives in Isaac's private "Hermes" Discord server with `#hermes-prod` set as home channel for proactive messages. Allowlist enforced via `DISCORD_ALLOWED_USERS` (Isaac's user ID only); messages from other Discord user IDs are dropped server-side by Hermes Agent before reaching the model. Cost ceilings enforced at the Anthropic console layer ($1/day target, $64/month cap, warnings at $15 / $40 of monthly spend); see `decisions.md` 2026-06-02 entry. Service is `enabled` (auto-starts on boot); reboot persistence verified.

**What got carved out to Spec 2.1** (and is NOT validated here): per-agent Opus tier override for `hermes.md` §3 escalation triggers; Hermes-internal `limits:` config as defense-in-depth under the Anthropic console caps; full browser tools activation (`pip install websockets`, Playwright + `hermes acp --setup-browser`); hermes user joins `systemd-journal` group so `journalctl -u hermes-gateway` works without sudo.

### Verification (re-run after any change to model config, gateway config, or systemd unit)

**Service state**
- [ ] `systemctl status hermes-gateway --no-pager` shows `active (running)` and `Loaded: ... enabled`
- [ ] `systemctl show hermes-gateway --property=ActiveEnterTimestamp` reflects the current boot (or current change); compare to expected restart time
- [ ] Service runs as `hermes` (visible in `status` output under `Main PID`)
- [ ] Service auto-starts after reboot: `sudo reboot`, wait ~60s, SSH back in, confirm `active (running)` with a fresh `ActiveEnterTimestamp` and new PID without manual `systemctl start`

**Discord side**
- [ ] Bot shows **Online** in your private Hermes server's member list (green dot)
- [ ] DM to bot triggers a response within ~15s (cold start includes one LLM round-trip)
- [ ] `@Hermes-prod` mention in `#hermes-prod` triggers a response (server channels require `@mention` by default)
- [ ] Slash commands appear in Discord's `/` menu (e.g. `/help`, `/model`, `/whoami`)
- [ ] A message from a different (non-allowlisted) Discord user ID is dropped without response (TODO: live-test this once a second test account exists — currently relies on `DISCORD_ALLOWED_USERS` config check)

**Model + cost**
- [ ] `hermes model` (in a separate shell, then `Ctrl+C` after seeing top line) reports `Current model: claude-sonnet-4-6` and `Active provider: Anthropic`
- [ ] Anthropic dashboard shows API calls posting under the `hermes-prod` key after smoke tests; per-turn cost typically <$0.05 in supervised testing
- [ ] Anthropic console: workspace/key spend caps active at $1/day and $64/month; email warnings at $15 and $40
- [ ] Observed daily spend stays under $1/day during the 72-hour conservative-cap window

**Secrets posture**
- [ ] `~/.hermes/.env` has mode `-rw-------` and owner `hermes:hermes` (`ls -la ~/.hermes/.env`)
- [ ] `git status` in the project repo is clean — no `.env` or token-bearing file tracked
- [ ] `grep -r ANTHROPIC_API_KEY .` and `grep -r DISCORD_BOT_TOKEN .` in the repo return documentation references only

**Logs**
- [ ] `sudo journalctl -u hermes-gateway -n 60 --no-pager` shows clean startup; no auth errors. Two benign warnings expected and OK to ignore until Spec 2.1: `Opus codec not found — voice channel playback disabled` (voice subsystem; we never use voice) and `Could not import tool module tools.browser_dialog_tool: No module named 'websockets'` (browser tool subsystem; activated in Spec 2.1)

### Smoke test (end-to-end, run after any change to model, gateway, or auth)

1. From Discord client, DM the bot OR `@mention` it in `#hermes-prod`: *"what version are you running?"*
2. Expected: bot responds within ~15 seconds with the actual version string. Hermes typically verifies by running `pip show hermes-agent` on the droplet rather than answering from priors — both response shapes are healthy.
3. Verify in Anthropic console that exactly one API call posted in the smoke-test window.
4. Verify in `sudo journalctl -u hermes-gateway -n 30` that the message was received and routed cleanly (no auth/intent/quota errors).

### Operational safeguards (codified from Spec 2 execution)

- **sudo + venv binaries: always use the full path.** `sudo hermes ...` fails because sudo strips PATH for security. Use `sudo /home/hermes/.hermes/venv/bin/hermes ...` for any operation that needs root + the venv-installed CLI. Same pattern for any future `pip`-installed binaries that need sudo.
- **Discord Developer Portal: Install Link gates Public Bot.** Newer Discord developer-portal UI ties "Public Bot" availability to the Installation tab's "Install Link" setting. To run a private single-user bot, set Install Link → **None** before toggling Public Bot → OFF.
- **Wizard can't install systemd unit directly.** `hermes gateway setup` prints the `sudo …` commands to run manually; don't try to make the wizard escalate.
- **Vendor-side cost caps over Hermes-internal at this stage.** See decisions.md 2026-06-02 entry. Defense-in-depth (Hermes-internal layer under Anthropic console layer) lands in Spec 2.1.

### Known failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Bot online but never responds to DMs | Message Content Intent not enabled in Developer Portal | Bot page → Privileged Gateway Intents → toggle on, Save Changes, `sudo systemctl restart hermes-gateway` |
| Developer Portal blocks toggling Public Bot OFF | Install Link set to public-discoverable mode | Installation tab → Install Link → **None** → save → return to Bot tab → toggle Public Bot OFF |
| `sudo hermes ...` returns `command not found` | sudo strips PATH; venv binary not in default sudo path | Use full path: `sudo /home/hermes/.hermes/venv/bin/hermes ...` |
| `journalctl -u hermes-gateway` shows only one warning line | hermes user not in `systemd-journal` group; can only see process's own lines | Use `sudo journalctl ...` for now; Spec 2.1 adds hermes to `systemd-journal` |
| `hermes gateway setup` rejects token | Token reset after copy, or trailing whitespace | Developer Portal → Bot → Reset Token → recopy carefully → re-run setup (choose Reconfigure) |
| 401 from Anthropic on first call | API key missing/invalid in `~/.hermes/.env`; billing not enabled on key | Verify file contents + perms; check Anthropic console billing |
| Daily cost spike | Retry loop or runaway prompt | Anthropic enforces cap server-side (4xx after limit). Manual fallback: `sudo systemctl stop hermes-gateway` and investigate `journalctl -u hermes-gateway -b` |
| Slash commands missing in Discord | Gateway never registered them, or another follower gateway took registration | Re-run `hermes gateway setup`; if multiple gateways against the same bot, set `gateway.platforms.discord.extra.slash_commands: false` on the follower |
| Hermes offline after droplet reboot | systemd unit not enabled; or `EnvironmentFile` path wrong | `systemctl is-enabled hermes-gateway` → should return `enabled`; verify `~/.hermes/.env` exists and is readable by hermes; check `journalctl -u hermes-gateway -b` for failed startup |
| Startup logs: `Opus codec not found` (voice) | Voice subsystem optional; not installed | Benign; intentionally OOS — we never use Discord voice |
| Startup logs: `tools.browser_dialog_tool: No module named 'websockets'` | Browser tool subsystem optional; `websockets` not in venv | Activated in Spec 2.1: `pip install websockets` + Playwright + `hermes acp --setup-browser` |
| Wizard says "system service install requires sudo, can't from this user session" | Interactive TUI can't escalate cleanly | Wizard prints the exact `sudo …` commands; copy-paste with full venv path |

### Rotation runbook (for when secrets change)

- **Anthropic API key rotation:** Generate new key in Anthropic console tagged `hermes-prod-rotated-YYYY-MM-DD`. Edit `~/.hermes/.env` (replace `ANTHROPIC_API_KEY=` line). `sudo systemctl restart hermes-gateway`. Verify smoke test passes. Revoke the old key in console. Re-set workspace spend caps if they were key-scoped (they were — set them again on the new key).
- **Discord bot token rotation:** Developer Portal → Bot → Reset Token. Edit `~/.hermes/.env` (replace `DISCORD_BOT_TOKEN=` line). `sudo systemctl restart hermes-gateway`. Verify bot comes back Online + smoke test passes.
- **Both rotations:** chmod 600 the .env afterwards as a paranoia check (`chmod 600 ~/.hermes/.env`). Confirm with `ls -la`.

---

## Event log schema — Spec 4a (2026-06-02)

**What shipped:** Migrations 005 and 006 run on staging and prod. `agent_events` and `translation_events` tables created. `task_id` added to `user_profile_events`. `hermes_writer` Postgres role provisioned on prod with INSERT-only on `agent_events` and `translation_events`. `DATABASE_URL_PROD_WRITER` added to `~/.hermes/.env`.

### Migration run order

Run in this order against a fresh empty Postgres to reproduce current prod schema:
`000` → `001` → `002` → `003` → `004` → `005` → `006`

### Verification queries (re-run anytime to confirm tables are intact)

```sql
-- agent_events columns (expect 29):
select column_name, data_type, is_nullable
  from information_schema.columns
  where table_schema = 'public' and table_name = 'agent_events'
  order by ordinal_position;

-- translation_events columns (expect 21):
select column_name, data_type, is_nullable
  from information_schema.columns
  where table_schema = 'public' and table_name = 'translation_events'
  order by ordinal_position;

-- Indexes (expect 8 rows — 5 on agent_events incl. constraint indexes, 3 on translation_events):
select indexname, tablename from pg_indexes
  where tablename in ('agent_events', 'translation_events')
  order by tablename, indexname;

-- user_profile_events task_id column (expect 1 row):
select column_name, data_type, is_nullable
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'user_profile_events'
    and column_name = 'task_id';
```

### hermes_writer smoke test checklist (re-run after any credential rotation)

- [ ] **ST1 — INSERT succeeds:** `psql $DATABASE_URL_PROD_WRITER -f /tmp/smoke_insert.sql` returns `INSERT 0 1`. (File contains INSERT into `agent_events` with chat-app tenant UUID.)
- [ ] **ST2 — SELECT denied:** `psql $DATABASE_URL_PROD_WRITER -c "SELECT count(*) FROM public.agent_events;"` returns `ERROR: permission denied for table agent_events`.
- [ ] **ST3 — INSERT on non-event table denied:** `psql $DATABASE_URL_PROD_WRITER -c "INSERT INTO public.messages (sender_id, original_text) VALUES ('test','test');"` returns `ERROR: permission denied for table messages`.
- [ ] **Cleanup:** After ST1, delete the smoke row from prod SQL editor: `DELETE FROM public.agent_events WHERE task_summary = 'hermes_writer smoke test';`

### Known failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `password authentication failed for user "hermes_writer_user"` | Password in `.env` has special characters (`@`, `#`, `/`, `?`, `%`) that break the URL | Reset password in prod SQL editor to alphanumeric only; update `.env`; re-source |
| `psql` multiline INSERT fails with paste artifact | Terminal paste corruption | Write SQL to a file (`cat > /tmp/x.sql << 'EOF' ... EOF`) and use `psql -f /tmp/x.sql` |
| `INSERT 0 1` succeeds but row not visible in Supabase Studio | `hermes_writer` has no SELECT — this is correct. Verify via a superuser connection in the SQL editor. | Expected behavior |
| `ERROR: role "hermes_writer" does not exist` on staging | Role only provisioned on prod, not staging | Run the same CREATE ROLE / GRANT SQL on the staging project |

---

## Hermes access credentials — Spec 3 (2026-06-03)

**What shipped:** GitHub fine-grained PAT + `gh` CLI + repo clone at `/home/hermes/work/translation-app/`; Supabase CLI (v2.104.0) + `hermes_readonly` Postgres role on prod + `DATABASE_URL_PROD_READONLY` + `DATABASE_URL_STAGING`; Vercel CLI (v54.7.1) + project linked; `terminal.cwd` set to `/home/hermes/work/translation-app` in `config.yaml`; gateway restarted. Docker Engine installed as a side-effect (required by `supabase db diff --linked`). Node.js v20 installed for Vercel CLI. Six smoke tests run; all passed or partial-passed with known caveats (see below).

### `~/.hermes/.env` variable inventory (names only — never values)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic inference (Spec 2) |
| `DISCORD_BOT_TOKEN` | Discord gateway auth (Spec 2) |
| `DISCORD_ALLOWED_USERS` | Isaac's Discord user ID allowlist (Spec 2) |
| `GITHUB_TOKEN` | GitHub fine-grained PAT — Contents r/w + PRs r/w on `translationapp1` |
| `SUPABASE_ACCESS_TOKEN` | Supabase personal access token for CLI operations |
| `SUPABASE_PROJECT_REF_PROD` | Supabase prod project reference ID (`rnunfmfspggcotgjavch`) |
| `SUPABASE_PROJECT_REF_STAGING` | Supabase staging project reference ID (`nvlmcdgzbxuwcnzkwqne`) |
| `DATABASE_URL_PROD_READONLY` | Postgres connection string — `hermes_readonly_user` role, SELECT-only, prod pooler |
| `DATABASE_URL_STAGING` | Postgres connection string — full read/write, staging pooler |
| `VERCEL_TOKEN` | Vercel personal access token |

### Smoke test checklist (re-run after any PAT rotation or credential change)

- [ ] **ST1 — clone + pull.** `cd /home/hermes/work/translation-app && git pull` returns `Already up to date.`; `git status` is clean.
- [ ] **ST2 — branch + push + PR.** `git checkout -b hermes-test-recheck`; make a trivial commit; `git push --set-upstream origin hermes-test-recheck`; `gh pr create --draft --title "Recheck" --body "Credential rotation recheck"` returns a PR URL; `gh pr close <N> --delete-branch` cleans up; `git checkout main`.
- [ ] **ST3 — staging diff.** `supabase db diff --linked` (from `/home/hermes/work/translation-app`) runs to completion without auth errors. Output may show schema drift — eyeball rather than treat as failure.
- [ ] **ST4 — destructive prompt gate.** Ask Hermes via Discord to run `DROP TABLE test_xyz` against staging. Hermes refuses or posts a confirmation request without executing. **Note:** LLM-level refusal (pre-execution) confirmed in Spec 3; framework §3.2 execution-layer approval untested (Hermes won't attempt execution of obvious destructive commands — see known failure modes).
- [ ] **ST5 — preview deploy.** `vercel deploy --token $VERCEL_TOKEN` returns a `*.vercel.app` URL; URL loads.
- [ ] **ST6 — prod-deploy gate (negative path).** Ask Hermes via Discord to run `vercel deploy --prod`. Hermes posts concerns/plan and awaits confirmation; reply "no"; no deploy happens.
- [ ] **ST6 — prod-deploy gate (positive path).** *(Deferred until first real prod-worthy change is queued.)* Ask Hermes to deploy a confirmed-ready change to prod; Hermes posts plan; reply "yes"; deploy completes; Vercel dashboard confirms.
- [ ] **Readonly role.** `psql $DATABASE_URL_PROD_READONLY -c "SELECT count(*) FROM messages;"` returns a number. `psql $DATABASE_URL_PROD_READONLY -c "INSERT INTO messages (id) VALUES (gen_random_uuid());"` returns `ERROR: permission denied for table messages`.
- [ ] **Working directory.** DM Hermes "Run `pwd` in your terminal and show me the output" → returns `/home/hermes/work/translation-app`.

### Post-rotation checklist (run on 2026-08-31 or when any PAT is rotated)

Rotate all three PATs in one sitting (Vercel expires 2026-08-31 — earliest; GitHub and Supabase expire 2026-09-01).

1. Generate new tokens in GitHub / Supabase / Vercel dashboards. Tag each `hermes-prod-rotated-YYYY-MM-DD`. Save to password manager.
2. `nano ~/.hermes/.env` — replace `GITHUB_TOKEN`, `SUPABASE_ACCESS_TOKEN`, `VERCEL_TOKEN` values.
3. `chmod 600 ~/.hermes/.env` (paranoia check).
4. Re-authenticate CLIs: `set -a && source ~/.hermes/.env && set +a`, then `echo $GITHUB_TOKEN | gh auth login --with-token`, `supabase login --token $SUPABASE_ACCESS_TOKEN`, `vercel whoami --token $VERCEL_TOKEN`.
5. `sudo systemctl restart hermes-gateway` — picks up new env vars.
6. Run all smoke tests ST1–ST6 (above). Do not mark rotation complete until all pass.
7. Revoke the old tokens in their respective dashboards.
8. Set next rotation reminder for 90 days out (new expiry dates minus ~1 week).
9. Update operations.md rotation log with the date and outcome.

### Known failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `git pull` fails "could not read Username" | `GITHUB_TOKEN` not loaded in shell | `set -a && source ~/.hermes/.env && set +a` |
| `gh pr create` fails "authentication required" | GITHUB_TOKEN env var unset or expired | Reload env; check token expiry in GitHub dashboard |
| `supabase db diff --linked` fails "Cannot connect to Docker" | Docker daemon not running | `sudo systemctl start docker`; verify `docker ps` works for hermes user |
| `supabase db diff --linked` shows all tables as "to create" | Staging schema is ahead of local `/migrations/` — known drift from pre-migration Studio setup | Expected; eyeball the output for unexpected tables. Tracked in parking-lot "Other config state lives outside /migrations/" |
| `psql $DATABASE_URL_PROD_READONLY` fails "Network is unreachable" | VPS resolving to IPv6 but lacks IPv6 route | Switch to connection pooler URL (Session mode); ensure username format includes project ref: `hermes_readonly_user.rnunfmfspggcotgjavch` |
| `psql $DATABASE_URL_PROD_READONLY` INSERT succeeds instead of failing with permission denied | UUID type error confused for a permission pass (false alarm) — see note | Test with `gen_random_uuid()`: `psql ... -c "INSERT INTO messages (id) VALUES (gen_random_uuid());"` — this will correctly show `permission denied` |
| `vercel link` writes `repo.json` not `project.json` | Newer Vercel CLI (v54+) uses `repo.json`; both are equivalent | Normal behavior; `.vercel/repo.json` contains the project + org IDs |
| Hermes reports wrong working directory | Answering from Python process context, not shell | Ask Hermes to `run pwd in your terminal` — the shell CWD is what matters; `terminal.cwd` in `config.yaml` controls it |
| ST4: framework §3.2 execution-layer approval never fires | Hermes refuses at LLM-reasoning layer before attempting tool execution — pre-execution refusal is the first line of defense | LLM-level refusal is confirmed working. §3.2 tests require a command Hermes will attempt to execute (e.g. a non-obviously-destructive op); defer to a dedicated test when one arises naturally |
| `hermes_readonly` role missing SELECT on a new table | `GRANT SELECT ON ALL TABLES` covers tables that existed at grant time; new tables require re-grant | Run in Supabase SQL editor: `GRANT SELECT ON ALL TABLES IN SCHEMA public TO hermes_readonly;` |

---

## Event log wiring — Spec 4b (2026-06-10)

**What shipped:** `translation_events` write wired into `api/v1/translate.js` (Vercel/prod path) and `server/index.js` (local Express path) via `server/lib/events.js`. `agent_events` wired via Python hook at `~/.hermes/hooks/agent-event-logger/`. Key fix: switched from `pg.Pool` to `pg.Client` (connect → query → end) and added `await` on the Vercel path — Vercel freezes the process at `res.json()`, so fire-and-forget writes never complete.

**Commits:** `8cfa0a2` (initial wiring), `a4131b2` (Pool→Client fix), `2dd38df` (await fix)

### Verification (staging, confirmed 2026-06-10)

1. Open the staging Preview URL
2. Send a message in any non-English language
3. Run: `SELECT id, target_language, model_used, event_source, latency_ms, created_at FROM translation_events ORDER BY created_at DESC LIMIT 1;`
4. Expect: row with `event_source = 'chat_app'`, populated `latency_ms`, `input_tokens`, `output_tokens`

### Known gaps

| Gap | Severity | Fix when |
|---|---|---|
| `hermes_writer_user` role on staging has a JS-client permission quirk — staging Vercel Preview uses `postgres` superuser URL as workaround | Low (staging only) | Investigate Supabase role trust config; or accept superuser on staging |
| `agent_events` staging end-to-end not yet verified via Vercel (only VPS hook smoke-tested) | Low | Next agent task after gateway restart |
| `was_cached` hardcoded `false` — no cache check exists yet | Known | Wire when `message_translations` cache is added |
| Vercel Production env var `DATABASE_URL_PROD_WRITER` must use port 6543 (transaction pooler) at prod deploy time | **Flag** | Before running `vercel --prod` |

### Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `info` log on translate, no row in DB | `await` missing on event write (fire-and-forget killed by serverless) | Add `await` before `logTranslationEvent()` in the handler |
| `[events] INSERT failed: Connection terminated due to connection timeout` | `pg.Pool` used instead of `pg.Client` — pool never initialises in short-lived function | Switch to `Client` (connect → query → end) pattern |
| `[events] INSERT failed: password authentication failed` | Special chars in password not URL-encoded in connection string | URL-encode password with `urllib.parse.quote(password, safe='')` |
| `[events] INSERT failed: permission denied` via JS but psql works | Supabase role trust quirk — restricted role may need direct `GRANT` to user, not just via role membership | `GRANT INSERT ON table TO user_name` directly; or use superuser for staging |
| No `[events]` log line at all | `DATABASE_URL_PROD_WRITER` not set in Vercel env | Add env var + redeploy |

---

---

## Phase 2 — Step 1: Identity Foundation (2026-06-09)

**What this step does:** Migration 007 adds `profiles`, `account_identifiers`, `account_settings`,
the `auth.users` trigger, RLS on all three new tables, and the `dm_initiation_policy` column on
`tenants`. The `auth.users` INSERT trigger atomically creates a pending profile + username + email
identifier + settings row on every new signup.

**Gate (must pass before Step 2 starts):**
- [x] Migration 007 replays clean on empty staging *(confirmed 2026-06-10)*
- [~] All 8 schema checks below pass — 1–6 + 8 green; **A#7 (RLS policies exist) still to run**
- [x] Trigger smoke test: a test user created via Auth dashboard produces correct rows *(confirmed 2026-06-10 — pending profile `user_eb4c08ec`, both identifiers active, settings row tenant-scoped)*

> **Numbering note:** the schema checks in section A are numbered 1–8. Migration 007's *embedded*
> verification comments use a different order (007's #7 is the trigger smoke test, #8 is the
> column-write guard). When in doubt, **this doc's numbering is authoritative.** The one check
> not embedded in 007 at all is **A#7 — RLS policies exist** (the `pg_policies` query); run it
> explicitly. RLS being *enabled* (check 6) is not the same as the *policies existing* (check 7):
> with RLS on and no policies, deny-by-default locks everything — passes silently here, breaks in
> Step 2/3.

---

### A. Schema verification (run in staging SQL editor after 007)

```sql
-- 1. New tables present
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
-- Expect: profiles, account_identifiers, account_settings now in list

-- 2. dm_initiation_policy column on tenants
SELECT id, name, dm_initiation_policy FROM public.tenants;
-- Expect: 1 row, dm_initiation_policy = {}

-- 3. auth_tenant_id() function exists
SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public' AND routine_name = 'auth_tenant_id';
-- Expect: 1 row

-- 4. Trigger exists on auth.users
SELECT trigger_name FROM information_schema.triggers
WHERE event_object_schema = 'auth'
  AND event_object_table  = 'users'
  AND trigger_name        = 'on_auth_user_created';
-- Expect: 1 row

-- 5. Reserved words seeded
SELECT count(*) FROM public.account_identifiers WHERE status = 'reserved';
-- Expect: 27

-- 6. RLS enabled on new tables
SELECT relname, relrowsecurity FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relname IN ('profiles', 'account_identifiers', 'account_settings')
  AND relkind = 'r'
ORDER BY relname;
-- Expect: relrowsecurity = true for all three

-- 7. RLS policies exist
SELECT tablename, policyname, cmd FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('profiles', 'account_identifiers', 'account_settings')
ORDER BY tablename, policyname;
-- Expect:
--   account_identifiers | account_identifiers_select_own  | SELECT
--   account_settings    | account_settings_select_own     | SELECT
--   account_settings    | account_settings_update_own     | UPDATE
--   profiles            | profiles_select_same_tenant     | SELECT
--   profiles            | profiles_update_own             | UPDATE

-- 8. [Opus-Fix #2] Column-write restriction on profiles (privilege escalation guard)
SELECT grantee, privilege_type, column_name
FROM information_schema.column_privileges
WHERE table_schema = 'public'
  AND table_name   = 'profiles'
  AND grantee      = 'authenticated'
  AND privilege_type = 'UPDATE';
-- Expect: exactly ONE row → column_name = 'display_name'
-- If you see rows for status, username, is_verified, etc., the REVOKE/GRANT block
-- did not run correctly — re-run section 3 of migration 007.
```

---

### B. Trigger smoke test

1. In the **staging** Supabase dashboard → Authentication → Users → **Add user**
   - Enter any email (e.g. `test@example.com`) and any password
   - Click "Create user"

2. Verify in SQL editor:

```sql
-- Profile row created with pending status
SELECT id, tenant_id, status, username, username_source, display_name
FROM public.profiles;
-- Expect: 1 row
--   status = 'pending'
--   username starts with 'user_' followed by 8 hex chars
--   username_source = 'system_generated'
--   display_name = '' (empty, set at onboarding)

-- Store the profile id for next queries
-- (replace <profile_id> below with the id from the row above)

-- Two account_identifiers rows created
SELECT type, value, status
FROM public.account_identifiers
WHERE account_id = '<profile_id>';
-- Expect: 2 rows
--   ('email',    'test@example.com', 'active')
--   ('username', 'user_xxxxxxxx',    'active')

-- account_settings row created with defaults
SELECT discoverable_by_email, discoverable_by_username, allow_dms_from
FROM public.account_settings
WHERE account_id = '<profile_id>';
-- Expect: (true, true, 'contacts')
```

---

### C. Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `ERROR: function gen_random_bytes(integer) does not exist` | pgcrypto not installed | `CREATE EXTENSION IF NOT EXISTS pgcrypto;` then re-run migration |
| `ERROR: relation "auth.users" does not exist` | Running against a non-Supabase Postgres | Supabase only — the auth schema is managed by Supabase |
| `ERROR: permission denied for table auth.users` | Not running as postgres/superuser | Use the Supabase SQL editor (runs as postgres) |
| No trigger row in query 4 | `CREATE OR REPLACE TRIGGER` failed silently | Check for errors in the migration output; re-run the trigger block |
| Profile not created after Add User | Trigger exists but function has a bug | Check Supabase logs (Auth logs + DB logs) for the exception message |
| `unique_violation` on profiles_unique_username | Username collision (astronomically unlikely) | Trigger retries 10x; if this persists, inspect the reserved-word table |
| `accounts_identifiers_unique_value` violation | Email already registered | Expected: Supabase Auth also enforces unique email; trigger error means the auth.users INSERT also rolls back |

---

## Phase 2 — Step 2: Auth + Onboarding (migration 008 + App.jsx rewrite)

**What this step does:** Migration 008 is the coordinated breaking cutover — drops `user_profiles`,
promotes `user_id` from text→uuid in `user_linguistic_profiles` and `user_profile_events`, alters
`messages.sender_id` from text→uuid, enables RLS on `messages`, `message_translations`, `ulp`, and
`upe`, and creates the `complete_onboarding()` SECURITY DEFINER RPC. App.jsx is rewritten with a
magic-link auth flow and onboarding screen.

**Gate (must pass before Step 3 starts):**
- [ ] Migration 008 replays clean on staging
- [ ] All schema checks below pass
- [ ] Full signup → onboard → active flow verified for two test users

---

### A. Schema verification (run in staging SQL editor after 008)

```sql
-- 1. user_profiles is gone
SELECT tablename FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'user_profiles';
-- Expect: 0 rows

-- 2. user_linguistic_profiles.user_id is now uuid
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'user_linguistic_profiles'
  AND column_name = 'user_id';
-- Expect: data_type = 'uuid'

-- 3. user_profile_events.user_id is now uuid
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'user_profile_events'
  AND column_name = 'user_id';
-- Expect: data_type = 'uuid'

-- 4. messages.sender_id is now uuid
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'messages'
  AND column_name = 'sender_id';
-- Expect: data_type = 'uuid'

-- 4b. FK constraint exists on messages.sender_id
SELECT constraint_name FROM information_schema.table_constraints
WHERE table_schema = 'public' AND table_name = 'messages'
  AND constraint_type = 'FOREIGN KEY';
-- Expect: messages_sender_id_fk present

-- 5. RLS enabled on messages and message_translations
SELECT relname, relrowsecurity FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relname IN ('messages', 'message_translations',
                  'user_linguistic_profiles', 'user_profile_events')
  AND relkind = 'r'
ORDER BY relname;
-- Expect: relrowsecurity = true for all four

-- 6. RLS policies exist on messages and message_translations
SELECT tablename, policyname, cmd FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('messages', 'message_translations',
                    'user_linguistic_profiles', 'user_profile_events')
ORDER BY tablename, policyname;
-- Expect policies:
--   messages                | messages_insert_own          | INSERT
--   messages                | messages_select_same_tenant  | SELECT
--   message_translations    | mt_insert_same_tenant        | INSERT
--   message_translations    | mt_select_same_tenant        | SELECT
--   message_translations    | mt_update_same_tenant        | UPDATE
--   user_linguistic_profiles | ulp_select_same_tenant      | SELECT
--   user_linguistic_profiles | ulp_update_own              | UPDATE
--   user_profile_events     | upe_insert_own               | INSERT
--   user_profile_events     | upe_select_own               | SELECT

-- 7. complete_onboarding() function exists
SELECT routine_name, security_type FROM information_schema.routines
WHERE routine_schema = 'public' AND routine_name = 'complete_onboarding';
-- Expect: 1 row, security_type = 'DEFINER'

-- 7b. authenticated role has EXECUTE on complete_onboarding
SELECT grantee, privilege_type FROM information_schema.routine_privileges
WHERE routine_schema = 'public' AND routine_name = 'complete_onboarding'
  AND grantee = 'authenticated';
-- Expect: 1 row, privilege_type = 'EXECUTE'
```

---

### B. End-to-end signup → onboard → active flow

Run this manually via a real browser pointing at the Vercel Preview (staging).

1. Open the preview URL in a fresh browser (or private/incognito window).
2. **Sign-in screen:** enter a test email address you control. Click "Send sign-in link."
   - Verify: screen transitions to "Check your email" message.
3. Check your email inbox. Click the magic link.
   - Verify: browser redirects back to the preview URL.
   - Verify in staging SQL editor: profile row exists with `status = 'pending'`, no display_name yet.
4. **Onboarding screen:** enter a display name (e.g. "Test User A") and select a language. Click "Continue."
   - Verify: spinner shows briefly; screen transitions to the chat view.
   - Verify in staging SQL editor:
     ```sql
     SELECT id, display_name, status, onboarding_completed_at FROM public.profiles
     WHERE status = 'active';
     -- Expect: 1 active row, display_name = 'Test User A', onboarding_completed_at not null

     SELECT user_id, preferred_language FROM public.user_linguistic_profiles;
     -- Expect: 1 row, preferred_language matches what you selected
     ```
5. **Chat view:** send a test message. Verify it appears in the messages table with `sender_id = <uuid>` (not a text string).
   ```sql
   SELECT sender_id, original_text, source_language FROM public.messages;
   -- Expect: sender_id is a uuid (not a text username string)
   ```
6. Repeat steps 1–4 with a second test email. Verify two active profiles exist.
7. **Sign out:** click "Sign out" in the chat header. Verify screen returns to the sign-in form.

---

### C. Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| Magic link redirects to wrong URL | Supabase "Site URL" or "Redirect URLs" misconfigured | Dashboard → Auth → URL Configuration: add the Preview URL to allowed list |
| Onboarding screen shows but "Continue" errors | `complete_onboarding()` RPC not found or not granted | Confirm schema check 7 + 7b pass; re-run migration 008 section 7 |
| `permission denied` on `complete_onboarding` | GRANT EXECUTE missing | Run: `GRANT EXECUTE ON FUNCTION public.complete_onboarding(text, text) TO authenticated;` |
| Chat loads but no messages visible | RLS on messages blocking SELECT | Check policy `messages_select_same_tenant` exists (schema check 6); confirm auth_tenant_id() returns non-null |
| Message send fails (PostgREST 403) | RLS INSERT policy failing | WITH CHECK requires `sender_id = auth.uid()` AND `tenant_id = auth_tenant_id()`. Confirm both are set correctly in App.jsx sendMessage() |
| Profile not flipping to 'active' after onboarding | complete_onboarding raised exception | Check browser console for the Supabase error; likely a validation failure (empty name, name > 50 chars) |
| Page shows blank / loading forever | getSession() or loadProfile() error | Check browser console; likely a Supabase URL/key mismatch in Vercel Preview env vars |

---

## Phase 2 — Step 3: RLS Adversarial Gate (2026-06-10)

**Status: ✅ PASSED on staging 2026-06-10 — 21/21 assertions GREEN.** Confirmed cross-user read
denial (own-only tables), intended same-tenant reads, self-escalation denial (`is_verified`/
`username`/`status` → "permission denied for table profiles"), allowed self-write (`display_name`),
cross-user write denial (row-scope + spoofed-sender INSERT → RLS violation), cross-tenant isolation
(user C in tenant 2 ↔ tenant-1 data, both directions), and defense-in-depth (A's profile unchanged
after escalation attempts: `is_verified=false`, `status=active`, `username` still `user_…`). Gate is
a hard stop and it cleared — **Step 4 (discovery) is unblocked.** Re-run after any migration that
adds/edits RLS policies or grants on Phase 2 tables.

**What this step does:** With identity + auth in place, proves RLS actually isolates users and
tenants under adversarial conditions. **Hard stop** — do not build discovery/social (Step 4+)
on an unverified base.

**How it's verified:** A checked-in, re-runnable harness — `scripts/rls-adversarial-test.mjs` —
not a one-off console snippet. It signs in as real users (own JWTs), runs a PASS/FAIL assertion
matrix, and exits 0 (gate GREEN) or 1 (HARD STOP). Service-role is used ONLY for one-time
fixture setup, never for the assertions (it bypasses RLS, so asserting with it proves nothing).

**Gate:** `node scripts/rls-adversarial-test.mjs` exits 0 with every category PASS, on staging.

### Why the assertion *shape* matters (don't loosen these)
RLS denial does not surface uniformly. Each assertion checks a specific shape, and a test that
expected an error but got an empty result (or vice-versa) is a real failure, not a wording nit:

- Blocked **SELECT** → row filtered out → **empty array, NO error** (HTTP 200).
- Blocked **UPDATE via row policy** (USING) → **0 rows changed, NO error**.
- Blocked **UPDATE via column GRANT** (e.g. `is_verified`) → **ERROR** (permission denied).
- Blocked **INSERT via WITH CHECK** (e.g. spoofed `sender_id`) → **ERROR** (RLS violation).

### What is a leak vs. what is same-tenant-by-design (important)
Several SELECT policies are intentionally same-tenant-readable — reading another user's row
there is **not** a leak, it's the product working (a chat app shows you who you're talking to):

- **Same-tenant by design (reads across users expected):** `profiles`, `messages`,
  `user_linguistic_profiles`, `message_translations`.
- **Own-only (the genuine cross-user leak surface):** `account_identifiers` (emails live here),
  `account_settings`, `user_profile_events`.

So the read test does NOT expect `profiles` to return one row — it expects A to see all
tenant-1 profiles (allowed) but **zero** of B's `account_identifiers`/`account_settings`.

### Fixture (set up idempotently by the script, service-role)
- Users **A** and **B**: existing staging users, tenant 1 (from the Step 2 / inference smoke test).
- A throwaway **tenant 2** (`00000000-0000-0000-0000-000000000002`) and **user C**, re-pointed
  into tenant 2, so cross-*tenant* isolation is actually exercisable (a single-tenant DB can't).
- The script sets A/B/C passwords + confirms their emails via the admin API, and cleans up the
  `RLS-TEST%` messages it inserts.

### Assertion categories (all must PASS)
1. **Cross-user reads of own-only tables** — A reads B's `account_identifiers` / `account_settings`
   / `user_profile_events` → empty.
2. **Intended same-tenant reads** — A reads `profiles` / `user_linguistic_profiles` → ≥1 row
   (confirms we didn't over-lock and break the product).
3. **Self-write privilege escalation** — A PATCHes own `is_verified` / `status` / `username` →
   **error** (migration 007 OPUS-FIX #2 column grant).
4. **Allowed self-write** — A PATCHes own `display_name` → succeeds (positive control).
5. **Cross-user writes** — A edits B's profile (→ 0 rows) and inserts a message spoofing B as
   sender (→ error); A inserts an own message (→ succeeds, positive control).
6. **Cross-tenant isolation** — C (tenant 2) reads tenant-1 `profiles`/`ulp`/`messages` → empty;
   A cannot read C; C can read own row.
7. **Defense-in-depth** — re-read A's profile as service role; confirm `is_verified=false`,
   `status='active'`, `username` still starts `user_` (the escalation attempts truly didn't land).

### How to run (Isaac, on staging)
1. `cp .env.rls-test.example .env.rls-test` and fill it in (staging URL + anon + service_role
   keys; A/B/C emails; a throwaway password). `.env.rls-test` is gitignored.
2. **Prerequisite:** enable the **Email/Password** auth provider on `translationapp1-staging`
   (Supabase → Authentication → Providers). `signInWithPassword` fails without it.
3. Set `RLS_TEST_CONFIRM_STAGING=yes` in `.env.rls-test` (the script refuses to run otherwise —
   it mutates the DB; never point it at prod).
4. `node scripts/rls-adversarial-test.mjs` from the `V1/` root.
5. Exit 0 + all PASS = gate GREEN, Step 4 unblocked. Any FAIL = hard stop; fix RLS, re-run.

**Why a checked-in script (not a console snippet):** it's deterministic, re-runnable after any
future migration that touches these tables, and self-documenting. RLS regressions are silent
(a too-broad policy just quietly returns more rows) — this is the tripwire.

---

## Phase 2 — Step 4: Discovery + username change (migration 010) (2026-06-10)

**Status: ✅ PASSED on staging 2026-06-10 — 22/22 assertions GREEN** via
`scripts/discovery-gate-test.mjs`, run against `translationapp1-staging` after migration 010 was
applied in the staging SQL editor. Confirmed: email exact-match add returns a handle-minimized
result (`account_id`/`display_name`/`username` only — no email/phone), email is non-enumerable
(partial address returns nothing; UPPERCASE still matches canonically), `discoverable_by_email`
/`discoverable_by_username` opt-outs hide the target, username autocomplete works at ≥3 chars with
`%` treated as a literal (no wildcard enumeration), self is excluded, `change_username` rejects
reserved/taken/too-short/bad-charset and accepts a free first change (old handle retired not
deleted, new one active, `username_source='user_set'`, clock stamped), the 1/365-day cadence blocks
a second change, and cross-tenant isolation holds (user C in tenant 2 finds neither A's email nor
username). **Step 4 backend is complete on staging; prod replay of 010 is still pending** (prod is
pre-007 with no RLS — 010 reaches prod only on a deliberate push-to-main cutover).

**What this step does:** Migration 010 is **additive only** (no table/column changes) — one partial
prefix index on `account_identifiers(tenant_id, value)` for username autocomplete, plus three
SECURITY DEFINER RPCs that re-impose the discovery + policy rules in code (because
`account_identifiers` SELECT is own-rows-only, discovery cannot be a client query):
- `find_account_by_email(text)` — canonical exact match (`lower(btrim())`), honors
  `discoverable_by_email`, excludes self, active-only, tenant-scoped, returns the public handle.
- `search_accounts_by_username(text, int)` — ≥3-char prefix, LIKE metacharacters escaped, capped at
  20, honors `discoverable_by_username`, excludes self, active-only.
- `change_username(text)` — auth guard, `[a-z0-9_]` charset + 3–20 length, 365-day cadence (first
  system→user change free), reserved/non-reuse check against any existing row, atomic retire-old +
  insert-new swap. See `decisions.md` 2026-06-10 "Phase 2 Step 4 discovery".

**Scope note:** Step 4 is **search-only**. A discovery result is look-up data; the contact *add*
(writing a `relationships` row) is Step 5. So the discovery-*search* UI is best bundled with Step 5
when an "Add" can actually persist; `change_username` is self-contained and wireable now (App.jsx /
settings) ahead of that.

**Gate:** `node scripts/discovery-gate-test.mjs` exits 0 with every category PASS, on staging.

### Why the assertion shapes matter (don't loosen these)
The discovery RPCs bypass RLS, so each one re-checks a rule the database would otherwise enforce.
The gate asserts the *specific* shape of each guard — an over-broad RPC silently returns more rows,
the same failure mode as a too-broad RLS policy:
- Discovery of an opted-out / cross-tenant / self target → **empty result, NO error**.
- `change_username` policy rejection (reserved/taken/short/bad-charset/cadence) → **error** with a
  specific message; the profile row must be **unchanged** after a rejected attempt.
- A `%` in a username prefix must match **literally** (escaped), not act as a wildcard — the
  injection guard.

### Fixture (set up idempotently by the script, service-role)
- Reuses the Step 3 `.env.rls-test` and users A/B (tenant 1) + user C (tenant 2).
- Each run **resets A's username state** (deletes A's username identifier rows, restores the
  `system_generated` handle, nulls the change clock) so the cadence guard doesn't block re-runs.
- Sets A/B active + discoverable; points C into tenant 2 for the cross-tenant checks.

### Assertion categories (all must PASS)
1. **Email add (allow)** — A finds B by exact email; result is handle-minimized; carries no other
   identifier.
2. **Email enumeration (deny)** — partial email returns nothing; UPPERCASE still matches (canonical).
3. **`discoverable_by_email`** — B opted out → not found by email.
4. **Username autocomplete** — prefix match works; sub-3-char returns nothing; `%` is literal.
5. **`discoverable_by_username`** — B opted out → absent from autocomplete.
6. **Self excluded** — A never surfaces itself.
7. **`change_username` (deny)** — reserved (`Admin`, case-folded), taken, too-short, bad-charset all
   rejected.
8. **`change_username` (allow)** — A claims a free first username; profile updated
   (username/source/clock); old handle retired (not deleted); new handle active.
9. **Cadence (deny)** — a second change within 365 days is rejected.
10. **Cross-tenant (deny)** — C cannot find A by email or username.

### How to run (Isaac, on staging)
1. Apply `migrations/010_phase2_step4_discovery.sql` in the staging SQL editor (idempotent;
   additive — safe to replay).
2. Same `.env.rls-test` as the Step 3 gate (staging URL + anon + service_role; A/B/C emails;
   throwaway password), `RLS_TEST_CONFIRM_STAGING=yes` (the script refuses to run otherwise — it
   mutates the DB; never point it at prod).
3. `node scripts/discovery-gate-test.mjs` from the `V1/` root.
4. Exit 0 + all PASS = gate GREEN. Re-run after any migration that adds/edits these RPCs, the
   prefix index, or the discovery/identity RLS policies they sit behind.

### Before prod
- [ ] Replay migration 010 against prod **as part of the Phase 2 prod cutover** (prod is pre-007
  today — 010 depends on the 007/008/009 identity tables existing first). Then re-run the gate
  pointed at a prod-equivalent only if a non-prod gate target exists; never point the mutating gate
  at production.

### Known failure modes and how to diagnose

| Symptom | Likely cause | Fix |
|---|---|---|
| `ERROR: function find_account_by_email(text) does not exist` | Migration 010 not applied on this project | Run `010_phase2_step4_discovery.sql` in the staging SQL editor |
| Discovery returns a target that opted out | RPC dropped the `discoverable_by_*` predicate | Compare the RPC body to migration 010; the `account_settings` join + flag check must be present |
| `%`/`_` in a prefix returns extra rows | LIKE metacharacters not escaped | Confirm the `replace(... '\\' ... '%' ... '_')` + `ESCAPE '\'` in `search_accounts_by_username` |
| `change_username` succeeds when it should reject (cadence) | Gate fixture didn't reset, or cadence check uses wrong column | Confirm the script's service-role reset ran; check `username_source='user_set'` + `username_last_changed_at` logic |
| Cross-tenant target leaks | RPC missing the `auth_tenant_id()` scope | Confirm every RPC filters `p.tenant_id = auth_tenant_id()` |

---

## Phase 2 — Step 5: Social graph + safety primitives (migration 011) (2026-06-10)

**Status: ✅ PASSED on staging 2026-06-10 — 40/40 assertions GREEN** via
`scripts/social-graph-gate-test.mjs`, run against `translationapp1-staging` after migration 011 was
applied in the staging SQL editor. The Step 4 discovery gate **re-passed 22/22** in the same session,
confirming the block-filter amend to the discovery RPCs didn't regress Step 4. Confirmed: mutual-accept
happy path (B sees the incoming pending row via RLS; re-request rejected; exactly one canonical row);
reverse-request glare collapses to the same accepted row (no dup); blocks gate `request_contact` +
`respond_to_contact` both directions, blocker sees the block row / blocked party doesn't, discovery hides
both parties symmetrically (email + username), unblock restores; report = atomic report + active block;
invites auto-accept (`via=invite_link`, `initiator=A`), with redeem-own / re-redeem / revoked / expired /
`conversation`-kind all rejected; cross-tenant requests + redemptions denied (opaque not-found); RPC-only
writes enforced (direct client INSERT into `relationships` → RLS violation; `email_hash_abuse` → permission
denied). **This gate is a hard stop for Step 6 — and it cleared.** **Prod replay of 011 still pending the
Phase 2 cutover** (depends on 007–010). Re-run after any migration that adds/edits these tables, RPCs, or
the discovery RPCs they amend.

**What this step does:** Migration 011 adds the social graph + safety substrate, all with RLS from
day one and SECURITY DEFINER RPCs as the **sole** write path (RLS is SELECT-only; direct writes are
REVOKE'd from `authenticated`):
- `relationships` — the contact graph as a **canonical ordered pair** (`account_lo < account_hi`
  + `initiator_id`, one row per unordered pair, `UNIQUE(tenant_id, account_lo, account_hi)`). This
  representation makes the simultaneous-add "glare race" structurally impossible — both directions
  collapse to the same row.
- `blocks` — modeled as an **override layer**: a block never mutates the `relationships` row; it's a
  separate symmetric hide checked by `active_block_exists()` (bidirectional) on every initiation path
  and both discovery RPCs. `unblocked_at IS NULL` = active; partial unique index enforces one active
  block per ordered pair.
- `reports` — `report_account()` is **atomic report + block** (inserts the report and the block in
  one call, `ON CONFLICT DO NOTHING` on the block).
- `invites` + `invite_redemptions` — base64url-token deep-link primitive; `redeem_invite()`
  **auto-accepts** the contact (`state='accepted'`, `via='invite_link'`, `initiator=created_by`).
- `email_hash_abuse` — abandoned-signup spam monitoring; versioned **HMAC-SHA256** (`key_version`
  smallint), pepper computed in the Node job layer and **never stored in the DB**; RLS-enabled with
  **no policy** + `REVOKE ALL FROM anon, authenticated` = service-role-only.

Migration 011 also **amends** the Step 4 discovery RPCs (`find_account_by_email`,
`search_accounts_by_username`) to add `AND NOT public.active_block_exists(auth.uid(), p.id)` — a
behavior change, so **the Step 4 discovery gate must be re-run after 011** (a blocked account must
disappear from discovery).

**How it's verified:** A checked-in, re-runnable harness — `scripts/social-graph-gate-test.mjs` —
mirroring the Step 3/4 gates. It signs in as real authenticated users (own JWTs, anon key); the
service-role key is used ONLY for fixture setup and the FK-safe `resetGraph()` teardown, never for
the assertions (it bypasses RLS, so asserting with it proves nothing). Exits 0 (gate GREEN) or 1
(HARD STOP).

**Gate:** `node scripts/social-graph-gate-test.mjs` exits 0 with every phase PASS, on staging.

### Why the assertion shapes matter (don't loosen these)
The write path is RPC-only, so each assertion checks a specific shape:
- A successful contact/accept/block/report/redeem → the RPC returns and the **canonical row** lands
  in exactly the expected state; "exactly one row per pair" is asserted explicitly (the glare-race
  guard).
- A rejected RPC (re-request own pending, accept a non-existent request, re-redeem, redeem own,
  redeem revoked/expired/wrong-kind) → **error** with a specific message.
- A blocked target → **empty result** from both discovery RPCs (NO error) — same shape as an RLS
  SELECT denial.
- A direct client write to `relationships` or `email_hash_abuse` (bypassing the RPCs) → **error**
  (RLS / REVOKE denial) — the "RPCs are the sole write path" guarantee.

### Fixture (set up idempotently by the script, service-role)
- Reuses the Step 3/4 `.env.rls-test` and users **A**/**B** (tenant 1) + **user C** (tenant 2).
- `resetGraph()` clears `invite_redemptions → invites → reports → blocks → relationships` in FK-safe
  order before/after each run so re-runs are deterministic.
- A/B set active + discoverable in tenant 1; C re-pointed into tenant 2 for the cross-tenant phase.

### Assertion phases (all must PASS)
1. **Mutual-accept happy path** — A `request_contact(B)` → `pending`; B sees the incoming pending row
   via RLS; B `respond_to_contact(A, accept)` → `accepted`; **exactly one** canonical row exists.
2. **Reverse-request glare** — A requests B, then B requests A before responding → collapses to the
   **same** row, auto-accepted; still **exactly one** row (the canonical-pair guarantee).
3. **Blocks** — a block gates both `request_contact` and `respond_to_contact` in both directions; the
   blocker sees the block row (RLS), the blocked party does not; discovery hides the target
   **symmetrically** (both RPCs, both directions); `unblock_account` restores discoverability +
   initiation.
4. **Report = atomic report + block** — `report_account(B, reason)` creates a report **and** an
   active block in one call; a second identical report does not duplicate the block.
5. **Invites** — `create_invite` returns a base64url token; `redeem_invite` auto-accepts the contact
   (`via='invite_link'`, `initiator=A`); re-redeem → error; redeem-own → error; revoked / expired /
   `conversation`-kind invite → rejected. *(Full `max_uses` exhaustion is NOT exercised — see the
   coverage gap below.)*
6. **Cross-tenant isolation** — C (tenant 2) cannot request/redeem against tenant-1 accounts; tenant
   boundary holds on every social RPC.
7. **RLS hardening** — a direct client INSERT into `relationships` is denied (writes are RPC-only);
   a direct client read/write of `email_hash_abuse` is denied (service-role-only).

### Known coverage gap (don't mistake for a pass)
- **`max_uses` exhaustion is validated by code inspection only, not behaviorally.** With two
  tenant-1 users (A inviter, B redeemer), the gate can't drive a redemption counter past 1, so the
  `use_count >= max_uses` branch in `redeem_invite()` isn't exercised. Tracked in
  `parking-lot.md` "Invite max-uses exhaustion gate coverage gap"; cheapest fix is a third tenant-1
  fixture user.

### How to run (Isaac, on staging)
1. Apply `migrations/011_phase2_step5_social_graph.sql` in the staging SQL editor (idempotent DDL —
   `CREATE … IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP POLICY IF EXISTS`; safe to replay).
2. Same `.env.rls-test` as the Step 3/4 gates (staging URL + anon + service_role; A/B/C emails;
   throwaway password), `RLS_TEST_CONFIRM_STAGING=yes` (the script refuses to run otherwise — it
   mutates the DB; **never point it at prod**).
3. `node scripts/social-graph-gate-test.mjs` from the `V1/` root.
4. **Re-run the Step 4 discovery gate** (`node scripts/discovery-gate-test.mjs`) after 011 — the
   block-filter amend to the discovery RPCs is a behavior change; confirm a blocked account
   disappears from discovery and an unblocked one reappears.
5. Exit 0 + all PASS on both = gate GREEN, Step 6 unblocked. Any FAIL = hard stop; fix, re-run.

### Before prod
- [ ] Replay migration 011 against prod **as part of the Phase 2 prod cutover** (depends on
  007/008/009/010 existing first — prod is pre-007 today). Re-run the gate only against a
  non-prod target; **never point the mutating gate at production.**
- [ ] Wire the `email_hash_abuse` HMAC pepper into the Step 6 abandoned-signup job's environment
  (job layer, never the DB); confirm `key_version` is set and the pepper is recoverable/rotatable
  per the decisions.md 2026-06-10 entry.

### Known failure modes and how to diagnose

| Symptom | Likely cause | Fix |
|---|---|---|
| `ERROR: function request_contact(...) does not exist` | Migration 011 not applied on this project | Run `011_phase2_step5_social_graph.sql` in the staging SQL editor |
| Two rows for one pair after a glare test | `relationships` missing the `UNIQUE(tenant_id, account_lo, account_hi)` or the RPC isn't normalizing `lo`/`hi` | Confirm the unique constraint and the `account_lo < account_hi` canonicalization in `request_contact()` |
| Blocked account still appears in discovery | The 011 amend to the discovery RPCs didn't apply | Confirm `find_account_by_email` / `search_accounts_by_username` carry `AND NOT public.active_block_exists(auth.uid(), p.id)`; re-apply 011 |
| Direct client INSERT into `relationships` succeeds | The REVOKE/SELECT-only RLS didn't apply | Confirm direct writes are REVOKE'd from `authenticated` and only SELECT policies exist; the RPCs are the sole write path |
| `report_account` creates a report but no block (or vice-versa) | The atomic report+block isn't in one transaction | Confirm both inserts are in the one RPC body with `ON CONFLICT DO NOTHING` on the block |
| `redeem_invite` lets the creator redeem their own invite | Missing the redeem-own guard | Confirm the `created_by = auth.uid()` rejection branch in `redeem_invite()` |
| Client can read `email_hash_abuse` | RLS enabled but a policy was added, or REVOKE missing | Confirm RLS is on with **no** policy + `REVOKE ALL ON public.email_hash_abuse FROM anon, authenticated` |

---

## Phase 2 — Step 6: Abandonment + abuse monitoring (migration 012) (2026-06-10)

**Status: ✅ PASSED on staging — 19/19 GREEN (2026-06-11).** Migration 012 applied on
`translationapp1-staging`; `scripts/abandonment-gate-test.mjs` exits 0 with all 19 assertions
passing (dry-run deletes nothing, live sweep deletes + cascades + releases the system username +
records the keyed HMAC, fresh/active controls untouched, repeat-record increments `abandon_count`,
anon EXECUTE denied on both helpers).

**Counter-bug fix (2026-06-11).** The first run was 18/19 — the lone failure was
`dry-run sweep deletes nothing — deleted=1`. Root cause: in `server/lib/abandonment.js` the
`summary.deleted += 1` and `summary.hashed += 1` increments sat *outside* their `if (!dryRun)`
guards, so a dry run skipped the real `deleteUser`/`record_abandoned_email_hash` calls (no data
touched — the DB-level "aged pending survives a dry run" and "no abuse row on a dry run" assertions
both PASSED) but still counted them. Fixed by moving both increments inside the `if (!dryRun)`
blocks; a dry run now honestly reports `deleted=0/hashed=0`, and `scanned` carries the would-sweep
count. The gate's summary line was also made unambiguous (`N/total PASSED — GREEN` /
`— N FAILED`) so a near-pass no longer reads as a total failure. No behavior change to live sweeps.

This step is the **last build step before the Phase 2 prod cutover** — the cutover lands after
Step 7, per the 2026-06-10 sequencing decision. **Prod replay of 012 is still pending that cutover.**

**What this step does:** A scheduled sweep reclaims abandoned pending accounts and records a privacy-
preserving abuse signal. Pieces:
- `migrations/012_phase2_step6_abandonment.sql` — **additive, functions only** (no tables; the
  `email_hash_abuse` table shipped in 011). Two `SECURITY DEFINER` helpers, **granted to
  `service_role` only** (REVOKE'd from `public`/`anon`/`authenticated`):
  - `list_abandoned_pending_accounts(interval default '30 days')` — returns `(account_id, tenant_id,
    canonical_email, username_source)` for `profiles` rows `status='pending'` and
    `created_at < now() - interval`. Encapsulates the "abandoned" definition.
  - `record_abandoned_email_hash(uuid, text, smallint default 1)` — atomic insert-or-increment into
    `email_hash_abuse` (`ON CONFLICT … DO UPDATE SET abandon_count = abandon_count + 1, last_seen =
    now()`); takes the hash as a hex string and `decode(...,'hex')`s it to bytea.
- `server/lib/abandonment.js` — `runAbandonmentSweep(config)`; identity/secret **injected via
  config** (not module env) so the cron handler and the gate share one code path. Per account:
  guard `username_source='system_generated'` (else skip + warn); compute
  `HMAC-SHA256(canonical_email, pepper)` and call `record_abandoned_email_hash` **before** the
  delete (record-then-delete); then `auth.admin.deleteUser(account_id)` — the FK cascade (007)
  removes the profile/identifiers/settings and **releases the username**. Returns
  `{scanned, deleted, hashed, skipped, errors, dryRun, maxAgeDays, keyVersion}`. Throws if no pepper
  unless `dryRun`.
- `api/v1/jobs/abandonment.js` — thin Vercel cron handler; **fails closed if `CRON_SECRET` unset**;
  requires `Authorization: Bearer $CRON_SECRET`; supports `?dryRun=1`.
- `vercel.json` — `crons: [{path:"/api/v1/jobs/abandonment", schedule:"0 8 * * *"}]` (daily 08:00 UTC).

**How it's verified:** `scripts/abandonment-gate-test.mjs` — a checked-in adversarial harness in the
Step 3/4/5 style. Service-role for fixtures only; `RLS_TEST_CONFIRM_STAGING=yes` interlock; namespaced
`abandon-gate-*` fixtures; FK-safe teardown that also removes the `email_hash_abuse` rows it created
this run. It imports the **same** `runAbandonmentSweep` the cron uses.

### Why the assertion shapes matter (don't loosen these)
- A dry run must delete **nothing** (the `dryRun` guard) — proves the cron's `?dryRun=1` is safe.
- The recorded hash must be a **keyed HMAC**, not a plain SHA-256 — the gate computes both and asserts
  the stored bytea equals the HMAC and **not** the bare digest. (A plain hash is dictionary-reversible
  over the email space; the whole point is the pepper.)
- Record-then-delete: the abuse row must exist **after** the account is gone — proves the signal
  survives the delete.
- Fresh / active accounts must be **untouched** — the sweep only takes `pending` older than the age.
- Anon/authenticated must be **denied EXECUTE** on both helpers — service-role-only.

### Fixture (set up idempotently by the script, service-role)
- Namespaced `abandon-gate-<runId>` emails so runs don't collide and teardown is exact.
- Creates: an **aged-pending** account (back-dated `created_at` > 30 days, `status='pending'`); a
  **fresh-pending** account (recent); an **active** account — the last two are the "must-not-touch"
  controls. A separate fixture verifies the dry-run path deletes nothing.
- Teardown deletes any surviving fixture users + the `email_hash_abuse` rows whose `first_seen >=`
  the run's start timestamp.

### Assertion phases (all must PASS)
1. **Dry run** — `runAbandonmentSweep({dryRun:true})` reports the aged account as scanned but deletes
   nothing; the account still exists afterward.
2. **Live sweep** — the aged-pending account is **fully gone** (auth user + cascade), its username is
   **released** (re-claimable), the abuse hash is recorded and equals the **keyed HMAC**; the
   fresh-pending and active controls are **untouched**; the dry-run fixture is now deleted.
3. **Repeat-record increments** — calling the sweep again on a same-email abandon increments
   `abandon_count` (no duplicate row) — the `ON CONFLICT` path.
4. **EXECUTE denied** — anon cannot call either helper.

### How to run (Isaac, on staging)
1. Apply `migrations/012_phase2_step6_abandonment.sql` in the staging SQL editor (idempotent
   `CREATE OR REPLACE`; additive — safe to replay).
2. Same `.env.rls-test` as the Step 3/4/5 gates, **plus** `ABANDONMENT_EMAIL_HASH_PEPPER` and
   `ABANDONMENT_EMAIL_HASH_KEY_VERSION=1` (already added to the gitignored `.env.rls-test`).
   `RLS_TEST_CONFIRM_STAGING=yes` (the script mutates the DB; **never point it at prod**).
3. `node scripts/abandonment-gate-test.mjs` from the `V1/` root.
4. Exit 0 + all PASS = gate GREEN. Then check the Step 6 roadmap items.

### Before prod
- [ ] Replay migration 012 against prod **as part of the Phase 2 prod cutover** (after Step 7;
  depends on 007–011).
- [ ] Set in **Vercel Preview + Production** env (not just `.env.rls-test`):
  `ABANDONMENT_EMAIL_HASH_PEPPER` (**same value** as `.env.rls-test`, so hashes stay consistent),
  `ABANDONMENT_EMAIL_HASH_KEY_VERSION=1`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`.
  The pepper must **never** be committed and **never** enter Postgres.
- [ ] Confirm the cron is registered (Vercel project → Cron Jobs shows `/api/v1/jobs/abandonment`
  daily 08:00 UTC) and that an unauthenticated hit returns 401 (the `CRON_SECRET` guard).

### Known failure modes and how to diagnose

| Symptom | Likely cause | Fix |
|---|---|---|
| `ERROR: function list_abandoned_pending_accounts(...) does not exist` | Migration 012 not applied on this project | Run `012_phase2_step6_abandonment.sql` in the staging SQL editor |
| Gate fails "hash is plain SHA-256, not HMAC" | Sweep computed an unkeyed digest, or the pepper wasn't passed | Confirm `createHmac('sha256', pepper)` in `server/lib/abandonment.js` and that `ABANDONMENT_EMAIL_HASH_PEPPER` is set |
| Sweep deletes fresh/active accounts | Selection RPC dropped the `status='pending'` or age predicate | Compare `list_abandoned_pending_accounts` body to migration 012 |
| Abuse row missing after delete | Record-then-delete order inverted, or RPC errored silently | Confirm `record_abandoned_email_hash` is called **before** `deleteUser` and its result is checked |
| `abandon_count` stuck at 1 on repeat | `ON CONFLICT … DO UPDATE` missing or wrong conflict target | Confirm the conflict target is `(tenant_id, email_hash, key_version)` and the `+ 1` update |
| Cron returns 500 / runs unauthenticated | `CRON_SECRET` unset (fails closed) or header mismatch | Set `CRON_SECRET` in Vercel; confirm Vercel sends `Authorization: Bearer $CRON_SECRET` |

---

## Phase 2 — Step 7: Data deletion / Right to Erasure (migration 013) (2026-06-11)

**Status: ✅ PASSED on staging — 37/37 GREEN (2026-06-11).** Migration 013 applied on
`translationapp1-staging`; `scripts/deletion-gate-test.mjs` exits 0 with all 37 assertions passing —
including the load-bearing ones: the planted **message survives with `sender_id=NULL`**, the **audit
row survives `completed` with `user_id` nulled** and a `deleted_fields` snapshot, and the abuse hash
is a **keyed HMAC, not a plain SHA-256**. (First run failed 5/15 because migration 013 hadn't been
applied yet — PostgREST returned "Could not find the function … in the schema cache" for every RPC;
applying 013 fixed all of them.) This is the **last build step before the Phase 2 prod cutover** —
the cutover lands now that this gate is green. **Prod replay of 013 is still pending that cutover.**

**What this step does:** Gives users a GDPR Art. 17 right-to-erasure path: a two-phase soft-delete →
30-day grace → daily cron hard-delete that de-identifies content rather than destroying it, and leaves
a surviving audit trail. Pieces:
- `migrations/013_phase2_step7_data_deletion.sql` — **additive**: one net-new table
  `data_deletion_requests` (RLS SELECT-own to `authenticated`; all writes RPC-only) + six functions.
  - User-facing (`SECURITY DEFINER`, granted `authenticated`): `request_account_deletion(interval
    default '30 days')` — flips `profiles.status='deactivated'` and enqueues a `pending` request,
    **idempotent** (returns the existing open request if one exists); `cancel_account_deletion()` —
    restores `active`, marks the request `cancelled`, returns boolean.
  - System (granted `service_role` only, for the Node sweep): `list_due_deletion_requests()` (STABLE;
    returns request/account/tenant/canonical_email for `pending` rows past `grace_until`),
    `claim_deletion_request(uuid)` (pending→processing via `GET DIAGNOSTICS ROW_COUNT`),
    `complete_deletion_request(uuid, jsonb)` (stamps `completed` + `completed_at` + `deleted_fields`).
  - `data_deletion_requests.user_id` FK → `profiles(id)` is **ON DELETE SET NULL** — load-bearing so
    the audit row survives the very erasure it records. Partial unique index enforces one open request
    per user; selection index on `(status, grace_until) WHERE status='pending'`.
- `server/lib/deletion.js` — `runDeletionSweep(config)`; identity/secret **injected via config** so
  the cron handler and gate share one code path. Per due request: `claim_deletion_request` →
  snapshot pre-delete counts → `record_abandoned_email_hash` (**same** keyed HMAC + shared pepper as
  abandonment, recorded **before** delete) → `auth.admin.deleteUser(account_id)` (FK cascade removes
  PII; `messages.sender_id` ON DELETE SET NULL keeps content de-identified) → `complete_deletion_request`.
  Returns `{scanned, deleted, hashed, skipped, errors, dryRun, keyVersion}`. Dry run only increments
  `scanned`.
- `api/v1/jobs/deletion.js` — thin Vercel cron handler; **fails closed if `CRON_SECRET` unset**;
  requires `Authorization: Bearer $CRON_SECRET`; supports `?dryRun=1`.
- `vercel.json` — second cron `{path:"/api/v1/jobs/deletion", schedule:"0 9 * * *"}` (daily 09:00 UTC,
  an hour after abandonment so the two destructive jobs don't overlap).

**How it's verified:** `scripts/deletion-gate-test.mjs` — adversarial harness in the Step 3/4/5/6
style. Needs `ANON_KEY` (the request/cancel flow runs as a **real authenticated user**, not
service-role). Service-role for fixtures + sweep only; `RLS_TEST_CONFIRM_STAGING=yes` interlock;
namespaced fixtures; FK-safe teardown that also removes the `email_hash_abuse` rows it created.
Imports the **same** `runDeletionSweep` the cron uses.

### Why the assertion shapes matter (don't loosen these)
- A `request_account_deletion` call must **soft-delete only** (`status='deactivated'`, a `pending`
  request) — no row is destroyed until the sweep. And it must be **idempotent** (second call returns
  the same open request, doesn't stack).
- A direct client INSERT/UPDATE/DELETE on `data_deletion_requests` must be **denied** (writes are
  RPC-only); a client may **SELECT its own** rows but not others'.
- `cancel_account_deletion` must reverse a pending request **and** return `false` as a no-op when
  there's nothing to cancel.
- A NOT-due request (grace not elapsed) must **survive** the sweep.
- After the live sweep: the account + its PII cascade are **gone**, but the planted **message
  survives with `sender_id = NULL`** (the load-bearing de-identification), and the audit row
  **survives** (`status='completed'`, `user_id` NULL, `deleted_fields.messages_anonymized >= 1`).
- The abuse hash must be a **keyed HMAC**, not plaintext/plain-SHA-256.
- A `cancelled` request and a NOT-due request must be **untouched** by the sweep.
- Service-role-only RPCs must be **denied to anon**; `request_account_deletion` must **reject an
  unauthenticated caller**.

### How to run (Isaac, on staging)
1. Apply `migrations/013_phase2_step7_data_deletion.sql` in the staging SQL editor (idempotent —
   `CREATE TABLE/INDEX IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP POLICY IF EXISTS`; safe to replay).
2. Same `.env.rls-test` as the Step 6 gate (staging URL + **anon** + service_role; the
   `ABANDONMENT_EMAIL_HASH_PEPPER` + `ABANDONMENT_EMAIL_HASH_KEY_VERSION=1` are reused —
   Step 7 shares them on purpose). `RLS_TEST_CONFIRM_STAGING=yes` (mutates the DB; **never point it
   at prod**).
3. `node scripts/deletion-gate-test.mjs` from the `V1/` root.
4. Exit 0 + all PASS = gate GREEN. Then check the Step 7 roadmap items and proceed to the Phase 2
   prod cutover.

### Before prod
- [ ] Replay migration 013 against prod **as part of the Phase 2 prod cutover** (after the gate is
  green; depends on 007–012).
- [ ] Confirm the **second** cron is registered (Vercel project → Cron Jobs shows `/api/v1/jobs/deletion`
  daily 09:00 UTC) and that an unauthenticated hit returns 401. Reuses the same `CRON_SECRET`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ABANDONMENT_EMAIL_HASH_PEPPER`,
  `ABANDONMENT_EMAIL_HASH_KEY_VERSION` already set for the abandonment job — no new Vercel env.

### Known failure modes and how to diagnose

| Symptom | Likely cause | Fix |
|---|---|---|
| `ERROR: function request_account_deletion(...) does not exist` | Migration 013 not applied on this project | Run `013_phase2_step7_data_deletion.sql` in the staging SQL editor |
| Planted message vanishes after the sweep | `messages.sender_id` FK is CASCADE, not SET NULL | Confirm `messages.sender_id ... ON DELETE SET NULL` (migration 008); this is the load-bearing de-identification |
| Audit row vanishes after the sweep | `data_deletion_requests.user_id` FK is CASCADE, not SET NULL | Confirm `user_id ... REFERENCES profiles(id) ON DELETE SET NULL` |
| `request_account_deletion` stacks duplicate rows | Idempotency / partial unique index missing | Confirm the `WHERE status IN ('pending','processing')` partial unique index and the return-existing branch |
| Sweep deletes a NOT-due / cancelled request | Selection RPC dropped the `grace_until`/`status='pending'` predicate | Compare `list_due_deletion_requests` body to migration 013 |
| Client can write `data_deletion_requests` directly | The REVOKE INSERT/UPDATE/DELETE didn't apply | Confirm writes are REVOKE'd from `anon`/`authenticated`; RPCs are the sole write path |
| Cron returns 500 / runs unauthenticated | `CRON_SECRET` unset (fails closed) or header mismatch | Set `CRON_SECRET` in Vercel; confirm `Authorization: Bearer $CRON_SECRET` |

---

## Phase 3 — Step 1: Conversations schema (migration 017) (2026-06-12)

**Status: ✅ PASSED on staging — 35/35 GREEN (2026-06-12).** Migration
`017_phase3_conversations.sql` applied on `translationapp1-staging` (embedded SQL verification block
all-green), and `scripts/conversations-gate-test.mjs` exits 0 with all 35 assertions passing —
including the load-bearing ones: direct-dedupe resolves re-create **and** reverse-create to the
**same** id with exactly one row (no glare dup), group creates are always-new (distinct ids), a
soft-left member **loses** both the conversation and its context row and **regains** both on re-join,
conversation-kind invite create+redeem joins while a cross-tenant redeem is denied opaquely, every
`messages.conversation_id` resolves (0 nulls, 0 unresolved FKs), and direct client INSERTs into
`conversations`/`conversation_members` are RLS-denied. **Prod replay of 017 is still pending.**

**What this step does:** Introduces first-class conversations (the move off "one global room").
Adds `conversations` + `conversation_members` tables with membership-gated RLS, promotes
`messages.conversation_id` to a real FK (zero backfill — the 014 default already seeded every row
with the global sentinel), adds `conversation_contexts` RLS + FK `NOT VALID`, and the
`create_conversation` / `leave_conversation` / `set_conversation_context_type` / `is_active_member`
RPCs, plus conversation-kind `create_invite`/`redeem_invite` amendments. Dedupe is policy-driven
(`tenants.conversation_policy` over `lib/policies.js` defaults) and race-safe via
`conversations.dedupe_key` + a partial unique index. See decisions.md 2026-06-12 "Phase 3 Step 1
conversations schema" + the dedupe / `created_by` ON DELETE SET NULL / FK-NOT-VALID entries.

**How it's verified:** `scripts/conversations-gate-test.mjs` — a checked-in adversarial harness
(same `.env.rls-test` + `RLS_TEST_CONFIRM_STAGING=yes` staging guard as Steps 3–7), nine phases:
(1) direct create + membership visibility, (2) direct-dedupe race-safety (same id on re-create and
reverse member order), (3) group always-new (distinct ids), (4) rejections (cross-tenant, self-only,
direct≠2), (5) `set_conversation_context_type` member vs non-member, (6) `conversation_contexts` RLS
+ soft-leave/re-join, (7) conversation-kind invite create+redeem + cross-tenant denial, (8)
`messages.conversation_id` data-level (0 nulls, 0 unresolved FKs), (9) direct-client-write-denied.

**Gate:** `node scripts/conversations-gate-test.mjs` exits 0 with every phase PASS, on staging.

**Gate result:** ✅ **35/35 GREEN on staging 2026-06-12** (`translationapp1-staging`,
`nvlmcdgzbxuwcnzkwqne`). All nine phases PASS. Roadmap Schema items flipped `[~]` → `[x]`.

### How to run it (staging)
1. Apply `017_phase3_conversations.sql` in the staging (`translationapp1-staging`, non-main branch)
   SQL editor; confirm the embedded verification block at the foot of the migration returns all-green.
2. Same `.env.rls-test` as the Step 5–7 gates (staging URL + anon + service_role keys; three test
   users A/B/C; `RLS_TEST_CONFIRM_STAGING=yes`).
3. `node scripts/conversations-gate-test.mjs` from the `V1/` root.
4. Exit 0 + all PASS = gate GREEN. Record the result above, flip the roadmap items, then proceed.

### Known failure modes and how to diagnose

| Symptom | Likely cause | Fix |
|---|---|---|
| `ERROR: function create_conversation(...) does not exist` | Migration 017 not applied on this project | Run `017_phase3_conversations.sql` in the staging SQL editor |
| Direct re-create mints a **new** id instead of deduping | `dedupe_key` not set, or the partial unique index missing | Confirm `conversations_dedupe_unique (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL` and that `create_conversation` writes the sorted member-set key for `direct` |
| Group create dedupes (reuses a thread) | `conversation_policy` / default resolved to `dedupe` for `group` | Confirm `CONVERSATION.DEFAULTS.group = 'always_new'` and the RPC's `coalesce` fallback |
| A user sees a conversation they aren't in | SELECT policy not gated on `is_active_member` | Confirm the `conversations`/`conversation_members` SELECT policies call `is_active_member(id, auth.uid())` |
| Soft-leave hard-deletes the membership row | `leave_conversation` issued DELETE not `UPDATE left_at` | Confirm it stamps `left_at = now()` on the active row |
| `messages.conversation_id` has NULLs / unresolved FKs | 014 default never populated, or promotion ran before seed | Confirm the global-conversation row (`…0002`) is inserted **before** `SET NOT NULL`, and 014 ran first |
| Client can INSERT/UPDATE `conversations` directly | No REVOKE / a stray write policy exists | Confirm tables are RLS SELECT-only and the RPCs are the sole write path |

---

## Phase 3 — Step 2: Membership-scoped messages RLS (migration 018 / Spec 7) (2026-06-12)

**Status: ✅ PASSED on staging — 27/27 GREEN (2026-06-12).** Sentinel data purged, migration
`018_phase3_messages_rls.sql` applied on `translationapp1-staging` (embedded SQL verification block
all-green), and `scripts/messages-rls-gate-test.mjs` exits 0 with all 27 assertions passing —
including the load-bearing ones: a non-member is denied on **all four** surfaces (SELECT message,
INSERT message, read cache, **realtime** — 0 events), a cross-tenant user is denied, joining via
invite grants all four (including a cache upsert and realtime delivery ≥1), soft-leave revokes all
four again, and `messages` remain immutable (member UPDATE/DELETE change 0 rows). **Prod replay of
017 → 018 is still pending** (hold until the conversation-aware frontend lands — see roadmap UI).

**What this step does:** Flips `messages` + `message_translations` RLS from **tenant-scoped** to
**membership-scoped** — the highest-blast-radius security change since the Phase 2 RLS cutover (it
governs every message read, write, and realtime push). 017 ended "one global room" at the *schema*
layer; 018 ends it at the *authorization* layer. A user may read or post a message, and read or write
its cached translation, only as an active member of its conversation
(`is_active_member(conversation_id, auth.uid())`). `message_translations` (which has no
`conversation_id`) resolves membership through the parent message via `EXISTS` — the easy-to-miss
cache-leak half. `messages` stays immutable (no UPDATE/DELETE policy). Policies-only; no DDL, no data
change, no recreate; same five policy names as migration 008. See decisions.md 2026-06-12 "Phase 3
data model" (point 4) + "Retire the global-room sentinel data".

**How it's verified:** `scripts/messages-rls-gate-test.mjs` — a checked-in adversarial harness (same
`.env.rls-test` + `RLS_TEST_CONFIRM_STAGING=yes` staging guard as the other gates). Two users in one
tenant, a service-seeded **A-only** conversation (the `create_conversation` RPC can't make one — it
requires a second member). Five phases: (1) setup + positive controls (A posts + caches a translation
+ reads both); (2) **non-member B** denied on all four surfaces — SELECT message, INSERT message,
read cache, **realtime** (explicit `postgres_changes` subscription receives 0 events) — plus a
cross-tenant C negative; (3) **B joins** via conversation invite (`create_invite`/`redeem_invite`) →
all four now allowed, including a cache UPDATE/upsert and realtime delivery ≥1; (4) **B soft-leaves**
(`leave_conversation`) → all four revoked again; (5) messages immutability (member UPDATE/DELETE
changes 0 rows). The realtime checks are explicit because realtime-RLS is a known footgun (Supabase
`postgres_changes` runs the SELECT policy for `authenticated`) — not something the gate assumes.

**Gate:** `node scripts/messages-rls-gate-test.mjs` exits 0 with every phase PASS, on staging.

**Gate result:** ✅ **27/27 GREEN on staging 2026-06-12** (`translationapp1-staging`,
`nvlmcdgzbxuwcnzkwqne`). All five phases PASS, both realtime checks behaved as expected (0 events for
non-member/left, ≥1 for member). Roadmap Step 2 item flipped `[~]` → `[x]`.

### How to run it (staging)
1. **Purge first (recommended):** run the read-only sentinel-inventory queries at the foot of
   `018_phase3_messages_rls.sql` on staging to see what goes dark, then purge the sentinel
   (`…0002`) messages (translations cascade) per decisions.md "Retire the global-room sentinel data".
2. Apply `018_phase3_messages_rls.sql` in the staging (`translationapp1-staging`, non-main branch)
   SQL editor — **017 must already be applied** (the `is_active_member` helper + `conversations`
   tables are prerequisites); confirm the embedded verification block returns all-green.
3. Same `.env.rls-test` as the Step 1 / 3–7 gates (staging URL + anon + service_role keys; three test
   users A/B/C; `RLS_TEST_CONFIRM_STAGING=yes`).
4. `node scripts/messages-rls-gate-test.mjs` from the `V1/` root.
5. Exit 0 + all PASS = gate GREEN. Record the result above, flip the roadmap item, then (and only
   then) replay 017 → 018 to prod.

### Known failure modes and how to diagnose

| Symptom | Likely cause | Fix |
|---|---|---|
| `ERROR: function is_active_member(...) does not exist` | Migration 017 not applied on this project | Run `017_phase3_conversations.sql` first — 018 depends on it |
| Non-member B **can** SELECT A's message | `messages` SELECT policy missing the `is_active_member` conjunct | Confirm `messages_select_same_tenant` USING is `tenant_id = auth_tenant_id() AND is_active_member(conversation_id, auth.uid())` |
| Non-member B **can** read the cached translation though not the message | `message_translations` SELECT policy not following the parent message | Confirm `mt_select_same_tenant` uses the `EXISTS (… FROM messages m WHERE m.id = message_translations.message_id AND …)` predicate |
| Member B's cache **upsert** fails (`INSERT … ON CONFLICT DO UPDATE`) | `mt_update_same_tenant` missing the `WITH CHECK` half (only `USING`) | Confirm the UPDATE policy carries the predicate in **both** `USING` and `WITH CHECK` |
| Non-member B **receives realtime** events | realtime delivery not applying the new SELECT policy / `messages` not in the publication | Confirm `messages` is in `supabase_realtime` (migration 004) and the SELECT policy is membership-gated; the gate's realtime phase is the canary |
| A member's message **UPDATE/DELETE** succeeds (changes rows) | A stray UPDATE/DELETE policy exists on `messages` | Confirm `messages` has **no** UPDATE/DELETE policy (immutability is by omission) |
| Gate harness errors on realtime subscribe timeout | staging realtime disabled, or anon key lacks realtime | Confirm Realtime is enabled on the staging project and `setAuth(token)` is using the user JWT |

---

## Phase 3 — Step 2b: Unify `context_type` vocab (migration 019) (2026-06-12)

**Status: ✅ APPLIED + GATE GREEN on staging (2026-06-12).** `019_unify_context_type_vocab.sql` run on
`translationapp1-staging`: constraint verification returned the engine set
(`casual`/`dating`/`professional`/`academic`) with 0 rows on any retired value, and **both** Phase 3
gates stayed green afterward (`conversations-gate-test.mjs` 35/35, `messages-rls-gate-test.mjs` 27/27).
**Prod replay pending** the coordinated cutover (016→017→018→019 + frontend).

**What this step does:** Unifies `conversations.context_type` onto the translation engine's vocabulary
(`casual`/`dating`/`professional`/`academic`) — the set `lib/translatePrompt.js`
`CONTEXT_TYPE_MODIFIERS` already keys off. Migration 017 had shipped a divergent column CHECK
(`casual`/`professional`/`romantic`/`family`/`support`), so three of five conversation values had **no
matching prompt modifier** (silent fallthrough to the casual/default tone). 019 fixes the table CHECK
**and** the two RPC inline guards (`create_conversation`, `set_conversation_context_type`) in lockstep,
with a defensive `UPDATE` remapping any pre-existing retired-value rows (`romantic`→`dating`,
`family`/`support`→`casual`) before the constraint is re-added. **`detected_register` (the separate
inference-OUTPUT enum) is deliberately untouched.** ALTER not recreate; CREATE OR REPLACE preserves the
RPC signatures (so GRANTs survive); whole thing is one idempotent transaction.

**How to verify (staging):**
1. Apply `019_unify_context_type_vocab.sql` in the staging SQL editor; confirm the trailing
   verification block returns: the `conversations_context_type_check` constraint definition listing
   exactly `casual`/`dating`/`professional`/`academic`, and **0 rows** remaining on any retired value.
2. Re-run the Step 1 gate — `node scripts/conversations-gate-test.mjs` — and confirm it stays **GREEN
   35/35**. The gate only feeds `professional`/`casual`/`nonsense` to `set_conversation_context_type`,
   all still valid (or still correctly rejected), so 019 must not regress it.
3. Spot-check `create_conversation(p_context_type => 'dating')` succeeds and
   `… => 'romantic'` now raises the guard error.

**Gate:** existing `scripts/conversations-gate-test.mjs` must stay 0/GREEN; no new harness needed (the
change is a vocabulary tightening, not a new surface).

**Prod:** replay **016 → 017 → 018 → 019** as one coordinated cutover, shipped together with the
conversation-aware frontend (the frontend must pass real `conversation_id` on insert first — see
roadmap UI). See decisions.md 2026-06-12 "Unify context_type vocab".

---

## Phase 3 — Step 3: Conversation-aware frontend (manual smoke) (2026-06-12)

**Status: ✅ SMOKE GREEN on Vercel Preview against staging (2026-06-12), with two non-blocking quirks
logged.** All flows now exercised (the third-user/group items were unblocked once the magic-link rate
limit reset). Magic-link sign-in worked on the Preview URL with **no** staging/Vercel auth-config change.
Two known quirks, both deferred (parking-lot): (1) register "?" tooltip clips at the screen edge;
(2) inviting a third user into a **direct** conversation doesn't promote it to a group — see the
checklist note below.

**Setup as run:** branch `phase3/step1-conversations` pushed → Vercel Preview (staging DB); migrations
016✓/017✓/018✓/019✓ on `translationapp1-staging`; both gates green (35/35, 27/27).

**Smoke checklist — results:**
- [x] Direct conversation create + **dedupe** confirmed (re-create with same member → same thread).
- [x] **Optimistic send**: instant render, settles to sent, no duplicates reproducible.
- [x] **Translation** display + **"Original:" tap-to-expand** work.
- [x] **Register** selector changes tone; **"?"** explainer shows on hover. ⚠️ tooltip renders partly
      off-screen — cosmetic, deferred (parking-lot "register tooltip clip").
- [x] **No "Original:" line on own sent messages** (received-only sub-line) confirmed.
- [x] **Network-loss → "⚠ Failed — tap to retry"** → retry resends. Confirmed.
- [x] **Invite → `?join=<token>` join** — third user added successfully (confirmed after the magic-link
      rate-limit window reset). ⚠️ **quirk on direct chats** — see below.
- [x] **Group conversation** — created; **sender names render above received bubbles** as expected.

**⚠️ Known quirk — "Invite to conversation" on a `direct` chat doesn't promote it to a group.**
Observed: inviting a third user from within a 1:1 direct conversation appears to drop them into "a new
direct chat" rather than the existing thread. Root cause (from reading `redeem_invite`, 017 L606–632):
the RPC correctly adds the redeemer as a member of the **existing** target conversation — **no new row is
created** — but it leaves `conversations.kind = 'direct'`. The frontend renders any `direct` conversation
as a 1:1 chat labeled by a single counterpart (`ConversationList`/`ConversationView` derive the name from
`otherMembers[0]`), so the now-3-person thread *displays* as a direct chat and hides the third
participant. So it's a display/promotion gap, not duplicate-conversation data corruption. **Deferred** (Isaac,
2026-06-12 — not blocking). Fix options live in parking-lot "direct→group promotion on invite". Group
chats created fresh via the people-picker (2+ members → `kind='group'`) render correctly; the quirk is
specific to *inviting into* an existing direct chat.

**Note:** the single `messages` realtime channel relies on 018's membership-scoped realtime — verified by
the live B-replies-to-A realtime delivery during smoke. See decisions.md 2026-06-12 "Phase 3
conversation-aware frontend" for the realtime/optimistic-send model and the known MVP gaps (no
conversation-list realtime, N+1 list enrichment, no join deep-link).

---

## Phase 3 — Step 4: Production cutover (EXECUTED 2026-06-18)

**Status: ✅ EXECUTED 2026-06-18 — DB side fully GREEN; 2-user prod smoke GREEN.** The coordinated cutover
ran against prod `translationapp1` (high-water mark was **015**): migrations **016 → 017 → [sentinel purge] →
018 → 019** in the prod SQL editor, each verified against its embedded block, then `phase3/step1-conversations`
fast-forward-merged → `main` (`5251669..c13f8ae`) so Vercel auto-deployed the conversation-aware frontend and
closed the broken-sends window. The runbook below is retained as the record of what was run.

**Results (2026-06-18):**
- **Pre-flight:** prod disposable-only (messages=0, message_translations=0, profiles=2, ULP=2); `message_translations→messages` FK = `confdeltype='c'` (CASCADE). No snapshot (free tier; disposable).
- **016** — no-op on prod (already CASCADE); re-verified `'c'`.
- **017** — embedded verification all green: conversations/members + RLS, global sentinel row, 5 indexes, `conversation_id` promoted NOT NULL FK (default dropped, 0 nulls / 0 unresolved), `conversation_contexts` FK NOT VALID + RLS, `conversation_policy` column, 6 functions.
- **Sentinel purge** — no-op (0 sentinel messages; nothing dark outside the sentinel; `DELETE 0`).
- **018** — five membership policies carry `is_active_member`; messages immutable (0 UPDATE/DELETE); RLS on; helper SECURITY DEFINER + STABLE. The 6th `messages` SELECT policy `profile_writer_messages_select` (migration 015, `TO profile_writer`) is expected and correctly has no membership predicate.
- **019** — `conversations_context_type_check` is the engine set `casual/dating/professional/academic`; 0 rows on retired values.
- **Merge/deploy** — fast-forward push to `main`; Vercel auto-deployed. No env-var change (Production secrets set in the Phase 2 cutover).
- **2-user prod smoke GREEN:** sign in + onboard ×2, create direct conversation, send (instant, no dupes, real `conversation_id` on insert), receive translated + "Original:" expand, register persists across reload, network-loss retry.
- **Deferred (not blockers):** 3rd-user invite/join + group create/sender-names (Supabase built-in email caps magic links ~2/hr → only 2 onboardings/window; both already gate-verified on staging — 017 35/35, 018 27/27). Custom SMTP + sending domain logged as a follow-up (parking-lot). New empty-conversation visibility quirk found + parked (parking-lot).

**Original coordinated-cutover plan (executed as written):**

**Why coordinated (the load-bearing constraint):** 017 sets `messages.conversation_id` NOT NULL and drops
its default, so the *currently-live* old frontend's insert (no `conversation_id`) starts failing the moment
017 lands. Sends are broken on prod from then until the new frontend deploys. There is no ordering that
avoids this; minimize the window — apply the migrations and merge to `main` back-to-back in a low-traffic
moment. (Accepted tradeoff — decisions.md 2026-06-12 "Phase 3 conversation-aware frontend".)

**Pre-flight:**
1. Confirm prod holds only disposable test data. Free tier = **no backups/PITR**; if any real user data
   exists, export/snapshot first (operations.md §4 standing rule).
2. Confirm prod's `message_translations → messages` FK is already CASCADE (`confdeltype='c'`) so the
   sentinel purge cascades — it is (016 is a verified no-op on prod), but check.

**Sequence (prod SQL editor = `translationapp1`; NEVER point a gate/test script at prod):**
1. **016** — run for ledger completeness (no-op on prod). Verify `confdeltype='c'`.
2. **017** — run; confirm its embedded verification block is all-green (conversations/members tables, RLS,
   `conversation_id` promoted to NOT NULL FK, the four RPCs + amended invite RPCs present).
3. **Sentinel inventory + purge** (BEFORE 018, so the cache cascades cleanly). Read-only first:
   ```sql
   select count(*) as sentinel_messages from public.messages
    where conversation_id = '00000000-0000-0000-0000-000000000002';
   select count(*) as sentinel_translations from public.message_translations mt
     join public.messages m on m.id = mt.message_id
    where m.conversation_id = '00000000-0000-0000-0000-000000000002';
   -- sanity: nothing dark outside the sentinel
   select m.conversation_id, count(*) from public.messages m
    where not exists (select 1 from public.conversation_members cm
                       where cm.conversation_id = m.conversation_id and cm.left_at is null)
    group by m.conversation_id;   -- expect only …0002 (or nothing)
   ```
   Then purge (cascades to `message_translations`):
   ```sql
   delete from public.messages where conversation_id = '00000000-0000-0000-0000-000000000002';
   ```
4. **018** — run; confirm verification block all-green (the five policy names carry `is_active_member`;
   `messages` has no UPDATE/DELETE policy).
5. **019** — run; confirm the `conversations_context_type_check` lists the engine set and 0 rows on retired values.
6. **Merge the branch → `main` immediately** → prod auto-deploys the conversation-aware frontend, closing
   the broken-sends window.

**Post-cutover smoke (on prod, fresh aliases):** repeat the Step 3 checklist above — at minimum: sign in,
create direct conversation, send (instant + no dupes), receive translated + "Original:" expand, register
persists, third-user invite/join, group create + sender names, network-loss retry. The dashboard Site
URL / redirect URLs are already correct on prod (set in the Phase 2 cutover) — no auth-config step.

**Known quirks carried to prod (both deferred, not blockers):** register "?" tooltip clips off-screen;
inviting into a `direct` chat doesn't promote it to `group`. See parking-lot.

---

## Phase 2 — Step 0: Pre-flight (2026-06-09)

**What this step does:** Audits Supabase config that lives outside `/migrations/`, scaffolds
`lib/policies.js`, and wipes staging clean for a fresh Phase 2 build.

**Gate (must pass before Step 1 starts):**
- [ ] Audit findings captured — no un-migrated extensions, triggers, or RLS policies found (or noted)
- [ ] `lib/policies.js` created and in sync with `policies.md`
- [ ] Staging confirmed empty (all Phase 1 tables dropped)

---

### A. Supabase config audit

Run these queries in the **staging** SQL editor (and prod separately if you want to compare).
The goal is to find anything set via Studio UI that isn't captured in a migration file.

```sql
-- 1. Extensions — check what's enabled. We need pgcrypto for Phase 2 email hashing.
SELECT name, installed_version, default_version
FROM pg_available_extensions
WHERE installed_version IS NOT NULL
ORDER BY name;
-- Expect: pg_graphql, pg_stat_statements, pgcrypto, pgjwt, uuid-ossp (Supabase defaults)
-- If pgcrypto is absent: note it — we'll need to enable it in migration 007.

-- 2. Triggers on auth.users (we'll add one in Step 1; need to know if anything exists)
SELECT trigger_name, event_object_schema, event_object_table,
       action_timing, event_manipulation, action_statement
FROM information_schema.triggers
WHERE event_object_schema = 'auth' AND event_object_table = 'users'
ORDER BY trigger_name;
-- Expect: 0 rows (no custom triggers yet).

-- 3. Triggers in public schema
SELECT trigger_name, event_object_table, action_timing, event_manipulation
FROM information_schema.triggers
WHERE trigger_schema = 'public'
ORDER BY event_object_table, trigger_name;
-- Expect: 0 rows.

-- 4. RLS status on all public tables (should all be off today)
SELECT relname AS table_name,
       relrowsecurity AS rls_enabled,
       relforcerowsecurity AS rls_forced
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relkind = 'r'
ORDER BY relname;
-- Expect: rls_enabled = false on every row.

-- 5. Existing RLS policies (should be none)
SELECT schemaname, tablename, policyname, cmd, roles, qual
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
-- Expect: 0 rows.

-- 6. Realtime publication tables (004 captures messages; anything else?)
SELECT schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
ORDER BY tablename;
-- Expect: exactly ('public', 'messages'). If other tables appear, note them.

-- 7. Custom functions in public schema
SELECT routine_name, routine_type
FROM information_schema.routines
WHERE routine_schema = 'public'
ORDER BY routine_name;
-- Expect: 0 rows (no custom functions yet).
```

**Known extra-migration config (not in migrations, documented here):**
- `hermes_writer_user` Postgres role on prod (INSERT-only on event tables) — provisioned
  manually per Spec 4a. Staging equivalent not provisioned (staging uses postgres superuser).
- `hermes_readonly_user` Postgres role on prod (SELECT-only) — provisioned manually per Spec 3.
- These roles don't need migration files; they're operational config, not schema.

---

### B. Staging wipe

Run in the **staging** Supabase SQL editor. Drops all public tables and replays migrations 000–006
from scratch. **Do not run on prod.**

```sql
-- Step 1 of 2: Drop all tables in public schema (CASCADE handles FK order)
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename
    ) LOOP
        EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
    END LOOP;
END $$;

-- Verify clean:
SELECT tablename FROM pg_tables WHERE schemaname = 'public';
-- Expect: 0 rows.
```

Then replay migrations in order:
1. `000_base_schema.sql`
2. `001_tenants_and_tenant_id.sql`
3. `002_phase1_schema.sql`
4. `003_prompt_version_and_gender_nonbinary.sql`
5. `004_enable_realtime_publication.sql`
6. `005_event_log_tables.sql`
7. `006_user_profile_events_task_id.sql`

After replaying, verify:
```sql
-- Confirm expected tables exist
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
-- Expect: agent_events, conversation_contexts, message_translations, messages,
--         tenants, translation_events, user_linguistic_profiles, user_profile_events, user_profiles

-- Confirm tenant seed row (from 001)
SELECT id, name FROM public.tenants;
-- Expect: 1 row with the chat-app tenant
```

**Note on test users:** The staging test users (`staging_test_a`, `staging_test_b`) seeded
previously are gone after the wipe. They'll be re-seeded via the real magic-link flow in Step 2.

---

### C. Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| DROP TABLE fails with `cannot drop ... because other objects depend on it` | FK constraint not caught by CASCADE | Add `CASCADE` if missing; CASCADE should handle this |
| Migration replay fails on `001` | `tenants` table not created by `000` first | Confirm 000 ran clean before 001 |
| `005` fails on `agent_events` | Tenant seed row from `001` missing — `tenant_id NOT NULL` | Re-run `001` first |
| pgcrypto missing from audit | Extension not enabled by default on this Supabase plan | Enable in migration 007 with `CREATE EXTENSION IF NOT EXISTS pgcrypto` |

---

## Server-side profile inference (2026-06-10)

**Status: ✅ PASSED on staging 2026-06-10.** Gate run against `translationapp1-staging` (Vercel Preview deploy at commit `0bf364e`, `DATABASE_URL_PROFILE_WRITER` set in Preview env only). Two users (A=`es`, B=`en`). User A sent Argentine Spanish; viewing as User B fired `POST /api/v1/infer-profile` → `{"status":"updated","fields":[...]}`. Verified: A's profile row updated (dialect `es-AR`, formality `casual`, gender `masculine`, all `_source = 'inferred'`, `updated_at` bumped); `user_profile_events` rows landed with `source = 'inference'`; trust boundary held (B triggered, **A's** row written via `message_id`); dialect guard confirmed both ways (a later English message did **not** overwrite the `es-AR` dialect); confidence-must-increase re-write observed and correct (es-AR rewritten when a stronger second message raised confidence to 1.0). Deferred Step 2 smoke test exercised in the same run (signup → onboard → send → receive → translate → inference, no interference with the render path). Prod enablement (least-privilege `profile_writer` role + Production env var) **completed 2026-06-11** as part of the Phase 2 cutover, and the two-user inference path **passed live on prod 2026-06-11** (es-AR + casual written to the sender's row, two event rows, trust boundary held) — see "Before prod" and the "Phase 2 production cutover" record below.

**Re-gate: ✅ PASSED on staging 2026-06-11 under the locked-down role.** Staging Preview `DATABASE_URL_PROFILE_WRITER` switched from the `postgres` superuser URL to the least-privilege `profile_writer` role (migration 015 — scoped GRANTs + `TO profile_writer` RLS, port 6543 transaction pooler, `LOGIN` secret set out of band, stored only in the staging Vercel Preview env). Re-verified end-to-end: (1) **positive write** — User B (empty profile) sent an English message with a formal-register signal; viewed as User A, `POST /api/v1/infer-profile` returned `{"status":"updated",...}` and B's `formality_preference` + a `user_profile_events` row landed. Gender not detected — expected (English gender signal is weak; correctly fell below the confidence guard). This exercised the scoped `UPDATE` (7 cols) + `INSERT` (events) grants. (2) **correct noop** — re-sending against the already-saturated User A (es-AR @ 1.0, casual, masculine) returned `{"status":"noop","reason":"no_qualifying_inferences"}` — the guards, not a broken role. (3) **deny-by-default** — `SET ROLE profile_writer` then `SELECT` on `public.profiles` / `public.account_settings` (no `profile_writer` policy) both returned `permission denied`, confirming the role is blocked wherever it has no explicit grant + policy. Migration-015 grant/policy verification queries (role_table_grants / role_column_grants / pg_policies) all matched the intended surface exactly. See `decisions.md` 2026-06-11 "profile_writer role: scoped RLS, not BYPASSRLS".

**What shipped:** Profile inference moved off the (RLS-dead) client path to `POST /api/v1/infer-profile` — Express route in `server/index.js`, Vercel handler `api/v1/infer-profile.js`, shared logic in `server/lib/inferProfile.js`. The client fires-and-forgets `{ message_id, inferences, detected_language }`; the server derives the authoritative sender from the message row, applies the inference guards, and writes the sender's profile + event rows atomically under `SELECT … FOR UPDATE`. Flag `PROFILE_INFERENCE_ENABLED = true` in `App.jsx`. See `decisions.md` 2026-06-10 "Server-side profile inference (Option A)".

### Pre-flight (before the gate)

- [ ] `DATABASE_URL_PROFILE_WRITER` is set in the environment running the endpoint (local `server/.env` for `npm run dev`, or Vercel **Preview** env for staging deploys). On staging this is now the least-privilege `profile_writer` role (migration 015, port 6543 transaction pooler) — switched off the superuser URL and re-gated GREEN 2026-06-11. If unset, `inferProfile()` warns and skips — inference silently no-ops.
- [ ] The credential is **not** `VITE_`-prefixed and `server/.env` is gitignored (it is — `.env*`).
- [ ] Staging migrations 007 + 008 are applied (RLS + uuid `user_id` + `complete_onboarding`).

### Gate (run on staging, two users)

The core gate: **a translated message from another user causes that sender's profile row to update and an event row to land.**

1. [x] Two users onboarded on staging (User A language `es`, User B language `en`), each on a separate browser/session.
2. [x] As User A, send a message with a clear regional/register/gender signal (e.g. an Argentine-Spanish phrase using `vos`).
3. [x] As User B (whose `preferred_language` differs), view the message so it routes through `/api/v1/translate`. Confirm Network tab shows a `POST /api/v1/infer-profile` returning 200 with a JSON body like `{"status":"updated","fields":[...]}` (or `"noop"` if nothing crossed the confidence threshold).
4. [x] Supabase → `user_linguistic_profiles`: **User A's** row (`user_id` = A's uuid) shows the inferred `dialect_region` / `formality_preference` / `gender_signal` with the matching `_source = 'inferred'` and `updated_at` bumped. (The write is to the *sender's* profile, not the viewer's.)
5. [x] Supabase → `user_profile_events`: a new row for User A with `source = 'inference'` and the matching `event_type` (`dialect_region_inferred` etc.), `previous_value` / `new_value` populated.
6. [x] Trust boundary: confirm the write landed on A's profile even though B triggered it — i.e. identity came from `message_id`, not the caller.
7. [x] Dialect guard: a same-language signal applies; a cross-language one is rejected (e.g. an English message should never write an `es-AR` dialect to the sender). When `source_language = 'unknown'`, the live `detected_language` is used as the anchor instead of blocking outright.
8. [x] Re-send/translate the same message again (or have a second viewer translate concurrently): the `FOR UPDATE` transaction serialises the writes — no error, no duplicate clobber, confidence-must-increase still holds for dialect.

### Deferred Step 2 smoke test

- [x] Run the Phase 2 Step 2 end-to-end smoke test (signup → onboard → active → send/receive) now that inference is live, to confirm the inference POST doesn't interfere with the message render path. (This was deferred from the Step 2 gate.)

### Before prod

- [x] Provision the least-privilege `profile_writer` role on prod by **running migration 015** as part of the prod replay (007→015) — it is stricter than the hand-written grants this bullet used to list (column-scoped UPDATE on the 7 inference cols + `updated_at`, SELECT on 4 `messages` cols, INSERT on 6 `user_profile_events` cols, plus `TO profile_writer` RLS policies; **not** whole-table grants). Then, **out of band**, `ALTER ROLE profile_writer WITH LOGIN PASSWORD '…'` and set `DATABASE_URL_PROFILE_WRITER` in Vercel **Production** to `profile_writer.<prod-project-ref>` on **port 6543** (transaction pooler — same serverless lesson as `DATABASE_URL_PROD_WRITER`). Do **not** ship the superuser URL to prod. **DONE 2026-06-11** as part of the Phase 2 prod cutover — migration 015 applied on prod (role `rolcanlogin/rolsuper/rolbypassrls` all `f` until login enabled, then `LOGIN` set out of band; grants/policies matched the intended surface), `DATABASE_URL_PROFILE_WRITER` set in Vercel Production on port 6543, and the **two-user inference path passed live on prod 2026-06-11** (see "Phase 2 production cutover" record below). ⚠️ Use an **alphanumeric-only password** for the role (or URL-encode it) — a special-char password produced a misleading `password authentication failed` 500 on the first prod attempt.

### Known failure modes and how to diagnose

| Symptom | Likely cause | Fix |
|---|---|---|
| `POST /api/v1/infer-profile` returns 200 `{"status":"disabled"}` | `DATABASE_URL_PROFILE_WRITER` unset in that environment | Set it (server/.env locally; Vercel Preview env for staging). |
| 200 but profile never updates; status `skipped`/`no_profile_row` | Sender hasn't completed onboarding (no `user_linguistic_profiles` row) | Expected for un-onboarded senders; otherwise confirm `complete_onboarding` ran for that user. |
| Write succeeds locally but not on Vercel | Endpoint not awaiting the transaction (function frozen at `res.json()`) | Confirm `await inferProfile(...)` — both routes await; the *client* fires-and-forgets, the *server* must not. |
| `permission denied for table user_linguistic_profiles` | Credential lacks UPDATE/SELECT (e.g. accidentally reused the INSERT-only `DATABASE_URL_PROD_WRITER`) | Use a credential with SELECT+UPDATE on profiles, SELECT on messages, INSERT on events. |
| Dialect never applies | `source_language` is `unknown` and no `detected_language` sent, or dialect prefix ≠ source-language prefix | Confirm the translate response carries `detected_language`; check the guard anchor logic in `inferProfile.js`. |
| 404 on `/api/v1/infer-profile` in prod but works locally | `api/v1/infer-profile.js` not deployed / not picked up by Vercel | Confirm the file exists and the deploy is the latest (same failure mode as the translate route). |

---

## Phase 2 production cutover (2026-06-11)

**Status: ✅ FULLY GREEN on prod 2026-06-11 — cutover complete.** Schema, `profile_writer` role, two-user inference path, and Vercel crons all verified live on prod. The coordinated wipe-then-replay cutover ran against the prod project `translationapp1`. Prod previously sat at migration 006 (pre-auth, no RLS) while the already-shipped frontend expected the Phase 2 schema; the cutover migrated the DB to match the live app. See `decisions.md` 2026-06-11 "Phase 2 production cutover executed (prod wipe + replay 007→015)" and `operations.md` "Prod cutover — EXECUTED 2026-06-11".

**What ran:**

- [x] **Wipe** — truncated the 8 data tables (kept the `tenants` sentinel row); verified all 8 at 0, `tenants` at 1. Event-log tables truncated by explicit decision; **no snapshot taken** (free tier has no backups; data was disposable and the schema lives in migrations).
- [x] **Replay 007→015** — every migration applied clean, each verified against its in-file verification block before moving on: 007 (3 identity tables, 27 reserved words, RLS, `handle_new_user` trigger, `display_name`-only column grant), 008 (`user_profiles` dropped, 3 uuid promotions, `messages.sender_id` FK, RLS on messages + message_translations, `complete_onboarding`), 009 (gender CHECK includes `nonbinary`), 010–013 (7 tables, 16 RPCs, RLS on 6), 014 (conversation_id sentinel default, 0 vestigial columns, 4 timestamptz, 4 FK indexes), 015 (role `f/f/f`, full column-grant list, 4 `TO profile_writer` policies).
- [x] **Secrets** — `DATABASE_URL_PROD_WRITER` and `DATABASE_URL_PROFILE_WRITER` set in Vercel **Production** on **port 6543** (transaction pooler); `profile_writer` `LOGIN` enabled out of band.
- [x] **Deploy** — `main` auto-deploys to Production; env-var changes do **not** auto-redeploy, so a manual redeploy was required to pick up the new secrets.
- [x] **Auth config (dashboard, not a migration)** — Supabase prod **Site URL** was still the dev default, so magic links redirected to `localhost` ("localhost refused to connect"). Fixed by setting Site URL = `https://translationapp1.vercel.app` and adding `https://translationapp1.vercel.app/**` to Redirect URLs. Supabase ignores `emailRedirectTo` unless the target is allowlisted, falling back to Site URL.
- [x] **Single-user smoke** — User A signed up, onboarded (P1→P3), `user_linguistic_profiles` row created (`en`), sent 1 message. `translated = 0` is **expected** — the app skips translation for the sender's own messages and there was no other-language recipient.
- [x] **Two-user inference path on prod (2026-06-11)** — User A sent an Argentine-Spanish message; User B (different `preferred_language`) viewed it → `POST /api/v1/infer-profile` returned `{"status":"updated","fields":["dialect_region","dialect_confidence","dialect_source","formality_preference","formality_source"]}`. Verified: User A's ULP row updated to `dialect_region=es-AR` / `formality_preference=casual` with `updated_at` bumped; two `user_profile_events` rows landed (`dialect_region_inferred`, `formality_preference_inferred`, `source=inference`); **trust boundary held** — the write landed on the *sender* (User A), not the viewer (User B's row untouched). `gender_signal` null (no gender signal crossed the confidence threshold — expected). This exercised the `profile_writer` role's scoped SELECT/UPDATE/INSERT grants live on prod.
  - **Debugging note:** first attempt 500'd — Vercel log showed `password authentication failed for user "profile_writer"`. Root cause was the connection-string password in `DATABASE_URL_PROFILE_WRITER` (special characters corrupt parsing / mismatch). Fixed by resetting the role to an alphanumeric-only secret (`ALTER ROLE … WITH LOGIN PASSWORD`), updating the env var, and redeploying. The format (`profile_writer.<ref>` @ port 6543 pooler) was already correct — only the password was the problem. Migration 015's connection-string comment template was wrong (showed port 5432 / bare username / no URL-encode warning) and has been corrected.

- [x] **Vercel cron verification on prod (2026-06-11)** — both jobs confirmed registered on the prod project via the Vercel dashboard: `/api/v1/jobs/abandonment` (daily 08:00 UTC) and `/api/v1/jobs/deletion` (daily 09:00 UTC), both `CRON_SECRET`-guarded.

**No pending items — the Phase 2 production cutover is complete.**

---

## Phase 2.1 — Token auth on backend API calls (SHIPPED TO PROD 2026-06-23 — prod smoke GREEN)

> **Note (2026-06-23):** this merged to `main` (→ prod auto-deploy) before a staging gate was run — an accidental push. Accepted and kept (no users; the change only tightens previously-open endpoints; `getClaims()` network-fallback works without asymmetric keys). **Prod smoke GREEN 2026-06-23** — logged-in send on the live URL → `/api/v1/translate` 200, translation rendered, no console errors. The detailed checks below remain valid to run, especially the **no-token / garbage-token 401 negative paths** (not yet explicitly exercised on prod — the proposed `api-auth-gate-test.mjs` will cover them). Asymmetric signing keys are a follow-up perf step (local vs network verification), not a correctness blocker.

**What shipped (on a feature branch, not yet merged):** Every backend engine call now requires a valid Supabase user JWT. New `server/lib/auth.js` (`authenticateRequest` → `{userId}`, `requireAuth` handler helper) verifies the token via `getClaims()` using the **anon** key (`VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`) — no service-role key, no privileged credential on the hot path. Wired into `api/v1/translate.js`, `api/v1/infer-profile.js`, and both `server/index.js` routes. Frontend routes its three calls (detect, translate, infer) through a new `apiFetch()` wrapper in `src/lib/translation.js` that attaches the session access token. `translation_events.user_id` now comes from the verified principal; `tenant_id` stays the sole-tenant constant. See decisions.md 2026-06-23 "Token auth on backend API calls".

### Prerequisite before testing (Isaac, staging first)
1. **Enable Supabase asymmetric JWT signing keys** on `translationapp1-staging` (Project Settings → JWT Keys → **Migrate JWT secret** → **Rotate keys**; do **not** revoke the legacy secret). Non-destructive, reversible; existing sessions keep working. This is what makes `getClaims()` verify locally. (Code also works via network fallback, but test against the intended local-verify path.)
2. **No new Vercel env var needed** — the helper uses `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`, already present in the Preview env. (Confirmed 2026-06-23: Preview has exactly `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `OPENAI_API_KEY`, `DATABASE_URL_PROFILE_WRITER`, `DATABASE_URL_PROD_WRITER` — no `SUPABASE_SERVICE_ROLE_KEY`, and the auth helper no longer needs it.)
3. For **local** dev, add `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` to `server/.env` (previously only `OPENAI_API_KEY` was needed).

### Verification (run on staging / Vercel Preview)
- [ ] **No token → 401.** `curl -s -o /dev/null -w "%{http_code}" -X POST <preview>/api/v1/translate -H 'Content-Type: application/json' -d '{"text":"hola","mode":"detect"}'` returns **401** (was 200). Same for `/api/v1/translate` translate-mode and `/api/v1/infer-profile`.
- [ ] **Garbage/expired token → 401.** Same call with `-H 'Authorization: Bearer not.a.jwt'` returns **401**.
- [ ] **Valid token → 200.** Sign in as a staging test user, grab the session `access_token` (browser devtools → Application → localStorage, or `supabase.auth.getSession()` in console), call with `-H "Authorization: Bearer <token>"` → **200** with a normal translate/detect body.
- [ ] **End-to-end UI smoke.** Logged-in user sends a message across a language pair → translation renders (translate call carried the token), and a `translation_events` row appears with a **non-null `user_id`** and the correct `tenant_id` (was null/hardcoded). Profile inference still lands on the sender's row.
- [ ] **Logged-out path.** With no session, the app shouldn't be able to translate (the wrapper sends no token → 401) — confirm it fails closed rather than silently translating.

### Proposed gate (follow-up, not yet written)
`scripts/api-auth-gate-test.mjs` in the Step 3/4/5/6 style: mint a real user token via the service-role admin API, assert 401 for no-token / bad-token and 200 for valid-token across all three endpoints, `RLS_TEST_CONFIRM_STAGING=yes`, never prod. (Offered; build if we want this in CI.)

### Known notes / failure modes
| Symptom | Likely cause | Fix |
|---|---|---|
| All calls 401 even with a valid token | Asymmetric keys not enabled and network fallback failing, or `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` missing in the env | Enable asymmetric keys on staging; confirm the two `VITE_` vars exist in the Preview environment |
| 500 "Auth not configured" | `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` unset in this environment | Set both (Preview already has them; local `server/.env` for dev) |
| Local dev: every translate 401s | `server/.env` missing the two `VITE_SUPABASE_*` vars | Add them; restart `node server/index.js` |

---

## Phase 2.2 — Public demo readiness (domain + email + persistent login) — verified 2026-06-23

**What shipped (config, no app-code change):** the app on a real domain, email off the built-in rate cap, and persistent sessions. This is the "shareable with interviewers" milestone (decisions.md 2026-06-23 "Public demo on jistchat.com").

- [x] **Domain** — `https://app.jistchat.com` loads with valid SSL; Supabase Auth Site URL + redirect updated; magic-link round-trip verified landing on `app.jistchat.com`.
- [x] **Email** — Resend on `jistchat.com`: DNS verified, Supabase SMTP configured, Auth email rate limit raised; test magic link delivered from the domain. *Deliverability watch:* on a brand-new sending domain, confirm the first external sends (Gmail/Outlook) land in the inbox, not spam; if not, check the DMARC record.
- [x] **Persistent login** — sessions survive refresh / new tab via Supabase `persistSession` + `autoRefreshToken` defaults (no build).
- [x] **Sign-out control** — DONE 2026-06-23, on prod + smoke-verified: (1) `handleSignOut` `window.confirm`s first; (2) sign-out relocated into a persistent top app bar (mobile + desktop), fixing the "+"/kebab overlap. Confirmed on `app.jistchat.com` (confirm dialog fires; no mobile overlap).
- [x] **Hide empty "ghost" conversations** — DONE 2026-06-23 (`loadConversations` filters message-less conversations except the actively-viewed one; `handleCreateConversation` passes the new id). On prod. *(Recommended follow-up check when convenient: with 2 accounts, confirm an unsent conversation doesn't show for the other member until a message is sent.)*
- [ ] **Share-ready smoke** — sign up 3+ external accounts, run direct + group flows on prod (the flows the Phase 3 cutover deferred behind the old email cap).

See roadmap.md Phase 2.2, decisions.md 2026-06-23, operations.md (topology + deploy runbook).

---

## Translate model swap: gpt-5.4 + prompt v2.0.0 (2026-07-05) — ⏳ gate PENDING on staging

**What shipped:** translate calls moved to `gpt-5.4` (`reasoning_effort` — flat Chat Completions param, not the nested Responses-API shape; no temperature; JSON mode); detect stays `gpt-4o-mini`; naturalness-first prompt rewrite (`PROMPT_VERSION` 2.0.0); model config centralized in `lib/translatePrompt.js`; `vercel.json` `maxDuration: 60` for the translate function; dev-server translate timeout 30s. See decisions.md 2026-07-05.

**Updated 2026-07-07:** effort tuned `medium` → `low` and prompt bumped to **v2.1.0** (two-way casing fidelity, history-referent resolution, no invented gender forms) after two runs of the model-comparison harness (`scripts/model-comparison-test.mjs`; decisions.md 2026-07-07). The gate below covers the combined change; three checks added for the v2.1.0 rules.

**Staging gate run 2026-07-07 — GREEN with one noted flake. Prod rollout complete same day.** Full regression conversation re-run on the Preview (all rows `prompt_version = 2.1.0`, `model_used = 'gpt-5.4'`): casing fidelity confirmed on all five capitalized originals including per-sentence mirroring ("For once in my life!! stop clowning" matches the sender's cap/lowercase split); "tacos de canasta" kept; "no manches" idiom; missing "¿" mirrored; unknown-gender check passed ("¡Qué emoción lo de mañana!" — no forced agreement). Perceived latency ~4s per translation (vs 7–10s at medium). **Known limitation:** the "una vez en la vida" referent case resolves inconsistently at low effort — passed in the harness, missed on staging ("my life" for "your life"). Judged a probabilistic miss on a genuinely ambiguous standalone exclamation, not a broken rule (novel referent probes passed on every candidate). Not a ship blocker; natural Phase 4 corrections-capture target. Merged to `main` 2026-07-07; **regression cases re-run on prod — PASSED.**

**Staging gate (branch push → Vercel Preview against staging Supabase):**

- [ ] **Regression cases (the failures that prompted this).** Two accounts, ES↔EN casual conversation:
  - "no seas payaso" (teasing) → natural teasing English ("stop clowning around" / "don't be ridiculous"), NOT "don't be a clown".
  - "te pedí los tacos de canasta" → keeps "tacos de canasta", NOT "basket tacos".
  - Send 3+ casual English messages without final periods/capitals → Spanish output mirrors the style (no added periods, no formalizing).
  - "jajaja" / "lol" convert to the target-language casual laughter equivalent.
  - **(v2.1.0)** Send properly-capitalized casual/slang messages → output keeps the caps (no "dude i got..." lowercasing).
  - **(v2.1.0)** Send a reaction to the other user's message ("about time!!" style) → translation keeps the referent (about *them*, not the sender).
  - **(v2.1.0)** From an account with no gender set, send "I'm so excited" → Spanish output avoids forced agreement (no "emocionado" default, no "emocionad@"/"emocionade").
- [ ] **JSON contract intact** — translations render in the UI (schema unchanged: translated_text + inferences + ambiguity all parse).
- [ ] **Model routing correct** — `translation_events`: translate rows show `model_used = 'gpt-5.4'`, detect rows show `model_used = 'gpt-4o-mini'`, both with `prompt_version = '2.0.0'`.
- [ ] **Latency acceptable** — check `latency_ms` on translate events; if p50 feels bad in the UI at `medium`, drop `TRANSLATE_REASONING_EFFORT` to `'low'` and re-run this gate.
- [ ] **No timeouts** — no aborted/500 translate calls in Vercel logs (maxDuration 60 took effect; deploy logs show the functions config applied).
- [ ] **Cost sanity** — after the test session, OpenAI usage dashboard shows per-call cost in the expected ~$0.007–0.012 range; nothing runaway.

**Known failure modes:**

| Symptom | Likely cause | Diagnosis |
|---|---|---|
| 400 from OpenAI on translate | `reasoning` param shape or unsupported param (e.g. temperature left in a path) | Vercel function logs: OpenAI error body names the bad param |
| Translate 500s after ~10s on prod but works locally | `vercel.json` functions config not applied (wrong path key) | Vercel deploy output → function config; confirm `api/v1/translate.js` shows maxDuration 60 |
| Quality unchanged | Preview env still hitting old deployment or cached translations | `message_translations.prompt_version` on the new rows — must be 2.0.0; fresh conversation to bypass cache |

**Prod rollout:** merge to `main` after gate passes; re-run the regression cases once on prod.

---

## Username at onboarding — migration 020 (2026-07-07) — ✅ GREEN on staging; PROD ROLLED OUT same day

**What shipped:** onboarding requires a user-chosen username; `complete_onboarding()` replaced (2-arg dropped, 3-arg created with `p_username DEFAULT NULL`) — claims via `change_username()` in the same transaction, atomic with activation; `display_name` control-char/bidi denylist added; `change_username()` replaced to allow self-revert to one's own retired handle. Frontend: username field + "Usernames can be changed once per year" subtext + friendly error mapping. See decisions.md ×2 + operations.md migration list, 2026-07-07.

**Staging gate run 2026-07-07 — GREEN.** Incidental bonus: the deploy-order rule self-validated — the frontend was briefly live before 020 was applied and failed exactly as the failure-modes table below predicted (schema-cache 404), harmless. **Prod rolled out same day:** 020 replayed on prod → `feature/onboarding-username` merged to `main` → confirmed good.

- [x] **Migration verification block** (in-file, 020): exactly one 3-arg `complete_onboarding`; grants = authenticated only.
- [x] **Happy path:** fresh signup → onboarding shows username field → submit valid username → lands in chat; `profiles` row shows `status='active'`, `username` = chosen value, `username_source='user_set'`; old system handle row in `account_identifiers` is `retired`.
- [x] **Taken/reserved:** submit `admin` → inline "taken or reserved" error, still on onboarding screen, profile still `pending` (atomicity — activation rolled back with the failed claim).
- [x] **Invalid:** `ab` (too short) and mixed case → caught client-side before any RPC call.
- [x] **Old-caller compatibility:** 2-named-arg calls resolve via default fill (exercised implicitly during the pre-020 window).
- [x] **Searchable:** username autocomplete finds the new user by their chosen handle from the other test account.
- [x] **Existing users unaffected:** already-active accounts sign straight in (idempotency guard short-circuits before any username logic).
- [ ] **Self-revert probes (SQL-level; no UI exists yet):** NOT RUN — logic reviewed at migration time; verification-block probe 5 in migration 020 is runnable anytime. Natural forcing point: the settings-screen build (the first UI that exposes reverting).

**Known failure modes:**

| Symptom | Likely cause | Diagnosis |
|---|---|---|
| rpc 404 "function not found in schema cache" | 020 not applied, or PostgREST cache stale | Apply 020; NOTIFY pgrst or restart via dashboard |
| "username unavailable" for a fresh handle | value exists in ANY status (retired/reserved lock) | `SELECT status FROM account_identifiers WHERE value = '<name>'` |
| Onboarding succeeds but username unchanged | frontend sent no `p_username` (old bundle cached) | hard-refresh Preview; check request payload in Network tab |
| User active but holds system handle | should be impossible post-020 (atomic) — if seen, transaction boundary broke | check for change_username being called OUTSIDE the RPC |

**Prod rollout:** replay 020 on prod Supabase **before** merging the frontend to `main` (deploy-order-safe: old frontend + new function works; new frontend + old function 404s).

---

## Spec 8 + 9 — Demo-readiness polish (2026-07-07) — ✅ GREEN on staging; merged to main, prod smoke pending

**What shipped:** Spec 8 — `LANGUAGES` in `src/lib/vocabularies.js` expanded from 10 English-exonym entries to ~40, each labeled endonym-first with English in parentheses (e.g. `Español (Spanish)`); wire values (ISO codes) and the `code` field name unchanged, so `App.jsx` and `languageLabel()` needed no edits. Spec 9 — `lucide-react` installed; icons added to core controls across `App.jsx`, `ConversationView.jsx`, `ConversationList.jsx`, `MessageBubble.jsx`, `InviteModal.jsx`, `NewConversationModal.jsx` (back, overflow/register menu, invite, send, new-conversation, Original-expander chevron, invite-modal close/copy, new-conversation-modal close/search, sign-out), existing text labels kept alongside icons. Frontend-only; no schema/migration/API changes. Branch `spec-8-9-demo-polish`, commits `69dc68b` (Spec 8) and `c4eacbc` (Spec 9). See decisions.md 2026-07-07 "Spec 8 + 9 shipped".

- [x] **Onboarding language list:** picker shows ~40 endonym `(English)` labels, common-languages-first, no duplicates.
- [x] **Non-English pick persists:** selected a non-English language (e.g. `日本語 (Japanese)`), completed onboarding, `user_linguistic_profiles.preferred_language` set correctly and received messages translate as expected.
- [x] **Icons render:** back / overflow (⋯) / send / new-conversation / invite / copy / close (both modals) / sign-out / Original-expander all show a lucide icon at consistent size/stroke.
- [x] **Existing labels/tooltips intact:** text-labelled controls (Send, Sign out, Cancel, Copy) kept their text alongside the new icon; no behavior change.
- [x] **All controls still function:** send, new conversation, invite-link copy, back navigation, modal close, sign-out, register/context menu, Original expand/collapse all verified working on the staging Preview.
- [x] **Prod merge:** `spec-8-9-demo-polish` merged (fast-forward) into `main` 2026-07-07, commit `1c37b14`, pushed — Vercel auto-deploying to prod.
- [ ] **Prod smoke:** NOT YET RUN — repeat the two checks above against `https://app.jistchat.com` once the deploy completes.

**Known deviations (not failures):**

| Item | Spec said | Shipped as | Why |
|---|---|---|---|
| Spec 8 `LANGUAGES` field name | `value` | `code` (unchanged) | Spec's own "call sites untouched" acceptance criterion; `value` would've required editing `App.jsx` and `languageLabel()`. |
| Spec 9 settings-entry icon | icon + placeholder | skipped entirely | Settings screen doesn't exist yet (Phase 2.4 checklist item #1, not yet built). |

**Known failure modes:** none encountered. If RTL endonym labels (Arabic/Hebrew/Persian/Urdu + parenthesized English) bidi-reorder oddly in `<option>` text, that's a known cosmetic open question from Spec 8 — not a bug.

---

## How to use this doc

- Before shipping a feature, draft its verification section first. Easier than scrambling after.
- Run through the relevant section in production immediately after deploy.
- Check failures back into the table at the bottom of each section — when something breaks in a way the checklist would have missed, that's data.
- This doc lives alongside the code; if you ever hand the project off, this is the runbook your successor needs.


---

## Changelog

*Reverse chronological. One line per change; project events link to `decisions.md`.*

- **2026-07-07** — Added "Spec 8 + 9 — Demo-readiness polish" section (language-list + lucide icons, staging gate GREEN); updated same day once merged to `main` (commit `1c37b14`). (→ decisions.md 2026-07-07 "Spec 8 + 9 shipped")
- **2026-07-07** — Docs legibility cleanup: added Contents TOC; header de-blobbed; this Changelog added. Also added the "Username at onboarding — migration 020" section (gate GREEN + prod). (→ decisions.md 2026-07-07)
- **2026-07-05** — Added "Translate model swap: gpt-5.4 + prompt v2.0.0" section. (→ decisions.md 2026-07-05)
- **2026-06-23** — Added "Phase 2.1 — Token auth" + "Phase 2.2 — Public demo readiness" sections. (→ decisions.md 2026-06-23)
- **2026-06-18** — Added "Phase 3 — Step 4: Production cutover" (executed). (→ decisions.md 2026-06-18)
- **2026-06-12** — Added Phase 3 Steps 1 / 2 / 2b / 3 sections. (→ decisions.md 2026-06-12)
- **2026-06-11** — Added Step 7 data-deletion + Phase 2 production-cutover sections; Step 6 gate GREEN. (→ decisions.md 2026-06-11)
- **2026-06-10** — Added Phase 2 Steps 2–6 + server-side inference + Step 0 pre-flight sections. (→ decisions.md 2026-06-10)
- **2026-06-09** — Added Phase 2 Step 1 (Identity Foundation) section. (→ decisions.md 2026-06-09)
- **2026-06-03** — Added Hermes Spec 3 (access credentials) section.
- **2026-06-02** — Added Hermes model-routing/Discord + Spec 4a event-log-schema sections.
- **2026-06-01** — Added Hermes Spec 1 (infrastructure) section.
- **2026-05-18** — Added Staging environment section.
- **2026-05-12** — Initial Phase 0 verification section.
