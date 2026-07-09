# Translation App — System Architecture

> Living technical document. Describes what the system is, the principles it's built on, and what we're migrating toward. Updated in the same commit as any architectural change.

**Last updated:** 2026-07-07 — docs legibility cleanup (added Contents TOC; §7 now points to the generated `schema.sql`; update history moved to the Changelog). Substantive prior update 2026-06-23 (Phase 2.1 token auth; Phase 2.2 domain/email/sessions). Full history in [Changelog](#changelog).
**Repo:** https://github.com/iwitt1/translationapp1
**Owner:** Isaac (iwitt1)

> **Read first:** `/docs/strategy.md` for product context, `/docs/roadmap.md` for what we're building when, `/docs/decisions.md` for why specific calls were made.

---

## Contents

- [1. What this is](#1-what-this-is)
- [2. Current state — what works today](#2-current-state--what-works-today)
- [What does NOT work today (in priority order to fix)](#what-does-not-work-today-in-priority-order-to-fix)
- [3. Architectural principles (never violate)](#3-architectural-principles-never-violate)
- [4. The layer separation](#4-the-layer-separation)
- [5. The translation API contract](#5-the-translation-api-contract)
- [6. The context object — the personalization mechanism](#6-the-context-object--the-personalization-mechanism)
- [7. Database schema](#7-database-schema)
  - [Live tables at a glance](#live-tables-at-a-glance)
  - [Tables that exist today (MVP)](#tables-that-exist-today-mvp)
  - [Tables to add in Phase 0 (cheap structural prep)](#tables-to-add-in-phase-0-cheap-structural-prep)
  - [Tables to add in Phase 1 (with the contextual-translation feature)](#tables-to-add-in-phase-1-with-the-contextual-translation-feature)
  - [Tables to add in Phase 1–2 (build the schema even before features fill them)](#tables-to-add-in-phase-12-build-the-schema-even-before-features-fill-them)
  - [Phase 2 tables (identity, discovery, social graph)](#phase-2-tables-identity-discovery-social-graph)
  - [Phase 2 DB functions (identity, discovery, safety, lifecycle)](#phase-2-db-functions-identity-discovery-safety-lifecycle)
- [8. How a translation moves through the system](#8-how-a-translation-moves-through-the-system)
- [9. AI integration — how it actually works](#9-ai-integration--how-it-actually-works)
- [10. Security and privacy posture](#10-security-and-privacy-posture)
- [11. Environments and config](#11-environments-and-config)
- [12. Deployment](#12-deployment)
- [13. File map](#13-file-map)
- [14. Brand & visual identity](#14-brand--visual-identity)
- [15. Glossary](#15-glossary)
- [16. Maintenance rules for this doc](#16-maintenance-rules-for-this-doc)
- [Changelog](#changelog)

---

## 1. What this is

A real-time multilingual chat application backed by an LLM-powered translation API. Every user sees every message in their preferred language. The chat app is the first-party client of its own translation API; the same API is the long-term commercial product (see strategy doc).

**Where it lives:**
- Code: GitHub (`iwitt1/translationapp1`)
- Backend (prod): Vercel serverless functions
- Backend (local dev): Node + Express on localhost:3001
- Database: Supabase (Postgres + Realtime)
- AI: OpenAI (`gpt-5.4` low reasoning for translate — since 2026-07-07, medium 07-05→07-07; `gpt-4o-mini` for detect)

---

## 2. Current state — what works today

- A single shared chat room; anyone with the URL joins by typing a username.
- Messages stored in `messages` table; broadcast to all connected clients via Supabase Realtime.
- Backend detects source language of each outgoing message before storing.
- On view, frontend compares source language to viewer's preferred language; if different, checks cache (`message_translations`) or calls backend for translation.
- Cached translations reused for every subsequent viewer at no additional OpenAI cost.

## What does NOT work today (in priority order to fix)

1. **Contextual translation is not implemented.** The translate prompt sees only the current message; no prior history is ever included. This is the biggest gap relative to the project's stated value proposition.
2. ~~**No structured inference return.**~~ **Built + verified on staging 2026-06-10** (server-side, `server/lib/inferProfile.js` + `/api/v1/infer-profile`; writes inferences to `user_linguistic_profiles` with `_source` tracking). Prod enablement deferred (prod safely no-ops until the least-privilege writer role + env var are set). Still true in **prod**.
3. ~~**No row-level security (RLS).**~~ **Built on staging** via migrations 007/008 — RLS enabled on `profiles`, `account_identifiers`, `account_settings`, `messages`, `message_translations`, `user_linguistic_profiles`, `user_profile_events`. Verified by the Step 3 adversarial gate (`scripts/rls-adversarial-test.mjs`). **Now live on prod** (Phase 2 cutover 2026-06-11; 018 moved messages/translations to membership-scoped on prod 2026-06-18).
4. ~~**No real authentication.**~~ **Built on staging** — Supabase Auth (magic-link / email OTP); identity is now the `auth.users` uuid via the `profiles` table. **Now live on prod** since the Phase 2 cutover (2026-06-11).
5. ~~**No conversation / room model.**~~ **Resolved on prod (Phase 3 cutover, 2026-06-18).** Migrations 017/018 add `conversations` + `conversation_members`, promote `messages.conversation_id` to a real FK, and move message authorization from tenant-scoped to membership-scoped. (Was: every message lived in one global `messages` table.)
6. ~~**No `tenant_id` on tables.** Will be retrofitted in Phase 0 — easy now, painful later.~~ Migration written 2026-05-12 (`migrations/001_tenants_and_tenant_id.sql`). Awaiting execution in Supabase.
7. ~~**No versioned API routes.** Current endpoint is `/api/translate`; needs to become `/api/v1/translate` in Phase 0.~~ Done 2026-05-12.
8. **No context-type parameter** (dating, professional, etc.) wired through.
9. ~~**Prompt drift between prod and local.** Local `server/index.js` has an extra prompt line that production `api/translate.js` lacks. Reconciled in Phase 0.~~ Done 2026-05-12.
10. **Wasteful detect-on-every-send.** Every message triggers an OpenAI detect call even when the sender's language is known.
11. **No error UX.** Translation failures silently fall back to the original text.
12. ~~**No way for users to set preferred language in the UI.**~~ **Resolved.** Set at onboarding via `complete_onboarding(...)`, and **changeable later in the settings screen** via `set_preferred_language()` (migration 021, 2026-07-08) — no longer a header control, so changing it can't accidentally re-translate all history. (Settings screen on prod 2026-07-08.)
13. ~~**Stray files at repo root** (`Bash`, `echo`, `which`). Gitignored but ugly; delete in Phase 0.~~ Done 2026-05-12.

---

## 3. Architectural principles (never violate)

These principles bind every architectural choice. If you find yourself proposing something that violates one, stop and update this document first.

1. **The frontend never calls OpenAI directly.** All AI traffic goes through our backend API.
2. **The chat app is a first-party client of its own translation API.** The frontend calls `/api/v1/translate` the same way an external developer would in Phase 2. No internal shortcuts that bypass the API contract. The API is built before it's opened.
3. **The translation layer knows nothing about chat.** Rooms, conversations, message storage, realtime subscriptions — none of this exists from the translation API's perspective. The translation API accepts text, target language, optional source language hint, and a context object. Where the context object came from is irrelevant.
4. **`tenant_id` on every table that holds user content.** Even at MVP with one tenant (you). Adding this retroactively is one of the most painful migrations in product history.
5. **`user_id` foreign key on every table with user-attributable data.** Required for GDPR Right to Erasure.
6. **Versioned API routes from day one.** `/api/v1/translate`, `/api/v1/detect`. New behavior gets a new version; old versions stay supported until deprecated.
7. **All translation prompts return structured JSON** including both the translated text and the model's inferences. Never throw away inference data.
8. **Corrections data is append-only.** Never mutate a correction. Snapshot the context at the moment of correction.
9. **Cache aggressively.** Same translation for the same `(message, target_language)` is computed once and reused forever.
10. **Backend is model-agnostic.** No model name hardcoded in places that would require refactoring to change. OpenAI today, possibly DeepSeek or fine-tuned model tomorrow.
11. **Production-safe security practices.** Real secrets in env vars, never in code. RLS on by Phase 2. No hand-rolled cryptography ever.
12. **Prefer minimal surgical code changes.** Don't refactor for elegance during a feature change; do the feature, then refactor in a separate commit.

---

## 4. The layer separation

This is the principle that makes the chat-app-to-API pivot trivial.

### Chat layer (knows about conversations, users, rooms)
- Conversations and conversation membership
- Message storage and retrieval
- Realtime subscriptions
- Conversation context assembly (querying the right tables, building the context object)

### Translation layer (knows nothing about chat)
- Language detection
- Translation execution
- Inference return
- Cache management

The chat layer assembles a context object and hands it to the translation layer. The translation layer doesn't know whether the request came from our chat app, a dating app, or an enterprise customer's CRM.

---

## 5. The translation API contract

### Endpoints (target state, achieved in Phase 0)

```
POST /api/v1/detect
POST /api/v1/translate
```

### Translation request body

```json
{
  "text": "Vamos al cine, che",
  "source_language_hint": "es",         // optional
  "target_language": "en",
  "context": {
    "user": {
      "dialect": "es-AR",
      "formality": "casual",
      "gender": "feminine",
      "known_languages": ["es", "en"]
    },
    "conversation": {
      "register": "romantic",
      "closeness": "acquainted"
    },
    "domain": null
  }
}
```

### Translation response body

```json
{
  "translated_text": "Let's go to the movies, you know?",
  "detected_language": "es",
  "inferences": {
    "detected_dialect": "es-AR",
    "dialect_confidence": 0.87,
    "detected_register": "casual",
    "register_confidence": 0.91,
    "gender_signal": "feminine",
    "gender_confidence": 0.73,
    "domain_signal": null,
    "idiomatic_elements": ["vos construction", "che"]
  },
  "ambiguity": {
    "detected": false,
    "confidence": 0.94,
    "alternatives": []
  }
}
```

The `inferences` object is the second product of every translate call. The chat layer compares each inferred value against the user's stored profile and decides whether to update the profile (see §8 on profile update logic).

The `ambiguity` object is the third product. When the model recognizes a phrase that has multiple plausible interpretations (sarcasm vs literal, idiom vs surface meaning, ambiguous pronoun reference, etc.), it returns `detected: true` along with the top alternatives. Example for an ambiguous case:

```json
"ambiguity": {
  "detected": true,
  "confidence": 0.55,
  "alternatives": [
    {
      "translated_text": "Oh great, just what I needed.",
      "interpretation": "sarcastic",
      "confidence": 0.55
    },
    {
      "translated_text": "Oh great, just what I needed!",
      "interpretation": "literal/grateful",
      "confidence": 0.45
    }
  ]
}
```

The chat layer decides what to do with the ambiguity signal. Likely uses: pre-send clarification UX ("we read this as sarcasm — is that what you meant?"), receiver-side hints showing the translation might be ambiguous, or quality tracking (ambiguity-flagged translations weighted differently in corrections). The clarification-on-send UX itself is parking-lot for now; the API contract is built ready for it.

---

## 6. The context object — the personalization mechanism

The context object is the structured-data alternative to baking personalization into natural-language system prompts. Target size: under 100 tokens.

### Why structured over natural-language

A natural-language system prompt explaining "you are translating for a feminine Spanish speaker from Argentina who is in a romantic conversation with an acquaintance, prefer casual register..." costs 400+ tokens. The structured JSON object above costs ~60. The model already knows what these terms mean; we're just naming them.

At MVP scale this doesn't matter financially. At the millions-of-calls-per-day scale Phase 2 targets, this is a meaningful cost difference and a real product decision.

### How it gets assembled

At translate-call time, the chat layer:
1. Queries `user_linguistic_profiles` for the requesting user.
2. Queries `conversation_contexts` for the current conversation.
3. Assembles the context object — explicit profile values always override inferred ones.
4. Includes the last N messages of the conversation as additional translation context (Phase 1: N=3).
5. Calls the translation layer with text + context.

### Explicit vs inferred values

The `_source` fields in `user_linguistic_profiles` (e.g., `dialect_source: 'explicit' | 'inferred'`) are non-negotiable. Without source tracking, you get bugs where inferred values silently overwrite values the user explicitly set. Explicit always wins. Inferred can update inferred, but never explicit.

---

## 7. Database schema

> **Source of truth for the *what*:** the exact current DDL lives in **`docs/schema.sql`** (a
> generated `supabase db dump --schema-only` snapshot, regenerated per migration by the
> `schema-dump` CI Action — operations.md §3) and in **`/migrations/`** (000–020, replayable in
> order). This section owns the ***why***: what each table is for, the relationships, and the
> constraints that carry meaning. Column-level detail (types, defaults, boilerplate keys) lives in
> `schema.sql` and is **not** repeated here.

**Where things stand:** all tables through migration **020 are live on prod** (Phase 2 cutover
2026-06-11 replayed 007→015; Phase 3 cutover 2026-06-18 replayed 016→019; 020 rolled out
2026-07-07). Per-migration status is in `roadmap.md`; the dated history + rationale are in
`decisions.md`. Two tables below (`translation_corrections`, `translation_reviews`) are **designed
but not built** — for those, this section is still the design of record.

### Live tables at a glance

Plain-English directory of the tables in `schema.sql` today — the technical detail is in the
subsections that follow.

| Table | What it's for |
|---|---|
| `tenants` | The workspace everything belongs to — one row today (the chat app); the seam for future B2B customers. |
| `messages` | The chat messages people send. |
| `message_translations` | Cached translations of each message, so the same text isn't paid to translate twice. |
| `conversations` | A chat thread — direct (1:1) or group. |
| `conversation_members` | Who belongs to each conversation. |
| `conversation_contexts` | The inferred "vibe" of a conversation (register, closeness) used to tune translation. |
| `user_linguistic_profiles` | What we've learned about how each person speaks — language, dialect, formality, gender forms. |
| `user_profile_events` | A history log of every change to those profiles (debugging + training data). |
| `translation_events` | A record of every translation call (model, cost, latency) for analytics. |
| `agent_events` | A record of Hermes agent task activity (the agent is currently paused). |
| `profiles` | A person's account — one per login. |
| `account_identifiers` | The handles people can be found by (email, username), kept normalized and non-reusable. |
| `account_settings` | Each person's privacy / discoverability preferences. |
| `relationships` | The contact graph — who is connected to whom. |
| `blocks` | Who has blocked whom. |
| `reports` | Abuse / spam reports filed against accounts. |
| `invites` + `invite_redemptions` | Shareable invite links and who redeemed them. |
| `email_hash_abuse` | A privacy-preserving signal to catch signup-spam without storing deleted users' emails. |
| `data_deletion_requests` | "Delete my account" (GDPR) requests + the audit trail proving it happened. |

*(Designed but not built yet: `translation_corrections`, `translation_reviews` — the future
corrections / quality-review store; sketches further down.)*

### Tables that exist today (MVP)

#### `messages`
> **RLS: membership-scoped as of migration 018 (Phase 3 Step 2 / Spec 7).** SELECT and INSERT
> now require `tenant_id = auth_tenant_id() AND is_active_member(conversation_id, auth.uid())` —
> a user may read or post a message only inside a conversation they are an active member of. This
> replaces the 008 tenant-only predicate (the "one global room" read/write boundary). **No UPDATE
> or DELETE policy** → messages remain immutable for `authenticated`. Realtime `postgres_changes`
> applies the SELECT policy for the `authenticated` role, so membership also governs realtime
> delivery (verified by the gate). Policy names are unchanged from 008 (`messages_select_same_tenant`,
> `messages_insert_own` — the `_same_tenant` suffix is now a slight misnomer; the predicate is tenant
> **and** membership).

- **`sender_id`** — migrated from the typed username string (text) to `uuid` FK `auth.users(id)`
  **ON DELETE SET NULL** (008): deleting an account nulls the author link but keeps the message —
  the data-deletion de-identification path (§10 / Step 7).
- **`conversation_id`** — promoted to a real FK → `conversations(id)` by migration 017; pre-staged by
  014 as nullable with the global-conversation sentinel default (`…0002`) so the promotion needed
  **zero backfill**. FK is NO ACTION on delete (conversations are soft-leave only, never hard-deleted).
- **`source_language`** — BCP 47 code, detected by the AI at send time.
- **Vestigial columns dropped by migration 014:** `room_id`, `translated_text`, `target_language`,
  `tone`, `context_id`, `model_version`, `latency_ms` — all superseded (`room_id`/`context_id` →
  `conversation_id` + `conversation_contexts`; `translated_text` → `message_translations`; `tone` →
  `context_type` + `detected_register`; `model_version`/`latency_ms` → `translation_events`). An
  `ALTER … DROP COLUMN` (not a recreate); decisions.md 2026-06-11 "Forward-schema prep".

#### `message_translations`
> **RLS: membership-scoped as of migration 018 (Phase 3 Step 2 / Spec 7).** The translation cache
> inherits the exact read/write boundary of the message it caches. Because the cache has no
> `conversation_id` column, all three policies (SELECT/INSERT/UPDATE) resolve membership through the
> parent message via `EXISTS (… messages m WHERE m.id = message_translations.message_id AND
> m.tenant_id = auth_tenant_id() AND is_active_member(m.conversation_id, auth.uid()))`. This is the
> easy-to-miss half of Spec 7: without it a non-member could read a conversation's translations even
> though they cannot read its source messages. The frontend upserts (`INSERT … ON CONFLICT DO
> UPDATE`), so INSERT `WITH CHECK` and UPDATE `USING`/`WITH CHECK` both carry the predicate. No DELETE
> policy (cache rows die via the `message_id` FK cascade). Policy names unchanged from 008.

- Unique `(message_id, language)` — one cached translation per message per target language.
- `message_id` FK is **ON DELETE CASCADE** (the cache is a strict child of its message). Reconciled to
  cascade on **both** environments by migration 016 after staging had drifted to NO ACTION (000's
  hand-reconstruction dropped the clause prod carried).
- `prompt_version` — semver of the prompt that produced the translation; null = pre-versioning (pre-003).

#### `user_profiles` — dropped
Replaced by `profiles`; **dropped** by migration 008 (staging) and in the Phase 2 prod cutover
(2026-06-11). Identity moved to the `auth.users` uuid (via `profiles`); language moved to
`user_linguistic_profiles.preferred_language`. Kept here only as a pointer — it is not in `schema.sql`.

### Tables to add in Phase 0 (cheap structural prep)

#### `tenants`
Seeded with one row representing the chat app itself; every other table carries a `tenant_id` FK to
it, and Phase 2 RLS scopes external customers by new tenant rows. `default_correction_ownership`
(`platform`|`tenant`|`shared`) and the other enum-like columns are **text + CHECK, not Postgres
enums** (project-wide anti-enum convention). Extra columns are added later: `dm_initiation_policy` and
`conversation_policy` (see the Phase 2 tables below).

### Tables to add in Phase 1 (with the contextual-translation feature)

#### `user_linguistic_profiles`
> **RLS:** SELECT same-tenant, UPDATE own (`user_id = auth.uid()`). Composite PK `(user_id,
> tenant_id)`; `user_id` is a uuid FK → `profiles(id)` ON DELETE CASCADE (recreated with the uuid key
> by 008). Enum-like columns are text + CHECK, not Postgres enums.

The per-user linguistic signal store — one row per user per tenant. Each inferred attribute pairs with
a `_source` column (`explicit` | `inferred`); **explicit always wins, and inference may only raise
confidence, never overwrite an explicit value** (§9). Notable: `gender_signal` distinguishes
`neutral` (source language has no grammatical gender — Finnish, Turkish, …) from `nonbinary` (speaker
uses gender-inclusive forms); migration 008 accidentally dropped `nonbinary` from the CHECK and **009
restored it** (decisions.md 2026-05-12 / 2026-06-10). `known_languages` (text[]) drives the
bilingual-corrector weighting in the flywheel.

#### `conversation_contexts`
> **RLS added 2026-06-12 (migration 017).** Live on staging since migration 002. 017 (Phase 3 Step 1)
> closes the long-standing RLS gap: a SELECT policy gated on active membership
> (`is_active_member(conversation_id, auth.uid())`) plus the `conversation_id` FK → `conversations(id)`
> **`NOT VALID`** (enforced on new/updated rows; legacy rows unscanned). Writes remain RPC-only.

Per-conversation register/closeness state, updated by a background job every N messages (**not** per
message). `detected_register` is the **inference output** (`professional`|`casual`|`romantic`|`family`|
`support`) — deliberately a different vocabulary from the user-chosen `conversations.context_type`.
`participant_ids` is **legacy** — `conversation_members` is now authoritative for access control; it's
retained only for the existing context-builder read path, not as a source of truth.

#### `conversations` (migration 017, Phase 3 Step 1)
> First-class conversation objects, replacing the implicit "everyone shares the global conversation"
> model. Created only via `create_conversation()`; never client-inserted. RLS: SELECT gated on active
> membership (`is_active_member`). The global-conversation sentinel (`…0002`) is seeded as a `group`
> row in the tenant sentinel (`…0001`) with `created_by NULL`.

- **`created_by`** FK → `profiles(id)` **ON DELETE SET NULL** — a conversation survives its creator's
  account deletion (persists while any member is active). This is why nothing currently reaps a
  fully-abandoned conversation (the parking-lot GC item).
- **`context_type`** (`casual`|`dating`|`professional`|`academic`, default `casual`) — the user-chosen
  register, **unified with the translation-engine vocab in migration 019** (was
  `professional/casual/romantic/family/support`). Set via `set_conversation_context_type()`; distinct
  from the inference-output `detected_register`.
- **`dedupe_key`** — sorted member-set string, populated only when the resolved policy is `dedupe`;
  arbiter of "one thread per member-set", enforced race-safely by the partial unique index
  `(tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL`.
- `kind` (`direct`|`group`) — a `direct` conversation must have exactly 2 members.

#### `conversation_members` (migration 017, Phase 3 Step 1)
> Membership rows, created/updated only via RPCs.

**Soft-leave model** (mirrors `blocks.unblocked_at`): leaving sets `left_at` rather than deleting the
row, so history and re-join stay clean, with one active row per (conversation, account) enforced by
the partial unique index `(conversation_id, account_id) WHERE left_at IS NULL`. `role`
(`owner`|`member`, creator = `owner`); `last_read_at` is the read-cursor for future unread counts.
FKs to `conversations` and `profiles` are both ON DELETE CASCADE.

### Tables to add in Phase 1–2 (build the schema even before features fill them)

*(`translation_corrections` and `translation_reviews` are **designed, not built** — not in
`schema.sql`; the column sketches below are the design of record for when they land.)*

#### `translation_corrections` (append-only) — NOT BUILT YET
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `tenant_id` | uuid | FK to tenants |
| `message_id` | uuid | FK to messages |
| `source_language` | text | |
| `target_language` | text | |
| `dialect_region` | text | **Snapshot** at time of correction |
| `original_text` | text | |
| `model_output` | text | What the AI produced |
| `corrected_text` | text | What the user changed it to |
| `correction_source` | text+CHECK | `'user_edit' \| 'thumbs_down' \| 'bilingual_review' \| 'ai_audit'` |
| `corrector_user_id` | uuid | nullable |
| `corrector_known_languages` | text[] | **Snapshot** of corrector's profile |
| `register_context` | jsonb | **Snapshot** of conversation register |
| `ownership` | text+CHECK | `'platform' \| 'tenant' \| 'shared'` |
| `created_at` | timestamptz | |

Snapshots are critical: context drifts, so you need what was true at the moment of correction, not
now. `corrector_known_languages` tells you whether the fix came from a native speaker of both
languages; `register_context` tells you what conversation state the model was operating under when it
failed.

#### `translation_reviews` — NOT BUILT YET
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `tenant_id` | uuid | FK to tenants |
| `translation_id` | uuid | References the specific translation event |
| `reviewer_type` | text+CHECK | `'ai_audit' \| 'human' \| 'bilingual_user'` |
| `reviewer_id` | uuid | nullable if ai_audit |
| `reviewed_at` | timestamptz | |
| `quality_score` | float | 0.0–1.0 |
| `flags` | text[] | e.g. `["register_mismatch", "idiom_error", "gender_error", "dialect_wrong"]` |
| `suggested_fix` | text | nullable |
| `confidence` | float | Reviewer's confidence in their assessment |
| `model_version` | text | nullable; if `ai_audit`, which model/prompt version reviewed |

Both human reviewers and AI auditors write into the same table — no schema changes when humans get
involved.

#### `data_deletion_requests` (migration 013, Phase 2 Step 7)
> **RLS:** SELECT own (`ddr_select_own`); all writes via SECURITY DEFINER RPCs.

Two-phase erasure: `request_account_deletion()` soft-deletes (`profiles.status='deactivated'`) and
enqueues a `pending` row with `grace_until = now()+30d`; `cancel_account_deletion()` reverses within
grace; the daily Node sweep (`server/lib/deletion.js`) hard-deletes due requests via the admin API.
The FK chain (007/008) does the anonymization — profile/identifiers/settings/linguistic-profile/events
cascade away, while `messages.sender_id` → NULL **retains content**. **The audit row outlives the
user by design:** `user_id` is FK → `profiles` **ON DELETE SET NULL** (not CASCADE), so the completed
request survives its own erasure as proof-of-deletion, with `user_id` nulled and a `deleted_fields`
jsonb snapshot of what was removed. On voluntary erasure the sweep records the same keyed email HMAC as
Step 6 (reusing `email_hash_abuse`), so `abandon_count` counts "times an account on this email hash
vanished" (abandonment **or** deletion; the `source` split is parked). Corrections anonymization is a
no-op stub until `translation_corrections` exists.

#### `user_profile_events` (append-only event source)
> **RLS:** SELECT own, INSERT own. First added by 005 (+ `task_id` in 006), recreated by 008 with a
> **uuid** `user_id` (FK `profiles`). The inference workstream writes here with `source='inference'`.

Append-only log (`source` ∈ `explicit`|`inference`|`correction_analysis`) that lets you reconstruct
what the system believed about a user at any point in time — critical for debugging bad translations
and for quality control on training data.

### Phase 2 tables (identity, discovery, social graph)

> Design rationale and trade-offs are in `decisions.md` (2026-06-09 + 2026-06-10 entries); policy
> *values* live in `policies.md` + `lib/policies.js`. **Identity vs. discovery principle:** the stable
> identity is the `auth.users` uuid; human-facing discovery handles are a separate normalized layer
> that points at it and is never a key.

#### Uniqueness scope (across vs. within tenant)
| Thing | Unique scope |
|---|---|
| `profiles.id` (uuid) | Global (across all tenants) |
| `tenant_id` | Global |
| invite `token` | Global (it's a URL) |
| `username` | **Within tenant** (`(tenant_id, canonical_username)`) |
| `display_name` | Not unique anywhere |
| email (at auth layer) | Global per Supabase project — see Model-A concern in decisions.md |

#### `profiles` (replaces `user_profiles`)
1:1 with `auth.users` (`id` = `auth.users.id`, FK ON DELETE CASCADE); RLS via `auth.uid()`. Adopts
**Model A — one tenant per user** (decisions.md 2026-06-09). Language/dialect do **not** live here —
they stay in `user_linguistic_profiles` (`preferred_language` written `explicit` at onboarding).
`username` is canonical-lowercase, unique **within tenant**, with `username_source`
(`system_generated`|`user_set`) + `username_last_changed_at` supporting the 1/year rule (policies.md
§1). `status` (`pending`|`active`|`deactivated`) + `onboarding_completed_at` drive the lifecycle
(policies.md §6); a DB trigger on `auth.users` insert creates the pending profile + a random username.
`is_verified` / `verification_method` are placeholders (no verification feature yet).

#### `account_identifiers` (normalized discovery handles)
Normalized handle rows pointing at `profiles` (ON DELETE CASCADE). `type` ∈
(`email`|`username`|`phone`|`friend_code`), `status` ∈ (`active`|`retired`|`reserved`) — **rows are
never hard-deleted**, and uniqueness on `(tenant_id, type, value)` across active+retired+reserved
enforces within-tenant non-reuse. Reserved words are seeded as `reserved` rows. **Handle
minimization** (policies.md §2): a discovery query returns only the matched handle, never an account's
other identifiers.

#### `account_settings` (per-user privacy prefs, 1:1)
1:1 with `profiles`: `discoverable_by_username` (default true) / `discoverable_by_email`
(**default false since migration 021** — new accounts are username-discoverable only; existing rows
backfilled to false, decisions.md 2026-07-08) + `allow_dms_from` (`everyone`|`contacts`|`nobody`,
default `contacts` — **stored but not yet enforced**; DM-initiation is currently governed by the
tenant-level `dm_initiation_policy` only, see parking-lot "DM-initiation control"). The discoverability
toggles are edited from the settings screen via a direct own-row UPDATE (`account_settings_update_own`).

#### `relationships` (contact graph; conversations are independent of this)
> **Canonical-pair model** (migration 011; decisions.md 2026-06-10 "Contact-graph representation").
> ONE row per unordered pair `{account_lo, account_hi}` with `account_lo < account_hi` enforced by a
> CHECK, replacing the originally-sketched directional `requester_id`/`addressee_id`. Direction is
> carried by `initiator_id` (whoever asked first), not by column position. The single-row invariant
> makes the **glare race** (both users hit "add" before either accepts) structurally impossible —
> both adds resolve to the *same* pair row, and the reverse-pending case auto-accepts.

Unique `(tenant_id, account_lo, account_hi)` is the anti-glare guarantee; a second index on
`(tenant_id, account_hi)` keeps "all of X's contacts" index-backed in both positions.
`via_identifier_type` records **provenance** (set at add-time, read by the DM-initiation policy;
`invite_link` set only by `redeem_invite()`). **RLS:** SELECT where the caller is `account_lo` or
`account_hi`; all writes go through `request_contact` / `respond_to_contact` / `redeem_invite`
(SECURITY DEFINER). State machine: new→`pending`, reverse-pending→`accepted` (mutual), `accepted`→
error, `declined`→re-request `pending`.

#### `blocks` (directional)
Stored directionally (`blocker_id` → `blocked_id`), `unblocked_at` nullable (null = currently blocked;
kept after unblock for history). A partial unique index on `(blocker_id, blocked_id) WHERE
unblocked_at IS NULL` prevents double-active-blocking while historical rows coexist; a second partial
index on the blocked leg backs the reverse check. **RLS: SELECT the blocker only** — the blocked party
must never learn they were blocked by reading this table. A block is an **override layer**: it never
mutates the `relationships` row; `active_block_exists()` (bidirectional) is checked first by every
initiation path and both discovery RPCs (symmetric hide). Writes via `block_account` /
`unblock_account`.

#### `reports`
`reason` ∈ (`spam`|`abuse`|`impersonation`|`other`); `status` ∈ (`open`|`reviewed`|`actioned`|
`dismissed`, default `open`). `report_account()` records the report **and** ensures an active block in
**one transaction** (atomic — both or neither). Multiple reports of the same target are allowed
(distinct incidents). No moderation-queue UI yet; rows accumulate at `status='open'`. **RLS:** SELECT
the reporter only (a future moderation tool reads via service role); `reports_no_self` CHECK.

#### `invites` + `invite_redemptions` (deep-link / invite-link primitive)
`invites` carries an opaque globally-unique `token`, a `kind` (`contact`|`conversation`), `created_by`,
optional `target_conversation_id` (Phase 3), `max_uses`/`use_count`, `expires_at`, and `revoked`.
`invite_redemptions` records one row per `(invite_id, redeemed_by)` (a re-click is a no-op, not a
re-add). Redeeming a `contact` invite **AUTO-ACCEPTS** the contact (decisions.md 2026-06-10) — it
writes a `relationships` row directly at `state='accepted'`, `via_identifier_type='invite_link'`,
`initiator_id = created_by`, with no separate accept handshake (minting the link is the creator's
consent; clicking is the redeemer's). Block-checked first. **RLS:** `invites` SELECT the creator only
(redemption is by token through the definer RPC, which also prevents enumeration); `invite_redemptions`
SELECT the redeemer only. Defaults at launch: multi-use, no expiry, revocable. Writes via
`create_invite` / `redeem_invite` / `revoke_invite`.

#### `tenants` — add columns
`dm_initiation_policy` jsonb — per-tenant overrides on top of `lib/policies.js` global defaults (sole
tenant launches `'{}'` → mutual-acceptance-only; policies.md §3). `conversation_policy` jsonb
(migration 017) — per-tenant overrides for conversation-dedupe (`{kind: 'dedupe'|'always_new'}`) on top
of `lib/policies.js` `CONVERSATION.DEFAULTS` (`direct: dedupe`, `group: always_new`); sole tenant
launches `'{}'`. Read by `create_conversation()` to decide whether a create reuses an existing thread.

#### Where policy lives (three layers)
1. `docs/policies.md` — human-readable values, audited on a cadence.
2. `lib/policies.js` — machine source of truth for **global** defaults; all enforcement reads here.
3. `tenants.dm_initiation_policy` / `tenants.conversation_policy` (jsonb) — per-**tenant** overrides.

Schema enforces *mechanism* (uniqueness, non-deletion, the partial index); layers 1–3 own *values*.

#### `email_hash_abuse` (signup-spam monitor; table + RLS in 011, writes in Step 6)
When an abandoned pending account is deleted (policies.md §6), a **keyed hash** of its canonical email
is recorded here — never the plaintext — so repeat-abandon / signup-spam is detectable without
retaining deleted-user PII. `email_hash` is `HMAC-SHA256(canonical_email, pepper)` (bytea) with a
`key_version` (default 1) and `abandon_count`, unique on `(tenant_id, email_hash, key_version)`. The
HMAC is computed in the **Step 6 abandonment job** (Node `crypto`) with the pepper read from an env
secret — **the pepper never enters Postgres**, so even a full DB compromise doesn't expose the key
(decisions.md 2026-06-10); `key_version` lets it rotate forward without re-keying old rows. **RLS:**
enabled with **no policy** for `authenticated`/`anon` *and* `REVOKE ALL … FROM anon, authenticated` —
fully denied to clients; only the service role (Step 6 job) touches it.

### Phase 2 DB functions (identity, discovery, safety, lifecycle)

These server-side functions are load-bearing for identity + RLS; treat them as part of the schema.
(Their SQL bodies are in `schema.sql`; described here for behavior/intent.)

- **`auth_tenant_id()`** (007, `SECURITY DEFINER`, SQL) — returns `tenant_id FROM profiles WHERE id = auth.uid()`. The linchpin of every tenant-scoped RLS policy. `SECURITY DEFINER` so it can read `profiles` without tripping the very RLS it feeds (avoids recursion); returns NULL for an unauthenticated caller → access denied by default.
- **`handle_new_user()`** (007, `AFTER INSERT` trigger `on_auth_user_created` on `auth.users`) — creates the pending `profiles` row + `email`/`username` `account_identifiers` + default `account_settings`. System username = `'user_' + 8 hex chars`. **Tenant hardcoded to the sole-tenant UUID `…001`**. If it raises, the `auth.users` INSERT rolls back (no orphaned auth rows).
- **`complete_onboarding(p_display_name, p_preferred_language, p_username DEFAULT NULL)`** (008, replaced by 020; `SECURITY DEFINER`, `EXECUTE` to `authenticated`) — the P1→P3 transition: sets `status='active'`, `display_name`, `onboarding_completed_at`, and creates the `user_linguistic_profiles` row with `preferred_language` written `_source='explicit'`. Since 020 it also (a) claims the user-chosen username via `change_username()` in the same transaction — atomic with activation, so pending accounts never hold user-chosen handles (preserves the Step 6 abandonment assumption) — and (b) enforces a `display_name` control-char/bidi denylist. Routed through an RPC precisely because `authenticated` may not write `status`/`username` directly (§10).
- **`find_account_by_email(p_email)`** (010, amended 011, `SECURITY DEFINER`, `EXECUTE` to `authenticated`) — Step 4 discovery. Exact-equality lookup on the canonical email; returns at most one `(account_id, display_name, username)`. Bypasses `account_identifiers`' own-rows-only RLS deliberately but **handle-minimizes** (never the target's email/phone/other identifiers). Tenant-scoped; active profiles only; respects `discoverable_by_email`; excludes the caller; **011 adds `AND NOT active_block_exists(caller, target)`**.
- **`search_accounts_by_username(p_prefix, p_limit)`** (010, amended 011, `SECURITY DEFINER`) — Step 4 username autocomplete. Prefix match on the canonical username. Min prefix 3, cap 20, LIKE metacharacters escaped. Tenant-scoped; active only; respects `discoverable_by_username`; excludes the caller; **011 adds the active-block filter** (both directions).
- **`change_username(p_new_username)`** (010, replaced by 020; `SECURITY DEFINER`) — the **sole** username-change path (`profiles.username` is REVOKEd from `authenticated`, §10). Validates charset/length/reserved/non-reuse + the 1/365-day cadence (the first `system_generated`→`user_set` change is free and starts the clock — consumed at onboarding since 020), then atomically retires the old `account_identifiers` row (never deletes) and activates the new one. **Since 020:** the caller may revert to their *own* retired handle (the retired row flips back to `active`); everyone else stays blocked (decisions.md 2026-07-07). Called directly (future settings screen) and by `complete_onboarding()`.

#### Phase 2 Step 5 social-graph RPCs (migration 011)

All nine are `SECURITY DEFINER`, `SET search_path = public`, `EXECUTE` granted to `authenticated`
only, and tenant-scoped via `auth_tenant_id()`. They are the **sole write path** to the Step 5 tables
(every social table is RLS SELECT-only / no policy, so direct client writes are denied).

- **`active_block_exists(p_a, p_b)`** — `STABLE` boolean helper; true iff an active block exists in **either** direction. `SECURITY DEFINER` so it reads `blocks` past the blocker-only RLS. Called first by the contact/redeem paths and both discovery RPCs.
- **`request_contact(p_target, p_via)`** → text — add-a-contact on the canonical pair. new→`pending`; reverse-pending→`accepted` (mutual); already-pending-by-caller / already-accepted→error; `declined`→re-request. Block-checked; rejects self/cross-tenant/`invite_link` via; locks the pair row `FOR UPDATE`.
- **`respond_to_contact(p_other, p_accept)`** → text — accept/decline an incoming `pending` request (caller must be the addressee). Accept→`accepted` (block-checked); decline→`declined` (kept soft for a future cooldown).
- **`block_account(p_target)`** → text — create an active block (idempotent). Does **not** mutate `relationships`.
- **`unblock_account(p_target)`** → text — stamp `unblocked_at`; history preserved.
- **`report_account(p_target, p_reason, p_details)`** → uuid — record a report **and** ensure an active block in one transaction (atomic).
- **`create_invite(p_kind, p_max_uses, p_expires_at, p_target_conversation_id)`** → text — **amended in 017** (4th param → DROP + CREATE). Mints an opaque base64url token. Defaults `contact` kind, multi-use / no-expiry / revocable. **017 un-rejects `conversation` kind** (requires the caller be an active member of the target).
- **`redeem_invite(p_token)`** → text — **amended in 017**. Validates token (revoked/expired/max-uses/cross-tenant/own-invite rejected), records the redemption. `contact` → **auto-accepts** the contact with the creator, returns `accepted`. **017:** `conversation` → inserts an active `conversation_members` row, returns `joined`. Block-checked.
- **`revoke_invite(p_invite_id)`** → text — revoke an invite the caller created.

#### Phase 2 Step 6 abandonment support functions (migration 012)

Unlike the RPCs above, these are **system functions** called only by the abandonment sweep as the
`service_role` (EXECUTE to `service_role` only); they don't use `auth.uid()` because the sweep operates
across all tenants. They exist because the sweep lives partly in Node (the abuse hash is a keyed HMAC
whose pepper never enters Postgres) but two pieces are cleanest in SQL:

- **`list_abandoned_pending_accounts(p_max_age interval DEFAULT '30 days')`** → setof `(account_id, tenant_id, canonical_email, username_source)` — `STABLE SECURITY DEFINER`. Every `pending` account older than `p_max_age`, with the canonical email to hash and `username_source` (the sweep refuses anything not `system_generated`). Backed by the `profiles_tenant_status_created_idx` partial index.
- **`record_abandoned_email_hash(p_tenant_id, p_email_hash_hex, p_key_version DEFAULT 1)`** → void — `VOLATILE SECURITY DEFINER`. Atomic insert-or-increment into `email_hash_abuse` (the +1 can't be a plain PostgREST upsert); hash arrives as hex, `decode()`d to bytea; on conflict bumps `abandon_count` + `last_seen`, preserving `first_seen`.

**No "release username" function exists by design:** the sweep deletes the `auth.users` row via the
admin API, and the FK cascade (007) drops the username/email rows, so within-tenant uniqueness +
historical-non-reuse no longer block the handle — it's released automatically (decisions.md 2026-06-10).

#### Phase 2 Step 7 data-deletion functions (migration 013)

Two **user-facing** RPCs (caller-scoped via `auth.uid()`, so a user can only erase themselves) plus
three **service_role-only** sweep helpers (mirroring the Step 6 split). The hard delete runs in Node
(`server/lib/deletion.js`) because `admin.deleteUser` is an auth-schema op and the abuse-hash pepper
must never enter Postgres.

- **`request_account_deletion(p_grace interval DEFAULT '30 days')`** → row — soft-deletes the caller (`status='deactivated'`) and enqueues a `pending` request with `grace_until = now()+p_grace`. **Idempotent** — returns an existing open request without resetting the clock.
- **`cancel_account_deletion()`** → boolean — reverses a `pending` request within grace (marks it `cancelled`, restores the profile); cannot cancel once the sweep has claimed it (`processing`).
- **`list_due_deletion_requests()`** → setof `(request_id, account_id, tenant_id, canonical_email)` — `service_role` only; pending requests past `grace_until`.
- **`claim_deletion_request(p_id)`** → boolean — atomic `pending`→`processing` (guards double-processing).
- **`complete_deletion_request(p_id, p_deleted_fields jsonb)`** → void — stamps `completed` + `completed_at` + the audit log, by PK (the row's `user_id` is already NULL from the cascade).

#### Phase 3 Step 1 conversation RPCs (migration 017)

All `SECURITY DEFINER`, `SET search_path = public`, `EXECUTE` to `authenticated` only, tenant-scoped
via the caller's profile. Sole write path to `conversations` / `conversation_members` (both RLS
SELECT-only).

- **`is_active_member(p_conversation_id, p_account_id)`** → boolean — `STABLE SECURITY DEFINER` membership helper; true iff an active (`left_at IS NULL`) membership row exists. Reads past the membership-gated RLS (mirrors `active_block_exists`); the linchpin of the conversation/members/contexts SELECT policies.
- **`create_conversation(p_kind, p_member_ids, p_title, p_context_type)`** → uuid — builds the distinct member set (incl. caller); rejects `<2` members and `direct ≠ 2`; enforces the single-tenant invariant; block-gated. Resolves dedupe from `tenants.conversation_policy` (fallback `CONVERSATION.DEFAULTS`); when `dedupe`, sets `dedupe_key` and **finds-or-creates** race-safely (INSERT, catch `unique_violation` → re-SELECT). Caller = `owner` on a fresh conversation.
- **`leave_conversation(p_conversation_id)`** → void — **soft-leave**: stamps `left_at` on the caller's active membership. No-op-safe.
- **`set_conversation_context_type(p_conversation_id, p_context_type)`** → void — validates against the CHECK set, requires the caller be an active member, updates `context_type` + `updated_at`.

(`create_invite` / `redeem_invite` were also amended in 017 for `conversation`-kind invites — see the
Step 5 RPC list above.)

### Phase 2.4 settings functions (migration 021)

Both `SECURITY DEFINER SET search_path = public`, `EXECUTE` to `authenticated` only. Called by the
settings screen (`SettingsModal.jsx` via `lib/settings.js`); the single validated write path for their
field.

- **`set_preferred_language(p_language)`** → text — validates non-empty (+ length cap), updates the caller's `user_linguistic_profiles.preferred_language` + `updated_at`. The change-later counterpart to `complete_onboarding`'s onboarding seed.
- **`set_display_name(p_display_name)`** → text — validates 1–50 chars after trim + the control-char/bidi denylist (identical to `complete_onboarding`), updates `profiles.display_name`. Exists so the denylist can't be bypassed by a raw client UPDATE (which `profiles_update_own` + the display_name column grant would otherwise allow).

(Migration 021 also flips `account_settings.discoverable_by_email` to default false and updates the `handle_new_user` trigger accordingly — see §7 `account_settings`.)

---

## 8. How a translation moves through the system

### Send path (target state)

1. User types and hits Send.
2. Frontend calls `POST /api/v1/translate` with mode `detect`, including the user's authentication token and `tenant_id`.
3. Backend authenticates, calls OpenAI to detect language, returns `{ detected_language }`.
4. Frontend inserts a row into `messages` with original text, detected language, conversation_id, tenant_id.
5. Supabase Realtime pushes the row to subscribed clients in the same conversation (scoped by RLS).

**Realtime channels (client, `App.jsx`).** Two membership-scoped `postgres_changes` subscriptions, both relying on RLS to deliver only rows the viewer may see (migrations 018 + 022): (1) `messages`-INSERT — drives the active thread + list snippet/unread, and reloads the list when a message lands for a conversation not currently shown (a fresh or previously-empty conversation appears live on its first message); (2) `conversation_members`-INSERT filtered to the viewer's own rows — reloads the list when the viewer is added to a conversation (a direct started with them, a group they're added to, an invite redeemed on another device). Published tables: `messages` (004), `conversation_members` (022). `conversations` is intentionally unpublished — no metadata-change (title/context_type) live-update subscriber exists yet.

### View path (target state)

1. A new message arrives via Realtime (or is loaded on page open).
2. For each message, the frontend compares the message's `source_language` to the viewer's `preferred_language`.
3. If match: display original text. Done.
4. If mismatch: check `message_translations` cache for `(message_id, target_language)`.
   - **Cache hit:** display cached. Done.
   - **Cache miss:** assemble context object (query `user_linguistic_profiles` for viewer, `conversation_contexts` for this conversation, include last N messages). Call `POST /api/v1/translate` with mode `translate`.
5. Backend calls OpenAI with the structured prompt. Receives translated text + inferences.
6. Backend compares inferences against the viewer's stored profile:
   - If stored value is `explicit` source → discard inference, keep explicit.
   - If stored value is `inferred` and new confidence is higher → update profile.
   - If no stored value → write inference to profile.
   - Log the change to `user_profile_events`.
7. Backend stores the translation in `message_translations` and returns it.
8. Frontend displays.

---

## 9. AI integration — how it actually works

### The fundamental constraint

LLMs have no memory between API calls. Every call starts fresh. The model wakes up with its full training intact but knows nothing about your specific user unless you tell it every single time. The database is doing the work the model cannot do — storing everything we know about the user and injecting it into every translate call.

### Prompt architecture

Every translate call has two components:
1. **System prompt** — static instructions about translation quality standards, idiom awareness, and the required JSON return format. Shared across all calls. Kept as short as possible (a fine-tuned model will eventually know most of this implicitly).
2. **Context injection** — the assembled context object (60–100 tokens of JSON). User- and conversation-specific. Assembled at call time from the database.

### Why we always return structured inferences

If we translate and discard the inferred dialect/register/gender, we throw away free intelligence the model already produced. By forcing the model to emit those inferences as structured fields, we:

- Build up `user_linguistic_profiles` automatically over time.
- Detect drift (someone's dialect shifting, register changing) without explicit user action.
- Feed the corrections pipeline with rich snapshots.

Retrofitting this into a prompt architecture that's been baked across many call sites is painful. Doing it now is one prompt change.

### Prompt versioning

Every meaningful prompt change increments `PROMPT_VERSION` in `lib/translatePrompt.js` (semver: major for schema changes, minor for new instructions/modifiers, patch for wording tweaks that could affect output). The version is stamped on `message_translations.prompt_version` at cache time.

This lets Phase 4 corrections analysis ask: "did quality improve after prompt version X?" without having to reconstruct what the prompt looked like at the time of translation. Translations cached before versioning was introduced have `prompt_version = null`.

Convention: increment the version in the same commit as the prompt change. The version string is the single source of truth — do not track prompt history in this doc.

### Model strategy

- **Current (2026-07-07):** mode-based split, configured in `lib/translatePrompt.js` (`TRANSLATE_MODEL`, `TRANSLATE_REASONING_EFFORT`, `DETECT_MODEL`) and consumed by both call sites. Translate runs `gpt-5.4` with `reasoning_effort: 'low'` (flat param — Chat Completions shape; the nested `reasoning: { effort }` is Responses-API-only); detect stays `gpt-4o-mini` (trivial classification, runs on every send — reasoning would add cost/latency for nothing). No `temperature` on translate calls: unsupported on gpt-5.4 reasoning calls. Effort chosen via the model-comparison harness (`scripts/model-comparison-test.mjs`, decisions.md 2026-07-07): low keeps every quality differentiator (professional usted register, keigo, neutral-gender handling) at ~2.6s median.
- **History:** MVP ran `gpt-4o-mini` for everything (prompt v1.x) — replaced after literal-translation failures (decisions.md 2026-07-05). Medium effort 07-05→07-07 — dropped after the harness showed no quality edge over low at 2–4x the latency (decisions.md 2026-07-07).
- **Small scale:** Per-message routing, now with a data-backed candidate policy from the 2026-07-07 harness runs: casual → `gpt-5.4-mini:low` (passes everything but professional register, 4x cheaper), professional/formal → `gpt-5.4:low`. Parking lot.
- **Funded:** Evaluate cheaper providers for cost; consider fine-tuning on corrections data once thousands of high-quality pairs exist.
- **Always:** Keep backend model-agnostic. The model names live in one configuration point (`lib/translatePrompt.js`), never hardcoded in business logic.

### Fine-tuning (deferred, parking lot)

Fine-tuning takes a base model and trains it further on our corrections data. Benefits:
- Shorter prompts (model implicitly knows our context).
- Better output on our specific use case.
- Can outperform a stronger non-fine-tuned model on our narrow task.
- Estimated cost when ready: $200–800 for the first meaningful training run on ~50k pairs.
- Requires thousands of high-quality labeled pairs first. Cannot start in Phase 1.

---

## 10. Security and privacy posture

### Current
- OpenAI API key lives in backend env vars only; frontend never sees it.
- Frontend never calls OpenAI directly.
- Supabase anon key is in the frontend bundle (by design — that's how a browser app talks to Supabase).
- **API token auth (Phase 2.1 — BUILT 2026-06-23 on branch, pending staging gate + merge).** Every backend engine call (`/api/v1/translate` incl. detect, `/api/v1/infer-profile`) requires a valid Supabase user JWT, verified in `server/lib/auth.js` (`authenticateRequest` → `{userId}`) via `getClaims()` — local JWKS verification once asymmetric signing keys are enabled, network fallback until then. Verification uses the **anon** key (`VITE_SUPABASE_*`), not the service-role key — least privilege, no privileged credential on the hot path, no new Vercel secret. RLS protects the *database*; this protects the *endpoints* (an open translate endpoint = anyone burning OpenAI spend). Inference is login-only (the message-derived trust boundary already prevents cross-user targeting). `translation_events.user_id` now records the verified user (was null); `tenant_id` stays the sole-tenant constant (moves to a JWT claim at multi-tenant). The helper is the single seam where the future B2B API-key path slots in. See decisions.md 2026-06-23 "Token auth on backend API calls".
- **Prod: RLS live.** Migrations 007/008 (RLS on identity/content tables) were replayed to prod in the Phase 2 cutover (2026-06-11); migration 018 moved `messages`/`message_translations` from tenant-scoped to membership-scoped on prod in the Phase 3 cutover (2026-06-18). The anon key is now safe to ship — RLS is the boundary.
- **Staging: RLS built and verified.** Migrations 007/008 enable RLS on all identity/content tables; the Step 3 adversarial gate (`scripts/rls-adversarial-test.mjs`) proves cross-user and cross-tenant isolation as real authenticated users.
- **⚠️ Known gap (found 2026-07-07): three tables have no RLS.** `tenants`, `translation_events`, `agent_events` are RLS-disabled and still carry the default `GRANT ALL TO anon, authenticated`, so any anon-key client can read/write them via the REST API — metadata only (tenant config + event log; **no chat text**), but tamperable, and cross-tenant-readable at multi-tenant. A Spec 4a oversight. Fix = a staging-first migration enabling RLS + revoking anon/authenticated (keep `hermes_*`/`service_role`). **Parked High, deferred until before real users.** See parking-lot.md "Phase 2 RLS / validation gaps" + decisions.md 2026-07-07 "Roadmap promotions + RLS gap".
- **Column-level write guard (007, OPUS-FIX #2).** RLS scopes *rows*, not *columns* — so even with a correct row policy, a `authenticated` user could PostgREST-PATCH `is_verified=true` on their own row to self-verify. Mitigation: `REVOKE UPDATE ON profiles FROM authenticated; GRANT UPDATE (display_name) ON profiles TO authenticated;`. Everything else on `profiles` (`status`, `username`, `is_verified`, …) is mutated only via `SECURITY DEFINER` RPCs (e.g. `complete_onboarding`, `change_username`). The Step 3 gate includes a self-write escalation negative test for exactly this.
- **Discovery RPCs deliberately bypass RLS (010, Step 4).** `account_identifiers` SELECT is own-rows-only, so cross-user discovery is impossible as a client query — by design. The three Step 4 RPCs (`find_account_by_email`, `search_accounts_by_username`, `change_username`) are `SECURITY DEFINER` and bypass that RLS *on purpose*, re-imposing the safety rules in code: **handle minimization** (return only `id`/`display_name`/`username`, never other identifiers or retired handles), tenant scoping via `auth_tenant_id()`, active-profiles-only, discoverability settings honored, and anti-enumeration limits (email exact-equality only; username prefix min-length 3 / cap 20 / escaped LIKE). EXECUTE is granted to `authenticated`, revoked from `anon`/`public`. Their correctness must be proven as real authenticated users (the Step 4 gate), since the postgres role bypasses RLS and would mask a leak.
- **Social-graph tables are RLS SELECT-only; writes are RPC-only (011, Step 5).** `relationships`, `blocks`, `reports`, `invites`, `invite_redemptions` each enable RLS with a narrow SELECT policy (party / blocker / reporter / creator / redeemer respectively) and **no** INSERT/UPDATE/DELETE policy — so `authenticated` cannot mutate the graph directly; the nine `SECURITY DEFINER` RPCs are the only write path and re-impose every rule in code (mutual-acceptance, block gating, atomic report+block, invite validity). `email_hash_abuse` is hardest: RLS-enabled with no client policy **and** `REVOKE ALL ... FROM anon, authenticated` → service-role only. Block privacy is deliberate: the blocker can SELECT their block row, the blocked cannot. The discovery RPCs are amended to filter active blocks (symmetric hide). Proven by the Step 5 gate (`scripts/social-graph-gate-test.mjs`) as real authenticated users, including a direct-client-write-denied negative test.
- **Server-side inference runs as a dedicated least-privilege role, NOT BYPASSRLS (015).** `server/lib/inferProfile.js` connects (via `DATABASE_URL_PROFILE_WRITER`, backend-only, never `VITE_`-prefixed) as the `profile_writer` role. It deliberately does **not** use `BYPASSRLS` (which Supabase now permits on PG 16+, but which is coarse — it skips RLS on *every* table). Instead the role holds **column-scoped grants** for exactly what inference touches (`SELECT (id, sender_id, tenant_id, source_language)` on `messages`; `SELECT` + `UPDATE (7 allowlisted cols + updated_at)` on `user_linguistic_profiles`; `INSERT (6 cols)` on `user_profile_events`) plus **RLS policies targeted `TO profile_writer`** that permit only those ops (`USING/WITH CHECK true`). Net: the DB authorizes the *operation*, the app authorizes the *row* (via the message-derived trust boundary, decisions.md 2026-06-10), and the role is **deny-by-default on every other table** — even an errant future grant is still blocked by RLS where no `profile_writer` policy exists. The role is created `NOLOGIN`; an operator enables `LOGIN` + a secret out of band (never committed). Column-level `UPDATE` also satisfies the `SELECT … FOR UPDATE` row lock (verified 2026-06-11). Proven by the inference gate on staging. (decisions.md 2026-06-11 "profile_writer role: scoped RLS, not BYPASSRLS".)
- **Conversation tables are RLS SELECT-only, gated on active membership; writes are RPC-only (017, Phase 3 Step 1).** `conversations`, `conversation_members`, and (now) `conversation_contexts` each enable RLS with a SELECT policy that resolves through the `is_active_member(conversation_id, auth.uid())` `SECURITY DEFINER` helper — a user sees only conversations they are an active member of — and **no** client INSERT/UPDATE/DELETE policy. The four Step 1 RPCs (`create_conversation`, `leave_conversation`, `set_conversation_context_type`, plus the amended `create_invite`/`redeem_invite`) are the sole write path and re-impose every rule (single-tenant invariant, block gating, member-count checks, race-safe dedupe, soft-leave). Proven by the Step 1 gate (`scripts/conversations-gate-test.mjs`, **35/35 GREEN on staging 2026-06-12; applied on prod 2026-06-18**) as real authenticated users, including a direct-client-write-denied negative test. **Note:** the companion `messages`/`message_translations` membership tightening is migration 018 (next bullet).
- **Messages + their cached translations are membership-scoped (018, Phase 3 Step 2 / Spec 7).** This ends the "one global room" model at the **authorization** layer (017 ended it at the schema layer). The read/write boundary on `messages` and `message_translations` moves from tenant-scoped to **membership-scoped**: a user may read or post a message, and read or write its cached translation, only if `is_active_member(conversation_id, auth.uid())`. `messages` SELECT/INSERT carry the predicate directly; the three `message_translations` policies resolve membership through the parent message (the cache has no `conversation_id` — the easy-to-miss cache-leak half). `messages` stays immutable (no UPDATE/DELETE policy). **Realtime is in scope:** Supabase `postgres_changes` runs the SELECT policy for `authenticated`, so the new predicate governs realtime delivery too — the gate (`scripts/messages-rls-gate-test.mjs`) verifies this explicitly rather than assuming it (realtime-RLS is a known footgun). This is the **highest-blast-radius security change since the Phase 2 RLS cutover** (it governs every message read, write, and realtime push), which is why it is a separate migration and a separate adversarial gate from 017. After 018, legacy global-conversation-sentinel messages go dark (no members) — intended. **Applied on prod 2026-06-18 (after 017); the prod sentinel purge was a no-op (messages=0).** Policies-only, no DDL/data change. (decisions.md 2026-06-12, 2026-06-18.)

### Target (post-Phase 2)
- Supabase Auth providing real user identity (stable `auth.users` uuid under the hood; `username` and `display_name` are separate handles, neither is the key — see §7 + decisions.md 2026-06-09).
- RLS enabled on every table (incl. the new identity/discovery/social tables). Messages visible only to participants. Profiles writable only by owner. Conversations scoped by membership. Discovery honors handle minimization (a user adding another sees only the handle they used).
- Tenant-scoped access on top of user-scoped access. A user in tenant A can never read data from tenant B.
- Token-based auth on every translate API call, even from the first-party frontend.

### Phase 2 migration is a coordinated cutover (breaking, by design)
The six new identity/discovery/social tables are **purely additive**. The **breaking** changes are
(1) `user_profiles → profiles` plus `user_id`/`sender_id` text→uuid, and (2) enabling RLS — the
moment RLS is on, the current anon-key / no-auth frontend can no longer read anything. This is
intended: new auth + schema + RLS + updated frontend ship **together** on a **wiped staging**
database (existing data is throwaway), and prod is untouched until staging verifies. Nothing breaks
accidentally — the current no-auth app is deliberately replaced.

### Privacy positioning (see strategy.md for marketable framing)

True E2EE and AI translation are architecturally in conflict. The defensible position is "encrypted in transit and at rest; plaintext exists transiently during translation; never logged, never stored, never used for training without explicit consent." Honest, marketable, and what we can actually deliver. The at-risk-user market (LGBTQ+ in criminalizing countries) is a different product with different requirements; recorded in the parking lot.

### Data retention & deletion

`data_deletion_requests` (migration 013, Phase 2 Step 7 — gate PASSED on staging, 37/37) tracks GDPR
Right-to-Erasure requests. The flow is **two-phase**: a user calls `request_account_deletion()`
→ profile soft-deletes to `deactivated` (reversible) and a `pending` request is enqueued with a
30-day `grace_until`; `cancel_account_deletion()` reverses within grace; a daily Node sweep
(`server/lib/deletion.js`, Vercel cron) hard-deletes due requests. The deletion job:
- Hard-deletes the `auth.users` row via the admin API → the FK chain (007/008) anonymizes:
  profile + identifiers + settings + linguistic profile + events **cascade away**;
  `messages.sender_id` → **NULL** (content + future translation pairs retained, author link severed).
- Will anonymize corrections (strip user_id + PII, keep pairs) — but `translation_corrections`
  is **not built yet**, so the sweep logs `corrections_anonymized: 0` for now.
- Never hard-deletes corrections/translation pairs — that destroys irreplaceable training data.
- Records the same keyed email HMAC as Step 6 (reuses `email_hash_abuse`) so delete-then-resignup
  abuse stays detectable without retaining PII.
- Leaves an **audit trail**: the request row survives the cascade (`user_id` FK is SET NULL), ending
  as `status='completed'` with `completed_at` + a `deleted_fields` log.

---

## 11. Environments and config

### Regions
- Supabase prod (`translationapp1`) and staging (`translationapp1-staging`) both in **`us-east-1`**.
- Vercel deployments default to multi-region edge; serverless function execution is close to user; database calls hit the configured Supabase region.
- Hermes VPS (Phase 1.5) will be provisioned in a matching US East region for low-latency calls to Supabase.

### Production domain, email & sessions (added 2026-06-23)
- **Production app:** `https://app.jistchat.com` (Vercel custom domain). `jistchat.com` is a disposable demo domain (decisions.md 2026-06-23 "Sending domain now, rebrand later"); the **root `jistchat.com` is reserved for the Phase 2.3 case-study landing page**, app on the `app.` subdomain (the stable anchor). `translationapp1.vercel.app` still resolves.
- **Auth Site URL:** Supabase prod Auth **Site URL + Redirect URLs** set to `https://app.jistchat.com` (the magic-link target; dashboard-only config — the step that bit the Phase 2 cutover).
- **Email:** magic links sent via **Resend** from `jistchat.com` (Supabase Auth → SMTP), replacing the built-in ~2/hr-capped sender; the Auth email rate limit was raised. SMTP creds live in the Supabase dashboard, not the repo.
- **Sessions:** persistent by default — Supabase `persistSession` + `autoRefreshToken` keep users signed in across refresh / new tab (verified 2026-06-23; no code change).

### Frontend env vars (root `.env`, exposed to browser, prefix `VITE_`)
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Safe to ship to the browser *once RLS is enabled*. Until then, treat the live URL as effectively a public read of the entire database.

### Backend env vars
- Local dev: `server/.env` containing `OPENAI_API_KEY`.
- Production: set in Vercel's environment variables panel as `OPENAI_API_KEY`.

The OpenAI API key never leaves the backend. Frontend never calls OpenAI directly.

**API token auth (added 2026-06-23, Phase 2.1)** — `server/lib/auth.js` verifies user JWTs via
`getClaims()`. It uses the **anon** key — `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` — which is
**already present in both Vercel Preview and Production**, so **no new Vercel env var** and no
service-role key on the hot path. (Server-side these are plain `process.env` values; the `VITE_`
prefix only affects Vite's client bundling.) **Local dev** now needs those two in `server/.env`
(previously only `OPENAI_API_KEY`). Plus a one-time Supabase config step: enable **asymmetric JWT
signing keys** (Project Settings → JWT Keys → Migrate JWT secret → Rotate keys; do **not** revoke
the legacy secret — that would force disabling the `anon`/`service_role` keys) so `getClaims()`
verifies locally; verification works via network fallback until then. Config state outside
`/migrations/` — see parking-lot.md "Other config state lives outside /migrations/".

**Step 6 abandonment cron (added 2026-06-10)** — the `/api/v1/jobs/abandonment` route needs these
backend env vars (Preview → staging, Production → prod), none `VITE_`-prefixed:
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — service-role client for the admin delete + the two Step 6 RPCs. The service-role key is a full-access secret; never ship it to the browser.
- `ABANDONMENT_EMAIL_HASH_PEPPER` — the HMAC pepper (decisions.md 2026-06-10). Must match the value the staging gate uses (`.env.rls-test`), and **never enters Postgres**.
- `ABANDONMENT_EMAIL_HASH_KEY_VERSION` (default 1), `ABANDONMENT_MAX_AGE_DAYS` (default 30) — optional tuning.
- `CRON_SECRET` — Vercel attaches `Authorization: Bearer $CRON_SECRET` to cron calls; the route fails closed if it's unset or mismatched (the endpoint deletes accounts, so it must not be publicly triggerable).

### Vercel env var scoping (added 2026-05-18 with staging)
- Production environment env vars point at prod Supabase.
- Preview environment env vars point at staging Supabase (`translationapp1-staging`).
- `OPENAI_API_KEY` is the same value across Production and Preview environments — same OpenAI account; split later if billing visibility becomes valuable.
- Development environment env vars are empty by design — local dev uses your own `.env` files.

---

## 12. Deployment

### Local development
1. From `/V1`, run `npm install` if needed.
2. Backend: from `/V1/server`, run `node index.js`. Listens on `http://localhost:3001`.
3. Frontend: from `/V1`, run `npm run dev`. Vite serves on `http://localhost:5173` (or similar).
4. Frontend auto-points at the local backend when `import.meta.env.DEV` is true; at `/api` in production.

### Production
1. Push to `main` on GitHub.
2. Vercel auto-deploys the Vite build of the frontend and the `/api` folder as serverless functions.

---

## 13. File map

```
/V1
├── api/
│   └── v1/
│       ├── translate.js      Vercel serverless: translate/detect (versioned routes)
│       ├── infer-profile.js  Vercel serverless: server-side profile inference
│       └── jobs/
│           ├── abandonment.js  Vercel cron entry (Step 6 sweep; CRON_SECRET-guarded)
│           └── deletion.js     Vercel cron entry (Step 7 deletion sweep; CRON_SECRET-guarded)
├── lib/                       Shared (server + serverless) translation/policy logic
│   ├── translatePrompt.js    System prompt + PROMPT_VERSION (semver, stamped on cache)
│   └── policies.js           Machine source of truth for global identity/safety defaults
├── server/
│   ├── index.js              Local dev backend (Express)
│   ├── lib/
│   │   ├── inferProfile.js   Inference→profile update logic (explicit-wins, confidence gate)
│   │   ├── events.js         user_profile_events writer
│   │   ├── auth.js           Request auth (Phase 2.1): verify user JWT via getClaims() (anon key) -> {userId}; B2B API-key seam
│   │   ├── abandonment.js    Step 6 abandonment sweep (delete aged-pending, release username, HMAC)
│   │   └── deletion.js       Step 7 deletion sweep (claim→hash→admin-delete→complete; SET-NULL retain)
│   └── .env                  Local OPENAI_API_KEY (not committed)
├── migrations/               Run in Supabase SQL editor, manually for now (000–020; 000–020 live on prod as of 2026-07-07)
│   ├── 000_base_schema.sql … 006_user_profile_events_task_id.sql
│   ├── 007_phase2_identity_foundation.sql   profiles/identifiers/settings, auth_tenant_id(), trigger
│   ├── 008_phase2_step2_identity_cutover.sql  text→uuid cutover, RLS, complete_onboarding()
│   ├── 009_restore_nonbinary_gender_signal.sql  restores nonbinary CHECK dropped by 008
│   ├── 010_phase2_step4_discovery.sql       Step 4 discovery + change_username RPCs, username-prefix index
│   ├── 011_phase2_step5_social_graph.sql    Step 5 relationships/blocks/reports/invites/email_hash_abuse + 9 RPCs; amends 010 discovery RPCs to filter blocks
│   ├── 012_phase2_step6_abandonment.sql     Step 6 list_abandoned_pending_accounts() + record_abandoned_email_hash() (service_role-only)
│   ├── 013_phase2_step7_data_deletion.sql   Step 7 data_deletion_requests table + RLS + 6 RPCs (request/cancel user-facing; list_due/claim/complete service_role)
│   ├── 014_forward_schema_prep.sql          Pre-cutover: messages.conversation_id (Phase 3 forward-prep) + drop 7 vestigial cols + timestamp→timestamptz + FK indexes
│   ├── 015_profile_writer_role.sql          Least-privilege profile_writer role for inferProfile.js — scoped GRANTs + TO-role RLS (not BYPASSRLS); NOLOGIN (operator sets secret out of band)
│   ├── 016_fix_message_translations_cascade.sql  Reconcile message_translations.message_id FK → ON DELETE CASCADE on both envs (staging had drifted to NO ACTION vs prod); also corrects migration 000
│   ├── 017_phase3_conversations.sql          Phase 3 Step 1: conversations + conversation_members tables + RLS + dedupe; promotes messages.conversation_id to a real FK; adds conversation_contexts RLS+FK; create_conversation/leave_conversation/set_conversation_context_type/is_active_member RPCs; amends create_invite/redeem_invite for conversation-kind; adds tenants.conversation_policy
│   ├── 018_phase3_messages_rls.sql           Phase 3 Step 2 / Spec 7: flips messages + message_translations RLS tenant-scoped → membership-scoped (is_active_member). Drops+recreates the same 5 policy names from 008; policies-only, no DDL/data change; messages stay immutable; replay to prod AFTER 017
│   ├── 019_unify_context_type_vocab.sql       Unify conversations.context_type CHECK + create_conversation/set_conversation_context_type inline guards on the engine vocab (casual/dating/professional/academic). ALTER + CREATE OR REPLACE; defensive remap; does NOT touch detected_register
│   ├── 020_onboarding_username.sql       Onboarding requires a user-chosen username; complete_onboarding() (3-arg) claims it atomically with activation; change_username() allows self-revert; display_name denylist
│   ├── 021_settings_screen.sql       Phase 2.4 settings: set_preferred_language() + set_display_name() RPCs; account_settings.discoverable_by_email default true→false + handle_new_user trigger + backfill
│   └── 022_realtime_conversation_members.sql  Phase 2.4: publishes conversation_members to supabase_realtime (idempotent, mirrors 004) so the list updates live when you're added to a conversation
├── scripts/
│   ├── rls-adversarial-test.mjs   Phase 2 Step 3 RLS gate (run on staging)
│   ├── discovery-gate-test.mjs    Phase 2 Step 4 discovery gate (run on staging)
│   ├── social-graph-gate-test.mjs Phase 2 Step 5 social-graph + safety gate (run on staging)
│   ├── abandonment-gate-test.mjs  Phase 2 Step 6 abandonment + abuse-monitoring gate (run on staging)
│   ├── deletion-gate-test.mjs     Phase 2 Step 7 data-deletion gate (run on staging)
│   ├── conversations-gate-test.mjs Phase 3 Step 1 conversations schema + RPC gate (run on staging)
│   └── messages-rls-gate-test.mjs  Phase 3 Step 2 membership-scoped messages RLS gate — adversarial matrix + explicit realtime check (run on staging)
├── src/
│   ├── App.jsx               Orchestrator: auth state machine, conversation list (preview shows the translated last inbound message — cached translation at load + MessageBubble onTranslated callback live), active thread, two realtime subscriptions (messages + conversation_members), optimistic send + reconcile, modals
│   ├── main.jsx              React entry point
│   ├── index.css             Tailwind directives
│   ├── components/           Presentational pieces (Phase 3 conversation UI; markup ported from mockups/phase3-conversations.html)
│   │   ├── ConversationList.jsx     Sidebar list of conversations (+ avatar/initials/time helpers, exported)
│   │   ├── ConversationView.jsx     Thread: header + overflow menu (register selector + "?" explainer) + messages + composer
│   │   ├── MessageBubble.jsx        Per-message translate/cache/infer + caret-toggled source-text preview (no "Original" label; caret shown only when the line is truncated, right=collapsed/down=expanded, ResizeObserver-measured) + onTranslated callback (feeds the list preview) + optimistic pending/failed states
│   │   ├── NewConversationModal.jsx People-picker (discovery RPCs) → create_conversation (direct dedupe / group)
│   │   ├── InviteModal.jsx          Mints a conversation invite (create_invite) → copyable ?join=<token> link
│   │   └── SettingsModal.jsx        Account settings (app-bar gear): username change (gated) / display name / language / discoverability + relocated sign-out
│   └── lib/
│       ├── supabase.js       Supabase client initialization
│       ├── config.js         Non-secret constants (CHAT_APP_TENANT_ID etc.)
│       ├── vocabularies.js   Client source of truth for enumerated option sets (context_type/register, languages); aligned with translatePrompt.js + the 019 CHECK
│       ├── translation.js    Translation-engine client config (API URLs, PROFILE_INFERENCE_ENABLED) + language-code normalizer + detectSourceLanguage(); keeps chat UI decoupled from the engine HTTP contract
│       ├── discovery.js      Data-access layer for the people-picker: find_account_by_email / search_accounts_by_username RPC wrappers
│       ├── conversations.js  Data-access layer for Phase 3 conversations: RPC wrappers (create/leave/setContextType/invite/redeem) + list/read/insert queries
│       └── settings.js       Data-access layer for the settings screen: account_settings read/UPDATE + set_preferred_language/set_display_name/change_username RPC wrappers + username-change eligibility helper
├── docs/
│   ├── architecture.md       This file
│   ├── schema.sql            Generated current-state schema snapshot (the *what*; §7 owns the *why*)
│   ├── strategy.md           Product vision, two-phase plan, market
│   ├── operations.md         Cost model, hiring, workflow
│   ├── roadmap.md            Phased roadmap with checklists
│   ├── parking-lot.md        Uncommitted ideas
│   ├── decisions.md          Dated decisions log
│   ├── policies.md           Trust & safety / identity governance (living, audited)
│   ├── specs.md              Hermes spec archive
│   ├── verification.md       Verification and debugging checklists
│   ├── hermes.md             Hermes Agent charter (VPS execution agent)
│   ├── cowork-handoff.md     Weekly Hermes→Cowork briefing (⏸ paused)
│   └── archive/              Frozen pre-cleanup snapshots + retired docs (see archive/README.md)
├── .cursorrules              Cursor rules and pointer to /docs
├── .env                      Frontend env vars
├── .env.rls-test.example     Template for the Step 3 RLS gate config (committed; real one gitignored)
├── .gitignore                
├── index.html                HTML shell
├── package.json              
├── README.md                 
├── tailwind.config.js        
├── vercel.json               Vercel cron schedule (Step 6 abandonment sweep, daily)
└── vite.config.js            
```

---

## 14. Brand & visual identity

- **Logo.** A rounded-square "wave-seam" speech-bubble icon split into two colors along a sinusoidal boundary — meant to represent two languages converging on one shared meaning — paired with an "Outfit" wordmark. Source files (`jistchat-logo-violet-teal.svg` icon-only, `jistchat-lockup-icon-wordmark.svg` icon+wordmark) live in the `Translation App` working folder, **not this repo** — not yet resolved whether they should move into `/V1` (see decisions.md 2026-07-02). The app's in-header SVG (App.jsx top app bar) is a hand-inlined copy of the same paths, not an import of those source files — keep both in sync manually if the mark changes.
- **Colors.** Primary violet `#7C3AED`, secondary teal `#0D9488` (tints `#EDE9FE` / `#CCFBF1`). These happen to equal Tailwind's built-in `violet-600`/`violet-100` and `teal-600`/`teal-100` exactly, so the product frontend needed **no `tailwind.config.js` changes** — every former `indigo-*` utility class across `src/App.jsx` and `src/components/*.jsx` was swapped to the equivalent `violet-*` shade (2026-07-02). The landing page (`jistchat-landing.html`, separate repo) uses its own `--accent`/`--accent-soft`/`--accent-2`/`--accent-2-soft` CSS variables set to the same hex values.
- **Wordmark typeface.** Outfit (Google Fonts), weight 700, solid black fill, ~-0.01em tracking. Loaded via `<link>` in both `index.html` (product app) and the landing page.
- **In-app lockup.** Top app bar (`src/App.jsx`) shows the icon always; the "Jistchat" wordmark is hidden below the `sm` Tailwind breakpoint (space-constrained mobile bar) and shown at `sm:` and up.
- **Status.** Visual identity finalized 2026-07-02; rolled out to `jistchat-landing.html` same day and to the product frontend (colors + in-app logo) 2026-07-02.

---

## 15. Glossary

Plain-English definitions for jargon used here. Keeps the door open for non-technical contributors.

- **Anon key** (Supabase). A public API key the browser uses to talk to Supabase. Safe to expose *only when* row-level security is on; without RLS it functions as a read-everything key.
- **API.** Application Programming Interface — a defined way for one piece of software to ask another for something. Our translation API is what other apps would call to get translations from us.
- **Append-only.** A table or log where rows can only be added, never updated or deleted. Used for correction and event-source tables to preserve history.
- **Backend.** Code that runs on a server, not in the user's browser. Holds secrets, talks to other services.
- **Cache.** Storing the result of a slow or expensive operation so the next request for the same thing is free.
- **Context object.** A small structured JSON payload describing the user and conversation, attached to every translate call.
- **CORS.** Cross-Origin Resource Sharing — browser security policy controlling which web origins are allowed to call which APIs.
- **Discovery handle.** A human-facing identifier used to *find or add* a user — email, username, phone, friend-code. Distinct from the stable identity (the uuid); never used as a key. A user can have several.
- **Event sourcing.** A pattern where every state change is recorded as an event in an append-only table. Lets you reconstruct state at any historical point.
- **Fine-tuning.** Additional training on top of a base AI model using your own labeled data. Doesn't create a new model; makes an existing one better at your specific task.
- **Foreign key (FK).** A column in one table that points at a row in another table. Connects tables together.
- **Frontend.** Code that runs in the user's browser. What the user actually sees.
- **GDPR.** EU privacy regulation. Right to Erasure means users can demand deletion of their data.
- **Handle minimization.** A privacy rule: when one user adds another, they see only the discovery handle they used to find them — never the target's other handles.
- **Homoglyph.** A character that looks like another (e.g. Cyrillic "а" vs Latin "a"). Used for impersonation; blocked by restricting usernames to ASCII.
- **IDE.** Integrated Development Environment — fancy text editor for code (Cursor and VS Code are IDEs).
- **Idempotency key.** A unique identifier sent with an API call so that retries don't accidentally do the same operation twice.
- **Inference (in this context).** What the model can tell about a user or conversation from the text alone — their dialect, register, gender signal, etc.
- **Inferred vs explicit.** Inferred = the system guessed it. Explicit = the user set it. Explicit always wins.
- **NMT.** Neural Machine Translation — the previous generation of translation systems before LLMs (DeepL, Google Translate). Generally faster and cheaper than LLMs but less context-aware.
- **OpenAI.** The company whose API we use for translation. `gpt-5.4` (medium reasoning effort) for translate calls, `gpt-4o-mini` for detect calls, as of 2026-07-05.
- **Optimistic UI.** Showing a result immediately, before the server confirms — a UX trick to make things feel fast.
- **Postgres.** The relational database under Supabase.
- **Provenance (in the contact graph).** A record of *how* a connection was made (`via_identifier_type`: email / username / phone / friend_code / invite_link), captured at add-time and read by the DM-initiation policy.
- **Realtime.** Supabase's feature that pushes database changes to connected clients without polling.
- **Register.** The level of formality and tone of communication. Critical in Japanese, Korean, Arabic; meaningful in most languages.
- **Repo / repository.** A folder of code tracked by Git, usually mirrored on GitHub.
- **RLS — row-level security.** Database-side rules saying which rows a given user can see or change. Without it, the anon key reads everything.
- **Serverless function.** A small backend function that runs on demand in the cloud (Vercel hosts ours). No server to manage, scales automatically.
- **Snapshot (in corrections).** Capturing the state of context at the moment of an event, not a reference to current state. Necessary because state drifts.
- **Supabase.** A backend-as-a-service built on Postgres. Provides database, realtime, auth.
- **System-generated username.** A random username assigned at signup (flagged `system_generated`). Keeps usernames non-load-bearing — a user can set their own later, and we can de-emphasize usernames with no data risk.
- **System prompt.** Instructions given to the AI model before the user's message, setting its behavior.
- **Tenant.** A customer of a multi-tenant API. Phase 1 has one tenant (the chat app). Phase 2 has many.
- **Token (AI).** The unit of text OpenAI bills on. Roughly ¾ of a word. Translation messages are small; context objects are tiny by design.
- **UUID.** Universally Unique Identifier — a long random string used as an identifier without revealing anything about its referent.
- **Vercel.** The hosting service running our frontend and serverless backend.
- **Vite.** The build tool that compiles the React frontend and runs the local dev server.

---

## 16. Maintenance rules for this doc

- Update this file in the same commit as any architectural change. Doc drift is the failure mode we're explicitly designing against.
- If a section is wrong, fix it. Don't append a "this is actually different now" caveat.
- Keep it concise; over 800 lines means we're documenting things the code should make obvious.
- New non-trivial decisions go in `decisions.md` with a date and reasoning, not into this doc.
- New ideas that aren't being built yet go in `parking-lot.md`, not into this doc.


---

## Changelog

*Reverse chronological. One line per change; project events link to `decisions.md`.*

- **2026-07-07** — §10: flagged the known RLS gap on `tenants`/`translation_events`/`agent_events` (parked High; see decisions.md "Roadmap promotions + RLS gap").
- **2026-07-07** — Docs legibility cleanup: added Contents TOC; header de-blobbed; §7 wired to + slimmed against the new generated `docs/schema.sql` (per-table column grids removed; ~1,124 → ~970 lines); §13 file map updated (migration 020, `schema.sql`, `archive/`; phase2-implementation retired). (→ decisions.md 2026-07-07 "Docs legibility cleanup + new conventions")
- **2026-06-23** — Phase 2.1 token auth (§10/§11/§13) + Phase 2.2 production domain/email/sessions (§11). (→ decisions.md 2026-06-23)
- **2026-06-18** — Phase 3 production cutover reconciled: §2/§7/§10 (016→019 on prod; membership-scoped RLS live). (→ decisions.md 2026-06-18)
- **2026-06-11** — Phase 2 production cutover; forward-schema prep (014) + profile_writer role (015); §7/§10/§13 reconciled. (→ decisions.md 2026-06-11)
- **2026-06-10** — §2/§7/§10/§13 reconciled to Phase 2 Steps 2–7 (identity cutover, discovery, social graph, abandonment, deletion). (→ decisions.md 2026-06-10)
- **2026-05-18** — §7 vestigial-column reconciliation; staging added.
