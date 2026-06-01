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

**Last updated:** 2026-06-01 (Hermes infrastructure section added — Spec 1 shipped, including SSH lockout debugging playbook)

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

## How to use this doc

- Before shipping a feature, draft its verification section first. Easier than scrambling after.
- Run through the relevant section in production immediately after deploy.
- Check failures back into the table at the bottom of each section — when something breaks in a way the checklist would have missed, that's data.
- This doc lives alongside the code; if you ever hand the project off, this is the runbook your successor needs.
