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

**Last updated:** 2026-06-10 (Phase 2 Step 1 schema checks 1–6 + 8 and the trigger smoke test confirmed on staging; check A#7 — RLS policies exist — still to run. Prior update 2026-06-09: Phase 2 Step 1 + Step 0 sections added)

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

## Phase 2 — Step 3: RLS Adversarial Gate (placeholder — fill in at build)

**What this step does:** With identity + auth in place, verifies that RLS actually holds under
adversarial conditions. Hard stop — do not build discovery/social on an unverified base.

**Gate:** Both test categories below must pass. Step 4 cannot start until they do.

### Test category A — Cross-user READ isolation
Standard cross-user test: user A authenticates and attempts to read user B's data via direct
Supabase client calls using their own JWT. All attempts must be denied or return 0 rows.

Queries to run as user A (use Supabase JS client with user A's session token):
- `SELECT * FROM profiles` → expect: only user A's own row (one row)
- `SELECT * FROM account_identifiers` → expect: only user A's own rows (email + username)
- `SELECT * FROM account_settings` → expect: only user A's own row
- `SELECT * FROM messages` → (once RLS is on messages in Step 3) expect: scoped to tenant

### Test category B — Self-write COLUMN escalation (added from Opus review of migration 007)
User A authenticates and attempts to PATCH columns on their OWN profile that should be
write-restricted. All attempts must be rejected by the column-level grant.

Attempts to make as user A via PostgREST/Supabase client:
```js
// All of these should fail with "permission denied" or similar
await supabase.from('profiles').update({ is_verified: true }).eq('id', userA.id)
await supabase.from('profiles').update({ status: 'active' }).eq('id', userA.id)
await supabase.from('profiles').update({ username: 'admin' }).eq('id', userA.id)
await supabase.from('profiles').update({ username_source: 'user_set' }).eq('id', userA.id)
```

Only `display_name` updates should succeed:
```js
// This should succeed
await supabase.from('profiles').update({ display_name: 'Test Name' }).eq('id', userA.id)
```

**Why this test exists:** RLS policies scope rows, not columns. Migration 007 added a
`REVOKE UPDATE / GRANT UPDATE (display_name)` block specifically because without it, a user
could POST-gREST-patch `is_verified=true` to self-verify. This test confirms those grants are
in place and survive any future migration that touches the profiles table.

*(Full verification queries to be written when Step 3 is built.)*

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

## How to use this doc

- Before shipping a feature, draft its verification section first. Easier than scrambling after.
- Run through the relevant section in production immediately after deploy.
- Check failures back into the table at the bottom of each section — when something breaks in a way the checklist would have missed, that's data.
- This doc lives alongside the code; if you ever hand the project off, this is the runbook your successor needs.
