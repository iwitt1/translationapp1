# Translation App — Roadmap

> Living document. Owns the prioritized list of work, organized by phase. Checkbox style so we can see progress at a glance.
>
> **What lives here:** committed work in priority order.
> **What does NOT live here:** ideas we haven't decided to build. Those go in `parking-lot.md`.

**Last updated:** 2026-05-17 (Phase 1 near-complete; dialect consistency guard shipped; server-side inference deferred to Phase 2)

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

## Phase 2 — Multi-user safety

**Goal:** The app is shareable with real testers without privacy concerns. Up until this phase, no third party should have the URL.

### Authentication
- [ ] Adopt Supabase Auth (email + password). Real user identities; UUID under the hood, username as display name
- [ ] Token-based authentication on every backend API call, including the chat app's own calls
- [ ] Refresh / rotation behavior verified
- [ ] Migration plan for existing user_profile rows (mostly: blow them away, this is a fresh start)

### Row-level security
- [ ] RLS policies on `messages`, `message_translations`, `user_profiles`, `user_linguistic_profiles`, `conversation_contexts`, every other table that exists by this point
- [ ] Tenant-scoped policies on top of user-scoped policies
- [ ] Test that one user cannot read another user's data via dev tools or direct API queries

### Data deletion
- [ ] `data_deletion_requests` table
- [ ] Deletion job that anonymizes corrections (strips user_id and PII, keeps translation pairs) rather than hard-deleting

### Staging environment
- [ ] Create a second Supabase project as a staging database. Same schema, no real data. Lets us run destructive migrations and feature tests without touching production data.
- [ ] Vercel environment variables: production points at the prod Supabase project; preview branches point at the staging project. Configure in Vercel dashboard.
- [ ] Establish migration workflow: all SQL migrations run against staging first, verified, then run against production.
- **Note:** If an autonomous build agent (e.g. Hermes) is introduced before Phase 2, pull this forward — the agent needs a safe target to deploy to and validate against before anything touches production.

### Profile inference (migrated from client-side)
- [ ] Move `applyInferences` logic to a server-side function (Supabase edge function or dedicated API endpoint). Client fires inference payload to the endpoint; server applies guards and writes atomically — eliminates the race condition from concurrent client-side writes.
- [ ] Dialect consistency guard updated to validate against the live translate response rather than the stored `source_language` field, now that the server has both in scope.
- [ ] All inference writes go through the server endpoint regardless of which viewer triggered the translation — single code path, auditable, no client-side divergence.

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
- [ ] Invite-by-username
- [ ] Per-conversation context type setting

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
