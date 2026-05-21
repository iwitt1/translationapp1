# Translation App — Specs

> Living document. Holds active and recent feature specs in the format described in `/docs/hermes.md` §9.1. One file rather than one-per-spec until volume justifies splitting (estimated ~10-15 specs before needing a `/docs/specs/` folder).
>
> Spec lifecycle: **draft** → **approved** → **in-flight** → **shipped** → **archived**. When a spec ships, mark it `shipped` here with the commit reference and move the verification details to `/docs/verification.md`. Archive specs after one cycle of "shipped" review (typically 2-4 weeks) — move them to a future `/docs/specs-archive.md` if/when this file exceeds ~600 lines.

**Last updated:** 2026-05-18 (file created; Spec 1 — VPS provisioning + Hermes Agent install — added in draft state)

---

## Spec 1 — VPS provisioning + Hermes Agent install

**Linked roadmap item:** Phase 1.5 → Infrastructure (first three checkboxes — provision VPS, install Hermes Agent, pin to v0.2.0)
**Author:** Isaac (drafted with Cowork, 2026-05-18)
**Status:** **draft** (awaiting Isaac approval before execution)
**Estimated time:** 1-1.5 hours in one continuous session

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

---

*(Future specs will be added below as drafted. Newest at top within a section; section order: draft → approved → in-flight → shipped.)*
