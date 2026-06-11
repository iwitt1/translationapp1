# Translation App — Operations

> Living document. Owns cost model, hiring plan, development workflow, and vendor decisions.

**Last updated:** 2026-06-11 (migration 013 — Phase 2 Step 7 data deletion / GDPR Right to Erasure: net-new `data_deletion_requests` table + RLS + 6 RPCs (`request_account_deletion`, `cancel_account_deletion`, `list_due_deletion_requests`, `claim_deletion_request`, `complete_deletion_request`); two-phase soft-delete → 30-day grace → daily cron hard-delete via `server/lib/deletion.js` + `api/v1/jobs/deletion.js` (second Vercel cron, 09:00 UTC). **Gate PASSED on staging — 37/37 GREEN** (`scripts/deletion-gate-test.mjs`; first run 5/15 before 013 was applied). 007–013 staging-only; prod replay pending the Phase 2 cutover. Same-day prior: migration 012 **gate PASSED on staging — 19/19 GREEN** (first run 18/19; a dry-run counter bug in `server/lib/abandonment.js` was fixed — increments moved inside the `if (!dryRun)` guards — and the gate summary wording clarified; prod replay of 012 pending the Phase 2 cutover after Step 7). Prior 2026-06-10: migration 012 added — Phase 2 Step 6 abandonment + abuse monitoring: two service_role-only `SECURITY DEFINER` helpers, **written, gate pending on staging**; 007–012 flagged staging-only (prod replay pending the Phase 2 cutover, which lands after Step 7). Earlier same-day: 011 Step 5 social graph **gate PASSED 40/40**; Step 4 gate re-passed 22/22 after the 011 block-filter amend; 010 Step 4 discovery RPCs; 005–008 list, the `nonbinary` gender-enum regression in 008, post-008 test-user note.)

**Prior update:** 2026-06-09 (added §6 "Trust & safety / identity policy review" ritual pointing at the new policies.md review cadence — start of each phase + quarterly, in sync with lib/policies.js and tenants.dm_initiation_policy)

**Prior update:** 2026-05-18 (staging environment added; §3 expanded with "Staging environment" subsection; §3 toolchain updated to three agents — Cowork + Cursor + Hermes; §4 Supabase region confirmed as us-east-1)

---

## 1. Cost model

### MVP (current, fewer than 100 users)

| Service | Cost |
|---|---|
| OpenAI API (`gpt-4o-mini`, low volume) | ~$1–2/month |
| Supabase | Free tier |
| Vercel | Free tier |
| GitHub | Free |
| **Total** | **~$0–5/month** |

Below the $30/month tools budget by an order of magnitude. Translation message tokens are small; the binding constraint at MVP is not cost.

### Small scale (1,000–10,000 active users, ~60% cache hit rate)

| Service | Cost |
|---|---|
| OpenAI (`gpt-4o-mini` only) | ~$15–40/month |
| OpenAI (with `gpt-4o` routing for idiomatic cases) | ~$200–500/month |
| Supabase Pro | $25/month |
| Vercel Pro | $20/month |
| **Total** | **~$60–600/month** |

Model choice becomes the dominant cost variable. The 15x cost delta between `gpt-4o-mini` and `gpt-4o` is what makes Phase 2's per-message model-routing logic worth building.

### Funded / large scale (100k–1M+ users)

| Service | Cost |
|---|---|
| AI API (negotiated enterprise pricing) | $3,000–15,000/month |
| Dedicated Postgres (Railway/AWS RDS) | $200–800/month |
| Redis cache layer (Upstash) | $0–100/month |
| Containerized backend | $100–400/month |
| Realtime infrastructure (Ably/Pusher) | $100–500/month |
| **Total** | **~$4,000–17,000/month** |

At this scale the architecture itself has shifted significantly; the Vercel/Supabase MVP stack is replaced. Numbers are rough planning ranges, not commitments.

### The cost lever to remember

Token counts are the single largest cost driver. A 2,000-token call costs 10x a 200-token call. Context injection that isn't disciplined balloons costs faster than user growth. The structured 60–80 token context object versus a 400+ token natural-language equivalent is a real financial decision at scale, not a stylistic preference. See architecture.md §6.

---

## 2. Hiring roadmap (product side only)

### MVP — solo + occasional contract

No full-time hires needed. Cursor + Cowork handle the build loop. If a specific feature requires expertise we lack, contract a full-stack React/Node engineer for a defined deliverable rather than retaining.

### Small scale — first three hires

In rough priority order:

1. **Full-stack engineer (React + Node).** Owns the existing stack. Builds features without architectural hand-holding. The first person who lets us move on more than one thing at a time.
2. **Mobile engineer (React Native preferred).** A messaging app needs to live on mobile to be a real consumer product. React Native shares logic with the existing React codebase, which compresses the bring-up.
3. **NLP linguist (consultant or advisor).** Audits dialect detection logic, identifies edge cases in register inference, validates training-data schema. Academic background is fine; part-time or advisory.

**Plus one contractor at this stage:**

4. **Security engineer (one-time engagement).** Specifically to audit the E2EE integration if/when we adopt it. Not a full-time hire — a defined engagement with a deliverable.

### Funded — scaling the team

5. **AI/ML engineer.** LLM application specialist, not ML researcher. Owns the corrections pipeline, fine-tuning runs, context-injection architecture, model evaluation. Highest leverage *after* meaningful correction data exists, which is why this hire is deferred. Compensation range varies dramatically by geography — $140–180k US, viable offshore at meaningful discount.
6. **Backend / infrastructure engineer.** Owns the migration off Vercel/Supabase to dedicated infrastructure when growth demands it. DevOps fluency required.

### What we deliberately won't hire (yet)

- A product manager. Isaac fills that role through Phase 1 and most of Phase 2; that's the point.
- A designer beyond contract engagements. The product's value is translation quality, not UI novelty.
- An ML researcher. We are not building a new model; we are deploying and tuning existing ones.
- Sales. Until there's a working API with one paying customer, sales is Isaac's job.

---

## 3. Development workflow

### The toolchain (committed 2026-05-12; expanded to three agents 2026-05-18)

**Three agents, with clear scope per agent:**

- **Cowork (Claude desktop app, file access + shell, Opus):** strategy and architecture conversations, spec writing, approval gates, doc maintenance, multi-file code changes that need judgment, debugging-when-stuck, anything that benefits from cross-file context. Persistent memory across sessions. The deliberate strategic-conversation surface.
- **Cursor (visual IDE):** line-level edits, the dev server loop, the live preview in browser, visual git operations, the moment-to-moment coding experience. Cursor has its own in-IDE AI for small inline edits; for anything multi-file or architectural, prefer Cowork.
- **Hermes Agent (NousResearch framework, on a VPS, Claude Sonnet/Opus):** routine implementation from approved specs, scheduled jobs, operational execution against staging, weekly research and digests. The execution surface. See `/docs/hermes.md` for the full operating contract.

The split is by *which agent is the right interface for the task*, not by capability — Cowork and Hermes both call Claude under the hood. The difference is conversational pattern (Cowork deliberate, Hermes execution-mode) and tooling (Cowork desktop-and-on-demand, Hermes always-on-and-multi-platform).

**What we explicitly dropped (still accurate):**

- Claude Chat (the regular web chat app) as a routine tool. Fine for an outside-the-loop second opinion, not part of the regular flow.
- Any expectation that we maintain multiple documents (Claude Chat thread + CLAUDE.md + Cursor rules + Cowork notes) describing the same architecture. We maintain one set of `/docs/` files; Cursor reads `.cursorrules`; Cowork and Hermes both read `/docs/`.

### The build loop

For most changes:

1. Open Cowork (this), describe the change in plain language, decide together on the approach.
2. Cowork either makes the change directly or describes what Cursor should do.
3. Open Cursor, review the diff, test locally, hit save.
4. Commit and push. Vercel auto-deploys.
5. Cowork updates `/docs/` to reflect what was built. Decisions of consequence land in `/docs/decisions.md`.

### Staging environment

Set up 2026-05-18, pulled forward from Phase 2 to give Hermes (and us) a safe target to deploy and validate against before anything touches production. See decisions.md.

**Topology:**
- **Production:** Supabase project `translationapp1` + Vercel production environment. Deploys from `main` branch.
- **Staging:** Supabase project `translationapp1-staging` (same region as prod, free tier) + Vercel Preview environment. Auto-deploys from any branch other than `main`.
- **Local dev:** Unchanged. Your local Express server (`server/index.js`) and frontend dev (`npm run dev`) still talk to prod Supabase via the root `.env`. The local workflow isn't routed through staging.

**How env-var routing works:**
- Vercel's Preview environment has `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `OPENAI_API_KEY` set as Project-scoped env vars pointing at staging. Vercel applies them at build time to any Preview deployment.
- Production env vars are untouched and continue pointing at prod Supabase.
- A push to any branch other than `main` triggers a Preview build using the staging values. A merge to `main` triggers a Production build using the prod values. The branch determines which database the deploy talks to.

**Migration workflow:**
1. New schema changes are written as new `.sql` files in `/migrations/` with a sequential number prefix.
2. Run the migration against staging Supabase first (SQL Editor → New query → paste → run).
3. Verify on staging using the verification queries embedded in each migration.
4. Run the same migration against prod Supabase.
5. Verify on prod.
6. The migration file lives in the repo as the canonical record. Any future fresh deploy can replay all migrations in order to reach the same state.

**Prod cutover — execution notes (captured 2026-06-11, for the Phase 2 wipe + replay).** The cutover (tasks #13–16: wipe prod → replay 007→015 → set Production env vars → deploy frontend → verify → reconcile docs) is the single most irreversible step in the project. Guidance for when it runs:
- **Audit prod's high-water mark first (#10).** ✅ **Done 2026-06-11.** Prod is fully at **006**, pre-007 (all 000–006 footprints present; `profiles` absent; the cowork-handoff Spec 4a claim that 005/006 ran on prod is confirmed and extends to 002–004). Replay start = a clean **007**; the prior "002–006 unverified" caveat is resolved. Prod data at wipe time: 29 messages / 94 message_translations (early/test data).
- **Snapshot prod before the wipe.** Take a Supabase backup/PITR snapshot even though the wipe is intended — cheap rollback insurance on an irreversible step.
- **One uninterrupted block, low-traffic window.** Prod is empty/inconsistent mid-flight; don't start unless you can finish. Budget ~3–5 hrs of active work — the dominant cost is *verification* (end-to-end smoke test: signup → onboard → send → translate → inference, plus the deletion/abandonment crons), not the migration runs (seconds each).
- **Stays in Cowork, not Hermes.** Judgment + irreversible work → this agent, not a routine hand-off.
- **Out-of-band secrets, prod edition.** After the replay, enable `profile_writer` LOGIN on prod and set `DATABASE_URL_PROFILE_WRITER` (role `profile_writer.<prod-project-ref>`, **port 6543** transaction pooler) in Vercel Production — never committed, never `VITE_`-prefixed. Same for any other prod writer creds.
- **A step-by-step runbook is to be drafted next session** before execution begins.

**Table-recreate checklist (DROP + CREATE in one migration).** Recreating a table — `DROP TABLE … ; CREATE TABLE …` — does *not* carry anything over from the old definition. Everything attached to the old table is silently lost unless the new `CREATE` re-states it. Migration 008 recreated `user_linguistic_profiles` and dropped the `nonbinary` value from the gender CHECK this way (fixed in 009). Before shipping any migration that recreates a table, walk this list and confirm each item is re-stated in the new definition (or intentionally dropped, noted in the migration comment + decisions.md):

- [ ] **CHECK constraints** — every `CHECK` from the old table (enum-like value lists are the easy ones to lose; cross-column checks too).
- [ ] **Column defaults** — `DEFAULT now()`, `DEFAULT false`, `gen_random_uuid()`, etc.
- [ ] **NOT NULL** on each column that had it.
- [ ] **Primary key** — including composite PKs.
- [ ] **Unique constraints / unique indexes** — including partial (`… WHERE …`) uniques.
- [ ] **Foreign keys** — both directions: FKs *out* of this table, and FKs *into* it from others (a `DROP … CASCADE` silently drops inbound FKs).
- [ ] **Plain indexes** — performance indexes don't error if missing, so they're easy to forget.
- [ ] **RLS** — `ENABLE ROW LEVEL SECURITY` **and** every policy (RLS state and policies are dropped with the table).
- [ ] **GRANTs / REVOKEs** — table- and column-level privileges (e.g. the `GRANT UPDATE (display_name)` column guard on `profiles`).
- [ ] **Triggers** on the table, and **functions** that reference it by name.
- [ ] **Comments**, generated columns, identity/sequence settings, if used.
- [ ] **Prefer `ALTER` over recreate** when the change is small (add/drop a column, widen a CHECK) — recreate only when the change is structural enough to need it. 009 itself is an `ALTER`, not a recreate, for exactly this reason.

**What's in `/migrations/` today.** Running 000–015 in order against an empty Postgres reproduces the **current staging** schema (010 + 011 gates both GREEN on staging 2026-06-10; 012 gate PASSED on staging 2026-06-11, 19/19 GREEN; 013 gate PASSED on staging 2026-06-11, 37/37 GREEN; 014 forward-schema prep — verified on staging 2026-06-11, 4/4 checks GREEN; 015 profile-writer role — applied to staging 2026-06-11, inference re-gate PASSED under the locked-down role, GREEN). **Migrations 007–015 are staging-only so far** — prod has not run them yet (the Phase 2 auth/RLS cutover is a deliberate, coordinated event; see architecture.md §10). The **prod replay sequence is 007 → 015** (014 forward-prep + 015 least-privilege profile-writer role). ✅ *Resolved 2026-06-11 (audit, task #10): prod is fully migrated through **006** and pre-007 — every 000–006 footprint present, `profiles` absent, exactly the 9 expected tables, no stray objects. Replay start point is a clean **007**. Prod holds 29 messages / 94 message_translations (early data, discarded by the wipe; `user_profiles` still present, dropped by 008 during replay).*
- `000_base_schema.sql` — base tables (`messages`, `message_translations`, `user_profiles`). Captures the pre-migration state of those tables, which were created via Supabase Studio UI before the migrations folder existed. See parking-lot.md for cleanup of vestigial columns surfaced during this work.
- `001_tenants_and_tenant_id.sql` — adds the `tenants` table, seeds the chat-app tenant row, retrofits `tenant_id` on the base tables.
- `002_phase1_schema.sql` — adds `user_linguistic_profiles`, `conversation_contexts`, `user_profile_events`.
- `003_prompt_version_and_gender_nonbinary.sql` — adds `prompt_version` to `message_translations`, expands `gender_signal` enum to include `nonbinary`. (008 accidentally dropped `nonbinary` when it recreated `user_linguistic_profiles`; **009 restores it** — see below.)
- `004_enable_realtime_publication.sql` — adds `messages` to the `supabase_realtime` publication. Captures a setting previously configured only via Supabase Studio UI on prod.
- `005_event_log_tables.sql` — Hermes event-log tables (`translation_events` et al.).
- `006_user_profile_events_task_id.sql` — adds `task_id` to `user_profile_events`.
- `007_phase2_identity_foundation.sql` — **(staging only)** `profiles`, `account_identifiers`, `account_settings`; `auth_tenant_id()`; `handle_new_user()` trigger on `auth.users`; RLS + column-grant guard on `profiles`.
- `008_phase2_step2_identity_cutover.sql` — **(staging only)** drops `user_profiles`; recreates `user_linguistic_profiles` + `user_profile_events` with uuid keys; `messages.sender_id` text→uuid (FK `auth.users`); RLS on `messages`/`message_translations`; `complete_onboarding()` RPC.
- `009_restore_nonbinary_gender_signal.sql` — **(staging only)** restores `nonbinary` to the `user_linguistic_profiles.gender_signal` CHECK that 008 accidentally dropped (realigns with 003 + decisions.md 2026-05-12). Widening-only; safe on empty or populated tables.
- `010_phase2_step4_discovery.sql` — **(staging only — gate PASSED 22/22; re-passed after 011's block-filter amend)** Phase 2 Step 4 discovery. **Additive only** — no table/column changes: three `SECURITY DEFINER` RPCs (`find_account_by_email`, `search_accounts_by_username`, `change_username`) + a partial username-prefix index. Bypasses `account_identifiers` own-rows-only RLS deliberately, with handle minimization + tenant scoping + anti-enumeration re-imposed in code. Idempotent (`CREATE OR REPLACE`, `IF NOT EXISTS`). Gate must run as real authenticated users (`scripts/discovery-gate-test.mjs`), not postgres. See decisions.md 2026-06-10 "Phase 2 Step 4 discovery". **Note: `find_account_by_email` + `search_accounts_by_username` are amended by 011 to filter active blocks — re-run the Step 4 gate after 011.**
- `011_phase2_step5_social_graph.sql` — **(staging only — gate PASSED 40/40)** Phase 2 Step 5 social graph + safety primitives. **Additive** — six new tables (`relationships` canonical-pair, `blocks`, `reports`, `invites`, `invite_redemptions`, `email_hash_abuse`), RLS (SELECT-only or none) on each, and nine `SECURITY DEFINER` RPCs that are the sole write path (`active_block_exists`, `request_contact`, `respond_to_contact`, `block_account`, `unblock_account`, `report_account`, `create_invite`, `redeem_invite`, `revoke_invite`). Also `CREATE OR REPLACE`-amends the two 010 discovery RPCs to filter active blocks (a behavior change → re-run the Step 4 gate too). No table recreates, no destructive change; idempotent (`CREATE TABLE/INDEX IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP POLICY IF EXISTS`). Gate as real authenticated users (`scripts/social-graph-gate-test.mjs`), not postgres. See decisions.md 2026-06-10 "Contact-graph representation: canonical pair" + companion entries.
- `012_phase2_step6_abandonment.sql` — **(staging only — gate PASSED on staging 2026-06-11, 19/19 GREEN)** Phase 2 Step 6 abandonment + abuse-monitoring support. **Additive, functions only** — two `SECURITY DEFINER` helpers granted to `service_role` only (`list_abandoned_pending_accounts(interval)`, `record_abandoned_email_hash(uuid, text, smallint)`); no tables (the `email_hash_abuse` table shipped in 011). These are *system* functions for the Node sweep, not user-facing RPCs — they don't use `auth.uid()`/`auth_tenant_id()`. The deletion + username release is done by the sweep (`server/lib/abandonment.js`) via the Supabase admin API; the FK cascade (007) releases the handle automatically, so there is **no** "release username" function by design. Idempotent (`CREATE OR REPLACE`). Gate: `scripts/abandonment-gate-test.mjs` (run on staging, `RLS_TEST_CONFIRM_STAGING=yes`). See decisions.md 2026-06-10 "Step 6 abandonment + abuse monitoring".
- `013_phase2_step7_data_deletion.sql` — **(staging only — gate PASSED 37/37)** Phase 2 Step 7 data deletion / GDPR Right to Erasure. **Additive** — one net-new table (`data_deletion_requests`: tracks erasure lifecycle, `user_id` FK to `profiles` is **ON DELETE SET NULL** so the audit row survives its own erasure) with RLS (SELECT-own to `authenticated`; all writes go through RPCs), and six functions. User-facing RPCs (`SECURITY DEFINER`, granted `authenticated`): `request_account_deletion(interval)` — soft-deletes (`profiles.status='deactivated'`) + enqueues a pending request, idempotent; `cancel_account_deletion()` — reverses within the grace window. System functions (granted `service_role` only, for the Node sweep): `list_due_deletion_requests`, `claim_deletion_request`, `complete_deletion_request`. The hard-delete itself is done by the sweep (`server/lib/deletion.js`) via the Supabase admin API; the FK cascade (007/008) anonymizes — `auth.users` delete CASCADEs PII (profiles/identifiers/settings/ULP/events) while `messages.sender_id` is **ON DELETE SET NULL** so content survives de-identified. Reuses `email_hash_abuse` + `record_abandoned_email_hash` (shared pepper) to record an abuse HMAC before delete; the source-column split is parked. Idempotent. Gate: `scripts/deletion-gate-test.mjs` (run on staging, `RLS_TEST_CONFIRM_STAGING=yes`, needs `ANON_KEY`). See decisions.md 2026-06-11 "Step 7 data deletion".
- `014_forward_schema_prep.sql` — **(staging — verified 2026-06-11, 4/4 checks GREEN)** Pre-cutover structural hardening surfaced by the 2026-06-11 forward-looking schema review (decisions.md). Four independent `ALTER`-only, idempotent changes, **no recreate**: (1) adds `messages.conversation_id` — nullable, `DEFAULT` the global-conversation sentinel `00000000-0000-0000-0000-000000000002`, **no FK yet** — so Phase 3 adds the `conversations` table + FK + `NOT NULL` with **zero backfill**; (2) drops the 7 vestigial `messages` columns (`room_id`, `translated_text`, `target_language`, `tone`, `context_id`, `model_version`, `latency_ms`) — all superseded (see architecture.md §7); (3) converts four naive `timestamp` columns → `timestamptz` (`message_translations.created_at`, `conversation_contexts.updated_at`, `tenants.created_at`, `user_profile_events.created_at`), interpreting existing values AS UTC, via a guarded DO block; (4) adds missing FK indexes (`messages.conversation_id/sender_id/tenant_id`, `message_translations.tenant_id`). **Pre-flight:** confirm `src/App.jsx` `.select('translated_text')` targets `message_translations`, not `messages` (verified 2026-06-11). No gate script needed (no new RLS/RPCs); verify with the queries at the foot of the file. See decisions.md 2026-06-11 "Forward-schema prep before prod cutover".
- `015_profile_writer_role.sql` — **(staging-only, pglast-validated, NOT yet applied)** Least-privilege `profile_writer` Postgres role for `server/lib/inferProfile.js` (connected via `DATABASE_URL_PROFILE_WRITER`). **Approach B — scoped RLS, not BYPASSRLS:** column-scoped table GRANTs (`messages` SELECT 4 cols; `user_linguistic_profiles` SELECT whole-table + UPDATE 7 cols + `updated_at`; `user_profile_events` INSERT 6 cols) + four RLS policies targeted `TO profile_writer` (USING/WITH CHECK `true`). DB authorizes the *operation*; app authorizes the *row* (message-derived trust boundary, decisions.md 2026-06-10). **Deny-by-default everywhere else** — any table without a `TO profile_writer` policy still blocks the role. Role created **`NOLOGIN`** (no secret in the repo); ⚠️ **operator must enable login out of band** (`ALTER ROLE profile_writer WITH LOGIN PASSWORD '<secret>'` in the Supabase SQL editor) and store the connection string only in the Vercel env var `DATABASE_URL_PROFILE_WRITER` (never committed, never `VITE_`-prefixed) **before** the Step-2 inference gate (#12) can run. Idempotent (`IF NOT EXISTS` role guard, idempotent GRANTs, `DROP POLICY IF EXISTS`). Verify with the queries at the foot of the file. See decisions.md 2026-06-11 "profile_writer role: scoped RLS, not BYPASSRLS".

**Test users on staging (not prod):** the chat-room users are now real Supabase Auth accounts (post-008 identity), not `user_profiles` rows. The Step 3 RLS gate uses three: A and B (tenant 1, pre-existing) and C (tenant 2, created by the gate script). Their emails/passwords live in the local, gitignored `.env.rls-test` (template: `.env.rls-test.example`). Use these to smoke-test without polluting real-looking data.

**Smoke-test runbook:** see `/docs/verification.md` "Staging environment" section.

### When to use which agent

- **Cowork:** Architectural decisions. Schema migrations. Doc work. Spec writing. Pre-implementation checklists. Tracing through unfamiliar code. Anything where you'd want to talk through it. Anything that needs Isaac's judgment in the loop.
- **Cursor:** Knowing exactly what change you want to make on a specific line. Running the dev server. Watching the live browser preview iterate. The 80% of editing that's mechanical.
- **Hermes:** Implementing a feature against an approved spec. Running scheduled jobs (research scrapes, error log triage, weekly digests). Maintaining `translation_events` on translation-touching changes. Anything Isaac has explicitly delegated. *Always operates against staging first, never directly to prod, with approval gates per hermes.md §6.*

### What Cursor's AI is for

Cursor has its own AI built in (`Cmd-K` for inline edits, the chat panel for questions). It's fine for small in-context edits. For anything architectural, prefer Cowork — it has the memory and the docs in context.

### Memory and continuity

- Cowork keeps persistent memory across sessions automatically. Things like "Isaac prefers casual, concise responses with jargon explained" don't need to be re-said.
- For anything load-bearing in the architecture, the source of truth is `/docs/`, not Cowork memory. Memory is for collaboration preferences and recent context; docs are for decisions.
- Before starting a new Cowork session on a technical topic, the docs are auto-context if I open them; you don't need to paste anything in.

---

## 4. Vendor and technology decisions

### Current commitments

- **Supabase** for database + realtime through small scale. Reasonable price/performance for our size. May need migration to dedicated Postgres at funded scale; that's a known future migration, not a regret.
- **Vercel** for hosting frontend + serverless backend through small scale. Same logic — fine for now, will migrate when growth demands.
- **OpenAI** as primary LLM provider. Stays primary at MVP. Evaluate alternatives (DeepSeek, fine-tuned models) at small scale; backend model-agnostic so swap is configuration, not refactor.
- **GitHub** for source. Not changing.

### Decisions we have NOT yet made

- Authentication provider. Supabase Auth is the obvious choice given the existing Supabase project, but worth a brief evaluation versus Clerk or Auth0 at Phase 2 boundary.
- Mobile framework. React Native is the leading candidate (shares codebase with web React), but Expo vs bare React Native, native modules vs JS-only — all open.
- Data residency region. Supabase region is `us-east-1` for both `translationapp1` (prod) and `translationapp1-staging` (staging). Chosen by default at project creation and confirmed 2026-05-18. May matter when entering regulated markets (EU healthcare especially); decision to migrate deferred until that's a real question. Hermes VPS will be provisioned in a matching US East region to keep network latency low.
- Whether to monetize the consumer app or keep it free as a data-generation vehicle. Strategy doc notes this; decision deferred until we have signal on consumer demand.

---

## 6. Operational rituals

### Trust & safety / identity policy review

`/docs/policies.md` (identity, discovery, DM-initiation, blocking, anti-abuse, account lifecycle) is reviewed **at the start of each phase and at minimum quarterly**. Each review updates the doc's "Last reviewed" line and logs material changes in `decisions.md`. Keep `policies.md` (human-readable) in sync with `lib/policies.js` (machine defaults) and `tenants.dm_initiation_policy` (per-tenant overrides). See policies.md header.

### 90-day PAT rotation

**Next trigger date: 2026-08-31** (Vercel token expires; GitHub and Supabase expire 2026-09-01 — rotate all three in the same sitting to keep one calendar slot).

Three credentials to rotate: `GITHUB_TOKEN` (GitHub fine-grained PAT, expires 2026-09-01), `SUPABASE_ACCESS_TOKEN` (Supabase personal access token, expires 2026-09-01), `VERCEL_TOKEN` (Vercel personal access token, expires 2026-08-31).

Full rotation procedure lives in `/docs/verification.md` "Hermes access credentials — Spec 3" post-rotation checklist. Summary:
1. Generate new tokens in each dashboard (tag `hermes-prod-rotated-YYYY-MM-DD`; save to password manager).
2. Update `~/.hermes/.env` on the droplet.
3. Re-authenticate CLIs (`gh auth login --with-token`, `supabase login --token`, `vercel whoami --token`).
4. Restart `hermes-gateway` service.
5. Run all six Spec 3 smoke tests. Do not mark rotation complete until all pass.
6. Revoke old tokens in their dashboards.
7. Update this date to the new trigger (90 days from new expiry dates).

**Rotation log:**

| Date | Outcome | Notes |
|---|---|---|
| 2026-06-03 | Initial setup — Spec 3 | Tokens created; no rotation needed |

---

## 5. Time budget

- Isaac targets 10–15 hours per week on the project.
- No hard deadline. Goal: working MVP-quality contextual translation faster than a month; "meaningful AI fluency" as a personal outcome within roughly the same window.
- Phase order is firm (see roadmap.md): Phase 0 → Phase 1 → Phase 2 → Phase 3.
