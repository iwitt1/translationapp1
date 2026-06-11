# Translation App — Phase 2 Implementation Spec & Sonnet Prompt

> Working spec for Phase 2 ("Multi-user safety"). The design decisions are already made and
> documented elsewhere; this file is the **plan of attack** (build order + test gates) plus a
> **paste-ready prompt** for the Sonnet session that does the implementation.
>
> **Model split:** Opus authored this plan and owns hard/ambiguous calls. Sonnet executes the
> steps. Three sub-tasks are flagged below to escalate back to Opus if Sonnet hits ambiguity.
>
> **Where the decisions live:** `policies.md` (the spec for identity/discovery/safety/lifecycle),
> `architecture.md` §7 (Phase 2 tables, uniqueness scope, three-layer policy storage) and §10 (the
> breaking cutover), `roadmap.md` Phase 2 (the checklist), `decisions.md` (the five 2026-06-09
> entries = the *why*), `operations.md` §3 (migration workflow) and §6 (policy review cadence).

**Created:** 2026-06-09

---

## Progress (updated 2026-06-11)

- **Step 0 — Pre-flight:** done. `lib/policies.js` scaffolded; config audit captured; branch→Preview→staging wiring confirmed.
- **Step 1 — Identity foundation:** done. Migration `007` shipped (profiles, account_identifiers, account_settings, `auth_tenant_id()`, `handle_new_user()` trigger, RLS). Gate passed on staging.
- **Step 2 — Auth + onboarding:** done. Migration `008` (text→uuid identity cutover, `complete_onboarding()` RPC, RLS on messages/message_translations/ulp/upe) + magic-link auth + onboarding in `App.jsx`. **Gate PASSED on staging 2026-06-10** (full signup→onboard→active flow for two users). Migration `009` restores the `nonbinary` gender signal 008 dropped.
- **Step 3 — RLS adversarial gate:** done. **PASSED on staging 2026-06-10 — 21/21 GREEN** via `scripts/rls-adversarial-test.mjs` (cross-user read/write denial, self-write escalation denial, cross-tenant isolation).
- **Step 4 — Discovery:** done. Migration `010` (3 SECURITY DEFINER RPCs — `find_account_by_email`, `search_accounts_by_username`, `change_username` — + username-prefix index). **Gate PASSED on staging 2026-06-10 — 22/22 GREEN** (re-passed after 011's block-filter amend).
- **Step 5 — Social graph + safety:** done. Migration `011` (canonical-pair `relationships`, `blocks`, `reports`, `invites`, `invite_redemptions`, `email_hash_abuse` + 9 SECURITY DEFINER RPCs). **Gate PASSED on staging 2026-06-10 — 40/40 GREEN.**
- **Step 6 — Abandonment + abuse monitoring:** done. Migration `012` (two service_role-only helpers) + `server/lib/abandonment.js` sweep + `api/v1/jobs/abandonment.js` Vercel cron + `vercel.json` + `scripts/abandonment-gate-test.mjs`. **Gate PASSED on staging 2026-06-11 — 19/19 GREEN** (a dry-run counter bug was fixed first). Re-prompt emails **parked → future CRM**.
- **Separable workstream — server-side profile inference:** done. `POST /api/v1/infer-profile` + `server/lib/inferProfile.js`. **Gate PASSED on staging 2026-06-10.** See decisions.md / verification.md.
- **Step 7 — Data deletion / Right to Erasure:** **written, gate PENDING on staging.** Migration `013` (`data_deletion_requests` table + RLS + 6 RPCs: `request_account_deletion`, `cancel_account_deletion`, `list_due_deletion_requests`, `claim_deletion_request`, `complete_deletion_request`) + `server/lib/deletion.js` sweep + `api/v1/jobs/deletion.js` second Vercel cron (09:00 UTC) + `vercel.json` + `scripts/deletion-gate-test.mjs`. Two-phase soft-delete → 30-day grace → cron hard-delete; content **de-identified not deleted** (`messages.sender_id` ON DELETE SET NULL); audit row survives its own erasure (`data_deletion_requests.user_id` ON DELETE SET NULL); abuse HMAC recorded on voluntary erasure too (shared with abandonment; source split parked). `translation_corrections` not built yet → corrections-anonymize is a logged no-op. **GATE (run on staging):** a test deletion removes the account + PII cascade, the planted message survives with `sender_id=NULL`, and the audit row survives `completed`. See decisions.md 2026-06-11.
- **→ NEXT: run the Step 7 gate on staging** (`scripts/deletion-gate-test.mjs`, `RLS_TEST_CONFIRM_STAGING=yes`, needs `ANON_KEY`). After it's green, the **Phase 2 prod cutover** (replay 007–013 against prod in order, set the Vercel Production env vars the crons need, verify) is the next milestone — a deliberate, coordinated event, not implicit.

**Migrations shipped so far: 007–013 — all staging-only; prod has run none of them (prod replay is the Phase 2 cutover, which lands after the Step 7 gate is green). Next migration prefix is `014_`.**

---

## Governing principles

1. **Dependency order, deny-by-default, a test gate between every component.** Nothing advances
   to the next piece — and nothing touches prod — until the current piece passes on staging.
2. **Migration workflow (operations.md §3):** numbered forward-only migration (007–009 shipped;
   next prefix is `010_`) → run on staging → verify with embedded queries → app changes → staging
   smoke + adversarial test → *only then* replay on prod.
3. **Every table ships with its RLS policies in the same migration**, deny-by-default. RLS is
   greenfield (none exists today); get it right at table creation rather than bolting it on.
4. **Keep `lib/policies.js` (machine defaults) in sync with `policies.md` (human source).**
   Per-tenant overrides read from `tenants.dm_initiation_policy`.
5. **`tenant_id` everywhere**, with the uniqueness scopes from architecture.md §7 (uuid /
   tenant_id / invite-token global; username within-tenant; display_name not unique).
6. **Seed test users through the real magic-link flow** so the P1 `auth.users` trigger runs — do
   not raw-insert profiles.
7. **Staging is wiped at Phase 2 start**, so the `text → uuid` identity change is a fresh build,
   NOT a data migration. This de-risks the scariest item.

---

## Build order (one component at a time; each has a test gate)

**Step 0 — Pre-flight (no schema yet).** Audit Supabase config living outside `/migrations/`
(roadmap line 106 — RLS, triggers, publications, extensions). Scaffold `lib/policies.js` as the
machine mirror of policies.md. Confirm branch → Vercel Preview → staging wiring.
*Gate:* audit findings captured as a migration or noted; staging confirmed empty.

**Step 1 — Identity foundation.** `profiles` (`id = auth.users.id`), the `auth.users` insert
trigger (creates pending profile + `system_generated` username + email identifier),
`account_identifiers`, `account_settings`, `tenants.dm_initiation_policy` column. RLS on each.
*Gate:* migration replays clean on empty staging; a test signup fires the trigger and produces a
correct pending row.
**→ Escalate to Opus if stuck:** the `text → uuid` cutover and the `auth.users` insert trigger
design. Hard to reverse and easy to get subtly wrong; if anything is ambiguous, stop and flag for
an Opus session rather than guessing.

**Step 2 — Auth + onboarding (app layer).** Magic-link via Supabase Auth; onboarding screen
(display name + language); P1 → P3 status transitions; remove the in-chat language selector (keep
the context/register dropdown). Note: P2 (clicked-but-not-onboarded) is inferred from
`auth.users.last_sign_in_at`, not logged (policies.md §6).
*Gate:* full signup → onboard → active flow works on staging for two test users; pending account
exists at P1; P3 flips to active.

**Step 3 — RLS adversarial gate.** With identity + auth in place, run the dedicated cross-user
test: user A cannot read user B's data via direct Supabase calls with their own token; tenant
scoping holds.
*Gate:* the adversarial test fails to leak. **Hard stop** — do not build discovery/social on an
unverified base.
**→ Escalate to Opus if stuck:** RLS policy correctness. Tenant-scope-on-top-of-user-scope is
subtle and a wrong policy silently leaks data. If a policy's correctness is unclear, flag for Opus.

**Step 4 — Discovery.** Username policy enforcement (within-tenant uniqueness, reserved-word
blocklist, 1-change/365-days, first-claim-free, system-generated default), exact-match add by
email/username, username autocomplete, **handle minimization enforced in the query/API** (not just
the UI).
*Gate:* email search is impossible; the adder sees only the handle they used; username rules
enforced.

**Step 5 — Social graph + safety.** `relationships` (with `via_identifier_type` provenance),
`blocks` (`unblocked_at` + partial unique index), `reports` (auto-creates a block), `invites` +
`invite_redemptions`, and DM-initiation enforcement (sole tenant → mutual-acceptance-only, reading
`lib/policies.js` defaults + tenant override).
*Gate:* mutual-acceptance default holds; a block prevents initiation in both directions; a report
creates a block; invite redemption works.
**→ Escalate to Opus if stuck:** the DM-initiation enforcement logic (resolving global defaults vs.
per-tenant override vs. mutual-acceptance). If the resolution order or conflict handling is
ambiguous, flag for Opus.

**Step 6 — Abandonment + abuse monitoring.** Scheduled job: re-prompt pending accounts, delete
abandoned ones after 30 days, release the system-generated username, record an email **hash** (not
plaintext) in the abuse-monitoring table.
*Gate:* a simulated 30-day-old pending account is deleted, its username released, its hash recorded
— no plaintext PII retained.

**Step 7 — Data deletion.** `data_deletion_requests` table + an anonymizing job (strip user_id and
PII, keep translation pairs).
*Gate:* a test deletion anonymizes corrections while the translation pairs survive.

**Separable workstream — server-side profile inference.** The `applyInferences` migration off the
client (roadmap "Profile inference" subsection) is listed in Phase 2 but is largely independent of
the identity work. Slot it last, or run it in parallel after Step 1 — just don't let it block the
identity/RLS critical path.

Only after a component's gate is green do you replay its migration against **prod** and re-verify
there.

---

## Sonnet prompt (paste-ready)

```
You are implementing Phase 2 ("Multi-user safety") of the Translation App — a
real-time multilingual chat app. Phase 2 adds real auth, identity, discovery, a
social graph, and row-level security. ALL design decisions are already made and
documented; your job is implementation, not redesign. Where you think a decision
is wrong or ambiguous, STOP and ask — do not silently deviate.

== SESSION START ==
For THIS session everything is already up to date (the repo was just pushed) and
there are no /docs/cowork-handoff.md updates to action — skip the pull/handoff
check. (Automated git-pull on session start is not yet wired up with credentials,
so don't rely on it.) Before writing any code, read these in order:
   - /docs/policies.md  — trust & safety / identity governance (THE spec for
     usernames, discovery, DM-initiation, blocking, anti-abuse, P1-P4 lifecycle)
   - /docs/architecture.md §7 (Phase 2 tables, uniqueness scope, three-layer
     policy storage) and §10 (the migration is a coordinated BREAKING cutover)
   - /docs/roadmap.md Phase 2 (the checklist you're executing)
   - /docs/decisions.md — the five 2026-06-09 entries (identity-vs-discovery /
     Model A, username policy, social-graph primitives, policies.md, onboarding
     lifecycle). These are the WHY behind everything.
   - /docs/operations.md §3 (migration workflow) and §6 (policy review cadence)
   - /docs/phase2-implementation.md (this plan — full build order + test gates)

== GROUND RULES ==
- Migration workflow (operations.md §3): write a numbered forward-only migration
  (007–009 shipped; next prefix is 010_), run on STAGING first, verify with embedded queries, make
  app changes, smoke-test on staging, then — only after the gate passes — replay
  on PROD. Never touch prod before staging is green.
- Every table ships with its RLS policies IN THE SAME migration, deny-by-default.
  RLS is greenfield (none exists today); get it right at creation.
- Keep lib/policies.js (machine defaults) in sync with policies.md (human source).
  Per-tenant overrides read from tenants.dm_initiation_policy.
- tenant_id everywhere; uniqueness scopes per architecture.md §7 (uuid/tenant/
  invite-token global; username within-tenant; display_name not unique).
- Seed test users via the real magic-link flow so the P1 auth.users trigger runs;
  do not raw-insert profiles.
- Update the relevant /docs in the SAME commit as the change they describe. New
  non-trivial decisions → decisions.md (date + reasoning). New deferred ideas →
  parking-lot.md. Don't create new doc files without a decisions.md entry.
- Staging is wiped at Phase 2 start: the text→uuid identity change is a fresh
  build, NOT a data migration.
- DO NOT commit or push. Isaac commits and pushes (Claude does not yet have those
  permissions). Stage your work and hand back the diff + a suggested commit message.

== BUILD ORDER (one component at a time; each has a TEST GATE; do not advance
   until the gate passes on staging) ==
Step 0 — Pre-flight: audit Supabase config outside /migrations/ (roadmap line
  106); scaffold lib/policies.js; confirm branch→Preview→staging wiring.
Step 1 — Identity foundation: profiles (id=auth.users.id), auth.users insert
  trigger (pending profile + system_generated username + email identifier),
  account_identifiers, account_settings, tenants.dm_initiation_policy column;
  RLS on each. GATE: clean replay on empty staging; trigger produces a correct
  pending row on a test signup.
  ESCALATE TO OPUS if the text→uuid cutover or the auth.users trigger design is
  ambiguous — hard to reverse, easy to get subtly wrong.
Step 2 — Auth + onboarding: magic-link auth; onboarding screen (display name +
  language); P1→P3 status transitions; remove in-chat language selector (keep
  context dropdown). P2 is inferred from auth.users.last_sign_in_at, not logged.
  GATE: full signup→onboard→active flow for two test users.
Step 3 — RLS adversarial gate: user A cannot read user B's data via direct
  Supabase calls with their token; tenant scoping holds. HARD STOP if it leaks.
  ESCALATE TO OPUS if any RLS policy's correctness is unclear — a wrong policy
  silently leaks data.
Step 4 — Discovery: username policy enforcement (within-tenant uniqueness,
  reserved blocklist, 1 change/365d, first-claim-free, system-gen default);
  exact-match add by email/username; username autocomplete; handle minimization
  enforced in the query/API. GATE: no email search; adder sees only the handle
  used; username rules hold.
Step 5 — Social graph + safety: relationships (via_identifier_type provenance),
  blocks (unblocked_at + partial unique index), reports (auto-creates block),
  invites + invite_redemptions, DM-initiation enforcement (sole tenant =
  mutual-acceptance-only). GATE: mutual-acceptance holds; block blocks both
  directions; report creates block; invite redemption works.
  ESCALATE TO OPUS if the DM-initiation enforcement logic (global default vs.
  per-tenant override vs. mutual-acceptance resolution) is ambiguous.
Step 6 — Abandonment + abuse: scheduled job to re-prompt pending, delete
  abandoned after 30 days, release the system username, record an email HASH
  (not plaintext) in the abuse table. GATE: a simulated 30-day pending account
  is deleted, username released, hash recorded.
Step 7 — Data deletion: data_deletion_requests table + anonymizing job (strip
  user_id/PII, keep translation pairs). GATE: deletion anonymizes corrections,
  pairs survive.

== ESCALATION SUMMARY (stop and flag for an Opus session, don't guess) ==
1. The text→uuid identity cutover and the auth.users insert trigger (Step 1).
2. RLS policy correctness — tenant-scope on top of user-scope (Step 3).
3. DM-initiation enforcement logic (Step 5).
These are security-critical or hard to reverse. For anything else, proceed.

== OUTPUT PER STEP ==
For each step: the migration file(s), the app/code changes, the verification
queries you ran and their results on staging, and a one-line note of what doc
you updated. Then pause for approval before promoting to prod and before
starting the next step. Do not commit or push — hand the diff back to Isaac.
```
