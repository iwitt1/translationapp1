# Translation App — Specs

> Living document. Holds active and recent feature specs in the format described in `/docs/hermes.md` §9.1. One file rather than one-per-spec until volume justifies splitting (estimated ~10-15 specs before needing a `/docs/specs/` folder).
>
> Spec lifecycle: **draft** → **approved** → **in-flight** → **shipped** → **archived**. When a spec ships, mark it `shipped` here with the commit reference and move the verification details to `/docs/verification.md`. Archive specs after one cycle of "shipped" review (typically 2-4 weeks) — move them to a future `/docs/specs-archive.md` if/when this file exceeds ~600 lines.

**Last updated:** 2026-06-01 (Spec 1 shipped — see `verification.md` "Hermes infrastructure — Spec 1 (2026-06-01)" for full verification record)

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
