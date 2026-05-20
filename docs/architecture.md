# Translation App — System Architecture

> Living technical document. Describes what the system is, the principles it's built on, and what we're migrating toward. Updated in the same commit as any architectural change.

**Last updated:** 2026-05-18 (§7 schema updated to reflect actual prod state — vestigial columns documented, tenant_id NOT NULL, surrogate id keys captured; closes a known doc/DB drift gap surfaced during staging setup)
**Repo:** https://github.com/iwitt1/translationapp1
**Owner:** Isaac (iwitt1)

> **Read first:** `/docs/strategy.md` for product context, `/docs/roadmap.md` for what we're building when, `/docs/decisions.md` for why specific calls were made.

---

## 1. What this is

A real-time multilingual chat application backed by an LLM-powered translation API. Every user sees every message in their preferred language. The chat app is the first-party client of its own translation API; the same API is the long-term commercial product (see strategy doc).

**Where it lives:**
- Code: GitHub (`iwitt1/translationapp1`)
- Backend (prod): Vercel serverless functions
- Backend (local dev): Node + Express on localhost:3001
- Database: Supabase (Postgres + Realtime)
- AI: OpenAI (`gpt-4o-mini` currently)

---

## 2. Current state — what works today

- A single shared chat room; anyone with the URL joins by typing a username.
- Messages stored in `messages` table; broadcast to all connected clients via Supabase Realtime.
- Backend detects source language of each outgoing message before storing.
- On view, frontend compares source language to viewer's preferred language; if different, checks cache (`message_translations`) or calls backend for translation.
- Cached translations reused for every subsequent viewer at no additional OpenAI cost.

## What does NOT work today (in priority order to fix)

1. **Contextual translation is not implemented.** The translate prompt sees only the current message; no prior history is ever included. This is the biggest gap relative to the project's stated value proposition.
2. **No structured inference return.** The translate prompt returns plain translated text and discards all the implicit dialect/register/gender inference the model performs. Highest-leverage fix; included in Phase 1.
3. **No row-level security (RLS).** Frontend uses Supabase anon key; without RLS, anyone with the public URL can read every message, profile, and translation in the database.
4. **No real authentication.** `user_id` is literally the typed username string. Same username on two browsers = same identity.
5. **No conversation / room model.** Every message lives in one global `messages` table.
6. ~~**No `tenant_id` on tables.** Will be retrofitted in Phase 0 — easy now, painful later.~~ Migration written 2026-05-12 (`migrations/001_tenants_and_tenant_id.sql`). Awaiting execution in Supabase.
7. ~~**No versioned API routes.** Current endpoint is `/api/translate`; needs to become `/api/v1/translate` in Phase 0.~~ Done 2026-05-12.
8. **No context-type parameter** (dating, professional, etc.) wired through.
9. ~~**Prompt drift between prod and local.** Local `server/index.js` has an extra prompt line that production `api/translate.js` lacks. Reconciled in Phase 0.~~ Done 2026-05-12.
10. **Wasteful detect-on-every-send.** Every message triggers an OpenAI detect call even when the sender's language is known.
11. **No error UX.** Translation failures silently fall back to the original text.
12. **No way for users to set preferred language in the UI.** Hardcoded to `en` at user creation.
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

### Tables that exist today (MVP)

#### `messages`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key, default `gen_random_uuid()` |
| `created_at` | timestamp with time zone | Default `now()` |
| `sender_id` | text | Currently the typed username string |
| `original_text` | text | The message as typed |
| `source_language` | text | BCP 47 language code, detected by AI at send |
| `tenant_id` | uuid | NOT NULL, FK to `tenants(id)`. Added by migration `001`. |
| `room_id` | uuid | **Vestigial** — predates the single-global-room model; unused by current code |
| `translated_text` | text | **Vestigial** — predates the `message_translations` cache; unused |
| `target_language` | text | **Vestigial** — same era as above |
| `tone` | text | **Vestigial** — predecessor to the `context_type` parameter |
| `context_id` | text | **Vestigial** — same era |
| `model_version` | text | **Vestigial** — old per-message model tag, default `'V1'` |
| `latency_ms` | numeric | **Vestigial** — old telemetry hook, currently not written |

The vestigial columns are present in both prod and staging (and captured in `migrations/000_base_schema.sql`) so the two environments match exactly. Cleanup is parked: `/docs/parking-lot.md` → "Vestigial columns on `messages` + architecture.md §7 doc drift."

#### `message_translations`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key, default `gen_random_uuid()` |
| `message_id` | uuid | FK to `messages(id)`. Nullable in schema; the cache contract assumes a real link. |
| `language` | text | NOT NULL. Target language code (BCP 47). |
| `translated_text` | text | NOT NULL. The cached translation. |
| `created_at` | timestamp without time zone | Default `now()` |
| `tenant_id` | uuid | NOT NULL, FK to `tenants(id)`. Added by migration `001`. |
| `prompt_version` | text | Semver of the prompt that produced this translation. Nullable; null = pre-versioning (pre-migration `003`). |

Unique: `(message_id, language)` — one cached translation per message per target.

#### `user_profiles`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key, default `gen_random_uuid()` — surrogate key, separate from `user_id` |
| `user_id` | text | UNIQUE. The username string (will migrate to `uuid` in Phase 2). |
| `display_name` | text | |
| `default_language` | text | Default `'en'` |
| `created_at` | timestamp without time zone | Default `now()` |
| `tenant_id` | uuid | NOT NULL, FK to `tenants(id)`. Added by migration `001`. |

### Tables to add in Phase 0 (cheap structural prep)

#### `tenants`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `name` | text | |
| `default_correction_ownership` | enum | `'platform' \| 'tenant' \| 'shared'`, default `'platform'` |
| `training_data_agreement` | boolean | default false |
| `created_at` | timestamp | |

Seeded with one row representing the chat app itself. Every other table gets a `tenant_id` FK pointing at this row. When Phase 2 opens the API to external customers, new tenants get new rows and RLS scopes them.

### Tables to add in Phase 1 (with the contextual-translation feature)

#### `user_linguistic_profiles`
| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid | FK to users |
| `tenant_id` | uuid | FK to tenants |
| `preferred_language` | text | e.g. `"es"` |
| `dialect_region` | text | e.g. `"es-AR"` (Rioplatense) |
| `dialect_confidence` | float | 0.0–1.0 |
| `dialect_source` | enum | `'explicit' \| 'inferred'` |
| `formality_preference` | enum | `'formal' \| 'neutral' \| 'casual'` |
| `formality_source` | enum | `'explicit' \| 'inferred'` |
| `gender_signal` | enum | `'masculine' \| 'feminine' \| 'neutral' \| 'nonbinary' \| 'unknown'` — `neutral` = language has no grammatical gender (Finnish, Turkish, etc.); `nonbinary` = speaker actively uses gender-inclusive forms |
| `gender_source` | enum | `'explicit' \| 'inferred'` |
| `script_preference` | text | e.g. `"latin"`, `"traditional"`, `"simplified"` |
| `script_source` | enum | `'explicit' \| 'inferred'` |
| `known_languages` | text[] | e.g. `["es", "en"]` for bilingual users |
| `updated_at` | timestamp | |

#### `conversation_contexts`
| Column | Type | Notes |
|---|---|---|
| `conversation_id` | uuid | Primary key |
| `tenant_id` | uuid | FK to tenants |
| `participant_ids` | uuid[] | |
| `detected_register` | enum | `'professional' \| 'casual' \| 'romantic' \| 'family' \| 'support'` |
| `register_confidence` | float | 0.0–1.0 |
| `relationship_closeness` | enum | `'new' \| 'acquainted' \| 'close'` |
| `closeness_signals` | jsonb | `{message_count, days_active, avg_response_time}` |
| `dominant_topics` | text[] | e.g. `["medical", "legal"]` for domain routing |
| `updated_at` | timestamp | |

Updated by a background job every N messages or when a significant shift is detected. NOT updated on every message.

### Tables to add in Phase 1–2 (build the schema even before features fill them)

#### `translation_corrections` (append-only)
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
| `correction_source` | enum | `'user_edit' \| 'thumbs_down' \| 'bilingual_review' \| 'ai_audit'` |
| `corrector_user_id` | uuid | nullable |
| `corrector_known_languages` | text[] | **Snapshot** of corrector's profile |
| `register_context` | jsonb | **Snapshot** of conversation register |
| `ownership` | enum | `'platform' \| 'tenant' \| 'shared'` |
| `created_at` | timestamp | |

Snapshots are critical. Context drifts; you need to know what was true at the moment of correction, not what is true now. The `corrector_known_languages` snapshot tells you whether the correction came from a native speaker of both languages. The `register_context` snapshot tells you what conversation state the model was operating under when it failed.

#### `translation_reviews`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `tenant_id` | uuid | FK to tenants |
| `translation_id` | uuid | References the specific translation event |
| `reviewer_type` | enum | `'ai_audit' \| 'human' \| 'bilingual_user'` |
| `reviewer_id` | uuid | nullable if ai_audit |
| `reviewed_at` | timestamp | |
| `quality_score` | float | 0.0–1.0 |
| `flags` | text[] | e.g. `["register_mismatch", "idiom_error", "gender_error", "dialect_wrong"]` |
| `suggested_fix` | text | nullable |
| `confidence` | float | Reviewer's confidence in their assessment |
| `model_version` | text | nullable; if `ai_audit`, which model/prompt version reviewed |

Both human reviewers and AI auditors write into the same table — no schema changes when humans get involved.

#### `data_deletion_requests`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `user_id` | uuid | FK to users |
| `tenant_id` | uuid | FK to tenants |
| `requested_at` | timestamp | |
| `completed_at` | timestamp | nullable |
| `status` | enum | `'pending' \| 'processing' \| 'completed'` |
| `deleted_fields` | jsonb | Log of what was removed |

The deletion job **anonymizes** corrections (strips user_id and PII, keeps translation pairs) rather than hard-deleting. Anonymized translation pairs remain legally usable for training. Hard-deletion destroys training data that is irreplaceable.

#### `user_profile_events` (append-only event source)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `user_id` | uuid | FK to users |
| `tenant_id` | uuid | FK to tenants |
| `event_type` | text | e.g. `"dialect_inferred"`, `"formality_set_explicit"` |
| `previous_value` | jsonb | |
| `new_value` | jsonb | |
| `source` | enum | `'explicit' \| 'inference' \| 'correction_analysis'` |
| `created_at` | timestamp | |

Lets you reconstruct what the system believed about a user at any point in time. Critical for debugging bad translations and for quality control on training data.

---

## 8. How a translation moves through the system

### Send path (target state)

1. User types and hits Send.
2. Frontend calls `POST /api/v1/translate` with mode `detect`, including the user's authentication token and `tenant_id`.
3. Backend authenticates, calls OpenAI to detect language, returns `{ detected_language }`.
4. Frontend inserts a row into `messages` with original text, detected language, conversation_id, tenant_id.
5. Supabase Realtime pushes the row to subscribed clients in the same conversation (scoped by RLS).

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

- **MVP:** `gpt-4o-mini` for everything. Cost-effective, sufficient for early translation quality.
- **Small scale:** Consider routing — `gpt-4o-mini` for simple messages, `gpt-4o` for idiomatically dense or context-heavy ones. 15x cost delta makes routing logic worth building.
- **Funded:** Evaluate DeepSeek ($0.14/M tokens vs. ~$3/M for Claude Sonnet) for cost; consider fine-tuning on corrections data once thousands of high-quality pairs exist.
- **Always:** Keep backend model-agnostic. The model name lives in one configuration point, never hardcoded in business logic.

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
- **No RLS yet.** Anon key + no RLS = anyone with the URL can read every message in the database. Fixed in Phase 2.

### Target (post-Phase 2)
- Supabase Auth providing real user identity (UUID under the hood, username as display name).
- RLS enabled on every table. Messages visible only to participants. Profiles writable only by owner. Conversations scoped by membership.
- Tenant-scoped access on top of user-scoped access. A user in tenant A can never read data from tenant B.
- Token-based auth on every translate API call, even from the first-party frontend.

### Privacy positioning (see strategy.md for marketable framing)

True E2EE and AI translation are architecturally in conflict. The defensible position is "encrypted in transit and at rest; plaintext exists transiently during translation; never logged, never stored, never used for training without explicit consent." Honest, marketable, and what we can actually deliver. The at-risk-user market (LGBTQ+ in criminalizing countries) is a different product with different requirements; recorded in the parking lot.

### Data retention & deletion

`data_deletion_requests` table tracks GDPR Right to Erasure requests. The deletion job:
- Anonymizes user-attributable rows (strips user_id and PII).
- Preserves translation pairs in corrections (no longer linked to a person; legally usable for training).
- Never hard-deletes corrections — that destroys irreplaceable training data.

---

## 11. Environments and config

### Frontend env vars (root `.env`, exposed to browser, prefix `VITE_`)
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Safe to ship to the browser *once RLS is enabled*. Until then, treat the live URL as effectively a public read of the entire database.

### Backend env vars
- Local dev: `server/.env` containing `OPENAI_API_KEY`.
- Production: set in Vercel's environment variables panel as `OPENAI_API_KEY`.

The OpenAI API key never leaves the backend. Frontend never calls OpenAI directly.

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
│       └── translate.js      Vercel serverless backend (versioned routes)
├── server/
│   ├── index.js              Local dev backend (Express)
│   └── .env                  Local OPENAI_API_KEY (not committed)
├── migrations/
│   └── 001_tenants_and_tenant_id.sql   Run in Supabase SQL editor, manually for now
├── src/
│   ├── App.jsx               Frontend UI (login, chat, message bubble) — single file currently
│   ├── main.jsx              React entry point
│   ├── index.css             Tailwind directives
│   └── lib/
│       ├── supabase.js       Supabase client initialization
│       └── config.js         Non-secret constants (CHAT_APP_TENANT_ID etc.)
├── docs/
│   ├── architecture.md       This file
│   ├── strategy.md           Product vision, two-phase plan, market
│   ├── operations.md         Cost model, hiring, workflow
│   ├── roadmap.md            Phased roadmap with checklists
│   ├── parking-lot.md        Uncommitted ideas
│   ├── decisions.md          Dated decisions log
│   └── verification.md       Verification and debugging checklists
├── .cursorrules              Cursor rules and pointer to /docs
├── .env                      Frontend env vars
├── .gitignore                
├── index.html                HTML shell
├── package.json              
├── README.md                 
├── tailwind.config.js        
└── vite.config.js            
```

---

## 14. Glossary

Plain-English definitions for jargon used here. Keeps the door open for non-technical contributors.

- **Anon key** (Supabase). A public API key the browser uses to talk to Supabase. Safe to expose *only when* row-level security is on; without RLS it functions as a read-everything key.
- **API.** Application Programming Interface — a defined way for one piece of software to ask another for something. Our translation API is what other apps would call to get translations from us.
- **Append-only.** A table or log where rows can only be added, never updated or deleted. Used for correction and event-source tables to preserve history.
- **Backend.** Code that runs on a server, not in the user's browser. Holds secrets, talks to other services.
- **Cache.** Storing the result of a slow or expensive operation so the next request for the same thing is free.
- **Context object.** A small structured JSON payload describing the user and conversation, attached to every translate call.
- **CORS.** Cross-Origin Resource Sharing — browser security policy controlling which web origins are allowed to call which APIs.
- **Event sourcing.** A pattern where every state change is recorded as an event in an append-only table. Lets you reconstruct state at any historical point.
- **Fine-tuning.** Additional training on top of a base AI model using your own labeled data. Doesn't create a new model; makes an existing one better at your specific task.
- **Foreign key (FK).** A column in one table that points at a row in another table. Connects tables together.
- **Frontend.** Code that runs in the user's browser. What the user actually sees.
- **GDPR.** EU privacy regulation. Right to Erasure means users can demand deletion of their data.
- **IDE.** Integrated Development Environment — fancy text editor for code (Cursor and VS Code are IDEs).
- **Idempotency key.** A unique identifier sent with an API call so that retries don't accidentally do the same operation twice.
- **Inference (in this context).** What the model can tell about a user or conversation from the text alone — their dialect, register, gender signal, etc.
- **Inferred vs explicit.** Inferred = the system guessed it. Explicit = the user set it. Explicit always wins.
- **NMT.** Neural Machine Translation — the previous generation of translation systems before LLMs (DeepL, Google Translate). Generally faster and cheaper than LLMs but less context-aware.
- **OpenAI.** The company whose API we use for translation. `gpt-4o-mini` is the specific model currently.
- **Optimistic UI.** Showing a result immediately, before the server confirms — a UX trick to make things feel fast.
- **Postgres.** The relational database under Supabase.
- **Realtime.** Supabase's feature that pushes database changes to connected clients without polling.
- **Register.** The level of formality and tone of communication. Critical in Japanese, Korean, Arabic; meaningful in most languages.
- **Repo / repository.** A folder of code tracked by Git, usually mirrored on GitHub.
- **RLS — row-level security.** Database-side rules saying which rows a given user can see or change. Without it, the anon key reads everything.
- **Serverless function.** A small backend function that runs on demand in the cloud (Vercel hosts ours). No server to manage, scales automatically.
- **Snapshot (in corrections).** Capturing the state of context at the moment of an event, not a reference to current state. Necessary because state drifts.
- **Supabase.** A backend-as-a-service built on Postgres. Provides database, realtime, auth.
- **System prompt.** Instructions given to the AI model before the user's message, setting its behavior.
- **Tenant.** A customer of a multi-tenant API. Phase 1 has one tenant (the chat app). Phase 2 has many.
- **Token (AI).** The unit of text OpenAI bills on. Roughly ¾ of a word. Translation messages are small; context objects are tiny by design.
- **UUID.** Universally Unique Identifier — a long random string used as an identifier without revealing anything about its referent.
- **Vercel.** The hosting service running our frontend and serverless backend.
- **Vite.** The build tool that compiles the React frontend and runs the local dev server.

---

## 15. Maintenance rules for this doc

- Update this file in the same commit as any architectural change. Doc drift is the failure mode we're explicitly designing against.
- If a section is wrong, fix it. Don't append a "this is actually different now" caveat.
- Keep it concise; over 800 lines means we're documenting things the code should make obvious.
- New non-trivial decisions go in `decisions.md` with a date and reasoning, not into this doc.
- New ideas that aren't being built yet go in `parking-lot.md`, not into this doc.
