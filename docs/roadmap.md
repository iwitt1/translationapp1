# Translation App — Roadmap

> Living document. Owns the prioritized list of work, organized by phase. Checkbox style so we can see progress at a glance.
>
> **What lives here:** committed work in priority order.
> **What does NOT live here:** ideas we haven't decided to build. Those go in `parking-lot.md`.

**Last updated:** 2026-06-10 (Added build-spec pointer to Phase 2 "Profile inference" subsection — Option A decided, full spec in parking-lot.md, building next session in Cowork. Earlier same day: Phase 2 Step 2 — magic-link auth + onboarding app layer built. Migration 008 ships the coordinated breaking cutover: user_profiles dropped, user_linguistic_profiles/user_profile_events user_id promoted text→uuid, messages.sender_id text→uuid+FK, RLS enabled on messages+message_translations+ulp+upe, complete_onboarding() SECURITY DEFINER RPC. App.jsx rewritten with auth state machine: loading→email_input→onboarding→chat. Language selector removed; context/register dropdown kept. Gate: full signup→onboard→active flow on staging for two test users.)

**Prior update:** 2026-06-09 (Phase 2 identity/discovery/social-graph design — rewrote Phase 2 Authentication into magic-link auth + P1–P4 onboarding lifecycle; added Identity & discovery and Social graph primitives subsections; expanded RLS to all new tables + greenfield/cutover note; clarified Phase 3 invite reuses the Phase 2 invite primitive + context-dropdown relocation. See policies.md, architecture.md §7 Phase 2 tables, and decisions.md 2026-06-09 entries.)

**Prior update:** 2026-06-02 (Phase 1.5 infrastructure — Discord gateway live; Sonnet routing live; per-agent Opus tier override carved into Spec 2.1. Checkbox 4 done; checkbox 3 partial. Spec 3 — access credentials — approved and ready to execute. Added "Cowork ↔ Hermes interface follow-ups" subsection capturing the Cowork-sandbox git-pull auth gap surfaced during Spec 3 drafting. See specs.md Spec 2 (shipped 2026-06-02 narrowed) + Spec 2.1 (draft) + Spec 3 (approved) and decisions.md 2026-06-02 entries.)

---

## Phase 0 — Foundation

**Goal:** Get the codebase and docs into a state where Phase 1's contextual translation work is fast, safe, and not blocked by structural debt. Mostly cheap structural changes. Days, not weeks.

### Docs and process
- [x] Master architecture doc (`/docs/architecture.md`)
- [x] Strategy doc (`/docs/strategy.md`)
- [x] Operations doc (`/docs/operations.md`)
- [x] Roadmap (this file)
- [x] Parking lot (`/docs/parking-lot.md`)
- [x] Decisions log (`/docs/decisions.md`)
- [x] `.cursorrules` at repo root
- [x] Project instructions updated in Cowork
- [x] Flesh out README with setup and run instructions

### Code hygiene
- [x] Delete stray files at repo root (`Bash`, `echo`, `which`)
- [x] Reconcile prod and local translate prompts. Picked the local version (with "Handle idioms naturally" line); api/v1/translate.js updated to match server/index.js.
- [ ] Baseline the live deployment — visit the production URL, verify what's actually shipping matches `main`. **Isaac to do after merging Phase 0 changes.**

### API-first prep (cheap now, painful later)
- [x] Rename API routes from `/api/translate` to `/api/v1/translate`. File moved to `api/v1/translate.js`; Express route updated; frontend updated.
- [ ] ~~Add a stub `/api/v1/detect`~~ — Decision: keep the single `/api/v1/translate` endpoint with a `mode` parameter for now. Will split into separate `/v1/detect` and `/v1/translate` endpoints in Phase 1 when we restructure the prompt for JSON-mode and structured inference return anyway.
- [x] Add `tenants` table to Supabase + seed row + add `tenant_id` columns + backfill. Migration written at `migrations/001_tenants_and_tenant_id.sql`. **Isaac to run in Supabase SQL editor.**
- [x] Frontend (`src/App.jsx`) now includes `tenant_id` on inserts via `src/lib/config.js` constant.

### Frontend cleanup, non-functional
- [ ] No changes yet — Phase 1 is where the frontend grows. Phase 0 leaves it as-is.

---

## Phase 1 — Contextual translation (the thing we came here for)

**Goal:** Turn translation from "single-message, idiom-flat" into "context-aware, register-sensitive, idiomatic." This is where the project's stated value proposition becomes real.

### Backend
- [x] Restructure the translate prompt to return structured JSON: `{ translated_text, detected_language, inferences: { dialect, register, gender, domain, idiomatic_elements }, ambiguity: { detected, confidence, alternatives } }`. Prompt lives in `lib/translatePrompt.js` (shared module).
- [x] Add JSON-mode (or equivalent) to the OpenAI call so parsing is reliable. `response_format: { type: 'json_object' }` on all translate calls.
- [x] System prompt instructs the model: when a phrase has multiple plausible interpretations (sarcasm, idiom collisions, pronoun ambiguity), return `ambiguity.detected: true` and populate `alternatives`. Defaults to `detected: false, alternatives: []` for unambiguous cases.
- [x] Add the lean context object as a request parameter. Backend takes it, includes it in the prompt.
- [x] Backend assembles context from request: user-level (from profile), conversation-level (from conversation context), conversation-history (last N=3 messages by default). Context assembly happens in the chat layer (App.jsx); backend receives the assembled object.
- [x] Add `context_type` parameter on the conversation (`casual`, `dating`, `professional`, `academic`, etc.). Default casual. Selects a system-prompt modifier.
- [x] Backend compares each returned inference against stored profile; updates inferred values when confidence improves; never overwrites explicit values. **Note:** runs client-side in MessageBubble (chat-layer concern per architecture.md §4). See decisions.md.
- [x] Add `user_profile_events` table (append-only log of inference and profile changes). Schema in `migrations/002_phase1_schema.sql`. Events written from App.jsx after each profile update.

### Schema additions
- [x] `user_linguistic_profiles` table (per architecture.md §7). Schema complete in `migrations/002_phase1_schema.sql`. **Isaac to run in Supabase SQL editor.**
- [x] `conversation_contexts` table (per architecture.md §7). Schema in `migrations/002_phase1_schema.sql`. **Isaac to run in Supabase SQL editor.**

### Frontend
- [x] Wire user's preferred language into context object on every translate call.
- [x] Add a basic UI for the user to set their preferred language explicitly (overrides the hardcoded `en`). Language selector in chat header.
- [x] Add a basic UI for setting conversation register/context type. Context-type selector in chat header.
- [x] Wire conversation history into the translate call (last 3 messages). Passed as `history` prop to MessageBubble; sliced from messages array.
- [x] Show a clearer loading state during translation; surface translation failures instead of silently falling back to original text. Error state + "⚠ Translation failed" message added to MessageBubble.

### Cleanup (post-testing)
- [x] Fix: remove `contextType` from MessageBubble `useEffect` dependency array — context-type changes should apply to new translations only, not retrigger re-render of existing history.
- [x] Add `PROMPT_VERSION` constant to `lib/translatePrompt.js`; stamp `message_translations.prompt_version` on every cached translation. Migration 003.
- [x] Add `nonbinary` to `gender_signal` enum in `user_linguistic_profiles`. Update prompt to distinguish `neutral` (no grammatical gender in source language) from `nonbinary` (speaker uses gender-inclusive forms). Migration 003.

### What "Phase 1 done" means
- A bilingual tester does a 30-message conversation in mixed languages and reports translations feel native, not literal. Quality is qualitatively better than DeepL on idiom, register, and pronouns for the chosen language pair.
- Every translation call returns structured inferences that are persisted to `user_linguistic_profiles` without cross-language contamination. **Known limitation:** inference runs client-side with a race condition under concurrent viewers, and dialect accuracy depends on the stored `source_language` being correct. These are accepted for Phase 1 and addressed in Phase 2 (see below).
- The same conversation, repeated with different `context_type` settings, produces meaningfully different translation tone.

---

## Phase 1.5 — Set up Hermes Agent

**Goal:** Stand up the Hermes Agent infrastructure on a VPS with Claude as the underlying model, multi-tier routing (Sonnet default, Opus on escalation), and one gateway. Operate in supervised mode for the first 30 days; graduate to autonomous routine work per `/docs/hermes.md` §12 Day-30 criteria.

**Pre-requisites (done 2026-05-18):**
- [x] Staging environment built — Supabase staging project + Vercel Preview env vars + migration workflow + smoke-test runbook. See 2026-05-18 decisions.md entries.
- [x] `/docs/hermes.md` charter drafted through v0.4. **Ratification = commit to main; pending Isaac's push.**

### Infrastructure
- [x] Provision VPS — DigitalOcean droplet `hermes-prod` (1 GB / 1 vCPU / 35 GB SSD / Ubuntu 24.04 LTS / NYC3 / weekly backups / $9.60/mo). Shipped 2026-06-01 per Spec 1. Provider rationale in `/docs/decisions.md` 2026-06-01 entry.
- [x] Install Hermes Agent — pinned to v0.14.0 (git tag `v2026.5.16`) at `/home/hermes/.hermes/venv/`. Shipped 2026-06-01 per Spec 1. Version-pin rationale in `/docs/decisions.md` 2026-06-01 entry.
- [~] Configure tiered model routing: Claude Sonnet 4.6 as default *(done 2026-06-02 per Spec 2; provider Anthropic direct, model `claude-sonnet-4-6`)*; explicit Opus escalation per `/docs/hermes.md` §3 rules *(deferred to **Spec 2.1**)*.
- [x] Wire up one messaging gateway — **Discord** (not Telegram; updated per Spec 2 scoping decision). Live as systemd service `hermes-gateway` since 2026-06-02; allowlist enforced; smoke + reboot tests passed. See `verification.md` "Hermes model routing + Discord gateway (2026-06-02)".
- [x] Set Hermes's access credentials: GitHub PAT scoped to the repo (commits + branches, no admin), Supabase CLI authenticated to both projects (prod read-only via separate Postgres role + readonly DATABASE_URL, write permission gated on §6.2 confirmation), Vercel CLI authenticated (staging autonomous, prod gated). **Spec 3 shipped 2026-06-03** (73835e5).

### Cowork ↔ Hermes interface follow-ups
*Trigger: after Hermes Specs 1, 2, 2.1, 3, and 4 all ship — i.e., after Hermes is operationally complete on its end.*

- [ ] Fix the Cowork sandbox so the session-start `git pull --ff-only` actually authenticates and runs. Currently fails with `fatal: could not read Username for 'https://github.com'` because the sandbox has no GitHub credentials. Without this, the session-start protocol in the Cowork project instructions can't pull Hermes's pushes since the last session, which means cowork-handoff.md may be stale + Cowork can branch from out-of-date state. Mechanism TBD — options: scoped read-only GitHub PAT mounted into the sandbox via Cowork's settings, SSH key in the sandbox, credential helper, or a custom session-start script that handles auth. Investigate and pick before opening for execution. *Surfaced 2026-06-02 during Spec 3 drafting when the session-start `git pull` failed with no auth.*

### Event log schema (per hermes.md §7)
- [x] Create `translation_events` and `agent_events` tables. *Spec 4a shipped 2026-06-02 — migrations 005 and 006 run on staging and prod; `hermes_writer` role provisioned; schemas finalized in hermes.md §7.2 and §7.3.*
- [x] Wire the live application's translate call sites to write `translation_events` on every call, and Hermes task lifecycle to write `agent_events`. *Spec 4b shipped 2026-06-10 — commits 8cfa0a2, a4131b2, 2dd38df. Verified on staging: `chat_app` rows appear in `translation_events` after every translate call. See verification.md.*

### Promote items pulled from parking lot
- [x] Promote "Autonomous test harness for agent-driven builds" from `/docs/parking-lot.md` → this phase. Required before Hermes operates beyond supervised mode. *Promoted 2026-06-09 → Spec 5 (approved, pending Hermes execution).*
- [~] Audit Supabase config that lives outside `/migrations/` (per `/docs/parking-lot.md` "Other config state lives outside /migrations/"). Audit queries written in `verification.md` Phase 2 Step 0 — Isaac to run and confirm findings before Step 1.

### Open questions to resolve (from hermes.md §13)
- [ ] Hermes Agent v0.14.0 (v2026.5.16) skill-versioning capability — can skills live in version control? Affects §6.8 design.
- [ ] Tool-call introspection / replay — can Hermes's actions be inspected and replayed for debugging? Affects §7.3 design.
- [ ] Gateway choice — Telegram vs Slack as first; confirm with hands-on use.
- [ ] VPS spec confirmation — 1-2GB enough for orchestrator only, or do we need more headroom?
- [ ] Cost ceilings (§6.5) — initial guesses; calibrate after observing one cycle.
- [ ] Modal vs VPS deployment comparison — Hermes Agent supports Modal as a backend. Possibly cheaper at low usage if Hermes is idle most of the time.

### Day-0 / Day-7 / Day-30 milestones (per hermes.md §12)
- [ ] **Day 0:** Charter ratified (committed to main). Roadmap updated (this section). Parking-lot items promoted. Cowork's project instructions updated to acknowledge Hermes as the third agent in the loop.
- [ ] **Day 7:** Infrastructure up; one end-to-end smoke test (Isaac issues "create a hello-world feature branch on staging", Hermes does so and reports per hermes.md §8.1).
- [ ] **Day 30:** Five specs delivered end-to-end. At least one §5 pre-implementation checklist triggered and approved. At least one decisions.md entry drafted by Hermes and approved+appended (per hermes.md §2 / v0.4). Cost ceilings calibrated. First monthly skill review (hermes.md §6.8) done. Hermes graduates from supervised mode.

### What "Phase 1.5 done" means
- Hermes can be assigned a well-scoped Phase 2 spec and execute it end-to-end (branch → test → staging deploy → verification → approval → merge to main → prod deploy) without manual intervention from Isaac except at approval gates.
- The 30-day onboarding has produced enough operational data to calibrate cost ceilings, identify framework rough edges, and validate the tiered Sonnet/Opus split.
- All hermes.md §13 open questions have answers; hermes.md is updated (likely v0.5 or v1.0) accordingly.

---

## Phase 2 — Multi-user safety

**Goal:** The app is shareable with real testers without privacy concerns. Up until this phase, no third party should have the URL.

### Authentication
- [~] Supabase Auth via **magic links (email OTP)** as primary. Architecture supports a future password toggle (same JWT/session downstream; password path purely additive, switchable via config/UI without a refactor) *(Step 2 built; gate not yet run)*
- [~] Onboarding lifecycle per policies.md §6: P1 email submitted → magic link + `auth.users` row + DB trigger creates pending `profiles` row (uuid, random `system_generated` username, email identifier); P2 link clicked → onboarding screen; P3 submit display name + language → `status='active'`; P4 first message (engagement, not a status) *(Step 1 trigger + Step 2 app layer built; gate not yet run)*
- [~] Display name + language collected post-click on one onboarding screen ("the name other people see"). In-chat **language** selector removed. **Context/register** dropdown kept. *(built in Step 2; gate not yet run)*
- [ ] Scheduled job: re-prompt pending accounts; delete abandoned ones after 30 days, release their system-generated username, record an email **hash** in the abuse-monitoring table *(Step 6)*
- [ ] Token-based authentication on every backend API call, including the chat app's own calls
- [ ] Refresh / rotation behavior verified
- [x] No data migration needed — staging is wiped at Phase 2 start (existing data is throwaway)

### Identity & discovery (per architecture.md §7 "Phase 2" tables; decisions.md 2026-06-09)
- [~] `profiles` table, `id = auth.users.id` (Model A — one tenant per user); migrate `user_id`/`sender_id` text → uuid *(profiles done Step 1; text→uuid cutover in migration 008 Step 2 — gate not yet run)*
- [x] `account_identifiers` (normalized handles, non-reusable usernames via never-deleted rows + reserved seeds) *(migration 007, Step 1 — verified)*
- [x] `account_settings` (per-user discoverability + `allow_dms_from`) *(migration 007, Step 1 — verified)*
- [ ] Username policy mechanism: within-tenant uniqueness, `username_source`, `username_last_changed_at`; values in `lib/policies.js` + policies.md §1 *(Step 4)*
- [ ] Discovery: exact-match add by email/username only (no email search), autocomplete on username, **handle minimization** enforced in the query/API *(Step 4)*

### Social graph primitives (schema + safety; DM *policy values* and DM *UI* are Phase 3)
- [ ] `relationships` (contacts, with `via_identifier_type` provenance), `blocks` (with `unblocked_at` + partial unique index), `reports` (auto-creates a block)
- [ ] `invites` + `invite_redemptions` (deep-link primitive; serves contact-add now, conversation-join in Phase 3)
- [ ] `tenants.dm_initiation_policy` jsonb (sole tenant `'{}'` → mutual-acceptance-only); enforcement reads `lib/policies.js` defaults + tenant overrides
- [ ] `email_hash` abuse-monitoring table for abandoned-signup spam detection

### Row-level security
- [~] RLS policies on every table that exists by this point: `messages`, `message_translations`, `user_linguistic_profiles`, `conversation_contexts`, `user_profile_events`, and all Phase 2 identity/discovery/social tables (`profiles`, `account_identifiers`, `account_settings`, `relationships`, `blocks`, `reports`, `invites`, `invite_redemptions`, abuse-monitoring email-hash table) *(migration 007 + 008 cover profiles/account_identifiers/account_settings/messages/message_translations/ulp/upe; conversation_contexts + social tables come with Steps 4–5)*
- [~] Tenant-scoped policies on top of user-scoped policies (use `auth.uid()`; tenant scope via `tenant_id`) *(all Step 1 + Step 2 policies follow this pattern)*
- [x] **No RLS exists in Supabase today** — this is greenfield. Every policy must live in a migration from day one. Confirmed: migrations 007 and 008 ship RLS with the tables.
- [ ] Test that one user cannot read another user's data via dev tools or direct API queries *(Step 3 adversarial gate)*

### Data deletion
- [ ] `data_deletion_requests` table
- [ ] Deletion job that anonymizes corrections (strips user_id and PII, keeps translation pairs) rather than hard-deleting

### Staging environment

**Pulled forward and completed 2026-05-18** to support Hermes Agent adoption. See `/docs/decisions.md` and the new "Staging environment" subsection in `/docs/operations.md`.

- [x] Create a second Supabase project (`translationapp1-staging`) as a staging database. Same schema, no real data. Lets us run destructive migrations and feature tests without touching production data.
- [x] Vercel environment variables: production points at the prod Supabase project; preview branches point at the staging project. Configured per-environment under Project scope.
- [x] Establish migration workflow: all SQL migrations run against staging first, verified, then run against production. Documented in `/docs/operations.md` §3.
- [x] Backfill `000_base_schema.sql` to capture pre-migrations tables (created via Supabase Studio UI before the folder existed). Migrations folder is now self-sufficient for fresh deploys.
- [x] Backfill `004_enable_realtime_publication.sql` to capture the realtime-publication setting (also configured originally via UI).
- [x] Seed two test users (`staging_test_a`, `staging_test_b`) on staging for smoke-testing.
- [x] Smoke-test verified: a preview-branch deploy talks to staging Supabase, writes to staging tables, prod is unchanged.
- [x] Staging smoke-test runbook codified in `/docs/verification.md`.

### Profile inference (migrated from client-side)
> **BUILT 2026-06-10 (Option A).** `POST /api/v1/infer-profile` (Express + Vercel) + `server/lib/inferProfile.js`; raw-pg `SELECT … FOR UPDATE`; client fires-and-forgets `message_id`; flag renamed `PROFILE_INFERENCE_ENABLED` and on. See `decisions.md` 2026-06-10 "Server-side profile inference (Option A)" and `verification.md` "Server-side profile inference". Verification gate (two users → profile row updates + event row lands) pending a staging run.

- [x] Move `applyInferences` logic to a server-side function (dedicated `/api/v1/infer-profile` endpoint). Client fires inference payload to the endpoint; server applies guards and writes atomically — eliminates the race condition via `SELECT … FOR UPDATE`.
- [x] Dialect consistency guard updated to anchor on the authoritative server-read `source_language` (falling back to the live `detected_language` when `unknown`), rather than a client-supplied value.
- [x] All inference writes go through the server endpoint regardless of which viewer triggered the translation — single code path, auditable, no client-side divergence.

### What "Phase 2 done" means
- Two test users on two devices can each see only their own messages.
- An adversarial test (one user attempting to read another's data via direct Supabase calls with their token) fails.
- A test deletion request results in the user's profile and metadata being removed while the anonymized translation pairs remain.
- Profile inference runs server-side; no client-side writes to `user_linguistic_profiles` or `user_profile_events`.

---

## Phase 3 — Real conversation model

**Goal:** Move from "one global room" to "users have many conversations with many participants." This is where the data model gets deliberately re-evaluated for future efficiencies before changes are committed.

### Schema
- [ ] `conversations` table
- [ ] `conversation_members` table
- [ ] `messages.conversation_id` foreign key
- [ ] `conversation_contexts` rows scoped per conversation (already in place from Phase 1)
- [ ] **Deliberate planning step:** before implementing, do a focused review of the data model with future efficiencies in mind — translation deduplication across conversations, caching strategies, multi-tenant scoping. Document conclusions in `decisions.md`.

### UI
- [ ] Conversation list view
- [ ] Create conversation flow
- [ ] Invite-to-conversation — reuses the Phase 2 `invites` + `invite_redemptions` primitive (built in Phase 2 for contact-add; extended here to conversation-join). Not a username-only flow: add by any discovery handle the user already has, subject to discovery policy + handle minimization (policies.md §2)
- [ ] Per-conversation context type setting. **This is where the in-chat context/register dropdown moves** — kept in the header through Phase 2, relocated to per-conversation setting here (auto-inference is the longer-term target; see parking-lot.md "Context type: auto-inferred, not manually set")

### What "Phase 3 done" means
- A user can have multiple distinct conversations with different other users.
- Each conversation has its own context type and conversation context.
- The data model is documented and approved as the basis for Phase 2 API growth.

---

## Phase 4 — Corrections capture

**Goal:** Start the data flywheel. Begin accumulating the corrections corpus that makes Phase 2's API defensible.

### Schema (build before features that fill them)
- [ ] `translation_corrections` table
- [ ] `translation_reviews` table

### Capture surfaces
- [ ] Thumbs-up / thumbs-down on every translated message
- [ ] Inline edit on the translation (the user fixes it; we record the original output and the fix)
- [ ] Bilingual user identification (if a user has multiple `known_languages` covering both ends of a translation, their edits get the highest weight)

### Pipeline
- [ ] Edits write to `translation_corrections` with full snapshots of profile and conversation register at correction time
- [ ] Background job processes correction patterns weekly: cluster by dialect, identify recurring failure modes

### What "Phase 4 done" means
- The app has surfaces for users to correct translations.
- Corrections are flowing into the corrections table with all required snapshots.
- We can produce a weekly report of "what kind of translations got corrected most."

---

## Phase 5 — Mobile

**Goal:** A chat app that lives where chat apps live. Until this phase, the product is web-only and that's fine for testers but not for consumer-grade reach.

This phase intentionally has less detail. We'll plan it when we get there.

Known constraints:
- React Native is the leading framework choice (shares logic with existing React).
- Mobile real-time push notifications are non-trivial — likely a vendor (OneSignal, Expo Push) rather than rolling our own.
- iOS App Store submission has lead time; factor in.

---

## Phase 6 — Open the API (Phase 2 of the strategic plan)

**Goal:** First external customer of the translation API. This is when the trojan horse strategy plays out.

This phase will get detailed when we're approaching it. High-level items:

- Public API documentation
- Developer authentication separate from end-user authentication (API keys + RBAC)
- Rate limiting and usage metering
- Webhook support for batch translation jobs
- Billing integration (Stripe likely)
- SDK in one or two languages (JavaScript and Python likely)
- Marketing-grade demo deployment that prospects can try
- Internal benchmark of translation quality on corrections-derived hard cases (used as primary sales tool)
- First customer in the dating vertical (per strategy.md, highest fit)

---

## Operating principles for this roadmap

- One phase at a time. Don't start Phase N+1 work until Phase N is closed.
- Phase order is firm. Re-ordering requires a decisions.md entry.
- Phases can grow new items as work reveals them. Items move down (or get deleted) when they're invalidated by new information.
- Items get checked when they're done in code and on `main`, not when they're written or planned.
