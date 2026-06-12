# Translation App — Decisions Log

> Append-only record of significant decisions and why they were made. New decisions go at the top. Each entry should explain not just what was decided but what the alternatives were and why we chose this one. Future-us will need that context to know whether a decision is still load-bearing.

**Format:**
```
## YYYY-MM-DD — Decision title

**Decision:** What we decided, in one sentence.
**Context:** What problem or question prompted this.
**Alternatives considered:** What else we looked at.
**Reasoning:** Why we chose what we chose.
**Implications:** What this commits us to or rules out downstream.
**Revisit when:** Specific conditions that would warrant reopening this decision.
```

---

## 2026-06-11 — Phase 2 production cutover executed (prod wipe + replay 007→015)

**Decision:** Executed the Phase 2 production cutover — wiped prod test data, replayed migrations 007→015 in order against prod, enabled the `profile_writer` LOGIN out of band, set the prod Vercel env vars on port 6543, and redeployed. Along the way settled three sub-decisions: **(a)** truncate the event-log tables (`translation_events`/`agent_events`) along with the chat data rather than preserving them; **(b)** proceed **without a pre-wipe snapshot** (Supabase free tier has no backups); **(c)** treat the existing `main` auto-deploy as the deploy mechanism — no separate "deploy frontend" step.

**Context:** Prod was fully migrated through 006 (pre-007) and the Phase-2 auth frontend was already live on `main` against that un-migrated DB (i.e. prod was effectively broken — the auth/onboarding UI was calling tables/RPCs that didn't exist). The cutover's real job was therefore "migrate the DB to match the app that already shipped," not "ship a new app." All migrations had passed their gates on staging; the replay was a known-good sequence.

**Alternatives considered:**
- *Keep the event-log tables* — rejected: everything in them was pre-launch test data plus the known stray `hermes_test` row; truncating gives a clean flywheel from launch and finally clears that stray row (the INSERT-only `hermes_writer` role couldn't delete it).
- *Manufacture a snapshot anyway* (pg_dump the few test rows) — rejected as not worth it: the schema lives in version-controlled migrations and the data was disposable, so the only thing a backup would insure against (real user data loss) didn't exist yet.
- *Gate the prod deploy behind a manual `vercel --prod`* — moot: prod auto-deploys from `main` per the Vercel project config; the "gating" in hermes.md/specs.md is an operating *contract* for Hermes, not a structural block. The env-var change did require an explicit redeploy to take effect.

**Reasoning:** An empty, disposable prod is the cheapest possible moment to do an irreversible reset. Replaying the exact staging-validated migration sequence (rather than hand-applying schema) guarantees prod ↔ staging parity. Each gate-bearing migration (008 identity cutover, 009 nonbinary restore, 015 profile_writer) was re-verified on prod immediately after running.

**Verified on prod (2026-06-11):** wipe left 0 rows in all 8 data tables, `tenants` seed intact. Replay 007→015 all green — 3 new identity tables + 27 reserved words + RLS (007); `user_profiles` dropped, 3 uuid promotions + `messages_sender_id_fk` + RLS + `complete_onboarding` (008); nonbinary CHECK restored (009); 7 social/deletion tables + 16 RPCs + RLS (010–013); `conversation_id` + 7 vestigial drops + 4 timestamptz + 4 FK indexes (014); `profile_writer` role with exactly the scoped grants/policies, still NOLOGIN/non-super/non-bypassrls until the out-of-band ALTER (015). Single-user smoke PASSED on live prod (signup → onboard → `status='active'` + ULP row → message sent).

**Two-user inference path — PASSED live on prod (2026-06-11).** User A sent an Argentine-Spanish message; User B (different `preferred_language`) viewed it → `POST /api/v1/infer-profile` returned `{"status":"updated","fields":[dialect_region, dialect_confidence, dialect_source, formality_preference, formality_source]}`. User A's ULP row updated to `es-AR`/`casual` (`updated_at` bumped); two `user_profile_events` rows landed (`dialect_region_inferred`, `formality_preference_inferred`, `source=inference`); **trust boundary held** — the write landed on the *sender* (A), not the viewer (B's row untouched); `gender_signal` null (below confidence — expected). This was the `profile_writer` role's first real exercise on prod.

**Still pending (before declaring the cutover fully GREEN):**
- *Vercel cron verification* — confirm `/api/v1/jobs/abandonment` (08:00) and `/api/v1/jobs/deletion` (09:00) are registered on the prod project.

**Dashboard-only gotchas this surfaced (not captured in any migration):**
- *Supabase Auth URL config* — magic links initially redirected to `localhost` because prod's **Site URL** was still the dev default. Fixed by setting Site URL = `https://translationapp1.vercel.app` and adding it to Redirect URLs. This config lives in the Supabase dashboard, not in `/migrations/`, so it's an easy cutover-checklist miss — see operations.md cutover notes.
- *Connection-string password footgun (cost ~1 hr).* The first prod inference attempt 500'd with `password authentication failed for user "profile_writer"` in the Vercel log. The connection *format* was correct (`profile_writer.<prod-ref>` @ port 6543 pooler) — the **password** was the problem: special characters in a connection-string password corrupt URL parsing and surface as this exact misleading auth error. Fixed by resetting the role to an **alphanumeric-only** secret + redeploy. **Lesson (applies to all future Supabase-role-for-Vercel bring-up, incl. the Phase 2 B2B API roles): use alphanumeric-only DB passwords, or URL-encode them.**
- *Stale comment in migration 015 — FIXED.* Lines 37–38 had shown "port 5432" + a bare `profile_writer` username + no encoding warning for the connection string; that's wrong for Vercel serverless (needs **6543** transaction pooler, and the pooler username must carry the project-ref suffix). The committed env var was always on 6543; the migration comment was corrected 2026-06-11 (now shows the 6543 pooler form + the alphanumeric-password warning).

**Resolves open Hermes-handoff escalations:** `DATABASE_URL_PROD_WRITER` confirmed on port 6543 in Vercel Production (was flagged as still 5432); the stray `hermes_test` prod row removed by the wipe.

**Revisit when:** the Vercel cron check completes (flip the cutover to fully GREEN and mark verification.md/roadmap accordingly); or if any prod-only divergence from staging surfaces.

---

## 2026-06-11 — profile_writer role: scoped RLS, not BYPASSRLS (migration 015)

**Decision:** Give `server/lib/inferProfile.js` its own dedicated least-privilege Postgres login role, `profile_writer` (migration 015), authorized via **column-scoped table GRANTs + RLS policies targeted `TO profile_writer` (USING/WITH CHECK `true`)** — **not** a `BYPASSRLS` role and **not** a `SECURITY DEFINER` RPC. The DB authorizes the *operation* (which tables/columns/verbs); the application authorizes the *row* via the message-derived trust boundary (decisions.md 2026-06-10). The role is created `NOLOGIN NOINHERIT`; an operator enables `LOGIN` + a strong password **out of band** (Supabase SQL editor) and stores it only in the Vercel env var `DATABASE_URL_PROFILE_WRITER` (never committed, never `VITE_`-prefixed).

**Context:** Inference writes were previously failing under RLS — the module only ever writes to *other* users' profile rows (your own messages skip translation), but the profile tables' RLS restricts writes to `user_id = auth.uid()`, so every write was denied. The module needs a connection whose authorization model fits "write to a row I derived myself from the message, not the row matching my auth identity." That forces a choice about *how* to grant it that power.

**Verified facts (web, 2026-06-11):**
- *Supabase now permits `BYPASSRLS` without superuser on PG 16+* (`ALTER ROLE <r> BYPASSRLS`), but it is **supautils-config- and version-dependent** and **coarse** — a BYPASSRLS role skips RLS on *every* table, so an app-code bug or SQL-injection on that connection has the whole schema exposed.
- *`SELECT … FOR UPDATE` requires UPDATE privilege on at least one column*, and a **column-level UPDATE grant satisfies it** — so the row-lock in `inferProfile` works fine with column-scoped (not whole-table) UPDATE.

**Alternatives considered:**
- *(A) BYPASSRLS role* — simplest, and now possible on Supabase PG16+. Rejected: coarse (skips RLS everywhere), and its availability is config/version-dependent, so it's a fragile thing to depend on. A leak on this connection would expose all tenants on all tables.
- *(C) `SECURITY DEFINER` RPC* — push the writes into a Postgres function owned by a privileged role, called over the normal authenticated connection. Rejected for now: moves non-trivial inference/guard logic (currently testable JS in `computeInferenceUpdates`) into PL/pgSQL, splitting the logic across two languages and making it harder to unit-test; the trust-boundary derivation already lives cleanly in the Node module.
- *(B) Scoped GRANTs + TO-role RLS policies* — **chosen.** Deny-by-default everywhere else: on any table without an explicit `TO profile_writer` policy, RLS still blocks the role even if a GRANT leaked in. The privilege surface is exactly the columns/verbs `inferProfile` uses and nothing more (`messages` SELECT 4 cols; `user_linguistic_profiles` SELECT whole-table + UPDATE 7 cols + `updated_at`; `user_profile_events` INSERT 6 cols). Role-targeted policies apply only when `current_user = profile_writer`, so anon/authenticated are unaffected.

**Implications:** Adds `profile_writer` to the role inventory; the inference Step-2 gate (#12) cannot run until the operator sets `LOGIN`+password out of band and populates `DATABASE_URL_PROFILE_WRITER` in staging Vercel. The migration carries no secret (NOLOGIN), so the committed file is safe. Prod replay sequence is 007→015 (015 is the tail). If a future writer needs a different column set, extend the GRANTs + allowlist in lockstep (`UPDATABLE_COLUMNS` in inferProfile.js ↔ the `grant update (…)` list ↔ migration 015). The deny-by-default posture means *adding* a table the role must touch requires both a GRANT and a `TO profile_writer` policy — a forced, visible decision rather than an accidental widening.

**Revisit when:** a second server-side writer role is needed (consider whether a shared pattern/helper is worth extracting); or Supabase stabilizes a documented, non-config-dependent BYPASSRLS path *and* we decide the coarseness is acceptable for a specific role (unlikely for anything touching tenant data); or the inference logic grows enough that a `SECURITY DEFINER` RPC's in-DB atomicity outweighs the two-language cost.

---

## 2026-06-11 — Forward-schema prep before prod cutover (migration 014)

**Decision:** Before wiping + rebuilding prod, fold four structural changes into a new `014_forward_schema_prep.sql` (staging-first, then part of the prod replay 007→015): **(1)** add `messages.conversation_id` — nullable, `DEFAULT` the global-conversation sentinel `00000000-0000-0000-0000-000000000002`, **no FK yet**; **(2)** drop the 7 vestigial `messages` columns; **(3)** convert four naive `timestamp` columns to `timestamptz`; **(4)** add the missing FK indexes. All `ALTER` (no recreate), idempotent.

**Context:** Prod is about to be wiped and replayed for the Phase 2 cutover. An empty prod is the single cheapest moment to bake in structure that would otherwise cost a destructive migration or a backfill once real traffic accumulates. Isaac asked for a forward-looking pass over the rest of the roadmap (Phase 3 conversations, Phase 4 corrections, Phase 6 API) plus common best-practice gaps.

**Findings from the review (what we are and aren't acting on now):**
- *`messages.conversation_id` is the one real landmine.* Phase 3 splits the single global room into per-conversation threads (`conversations`, `conversation_members`, `messages.conversation_id` FK). If messages accumulate in prod with no `conversation_id`, adding a `NOT NULL` FK later forces a backfill — the exact "add multi-tenancy when we need it" regret strategy.md §2 commits to avoiding. Pre-staging a defaulted nullable column now means Phase 3 just creates the table, inserts the `…0002` sentinel row, adds the FK, flips `NOT NULL`, and drops the default — **zero backfill**. Mirrors the `tenant_id` (`…0001`) pattern from 001. **Acting now.**
- *Vestigial `messages` columns are all accounted for elsewhere* — `room_id`/`context_id` → `conversation_id` + `conversation_contexts`; `translated_text` → `message_translations.translated_text`; `target_language` → `message_translations.language`; `tone` → `context_type` + `conversation_contexts.detected_register`; `model_version` → `translation_events.model_used`; `latency_ms` → `translation_events.latency_ms`. The per-translation telemetry that the Phase 6 API will bill on (`model_used`, `latency_ms`, `input_tokens`, `output_tokens`, `cost_cents`) **already exists** on `translation_events` (migration 005) at the right grain — no capture gap. **Dropping now** while prod is empty keeps both envs matched via the migration.
- *timestamptz standardization.* Mixed `timestamp` / `timestamptz` is a known footgun (cross-type comparisons misbehave; naive values have no offset). Empty prod is the only clean moment to standardize — once data exists you must *guess* the origin tz to convert. **Acting now**, interpreting existing naive values AS UTC (Supabase runs UTC). Note: `timestamptz` stores only the UTC instant; it does **not** retain the user's local zone (see parking-lot "Per-user IANA timezone").
- *FK indexes.* Postgres doesn't auto-index FK columns and every RLS predicate filters on them. **Acting now.**
- *Corrections/reviews tables (Phase 4)* are purely additive — safe to add later, no destructive risk. Isaac is fine missing early corrections (UI + collected fields will change), so **not** pre-building them.
- *API surface (Phase 6)* — API keys / RBAC / rate-limit / billing are all new additive tables; the two expensive-to-retrofit hooks (`tenant_id` everywhere, versioned `/api/v1/` routes) are already in place. **Nothing to do now.**
- *uuid v4 vs v7/ULID* — v4 random PKs fragment indexes at scale, but a PK-type change is a populated-table rewrite. Fine at current scale; **parked** to revisit at meaningful user/message volume (parking-lot.md).
- *conversation_contexts RLS* is still missing — flagged. Every table carries RLS from the cutover forward; this one ships its policy before it serves real traffic (no traffic until Phase 3, so deferred to Phase 3, tracked in roadmap.md + architecture.md §7).

**Alternatives considered:**
- *Add `conversation_id` later (backfill in Phase 3)* — rejected: that's precisely the destructive backfill this review exists to avoid, and it's free to pre-stage now.
- *Keep the vestigial columns for parity / future use* — rejected: all superseded (telemetry already on `translation_events`); the wipe is the natural moment to drop them, and the migration keeps staging + prod matched.
- *Defer timestamptz to "when it bites"* — rejected: it can't be cleanly fixed once data exists (origin-zone ambiguity).
- *Convert text+CHECK columns to real Postgres enums "for tidiness"* — rejected as a standing rule: altering a PG enum (dropping a value, adding mid-list) is painful; text+CHECK stays. Corrected the §7 specs for `conversation_contexts` + `tenants` that still said "enum" to match the live `text + CHECK` reality.

**Implications:** Prod replay sequence becomes 007→015 (014 forward-prep + 015 least-privilege profile-writer role; the role migration renumbered from 014). Phase 3 inherits a populated `conversation_id` and only needs the additive conversations tables + FK + NOT-NULL flip. Pre-flight before running 014: confirm `src/App.jsx` `.select('translated_text')` reads `message_translations`, not `messages` (verified 2026-06-11 — code refs resolve to the cache / `translation_events` / local vars).

**Revisit when:** Phase 3 lands (add `conversations`/`conversation_members`, FK, NOT NULL, drop the default, add conversation_contexts RLS); user/message volume becomes meaningful (reconsider ULID/uuid v7 for high-volume tables); or a concrete use appears for the user's local timezone (add the IANA column).

---

## 2026-06-11 — Step 7 data deletion / GDPR Right to Erasure

**Decision:** A **two-phase, 30-day grace** erasure. A user-facing `request_account_deletion(interval default '30 days')` RPC soft-deletes the account (`profiles.status='deactivated'`) and enqueues a row in a net-new `data_deletion_requests` table (status `pending`); `cancel_account_deletion()` reverses it within the window. A **second daily Vercel cron** (`/api/v1/jobs/deletion`, 09:00 UTC — an hour after abandonment so the two destructive jobs don't overlap) runs a Node sweep (`server/lib/deletion.js`) that picks up requests past `grace_until`, claims each (pending→processing), records an **abuse-monitoring HMAC** of the canonical email, then **hard-deletes** the `auth.users` row via the admin API. Content is **de-identified, not deleted**: the 007/008 FK topology CASCADE-deletes PII (profiles/identifiers/settings/ULP/events) while `messages.sender_id` is **ON DELETE SET NULL**, so message content survives with its author link severed. Migration 013. Triggered by an **on-demand RPC + cron processor** pattern.

**Context:** Step 7 of the Phase 2 spec — GDPR Article 17 Right to Erasure. We need a user-initiated path that reclaims PII on a defined timeline, survives accidental requests (grace window), leaves an audit trail, and — because Phase 2 treats the translation engine as a B2B product — generalizes to a future tenant/admin-initiated erasure.

**Sub-decisions surfaced and approved before building:**
- *Extra lifecycle columns on `data_deletion_requests`* (`status`, `requested_by`, `grace_until`, `completed_at`, `deleted_fields jsonb`, partial unique index for one-open-request-per-user) — over a minimal table — so the row is a real audit/operational record, not just a flag. Approved.
- *`data_deletion_requests.user_id` FK = ON DELETE SET NULL* (not CASCADE) — **load-bearing**: the audit row must survive the very deletion it records. CASCADE would erase the proof the erasure happened. Approved.
- *Reuse `email_hash_abuse` + `record_abandoned_email_hash` (shared pepper / key_version) for the voluntary-erasure HMAC* — no schema change, but it conflates two sources (abandonment vs. voluntary erasure) in one table. The **source-column split is parked** (parking-lot.md). Approved.

**Alternatives considered:**
- *Immediate hard-delete, no grace* — rejected: no protection against accidental or coerced deletion, and no cancellation path. 30-day grace is the GDPR-conventional balance.
- *Delete content rows too (not de-identify)* — rejected: per spec, message content is retained de-identified (sender severed) so conversations for the *other* party and the translation corpus aren't destroyed. The FK SET NULL on `messages.sender_id` already gives us this for free.
- *Trigger via a pure cron scan of `profiles.status` (no request table)* — rejected: loses the audit trail, the grace timer, the cancellation path, and the future admin/tenant-initiated entry point. The on-demand RPC + cron-processor split is the industry-standard, most future-facing pattern (Isaac's stated preference).
- *Don't record an HMAC on voluntary erasure* — rejected by Isaac: even voluntary deleters should feed the same weak abuse signal (delete-then-resignup correlation), so the pepper + key_version are shared with abandonment on purpose.

**Implications:** Adds a second daily destructive cron (`CRON_SECRET`-guarded, fail-closed). Shares the abandonment pepper — rotating one rotates both; the source-split parking-lot item must be resolved before the abuse signal can distinguish abandonment from erasure. `translation_corrections` isn't built yet, so "anonymize corrections" is a logged no-op (`corrected_anonymized:0`) until it exists. Prod replay of 013 rides the Phase 2 cutover (after the Step 7 gate is green).

**Revisit when:** `translation_corrections` ships (wire real anonymization into the snapshot); the source-split is resolved (separate abandonment vs. erasure HMAC sources); or an admin/tenant-initiated erasure path is built (extend `requested_by`).

---

## 2026-06-10 — Step 6 abandonment + abuse monitoring (sweep design)

**Decision:** A scheduled **Vercel cron** (`/api/v1/jobs/abandonment`, daily 08:00 UTC) runs a Node sweep that finds `profiles` rows still `status='pending'` and older than 30 days, **hard-deletes** the underlying `auth.users` row via the Supabase admin API (cascade removes profile/identifiers/settings), and — *before* deleting — records a versioned **HMAC-SHA256 hash of the canonical email** in `email_hash_abuse` (incrementing `abandon_count` on repeat). Two `SECURITY DEFINER` SQL helpers, granted to `service_role` only, back the sweep: `list_abandoned_pending_accounts(interval)` (encapsulates the "abandoned" definition) and `record_abandoned_email_hash(uuid, text, smallint)` (atomic insert-or-increment). Migration 012. Re-prompt emails (day 3 / day 14) are **parked** (see parking-lot.md).

**Context:** Step 6 of the Phase 2 spec (policies.md §6). Pending accounts that never complete onboarding hold a system-generated username and an email indefinitely; we need to reclaim handles and track repeat abandoners (a weak abuse signal) without storing plaintext emails of deleted users.

**Alternatives considered:**
- *Soft-delete / tombstone the profile* — keeps a row to "hold" the username and mark it abandoned. Rejected: Isaac confirmed the system username is never user-chosen or shared, so there's nothing to preserve; a hard delete is cleaner and the FK cascade does the work. (Revisit only if usernames ever become user-chosen.)
- *A dedicated `release_username` RPC* — planned originally, then eliminated: deleting `auth.users` cascades (007 FKs) through `profiles` → `account_identifiers`/`account_settings`, so the handle's rows simply vanish and reuse is unblocked. No release function needed; surfaced as a refinement rather than built silently.
- *Store plaintext email (or a plain unsalted SHA-256) for the abuse signal* — rejected. Plaintext re-introduces PII for users we just deleted; an unkeyed hash is trivially reversible by dictionary over the email space. We use HMAC with a **pepper that lives only in env (Vercel + gitignored `.env.rls-test`), never in Postgres**, with `key_version` for rotation.
- *Re-prompt emails server-side now* — parked. No sending domain set up (limited to ~2/hour), and lifecycle email belongs in a CRM, not the server. Captured in parking-lot.md with the day-3/day-14 cadence.
- *Supabase scheduled function (pg_cron) instead of Vercel cron* — would keep the job in-DB, but the sweep needs the admin API (delete auth users) and the pepper (compute HMAC in Node), neither of which belongs in Postgres. Vercel cron co-locates with the existing API layer and the secret.

**Reasoning:** Record-then-delete ordering guarantees we never lose the abuse signal if the delete fails mid-way (worst case: a hash with no delete, retried next run — idempotent via `ON CONFLICT`). Keeping the pepper out of the DB means a Postgres compromise can't reverse the hashes. The two helpers keep the "what counts as abandoned" rule and the atomic increment in SQL while the privileged actions (delete, HMAC) stay in the Node job. The sweep deletes **all** aged-pending accounts each run by design — there is no partial/batch cap, because volume is negligible pre-launch.

**Implications:** The cron handler fails closed if `CRON_SECRET` is unset and requires the `Authorization: Bearer $CRON_SECRET` header Vercel sends. Vercel Preview/Prod env must carry `ABANDONMENT_EMAIL_HASH_PEPPER` (same value as `.env.rls-test`), `ABANDONMENT_EMAIL_HASH_KEY_VERSION` (1), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`. Identity/config is injected into `runAbandonmentSweep()` so the gate and the handler share one code path. Rotating the pepper means **bumping `key_version`, not editing in place** (old hashes stay valid under their version). The helpers are service_role-only and don't use `auth.uid()` — they are explicitly *not* tenant-RLS user RPCs.

**Revisit when:** usernames become user-chosen/shareable (then soft-delete, not hard-delete); we stand up a CRM/sending domain (then unpark re-prompt emails); abandonment volume grows enough to need batching or a partial-progress cursor; or we want the abuse signal to feed an actual rate-limit/denylist (today it's only recorded).

**Gate result (2026-06-11):** `scripts/abandonment-gate-test.mjs` PASSED on staging — 19/19 GREEN. First run was 18/19; the single failure was a dry-run counter bug in `server/lib/abandonment.js` — `summary.deleted`/`summary.hashed` were incremented *outside* their `if (!dryRun)` guards, so a dry run skipped the real `deleteUser`/`record_abandoned_email_hash` calls (no data touched) but still counted them. Fixed by moving the increments inside the guard (`scanned` carries the would-sweep count); the gate's summary line was also made unambiguous. No behavior change to live sweeps, so no separate decision — recorded here for history. Prod replay of 012 pending the Phase 2 cutover (after Step 7).

## 2026-06-10 — Contact-graph representation: canonical ordered pair (not directional rows)

**Decision:** `relationships` stores **one row per unordered pair** — `account_lo`/`account_hi` with a CHECK `account_lo < account_hi`, plus `initiator_id` (whoever asked first) — rather than the directional `requester_id`/`addressee_id` design sketched in architecture.md §7. Unique `(tenant_id, account_lo, account_hi)`. Shipped in migration 011.

**Context:** Step 5 needs the contact graph to support request → accept/decline, a reverse-request "glare" case (both users add each other before either accepts), and blocks/reports composed on top. The §7 sketch used a directional single row. Before writing SQL we did a representation design pass; this deviates from a documented design, so it's logged as a decision rather than a silent change.

**Alternatives considered:**
- *Directional single row (`requester_id`, `addressee_id`), unique on the ordered pair* — the §7 sketch. Simple, but the glare race can insert **two** rows (A→B and B→A) that both mean "pending," and nothing structurally forbids it; you need app-level logic to detect and merge, and a uniqueness constraint on the *ordered* pair doesn't catch the reverse row. Rejected.
- *Two-row adjacency (one row per direction, kept in sync)* — natural for follow-graphs, but a mutual contact is two rows you must keep consistent; doubles the write surface and the RLS surface for no benefit in a symmetric-relationship model. Rejected.
- *Canonical ordered pair (chosen)* — one row, uniqueness on `(tenant_id, lo, hi)` makes "one relationship per pair" **structural**; the glare race collapses because both adds resolve to the same row (reverse-pending auto-accepts). Direction is preserved by `initiator_id`.

**Reasoning:** Makes the core invariant a database guarantee instead of application discipline; eliminates the glare race by construction; keeps direction available (for the DM-initiation "initiator's handle type" rule and incoming-vs-outgoing UI) via `initiator_id` + a CHECK that the initiator is one of the pair. Costs a `least()/greatest()` at the call site (hidden inside the RPCs) and a second index for hi-side lookups.

**Implications:** Writes go only through `request_contact` / `respond_to_contact` / `redeem_invite` (they compute the canonical order); a raw client can't insert (RLS SELECT-only). "All of X's contacts" is `WHERE account_lo = X OR account_hi = X` — covered by the unique index (lo) + `relationships_hi_idx` (hi). architecture.md §7 updated to match. Any future asymmetric relationship type (follow/subscribe) would NOT fit this table and should be modeled separately.

**Revisit when:** we need a directional/asymmetric relationship (follower model), or contact volume makes the OR-query a measured hotspot (then consider a generated-column or materialized adjacency).

## 2026-06-10 — Block is an override layer; symmetric hide; discovery RPCs amended

**Decision:** A block never mutates the `relationships` row — it's a separate `blocks` row that overrides at query time. Hiding is **symmetric**: an active block in *either* direction removes each user from the other's discovery results and gates every initiation path. `unblocked_at` (nullable, null=active) preserves history. Migration 011 also `CREATE OR REPLACE`-amends the two Step 4 discovery RPCs (010) to add `AND NOT active_block_exists(caller, target)`.

**Context:** Blocking an existing contact must not destroy the relationship state (so unblock restores it with no resurrection logic), and a blocked user must not be able to re-find or re-add the blocker. The Step 4 discovery RPCs predate `blocks` and currently return blocked users.

**Alternatives considered:**
- *Block mutates `relationships` (set state='blocked')* — conflates two axes (are-we-contacts vs is-there-a-block) into one column; unblocking would need to remember the prior state. Rejected.
- *Directional hide only (blocked can still see blocker)* — leaks the blocker back into the blocked user's search and lets them re-initiate. Rejected; symmetric hide is the safer default. (`unblocked_at` is retained even though symmetric hide reduces its immediate need — keeps the door open for a future "blocks you've placed" management UI.)
- *Symmetric override layer (chosen).*

**Reasoning:** Override-layer keeps the two concerns orthogonal and makes unblock trivial (stamp `unblocked_at`). `active_block_exists()` is a single `SECURITY DEFINER` helper (bidirectional, tenant-scoped) reused by both discovery RPCs and all three initiation RPCs, so the rule lives in one place. Blocker-only RLS on `blocks` keeps the raw fact private from the blocked party.

**Implications:** Amending shipped functions is a behavior change → the **Step 4 gate must be re-run** after 011, in addition to the new Step 5 gate. Block privacy is asymmetric by design (blocker sees the row, blocked does not). Rate-limiting block/unblock cycles is parked.

**Revisit when:** a verification/trust feature changes who can see what; or product wants a one-directional "mute" distinct from a symmetric "block."

## 2026-06-10 — Invite redemption auto-accepts the contact

**Decision:** Redeeming a `contact` invite writes the `relationships` row **directly at `state='accepted'`** (`via_identifier_type='invite_link'`, `initiator_id = creator`), with no separate accept handshake. Block-checked first; one redemption per user per invite.

**Context:** Step 5 introduces invite links. The question was whether redeeming creates a *pending request* the creator must then accept, or an accepted contact outright.

**Alternatives considered:**
- *Redeem → pending (creator must accept)* — symmetric with the email/username add flow, but the creator already consented by minting and sharing the link; making them re-accept every click is friction with no safety gain (the link is the consent). Rejected.
- *Redeem → accepted (chosen)* — minting the link is the creator's consent, clicking is the redeemer's; mutual by construction.

**Reasoning:** The trust model differs from search-based adds: an invite link is an explicit "add me" issued by the creator. Auto-accept matches user expectation (clicking an invite link should just connect you) while blocks + revocation + expiry + max-uses remain the safety levers.

**Implications:** `redeem_invite` is the only RPC that writes `via_identifier_type='invite_link'` and that sets `initiator_id` to someone other than the caller. Revoked/expired/over-max-uses/cross-tenant/own-invite redemptions are all rejected before any write. `conversation`-kind invites are Phase 3 (rejected for now).

**Revisit when:** invite-link spam becomes a vector (then consider redeem→pending for unverified creators, or rate limits on redemptions).

## 2026-06-10 — `email_hash_abuse`: versioned HMAC computed in the job layer

**Decision:** The abandoned-signup abuse monitor stores `HMAC-SHA256(canonical_email, pepper)` as `bytea` plus a `key_version smallint`. The HMAC is computed in the **Step 6 abandonment job** (Node `crypto`); the pepper lives in an env secret and **never enters Postgres**. Migration 011 creates the table + RLS (service-role-only); the writes wire in Step 6.

**Context:** policies.md §6 requires detecting repeat-abandon / signup-spam without retaining deleted-user PII. Isaac asked how hard later key rotation / key loss would be, and what's standard.

**Alternatives considered:**
- *Plaintext email* — simplest correlation, but retains PII of deleted users (defeats the GDPR-clean purpose). Rejected.
- *Unkeyed hash (SHA-256 of the email)* — emails are low-entropy and enumerable, so a plain hash is reversible by dictionary; not meaningfully de-identifying. Rejected.
- *Keyed HMAC computed **in Postgres** (pgcrypto, pepper in a DB setting)* — puts the pepper in the DB, so a DB compromise exposes it. Rejected.
- *Keyed HMAC computed in the job layer, pepper in env, `key_version` column (chosen)* — industry-standard for de-identified-but-correlatable tokens; pepper never touches the DB.

**Reasoning:** Keyed HMAC defeats dictionary reversal; computing it outside the DB means even a full DB dump doesn't leak the key. `key_version` makes rotation a non-event (bump the version, key forward; old rows stay readable within their version). Key **loss** is low-stakes here specifically because the table is advisory-only — nothing joins on it, so the worst case is the spam-correlation window resets. (This is *not* true of any future table where the hash is a join key — there, loss would orphan rows.)

**Implications:** Step 6 must read the pepper from env and tag each write with the current `key_version`; deploy/rotation runbooks own the pepper. Until Step 6, the table is empty and inert. RLS is enabled with no client policy **and** `REVOKE ALL FROM anon, authenticated` (belt-and-suspenders, service-role only).

**Revisit when:** Step 6 builds the job (pick the initial pepper + storage); or a future feature wants to join on the hash (then key-loss stops being low-stakes — reassess).

## 2026-06-10 — Phase 2 Step 4 discovery: search-only scope, SECURITY DEFINER RPCs, email-match returns username

**Decision:** Step 4 (Discovery) is **search-only** and ships as migration 010 — three `SECURITY DEFINER` RPCs (`find_account_by_email`, `search_accounts_by_username`, `change_username`) plus a prefix index — with **no table or column changes**. The *add* action (which writes a `relationships` row) is deferred to **Step 5**, where `blocks` exists to gate it. On an exact email match the discovery RPC returns the found user's **username** in addition to `id` + `display_name`.

**Context:** The roadmap listed "exact-match add by email/username" under Step 4, but an add writes `relationships`, which doesn't exist until Step 5. And `account_identifiers` SELECT is own-rows-only (007), so cross-user discovery can't be a client query — it has to be a definer-rights function. Both the scope seam and the RPC return shape needed an explicit call before building.

**Alternatives considered:**
- *Pull `relationships` forward into Step 4* so the add works now — rejected: ships an add path that can't honor blocks (Step 5), and bloats an otherwise table-free migration.
- *Return `id` + `display_name` only on email match (strict handle minimization)* — cleaner privacy literalism, but the username is already a public, searchable handle, so hiding it on the email path buys no real privacy while making the add UI less recognizable. Rejected.
- *Views instead of RPCs* — can't express handle minimization (a view would expose other identifier rows) and can't safely bypass RLS with per-call logic. Rejected.

**Reasoning:** Keeping Step 4 search-only preserves the gate-before-advance discipline (autocomplete with no way to act on a blocked user is acceptable; an add with no block check is not). Definer-rights RPCs are the intended mechanism (007 explicitly deferred discovery to them). Returning the username on email match treats "minimization" as "never expose a handle the adder *didn't* use" — email/phone/friend_code and retired usernames stay hidden; the one public handle (username) is shown.

**Implications:**
- Migration 010 is additive only → no ALTER-vs-recreate risk; idempotent; safe to replay on prod after the staging gate.
- All three RPCs return exactly `(account_id, display_name, username)`; never email/phone/other or retired handles. Discovery surfaces only `status='active'` profiles and respects `account_settings` discoverability. Anti-enumeration: email is exact-equality only; username prefix has min length 3, cap 20, escaped LIKE.
- `change_username` is the sole username-change path (profiles.username is REVOKEd from `authenticated`); it enforces charset/length/reserved/non-reuse and the 1/365-day cadence (first system→user change free), retiring the old identifier row rather than deleting it.
- Reserved-word seeding was already done for the sole tenant in 007 — 010 only enforces against it. Per-tenant seed automation stays parked until tenant #2.
- **Known limitation (resolved by Step 5):** username autocomplete cannot filter blocked users until `blocks` ships.

**Revisit when:** Step 5 adds the add/block path (autocomplete should then filter blocks); discovery rate limits are built; or a second tenant forces per-tenant reserved seeding.

---

## 2026-06-10 — Restore `nonbinary` to `gender_signal` (migration 009), don't ratify the 008 drop

**Decision:** Re-add `nonbinary` to the `user_linguistic_profiles.gender_signal` CHECK via migration `009_restore_nonbinary_gender_signal.sql`, rather than accept its removal.

**Context:** A 2026-06-10 docs audit (reconciling architecture.md against shipped migrations) found that migration 008, when it recreated `user_linguistic_profiles` during the identity cutover, wrote a CHECK of `('masculine','feminine','neutral','unknown')` — dropping `nonbinary`, which migration 003 had deliberately added (decisions.md 2026-05-12). On staging, any `gender_signal='nonbinary'` write now violates the CHECK.

**Alternatives considered:** (1) **Ratify the drop** — treat 008 as an intentional simplification, update 003's note + architecture.md + this log to say `nonbinary` is not stored. Rejected: the 003 decision had concrete, still-valid reasoning (it's a translation-quality signal — it tells the model to use gender-inclusive target-language forms; conflating it with `neutral`, a source-language property, produces worse output). Nothing about that changed; the drop was an oversight in the 008 rewrite, not a reconsidered call. (2) **Restore via a small migration.** Chosen.

**Reasoning:** Restoring realigns the schema with an existing, deliberate decision and with the prompt logic in `lib/translatePrompt.js` (which already distinguishes the two). The fix is a widening-only CHECK swap — it cannot fail on existing rows, and staging's `ulp` is empty anyway. Cheapest to settle now, while still staging-only, before 008's CHECK ships to prod in the cutover.

**Implications:** `009` must run on staging (and replay on prod as part of / before the Phase 2 cutover) or prod will inherit the regression. Reinforces a process point: table *recreates* (vs. ALTERs) silently drop constraints/defaults/grants unless each is carried forward — worth a checklist item for any future recreate.

**Revisit when:** Measured model quality on `nonbinary` forms is poor enough that we'd rather not store/act on the signal — at which point removal would be a real decision, made on purpose.

## 2026-06-10 — Phase 2 Step 3 RLS gate is a checked-in adversarial script + a throwaway tenant

**Decision:** Build the Step 3 RLS gate as a committed, re-runnable Node harness (`scripts/rls-adversarial-test.mjs`) that authenticates as real users and asserts RLS behavior by *denial shape*, and provision a real **second tenant** (`...002`) + a user C in it so cross-tenant isolation is actually testable.

**Context:** Step 3 is the Phase 2 hard stop: prove one user can't read/write another's data, and tenant scoping holds. Two design questions had to be settled. (1) *How to run it* — browser-console snippets vs. a checked-in script. (2) *How to test tenant scoping at all* — the live DB has exactly one tenant, so cross-tenant policies (`auth_tenant_id()`-based) are unexercised by construction.

**Alternatives considered:** (1) Console snippets — fast to write, but not re-runnable, not version-controlled, and RLS regressions are *silent* (a too-broad policy just returns more rows), so a one-off check rots immediately. Rejected. (2) Stay single-tenant and skip cross-tenant assertions — would leave the most important Phase 2 isolation guarantee untested. Rejected. **Chosen:** checked-in script + throwaway tenant 2/user C, set up idempotently by the script via service-role (fixture only — assertions use real user JWTs, since service-role bypasses RLS).

**Reasoning:** The script is the tripwire that survives future migrations touching these tables; it encodes the non-obvious denial shapes (blocked SELECT → empty/no-error; column-grant write → error; WITH-CHECK insert → error) so we don't re-derive them each time. It also bakes in the migration 007 OPUS-FIX #2 self-write escalation test (PATCH own `is_verified`/`status`/`username` → denied), which RLS-alone (row scoping) would miss. A real second tenant is the only honest way to test tenant scoping.

**Implications:** `scripts/rls-adversarial-test.mjs` + `.env.rls-test.example` are committed; `.env.rls-test` stays gitignored (added a `!.env.rls-test.example` negation so the example is tracked). The script mutates the DB, so it's interlocked behind `RLS_TEST_CONFIRM_STAGING=yes` and must never be pointed at prod. Staging needs the Email/Password auth provider enabled for `signInWithPassword`. Re-run this gate after any migration that adds/edits RLS policies or grants on Phase 2 tables.

**Revisit when:** We move to automated CI (the script becomes a CI job, not a manual run), add tables with their own RLS, or change the tenancy model (more than the current shared-tenant-1 default).

## 2026-06-10 — Process: branch before touching `main` so staging verification comes first

**Decision:** For any change that needs a staging gate before prod, create the feature/verify branch **first** and push *that* to get a Vercel Preview deploy — never push the work to `main` and then try to verify, because `main` deploys straight to Production.

**Context:** Verifying server-side profile inference, we pushed the code to `main` (which Vercel deploys to **Production** → prod Supabase, where `DATABASE_URL_PROFILE_WRITER` is intentionally unset, so inference no-ops). All test data lived in **staging**. Code and data never met, so the gate appeared to fail. Compounding it: a Preview build needs a unique commit SHA — a branch pointing at the same SHA as `main` (`verify-inference == main == 0bf364e`) produced no new Preview because Vercel dedups by SHA and GitHub showed "no differences." We had to push an empty commit to force a unique hash and get the Preview to build.

**Alternatives considered:** (1) Keep pushing to `main` and verify in Production — unsafe; that's verifying live, and it's why the gate was confusing here. (2) Branch-first, Preview-deploys-to-staging, verify, then merge to `main`/Production. **Chosen.**

**Reasoning:** Vercel's model is fixed: `main` → Production, any other branch → Preview (staging env vars). The only way to get code onto staging is a non-`main` branch with its own SHA. Branching first makes the staging-before-prod rule automatic instead of something we reconstruct after a confusing failure.

**Implications:** Standard flow for gated changes is now: branch → push → Preview build on staging → run the gate → merge to `main` only after it passes. If a verify branch ever shares a SHA with `main`, force a unique commit (an empty commit is fine) so Vercel builds a Preview. Throwaway verify branches + empty commits get deleted after merge.

**Revisit when:** We change hosting/CI off Vercel's branch-based Preview/Production split, or introduce a dedicated long-lived `staging` branch/environment that changes how deploys map to environments.

---

## 2026-06-10 — Server-side profile inference (Option A): dedicated endpoint, message_id trust boundary, raw pg + FOR UPDATE

**Decision:** Move profile inference off the client into a dedicated `POST /api/v1/infer-profile` endpoint (Option A). The client sends `message_id` (not a sender id); the server derives the authoritative sender from the message row. The write runs through a raw `pg` client over a privileged connection (`DATABASE_URL_PROFILE_WRITER`) in a `SELECT … FOR UPDATE` transaction. Inference flag renamed `CLIENT_SIDE_INFERENCE_ENABLED` → `PROFILE_INFERENCE_ENABLED` and flipped on.

**Context:** Migration 008 put RLS on `user_linguistic_profiles` / `user_profile_events` restricting writes to `user_id = auth.uid()`. But `applyInferences` only ever ran for *other* users' messages (your own skip translation), so every client write was RLS-denied — inference was 100% dead (`CLIENT_SIDE_INFERENCE_ENABLED = false`). The linguistic-profile half of the Phase 1 data flywheel wasn't turning. Two pre-existing problems also needed fixing: a multi-viewer write race, and the dialect guard trusting a client-supplied language anchor.

**Alternatives considered:**
- *Architecture:* (A) dedicated endpoint + privileged client — keeps the translation layer clean for the B2B story, relocates the JS logic without rewriting it, fixes the race by moving read+write server-side. **Chosen.** (B) fold inference into the translate path — couples chat and translation layers. (C) Postgres trigger/RPC doing inference — buries logic in SQL.
- *Trust boundary:* (1) client sends `message_id`, server derives sender/tenant/source_language — closes profile-spoofing, cheap, still trusts the `inferences` payload (low-stakes). **Chosen.** (2) full server-side re-inference — fully closes it but drifts into Option B and doubles LLM cost. (3) accept client-sent sender id — testing-only hole.
- *Locking mechanism:* (A) raw `pg` client mirroring `events.js`, JS guard logic verbatim, native `SELECT … FOR UPDATE`. **Chosen.** (B) Supabase service-role JS client + SECURITY DEFINER plpgsql RPC — uses the existing service-role key (no new credential) but rewrites the guard logic into SQL (a maintenance fork).

**Reasoning:** Option A + message_id + raw pg is the combination that satisfies every stated goal at once: layer separation (clean translate path), relocate-not-rewrite (the guard logic moved into `server/lib/inferProfile.js` essentially verbatim), spoofing closed (authoritative identity from the message row), and the race fixed natively (`FOR UPDATE` serialises concurrent inferences for the same sender). Note the spec said "service-role *Supabase* client (lazy-init like events.js)" — but `events.js` is raw `pg`, not a Supabase client, and the Supabase JS/PostgREST client cannot express explicit transactions or row locks, so step 5 (`FOR UPDATE`) forced the raw-pg reading of that instruction. The credential is therefore a Postgres connection string, not `SUPABASE_SERVICE_ROLE_KEY`.

**Implications:**
- New privileged credential `DATABASE_URL_PROFILE_WRITER` (server-only, never `VITE_`). ~~On staging it reuses the superuser URL~~ **Superseded 2026-06-11:** the least-privilege `profile_writer` role shipped as migration 015 (scoped GRANTs + `TO profile_writer` RLS, not BYPASSRLS — see decisions.md 2026-06-11) and is now live on staging Preview (port 6543), re-gated GREEN. Prod gets the same role via the 007→015 replay before prod deploy.
- The endpoint must `await` its transaction before responding (Vercel freezes the function at `res.json()` — same lesson as Spec 4b's event-log fire-and-forget bug). The *client* fires-and-forgets; the *server* awaits.
- Resolves the parking-lot "dialect consistency guard uses stored `source_language`" sibling item: the guard now anchors on the authoritative server-read `source_language`, falling back to the live translate-time `detected_language` only when the stored code is missing/`unknown` (fixes both the legacy-`unknown` and wrong-original-detect edge cases).
- The `inferences` payload is still trusted (option 1, not 2). A forged inference can write a plausible-but-false dialect/register/gender to a real sender's profile. Low-stakes at single tenant; revisit if multi-tenant or if profile integrity becomes a felt problem (parking-lot "Phase 2 RLS / validation gaps" #1 is the cache-side sibling of this).

**Revisit when:** (a) First real multi-tenant move — re-evaluate trust option 2 (server-side re-inference) and provision per-tenant least-privilege writer roles. (b) Prod deploy — run migration 015 (the `profile_writer` role) in the 007→015 replay + set the Production env var on port 6543, do not ship the superuser URL to prod. (Staging done 2026-06-11.) (c) If inference logic starts changing often, reconsider whether option B (logic in a versioned migration/RPC) is worth the rewrite for DB-native atomicity.

---

## 2026-06-10 — Migration 008: coordinated breaking cutover for Step 2 identity promotion

**Decision:** Deliver all text→uuid identity promotions, `user_profiles` drop, and RLS enablement on `messages` / `message_translations` / `user_linguistic_profiles` / `user_profile_events` in a single migration (008) that ships together with the App.jsx rewrite.

**Context:** Phase 1 stored `sender_id` as a plain text username string and `user_id` in linguistic profile tables as text. Phase 2 needs real auth identities (uuid from `auth.users`). Multiple tables needed coordinated changes, and the old App.jsx couldn't coexist with the new schema (sender_id type mismatch would break inserts).

**Alternatives considered:** (A) Spread the cutover across multiple migrations with a compatibility shim — adds complexity and a window where the schema is half-migrated. (B) Single migration + deploy both together on wiped staging — clean and safe since there's no production data to migrate. **Chosen.**

**Reasoning:** Staging was wiped at Phase 2 start. With no rows to transform, the text→uuid promotion is a one-line ALTER. The risk of a partial cutover (old app + new schema) outweighs the simplicity of splitting. Shipping migration + app together is standard practice for breaking schema changes.

**Implications:** Migration 008 and the new App.jsx must be deployed atomically. Running 008 without the new frontend (or vice versa) breaks the app. Document this in the deployment notes.

**Revisit when:** If we ever need to do this cutover in prod with real data, we'd need a proper data migration that casts existing text sender_ids to uuids (requires a lookup table or backfill).

---

## 2026-06-10 — complete_onboarding() as SECURITY DEFINER RPC for P1→P3 transition

**Decision:** Implement the P1→P3 status transition (pending → active) as a SECURITY DEFINER PostgreSQL function called via `supabase.rpc()`, rather than a direct UPDATE from the client.

**Context:** Migration 007 [OPUS-FIX #2] added column-level GRANTs that restrict `authenticated` users to updating only `profiles.display_name` directly. `status`, `username`, `is_verified` are intentionally blocked to prevent privilege escalation. The onboarding flow must set `status='active'` and create the `user_linguistic_profiles` row — neither of which the client can do directly.

**Alternatives considered:** (A) Relax the column grants temporarily during onboarding — defeats the security model. (B) Server-side API endpoint (`POST /api/v1/onboarding`) — adds a new API route and auth token forwarding complexity for a one-time operation. (C) SECURITY DEFINER RPC in Postgres — runs in the DB with elevated privileges, callable via `supabase.rpc()` without an extra HTTP hop. **Chosen.**

**Reasoning:** Keeps the privilege escalation guard intact. The RPC is the canonical path for controlled status transitions — consistent with how username changes and verification will work (Steps 4+). Validation (display_name length, non-empty language) lives in the function body close to the write.

**Implications:** Any future status transition (active → deactivated, username change) should also be a SECURITY DEFINER RPC, not a direct UPDATE. The `GRANT EXECUTE ... TO authenticated` is required for PostgREST to expose it via `supabase.rpc()`.

**Revisit when:** Server-side inference migration (parking-lot.md) may consolidate some DB writes into API endpoints — revisit whether some RPCs should move there.

---

## 2026-06-09 — Scaffold lib/policies.js as machine mirror of policies.md

**Decision:** Create `lib/policies.js` at Phase 2 Step 0 as the single machine-readable source of truth for global policy defaults. All enforcement code reads from this module. Per-tenant overrides remain in `tenants.dm_initiation_policy` (jsonb).

**Context:** Phase 2 adds username enforcement, DM-initiation gating, discovery rules, and account lifecycle logic. Without a single module, policy values would be scattered across enforcement code, creating drift risk between the human doc (policies.md) and what the code actually does.

**Alternatives considered:** (A) Inline constants in each enforcement function — values drift immediately. (B) Store all defaults in the DB alongside tenant overrides — over-engineered; global defaults don't need DB writes. (C) Single `lib/policies.js` mirroring policies.md. **Chosen.**

**Reasoning:** Matches the existing `lib/translatePrompt.js` pattern. ES module imports work in both Vercel serverless and Express. One place to update when policy values change; grep-able for every call site.

**Implications:** `lib/policies.js` must be updated in the same commit as any material change to `policies.md`. The `resolve()` and `isPermitted()` helpers on `DM_INITIATION` are the canonical enforcement path — don't duplicate logic elsewhere.

**Revisit when:** Policy complexity grows to the point where a dedicated policy engine (e.g., OPA) is warranted, or per-tenant overrides need richer evaluation than a simple jsonb merge.

---

## 2026-06-09 — New doc: phase2-implementation.md (build-order spec + Sonnet prompt)

**Decision:** Add `docs/phase2-implementation.md` holding the Phase 2 plan of attack (dependency-ordered build steps with a test gate between each) and a paste-ready prompt for the Sonnet session that implements it.

**Context:** Phase 2 design is done and spread across policies.md, architecture.md §7/§10, roadmap.md, and the 2026-06-09 decisions entries. Implementation runs Sonnet against an Opus-authored plan; we wanted one version-controlled artifact that Sonnet can read directly, pointing at all the supporting docs, rather than re-deriving sequencing or pasting an ephemeral prompt each session.

**Alternatives considered:** (A) Keep the plan + prompt in chat only — not version-controlled, lost between sessions. (B) Fold it into roadmap.md — roadmap is the *what/priority*, not the *how-to-execute*; mixing them bloats it. (C) A dedicated implementation spec doc. **Chosen.**

**Reasoning:** Separates "what we decided" (the existing docs) from "how Sonnet executes it" (this file). Keeps the model split explicit: Opus owns the plan and three flagged hard sub-tasks (text→uuid cutover + auth trigger, RLS correctness, DM-initiation logic); Sonnet executes the rest.

**Implications:** One more doc to keep current as Phase 2 lands — update or retire it as steps complete. When Phase 2 is done it can be archived or collapsed into a "how Phase 2 was built" note.

**Revisit when:** Phase 2 is complete (archive/retire), or the build order materially changes (update the file + note it here).

---

## 2026-06-09 — Identity vs. discovery: stable uuid + normalized account_identifiers (Model A)

**Decision:** A user's stable identity is the `auth.users` uuid, mirrored 1:1 into a `public.profiles` table (`profiles.id = auth.users.id`, FK, on delete cascade). All app tables FK to `profiles.id`; all RLS uses `auth.uid()`. Human-facing "discovery handles" (email, username, and later phone / friend_code) live in a separate normalized `account_identifiers` table that points at `profiles.id`. A discovery handle is never a primary key or FK target. We adopt **Model A — one tenant per user** (a profile row carries a single `tenant_id`).

**Context:** Phase 2 establishes auth and migrates `user_id`/`sender_id` from text to uuid. Phase 3 adds DMs/groups and a contact graph. We need to future-proof how users find and add each other without Phase 2's identity work creating friction for Phase 3.

**Alternatives considered:**
- *Handles as columns on the profile* — simpler, but adding phone/friend_code later means migrations, and you can't hold multiple values per type.
- *Email or phone as the identity key (WhatsApp/Signal model)* — zero-friction discovery, but the key becomes unchangeable, leaks via enumeration, and can't carry multiple handle types.
- *Stable uuid + normalized identifiers (iMessage "handles" model)* — more join complexity now, zero migration churn later. **Chosen.**
- *Model B — one human, many tenant memberships (Slack model)* — a `memberships` table with profile split into global identity + per-tenant profile. More flexible, more complex. **Not chosen** — our B2B future treats tenants as API customers, not workspaces a single end-user joins many of.

**Reasoning:** The uuid never changes, is never shown to users, and is never a discovery handle — eliminating the entire class of "we keyed off a mutable handle" migrations (Discord's username#discriminator unwind is the cautionary case). Model A is correct for a consumer app where the app *is* the tenant.

**Implications:**
- New Phase 2 tables: `profiles`, `account_identifiers`, `account_settings`. (Social-graph tables in a separate entry.)
- `profiles` carries `is_verified` (default false; placeholder until a verification feature exists) and `verification_method` (nullable; how a user was verified — may become enum/array once methods are known).
- Identifier rows are never hard-deleted (supports username non-reuse).
- **Uniqueness matrix** — global (across tenants): `profiles.id` (uuid), `tenant_id`, invite `token`. Within tenant: `username`. Not unique anywhere: `display_name`.

**Concerns to carry (Model A trade-offs, accepted for now):**
- **Multi-tenant email uniqueness.** Supabase Auth enforces one `auth.users` row per email *per project* (global), not per tenant. Single-tenant today, so a non-issue. For multi-tenant, the same email existing in two tenants would require a Supabase-project-per-tenant or a custom identity mapping. Unsolved by design.
- **Model A is a one-way-ish door.** Moving to Model B later is a migration (introduce `memberships`, possibly split profile). We keep B reachable by ensuring every social/discovery table carries its *own* `tenant_id` (not inherited via the profile) and invites are tenant-scoped — so a `memberships` table could slot in without re-tenanting every row.

**Revisit when:** We onboard tenant #2 (forces both the email-uniqueness decision and the Model A vs B call), or join complexity from the normalized identifiers table measurably hurts read performance.

---

## 2026-06-09 — Username policy: unique within tenant, non-reusable, one change per year

**Decision:** Usernames are ASCII alphanumeric + underscore (`[a-z0-9_]`), case-insensitive-unique **within a tenant**, non-reusable even after a user changes theirs, and changeable at most once per year. Every user gets a random `system_generated` username at signup; the first change to a user-chosen value is free and does not start the yearly clock. Display names are alphanumeric + space + hyphen + apostrophe, not unique. Detailed values live in `docs/policies.md`.

**Context:** Usernames need to be a stable, real-feeling handle. Reuse, squatting, and impersonation are all expensive to fix retroactively.

**Alternatives considered:** (A) Reusable usernames freed on change — enables impersonation of the prior holder and breaks cached references. (B) No usernames at launch — but Phase 3 assumes "invite by username," and bolting uniqueness on later is a painful migration. (C) Unique-within-tenant + non-reusable + rate-limited changes. **Chosen.**

**Reasoning:** Non-reuse + ASCII-only charset + a reserved-word list together close the common impersonation and homoglyph vectors (ASCII-only kills Cyrillic-lookalike attacks). The 1/year limit (noted in UI even before it's enforced) discourages churn. System-generated-first keeps usernames non-load-bearing, so we can de-emphasize or drop them with no data risk.

**Implications:**
- `profiles.username`, `username_source` (`system_generated | user_set`), `username_last_changed_at`.
- Retired usernames stay locked via non-deleted `account_identifiers` rows (status `retired`).
- Policy *values* (charset, reserved words, change cadence) live in `policies.md` + `lib/policies.js`; changeable without a schema change.
- A future timed-release / contact-the-holder reclaim mechanism is parked.

**Revisit when:** Username squatting becomes a real problem, or we build the reclaim mechanism.

---

## 2026-06-09 — Social-graph primitives built in Phase 2 (schema), DM policy deferred

**Decision:** Phase 2 builds the schema and safety primitives even though DMs/groups are Phase 3: `relationships` (contacts, with provenance), `blocks`, `reports`, `invites` + `invite_redemptions`. DM-initiation is gated by a swappable **tenant-level** policy enforced in the application layer. The sole tenant launches with **no special permissions**, so DMs require **mutual acceptance** (Snapchat model). Conversations remain independent of the contact graph.

**Context:** Phase 2 is titled "Multi-user safety." Blocking and reporting are safety primitives that should exist before the app is shared. We want to avoid fully-open DMs but keep the option to grant non-mutual DMs based on discovery handle + (future) verification, without locking policy into schema.

**Alternatives considered:** (A) Defer all social tables to Phase 3 — ships the "safety" phase without block/report, and forces provenance to be backfilled (impossible — it's only knowable at add-time). (B) Hard-code DM gating into schema constraints — unswappable. (C) Build schema + provenance now, keep gate logic in the app layer + tenant config. **Chosen.**

**Reasoning:** Provenance (`via_identifier_type`) is only knowable when a connection is made, so the column must exist in Phase 2 even if the policy reading it is decided later. Keeping the gate in the app layer makes the policy a config change, not a migration.

**Implications:**
- `relationships.via_identifier_type`: email / username / phone / friend_code / invite_link.
- `tenants.dm_initiation_policy` (jsonb) holds per-tenant overrides; sole tenant = `{}` → mutual-acceptance-only. Global defaults live in `lib/policies.js`.
- **Conflict-resolution rule (confirmed):** mutually-accepted contacts can always DM each other; otherwise non-mutual DMs are allowed only where a tenant override permits the initiator's handle type.
- "Allow if verified" tiers are inert until a verification feature exists (`is_verified` defaults false).
- `blocks.unblocked_at` (nullable; null = active) preserves block/unblock history; partial unique index `(blocker_id, blocked_id) WHERE unblocked_at IS NULL` prevents double-blocking.
- `reports` initially just records + auto-creates a block; no moderation queue UI yet.

**Revisit when:** Verification ships (activates verified tiers), or spam volume forces revisiting the handle→DM matrix.

---

## 2026-06-09 — New doc: policies.md (trust & safety / identity governance)

**Decision:** Add `docs/policies.md` as a living, periodically-audited doc holding username policy, discoverability & DM-initiation policy, blocking/reporting policy, and account-lifecycle rules. The machine-readable global defaults live in a single `lib/policies.js` module; per-tenant overrides live in DB (`tenants.dm_initiation_policy`).

**Context:** These are governance rules (values, blocklists, cadences), not technical system design (architecture.md) or cost/workflow (operations.md). They need continual updating and auditing against best practice.

**Alternatives considered:** (A) Fold into architecture.md — mixes mutable policy values with stable system design. (B) decisions.md only — append-only point-in-time records, wrong shape for a living policy. (C) Dedicated policies.md + `lib/policies.js`. **Chosen.**

**Reasoning:** A focused doc with an audit cadence keeps policy values in one auditable place; a single code module keeps enforcement reading from one source. Matches the 2026-05-12 doc-structure precedent.

**Implications:** policies.md is referenced from architecture.md §7/§10 and roadmap Phase 2. operations.md gets a one-line pointer to its review cadence. Schema enforces *mechanism*; policies.md + `lib/policies.js` own the *values*.

**Revisit when:** policies.md grows past ~800 lines (split it) or a vertical needs its own policy doc.

---

## 2026-06-09 — Onboarding: explicit display name + system-generated username + pending-signup lifecycle

**Decision:** Signup is a four-stage lifecycle. **(P1)** User submits email and clicks Sign up → magic link sent; `auth.users` row (uuid) is created immediately, and a DB trigger on that insert creates a `profiles` row with `status='pending'`, a random `system_generated` username, and the email identifier. **(P2)** User clicks the link, authenticates, lands on the onboarding screen (display name + language). **(P3)** User submits → `status='active'`, `onboarding_completed_at` set, language written to `user_linguistic_profiles` as `explicit`. **(P4)** User sends a first message — an engagement milestone, *not* an account status, so it is not in the `status` column. Email is collected only to send the link; display name ("the name other people see") and language are collected post-click on the same screen.

**Context:** We considered deriving display name from the email local-part (`isaac@gmail.com` → `isaac`), which is confusing if users don't realize it's changeable. We also want to capture incomplete signups so we can re-prompt them.

**Alternatives considered:** (A) Display name from email local-part — confusing, collides, implies a fixed name. (B) Ask name before sending the link — lost when the link opens on another device; collects profile data pre-auth. (C) Explicit name + language post-click; random username assigned at P1 via trigger; pending lifecycle. **Chosen.**

**Reasoning:** Post-click collection is device-safe and post-auth. Assigning uuid + random username at P1 means an incomplete account is a real, re-promptable record. Random `system_generated` username keeps usernames non-load-bearing.

**Implications:**
- `profiles.status` (`pending | active | deactivated`), `onboarding_completed_at`.
- First username change (system→chosen) is free; see username-policy entry.
- The in-chat language selector is removed; the context/register dropdown stays for now (see roadmap note + parking lot).
- **Abandoned pending accounts** are deleted after 30 days. The system-generated username is released (it was never user-chosen or shared). To monitor repeat-abandon / signup-spam without retaining deleted-user PII, a **hash** of the email (not plaintext) is recorded in an abuse-monitoring table with first-seen + abandon-count. (Hash chosen over plaintext for GDPR cleanliness — confirm at build.)

**Revisit when:** We add OAuth/social login (changes what the provider hands us at signup), or abandoned-signup abuse patterns require more than hash-based monitoring.

---

## 2026-06-02 — hermes_writer Postgres role scoped to INSERT-only on event tables

**Decision:** Hermes writes `agent_events` and `translation_events` rows via a dedicated `hermes_writer` Postgres role with INSERT-only access on those two tables. No SELECT, no UPDATE, no DELETE, no other tables.

**Context:** Spec 4a required a write mechanism for Hermes to log to prod. Hermes already has `DATABASE_URL_PROD_READONLY` (SELECT-only) from Spec 3; a separate write credential was needed for the event tables.

**Alternatives considered:** (A) Supabase service role key via REST API — easier to set up, but service role bypasses Row Level Security and grants full read/write on all tables. (B) Staging-only for now — defers the credential work but leaves a gap in the prod audit trail. (C) `hermes_writer` role with INSERT-only on event tables — same pattern as `hermes_readonly` from Spec 3, minimum privilege.

**Reasoning:** Option C follows the existing precedent and gives Hermes exactly what it needs — the ability to append audit rows — without any read access or write access to application tables. Blast radius if the credential is compromised is limited to inserting junk rows into two append-only logging tables.

**Implications:** `DATABASE_URL_PROD_WRITER` added to `~/.hermes/.env`. Uses the same Session-mode pooler pattern as `DATABASE_URL_PROD_READONLY` (aws-1-us-east-1.pooler.supabase.com:5432, username includes project ref). Rotate alongside the other credentials on 2026-08-31.

**Revisit when:** A second table needs write access from Hermes (e.g. a future corrections pipeline), or if we move to a service-account model with row-level security enforcing per-tenant access.

---

## 2026-06-03 — GitHub fine-grained PAT scoped to single repo with minimum permissions

**Decision:** Hermes's GitHub credential is a fine-grained Personal Access Token scoped to `translationapp1` only, with permissions: Contents read+write, Pull requests read+write, Metadata read (auto). No admin, workflows, actions, or secrets access.

**Context:** Spec 3 required GitHub access for Hermes to clone, branch, commit, push, and open PRs. Choice was between a classic PAT (account-wide) and a fine-grained PAT (single-repo, specific permissions).

**Alternatives considered:** Classic PAT — simpler to create, but grants access to all repos in the account and has coarser permission granularity. Fine-grained PAT — slightly more setup, but limits blast radius to one repo and one permission slice.

**Reasoning:** Hermes only needs to touch one repo. Granting account-wide access to an agent that runs autonomously on a VPS is unnecessary risk. Fine-grained PATs are revocable independently and expire on a known date (2026-09-01). The 5 extra minutes of setup is worth the narrower blast radius.

**Implications:** Token stored as `GITHUB_TOKEN` in `~/.hermes/.env` (mode 600). Expires 2026-09-01; rotation trigger 2026-08-31 (aligned with Vercel expiry — rotate all three in one sitting). `gh` CLI authenticated via env var; stale OAuth credential removed. Git config: `user.name "Hermes Agent"`, `user.email "24737689+iwitt1@users.noreply.github.com"` (GitHub no-reply address — associates commits with Isaac's account without exposing personal email).

**Revisit when:** A second repo needs Hermes access (create a second fine-grained PAT rather than widening this one); token rotation cadence becomes painful (automate); GitHub changes fine-grained PAT feature behavior.

---

## 2026-06-03 — Supabase prod read-isolation via dedicated Postgres role + DATABASE_URL_PROD_READONLY

**Decision:** Hermes inspects the production database through a dedicated `hermes_readonly` Postgres role (SELECT-only on public schema) with its own login user (`hermes_readonly_user`) and connection string stored as `DATABASE_URL_PROD_READONLY`. Write operations to prod still go through the Supabase PAT and require §6.2 two-confirm gating.

**Context:** Spec 3 OQ2 asked how to limit Hermes's prod database blast radius. Three options: (a) no separation — full read/write PAT only; (b) single PAT + separate read-only Postgres role for inspection; (c) separate Supabase account with prod scoped read-only via invitation.

**Alternatives considered:** Option (a) — no separation. Simplest, but any Hermes bug or prompt injection with DB access could write or delete prod data. Option (c) — second Supabase account. Captures most of option (b)'s blast-radius story but adds account management overhead and a second login credential to rotate.

**Reasoning:** Option (b) captures the key safety property (prod inspection can't accidentally write) without the overhead of a second account. The `hermes_readonly_user` connection string has no INSERT/UPDATE/DELETE on any table — verified during Spec 3 smoke testing (`permission denied` on INSERT with a valid UUID). Write path to prod still exists but is gated behind §6.2's two-confirm flow, which also confirmed working during Spec 3.

**Implications:** `DATABASE_URL_PROD_READONLY` in `~/.hermes/.env`. Uses Supabase connection pooler (Session mode) to avoid IPv6 routing issues on the VPS — username format `hermes_readonly_user.rnunfmfspggcotgjavch` required for pooler tenant routing. `DATABASE_URL_STAGING` also added (full read/write, for migration work). `hermes_readonly` role needs `GRANT SELECT ON ALL TABLES` re-run if new tables are added to public schema. Docker Engine installed on VPS as a side-effect of Spec 3 execution (required by `supabase db diff --linked`).

**Revisit when:** New schemas added beyond `public` that Hermes needs to inspect; `hermes_readonly` role missing SELECT on new tables after a migration; secrets management upgraded (Doppler/1Password) making per-credential rotation less manual.

---

## 2026-06-03 — Vercel prod-deploy gated via operating contract (charter §6.2), not a wrapper script

**Decision:** Hermes's constraint against running `vercel deploy --prod` without explicit authorization is enforced by the operating contract (charter §2 + §6.2 two-confirm flow), not by a wrapper script or CLI shim that intercepts the command.

**Context:** Spec 3 OQ3 asked how to gate prod deploys. Three options: (a) operating-contract only — charter §6.2 requires Hermes to post a plan and wait for Isaac's "yes" before any prod deploy; (b) Vercel project-level protection (preview-only token) — token scoped to preview deploys only, prod deploy requires a separate token Isaac controls; (c) wrapper script — a shell shim replaces `vercel` and intercepts `--prod` flag, requiring out-of-band confirmation before passing through.

**Alternatives considered:** Option (b) — preview-only token. Strong platform-level enforcement, but Vercel's token permission model doesn't cleanly separate preview vs. prod deploy scope on personal accounts. Option (c) — wrapper script. Structural enforcement like branch protection, but adds a maintenance surface: the script must be kept in sync with CLI updates, and a motivated agent could bypass it by calling the CLI binary directly.

**Reasoning:** Same enforcement layer as every other §6.2-gated operation (DROP TABLE, schema migrations, force-push). Hermes confirmed working during ST6 negative path — posted concerns and stood down on "no" without deploying. Option (c) captured as a parking-lot item to add if option (a) ever fails in practice.

**Implications:** No wrapper script to maintain. Charter §6.2 is the single enforcement layer for all destructive/high-impact ops. ST6 positive path (Hermes deploys on "yes") deferred until first real prod-worthy change is queued.

**Revisit when:** Hermes deploys to prod without a §6.2 confirmation (near-miss → add wrapper script immediately); Vercel adds token-level preview/prod scope separation on personal accounts; a second operator gains access and operating-contract enforcement becomes insufficient.

---

## 2026-06-02 — Defer structural GitHub branch protection on `main`; behavior-enforcement only

**Decision:** Spec 3 ships without GitHub branch protection enabled on `main`. Protection against direct-to-main pushes relies on the operating-contract layer for now (charter §6.1 + the framework-level git wrapper described in §11.1 #7). Re-evaluate when one of the listed triggers fires.

**Context:** Spec 3 Open Question 1 had us answer "yes" to enabling branch protection on `main` — both because charter §11.1 #7 explicitly names it as the structural mitigation for the "direct-to-main push" failure mode, and because the cost was "5 minutes in a GitHub settings page." At execution time, Isaac discovered that GitHub gates *both* Rulesets *and* the legacy Branch protection rules behind paid plans (Pro/Team) for private repositories. The exact warning: *"Your rulesets won't be enforced on this private repository until you move to GitHub Team organization account."* The legacy Branch protection rules path produced the equivalent restriction. Free-tier private-repo owners can configure the rules but they don't actually fire.

**Alternatives considered:**
- *Upgrade to GitHub Pro (~$4/mo individual) or Team (~$4/user/mo for orgs).* Unlocks rulesets / branch protection on private repos. ~$48–$96/year recurring. Adds a new line item to operations.md cost model. Justifiable if/when Hermes is doing autonomous work where a direct-to-main slip would actually happen, or if the value of "the platform refuses, not just the agent refuses" feels load-bearing enough.
- *Make the repo public.* Costs nothing, unlocks branch protection. Trade-off is exposing the project's code (including patterns around translation prompt, schema, and integration plumbing) to anyone, ahead of any deliberate Phase 6 API-positioning decision. Off the table at this stage.
- *Behavior-enforcement only.* Lean on the two non-platform mitigations from charter §11.1 #7: (a) charter §6.1's "direct pushes to main are treated as an error" rule, and (b) Hermes Agent's git-wrapper behavior that aborts on `main` branch unless explicitly authorized. One of two §11.1 #7 mitigations holds; the platform-level one is deferred.
- *Block on this and renegotiate Spec 3.* Disproportionate — Spec 3 has five other acceptance bundles independent of branch protection.

**Reasoning:** Adding $4–8/mo of recurring cost ahead of evidence that the structural rail is needed isn't yet justified. Hermes is in supervised mode through Day 30 per `hermes.md` §12; every commit Hermes pushes is still gated by Isaac's review at the PR-merge step. The risk surface that branch protection closes (Hermes silently force-pushes to main) is partially closed already by the framework's own git wrapper. Deferring is reversible at any time — flip the upgrade switch in GitHub settings and add the entry to operations.md. The platform-level rail is a defense-in-depth nice-to-have right now, not a load-bearing piece.

**Implications:**
- Spec 3 ships with behavior-enforcement only; charter §11.1 #7 is partially satisfied (1 of 2 mitigations active).
- New parking-lot item under Infrastructure: "GitHub branch protection on `main` — paid-tier upgrade." Tracked there so it's not forgotten.
- If Hermes ever attempts a direct push to `main` (the failure mode this would have prevented), that event becomes the explicit revisit trigger and gets logged as a near-miss in `verification.md`.
- Operations.md cost model doesn't grow this month; revisit if upgrade is approved.
- Day-30 Hermes review (`hermes.md` §12) is a natural checkpoint for re-asking whether the structural rail is worth $4/mo now that we have real operational data.

**Revisit when:**
- Hermes attempts (or successfully completes) a direct push to `main` — this is the empirical trigger; capture as a near-miss in `verification.md` and use the incident to justify the upgrade.
- Hermes graduates from supervised mode at Day 30 — if the PR-review gate is loosened, the platform-level rail becomes more load-bearing.
- A second human (collaborator, hire, contractor) gains write access to the repo — at that point the upgrade is justified by team scale, not just agent risk.
- Operations.md cost model surfaces capacity for a $4–8/mo addition without trade-off pain.
- GitHub changes its free-tier policy and unlocks branch protection on private repos at zero cost.

---

## 2026-06-02 — Anthropic direct as Hermes Agent AI provider

**Decision:** Hermes Agent routes inference through Anthropic's native API directly (`ANTHROPIC_API_KEY` in `~/.hermes/.env`, provider configured via `hermes model` → Anthropic → "Use existing credentials"), not through OpenRouter or any other aggregator.

**Context:** Spec 2 needed an AI provider configured before the Discord gateway could route messages. Hermes Agent v0.14.0 supports ~30 providers (`/docs/integrations/providers`); the realistic shortlist was Anthropic direct vs. OpenRouter (aggregator that fronts many providers including Anthropic).

**Alternatives considered:**
- *OpenRouter as aggregator.* One auth for many providers; easier to A/B test other models from Hermes's chat without re-configuring auth. ~5% margin over Anthropic-direct pricing. Adds a vendor in the critical path between Hermes and the model.
- *Claude Max OAuth (Anthropic OAuth flow).* Cheaper if we already had a Max plan + extra credits. We don't; Isaac is on API pay-per-token. Not applicable.
- *Self-hosted (Ollama / vLLM).* Off the table at this scale — Claude is the model decision per 2026-05-18 entry; running a frontier-comparable model ourselves is out of scope.

**Reasoning:** Anthropic direct is the simplest correct configuration at this stage. The architecture's "abstract external service boundaries" principle (`architecture.md` §3.10) means the provider is swappable later: changing to OpenRouter is a config.yaml edit + new env var + restart, roughly 15-20 min of work plus a small follow-up decisions entry. No code anywhere in the project couples to "Anthropic specifically." Picking Anthropic direct today doesn't lock anything in.

**Implications:**
- Anthropic API key tagged "hermes-prod" in console, stored in `~/.hermes/.env` (mode 600), never in tracked files. Verified with `git status` + grep at ship time.
- Sonnet 4.6 (`claude-sonnet-4-6`) is the active default model — set via `hermes model` → Anthropic → "Use existing credentials" → model picker. Switching models within Anthropic is a `/model` command in Discord (one-shot) or `hermes model` (persistent).
- Opus 4.6 access verified by being on the same API key (no separate auth needed); the per-agent tier override that routes specific Hermes-side tasks to Opus per `hermes.md` §3 is deferred to **Spec 2.1**.
- Anthropic console-side spend caps (per the companion decisions entry on cost caps) provide the safety rail rather than a Hermes-internal mechanism — vendor-side enforcement is more robust against a misbehaving Hermes config.

**Revisit when:**
- A model in Hermes's hands underperforms in a way that a different model (DeepSeek, Gemini, GPT-5, etc.) would meaningfully improve, and we want to A/B test from Hermes itself.
- Anthropic's pricing or API stability changes materially.
- A future spec needs multi-provider redundancy (e.g., automatic fallback when Anthropic has a 503).
- We sign onto Claude Max + extra credits and want to migrate Hermes's billing surface to that.

---

## 2026-06-02 — Conservative cost caps on Hermes via Anthropic console, not Hermes-internal

**Decision:** Hermes's per-day and per-month spend ceilings are enforced at the Anthropic console layer, not via Hermes Agent's internal cost-cap mechanism. Initial values: **$1/day** target and **$64/month** absolute cap, with email warnings at $15 and $40 of monthly spend. These supersede the spec's literal "$1 soft / $3 hard daily" wording.

**Context:** Spec 2 called for "conservative cost caps for first 72 hours" in line with `hermes.md` §6.5 (charter default $5 soft / $15 hard daily, Claude API spend). The spec's literal wording of $1 soft / $3 hard daily came from drafting before we knew exactly which layer would enforce the cap. At ship time we had two options: Hermes Agent's internal limits (config.yaml `limits:` block, schema would require docs deep-dive) or Anthropic's console-side workspace/key spend limits.

**Alternatives considered:**
- *Hermes-internal config.yaml limits.* Auto-pauses Hermes-the-agent at the cap. More integrated; can trigger Hermes-side notifications. Less robust if Hermes itself misbehaves or the config gets edited.
- *Anthropic console-side caps.* Vendor-enforced — Anthropic refuses requests once cap is hit, regardless of what Hermes thinks. More robust against Hermes-side bugs. Lower granularity on what Hermes does after hitting the cap (just sees API errors).
- *Both layers.* Belt-and-suspenders. Worth doing once we tighten internal caps in Spec 2.1.
- *No cap.* Rejected — the "$3,000 weekend bill" failure mode (`hermes.md` §11.1 #5) is exactly why this exists.

**Reasoning:** Vendor-side enforcement is the more robust layer for "make sure we never get a surprise bill" — it doesn't depend on Hermes's own config being correct or Hermes's process being healthy. The $1/day target reflects expected very-low traffic in supervised mode (only Isaac DM-ing the bot for tests). The $64/month absolute cap is intentionally generous as a safety net (≈2× a per-day soft cap × 30 days, with headroom for occasional bursts); it's the "never charge me more than this" promise, not the operational budget. Email warnings at $15 and $40 give early-warning escalation before the hard cap.

The literal "$1 soft / $3 hard daily" the spec called for would have been brittle in monthly-billing terms — would trigger a hard cap on legitimate use during a long debugging day, defeating the goal. The current ($1/day target + $64/month-max + $15/$40 warning) is the right shape for monthly-billed APIs.

**Implications:**
- Anthropic dashboard is the source of truth for current cost-cap state; changes there don't require a code/config push.
- Hermes-internal cost caps are NOT set in `~/.hermes/config.yaml`; if Hermes were to misbehave with a retry loop, it would discover the cap by getting 429s/quota errors from Anthropic. That's the intended behavior at this stage.
- Spec 2.1 will tighten by adding Hermes-internal `limits:` config as a defense-in-depth layer once we have the schema docs in front of us and have observed actual daily spend for a week.
- These caps are tied to the `hermes-prod` API key / workspace. Rotating the key requires re-setting the caps; document in the rotation runbook (future verification.md entry).

**Revisit when:**
- Observed daily spend trends above $1 consistently in normal operation — raise the day target (not the month max).
- Hermes is given autonomous workloads (Spec 5+) where occasional bursts above $1/day are expected — recalibrate based on observed task cost.
- Day-30 milestone (`hermes.md` §12) — first deliberate review of charter §6.5 defaults vs. actuals.
- Anthropic changes its console UX in a way that breaks this configuration approach.
- A real budget event (we trip a cap during legitimate work) — capture in verification.md as a teaching example like we did with the SSH lockout.

---

## 2026-06-01 — DigitalOcean as VPS provider for Hermes Agent

**Decision:** Hermes runs on a DigitalOcean Basic droplet in NYC3 (1 GB RAM / 1 vCPU / Ubuntu 24.04 LTS / 35 GB SSD / weekly backups), totaling $9.60/mo ($8 droplet + $1.60 backups).

**Context:** Per the 2026-05-18 "Adopt Hermes Agent framework" decision, Hermes needs to live somewhere other than Isaac's laptop. Spec 1 (`/docs/specs.md`) operationalized this choice; execution ran 2026-05-21 (session 1, provisioning), 2026-05-26 (session 2, recovery from misdiagnosed lockout), and 2026-06-01 (session 3, install completed and shipped).

**Alternatives considered:**
- *Hetzner Cloud.* Cheaper (~$4-5/mo for equivalent specs), but their NYC region is newer and we wanted closest-to-Supabase-us-east-1 proximity with a mature footprint. Worth revisiting if costs become material.
- *Linode (Akamai).* Comparable pricing; less mature dashboard for non-developer operation, which matters for Isaac's PM-track learning curve.
- *Modal serverless.* Per hermes.md §13 open question 6 — trades fixed VPS cost for per-invocation. Cheaper at low usage but hides the infra layer that has PM-portfolio learning value. Deferred; revisit after 30-day Hermes operation if VPS-on-DO friction shows up.
- *AWS Lightsail / GCP e2-micro.* Hyperscaler overhead and dashboard complexity not justified for a single VPS.

**Reasoning:** DigitalOcean's combination of simple dashboard, weekly snapshot backups as a one-click product, transparent pricing, mature NYC region (closest match to Supabase's `us-east-1`), and recurring-cost model fits the operational and learning requirements for Phase 1.5. Cost is within `/docs/operations.md` §1 cost-model band for infrastructure.

**Implications:**
- Recurring $9.60/mo line item in `operations.md` §1 cost model; updated once first invoice confirms exact figure.
- Backups are *weekly* (DO's product cadence), not daily — Hermes's skill library and any state on the VPS has up to 7 days of replay risk between snapshots. Acceptable; mitigated by keeping the skill library in git per hermes.md §6.8.
- Root password set + SSH-key-only auth + UFW with port 22 only + DO's hypervisor-level Droplet Console as fallback path. Combined gives three independent recovery vectors; documented in `verification.md` "Hermes infrastructure."
- Migration path: if Modal serverless or another provider becomes attractive later, Hermes's install is contained in `/home/hermes/.hermes/` and reproducible from spec + decisions.md. No DO-specific code in the application stack.

**Revisit when:**
- Monthly VPS+backup cost exceeds $25 (3× current) for the same workload — likely signal we should re-evaluate.
- A future Phase needs an order-of-magnitude RAM/CPU increase that makes per-droplet pricing punitive vs. autoscaling alternatives.
- DigitalOcean materially raises prices on Basic droplets again, or removes weekly backups from the product.
- Hermes-on-VPS reveals operational friction (manual SSH for every change, no auto-scaling, console quirks) that would be solved by a managed-agent alternative (e.g., the parking-lot item in `hermes.md` §14).

---

## 2026-06-01 — Pin Hermes Agent to v0.14.0 (v2026.5.16), not latest v0.15.2

**Decision:** Spec 1 installs Hermes Agent v0.14.0 / git tag `v2026.5.16`, despite v0.15.2 being current at install time. Pin stays until a specific reason to bump (capability gap, security fix, or post-30-day evaluation).

**Context:** Original spec was drafted with "v0.2.0" as the version — an unverified placeholder that turned out not to exist on GitHub (latest at that time was v0.14.0 / 2026.5.16 under Hermes Agent's CalVer scheme — "v0.X" SemVer plus "vYYYY.M.D" CalVer git tags). Session 2 (2026-05-26) caught and corrected to v0.14.0. By session 3 (2026-06-01), v0.15.2 had shipped (May 29, 2026) — a hotfix release for a v0.15.0 dashboard-reload bug in loopback mode.

**Alternatives considered:**
- *Pin to v0.15.2 (current latest).* Includes the dashboard-reload hotfix and a few smaller fixes. Downside: only 3 days old at decision time; not yet field-tested by anyone else on a fresh install at our scale. The bug v0.15.2 fixes affects loopback mode, which we're not using.
- *Track latest (no pin, `pip install hermes-agent`).* Simpler operationally but creates implicit upgrade surface every time we touch the install — antithetical to spec discipline.
- *Pin to v0.13.0 or earlier.* Older and lacks browser-tool improvements landed in v0.14.0 that we'll likely use.

**Reasoning:** v0.14.0 is 2+ weeks old, no known issues affecting our use case, and matches what the spec was already updated to. v0.15.2 is current but the surface area of new code is small (one hotfix + minor changes), the bug it fixes doesn't affect us, and the day-0 install posture favors known-stable over freshest. We can bump deliberately once the Hermes deployment is operational and we have signal.

**Implications:**
- Hermes shows "1 commit behind" on every `hermes --version` — visible, intentional drift from latest; ignore the upgrade nudge unless a specific reason to upgrade lands.
- Version bumps are themselves decisions: future `pip install --upgrade` runs require a (small) decisions.md entry naming the bump and why. Prevents silent dependency creep per charter §6.7.
- This decision also captures the broader principle: spec-stated dependency versions get audited against vendor docs before any irreversible install action. Spec 1's "v0.2.0" landed in the doc as a placeholder and was never verified before session 1 — corrected mid-execution at session 2, codified as a feedback memory ("verify speculative claims early") between sessions.

**Revisit when:**
- A security advisory is published against v0.14.0.
- v0.15.x or later ships a capability we need (e.g., a new gateway, a needed bug fix in our path).
- The "Day 30" Hermes evaluation milestone (`hermes.md` §12) — we can bump as part of that review with full operational context.
- Hermes Agent project switches versioning scheme or drops support for our pin.

---

## 2026-05-18 — Adopt Hermes Agent framework + tiered Claude model architecture

**Supersedes:** The 2026-05-12 "Toolchain: Cowork + Cursor only" entry below. That decision was made before Hermes was on the table and explicitly committed to two tools; the current toolchain is three agents (Cowork + Cursor + Hermes Agent), with scope defined per agent in `/docs/operations.md` §3 and `/docs/hermes.md` §3.

**Decision:** Adopt Hermes Agent (NousResearch's open-source, MIT-licensed agent framework) as the operational layer for autonomous engineering and routine work, with Claude as the underlying model and a three-tier split: Sonnet for routine execution, Opus for hard problems via Hermes self-escalation, Cowork conversation for strategy and approvals.

**Context:** As Phase 1 wraps up and Phase 2 work expands, Isaac wants to move code execution and automation off his personal machine, gain multi-platform access (Telegram/Slack/Email/CLI), reduce per-task cost of operational work, and gain practical exposure to agent internals as part of a PM career pivot. Cowork-with-Opus is excellent for strategy but becomes a bottleneck for routine execution that doesn't need Isaac's direct involvement.

**Alternatives considered:**
- *Stay on Cowork-only.* Simplest; doesn't get work off personal machine; doesn't free up Cowork sessions for higher-leverage strategic work.
- *Direct Claude Agent SDK on a VPS (no framework).* Less ops burden but loses the Hermes feature set (gateways, persistent memory, skill system, subagent delegation). More total work to reproduce.
- *Nous Hermes open-weight models on a VPS.* Initially considered then dismissed — open-weight models are meaningfully weaker than frontier Claude at agentic reasoning, and the ops cost (GPU VPS or aggressive quantization) doesn't pay off at low volume. Hermes Agent the *framework* is model-agnostic and uses Claude under the hood, which is what we adopt instead.
- *Defer indefinitely; revisit in three months.* Rejected because Phase 2's velocity benefits significantly from a tier between strategic Cowork sessions and routine execution.

**Reasoning:** Hermes Agent is MIT-licensed, model-agnostic, multi-platform, supports persistent memory and subagent delegation — all matching the operational requirements. The tiered Sonnet/Opus/Cowork split provides the right cost/quality calibration: Sonnet for high-volume routine work, Opus when Hermes self-detects a hard problem, Cowork conversations reserved for strategy/architecture/approvals. The pattern also surfaces clean agentic-architecture vocabulary Isaac will benefit from for his PM track.

**Implications:**
- `/docs/hermes.md` is the canonical operating contract for Hermes; updated in the same commit as any change to its operation.
- Pulls forward the staging environment work from Phase 2 — Hermes needs a safe deploy target before anything touches prod. See companion decisions.md entry.
- `translation_events` and `agent_events` event tables (hermes.md §7) become a near-term schema commitment.
- Cost ceilings from hermes.md §6.5 govern Hermes spend; raised only via subsequent decisions.md entries.
- Cowork sessions shift toward strategic/architectural/approval work; routine implementation moves to Hermes once it's online.
- Roadmap will gain a "Set up Hermes" phase as a follow-up; VPS provisioning and framework install are upcoming work, not yet started.

**Revisit when:**
- Hermes Agent framework reveals load-bearing issues that exceed workaround cost.
- A pricing/licensing change shifts the calculus (Hermes Agent becoming non-open, or Claude API pricing changing materially).
- Six months in, evaluate whether the tiered split delivered the expected leverage; adjust if not.
- A different agent framework demonstrates a meaningful advantage on the multi-platform + persistent memory + model-agnostic requirements.

---

## 2026-05-18 — Pull staging environment forward from Phase 2 to enable Hermes adoption

**Decision:** The staging environment (separate Supabase project + Vercel Preview env vars + migration workflow) is built and verified now (2026-05-18), pulled forward from its original Phase 2 placement. Supersedes the 2026-05-12 decision to defer staging to Phase 2.

**Context:** The 2026-05-12 decision deferred staging because "through Phase 1 the only user is Isaac and the only data is test data... the cost of a brief prod outage is negligible." That decision's "Revisit when" clause explicitly named anyone other than Isaac using the app as a trigger. Adopting Hermes (per companion entry) introduces an autonomous executor that can run migrations and deploys — functionally equivalent to "someone else is using the app" from a risk perspective. Without staging, Hermes either runs against prod with all the destructive-operation risks hermes.md §11.1 names, or is degraded to no-deploy mode which removes most of its value.

**Alternatives considered:**
- *Skip staging entirely; rely on supervised mode for Hermes (every PR manually reviewed).* Degrades Hermes to a typing assistant. Acceptable as a Day-0/Day-7 fallback; unsustainable as a permanent posture.
- *Defer staging until after Hermes is online; let Hermes set up staging as its first task.* Rejected — Hermes setting up its own safety net before being validated on simpler tasks is recursive risk. Set the net first, then test the agent against it.
- *Full staging with branch protection rules, separate domain, automated migration workflow.* Deferred — over-engineered for current needs; can layer on later.
- *Minimum-viable staging.* Chosen: Supabase staging project + Vercel Preview env vars + migration workflow + smoke-test runbook. ~45 minutes setup plus backfill work that turned implicit prod state into captured artifacts.

**Reasoning:** The minimum-viable staging is what's actually needed to safely operate Hermes. The backfill migrations (`000_base_schema.sql` capturing pre-migration tables, `004_enable_realtime_publication.sql` capturing the realtime config previously only in Supabase Studio UI) are positive externalities — they turn implicit prod state into captured artifacts in `/migrations/`, which any future fresh deploy benefits from.

**Implications:**
- `/V1/migrations/` now contains `000` → `004`. Any future fresh Postgres can replay these in order to reach prod state.
- All future migrations run on staging first, verified, then on prod. Documented in operations.md §3.
- All future feature work uses the branch → Vercel Preview → verify → merge-to-main flow. Direct pushes to main are now genuinely an error, not just a stylistic preference.
- Two new tech-debt items in parking-lot.md: vestigial columns on `messages`, and broader Supabase config that lives outside `/migrations/`. The latter calls for an audit pass before Phase 2 RLS work begins.
- `OPENAI_API_KEY` is shared across prod and staging (same value, both environments). Acceptable at current volume; split if billing visibility becomes valuable.
- During the doc-update phase that closed this work, an architectural question was surfaced and parked for Phase 3 review: per-context variation in user linguistic profile elements (parking-lot.md → "Translation quality and intelligence"). Routine work surfacing latent architectural questions — and capturing them in the parking lot for focused future review rather than ad-hoc resolution — is the discipline Hermes will follow once online (per hermes.md §4 #11).

**Revisit when:**
- Staging traffic becomes meaningful enough to need its own OpenAI key (billing/quota concerns).
- A use case emerges for a fixed staging URL (demoable to prospects) rather than per-branch preview URLs.
- Phase 2 introduces RLS — staging's RLS posture (mirror prod, or RLS-on-stage to validate policies?) becomes a real decision.
- A real incident on staging reveals a gap in the smoke-test runbook in verification.md.

---

## 2026-05-15 — Dialect-language consistency guard in applyInferences

**Decision:** `applyInferences` now checks that an inferred dialect is linguistically consistent with the message's detected source language before writing it to the sender's profile. The function accepts a new `detectedLanguage` parameter (the top-level `detected_language` from the translate response). If the dialect's language prefix doesn't match the detected language prefix (e.g. `es-AR` prefix `es` vs. detected `en`), the dialect block is skipped entirely.

**Context:** After all prior fixes (normalizeLang, isSender skip, prompt scoping), Sam's profile continued accumulating `es-AR` on every test run. Root-cause analysis confirmed the writes fired at app load when Marco had a stale `default_language = 'es'` in localStorage from a prior session. With `targetLanguage = 'es'`, Sam's old English messages passed the skip check (`source='en' ≠ target='es'`), went through translate, and the model — seeing "So what do you do back in Buenos Aires?" — inferred `es-AR` for Sam. The fix is structural: no dialect signal should ever be written to a sender's profile if it contradicts that message's detected language.

**Alternatives considered:**
- *Refresh localStorage on login.* Fixes the stale cache trigger for this specific bug but doesn't protect against the class of bug — any future path that sends a message through translate with a mismatched target could produce the same result.
- *Prompt-only fix (already done).* Scoping inferences to the sender's own message helps, but the model can still return a dialect inference based on place names or cultural content in the message text even for English messages. A hard consistency check at write time is the reliable safety net.
- *Only run applyInferences when the viewer is the sender.* Would require restructuring MessageBubble's translate flow; more invasive than a two-line guard.

**Reasoning:** The guard is the minimal, robust fix. A dialect of `es-AR` on an `en`-detected message is definitionally wrong — it doesn't matter what the model returned. Checking at write time is the right layer because it's independent of who triggered the translation, what language they had selected, or what the model inferred.

**Implications:** Any future dialect that could span language boundaries (e.g. a mixed-language dialect code) would need the guard relaxed. This seems hypothetical. The `detectedLanguage` parameter is now part of the `applyInferences` public signature — don't remove it.

**Revisit when:** A legitimate dialect code emerges whose language prefix doesn't match its speakers' primary language, and we need to handle that case.

---

## 2026-05-15 — Suppress no-op profile event writes; only log real changes

**Decision:** `applyInferences` now guards formality and gender writes with a value-change check. An event is only logged and a profile upsert only fires when the inferred value differs from what is already stored.

**Context:** Phase 1 testing showed `user_profile_events` accumulating ~100 rows per 30-message conversation, the vast majority being `casual → casual` or `neutral → neutral` — the same value being re-written on every translate call. This created noise that made the event log unreadable and wasted unnecessary DB writes.

**Alternatives considered:**
- *Write events unconditionally, filter at read time.* Keeps the write path simple but the table grows without bound and query costs scale with volume. The log becomes useless as an audit trail.
- *Debounce writes with a timer.* Adds complexity for no benefit — the right behaviour is simply "don't write if nothing changed."

**Reasoning:** The event log is an audit trail of meaningful state changes. A `casual → casual` write is not a state change. The guard is two lines and eliminates the noise at the source.

**Implications:** The dialect write already had an implicit guard (only fires when new confidence exceeds stored confidence). Formality and gender now have the same behaviour. Any future inference field added to `applyInferences` should follow the same pattern: write only on actual value change.

**Revisit when:** Never — this is just correct behaviour. No reason to reopen.

---

## 2026-05-15 — Inferences scoped to sender's own message; history excluded from dialect attribution

**Decision:** The translate prompt now explicitly instructs the model that all inferences (dialect, register, gender) must reflect the sender of the message being translated, inferred from their own message text only. Conversation history is provided for translation quality only and must not be used to attribute dialect or register signals to the current sender.

**Context:** Phase 1 testing found that both users in a two-person conversation were acquiring `dialect_region = es-AR` at confidence 1.0, even the English-speaking user who had no Argentine Spanish in their writing. Tracing the event log showed the English user's profile getting es-AR inferred within 4 seconds of sending their first message — immediately after it was translated in the other user's view. The conversation history at that point contained only the Argentine Spanish user's first message. The model was attributing the Argentine Spanish dialect signals from the history to the English sender.

**Alternatives considered:**
- *Strip history from the translate call entirely.* Fixes the contamination but degrades translation quality — history is what gives the model register and conversational context for better translations.
- *Separate the translate call from the inference call.* Two separate API calls per message: one for translation (with history), one for inference (message only, no history). Cleaner separation but doubles inference-related API calls and adds latency.
- *Add a prompt instruction clarifying the scope of inferences.* One sentence. Keeps the single-call architecture, costs nothing extra.

**Reasoning:** A prompt-level instruction is the simplest fix that preserves translation quality. The model is capable of honouring the constraint — it was only attributing history dialect signals because nothing told it not to. The single-call architecture is worth preserving.

**Implications:** `PROMPT_VERSION` bumped to `1.2.1`. Any future inference field added to the schema should be covered by this instruction implicitly, but it's worth reviewing the prompt if new fields are added that might be ambiguously attributable to sender vs. history participants.

**Revisit when:** Inference quality is measurably poor even with the constraint in place — at that point the two-call architecture (translate + infer separately) becomes worth the cost.

---

## 2026-05-14 — Normalise source_language codes; detect prompt returns BCP 47

**Decision:** All language codes are normalised to BCP 47 short codes (`'en'`, `'es'`, `'pt'`) before comparison or storage. The detect prompt explicitly instructs the model to return BCP 47 codes, never full language names. A `normalizeLang()` helper in App.jsx handles legacy full-name values already in the DB.

**Context:** Phase 1 testing revealed that the detect API was returning full language names (`'English'`, `'Spanish'`, `'Portuguese'`) instead of codes. The skip check `source_language === targetLanguage` compared `'English'` to `'en'`, which is always false. Every message therefore went through the translate path — including messages in the same language as the viewer. Combined with a corrupted `es-AR` dialect profile on a user (see separate entry), the model was producing Spanish output for English messages and caching it under `language='en'`. This is why the viewer was seeing Spanish in their own English message bubbles.

**Alternatives considered:**
- *Fix the detect prompt only.* Fixes new data but doesn't handle the existing `'English'` / `'Spanish'` values already stored in the `messages` table.
- *Normalise only at storage time.* Fixes future rows but still breaks the skip check for the 50+ existing messages with full-name values.
- *Coerce at both points.* Handles old data and new data correctly. Small function, applied in two places.

**Reasoning:** Normalisation at both the skip check and storage is the only option that fixes the live UI immediately (old cache entries) and keeps future data clean.

**Implications:** `normalizeLang()` must cover all languages we support. Any new language added to the LANGUAGES array should have a corresponding entry in `LANG_NAME_TO_CODE`. The detect prompt now explicitly specifies BCP 47 — if the model deviates, the normaliser catches it.

**Revisit when:** We switch to a dedicated language-detection library (lingua, franc) rather than GPT-4o-mini for detect calls. At that point the normaliser is still useful as a safety net but the format issue goes away.

---

## 2026-05-14 — Detect API returns confidence; Spanglish falls back to sender's language

**Decision:** The detect prompt now requests a `confidence` float alongside `detected_language`. In `sendMessage`, if confidence is below 0.85, the message is stored with the sender's own preferred language as `source_language` rather than the uncertain detection result.

**Context:** Phase 1 testing found that Spanglish messages (English with a few Spanish words) were being detected as Spanish with confidence 1.0. This caused: (a) the translate path to fire unnecessarily on the viewer's side, (b) the translation model to infer es-AR dialect at high confidence and write it to the sender's `user_linguistic_profiles` row, self-poisoning their linguistic profile, and (c) the sender seeing a "re-translated" version of their own mixed message.

**Alternatives considered:**
- *Accept misclassification.* Simple but creates a self-reinforcing profile corruption loop — once a wrong dialect is written at high confidence, context injection makes every subsequent translation reinforce it.
- *Detect with a separate high-quality model or library.* Better accuracy but adds latency and cost on every send; overkill for Phase 1.
- *Use the sender's language as source unconditionally.* Too aggressive — a genuine Spanish speaker sending Spanish should get `source_language = 'es'`.

**Reasoning:** Confidence-gated fallback is cheap and directly addresses the root cause without over-engineering. The 0.85 threshold leaves room for genuine mixed-language messages to be detected correctly while protecting against low-confidence guesses on Spanglish.

**Implications:** The detect prompt schema changed (added `confidence` field). `PROMPT_VERSION` bumped to `1.2.0`. Old detect calls without a confidence field are treated as confidence=1.0 (backward compatible). Detect confidence is not stored anywhere — it's used only at send time to decide `source_language`.

**Revisit when:** We have enough data to evaluate whether 0.85 is the right threshold, or when we switch to a dedicated language-detection library.

---

## 2026-05-14 — Viewer's own messages are never translated; always show as-typed

**Decision:** In the consumer chat app, a user's own outgoing messages always display exactly as typed. Translation is skipped entirely for `isSender = true` messages, regardless of the viewer's target language setting.

**Context:** Phase 1 testing revealed that when a user changes their target language, the translation engine was treating their own messages as translatable — an English-speaking user who briefly set their language to Spanish would see their own English messages "translated" into Spanish. This also caused their English messages to be cached in `message_translations` with Spanish translations, polluting the cache and creating confusing profile inferences.

**Alternatives considered:**
- *Translate own messages like any other.* Architecturally consistent — the translation layer shouldn't care who sent what. But bad product UX: users expect to see what they typed, not a back-translation of it.
- *Translate but don't show translated text for own messages (suppress at render layer only).* Wastes API calls and produces misleading inference data. The skip should happen before the translate call.

**Reasoning:** For the consumer chat app, a user's own message is ground truth — they know what they meant, they don't need it translated for them. The translation layer exists to bridge language gaps between parties, not to re-render your own speech. This is a UX decision, not a translation architecture decision: B2B API callers can still translate any text they want.

**Implications:** The `isSender` check is in MessageBubble's useEffect, before the cache check and before the API call. Own messages produce no `message_translations` rows and no profile inference events when viewed by the sender. Profile inference for a user still happens when OTHER users translate that user's messages (correct behavior — we infer from how they write, not how we translate for them).

**Revisit when:** A use case emerges where users want to see how their message was rendered in the recipient's language (e.g., a "preview outgoing translation" feature). At that point this could become a user preference rather than a hard rule.

---

## 2026-05-12 — Add prompt versioning: PROMPT_VERSION constant + prompt_version column on message_translations

**Decision:** `lib/translatePrompt.js` exports a `PROMPT_VERSION` semver string. Every cached translation row in `message_translations` stores the prompt version that produced it. Version is incremented on any meaningful prompt change.

**Context:** Without versioning, there is no way to know which prompt produced a given translation. This matters in Phase 4 when corrections analysis needs to ask whether a quality shift correlates with a prompt change — the data is worthless without a timestamp anchor on the prompt state.

**Alternatives considered:**
- *Log prompt changes in decisions.md only.* Human-readable but not machine-queryable. Can't join against it in SQL.
- *Hash the full prompt string as the version.* Unique but opaque — can't tell at a glance what changed or when. Also changes on every whitespace edit.
- *Defer until Phase 4.* By then, months of translations exist with no version information. Retroactively assigning versions would be approximate at best.

**Reasoning:** A semver string costs essentially nothing to add now (one constant, one nullable column). The alternative is a permanently unbridgeable gap in the corrections corpus.

**Implications:** `PROMPT_VERSION` must be incremented in the same commit as any meaningful prompt change. All future prompt work carries this as a standing requirement.

**Revisit when:** We have multiple prompt variants running simultaneously (A/B testing). At that point versioning may need to become a per-request field rather than a global constant.

---

## 2026-05-12 — Add 'nonbinary' to gender_signal enum; distinguish from 'neutral'

**Decision:** `gender_signal` gains a fifth value: `'nonbinary'`. The existing `'neutral'` value is redefined strictly as "the source language has no grammatical gender" (Finnish, Turkish, Hungarian, etc.). `'nonbinary'` means the speaker is actively using gender-inclusive or nonbinary language forms.

**Context:** Several gendered languages have emerging nonbinary forms that speakers actively use: Spanish `-e` endings and `elle`, French `iel`, Portuguese `-x`/`-@` forms, German gender star/colon. Using `'neutral'` to cover these cases conflates two unrelated things — a language property and a speaker's identity expression — and causes the model to miss gender-inclusive translation opportunities.

**Alternatives considered:**
- *Keep 'neutral' and document it covers nonbinary.* Technically workable but semantically wrong, and produces worse translations — the model won't know to use inclusive target-language forms.
- *Add a separate boolean `uses_inclusive_forms`.* More granular but adds a column for something the enum already captures cleanly.

**Reasoning:** The distinction is linguistically meaningful and directly affects translation output. `'nonbinary'` in the speaker context tells the model to use inclusive forms in the target language. `'neutral'` does not. They must be separate values.

**Implications:** Migration 003 drops and recreates the check constraint on `user_linguistic_profiles.gender_signal`. The prompt in `lib/translatePrompt.js` explicitly explains the distinction to the model and adds a rule for nonbinary-aware translation. Quality of nonbinary form usage will vary by language pair and model knowledge — this is an evolving area.

**Revisit when:** Model quality on nonbinary forms is measurably poor for a specific language pair, warranting language-specific prompt additions or routing.

---

## 2026-05-12 — Phase 1: profile update logic runs client-side, not on the backend

**Decision:** After a translate call returns inferences, the chat layer (App.jsx / MessageBubble) is responsible for comparing them to the stored profile and writing updates to `user_linguistic_profiles`. The backend returns inferences and nothing else.

**Context:** The architecture principle is "translation layer knows nothing about chat." Profile updates are a chat-layer concern — they require knowing who the sender is, querying their profile, comparing confidence, and deciding whether to write. Putting this on the backend would require the backend to have Supabase credentials and knowledge of conversation structure.

**Alternatives considered:**
- *Backend updates profiles directly.* Requires `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` in backend env vars. Couples the translation API to a specific database. Violates the layer separation principle. Deferred to Phase 2 at earliest if we add a backend-to-Supabase pattern for other reasons.
- *Skip profile updates for now.* Would mean inferences get returned and thrown away. Defeats the data flywheel goal.

**Reasoning:** The backend's job is to return structured inferences. What the chat layer does with them is not the backend's concern. Client-side update also works fine with the current anon-key Supabase setup; no additional credentials needed.

**Implications:** Profile update code lives in `App.jsx`. If we ever add server-side rendering or a mobile app, this logic will need to be moved or duplicated. Recorded here so Phase 2 auth work can revisit.

**Revisit when:** Phase 2 adds backend auth tokens. At that point, moving profile updates server-side becomes possible and may be cleaner for a multi-client world.

---

## 2026-05-12 — Phase 1: user_id stays text in new schema tables

**Decision:** `user_linguistic_profiles`, `conversation_contexts`, and `user_profile_events` use `text` for `user_id` in Phase 1, matching `user_profiles.user_id` (also text, the typed username string).

**Context:** The long-term schema uses `uuid` for user_id (driven by Supabase Auth in Phase 2). But Phase 1 has no real auth — users are just username strings. Using `uuid` now would require fake UUIDs or type coercion everywhere and give no benefit.

**Alternatives considered:**
- *Use uuid now, generate fake UUIDs per username.* Possible but fake UUIDs add indirection with zero value. The "real" UUIDs come from Supabase Auth in Phase 2 and will be different values anyway.
- *Don't create the tables until Phase 2.* Defers the schema but also defers all Phase 1 profile inference work. Not compatible with Phase 1 completion criteria.

**Reasoning:** Match the existing pattern (user_id as text) for zero friction. Phase 2 migration will update these columns to uuid and backfill from Supabase Auth.

**Implications:** Phase 2 requires a migration that alters `user_id` column type and maps old text user_ids to new UUIDs. Document this debt clearly in Phase 2 roadmap.

**Revisit when:** Phase 2 auth adoption. Expect a deliberate migration step.

---

## 2026-05-12 — Phase 1: context.user = sender's profile, not viewer's

**Decision:** When the chat layer calls the translate API, `context.user` is populated from the **sender's** linguistic profile, not the viewer's. Inferences returned by the model update the **sender's** profile.

**Context:** The translate call is "translate sender's message into viewer's language." The context object guides dialect/register/gender-aware translation. Knowing the sender's dialect is what helps the model translate idioms correctly (e.g., knowing "che" is Argentine Spanish). The viewer's identity is fully captured by `targetLanguage`.

**Alternatives considered:**
- *context.user = viewer's profile.* The viewer's profile tells the model about the audience, not the source text. Less useful for idiom/dialect translation. Also ambiguous — what do gender/dialect of the viewer have to do with translating someone else's message?
- *Include both sender and viewer profiles.* More tokens, more complexity. Deferred: if multi-party context proves useful, we can add `context.viewer` as an additional field later without breaking the contract.

**Reasoning:** Accurate translation of the source text is the primary job. The source text's dialect, register, and gender signal are what the model needs. These come from the sender's profile.

**Implications:** MessageBubble queries the sender's profile (not the viewer's) before each translate call. Inferences write back to the sender's profile. The viewer's profile is used only to determine `targetLanguage`.

**Revisit when:** A use case emerges where the viewer's linguistic profile should influence the translation output (e.g., "translate into formal Spanish for a Castilian speaker" rather than generic Spanish).

---

## 2026-05-12 — Phase 1: shared prompt module at lib/translatePrompt.js

**Decision:** All prompt logic lives in `lib/translatePrompt.js`, imported by both `api/v1/translate.js` (Vercel serverless) and `server/index.js` (Express). No inline prompt construction in route handlers.

**Context:** Phase 0 identified prompt drift between prod and local as an active bug — the two files had diverged. The fix was manual. With Phase 1 adding a substantially more complex prompt (context injection, history block, JSON schema, context-type modifiers), the drift risk multiplies.

**Alternatives considered:**
- *Keep prompts inline, reconcile manually.* The Phase 0 approach. Already failed once.
- *Single backend only (drop Express local dev server).* Would eliminate the duplication entirely but removes useful dev tooling (AbortController timeout, rich logging, health check). Not worth the tradeoff.

**Reasoning:** ES module imports work in both Vercel and Express environments (both use `"type": "module"`). The shared module costs nothing to introduce. Prompt drift is now structurally impossible.

**Implications:** Any future prompt change touches exactly one file. New context parameters are added to `buildMessages()` signature and both callers just pass the new field.

**Revisit when:** We switch to a proper monorepo tool or the project layout changes significantly.

---

## 2026-05-12 — Phase 1: JSON mode enabled for translate calls

**Decision:** All translate calls (not detect) set `response_format: { type: 'json_object' }` on the OpenAI request.

**Context:** Phase 1 restructures the translate response to a multi-field JSON object. Without JSON mode, the model sometimes wraps output in markdown code fences or adds prose commentary. The current parser (`JSON.parse(raw)`) would break on these.

**Alternatives considered:**
- *Rely on prompt-only JSON enforcement.* What we had before. Works most of the time; breaks occasionally. The Phase 1 response schema is complex enough that a parse failure is a visible user-facing bug.
- *Strip markdown fences in the parser.* Defensive but whack-a-mole — the model can produce other non-JSON wrapping.

**Reasoning:** JSON mode is designed exactly for this. The model is constrained to valid JSON output. One-line change, zero downside for gpt-4o-mini.

**Implications:** The system prompt must contain the word "JSON" for JSON mode to work (OpenAI requirement). Our prompt does. Detect mode stays as plain-text because the detect prompt is minimal and JSON mode is unnecessary overhead.

**Revisit when:** We switch models. Not all models support JSON mode or the same `response_format` parameter. Verify on any model change.

---

## 2026-05-12 — Defer staging environment to Phase 2; local + prod is enough through Phase 1

**Decision:** Through Phase 1, the environment topology is "local dev on Isaac's laptop" + "production on Vercel/Supabase." No separate staging environment, no Vercel preview deployments routinely used. A second Supabase project for staging is added to the Phase 2 roadmap.

**Context:** Question raised whether to set up a separate staging environment after Phase 0 shipped. The motivation would be ability to test changes without risking prod data; the cost would be additional setup and an extra Supabase project to maintain.

**Alternatives considered:**
- *Vercel preview deployments now.* Free, automatic, requires no setup. Rejected because previews would share the production Supabase database, so they're only marginally safer than pushing to main, and the workflow overhead (always branch first) isn't worth it for solo dev.
- *Full staging now (second Supabase + Vercel preview env vars).* Real isolation. Rejected as premature — there are no other users, breaking prod for an hour is harmless, and the time spent setting this up is better spent on Phase 1.
- *Defer until growth pressure or a real incident.* Same outcome as the current decision but without explicit roadmap placement. Worse because it leaves an undocumented "we should do this someday" rattling around.

**Reasoning:** Through Phase 1 the only user is Isaac and the only data is test data. The cost of a brief prod outage is negligible. The cost of setting up and maintaining staging is real (small but real). Phase 2 is when prod starts holding data worth not breaking (auth, real user profiles, eventually RLS-protected data) — that's the natural moment to add staging.

**Implications:**
- Phase 1 work is committed directly to `main`. No branching workflow expected.
- Migrations are run directly against the production Supabase database, with the SQL versioned in `/migrations/`.
- Roadmap Phase 2 includes adding a staging Supabase project + Vercel environment variable configuration.

**Revisit when:** Anyone other than Isaac uses the app, the data in prod becomes valuable enough that breaking it would be costly, or a migration goes wrong against prod.

---

## 2026-05-12 — Add `/docs/verification.md` for feature verification and debugging checklists

**Decision:** A seventh file in `/docs/` — `verification.md` — owns post-feature verification checklists and debugging playbooks, growing as we ship features. First entry is the Phase 0 verification checklist used after the 2026-05-12 push.

**Context:** After Phase 0 shipped, Isaac needed a checklist to verify production was working correctly. The list was generated in conversation. Isaac asked whether it should be a persistent doc so future verification steps don't have to be re-derived from scratch, saving Claude compute.

**Alternatives considered:**
- *Add to operations.md.* operations.md owns cost, hiring, workflow conventions; adding feature-specific verification steps would dilute its focus and make it harder to scan.
- *Add to architecture.md.* That doc describes what the system is, not how to test it. Wrong audience.
- *Keep verification ad-hoc.* Means re-deriving the same checklists every time, which costs both attention and money.
- *A separate file.* Clean, scannable, easy to add to as we ship features. Chosen.

**Reasoning:** Verification checklists are operational knowledge that compounds — every shipped feature should leave behind a "here's how to confirm this works in prod" section. A dedicated doc grows naturally; folding into operations.md would force awkward subsections in an unrelated context.

**Implications:**
- `/docs/` is now seven files instead of six.
- The maintenance rule in earlier docs ("five files") should be updated wherever it appears (decisions log, architecture, README, Cowork project instructions, `.cursorrules`).
- Each phase or significant feature gets its own section in `verification.md` when it ships.

**Revisit when:** Two files in `/docs/` start covering overlapping ground, or `verification.md` gets large enough to need splitting (~600+ lines).

---

## 2026-05-12 — Add `ambiguity` block to translate API response contract

**Decision:** The translate API response includes an `ambiguity` block: `{ detected: bool, confidence: float, alternatives: [{ translated_text, interpretation, confidence }] }`. The model is prompted to populate it when a phrase has multiple plausible interpretations (sarcasm vs literal, idiom collisions, pronoun ambiguity).

**Context:** Isaac raised the case of sarcasm and ambiguous phrases — situations where the model probably picks one interpretation but the user might have meant another. Surfacing the ambiguity from the model gives downstream clients (the chat app, future API consumers) the option to handle it well: prompt the user to disambiguate, show alternatives to the receiver, weight ambiguous translations differently in quality tracking.

**Alternatives considered:**
- *Don't expose ambiguity at all.* Model picks one; user gets a literal-vs-sarcastic mistake silently. Cheapest in tokens. Loses the highest-friction translation failure cases.
- *Always return alternatives, even when unambiguous.* Wasted tokens on every call. Inflated response sizes. Rejected.
- *Add the ambiguity signal in Phase 2 or later, not Phase 1.* Could work — the API contract is forward-extensible. But since we're already restructuring the response in Phase 1 to add structured inferences, adding this field at the same time is essentially free. Retrofitting later would mean another round of prompt and parser changes.

**Reasoning:** The model is already doing the ambiguity assessment implicitly (it just doesn't tell us). Asking for the output costs essentially nothing in tokens (a small fixed addition to the system prompt + a few tokens in the response for the unambiguous default case). The downstream UX value is substantial — sarcasm-read-literally is one of the most universally-felt translation failures.

**Implications:**
- Phase 1 backend work includes prompting the model to return the ambiguity block.
- The clarification-on-send UX is *not* committed yet; it lives in the parking lot. But the API contract is built ready for it, so the UX feature can ship later without an API change.
- Receiver-side ambiguity hints similarly available as a parking-lot UX option.
- Corrections schema may eventually want a "user clarified ambiguity" source type alongside `user_edit`, `thumbs_down`, etc. — defer the schema change until we actually ship the clarification UX.

**Revisit when:** Phase 1 ships and we have data on how often `ambiguity.detected: true` fires, whether the alternatives are meaningfully different from each other, and whether the model is over- or under-detecting ambiguity. May need prompt tuning or threshold guidance.

---

## 2026-05-12 — Adopt trojan-horse two-phase strategy

**Decision:** The project is committed to a two-phase strategy: Phase 1 builds the consumer chat app as a distribution vehicle and data flywheel; Phase 2 opens the underlying translation engine as a B2B API and treats that as the actual business.

**Context:** The original framing was "build a chat app to talk to a friend, with eventual API potential as a stretch." A subsequent strategic planning session with Claude Chat sharpened that into a trojan-horse model where the chat app is explicitly the means and the API is the end. The question was whether to commit.

**Alternatives considered:**
- *Personal-use focus only.* Build for two people; defer real productization indefinitely. Lower ambition, lower investment, lower learning value.
- *API-first product with no consumer app.* Skip the consumer chat product entirely; build the API directly. Faster path to commercial viability if anyone would buy it; almost impossible without the data flywheel a consumer product provides.
- *Hybrid uncommitted.* Build the chat app as if personal-use; rebuild for product if it grows. The default failure mode — most decisions get punted, retrofitting compounds.

**Reasoning:** Isaac stated preference: "I'd rather over-engineer now than be bottlenecked by time and money later." The cost of API-first patterns at MVP is genuinely small (a few hours of careful schema and route work). The cost of retrofitting them later is genuinely large. Committing now gives every subsequent decision a clear north star.

**Implications:**
- Every architectural choice from Phase 0 forward is made as if the API already has external customers.
- `tenant_id` on every table from day one, even with one tenant.
- Versioned API routes (`/v1/`) from day one.
- Token-based authentication on the chat app's own backend calls (deferred to Phase 2 timing but committed in principle).
- Translation layer designed knowing nothing about chat layer concerns.
- The chat app is the API's first first-party client, not a separate codebase that talks to the API.

**Revisit when:** Six months in, evaluate whether real B2B interest exists. If clearly not, drop the API-first overhead and refocus the chat app as a consumer product alone. If clearly yes, accelerate Phase 6.

---

## 2026-05-12 — Toolchain: Cowork + Cursor only

**Decision:** Development toolchain is Cowork (Claude desktop app with file access) plus Cursor (visual IDE). Claude Chat is dropped from the regular loop. No `CLAUDE.md` file in the repo.

**Context:** Earlier guidance from Claude Chat recommended a four-tool loop (Claude Chat → CLAUDE.md → Cursor → Cowork) and put a CLAUDE.md file at the repo root. Evaluation showed (a) the four-tool loop introduces unnecessary doc-drift surface, (b) CLAUDE.md is the Claude Code convention, not Cursor's, and Isaac doesn't use Claude Code, (c) Cowork's file and shell access make it capable of the coding loop, not just task-completion work as that guidance assumed.

**Alternatives considered:**
- *The full four-tool loop.* Higher coordination cost, more places for the source of truth to fragment, no offsetting benefit for a solo builder.
- *Cursor only.* Loses the strategy/architecture conversation surface and the persistent memory across sessions.
- *Claude Chat + Cursor (no Cowork).* Would lose direct file/shell access; everything has to be relayed through Isaac.

**Reasoning:** Cowork can do everything Claude Chat does plus directly read, edit, and run files. Cursor handles the visual editing experience Cowork doesn't replicate. Two tools, clear division, one set of docs (`/docs/`) and one set of Cursor rules (`.cursorrules`).

**Implications:**
- `.cursorrules` is the Cursor-side rules file. Lives at repo root.
- No `CLAUDE.md` until/unless Isaac starts using Claude Code.
- Claude Chat remains available as an outside-the-loop second opinion, not part of the regular flow.

**Revisit when:** Isaac starts using Claude Code (add a `CLAUDE.md` that points at `/docs/`), or a workflow friction emerges that the current setup can't address.

---

## 2026-05-12 — Documentation structure: /docs/ folder with five files

**Decision:** Project documentation lives in a `/docs/` folder containing `architecture.md`, `strategy.md`, `operations.md`, `roadmap.md`, `parking-lot.md`, and `decisions.md` (this file). The repo root contains only `.cursorrules` and standard project files.

**Context:** Multiple inputs created risk of doc fragmentation: an existing one-line README, the original `ARCHITECTURE.md` at repo root, the new Claude Chat knowledge base covering strategy / business / hiring as well as architecture, and the future need for a Cursor rules file. Without explicit structure these would have ended up as overlapping documents.

**Alternatives considered:**
- *Single mega-document at repo root.* One source of truth, no folder. Becomes unmaintainable past about 500 lines.
- *Architecture only; everything else lives outside the repo.* Loses the "documentation travels with the code" property; strategy and roadmap drift from implementation.
- *Architecture and strategy combined into one file.* Mixes audiences (engineers need architecture, partners need strategy); the doc becomes useful to neither.

**Reasoning:** Five focused files, each with a clear owner and a clear audience, are easier to maintain than one general-purpose document or three loosely-themed ones. The folder structure also signals "this is part of the project, not a one-off note."

**Implications:**
- All future documentation updates target one of the five files.
- The old `/ARCHITECTURE.md` at repo root becomes a redirect.
- New types of project knowledge that don't fit any existing file warrant a discussion about whether they need a sixth file or whether they fit somewhere existing.

**Revisit when:** A specific document grows past ~800 lines (split it), or we add a vertical that needs its own file (hiring becomes its own doc once we're hiring at volume, sales playbook becomes its own when we're actually selling).

---

## 2026-05-12 — Phase order: 0 → 1 → 2 → 3 → 4 → 5 → 6

**Decision:** Roadmap proceeds in strict phase order:
- Phase 0 (Foundation, structural prep)
- Phase 1 (Contextual translation — the project's stated value proposition)
- Phase 2 (Multi-user safety: auth + RLS)
- Phase 3 (Real conversation model, with deliberate schema review for future efficiencies)
- Phase 4 (Corrections capture — start the data flywheel)
- Phase 5 (Mobile)
- Phase 6 (Open the API)

**Context:** Initial plan was Phase 0–3. Strategic commitment to trojan horse added Phase 4 (data flywheel) and Phase 6 (API opening). Phase 5 (mobile) is inserted before Phase 6 because a consumer chat app without a mobile presence is not the product the strategy assumes.

**Alternatives considered:**
- *Move Phase 2 (auth + RLS) before Phase 1.* Was considered when we thought the live deployment might already be shared with testers. Isaac confirmed only he uses it currently, so Phase 1 first.
- *Skip Phase 1 and go directly to Phase 4 (corrections).* Would generate corrections for translations that aren't yet contextual. Low-quality corpus, defeats the purpose.
- *Phase 6 (API open) before Phase 5 (mobile).* Would let the API land before the chat app has consumer reach. Possible but loses the "the chat app is the distribution vehicle" thesis.

**Reasoning:** Each phase produces a verifiable outcome that the next phase depends on. Phase 1 makes translation actually good. Phase 2 makes the app safe to share. Phase 3 enables real conversation patterns. Phase 4 starts the flywheel that makes Phase 6 defensible.

**Implications:**
- Re-ordering requires a new decisions.md entry.
- Phases don't overlap. Phase N+1 work doesn't start until Phase N is closed.
- Items can be added or removed from a phase during planning; the phase boundaries are firmer than the item lists.

**Revisit when:** A phase reveals work that should logically belong to a different phase, or when external pressure (a real customer interest, a real privacy incident) forces reordering.

---

## 2026-05-11 — Architecture doc at repo root (superseded 2026-05-12)

**Decision:** Master architecture documentation as `/ARCHITECTURE.md` at repo root.

**Status:** Superseded by 2026-05-12 decision to use a `/docs/` folder structure. The original `ARCHITECTURE.md` has been replaced with a redirect to `/docs/architecture.md`.

**Why noted:** Documents the path that led to the current structure, so a future reader doesn't wonder where ARCHITECTURE.md went.
