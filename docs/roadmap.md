# Translation App — Roadmap

> Living document. Owns the prioritized list of work, organized by phase. Checkbox style so we can see progress at a glance.
>
> **What lives here:** committed work in priority order.
> **What does NOT live here:** ideas we haven't decided to build. Those go in `parking-lot.md`.

**Last updated:** 2026-07-07 — docs legibility cleanup (added this Contents TOC + phase statuses; update history moved to the Changelog). Substantive prior update 2026-07-05 ("Next up — translate model selection"). Full history in [Changelog](#changelog).
**Owner:** Isaac (iwitt1)

---

## Contents

| Section | What it's for | Status |
|---|---|---|
| [Next up — translate model selection (latency vs quality vs cost) (added 2026-07-05)](#next-up--translate-model-selection-latency-vs-quality-vs-cost-added-2026-07-05) | Pick the translate model (latency/quality/cost) + this docs cleanup | 🔶 Model shipped 07-07; docs cleanup in progress |
| [Phase 0 — Foundation](#phase-0--foundation) | Get the codebase + docs ready for Phase 1 (cheap structural prep) | ✅ Done (2 minor items open) |
| [Phase 1 — Contextual translation (the thing we came here for)](#phase-1--contextual-translation-the-thing-we-came-here-for) | Context/register/dialect/gender-aware translation — the core value prop | ✅ Done |
| [Phase 1.5 — Set up Hermes Agent](#phase-15--set-up-hermes-agent) | Stand up the Hermes execution agent on a VPS | ⏸️ Paused — infra shipped, Hermes not adopted |
| [Phase 2 — Multi-user safety](#phase-2--multi-user-safety) | Auth, identity, RLS, deletion — shareable without privacy risk | ✅ Done (prod cutover 2026-06-11) |
| [Phase 2.1 — Close auth / security gaps before widening access](#phase-21--close-auth--security-gaps-before-widening-access) | Lock the API endpoints before widening access | ✅ Done (2026-07-16 — token auth + refresh/rotation GREEN; 2 Hermes items killed) |
| [Phase 2.2 — Enable real multi-user testing](#phase-22--enable-real-multi-user-testing) | Remove friction (SMTP, persistent login) for real testers | 🔶 3+-user smoke checklist written, run pending |
| [Phase 2.3 — Public demo site + case-study landing](#phase-23--public-demo-site--case-study-landing) | Shareable jistchat.com case-study page → live demo | ✅ Done (own-voice copy landed ~2026-07-15) |
| [Phase 2.4 — Demo-readiness polish + repo hardening](#phase-24--demo-readiness-polish--repo-hardening) | App usability (settings, languages, symbology, realtime) + repo scrub for sharing | ✅ Done (2026-07-08) |
| [Phase 2.5 — Group-chat polish (surfaced in 3-user testing)](#phase-25--group-chat-polish-surfaced-in-3-user-testing) | Sender attribution + search-to-add / system messages | ✅ Done (2026-07-16 — Spec 11 + 12 on prod) |
| [Phase 3 — Real conversation model](#phase-3--real-conversation-model) | Many conversations/participants (not one global room) | ✅ Done (prod cutover 2026-06-18) |
| [Phase 4 — Corrections capture](#phase-4--corrections-capture) | Start the corrections data flywheel | 📋 Planned |
| [Phase 5 — Mobile](#phase-5--mobile) | Native mobile app (React Native) | 📋 Planned (future) |
| [Phase 6 — Open the API (Phase 2 of the strategic plan)](#phase-6--open-the-api-phase-2-of-the-strategic-plan) | First external API customer — the actual business | 📋 Planned (strategic Phase 2) |
| [Operating principles for this roadmap](#operating-principles-for-this-roadmap) | How this roadmap is maintained | — |
| [Changelog](#changelog) | Dated history of roadmap changes | — |

**Status legend:** ✅ Done · 🔶 In progress · ⏸️ Paused · 📋 Planned.

---

## Next up — translate model selection (latency vs quality vs cost) (added 2026-07-05)

**Context:** the 2026-07-05 swap to `gpt-5.4` medium reasoning + prompt v2.0.0 (decisions.md same date) made quality significantly better — Isaac: "almost all nuance correct" on the staging gate — but translations now take **~7–10s**, too slow for live chat. Long-term the answer is caching + per-message model routing (parking lot); near-term it's picking the right single model/effort point deliberately instead of guessing.

- [x] **Model/effort analysis.** DONE 2026-07-07 via `scripts/model-comparison-test.mjs` (23 frozen cases × 6 configs, run under prompt v2.0.0 and v2.1.0 — results committed in `scripts/`). **Winner: `gpt-5.4:low`** — keeps every differentiator (professional usted, keigo, neutral-gender) at ~2.6s median, $6.5/1k. mini:low is the routing candidate for casual messages later. See decisions.md 2026-07-07.
- [x] **Capitalization-fidelity prompt fix.** DONE in prompt v2.1.0 (plus two bonus rules from run-1 findings: history-referent resolution, no invented gender forms). Run 2 confirmed all three landed on every model, including novel anti-memorization probes.
- [x] **Prod rollout** of `gpt-5.4:low` + prompt v2.1.0. DONE 2026-07-07: staging gate GREEN (one noted flake — "una vez en la vida" referent, logged as a known limitation → Phase 4 target), merged to main, regression cases re-run on prod PASSED. Perceived latency ~4s, down from 7–10s. See verification.md + decisions.md 2026-07-07.
- [x] **Username at onboarding** (added 2026-07-07, Isaac's call; built, gated GREEN on staging, and ROLLED OUT TO PROD same day — 020 replayed on prod before the frontend merge, per the deploy-order rule; self-revert SQL probes deferred to the settings-screen build). Onboarding now requires a user-chosen username alongside display name + language; claimed atomically with activation via `complete_onboarding()` → `change_username()` (migration 020). 365-day policy kept ("Usernames can be changed once per year" subtext), with a policy soften in the same migration: users can revert to their own prior usernames (blocked for everyone else). Flagged debt: settings screen (the promised change path) still parked, priority raised; availability feedback is submit-and-error (availability RPC parked). Gate: fresh staging signup exercising happy path + taken/reserved/invalid + atomicity probe + self-revert probes. See decisions.md 2026-07-07 "Username chosen at onboarding" + "Self-revert".
- [ ] **Docs legibility cleanup (review with Isaac before changing anything).** The doc set has drifted toward write-only: the "Last updated" headers on roadmap.md/verification.md are giant single-paragraph blobs that are (Isaac, 2026-07-05) "incredibly difficult to decipher." Goal: legible, MECE, and understandable by a lay reader — likely means moving update history into a dated changelog list, tightening section structure, and cutting duplication across docs. **Process note: this is a review-together session, not a solo sweep — propose the new structure to Isaac first, adjust, then execute.**

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

- [x] ~~Fix the Cowork sandbox so the session-start `git pull --ff-only` actually authenticates and runs.~~ **DROPPED 2026-07-16** (also tracked under Phase 2.1, killed there). Moot with Hermes shelved: no agent pushes between sessions, and Isaac runs the session-start pull in the repo directly — the sandbox is read-only-inspection-only and never runs git. Reopen if an autonomous between-session agent returns. See decisions.md 2026-07-16.

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
- [x] Supabase Auth via **magic links (email OTP)** as primary. Architecture supports a future password toggle (same JWT/session downstream; password path purely additive, switchable via config/UI without a refactor) *(Step 2 built; gate PASSED on staging 2026-06-10)*
- [x] Onboarding lifecycle per policies.md §6: P1 email submitted → magic link + `auth.users` row + DB trigger creates pending `profiles` row (uuid, random `system_generated` username, email identifier); P2 link clicked → onboarding screen; P3 submit display name + language → `status='active'`; P4 first message (engagement, not a status) *(Step 1 trigger + Step 2 app layer built; gate PASSED on staging 2026-06-10)*
- [x] Display name + language collected post-click on one onboarding screen ("the name other people see"). In-chat **language** selector removed. **Context/register** dropdown kept. *(built in Step 2; gate PASSED on staging 2026-06-10)*
- [x] Scheduled job: re-prompt pending accounts; delete abandoned ones after 30 days, release their system-generated username, record an email **hash** in the abuse-monitoring table *(Step 6 — **gate PASSED on staging 2026-06-11, 19/19 GREEN.** Vercel cron `/api/v1/jobs/abandonment` (daily 08:00 UTC) + `server/lib/abandonment.js` + migration 012 (two service_role-only `SECURITY DEFINER` helpers). Hard-deletes aged-pending via the admin API; the FK cascade releases the username (no release function by design); records a keyed **HMAC-SHA256** of the email (pepper in env, never in DB, `key_version=1`) before delete. **Re-prompt emails parked → future CRM** (no sending domain yet) — so the "re-prompt" half of this item is an intentional deferral, not built. Gate is `scripts/abandonment-gate-test.mjs` (exits 0 on staging, 19/19). **Prod replay of 012 pending the Phase 2 cutover (after Step 7).** See decisions.md 2026-06-10 "Step 6 abandonment + abuse monitoring" + verification.md Step 6 (gate result + counter-bug fix).)*
- [x] Token-based authentication on every backend API call, including the chat app's own calls *(DONE 2026-06-23 — built + prod-verified under Phase 2.1)*
- [x] Refresh / rotation behavior verified *(done under Phase 2.1 — gate `scripts/auth-refresh-gate-test.mjs` GREEN 7/7 on staging 2026-07-16)*
- [x] No data migration needed — staging is wiped at Phase 2 start (existing data is throwaway)

### Identity & discovery (per architecture.md §7 "Phase 2" tables; decisions.md 2026-06-09)
- [x] `profiles` table, `id = auth.users.id` (Model A — one tenant per user); migrate `user_id`/`sender_id` text → uuid *(profiles done Step 1; text→uuid cutover in migration 008 Step 2 — gate PASSED on staging 2026-06-10)*
- [x] `account_identifiers` (normalized handles, non-reusable usernames via never-deleted rows + reserved seeds) *(migration 007, Step 1 — verified)*
- [x] `account_settings` (per-user discoverability + `allow_dms_from`) *(migration 007, Step 1 — verified)*
- [x] Username policy mechanism: within-tenant uniqueness, `username_source`, `username_last_changed_at`; values in `lib/policies.js` + policies.md §1 *(Step 4 — `change_username()` RPC in migration 010 enforces charset/length/reserved/non-reuse + 1/365-day cadence; **gate PASSED on staging 2026-06-10, 22/22 GREEN** via `scripts/discovery-gate-test.mjs`. Prod replay pending.)*
- [x] Discovery: exact-match add by email/username only (no email search), autocomplete on username, **handle minimization** enforced in the query/API *(Step 4 — `find_account_by_email()` + `search_accounts_by_username()` RPCs in migration 010, SECURITY DEFINER, handle-minimized; **gate PASSED on staging 2026-06-10, 22/22 GREEN**. The *add* itself — writing `relationships` — is deferred to Step 5 per decisions.md 2026-06-10. Prod replay pending.)*

### Social graph primitives (schema + safety; DM *policy values* and DM *UI* are Phase 3)
*Step 5 — migration `011` + gate `scripts/social-graph-gate-test.mjs` **gate PASSED on staging 2026-06-10, 40/40 GREEN**; the Step 4 discovery gate re-passed 22/22 after the block-filter amend. **Prod replay of 011 pending the Phase 2 cutover** (depends on 007–010 existing first).*
- [x] `relationships` (contacts, with `via_identifier_type` provenance) — **canonical ordered-pair** representation (`account_lo`/`account_hi`/`initiator_id`, one row per unordered pair) makes the simultaneous-add glare race structurally impossible; `blocks` (with `unblocked_at` + partial unique index, modeled as an **override layer** that never mutates the relationship row); `reports` (atomic report **+** block). *(migration 011; gate PASSED on staging 2026-06-10)*
- [x] `invites` + `invite_redemptions` (deep-link primitive; serves contact-add now, conversation-join in Phase 3) — redemption **auto-accepts** the contact (`via='invite_link'`, `initiator=created_by`). *(migration 011; gate PASSED on staging 2026-06-10)*
- [x] `tenants.dm_initiation_policy` jsonb (sole tenant `'{}'` → mutual-acceptance-only); enforcement reads `lib/policies.js` defaults + tenant overrides *(column added in migration **007**, not 011; Step 5 enforces the mutual-acceptance **mechanism** via the contact-graph RPCs — the policy **values**/tiers remain Phase 3)*
- [x] `email_hash` abuse-monitoring table for abandoned-signup spam detection — shipped as `email_hash_abuse` (versioned **HMAC-SHA256**, `key_version` smallint, pepper computed in the Node job layer and never stored in the DB; RLS-enabled with **no** policy + REVOKE = service-role-only). *(migration 011; gate PASSED on staging 2026-06-10 — service-role-only denial confirmed. Pepper wiring + enforcement are Step 6.)*

### Row-level security
- [~] RLS policies on every table that exists by this point: `messages`, `message_translations`, `user_linguistic_profiles`, `conversation_contexts`, `user_profile_events`, and all Phase 2 identity/discovery/social tables (`profiles`, `account_identifiers`, `account_settings`, `relationships`, `blocks`, `reports`, `invites`, `invite_redemptions`, abuse-monitoring email-hash table) *(migration 007 + 008 cover profiles/account_identifiers/account_settings/messages/message_translations/ulp/upe; the social tables — `relationships`, `blocks`, `reports`, `invites`, `invite_redemptions`, `email_hash_abuse` — carry RLS from day one in migration 011, **verified by the Step 5 gate on staging (40/40)**. `conversation_contexts` RLS still outstanding.)*
- [~] Tenant-scoped policies on top of user-scoped policies (use `auth.uid()`; tenant scope via `tenant_id`) *(all Step 1 + Step 2 policies follow this pattern; the shipped subset is verified by the Step 3 gate — cross-tenant isolation confirmed both directions. Remains partial until Steps 4–5 add the social tables.)*
- [x] **No RLS exists in Supabase today** — this is greenfield. Every policy must live in a migration from day one. Confirmed: migrations 007 and 008 ship RLS with the tables.
- [x] Test that one user cannot read another user's data via dev tools or direct API queries *(Step 3 adversarial gate — PASSED on staging 2026-06-10, 21/21 GREEN via `scripts/rls-adversarial-test.mjs`; also covers self-escalation, cross-user write, cross-tenant isolation)*

### Data deletion
- [x] `data_deletion_requests` table *(Step 7 — **gate PASSED on staging 2026-06-11, 37/37 GREEN.** Migration `013_phase2_step7_data_deletion.sql`: net-new table + RLS (`ddr_select_own`) + 6 RPCs. `user_id` FK = **ON DELETE SET NULL** so the audit row survives its own erasure. Columns extend architecture.md §7's sketch with `grace_until`/`requested_by`/`cancelled` (decisions.md 2026-06-11). **Prod replay pending the Phase 2 cutover.**)*
- [x] Deletion job that anonymizes corrections (strips user_id and PII, keeps translation pairs) rather than hard-deleting *(Step 7 — **gate PASSED on staging 37/37.** Two-phase: `request_account_deletion()` soft-deletes + enqueues with a 30-day grace; `cancel_account_deletion()` reverses; the Node sweep `server/lib/deletion.js` (Vercel cron `/api/v1/jobs/deletion`, daily 09:00 UTC, `CRON_SECRET`-guarded) hard-deletes due requests. The 007/008 FK chain anonymizes — profile/identifiers/settings/ULP/events cascade, `messages.sender_id`→NULL **retains content**. **Corrections anonymization is a no-op stub** — `translation_corrections` isn't built yet, so the sweep logs `corrections_anonymized:0`; wire the strip-PII pass when that table lands. Records the keyed email HMAC reusing `email_hash_abuse` (no schema change; `source`-split parked). **Prod replay of 013 pending the Phase 2 cutover.** See decisions.md 2026-06-11 + verification.md Step 7.)*

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
> **BUILT + VERIFIED 2026-06-10 (Option A).** `POST /api/v1/infer-profile` (Express + Vercel) + `server/lib/inferProfile.js`; raw-pg `SELECT … FOR UPDATE`; client fires-and-forgets `message_id`; flag renamed `PROFILE_INFERENCE_ENABLED` and on. See `decisions.md` 2026-06-10 "Server-side profile inference (Option A)" and `verification.md` "Server-side profile inference". **Gate PASSED on staging 2026-06-10** (two users → sender's profile row updated, event rows landed, trust boundary + dialect guard both confirmed). **Prod enablement DONE 2026-06-11** as part of the Phase 2 cutover — migration 015 (least-privilege `profile_writer` role) applied on prod, `LOGIN` enabled out of band, `DATABASE_URL_PROFILE_WRITER` set in Vercel Production (port 6543). The two-user inference path on prod is the one remaining check (rate-limited this session).

- [x] Move `applyInferences` logic to a server-side function (dedicated `/api/v1/infer-profile` endpoint). Client fires inference payload to the endpoint; server applies guards and writes atomically — eliminates the race condition via `SELECT … FOR UPDATE`.
- [x] Dialect consistency guard updated to anchor on the authoritative server-read `source_language` (falling back to the live `detected_language` when `unknown`), rather than a client-supplied value.
- [x] All inference writes go through the server endpoint regardless of which viewer triggered the translation — single code path, auditable, no client-side divergence.

### What "Phase 2 done" means
- Two test users on two devices can each see only their own messages.
- An adversarial test (one user attempting to read another's data via direct Supabase calls with their token) fails.
- A test deletion request results in the user's profile and metadata being removed while the anonymized translation pairs remain.
- Profile inference runs server-side; no client-side writes to `user_linguistic_profiles` or `user_profile_events`.

---

## Phase 2.1 — Close auth / security gaps before widening access

*Added 2026-06-23. Numbered 2.x as Phase-2 (multi-user safety) follow-ons, but picked up **now**, after the Phase 3 cutover. **Ordered ahead of 2.2 deliberately** (reordered 2026-06-23): lock the endpoints before 2.2 removes the email throttle that currently keeps strangers out. See decisions.md 2026-06-23 "Phase 2.1 / 2.2 — auth-hardening + testing-enablement sub-phases".*

**Goal:** Close the authentication and operational gaps the Phase 2 cutover left open, **before** the app is shared more widely. These are the locks; Phase 2.2 opens the doors.

- [x] **Token-based authentication on every backend API call** (`/api/v1/translate`, `/api/v1/infer-profile`), including the chat app's own first-party calls. *This is the canonical home for the still-open Phase 2 "Authentication" item. The endpoints are callable today without a verified user JWT — architecture.md §8/§10 list token-on-API as target state, not current. RLS protects the database; it does **not** authenticate these API endpoints, so this is a cost/abuse exposure (anyone can call the translate endpoint, which burns OpenAI spend). **Blocks the Phase 2.2 SMTP item** — don't widen signup access while these endpoints are open.* **→ BUILT 2026-06-23** (`server/lib/auth.js` helper + all four handlers + `apiFetch` wrapper on the 3 frontend call sites; `getClaims()` local-JWKS verification via the **anon** key — no service-role on the hot path, no new Vercel env var; `translation_events` now records the real `user_id`). **→ MERGED TO MAIN / on prod 2026-06-23** (accidental early merge — no staging gate was run; decision: move forward, no users yet + change only tightens previously-open endpoints + graceful network fallback; see decisions.md). **Prod smoke GREEN 2026-06-23** (logged-in send → `/api/v1/translate` 200, translation rendered) → **DONE**. Follow-ups (non-blocking): enable Supabase asymmetric JWT signing keys (staging→prod) as a perf step, and the `api-auth-gate-test.mjs` negative-path gate. See decisions.md 2026-06-23 "Token auth on backend API calls" + verification.md "Phase 2.1 — Token auth".
- [x] **Refresh / rotation behavior verified.** **DONE 2026-07-16 — gate GREEN 7/7 on staging** (`scripts/auth-refresh-gate-test.mjs`, which also absorbs the previously-proposed `api-auth-gate-test.mjs` no-token/garbage/valid checks). Confirmed: rotation issues a new access + refresh token, the endpoint accepts the rotated token, and reuse of a superseded refresh token is rejected (`400 Already Used`). Reuse detection is ON (10s) on staging + prod — no config change needed. See verification.md "Phase 2.1 — Refresh / rotation behavior".
- [x] ~~**Delete the stray `hermes_test` row in prod `translation_events`**~~ **CLOSED 2026-07-16 — already moot.** The row was **already cleared** by the 2026-06-11 prod-cutover `TRUNCATE` (operations.md "Prod cutover — EXECUTED 2026-06-11"); this item was a stale roadmap entry the two docs disagreed on. Confirm anytime read-only: `SELECT * FROM translation_events WHERE id = '0f1ff660-33df-4bbc-a44f-bbde739bec11';` → expect 0 rows. See decisions.md 2026-07-16.
- [x] ~~**Fix the Cowork↔Hermes sandbox `git pull` auth gap**~~ **KILLED 2026-07-16** — won't-do / moot. The item existed so the Cowork *sandbox* could pull *Hermes's* between-session pushes; Hermes is shelved and Isaac runs `git pull --ff-only` in the repo directly at session start (the sandbox does read-only inspection only, never git). Also dropped from the Phase 1.5 duplicate. See decisions.md 2026-07-16.

### What "Phase 2.1 done" means
- Every backend API call requires a valid user token; an unauthenticated call is rejected.
- Session refresh / rotation behavior is confirmed.
- Prod data is clean (stray test row gone) and Cowork reliably loads current docs at session start.

---

## Phase 2.2 — Enable real multi-user testing

*Added 2026-06-23 (reordered after 2.1, 2026-06-23). The enablers that gate putting real testers on prod. See decisions.md 2026-06-23 "Phase 2.1 / 2.2 — auth-hardening + testing-enablement sub-phases" + "Sending domain now, rebrand later".*

**Goal:** Remove the friction that currently blocks onboarding more than ~2 users at a time, so real multi-user testing on prod becomes possible. **Concrete target (decisions.md 2026-06-23 "Public demo on jistchat.com"):** the app, shareable with interviewers/employers, running on `app.jistchat.com` at a **demo-polished** bar.

- [x] **Domain — `jistchat.com` + Vercel custom domain.** *(DONE 2026-06-23 — `app.jistchat.com` live with valid SSL; Supabase prod Auth Site URL + redirect updated; magic-link round-trip verified landing on `app.jistchat.com`.)* Register `jistchat.com` (cheap, disposable placeholder — the "Sending domain now, rebrand later" instance). Point **`app.jistchat.com`** at the Vercel app (production); **reserve the root `jistchat.com` + `www` for the case-study landing page (Phase 2.3)**. Update Supabase Auth **Site URL + Redirect URLs** to `https://app.jistchat.com` (dashboard-only — the step that bit the Phase 2 cutover). Mostly registrar + Vercel + Supabase dashboard clicks; DNS propagation wait.
- [x] **Custom transactional email (SMTP) + sending domain.** *(DONE 2026-06-23 — Resend on `jistchat.com`: DNS verified, Supabase Auth SMTP configured, email rate limit raised, test magic link delivered from the domain. External signup is no longer rate-capped.)* Replace Supabase's built-in email (magic-link delivery, throttled ~2–4/hr) with a real provider (**Resend** recommended — lightest lift) sending from **`mail.jistchat.com`**, configured under Supabase → Authentication → SMTP. This is *the* production blocker for onboarding testers — magic-link is the only sign-in path, so the email cap *is* the signup cap. Also unblocks the parked re-prompt / CRM email. **Blocked by Phase 2.1 token auth** (done) — widening signup requires locked endpoints. **Domain strategy (decisions.md "Sending domain now, rebrand later"):** dedicated sending subdomain isolates reputation; keep all domain refs in config not code; verify SPF/DKIM/DMARC; pick a provider allowing multiple verified domains so a later rebrand is add-warm-switch. Doing it now is the cheap moment — little deliverability reputation to lose at demo scale. *(promoted from parking-lot.md "Custom transactional email (SMTP) + sending domain".)*
- [x] **Persistent login / stay signed in across refresh & tabs.** *(DONE 2026-06-23 — verified working with no build: Supabase's default `persistSession` + `autoRefreshToken` already keep users signed in across refresh and new tabs.)* **Verify-first:** Supabase Auth persists the session in `localStorage` and auto-refreshes tokens by default, so step one is confirming `persistSession` / `autoRefreshToken` in `src/lib/supabase.js` + the Auth session-duration setting *before* scoping any build — it may be largely on already. Removes most re-login friction (and email pressure on the SMTP item above). *(promoted from parking-lot.md.)*
- [x] **Sign-out control — confirm + fix mobile overlap.** *(DONE 2026-06-23 — two parts: (1) `handleSignOut` now `window.confirm`s before signing out; (2) sign-out moved out of the floating `fixed top-right` element into a **persistent top app bar** (mobile + desktop), so it can no longer overlap the conversation list's "+" button. The app bar supersedes the originally-planned "relocate into a menu" — it solves the overlap directly. **On prod + smoke-verified 2026-06-23.**)* Original bug: on phone widths the exposed top-right sign-out button overlapped the "+"/kebab area, so a mis-tap could force a logout — which, with no persistent session, costs a full magic-link round-trip. **Cheap first step:** a "Sign out?" confirmation prompt. **Proper fix:** move sign-out into an account/overflow menu. *(promoted from parking-lot.md.)*
- [x] **Hide empty / "ghost" conversations in the list.** *(DONE 2026-06-23 — `loadConversations(keepId=activeId)` now filters out message-less conversations except the one the user is actively viewing; `handleCreateConversation` passes the new id so a creator can still type into a fresh thread. **On prod + smoke-verified 2026-06-23.**)* A conversation someone starts but never sends in used to show in the other member's list on refresh. Frontend-only fix (option 1). *(promoted from parking-lot.md "Empty / message-less conversation is visible…".)*
- [ ] **Share-ready smoke.** With email working, sign up **3+ external accounts** and run a full multi-user smoke on prod (direct + group create, invite/join, cross-language translation, sender names) — the flows the Phase 3 cutover had to defer behind the 2/hr email cap. **Checklist WRITTEN 2026-07-16** — verification.md "Phase 2.2 — Share-ready multi-user smoke". **Run pending** (manual, on prod; needs 3 real inboxes). Check off after a clean run.

### What "Phase 2.2 done" means
- A new tester can sign up on `app.jistchat.com` by magic link without hitting an email rate limit.
- A signed-in user survives a refresh / new tab without re-authenticating.
- Sign-out can't be triggered by an accidental mobile mis-tap.
- No empty ghost conversations clutter a new user's list.
- The 3+-user flows deferred at the Phase 3 cutover pass live on prod.

---

## Phase 2.3 — Public demo site + case-study landing

*Added 2026-06-23. Portfolio/demo deliverable (not core product) — a webpage explaining what was built and how, aimed at interviewers/employers. See decisions.md 2026-06-23 "Public demo on jistchat.com".*

**Goal:** A shareable `jistchat.com` that leads with the story and links to the live demo — a single link that shows product thinking + how AI/agents were used to build it.

- [x] **Landing / case-study page at `jistchat.com` root** (+ `www`), separate from the app (which lives at `app.jistchat.com`). Likely a small standalone static page/project (keeps the SPA clean; independent deploy).
- [x] **Content — narrative + highlights** for a PM/hiring audience: the problem, the trojan-horse strategy (consumer app → B2B translation API), the phased build, and how the work was done with AI + a Cowork/Cursor/Hermes agent workflow. A few selected technical highlights (architecture sketch, 2–3 key decisions), screenshots. Readable, not a spec dump.
- [x] **"Try the live demo" CTA** → `app.jistchat.com`, so a reader flows from the write-up into the working product.
- [x] **Hosting decided** (built + deployed). The *confirm nothing sensitive is exposed* check moves into the Phase 2.4 **repo cleanup** item.
- [x] **Rewrite the case-study copy in my own voice** — ~~the current copy is AI-drafted.~~ **DONE ~2026-07-15** in a separate Cowork session — case-study copy reworked in Isaac's voice (landing folder: `jistchat-landing-site/index.html` + "Summary Site Copy V1_260715.docx"). Hermes kept out of public copy per decisions.md 2026-07-05.

### What "Phase 2.3 done" means
- `jistchat.com` shows a clear, credible case-study page with a working "Try the demo" link.
- A non-technical evaluator understands what the product is, the strategy, and how it was built; a technical one sees enough depth to be intrigued.

---

## Phase 2.4 — Demo-readiness polish + repo hardening

*Added 2026-07-07. Promoted from parking-lot: the app-usability items that make the demo genuinely good — ordered UI-first, then the repo-sharing prep. These gate a *good* public demo (Phase 2.3).*

**Goal:** The app is pleasant and navigable for a first-time demo user (including one who doesn't read English), and the repo is safe to share publicly.

- [x] **Account settings screen** (High). One place to change **language preference**, **username** (the once-a-year change the onboarding subtext already promises), **display name**, and **discoverability** toggles. Moves language out of the chat header — stops accidental full-history re-translation / credit burn. Bundles three previously-parked items. *(Promoted from parking-lot 2026-07-07.)* **Built 2026-07-08** (`SettingsModal.jsx` + `lib/settings.js` + migration 021): app-bar gear opens it, sign-out relocated in, validated RPCs (`set_preferred_language`, `set_display_name`, `change_username`) + own-row discoverability UPDATE; discoverability default flipped to **username-only** (email-off, existing rows backfilled). "Who can message you" pulled (unenforced → parking-lot). **On prod 2026-07-08 (migration 021 applied prod-first, then frontend merged to `main`); smoke GREEN.** See decisions.md 2026-07-08.
- [x] **Onboarding language list — native names + expanded set** (High). Show endonyms (Español, 日本語, Deutsch, …) not English exonyms, and offer more languages, so a non-English speaker can find theirs. *(Promoted from parking-lot.)* **Shipped 2026-07-07** (Spec 8, commit `69dc68b`) — staging gate GREEN; **merged to `main` 2026-07-07** (commit `1c37b14`), deploying to prod via Vercel; prod smoke still pending. See verification.md "Spec 8 + 9 — Demo-readiness polish (2026-07-07)".
- [x] **UI symbology for non-English navigation** (High). Icons/symbols on the core controls so the app is navigable without reading English — a lighter first step than full UI localization (which stays parked). *(Added 2026-07-07, Isaac.)* **Shipped 2026-07-07** (Spec 9, commit `c4eacbc`) — staging gate GREEN; **merged to `main` 2026-07-07** (commit `1c37b14`), deploying to prod via Vercel; prod smoke still pending. See verification.md.
- [x] **Conversation-list realtime** (Med). A conversation someone creates-with-you or invites-you-to should appear without a manual reload. Needs `conversation_members`/`conversations` added to the Supabase realtime publication + a second channel in `App.jsx`; intersects the realtime-RLS gap (parking-lot). A real demo friction point. *(Promoted from parking-lot.)* **Built 2026-07-08** (migration 022 publishes `conversation_members`; `App.jsx` adds a membership-INSERT channel + a reload-on-unknown-conversation guard on the messages channel). Only `conversation_members` published (`conversations` metadata-realtime deferred — no subscriber). **On prod 2026-07-08 (022 applied prod-first, frontend merged to `main`); two-account smoke GREEN.** See decisions.md 2026-07-08.
- [x] **Move the build/deploy marker into Settings** (Low, small). The commit-hash build marker used to sit `fixed bottom-left` on *every* page, overlaying the chat UI (cramped on mobile). *(Added 2026-07-08, Isaac.)* **Done 2026-07-08** — removed from `App.jsx`'s global chrome; now rendered only in the `SettingsModal` footer, bottom-right, small greyed mono (`__COMMIT_HASH__`), beside the sign-out row. **On prod 2026-07-08.**
- [x] **Repo cleanup for public sharing.** Scrub git history for secrets (e.g. gitleaks), decide public vs private, and confirm nothing sensitive (internal `/docs/`, infra details, keys) is exposed — folds in the Phase 2.3 "nothing sensitive" check. **Cleared 2026-07-08:** secret scan of the working tree + all 106 commits found **no secrets** (keys live in Vercel/Supabase env, `.env*` gitignored); the only "sensitive" content is benign cost/infra/aspiration detail that's fine (even credible) for a portfolio. **Decision: publish public, full history, docs kept as-is** (decisions.md 2026-07-08). Isaac flips GitHub visibility to public; nothing to scrub. Unblocks the Phase 2.3 docs-screenshot / repo link.

### What "Phase 2.4 done" means
- A first-time user who doesn't read English can navigate the core app and pick their language.
- Language / username / discoverability are changed in a settings screen, not the chat header.
- New and invited conversations appear without a manual reload.
- The repo is confirmed clean and safe to share publicly.

---

## Phase 2.5 — Group-chat polish (surfaced in 3-user testing)

*Added 2026-07-16 from the Phase 2.2 share-ready smoke: the first real 3-person test exposed two group-chat gaps. Both are demo-facing. Specced + approved with Cowork (Spec 11 + Spec 12, 2026-07-16), Cowork-built; the migration is Isaac-run on staging. Build pending Isaac's go-ahead.*

**Goal:** A group conversation is legible (you can tell who said what) and adding people is a search-first action, not a link hunt.

- [x] **Add-to-conversation: search-to-add + "X was added" system message** (High). Make the primary add path a username/email search that adds directly; demote "copy link" to a secondary fallback; post an iMessage-style "X was added to the conversation" system message; promote a `direct` chat to `group` when a 3rd person is added (closes the parking-lot quirk). *(Spec 11.)* **SHIPPED — on prod 2026-07-16** (Cowork): migration 023 (`messages.kind`+`payload`, `add_conversation_member`, `_member_added_finalize` promote+system-message, `redeem_invite` amended) + frontend. Staging smoke GREEN → 023 replayed on prod → merged to `main` + `vercel --prod` → prod smoke GREEN. See verification.md "Spec 11". Group-naming polish parked (High).
- [x] **Group-chat sender attribution — colored avatar + name (Option B)** (High). Colored initials avatar + colored sender name on received group messages, keyed on `account_id`, grouped by run. Reuses `ConversationList.avatarColor()`/`initials()` and `MessageBubble`'s existing `showSenderName`. *(Spec 12.)* **BUILT 2026-07-16** (Cowork, frontend-only: `ConversationList`/`ConversationView`/`MessageBubble`; palette 6→12 + within-conversation de-collision). Local `vite build` GREEN; **staging smoke GREEN + merged to `main` 2026-07-16 (commit `c681d2b`), on prod.** See verification.md "Spec 12".

### What "Phase 2.5 done" means
- In a 3+-person group, each received message is visibly attributed to its sender (stable per-person color) and consecutive messages group cleanly.
- You add someone by searching their handle; a system message records the add; a 1:1 that gains a 3rd person becomes a group.

---

## Phase 3 — Real conversation model

**Goal:** Move from "one global room" to "users have many conversations with many participants." This is where the data model gets deliberately re-evaluated for future efficiencies before changes are committed.

> **Forward-prep done (migration 014, 2026-06-11).** `messages.conversation_id` already exists — nullable, defaulted to the global-conversation sentinel `00000000-0000-0000-0000-000000000002`, and indexed — so this phase adds the conversations tables and *promotes* the existing column rather than backfilling. See decisions.md 2026-06-11 "Forward-schema prep before prod cutover".

### Schema
> **Step 1 DONE on staging (migration 017, 2026-06-12) — gate GREEN 35/35.** All four schema items below are implemented in `migrations/017_phase3_conversations.sql` (+ the `create_conversation`/`leave_conversation`/`set_conversation_context_type`/`is_active_member` RPCs and the `create_invite`/`redeem_invite` conversation-kind amendments) and verified by `scripts/conversations-gate-test.mjs` (35/35 on `translationapp1-staging`). **Applied on prod 2026-06-18 (Phase 3 cutover).** See decisions.md 2026-06-12 "Phase 3 Step 1 conversations schema" + 2026-06-18 "Phase 3 production cutover executed" + verification.md "Phase 3 — Step 1" / "Phase 3 — Step 4".
- [x] `conversations` table — insert the `…0002` global-conversation row so every pre-existing message already FK-resolves *(migration 017; staging gate GREEN; applied on prod 2026-06-18)*
- [x] `conversation_members` table *(migration 017, soft-leave model via `left_at`; staging gate GREEN; applied on prod 2026-06-18)*
- [x] `messages.conversation_id`: add the FK (→ `conversations`), `SET NOT NULL`, then **drop the migration-014 default** so real conversation ids take over. **No backfill** — every row already carries the sentinel. *(migration 017, promotion is DO-block-guarded + idempotent; staging gate GREEN; applied on prod 2026-06-18)*
- [x] `conversation_contexts` rows scoped per conversation (table in place from Phase 1) — **add its RLS policy here** (SELECT membership-gated / write-via-RPC); it shipped without RLS and must not serve real traffic until the policy lands (architecture.md §7) *(migration 017 adds the membership-gated SELECT policy + the `conversation_id` FK `NOT VALID`; staging gate GREEN; applied on prod 2026-06-18)*
- [x] **`messages` + `message_translations` RLS: tenant-scoped → membership-scoped (Step 2 / Spec 7).** Ends the "one global room" model at the authorization layer (017 ended it at the schema layer): a user may read/post a message, and read/write its cached translation, only as an active member of its conversation; realtime delivery follows the same predicate. *(migration 018 — policies-only, no DDL/data change; **staging gate `scripts/messages-rls-gate-test.mjs` GREEN 27/27 on 2026-06-12; sentinel purged; applied on prod 2026-06-18 (after 017, with the conversation-aware frontend)**. See decisions.md "Retire the global-room sentinel data".)*
- [x] **`conversations.context_type` vocab unified with the translation engine (migration 019).** The 017 column CHECK (`casual`/`professional`/`romantic`/`family`/`support`) diverged from the engine's `CONTEXT_TYPE_MODIFIERS` set (`casual`/`dating`/`professional`/`academic`); 019 unifies the table CHECK + the two RPC inline guards (`create_conversation`, `set_conversation_context_type`) onto the engine set, with a defensive remap of any retired-value rows (`romantic`→`dating`, `family`/`support`→`casual`). **Does not touch `detected_register`** (separate inference-output field). ALTER not recreate; single transaction; gate stays GREEN. *(applied on staging 2026-06-12 + prod 2026-06-18 (016→017→018→019) — shipped with the conversation-aware frontend. See decisions.md 2026-06-12 "Unify context_type vocab" + 2026-06-18 "Phase 3 production cutover executed".)*
- [x] **Deliberate planning step:** before implementing, do a focused review of the data model with future efficiencies in mind — translation deduplication across conversations, caching strategies, multi-tenant scoping. Document conclusions in `decisions.md`. **Done 2026-06-12** — see decisions.md "Phase 3 data model: conversations as the single membership-scoped primitive". Schema + write RPCs carved into Spec 6 (migration 017); membership-scoped messages RLS into Spec 7 (migration 018); cross-conversation dedup/caching explicitly deferred to parking-lot. (Migration 016 is an unrelated FK-cascade drift fix that slotted in ahead — see decisions.md 2026-06-12 "FK drift".)

### UI
> The server-side write layer for these flows ships in migration 017 (`create_conversation`, `leave_conversation`, conversation-kind `create_invite`/`redeem_invite`, `set_conversation_context_type`). The items below are the **UI** that calls them.
>
> **Frontend built 2026-06-12; smoke largely GREEN on Vercel Preview against staging (016–019 applied, both gates 35/35 + 27/27). Shipped to prod 2026-06-18 (Phase 3 cutover); 2-user prod smoke GREEN; 3rd-user/group deferred (email rate limit).** `src/App.jsx` rewritten from the single global-room view into a conversation-aware app: `ConversationList` + `ConversationView` + `MessageBubble` + `NewConversationModal` + `InviteModal` (markup ported from `mockups/phase3-conversations.html`), backed by the `src/lib/conversations.js` / `discovery.js` / `translation.js` data layers. **Sends now carry the real `conversation_id`** (the old insert omitted it — the coupling that gated the 017→018 prod replay). **Smoke GREEN (2026-06-12):** dedupe, optimistic send (no dupes), translation + "Original:" tap-to-expand, register + "?" (tooltip clips off-screen — parking-lot), no sub-line on own sends, network-loss retry, live realtime delivery, third-user invite/join, group create + sender-name rendering. **Two deferred quirks:** register tooltip clip; inviting into a `direct` chat doesn't promote it to `group`. See decisions.md 2026-06-12 "Phase 3 conversation-aware frontend" + verification.md "Phase 3 — Step 3" + parking-lot.
- [x] Conversation list view *(`ConversationList.jsx`; staging smoke GREEN)*
- [x] Create conversation flow *(`NewConversationModal.jsx` → `create_conversation`; direct create + dedupe smoke GREEN; group rendering still unverified — magic-link budget)*
- [x] Invite-to-conversation — reuses the Phase 2 `invites` + `invite_redemptions` primitive (built in Phase 2 for contact-add; extended here to conversation-join). Not a username-only flow: add by any discovery handle the user already has, subject to discovery policy + handle minimization (policies.md §2) *(`InviteModal.jsx` mints `create_invite`; `?join=<token>` redemption wired in App via `redeem_invite`. Third-user join smoke-GREEN. ⚠️ **known quirk:** inviting into a `direct` chat doesn't promote it to `group` — display/promotion gap, deferred; see parking-lot "direct→group promotion on invite" + verification.md Step 3)*
- [x] Per-conversation context type setting. *(RPC `set_conversation_context_type` built in 017; vocab unified to the engine set `casual`/`dating`/`professional`/`academic` in **migration 019**; UI in the `ConversationView` overflow (⋯) menu with the "?" explainer; staging smoke GREEN, persists across reload)* **This is where the in-chat context/register dropdown moved** — kept in the header through Phase 2, now in the per-conversation overflow menu (see `mockups/phase3-conversations.html`). Selectable list/labels/help come from `src/lib/vocabularies.js` (single app-layer source; tenant-scoped DB registry deferred — see parking-lot.md "Tenant-scoped option registry"). Auto-inference is the longer-term target (see parking-lot.md "Context type: auto-inferred, not manually set").

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


---

## Changelog

*Reverse chronological. One line per change; details live in `decisions.md`.*

- **2026-07-16** — Added **Phase 2.5 — Group-chat polish** (Spec 11 add-to-conversation search-to-add + "X was added" system message + migration 023; Spec 12 sender attribution avatar+name), both surfaced during the 3-user share-ready test. (→ specs.md Spec 11/12)
- **2026-07-16** — Wrap-up of 2.1–2.3: **Phase 2.1 ✅ closed** — refresh/rotation gate `scripts/auth-refresh-gate-test.mjs` GREEN 7/7 on staging; the two Hermes-era 2.1 items killed (stray row already cleared at the 06-11 cutover; git-pull gap moot) (→ decisions.md 2026-07-16). **Phase 2.3 ✅** — own-voice copy rewrite landed ~2026-07-15. **Phase 2.2** down to one item — the 3+-user share-ready smoke (checklist written in verification.md, manual prod run pending).
- **2026-07-08** — Phase 2.4 polish (staging feedback): dropped the "Original" label on inbound bubbles (caret-only, right=collapsed/down=expanded per disclosure convention); conversation-list preview now shows the translated last inbound message (cache at load + MessageBubble `onTranslated` callback); the original-text caret now appears only when the preview is actually truncated (ResizeObserver measurement). No read/unread marker added — the in-memory version (both the prior count badge and a trial bold-row) resets on reload, so it was removed entirely; the persistent read-cursor version is parked Med (parking-lot "Unread state"). **All on prod 2026-07-08.**
- **2026-07-08** — Phase 2.4: Conversation-list realtime shipped to prod (migration 022 publishes `conversation_members`; second `App.jsx` channel + reload-on-unknown-conversation) + build/deploy marker relocated into the Settings footer. (→ decisions.md 2026-07-08 "Conversation-list realtime")
- **2026-07-08** — Phase 2.4: Account settings screen shipped to prod (`SettingsModal.jsx` + migration 021 — `set_preferred_language`/`set_display_name` RPCs, discoverability default → username-only + backfill); app-bar gear entry, sign-out relocated; "Who can message you" parked. (→ decisions.md 2026-07-08 "Account settings screen")
- **2026-07-07** — Phase 2.4: Spec 8 (onboarding language list, ~40 endonym-first entries) + Spec 9 (lucide-react icons on core controls) shipped to staging, gate GREEN, prod merge pending. (→ decisions.md 2026-07-07 "Spec 8 + 9 shipped")
- **2026-07-07** — Promoted a pre-demo UX cluster from parking-lot into new **Phase 2.4** (account settings screen, native-name + expanded languages, non-English symbology, conversation-list realtime) + repo cleanup; checked off Phase 2.3 landing/content/CTA/hosting and added an own-voice copy-rewrite item. (→ decisions.md 2026-07-07 "Roadmap promotions + RLS gap")
- **2026-07-07** — Docs legibility cleanup: added Contents TOC + per-phase statuses; header de-blobbed; this Changelog added. (→ decisions.md 2026-07-07 "Docs legibility cleanup + new conventions")
- **2026-07-05** — Added "Next up — translate model selection"; parked 4 UI/language items. (→ decisions.md 2026-07-05)
- **2026-06-23** — Concretized Phase 2.2 (jistchat.com demo) + added Phase 2.3; added Phase 2.1/2.2 auth-first sub-phases; token auth marked done. (→ decisions.md 2026-06-23)
- **2026-06-18** — Phase 3 production cutover executed (migrations 016→019 + conversation-aware frontend). (→ decisions.md 2026-06-18)
- **2026-06-11** — Phase 2 production cutover executed (wipe + replay 007→015); Step 6/7 gates GREEN on staging. (→ decisions.md 2026-06-11)
- **2026-06-10** — Phase 2 Steps 2–6 gates GREEN on staging; `nonbinary` restored (009); server-side inference built. (→ decisions.md 2026-06-10)
- **2026-06-09** — Rewrote Phase 2 into magic-link auth + identity/discovery/social-graph design. (→ decisions.md 2026-06-09)
- **2026-06-02** — Phase 1.5 infra: Discord gateway + Sonnet routing live; Spec 2.1 carved out. (→ decisions.md 2026-06-02)
