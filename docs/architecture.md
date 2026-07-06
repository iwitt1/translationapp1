# Translation App — System Architecture

> Living technical document. Describes what the system is, the principles it's built on, and what we're migrating toward. Updated in the same commit as any architectural change.

**Last updated:** 2026-06-23 (Phase 2.1 token auth on backend API calls — §10/§11/§13; anon-key `getClaims()` verification. Phase 2.2 public-demo readiness — added §11 "Production domain, email & sessions": app live at `app.jistchat.com` (Vercel custom domain on `jistchat.com`), magic-link email via Resend, persistent sessions via Supabase defaults; Auth Site URL moved to the new domain. Config + the token-auth code; no schema change. See decisions.md 2026-06-23. Prior 2026-06-18: **Phase 3 production cutover EXECUTED.** Migrations 016→019 replayed on prod `translationapp1` (high-water mark was 015): 016 no-op (already CASCADE), 017 conversations schema + `messages.conversation_id` promotion, sentinel purge a no-op (messages=0), 018 membership-scoped `messages`/`message_translations` RLS, 019 context_type vocab unify — each verified against its embedded block; then `phase3/step1-conversations` merged → `main` (`5251669..c13f8ae`) and Vercel auto-deployed the conversation-aware frontend, closing the broken-sends window. 2-user prod smoke GREEN; 3rd-user/group flows + custom SMTP deferred. Reconciled this pass: §2 item 5 (conversation model now on prod), §7 (017/018/019 rows → prod-applied), §10 (prod RLS now live, membership-scoped) — the last three had carried stale "prod has no RLS / pre-007" prose left over from before the 2026-06-11 Phase 2 cutover. See decisions.md/operations.md/verification.md 2026-06-18. Prior 2026-06-11: **Phase 2 production cutover EXECUTED.** The coordinated wipe-then-replay ran against prod `translationapp1`: prod (previously at migration 006, pre-auth/no-RLS) was wiped (8 data tables truncated, `tenants` sentinel kept; **no snapshot** — free tier, disposable data) and migrations **007→015 replayed clean**, each verified against its in-file block. `profile_writer` `LOGIN` enabled out of band; `DATABASE_URL_PROD_WRITER` + `DATABASE_URL_PROFILE_WRITER` set in Vercel Production on **port 6543**; manual redeploy to pick up env vars (`main` auto-deploys code but not env changes). Supabase prod **Site URL** had to be set to `https://translationapp1.vercel.app` (+ `/**` redirect) — magic links were falling back to `localhost`. Single-user smoke GREEN (signup → onboard → ULP row → message). **Two-user inference path PASSED live on prod 2026-06-11** (es-AR + casual written to the sender's row, two `user_profile_events` rows, trust boundary held under the `profile_writer` role; first attempt 500'd on a special-char password in `DATABASE_URL_PROFILE_WRITER` — fixed by an alphanumeric reset + redeploy; migration 015's connection-string comment corrected). Vercel crons confirmed registered on prod (abandonment 08:00, deletion 09:00). **Cutover FULLY GREEN — prod now matches the shipped Phase 2 app with no pending verification.** See decisions.md 2026-06-11 "Phase 2 production cutover executed" + verification.md "Phase 2 production cutover". Prior same-day: **Pre-cutover schema + role hardening.** Migration **014 `forward_schema_prep`** verified on staging (4/4 GREEN): adds `messages.conversation_id` (nullable, default global-conversation sentinel `…0002`, no FK — Phase 3 adds the FK + NOT NULL with zero backfill), drops the 7 vestigial `messages` columns (all superseded — see §7), converts four naive `timestamp` columns → `timestamptz` (interpreted AS UTC), and adds the missing FK indexes. Migration **015 `profile_writer_role`** (applied on staging + **prod 2026-06-11**) adds a least-privilege `profile_writer` Postgres role for `server/lib/inferProfile.js` — **scoped GRANTs + RLS policies `TO profile_writer`, not BYPASSRLS** (the DB authorizes the operation, app code authorizes the row via the message-derived trust boundary; deny-by-default everywhere else); role is `NOLOGIN` so the migration carries no secret — operator enables login + sets `DATABASE_URL_PROFILE_WRITER` out of band before the inference gate (#12). §7 (messages/conversation_id + vestigial drop + timestamptz notes), §10 (profile_writer role posture), §13 file map all reconciled; decisions.md 2026-06-11 ×2 ("Forward-schema prep before prod cutover", "profile_writer role: scoped RLS, not BYPASSRLS"). Prod replay sequence is now 007→015. Prior 2026-06-11: Phase 2 **Step 7 (data deletion / GDPR erasure) gate PASSED on staging — 37/37 GREEN** (first run 5/15 before migration 013 was applied — PostgREST "function not found in schema cache"). Migration 013 adds the net-new `data_deletion_requests` table + RLS + 6 RPCs (`request_account_deletion`/`cancel_account_deletion` user-facing; `list_due_deletion_requests`/`claim_deletion_request`/`complete_deletion_request` service_role); the Node sweep is `server/lib/deletion.js` + `api/v1/jobs/deletion.js` (daily 09:00 UTC cron) + a second `vercel.json` cron. **Two-phase** erasure: `request` soft-deletes (`status='deactivated'`) + enqueues with a 30-day `grace_until`; `cancel` reverses within grace; the sweep hard-deletes due requests via the admin API and the 007/008 FK chain anonymizes (profile/identifiers/settings/ULP/events cascade; `messages.sender_id`→NULL retains content). Audit row survives the cascade (`user_id` FK = SET NULL). Records the keyed email HMAC reusing `email_hash_abuse` (no schema change). Schema extends §7's sketch with `grace_until`/`requested_by`/`cancelled` (decisions.md 2026-06-11). §7 status + table, §10 retention, §13 file map, DB-functions list all reconciled. Prod replay of 013 pending the Phase 2 cutover. Earlier 2026-06-11: Phase 2 **Step 6** gate ✅ **PASSED on staging — 19/19 GREEN**; §7 status flipped. The sweep code (`server/lib/abandonment.js`) is unchanged in shape — a dry-run counter bug was fixed (the `summary.deleted`/`summary.hashed` increments moved inside the `if (!dryRun)` guards; no live-sweep behavior change). Prod replay of 012 pending the Phase 2 cutover (after Step 7). Prior 2026-06-10: §7/§8/§11/§13 reconciled to Phase 2 **Step 6** — migration 012 (abandonment support functions `list_abandoned_pending_accounts()` + `record_abandoned_email_hash()`, service_role-only) **written, pending gate on staging**; the sweep itself is Node — `server/lib/abandonment.js` run by a Vercel cron (`api/v1/jobs/abandonment.js` + `vercel.json`). Username release is automatic via the auth.users→profiles→identifiers FK cascade — no release RPC (decisions.md 2026-06-10 "Step 6 abandonment"). Prior 2026-06-10: §7/§10/§13 reconciled to Phase 2 **Step 5** — migration 011 (social graph + safety primitives) **gate PASSED on staging, 40/40 GREEN** (Step 4 discovery gate re-passed 22/22 after the block-filter amend): `relationships` adopts the **canonical-pair** model — `account_lo`/`account_hi`/`initiator_id` rather than the originally-sketched `requester_id`/`addressee_id` (decisions.md 2026-06-10 "Contact-graph representation"); adds `blocks`/`reports`/`invites`/`invite_redemptions`/`email_hash_abuse`, nine SECURITY DEFINER RPCs, and amends the two Step 4 discovery RPCs to filter active blocks. Prior 2026-06-10: §2, §7, §10, §13 reconciled to the Phase 2 build: migrations 007 (identity foundation) + 008 (identity cutover) are LIVE ON STAGING — `profiles`/`account_identifiers`/`account_settings` exist, `user_profiles` dropped, `messages.sender_id` + `user_linguistic_profiles`/`user_profile_events` cut over to uuid, RLS enabled on the Phase 2 tables, and `auth_tenant_id()`/`handle_new_user()`/`complete_onboarding()` added. Server-side profile inference shipped + verified on staging. **Prod is untouched** — it still runs the pre-auth no-RLS app; the cutover is a coordinated wipe-staging-then-prod event (see §10). Prior 2026-05-18: §7 vestigial-column reconciliation.)
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
- AI: OpenAI (`gpt-5.4` medium reasoning for translate; `gpt-4o-mini` for detect — since 2026-07-05)

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
12. ~~**No way for users to set preferred language in the UI.**~~ **Built on staging** — `complete_onboarding(display_name, preferred_language)` RPC sets it explicitly at onboarding (written `_source='explicit'` to `user_linguistic_profiles`). Still true in **prod**.
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

> **Migration status (2026-06-10).** The "Phase N — to add" framing below is partly historical: a
> chunk of it has now shipped to **staging** (not prod). Quick map:
>
> | Table / object | Migration | State |
> |---|---|---|
> | `tenants`, `tenant_id` columns | 001 | live (prod + staging) |
> | `messages`, `message_translations` | 000/001 | live; **`messages.sender_id` text→uuid (FK `auth.users`, ON DELETE SET NULL)** on **staging** via 008 |
> | `user_profiles` | 000 | **dropped on staging** by 008 (replaced by `profiles`) |
> | `user_linguistic_profiles` | 002 → recreated 008 → 009 | live on staging with **uuid** `user_id` (FK `profiles`); 009 restores `nonbinary` to the gender CHECK |
> | `user_profile_events` | 005/006 → recreated 008 | live on staging with **uuid** `user_id` |
> | `profiles`, `account_identifiers`, `account_settings` | 007 | live on **staging** |
> | `auth_tenant_id()`, `handle_new_user()` trigger | 007 | live on staging |
> | `complete_onboarding(display_name, preferred_language)` RPC | 008 | live on staging |
> | RLS on all Phase 2 tables + `messages`/`message_translations` | 007/008 | enabled on staging; verified by Step 3 gate |
> | `find_account_by_email()`, `search_accounts_by_username()`, `change_username()` discovery RPCs + username-prefix index | 010 | **gate PASSED on staging (22/22); re-passed after 011's block-filter amend** (Phase 2 Step 4; additive, no table changes). The two discovery RPCs are **amended by 011** to filter active blocks. |
> | `relationships` (canonical-pair), `blocks`, `reports`, `invites`, `invite_redemptions`, `email_hash_abuse` + 9 RPCs (`active_block_exists`, `request_contact`, `respond_to_contact`, `block_account`, `unblock_account`, `report_account`, `create_invite`, `redeem_invite`, `revoke_invite`) | 011 | **gate PASSED on staging (40/40)** (Phase 2 Step 5; additive tables + RLS + RPCs, no destructive change). `tenants.dm_initiation_policy` already exists (007). |
> | `list_abandoned_pending_accounts()`, `record_abandoned_email_hash()` support functions for the abandonment sweep | 012 | **gate PASSED on staging 2026-06-11 (19/19 GREEN)** (Phase 2 Step 6; additive functions only, `service_role`-only EXECUTE, no table changes — `email_hash_abuse` shipped in 011). The sweep itself is Node (Vercel cron): `server/lib/abandonment.js` + `api/v1/jobs/abandonment.js`. |
> | `data_deletion_requests` table + `request_account_deletion()`, `cancel_account_deletion()` (user RPCs), `list_due_deletion_requests()`, `claim_deletion_request()`, `complete_deletion_request()` (service_role) | 013 | **gate PASSED on staging 2026-06-11 (37/37 GREEN)** (Phase 2 Step 7; net-new table + RLS + 6 RPCs, additive, no table recreate). Two-phase erasure (deactivate → grace → hard-delete). The sweep is Node (Vercel cron): `server/lib/deletion.js` + `api/v1/jobs/deletion.js`. Reuses `email_hash_abuse` (no schema change). |
> | `conversations`, `conversation_members` + `is_active_member()` + write RPCs (`create_conversation`, `leave_conversation`, `set_conversation_context_type`) + `create_invite`/`redeem_invite` amended for `conversation`-kind + `tenants.conversation_policy` jsonb | 017 | **gate PASSED on staging 2026-06-12 (35/35 GREEN); applied on prod 2026-06-18** (Phase 3 Step 1 / Spec 6; additive tables + RLS + RPCs, promotes `messages.conversation_id` to FK + NOT NULL, adds `conversation_contexts` RLS + FK). Direct-dedupe is race-safe via `conversations.dedupe_key` + a partial unique index. |
> | `conversation_contexts` RLS + `conversation_id` FK | 017 | **added 2026-06-12** — closes the outstanding Phase-1 RLS gap; FK added `NOT VALID` (legacy rows unscanned). |
> | `messages` + `message_translations` RLS flipped **tenant-scoped → membership-scoped** | 018 | **gate PASSED on staging 2026-06-12 (27/27 GREEN; sentinel purged first); applied on prod 2026-06-18 (after 017)** (Phase 3 Step 2 / Spec 7; policies-only, no DDL/data change). Drops + recreates the same five policy names from 008 with an added `is_active_member()` predicate. Replayed to prod after 017, as required (prod sentinel purge was a no-op, messages=0). |
> | `conversations.context_type` CHECK + `create_conversation`/`set_conversation_context_type` inline guards → unified on the engine vocab `casual/dating/professional/academic` | 019 | **applied on staging 2026-06-12 + prod 2026-06-18** (was `casual/professional/romantic/family/support`). ALTER on the table CHECK + CREATE OR REPLACE on the two RPCs (signatures unchanged → grants preserved); defensive remap of any retired-value rows (0 expected). Does **not** touch the `detected_register` field. Interim stop-gap until the tenant-scoped vocab registry (parking-lot). |
> | `translation_corrections`, `translation_reviews` | — | **not built yet** |
>
> Prod runs the full schema through migration **019** (Phase 2 cutover 2026-06-11 replayed 007→015; Phase 3 cutover 2026-06-18 replayed 016→019). The column
> definitions in the subsections below are the design of record; where 007/008 diverged from the
> original sketch it's noted inline.

### Tables that exist today (MVP)

#### `messages`
> **RLS: membership-scoped as of migration 018 (Phase 3 Step 2 / Spec 7).** SELECT and INSERT
> now require `tenant_id = auth_tenant_id() AND is_active_member(conversation_id, auth.uid())` —
> a user may read or post a message only inside a conversation they are an active member of. This
> replaces the 008 tenant-only predicate (the "one global room" read/write boundary). **No UPDATE
> or DELETE policy** → messages remain immutable for `authenticated` (unchanged). Realtime
> `postgres_changes` applies the SELECT policy for the `authenticated` role, so membership also
> governs realtime delivery (verified explicitly by the gate). Policy names are unchanged from 008
> (`messages_select_same_tenant`, `messages_insert_own` — the `_same_tenant` suffix is now a slight
> misnomer; the predicate is tenant **and** membership).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key, default `gen_random_uuid()` |
| `created_at` | timestamp with time zone | Default `now()` |
| `sender_id` | text → **uuid** | Was the typed username string. **Staging (008):** now `uuid`, FK `auth.users(id)` ON DELETE SET NULL. Prod still `text`. |
| `original_text` | text | The message as typed |
| `source_language` | text | BCP 47 language code, detected by AI at send |
| `tenant_id` | uuid | NOT NULL, FK to `tenants(id)`. Added by migration `001`. Indexed (014). |
| `conversation_id` | uuid | **Promoted to a real FK by migration 017 (Phase 3 Step 1).** Pre-staged by 014 (nullable, `DEFAULT` the global-conversation sentinel `00000000-0000-0000-0000-000000000002`); 017 inserts the `conversations` global row, **adds the FK → `conversations(id)`**, `SET NOT NULL`, and **drops the 014 default** (real conversation ids take over). Zero backfill, as designed. Indexed (014). FK is NO ACTION on delete (conversations are never hard-deleted in-model; soft-leave only). |

**Vestigial columns dropped by migration 014.** `room_id`, `translated_text`, `target_language`, `tone`, `context_id`, `model_version`, `latency_ms` were all superseded and are removed: `room_id`/`context_id` → `conversation_id` + `conversation_contexts`; `translated_text` → `message_translations.translated_text`; `target_language` → `message_translations.language`; `tone` → per-call `context_type` + `conversation_contexts.detected_register`; `model_version` → `translation_events.model_used`; `latency_ms` → `translation_events.latency_ms`. They lived in `000_base_schema.sql`; 014 is an `ALTER … DROP COLUMN` (not a recreate) run on staging then in the prod replay, so both environments stay matched. (decisions.md 2026-06-11 "Forward-schema prep".)

#### `message_translations`
> **RLS: membership-scoped as of migration 018 (Phase 3 Step 2 / Spec 7).** The translation cache
> inherits the exact read/write boundary of the message it caches. Because the cache has no
> `conversation_id` column, all three policies (SELECT/INSERT/UPDATE) resolve membership through
> the parent message via `EXISTS (SELECT 1 FROM messages m WHERE m.id = message_translations.message_id
> AND m.tenant_id = auth_tenant_id() AND is_active_member(m.conversation_id, auth.uid()))`. This is
> the easy-to-miss half of Spec 7: without it a non-member could read a conversation's translations
> even though they cannot read its source messages. The frontend upserts (`INSERT … ON CONFLICT DO
> UPDATE`), so both the INSERT `WITH CHECK` and the UPDATE `USING`/`WITH CHECK` carry the predicate.
> No DELETE policy (unchanged — cache rows die via the `message_id` FK cascade, migration 016). Policy
> names unchanged from 008 (`mt_select_same_tenant`/`mt_insert_same_tenant`/`mt_update_same_tenant`).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key, default `gen_random_uuid()` |
| `message_id` | uuid | FK to `messages(id)`, **ON DELETE CASCADE** — the cache is a strict child of its message, so deleting a message removes its cached translations. Reconciled to cascade on **both** environments by migration 016 (2026-06-12) after staging was found drifted to NO ACTION (migration 000's hand-reconstruction had dropped the clause prod carried). Nullable in schema; the cache contract assumes a real link. |
| `language` | text | NOT NULL. Target language code (BCP 47). |
| `translated_text` | text | NOT NULL. The cached translation. |
| `created_at` | timestamptz | Default `now()`. **Migration 014** converted this from `timestamp without time zone` (naive values interpreted AS UTC) to standardize on tz-aware timestamps across the schema. |
| `tenant_id` | uuid | NOT NULL, FK to `tenants(id)`. Added by migration `001`. Indexed (014). |
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

**Replaced by `profiles`** — and as of migration 008 this table is **dropped on staging**
(`DROP TABLE public.user_profiles CASCADE`). The `user_id` text key and `default_language` moved:
identity is now the `auth.users` uuid (via `profiles`) and language lives in
`user_linguistic_profiles.preferred_language`. Prod dropped `user_profiles` in the Phase 2 cutover (2026-06-11).

### Tables to add in Phase 0 (cheap structural prep)

#### `tenants`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `name` | text | |
| `default_correction_ownership` | text + CHECK | `'platform' \| 'tenant' \| 'shared'`, default `'platform'`. (Migration 001 already implements this as text + CHECK, not a Postgres enum — matches the project-wide anti-enum convention; spec corrected 2026-06-11.) |
| `training_data_agreement` | boolean | default false |
| `created_at` | timestamptz | Standardized by migration 014 (was naive `timestamp`). |

Seeded with one row representing the chat app itself. Every other table gets a `tenant_id` FK pointing at this row. When Phase 2 opens the API to external customers, new tenants get new rows and RLS scopes them.

### Tables to add in Phase 1 (with the contextual-translation feature)

#### `user_linguistic_profiles`
> **Live on staging** (recreated by migration 008 with a uuid key). PK is composite
> `(user_id, tenant_id)`. Enum-like columns are enforced as text + `CHECK` constraints, not Postgres
> enums. RLS: SELECT same-tenant, UPDATE own (`user_id = auth.uid()`).
| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid | **FK to `profiles(id)`** ON DELETE CASCADE (008). Part of composite PK. |
| `tenant_id` | uuid | FK to tenants. Part of composite PK. |
| `preferred_language` | text | e.g. `"es"`; set `explicit` at onboarding |
| `dialect_region` | text | e.g. `"es-AR"` (Rioplatense) |
| `dialect_confidence` | float | 0.0–1.0, default 0.0 |
| `dialect_source` | text+CHECK | `'explicit' \| 'inferred'`, default `'inferred'` |
| `formality_preference` | text+CHECK | `'formal' \| 'neutral' \| 'casual'` |
| `formality_source` | text+CHECK | `'explicit' \| 'inferred'`, default `'inferred'` |
| `gender_signal` | text+CHECK | `'masculine' \| 'feminine' \| 'neutral' \| 'nonbinary' \| 'unknown'`. 008 dropped `nonbinary` from the CHECK (regression vs. migration 003); **migration 009 restores it** (pending its staging run). `neutral` = source language has no grammatical gender (Finnish, Turkish, …); `nonbinary` = speaker uses gender-inclusive forms (decisions.md 2026-05-12). |
| `gender_source` | text+CHECK | `'explicit' \| 'inferred'`, default `'inferred'` |
| `script_preference` | text | e.g. `"latin"`, `"traditional"`, `"simplified"` |
| `script_source` | text+CHECK | `'explicit' \| 'inferred'`, default `'inferred'` |
| `known_languages` | text[] | e.g. `["es", "en"]` for bilingual users |
| `updated_at` | timestamptz | default `now()` |

#### `conversation_contexts`
> **RLS added 2026-06-12 (migration 017).** This table has been live on staging since
> migration 002. Migration 017 (Phase 3 Step 1) closes the long-standing RLS gap: it adds a
> SELECT policy gated on active membership (`is_active_member(conversation_id, auth.uid())`)
> and adds the `conversation_id` FK → `conversations(id)` **`NOT VALID`** (enforced on new/
> updated rows; legacy rows left unscanned). Writes remain RPC-only (no client INSERT/UPDATE
> policy). The `conversation_id` PK here is the same id pre-staged on
> `messages.conversation_id` (migration 014) and seeded as the global-conversation sentinel.
> `participant_ids` is **legacy** — membership is now authoritative in `conversation_members`;
> `participant_ids` is retained for the existing context-builder read path and is not the
> source of truth for access control.
| Column | Type | Notes |
|---|---|---|
| `conversation_id` | uuid | Primary key; FK → `conversations(id)` (017, `NOT VALID`). |
| `tenant_id` | uuid | FK to tenants |
| `participant_ids` | uuid[] | **Legacy** — superseded by `conversation_members` for access control (017). |
| `detected_register` | text + CHECK | `'professional' \| 'casual' \| 'romantic' \| 'family' \| 'support'`. (text + CHECK, not a Postgres enum — anti-enum convention; spec corrected 2026-06-11.) |
| `register_confidence` | float | 0.0–1.0 |
| `relationship_closeness` | text + CHECK | `'new' \| 'acquainted' \| 'close'`. (text + CHECK, not enum; spec corrected 2026-06-11.) |
| `closeness_signals` | jsonb | `{message_count, days_active, avg_response_time}` |
| `dominant_topics` | text[] | e.g. `["medical", "legal"]` for domain routing |
| `updated_at` | timestamptz | Standardized by migration 014 (was naive `timestamp`). |

Updated by a background job every N messages or when a significant shift is detected. NOT updated on every message.

#### `conversations` (migration 017, Phase 3 Step 1)
> First-class conversation objects. Replaces the implicit "everyone shares the global
> conversation" model. Created only via the `create_conversation()` RPC; never client-inserted.
> RLS: SELECT gated on active membership (`is_active_member`). The global-conversation sentinel
> (`…0002`) is seeded here as a `group` row in the tenant sentinel (`…0001`) with `created_by NULL`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK, default `gen_random_uuid()`. |
| `tenant_id` | uuid | NOT NULL, FK → tenants. Single-tenant invariant enforced in the RPC. |
| `kind` | text + CHECK | `'direct' \| 'group'`. `direct` must have exactly 2 members. |
| `title` | text | Nullable; group display name. |
| `context_type` | text + CHECK | `'casual' \| 'dating' \| 'professional' \| 'academic'`, default `'casual'`. **Unified with the translation engine vocab in migration 019** (was `professional/casual/romantic/family/support`). This is the user-chosen conversation register; distinct from the inference-output `detected_register` field, which keeps its own set. Set via `set_conversation_context_type()`. |
| `created_by` | uuid | FK → `profiles(id)` **ON DELETE SET NULL** — a conversation survives its creator's account deletion (persists while any member is active). |
| `dedupe_key` | text | Sorted member-set string; populated only when resolved policy = `dedupe`, else NULL. Arbiter of "one thread per member-set". |
| `created_at` / `updated_at` | timestamptz | NOT NULL, default `now()`. |

**Indexes/constraints:** `conversations_tenant_id_idx`; partial unique `conversations_dedupe_unique (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL` (race-safe dedupe).

#### `conversation_members` (migration 017, Phase 3 Step 1)
> Membership rows. **Soft-leave model** (mirrors `blocks.unblocked_at`): leaving sets `left_at`
> rather than deleting the row, so history and re-join are clean. One active row per
> (conversation, account) enforced by a partial unique index. Created/updated only via RPCs.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK, default `gen_random_uuid()`. |
| `conversation_id` | uuid | NOT NULL, FK → `conversations(id)` **ON DELETE CASCADE**. |
| `account_id` | uuid | NOT NULL, FK → `profiles(id)` **ON DELETE CASCADE**. |
| `tenant_id` | uuid | NOT NULL, FK → tenants. |
| `role` | text + CHECK | `'owner' \| 'member'`, default `'member'`. Creator is `owner`. |
| `joined_at` | timestamptz | NOT NULL, default `now()`. |
| `left_at` | timestamptz | Nullable; non-null = soft-left (inactive membership). |
| `last_read_at` | timestamptz | Nullable; read-cursor for unread counts. |

**Indexes/constraints:** `conversation_members_account_id_idx`, `conversation_members_conversation_id_idx`; partial unique `conversation_members_active_unique (conversation_id, account_id) WHERE left_at IS NULL`.

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
> **Built by migration 013 (Phase 2 Step 7) — gate PASSED on staging (37/37).** RLS: SELECT own
> (`ddr_select_own`); all writes via SECURITY DEFINER RPCs. The three columns marked † extend
> the original §7 sketch to support the two-phase grace flow + a future admin path
> (decisions.md 2026-06-11).
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `user_id` | uuid | FK → `profiles(id)` **ON DELETE SET NULL** — the audit row *survives* the hard delete; the null is itself anonymization. (NOT cascade: that would delete the audit record of its own erasure.) |
| `tenant_id` | uuid | FK to tenants |
| `requested_at` | timestamptz | |
| `grace_until` † | timestamptz | Hard-delete eligible once `now() > grace_until` (default request + 30 days) |
| `completed_at` | timestamptz | nullable; set when the sweep finishes |
| `status` | text + CHECK | `'pending' \| 'processing' \| 'completed' \| 'cancelled'` † (`cancelled` = grace-window reversal) |
| `requested_by` † | text + CHECK | `'user' \| 'admin'` (default `'user'`) |
| `deleted_fields` | jsonb | Log of what was removed (table → count/flag) |
| `updated_at` | timestamptz | |

Two-phase erasure: `request_account_deletion()` soft-deletes (`profiles.status='deactivated'`) and enqueues a `pending` row; `cancel_account_deletion()` reverses within grace; the daily Node sweep (`server/lib/deletion.js`) hard-deletes due requests via the admin API. The FK chain (007/008) does the anonymization — profile/identifiers/settings/linguistic-profile/events cascade away, `messages.sender_id` → NULL retains content. The deletion job will also **anonymize** corrections (strip user_id and PII, keep translation pairs) rather than hard-deleting — but `translation_corrections` is **not built yet**, so the sweep currently logs `corrections_anonymized: 0` (wire the strip-PII pass when that table lands). Anonymized translation pairs remain legally usable for training; hard-deletion destroys training data that is irreplaceable.

On a voluntary erasure the sweep records the same keyed email HMAC as Step 6, reusing `email_hash_abuse` + `record_abandoned_email_hash()` (no schema change); `abandon_count` therefore counts "times an account on this email hash vanished" (abandonment **or** deletion). Splitting the two via a `source` column is parked (parking-lot.md).

#### `user_profile_events` (append-only event source)
> **Live on staging** — first added by migration 005 (+ `task_id` in 006), recreated by 008 with a
> **uuid** `user_id` (FK `profiles`). RLS: SELECT own, INSERT own. The inference workstream writes
> here with `source='inference'`.
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `user_id` | uuid | FK to users |
| `tenant_id` | uuid | FK to tenants |
| `event_type` | text | e.g. `"dialect_inferred"`, `"formality_set_explicit"` |
| `previous_value` | jsonb | |
| `new_value` | jsonb | |
| `source` | enum | `'explicit' \| 'inference' \| 'correction_analysis'` |
| `created_at` | timestamptz | Standardized by migration 014 (was naive `timestamp`). |

Lets you reconstruct what the system believed about a user at any point in time. Critical for debugging bad translations and for quality control on training data.

### Phase 2 tables (identity, discovery, social graph)

> **Status:** `profiles`, `account_identifiers`, `account_settings` are **live on staging** (migration
> 007). `relationships`, `blocks`, `reports`, `invites`/`invite_redemptions`, `email_hash_abuse` are
> **live on staging via migration 011 — gate PASSED 40/40** (Phase 2 Step 5). Design rationale and
> trade-offs in `decisions.md` (2026-06-09 + 2026-06-10 entries). Policy *values* live in
> `policies.md` + `lib/policies.js`. **Identity vs. discovery principle:** the stable identity is
> the `auth.users` uuid; human-facing discovery handles are a separate normalized layer that
> points at it and is never a key.

#### Uniqueness scope (across vs. within tenant)
| Thing | Unique scope |
|---|---|
| `profiles.id` (uuid) | Global (across all tenants) |
| `tenant_id` | Global |
| invite `token` | Global (it's a URL) |
| `username` | **Within tenant** (`(tenant_id, canonical_username)`) |
| `display_name` | Not unique anywhere |
| email (at auth layer) | Global per Supabase project — see Model-A concern in decisions.md |

#### `profiles` (replaces `user_profiles` in Phase 2)
1:1 with `auth.users`. `id` = `auth.users.id` (FK, on delete cascade). RLS uses `auth.uid()`.
Adopts **Model A — one tenant per user** (decisions.md 2026-06-09).
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK = `auth.users.id` |
| `tenant_id` | uuid | NOT NULL, FK to `tenants(id)` |
| `display_name` | text | NOT NULL. "The name other people see." Not unique. |
| `username` | text | Canonical (lowercased). Unique **within tenant**. See policies.md §1. |
| `username_source` | enum | `'system_generated' \| 'user_set'`, default `'system_generated'` |
| `username_last_changed_at` | timestamptz | Supports the 1/year rule |
| `is_verified` | boolean | default false. Placeholder; no verification feature yet. |
| `verification_method` | text | nullable. How verified (platform/tool); may become enum/array later. |
| `status` | enum | `'pending' \| 'active' \| 'deactivated'`, default `'pending'` |
| `onboarding_completed_at` | timestamptz | null until display_name + language set; flips status to `active` |
| `created_at` / `updated_at` | timestamptz | |

Language/dialect preferences do NOT live here — they stay in `user_linguistic_profiles`
(`preferred_language` written `explicit` at onboarding). Lifecycle (pending → active →
abandonment) is governed by policies.md §6; a DB trigger on `auth.users` insert creates the
pending profile + random username.

#### `account_identifiers` (normalized discovery handles)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `account_id` | uuid | FK to `profiles(id)`, on delete cascade |
| `tenant_id` | uuid | FK to tenants |
| `type` | enum | `'email' \| 'username' \| 'phone' \| 'friend_code'` |
| `value` | text | Canonical/normalized (lowercased email/username) |
| `status` | enum | `'active' \| 'retired' \| 'reserved'`. Rows are never hard-deleted. |
| `verified` | boolean | default false |
| `created_at` | timestamptz | |

Usernames unique within tenant via `(tenant_id, type, value)` covering active+retired+reserved
(enforces non-reuse). Reserved words seeded as `reserved` rows. **Handle minimization** (policies.md
§2): a discovery query returns only the matched handle, never an account's other identifiers.

#### `account_settings` (per-user privacy prefs, 1:1)
| Column | Type | Notes |
|---|---|---|
| `account_id` | uuid | PK, FK to `profiles(id)` |
| `tenant_id` | uuid | FK to tenants |
| `discoverable_by_email` | boolean | default true |
| `discoverable_by_username` | boolean | default true |
| `allow_dms_from` | enum | `'everyone' \| 'contacts' \| 'nobody'`, default `'contacts'` |
| `updated_at` | timestamptz | |

#### `relationships` (contact graph; conversations are independent of this)
> **Canonical-pair model** (migration 011; decisions.md 2026-06-10 "Contact-graph representation").
> ONE row per unordered pair `{account_lo, account_hi}` with `account_lo < account_hi` enforced by a
> CHECK. This replaces the originally-sketched directional `requester_id`/`addressee_id` design.
> Direction is carried by `initiator_id` (whoever asked first), not by column position. The single-row
> invariant makes the **glare race** (both users hit "add" before either accepts) structurally
> impossible — both adds resolve to the *same* pair row, and the reverse-pending case auto-accepts.
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | NOT NULL, FK to tenants |
| `account_lo` | uuid | FK to `profiles(id)` ON DELETE CASCADE. The lexically-smaller of the two uuids. |
| `account_hi` | uuid | FK to `profiles(id)` ON DELETE CASCADE. The lexically-larger. CHECK `account_lo < account_hi`. |
| `initiator_id` | uuid | FK to `profiles(id)`. Whoever sent the request. CHECK `initiator_id IN (account_lo, account_hi)`. Drives the DM-initiation policy's "initiator's handle type" rule + the incoming-vs-outgoing UI distinction. |
| `state` | text+CHECK | `'pending' \| 'accepted' \| 'declined'`, default `'pending'` |
| `via_identifier_type` | text+CHECK | `'email' \| 'username' \| 'phone' \| 'friend_code' \| 'invite_link'` — **provenance**, set at add-time, read by the DM-initiation policy. `invite_link` is set only by `redeem_invite()`. |
| `created_at` / `updated_at` | timestamptz | |

Unique `(tenant_id, account_lo, account_hi)` — the anti-glare guarantee. Second index
`relationships_hi_idx (tenant_id, account_hi)` so "all of X's contacts" is index-backed in both
positions. **RLS:** SELECT where the caller is `account_lo` or `account_hi` (either party sees the
row); all writes go through `request_contact` / `respond_to_contact` / `redeem_invite` (SECURITY
DEFINER). The state machine: new→`pending`, reverse-pending→`accepted` (mutual), `accepted`→error,
`declined`→re-request `pending`.

#### `blocks` (directional)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK to tenants |
| `blocker_id` | uuid | FK to `profiles(id)` |
| `blocked_id` | uuid | FK to `profiles(id)` |
| `unblocked_at` | timestamptz | nullable; null = currently blocked. Kept after unblock for history. |
| `created_at` | timestamptz | |

Partial unique index `blocks_active_unique (blocker_id, blocked_id) WHERE unblocked_at IS NULL` — no
double-active-blocking, while historical (unblocked) rows coexist. Second partial index
`blocks_blocked_active_idx (blocked_id) WHERE unblocked_at IS NULL` backs the reverse leg of
`active_block_exists()`. **RLS:** SELECT the **blocker only** — the blocked party must never learn
they were blocked by reading this table. A block is an **override layer**: it never mutates the
`relationships` row; `active_block_exists()` (bidirectional) is checked first by every initiation
path and both discovery RPCs (symmetric hide). Writes via `block_account` / `unblock_account`.

#### `reports`
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | FK to tenants |
| `reporter_id` | uuid | FK to `profiles(id)` |
| `reported_id` | uuid | FK to `profiles(id)` |
| `reason` | enum | `'spam' \| 'abuse' \| 'impersonation' \| 'other'` |
| `details` | text | nullable |
| `status` | text+CHECK | `'open' \| 'reviewed' \| 'actioned' \| 'dismissed'`, default `'open'` |
| `created_at` | timestamptz | |

Initial behavior: `report_account()` records the report **and** ensures an active block in **one
transaction** (atomic — both or neither). Multiple reports of the same target are allowed (distinct
incidents). No moderation-queue UI yet; rows accumulate at `status='open'` for later review. **RLS:**
SELECT the reporter only (a future moderation tool reads via service role). `reports_no_self` CHECK.

#### `invites` + `invite_redemptions` (deep-link / invite-link primitive)
`invites`: `id`, `tenant_id`, `token` (globally unique, opaque), `kind` enum
`'contact' \| 'conversation'`, `created_by` FK profiles, `target_conversation_id` uuid nullable
(Phase 3), `max_uses` int nullable, `use_count` int default 0, `expires_at` timestamptz nullable,
`revoked` boolean default false, `created_at`.
`invite_redemptions`: `id`, `invite_id` FK, `redeemed_by` FK profiles, `redeemed_at`, UNIQUE
`(invite_id, redeemed_by)` (a re-click is a no-op, not a re-add). Redeeming a `contact` invite
**AUTO-ACCEPTS** the contact (decisions.md 2026-06-10) — it writes a `relationships` row directly at
`state='accepted'`, `via_identifier_type='invite_link'`, `initiator_id = created_by`, with no
separate accept handshake (minting the link is the creator's consent; clicking is the redeemer's).
Block-checked first. `conversation`-kind invites are reserved for Phase 3 and rejected by
`redeem_invite()` for now. **RLS:** `invites` SELECT the creator only (redemption is by token through
the definer RPC, which also prevents token/invite enumeration via the table); `invite_redemptions`
SELECT the redeemer only. Defaults at launch: multi-use, no expiry, revocable. Writes via
`create_invite` / `redeem_invite` / `revoke_invite`.

#### `tenants` — add columns
`dm_initiation_policy` jsonb — per-tenant overrides on top of `lib/policies.js` global defaults.
Sole tenant launches `'{}'` (no overrides → mutual-acceptance-only; policies.md §3).
`conversation_policy` jsonb (migration 017) — per-tenant overrides for conversation-dedupe
(`{kind: 'dedupe'|'always_new'}`) on top of `lib/policies.js` `CONVERSATION.DEFAULTS`
(`direct: dedupe`, `group: always_new`). Sole tenant launches `'{}'`. Read by the
`create_conversation()` RPC to decide whether a create reuses an existing thread.

#### Where policy lives (three layers)
1. `docs/policies.md` — human-readable values, audited on a cadence.
2. `lib/policies.js` — machine source of truth for **global** defaults; all enforcement reads here.
3. `tenants.dm_initiation_policy` / `tenants.conversation_policy` (jsonb) — per-**tenant** overrides.

Schema enforces *mechanism* (uniqueness, non-deletion, the partial index); layers 1–3 own *values*.

#### `email_hash_abuse` (signup-spam monitor; table + RLS in 011, writes in Step 6)
When an abandoned pending account is deleted (policies.md §6), a **keyed hash** of its canonical email
is recorded here — never the plaintext — so repeat-abandon / signup-spam is detectable without
retaining deleted-user PII.
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | NOT NULL, FK to tenants |
| `email_hash` | bytea | `HMAC-SHA256(canonical_email, pepper)` |
| `key_version` | smallint | default 1; supports pepper rotation |
| `first_seen` / `last_seen` | timestamptz | |
| `abandon_count` | integer | default 1, CHECK `>= 1` |

UNIQUE `(tenant_id, email_hash, key_version)`. The HMAC is computed in the **Step 6 abandonment job**
(Node `crypto`), with the pepper read from an env secret — **the pepper never enters Postgres**, so
even a full DB compromise does not expose the key (decisions.md 2026-06-10). `key_version` lets the
pepper rotate forward without re-keying old rows; losing the pepper is low-stakes here (advisory-only
table, nothing joins on it). **RLS:** enabled with **no policy** for `authenticated`/`anon` *and*
`REVOKE ALL ... FROM anon, authenticated` — fully denied to clients; only the service role (Step 6
job) touches it. The table + RLS land in 011; the writes wire in Step 6.

### Phase 2 DB functions (live on staging, 007/008)

These three server-side functions are load-bearing for identity + RLS; treat them as part of the schema.

- **`auth_tenant_id()`** (007, `SECURITY DEFINER`, SQL) — returns `tenant_id FROM profiles WHERE id = auth.uid()`. The linchpin of every tenant-scoped RLS policy. It's `SECURITY DEFINER` so it can read `profiles` without tripping the very RLS it feeds (avoids recursion); returns NULL for an unauthenticated caller → access denied by default.
- **`handle_new_user()`** (007, `AFTER INSERT` trigger `on_auth_user_created` on `auth.users`) — creates the pending `profiles` row + `email` and `username` `account_identifiers` + default `account_settings`. System username = `'user_' + 8 hex chars` (needs pgcrypto). **Tenant hardcoded to the sole-tenant UUID `…001`** — every new signup lands in tenant 1. If it raises, the `auth.users` INSERT rolls back (no orphaned auth rows).
- **`complete_onboarding(p_display_name, p_preferred_language)`** (008, `SECURITY DEFINER`, `GRANT EXECUTE … TO authenticated`) — the P1→P3 transition: sets `status='active'`, `display_name`, `onboarding_completed_at`, and creates the `user_linguistic_profiles` row with `preferred_language` written `_source='explicit'`. Routed through an RPC (not a direct table write) precisely because `authenticated` is *not* allowed to write `status` directly (see §10 column-grant note).
- **`find_account_by_email(p_email)`** (010, **amended 011**, `SECURITY DEFINER`, `GRANT EXECUTE … TO authenticated`) — Step 4 discovery. Exact-equality lookup on the canonical email; returns at most one `(account_id, display_name, username)`. Bypasses `account_identifiers`' own-rows-only RLS deliberately, but **handle-minimizes**: returns only public handles, never the target's email/phone/other identifiers. Tenant-scoped via `auth_tenant_id()`; only `status='active'` profiles; respects `discoverable_by_email`; excludes the caller; **011 adds `AND NOT active_block_exists(caller, target)`** (symmetric block hide). No prefix/enumeration.
- **`search_accounts_by_username(p_prefix, p_limit)`** (010, **amended 011**, `SECURITY DEFINER`, `GRANT … TO authenticated`) — Step 4 username autocomplete. Prefix match on the canonical username; returns `(account_id, display_name, username)` rows. Min prefix length 3, result cap 20, LIKE metacharacters escaped (no `%`/`_` injection). Tenant-scoped; only active profiles; respects `discoverable_by_username`; excludes the caller; **011 adds the active-block filter** (both directions). Amending shipped functions is a behavior change → re-run the Step 4 gate after 011.
- **`change_username(p_new_username)`** (010, `SECURITY DEFINER`, `GRANT … TO authenticated`) — the **sole** username-change path (`profiles.username` is REVOKEd from `authenticated`, §10). Validates charset/length/reserved/non-reuse and the 1/365-day cadence (first `system_generated`→`user_set` change is free and starts the clock), then atomically retires the old `account_identifiers` row (never deletes), inserts the new active row, and updates `profiles`. Returns the new canonical username; raises a client-parseable error on any rule violation.

#### Phase 2 Step 5 social-graph RPCs (migration 011; gate PASSED on staging 40/40)

All nine are `SECURITY DEFINER`, `SET search_path = public`, `EXECUTE` granted to `authenticated`
only (revoked from `public`/`anon`), and tenant-scoped via `auth_tenant_id()` (an unauthenticated
caller matches nothing). They are the **sole write path** to the Step 5 tables — every social table
is RLS SELECT-only (or no policy), so direct client writes are denied.

- **`active_block_exists(p_a, p_b)`** — `STABLE` boolean helper. True iff an active block (`unblocked_at IS NULL`) exists in **either** direction between two accounts in the caller's tenant. `SECURITY DEFINER` so it reads `blocks` past the blocker-only RLS. Called first by `request_contact`, `respond_to_contact`, `redeem_invite`, and both discovery RPCs.
- **`request_contact(p_target, p_via)`** → text — add-a-contact entry point on the canonical pair. new→`'pending'`; reverse-pending→`'accepted'` (mutual); already-pending-by-caller / already-accepted→error; `declined`→re-request `'pending'`. Block-checked; rejects self/cross-tenant/`invite_link` via. Locks the pair row `FOR UPDATE` so concurrent adds serialize.
- **`respond_to_contact(p_other, p_accept)`** → text — accept/decline an incoming `pending` request (caller must be the addressee, i.e. not the initiator). Accept→`'accepted'` (block-checked); decline→`'declined'` (kept soft for a future re-request cooldown).
- **`block_account(p_target)`** → text — create an active block (idempotent: `'blocked'` / `'already_blocked'`). Does **not** mutate `relationships`.
- **`unblock_account(p_target)`** → text — stamp `unblocked_at` on the caller's active block (`'unblocked'` / `'not_blocked'`); history preserved.
- **`report_account(p_target, p_reason, p_details)`** → uuid — record a report **and** ensure an active block in one transaction (atomic). Returns the report id.
- **`create_invite(p_kind, p_max_uses, p_expires_at, p_target_conversation_id)`** → text — **amended in 017** (was 3-arg; the 4th param required a DROP + CREATE, not CREATE OR REPLACE — adding a param overloads rather than replaces). Mints an opaque base64url token (16 random bytes; `extensions.gen_random_bytes`, schema-qualified). Defaults `contact` kind, multi-use / no-expiry / revocable. **017 un-rejects `conversation` kind:** a `conversation` invite requires `p_target_conversation_id` and the caller to be an active member of that conversation. Re-REVOKE/GRANT issued for the new signature.
- **`redeem_invite(p_token)`** → text — **amended in 017** (CREATE OR REPLACE, same signature). Validates token (revoked/expired/max-uses/cross-tenant/own-invite all rejected) and records the redemption (one per user). `contact` kind unchanged → **auto-accepts** the contact with the creator (`via='invite_link'`, `initiator=creator`), returns `'accepted'`. **017 un-rejects `conversation` kind:** inserts an active `conversation_members` row for the redeemer on the target conversation (single-tenant + block checks, glare-safe), returns `'joined'`. Block-checked.
- **`revoke_invite(p_invite_id)`** → text — revoke an invite the caller created (`'revoked'` / `'noop'`); no further redemptions.

#### Phase 2 Step 6 abandonment support functions (migration 012; gate PASSED on staging 2026-06-11, 19/19)

Unlike every RPC above, these are **system functions** called only by the abandonment sweep as
the `service_role` — `EXECUTE` is granted to `service_role` only (revoked from
`public`/`anon`/`authenticated`), and they do **not** use `auth.uid()`/`auth_tenant_id()` because
the sweep operates across all tenants, not as a logged-in user. They exist because the sweep's
logic must live partly in Node (the abuse hash is a keyed HMAC whose pepper never enters Postgres —
decisions.md 2026-06-10) but two pieces are cleanest in SQL:

- **`list_abandoned_pending_accounts(p_max_age interval DEFAULT '30 days')`** → setof `(account_id, tenant_id, canonical_email, username_source)` — `STABLE SECURITY DEFINER`. Returns every `status='pending'` account created more than `p_max_age` ago, with the canonical (`lower(trim)`) email the sweep hashes and `username_source` (a guard — the sweep refuses anything not `system_generated`). Backed by the `profiles_tenant_status_created_idx` partial index (007), built for exactly this query.
- **`record_abandoned_email_hash(p_tenant_id uuid, p_email_hash_hex text, p_key_version smallint DEFAULT 1)`** → void — `VOLATILE SECURITY DEFINER`. Atomic insert-or-increment into `email_hash_abuse` (the +1 can't be expressed as a plain PostgREST upsert). The hash arrives as hex and is `decode()`d to `bytea`; on conflict `(tenant_id, email_hash, key_version)` it bumps `abandon_count` + `last_seen`, preserving `first_seen`.

**No "release username" function exists by design:** the sweep deletes the `auth.users` row via the
Supabase admin API, and the FK cascade (auth.users→profiles→account_identifiers/account_settings,
all ON DELETE CASCADE, 007) drops the username + email rows — with the rows gone, within-tenant
uniqueness + historical-non-reuse no longer block the handle, so it is released automatically
(decisions.md 2026-06-10 "Step 6 abandonment").

#### Phase 2 Step 7 data-deletion functions (migration 013; gate PASSED on staging, 37/37)

Two **user-facing** RPCs (caller-scoped via `auth.uid()`, so a user can only ever erase
themselves) plus three **service_role-only** sweep helpers (mirroring the Step 6 list/record
split). The hard delete itself runs in Node (`server/lib/deletion.js`) because `admin.deleteUser`
is a Supabase auth-schema op and the abuse-hash pepper must never enter Postgres.

- **`request_account_deletion(p_grace interval DEFAULT '30 days')`** → `data_deletion_requests` row — `VOLATILE SECURITY DEFINER`, `EXECUTE` to `authenticated`. Soft-deletes the caller (`profiles.status='deactivated'`) and enqueues a `pending` request with `grace_until = now()+p_grace`. **Idempotent** — returns an existing open request without resetting the grace clock.
- **`cancel_account_deletion()`** → boolean — reverses a `pending` request within grace: marks it `cancelled` and restores the profile to `active` (or `pending` if onboarding never completed). `false` if nothing is pending. Cannot cancel once the sweep has claimed it (`processing`).
- **`list_due_deletion_requests()`** → setof `(request_id, account_id, tenant_id, canonical_email)` — `STABLE SECURITY DEFINER`, `service_role` only. Pending requests past `grace_until`, with the canonical email to hash. Backed by `data_deletion_requests_due_idx`.
- **`claim_deletion_request(p_id)`** → boolean — atomic `pending`→`processing`; true if this call won the claim (guards double-processing across overlapping runs).
- **`complete_deletion_request(p_id, p_deleted_fields jsonb)`** → void — stamps `completed` + `completed_at` + the `deleted_fields` audit log, by PK (the row's `user_id` is already NULL from the cascade).

**The audit row outlives the user by design:** `data_deletion_requests.user_id` is FK → `profiles`
**ON DELETE SET NULL** (not CASCADE), so the request row survives its own erasure as proof-of-deletion
(decisions.md 2026-06-11 "Step 7 data deletion").

#### Phase 3 Step 1 conversation RPCs (migration 017; gate PASSED on staging 2026-06-12, 35/35)

All `SECURITY DEFINER`, `SET search_path = public`, `EXECUTE` granted to `authenticated` only
(revoked from `public`/`anon`), tenant-scoped via the caller's profile. They are the **sole write
path** to `conversations` / `conversation_members` — both tables are RLS SELECT-only, so direct
client writes are denied.

- **`is_active_member(p_conversation_id, p_account_id)`** → boolean — `STABLE SECURITY DEFINER` membership helper. True iff an active (`left_at IS NULL`) `conversation_members` row exists. Reads past the membership-gated RLS (mirrors `active_block_exists`); the linchpin of the `conversations` / `conversation_members` / `conversation_contexts` SELECT policies.
- **`create_conversation(p_kind, p_member_ids, p_title, p_context_type)`** → uuid — `VOLATILE`. Builds the distinct member set (incl. caller); rejects `<2` members and `direct ≠ 2`; enforces the single-tenant invariant via a `profiles` count (opaque "member not found" on mismatch); block-gated via `active_block_exists`. Resolves dedupe from `tenants.conversation_policy` (falling back to `CONVERSATION.DEFAULTS`: `direct→dedupe`, `group→always_new`); when `dedupe`, sets `dedupe_key` = sorted member-set and **finds-or-creates** race-safely (INSERT, catch `unique_violation` → re-SELECT on the partial unique index). Ensures an active membership row per member (caller = `owner` on a fresh conversation), glare-safe.
- **`leave_conversation(p_conversation_id)`** → void — **soft-leave**: stamps `left_at = now()` on the caller's active membership (mirrors `unblock_account`). No-op-safe if already left / not a member.
- **`set_conversation_context_type(p_conversation_id, p_context_type)`** → void — validates `context_type` against the CHECK set, requires the caller be an active member (`is_active_member`), updates `conversations.context_type` + `updated_at`.

(`create_invite` / `redeem_invite` were also amended in 017 for `conversation`-kind invites — see the Step 5 RPC list above.)

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

- **Current (2026-07-05):** mode-based split, configured in `lib/translatePrompt.js` (`TRANSLATE_MODEL`, `TRANSLATE_REASONING_EFFORT`, `DETECT_MODEL`) and consumed by both call sites. Translate runs `gpt-5.4` with `reasoning_effort: 'medium'` (flat param — Chat Completions shape; the nested `reasoning: { effort }` is Responses-API-only); detect stays `gpt-4o-mini` (trivial classification, runs on every send — reasoning would add cost/latency for nothing). No `temperature` on translate calls: unsupported on gpt-5.4 reasoning calls. The effort constant is the cost/latency dial — drop to `low`/`none` if chat latency hurts (OpenAI's guidance for latency-sensitive paths).
- **History:** MVP ran `gpt-4o-mini` for everything (prompt v1.x). Replaced after observed literal-translation failures (decisions.md 2026-07-05).
- **Small scale:** Consider per-message routing — cheap model for simple messages, gpt-5.4 for idiomatically dense or context-heavy ones. The ~25x cost delta makes routing logic worth building (parking lot).
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
├── migrations/               Run in Supabase SQL editor, manually for now (000–019; 000–019 live on prod as of 2026-06-18)
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
│   └── 019_unify_context_type_vocab.sql       Unify conversations.context_type CHECK + create_conversation/set_conversation_context_type inline guards on the engine vocab (casual/dating/professional/academic). ALTER + CREATE OR REPLACE; defensive remap; does NOT touch detected_register
├── scripts/
│   ├── rls-adversarial-test.mjs   Phase 2 Step 3 RLS gate (run on staging)
│   ├── discovery-gate-test.mjs    Phase 2 Step 4 discovery gate (run on staging)
│   ├── social-graph-gate-test.mjs Phase 2 Step 5 social-graph + safety gate (run on staging)
│   ├── abandonment-gate-test.mjs  Phase 2 Step 6 abandonment + abuse-monitoring gate (run on staging)
│   ├── deletion-gate-test.mjs     Phase 2 Step 7 data-deletion gate (run on staging)
│   ├── conversations-gate-test.mjs Phase 3 Step 1 conversations schema + RPC gate (run on staging)
│   └── messages-rls-gate-test.mjs  Phase 3 Step 2 membership-scoped messages RLS gate — adversarial matrix + explicit realtime check (run on staging)
├── src/
│   ├── App.jsx               Orchestrator: auth state machine, conversation list, active thread, single realtime subscription, optimistic send + reconcile, modals
│   ├── main.jsx              React entry point
│   ├── index.css             Tailwind directives
│   ├── components/           Presentational pieces (Phase 3 conversation UI; markup ported from mockups/phase3-conversations.html)
│   │   ├── ConversationList.jsx     Sidebar list of conversations (+ avatar/initials/time helpers, exported)
│   │   ├── ConversationView.jsx     Thread: header + overflow menu (register selector + "?" explainer) + messages + composer
│   │   ├── MessageBubble.jsx        Per-message translate/cache/infer + "Original:" single-line expandable preview + optimistic pending/failed states
│   │   ├── NewConversationModal.jsx People-picker (discovery RPCs) → create_conversation (direct dedupe / group)
│   │   └── InviteModal.jsx          Mints a conversation invite (create_invite) → copyable ?join=<token> link
│   └── lib/
│       ├── supabase.js       Supabase client initialization
│       ├── config.js         Non-secret constants (CHAT_APP_TENANT_ID etc.)
│       ├── vocabularies.js   Client source of truth for enumerated option sets (context_type/register, languages); aligned with translatePrompt.js + the 019 CHECK
│       ├── translation.js    Translation-engine client config (API URLs, PROFILE_INFERENCE_ENABLED) + language-code normalizer + detectSourceLanguage(); keeps chat UI decoupled from the engine HTTP contract
│       ├── discovery.js      Data-access layer for the people-picker: find_account_by_email / search_accounts_by_username RPC wrappers
│       └── conversations.js  Data-access layer for Phase 3 conversations: RPC wrappers (create/leave/setContextType/invite/redeem) + list/read/insert queries
├── docs/
│   ├── architecture.md       This file
│   ├── strategy.md           Product vision, two-phase plan, market
│   ├── operations.md         Cost model, hiring, workflow
│   ├── roadmap.md            Phased roadmap with checklists
│   ├── phase2-implementation.md  Phase 2 step-by-step build spec
│   ├── parking-lot.md        Uncommitted ideas
│   ├── decisions.md          Dated decisions log
│   ├── policies.md           Trust & safety / identity governance (living, audited)
│   ├── specs.md              Hermes spec archive
│   ├── verification.md       Verification and debugging checklists
│   ├── hermes.md             Hermes Agent charter (VPS execution agent)
│   └── cowork-handoff.md     Weekly Hermes→Cowork briefing
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
