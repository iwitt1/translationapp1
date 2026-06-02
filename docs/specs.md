# Translation App — Specs

> Living document. Holds active and recent feature specs in the format described in `/docs/hermes.md` §9.1. One file rather than one-per-spec until volume justifies splitting (estimated ~10-15 specs before needing a `/docs/specs/` folder).
>
> Spec lifecycle: **draft** → **approved** → **in-flight** → **shipped** → **archived**. When a spec ships, mark it `shipped` here with the commit reference and move the verification details to `/docs/verification.md`. Archive specs after one cycle of "shipped" review (typically 2-4 weeks) — move them to a future `/docs/specs-archive.md` if/when this file exceeds ~600 lines.

**Last updated:** 2026-06-01 (Spec 2 drafted and approved; Spec 1 shipped earlier same day. Section order: approved → shipped.)

---

## Spec 2 — Hermes Agent model routing + Discord gateway

**Linked roadmap item:** Phase 1.5 → Infrastructure (checkboxes 3 and 4 — configure tiered model routing; wire up one messaging gateway)
**Author:** Isaac (drafted with Cowork, 2026-06-01)
**Status:** **approved 2026-06-01** (open-question answers locked; ready to enter `in-flight` when execution session starts)
**Estimated time:** 1.5–2 hours including smoke tests and a 24-hour cost-cap observation window before status → shipped

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

### Open questions (resolved 2026-06-01)
1. **AI provider** — *Resolved:* **Anthropic direct**. Switching to OpenRouter remains a config-only change later if we want to A/B-test providers.
2. **Cost caps for first 72 hours** — *Resolved:* **Conservative** ($1/day soft, $3/day hard). Raise to charter §6.5 defaults via follow-up decisions.md entry once signal is in.
3. **Where the API key lives** — *Resolved:* **Option B**, `~/.hermes/.env` (mode 600), referenced from config.yaml as `${ANTHROPIC_API_KEY}`.
4. **Private Discord server or DM-only** — *Resolved:* **Private server with a dedicated channel** (e.g. `#hermes-prod`).
5. **Exact model strings** — *Defer to execution.* Confirm what `hermes model` accepts at run time; document the chosen strings in the spec before status → shipped.
6. **Single-user identity verification config** — *Defer to execution.* Confirm the exact config key during `hermes gateway setup`; document.
7. **Smoke-test trigger for Opus escalation** — *Defer to execution.* Pick a deterministic trigger (likely a tier-override on a test-agent config) once the per-agent tier mechanism is in front of us.

### Technical sketch (single Cowork+Isaac session, supervised execution)
1. **Anthropic API key obtained** (~5 min, Isaac side). If no Anthropic console account yet: sign up at console.anthropic.com, add payment, generate API key tagged "hermes-prod". Save key + console login to password manager.
2. **Discord bot created** (~10 min). discord.com/developers/applications → New Application → name "Hermes-prod" (or Isaac's choice). Bot tab → enable Bot → disable "Public Bot" → enable "Message Content Intent" → Reset Token → copy to password manager.
3. **Private Discord server created** (~5 min, Isaac side). Discord client → "Add a Server" → "Create My Own" → name "Hermes" → create one channel `#hermes-prod`. OAuth2 → URL Generator with `bot` + `applications.commands` scopes plus the permissions Hermes docs specify; visit URL; authorize bot into the server.
4. **Env vars on droplet** (~5 min). SSH as hermes → `nano ~/.hermes/.env` with `ANTHROPIC_API_KEY=...` and `DISCORD_BOT_TOKEN=...` → `chmod 600 ~/.hermes/.env`. Wire env into Hermes Agent per the framework's convention (likely a `dotenv` reference in config.yaml; confirm at hermes-agent.nousresearch.com/docs).
5. **Run `hermes model`** (~5 min). Select Anthropic provider; pick `claude-sonnet-4-6` (or the exact string Hermes Agent v0.14.0 expects — see open question 5). Confirm with `hermes config show` or equivalent.
6. **Run `hermes gateway setup` for Discord** (~10 min). Walk the interactive prompts. Provide bot token. Set the allowed user IDs to Isaac's Discord ID only (per open question 6 resolution).
7. **Configure cost caps** (~5 min). Set per-day soft/hard caps in Hermes's config (whatever the v0.14.0 mechanism is — likely a `limits:` block in config.yaml). $1/$3 for first 72 hours.
8. **Persistent service via systemd** (~10 min). Write `/etc/systemd/system/hermes-agent.service` (Type=simple, Restart=on-failure, User=hermes, EnvironmentFile=`~/.hermes/.env`, ExecStart=`/home/hermes/.hermes/venv/bin/hermes gateway start` or equivalent per docs). `systemctl daemon-reload && systemctl enable --now hermes-agent`. Verify `systemctl status hermes-agent` shows active.
9. **Smoke test 1: version check** (~5 min). DM bot "what's your version?". Verify response, billing post, clean logs.
10. **Configure Opus escalation tier** (~10 min). Edit config.yaml per Hermes Agent's per-agent tier docs. Map the §3 escalation triggers to a tier override that routes to Opus (`claude-opus-4-6` or current equivalent).
11. **Smoke test 2: escalation** (~5 min). Trigger a known-escalation task. Verify Opus turn → Sonnet turn in billing.
12. **24-hour cost observation window** (passive). Note observed daily total; if under $1, raise to charter defaults with a follow-up decisions.md entry; if at the cap and apparently due to a runaway loop, debug before status → shipped.
13. **Document and decide** (~20 min). Draft decisions.md entries (provider, cost-cap conservative posture, private-server posture), draft verification.md "Hermes model routing + Discord gateway (date)" section, mark roadmap.md Phase 1.5 checkboxes 3 and 4, move spec status → shipped with commit ref.

### Verification plan (becomes a section of `/docs/verification.md` after acceptance)
- [ ] Discord bot shows "Online" in your private server and responds to a DM within 10 seconds
- [ ] `journalctl -u hermes-agent -n 50` shows clean startup; no token or auth errors
- [ ] `hermes config show` (or equivalent) reports the pinned Sonnet model as default
- [ ] Anthropic dashboard: at least one call posted; smoke-test cost <$0.10 per turn
- [ ] A message from a non-Isaac Discord user ID is logged but not acted on
- [ ] systemd service: `systemctl status hermes-agent` shows `active (running)`; service restarts on boot (verify with `sudo reboot && sleep 60 && ssh && systemctl status`)
- [ ] First 24 hours of Discord traffic totals under tightened cost caps ($1/day)
- [ ] No secrets in tracked files: `git status` clean, `grep -r ANTHROPIC_API_KEY .` shows only documentation refs, same for `DISCORD_BOT_TOKEN`
- [ ] `~/.hermes/.env` has mode 600 (owner read/write only)
- [ ] Sample Opus-escalation prompt resolves through Opus on first turn, Sonnet on follow-up

### Failure-mode preview (added to verification.md after shipping)
| Symptom | Likely cause | Fix |
|---|---|---|
| Bot shows online but never responds to DMs | Message Content Intent not enabled in Developer Portal | Bot page → Privileged Gateway Intents → toggle on, Save Changes, restart `hermes-agent` |
| `hermes gateway setup` fails with "invalid token" | Token copied with trailing whitespace, or token was reset after copy | Reset Token in Developer Portal, recopy carefully, re-run setup |
| 401 from Anthropic on first call | API key not in env vars where Hermes can read; key has no billing enabled | Verify `~/.hermes/.env` permissions and contents; check Anthropic console billing |
| Hermes responds but billing posts Opus when expected Sonnet | Tier override config wrong; model name typo'd | Re-check config.yaml; `hermes config show` to confirm default; clear cached state |
| Daily cost spike beyond cap | Retry loop / stuck escalation / runaway prompt | Hard cap should auto-pause; manual fallback: `systemctl stop hermes-agent` and investigate logs |
| Slash commands missing in Discord | Gateway never registered them; another follower gateway took registration | `hermes gateway setup` again with slash registration enabled; ensure no second Hermes gateway pointing at same bot |
| Hermes drops offline after droplet reboot | systemd unit not enabled, or `EnvironmentFile` path wrong | `systemctl enable hermes-agent`; verify `~/.hermes/.env` referenced correctly; check `journalctl -u hermes-agent -b` |
| `hermes model` rejects the model string | Hermes Agent v0.14.0 expects a different format (dot vs hyphen, prefixed vs bare) | Try `claude-sonnet-4-6`, `claude-sonnet-4.6`, `anthropic/claude-sonnet-4.6` in that order; document the working format in this spec before status → shipped |

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
