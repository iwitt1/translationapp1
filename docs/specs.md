# Translation App — Specs

> Living document. Holds active and recent feature specs in the format described in `/docs/hermes.md` §9.1. One file rather than one-per-spec until volume justifies splitting (estimated ~10-15 specs before needing a `/docs/specs/` folder).
>
> Spec lifecycle: **draft** → **approved** → **in-flight** → **shipped** → **archived**. When a spec ships, mark it `shipped` here with the commit reference and move the verification details to `/docs/verification.md`. Archive specs after one cycle of "shipped" review (typically 2-4 weeks) — move them to a future `/docs/specs-archive.md` if/when this file exceeds ~600 lines.

**Last updated:** 2026-05-21 (Spec 1 status moved to "in-flight (paused)" after session 1 of 2; resume notes added at bottom of spec)

---

## Spec 1 — VPS provisioning + Hermes Agent install

**Linked roadmap item:** Phase 1.5 → Infrastructure (first three checkboxes — provision VPS, install Hermes Agent, pin to a specific version)
**Author:** Isaac (drafted with Cowork, 2026-05-18; execution started 2026-05-21)
**Status:** **in-flight (paused at end of session 1 of 2 — see "Resume notes" at bottom of spec)**
**Estimated time:** 1-1.5 hours original estimate; actual will be ~3 hours across two sessions due to scope corrections discovered during execution

### Goal
Stand up the VPS where Hermes will live, install the Hermes Agent framework on it, verify the install. End state: an SSH-able DigitalOcean droplet running an idle Hermes Agent process, ready for model routing + Discord gateway configuration in Spec 2.

### Acceptance criteria
- DigitalOcean droplet exists: **1GB RAM / 1 vCPU, Ubuntu 22.04 LTS, NYC region** (closest DigitalOcean region to Supabase's `us-east-1`), name `hermes-prod`.
- Daily backup snapshots enabled at provisioning (~$1.20/mo additional). Cost added to `/docs/operations.md` §1 cost model once the first DigitalOcean invoice confirms the actual charge.
- SSH key auth set up — new key generated for this droplet (`~/.ssh/id_ed25519` or similar; Isaac has no existing key per 2026-05-18 check).
- UFW firewall enabled on the droplet with port 22 (SSH) open only.
- Root SSH login disabled; non-root `hermes` user owns the install and has sudo access.
- Hermes Agent v0.2.0 installed at a known path on the droplet (specific path depends on Hermes Agent's install convention; document the choice).
- `hermes-agent --version` (or framework equivalent) returns `v0.2.0`.
- Droplet IP address documented in Isaac's password manager alongside SSH key passphrase.
- `decisions.md` entry drafted by Cowork capturing: provider (DigitalOcean), droplet spec, region (NYC), OS (Ubuntu 22.04 LTS), install path, install method, backup posture. Awaits Isaac's approval before append.

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

### Technical sketch (executed step-by-step in a future Cowork session)
1. **DigitalOcean account setup** (~10 min). Sign up, add payment, create a project called "Translation App."
2. **Generate SSH key on Isaac's Mac** (~5 min). `ssh-keygen -t ed25519` with a passphrase. Save key + passphrase in password manager. Add public key to DigitalOcean account.
3. **Create droplet** (~10 min). Basic / Premium Intel, $6/mo (1GB RAM / 1 vCPU), Ubuntu 22.04 LTS, NYC3 region, name `hermes-prod`, attach the SSH key, enable backups.
4. **Initial server hardening** (~20 min). SSH in as root → create non-root `hermes` user with sudo → copy SSH key to hermes user → disable root SSH login (`/etc/ssh/sshd_config`) → enable UFW with port 22 open → run `apt update && apt upgrade -y`.
5. **Install dependencies** (~10 min). Python 3.11+, git, build tools (`build-essential`). Confirm version requirements against Hermes Agent docs before installing.
6. **Install Hermes Agent v0.2.0** (~15 min). Clone the repo or use the install script per Nous Research docs. Pin to the v0.2.0 release tag. Install to `/home/hermes/hermes-agent/` (subject to confirmation from Hermes Agent install convention).
7. **Verify** (~5 min). `hermes-agent --version` returns v0.2.0. Idle process can be started and stopped cleanly.
8. **Document and decide** (~10 min). Draft the `decisions.md` entry for Isaac's approval. Record droplet IP and any non-default install paths in his password manager.

### Verification plan (becomes a section of `/docs/verification.md` after acceptance)
- [ ] SSH to droplet succeeds from Isaac's Mac as `hermes` user using the generated key
- [ ] `whoami` returns `hermes`
- [ ] `sudo whoami` returns `root` (sudo works)
- [ ] Root SSH login fails (security check — try `ssh root@<ip>`, expect rejection)
- [ ] `sudo ufw status` shows port 22 open, others closed
- [ ] `hermes-agent --version` returns `v0.2.0`
- [ ] DigitalOcean dashboard: droplet status "Running", backups enabled, IP noted
- [ ] No translate-app code touched (this spec is infrastructure-only)

### Failure-mode preview (added to verification.md after shipping)
| Symptom | Likely cause | Fix |
|---|---|---|
| Can't SSH after droplet creation | SSH key not attached during droplet creation, or sshd not yet ready | Wait 2 min and retry; or use DigitalOcean web console to add key manually |
| Hermes Agent install fails on Python version | Ubuntu 22.04 ships Python 3.10; Hermes Agent may need 3.11+ | Install Python 3.11 from deadsnakes PPA or use pyenv |
| UFW blocks SSH and locks Isaac out | UFW enabled before allowing port 22 | Use DigitalOcean web console (browser-based SSH) to disable UFW and reconfigure |
| `hermes-agent --version` not found | Install path not in `PATH`, or binary named differently in v0.2.0 | Check Hermes Agent docs for actual command name; symlink to `/usr/local/bin/` if needed |

### Resume notes (session 1 stopped 2026-05-21)

Execution paused because we ran over the 1.5-hour time budget and hit an unexpected lockout that needs a fresh session to resolve. State of the droplet at pause:

**Droplet exists and is at IP `167.71.161.145`:**
- DigitalOcean droplet `hermes-prod` created in NYC datacenter.
- Spec specs (1 GB / 1 vCPU / Ubuntu 22.04 LTS) — confirmed.
- Actual cost: **$9.60/mo** ($8 droplet + $1.60 backups), not the spec's $6/$7.50 estimate. DO raised prices since spec was drafted. SSD is 35 GB, not 25 GB. Update `operations.md` §1 with the real number once first invoice confirms.
- Backups: **weekly** (DO's product). The original AC wording said "daily" — that was wrong; the answer to open question 3 said "weekly" — that was right. Patch AC wording when marking shipped.

**Hardening done:**
- `hermes` user created with sudo group. Password set and saved in Isaac's password manager.
- SSH key copied to `/home/hermes/.ssh/authorized_keys` with `chmod 700` on the dir and `chmod 600` on the file. SSH as `hermes` was verified working in step B.3.
- Root SSH disabled (`PermitRootLogin no` in `/etc/ssh/sshd_config`). Verified rejecting connections in step B.5.
- UFW enabled with port 22 open only. Verified in step B.6.
- `apt update && apt upgrade -y` completed; droplet rebooted.

**Current breakage (to debug at start of session 2):**
- `ssh hermes@167.71.161.145` fails with `Permission denied (publickey)` even with the correct SSH key passphrase. Something between the pre-reboot verified-working state and the post-reboot state broke hermes's key auth. Most likely culprits: file perms on `/home/hermes/.ssh/` mangled by upgrade/reboot, or `authorized_keys` contents altered. Will not know until we can inspect from inside the droplet.
- DigitalOcean's web console fails with `All Configured authentication methods failed`. Strong suspicion this is because DO's console uses SSH under the hood with the `root` account, and our `PermitRootLogin no` change blocks it. The spec doesn't address this; we need to set a root password (`sudo passwd root`) before disabling root SSH in any future provisioning, so DO's console retains a fallback auth path.

**Next session resume steps (in order):**
1. **Get console access back.** Reset root password via DO dashboard → droplet → Access → "Reset Root Password." DO emails a temp password. Then either (a) try the web console again with root + new password, or (b) use DO's Recovery Console (boots a rescue image, independent of droplet SSH config).
2. **Diagnose hermes SSH failure** by running these from inside the console:
   - `ls -la /home/hermes/.ssh/`
   - `cat /home/hermes/.ssh/authorized_keys`
   - `grep -E '^(PermitRootLogin|PasswordAuthentication|PubkeyAuthentication|AllowUsers|AllowGroups)' /etc/ssh/sshd_config`
   - `sudo journalctl -u ssh -n 30 --no-pager`
3. **Fix the auth issue** — most likely a permissions reset (`chown -R hermes:hermes /home/hermes/.ssh && chmod 700 /home/hermes/.ssh && chmod 600 /home/hermes/.ssh/authorized_keys`).
4. **Set root password** (`sudo passwd root`) so DO console works going forward. Save password to password manager.
5. **Verify SSH as hermes works AND DO console works** before proceeding.
6. **Continue with Phase C** (Chromium / Playwright system deps as root) and **Phase D** (install Hermes Agent v0.14.0 / 2026.5.16 — confirm exact PyPI version string at install time via `pip index versions hermes-agent`).
7. **Phase E** (docs): patch this spec's wording in all the places we found drift, mark shipped with commit ref, append decisions.md entry (draft for Isaac's approval first), draft verification.md "Hermes infrastructure" section from this spec's verification plan, mark Phase 1.5 checkboxes in roadmap.md.

**Spec wording fixes to apply when marking shipped (do not patch piecemeal; do it as part of the same commit that moves status → shipped):**
- AC line 23: "Daily backup snapshots" → "Weekly backup snapshots" (DO's product is weekly).
- AC line 28: `hermes-agent --version` → `hermes --version` (actual CLI binary is `hermes`).
- AC line 27 + technical sketch step 6: "v0.2.0" → "v0.14.0 / git tag `v2026.5.16`" (charter's v0.2.0 was speculative; doesn't exist on GitHub).
- AC line 22 cost figure (~$6 spec assumption): update to **$9.60/mo** ($8 droplet + $1.60 backups; 35 GB SSD).
- Technical sketch step 6 install path: `/home/hermes/hermes-agent/` → `/home/hermes/.hermes/hermes-agent/` (which is `~/.hermes/hermes-agent/` for the hermes user — same place, correct framework convention).
- Add a new AC: "Root password set (saved in password manager) so DO's web console retains a fallback auth path after `PermitRootLogin no`."
- Add to technical sketch a new step between current 4 and 5: "Set a strong root password via `sudo passwd root`. Save to password manager. Required so DO's web console doesn't lose access when SSH is locked down."

**Charter changes triggered (handle in same commit as spec ship):**
- `hermes.md` §12 Day 7 and §13 open question 1 reference "v0.2.0" — update to "v0.14.0 / git tag `v2026.5.16`."
- `roadmap.md` Phase 1.5 references "v0.2.0" — update.
- Add a `decisions.md` entry covering: (a) DigitalOcean as VPS provider with rationale, (b) the v0.2.0 → v0.14.0 correction with rationale, (c) the "set root password before locking SSH" pattern as a learned safeguard.

---

*(Future specs will be added below as drafted. Newest at top within a section; section order: draft → approved → in-flight → shipped.)*
