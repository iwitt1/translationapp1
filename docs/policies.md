# Translation App — Policies (Trust & Safety / Identity Governance)

> Living document. Owns the **values and rules** behind identity, discovery, safety, and
> account lifecycle — the things that change as we learn best practice, as distinct from the
> schema/mechanism that enforces them (`architecture.md` §7) and the point-in-time rationale
> (`decisions.md`).
>
> **Where these live in code:** global defaults are mirrored in a single `lib/policies.js`
> module (the machine source of truth that enforcement reads from). Per-tenant overrides live
> in the DB (`tenants.dm_initiation_policy`). This doc is the human-readable copy; keep the two
> in sync, and log material changes in `decisions.md`.
>
> **Audit cadence:** review at the start of each phase, and at minimum quarterly. Each review
> updates "Last reviewed" and logs material changes in `decisions.md`.

**Last reviewed:** 2026-06-11 (§6 added "Data deletion / Right to Erasure (GDPR Art. 17)" subsection at Step 7 build — two-phase 30-day grace; content de-identified via `messages.sender_id` ON DELETE SET NULL not deleted; audit row survives via `data_deletion_requests.user_id` ON DELETE SET NULL; abuse HMAC recorded on voluntary erasure too, source split parked. Gate PASSED on staging 37/37. See decisions.md 2026-06-11. Prior 2026-06-10: §6 Abandonment resolved at Step 6 build — hash-over-plaintext confirmed; HMAC pepper in env not Postgres, `key_version=1`; username release is automatic via FK cascade, no release function; re-prompt emails parked to a future CRM. Prior: 2026-06-09 initial draft — Phase 2 identity/discovery/lifecycle design.)

---

## 1. Username & display-name policy

### Username
- **Charset:** ASCII lowercase alphanumeric + underscore (`[a-z0-9_]`). Stored canonical
  (lowercased). Display may preserve original case; uniqueness is case-insensitive.
  *ASCII-only is deliberate — it removes homoglyph impersonation (e.g. Cyrillic "а" vs Latin "a").*
- **Length:** 3–20 characters. *(Confirm bounds at build.)*
- **Uniqueness:** unique **within a tenant** (`(tenant_id, canonical_username)`).
- **Non-reuse:** once claimed, a username is never reissued — even after the holder changes
  theirs. Enforced by never hard-deleting `account_identifiers` rows; retired rows keep the
  value locked. (Exception: a system-generated username from a *deleted abandoned signup* is
  released — see §6.)
- **Change cadence:** at most one change per 365 days. The first change from a system-generated
  handle to a user-chosen one is **free** and starts the clock from that point. Enforcement may
  lag the UI note; the rule is stated in the UI from launch.
- **System-generated default:** every account gets a random `system_generated` username at
  signup (P1, see §6), drawn to avoid reserved words and retired values.
- **Reserved words (blocklist):** role/system terms (`admin`, `root`, `support`, `help`,
  `official`, `mod`, `staff`, `system`, `api`, `billing`, `security`), the product/brand name,
  and a profanity list. Seeded as `reserved`-status rows in `account_identifiers`.
- **Impersonation:** handled reactively via reports + a future verification badge. Proactive
  brand/figure reservation is not attempted at this scale.

### Display name
- **Charset:** alphanumeric + space + hyphen + apostrophe. Trimmed; no leading/trailing space.
- **Length:** 1–50 characters. *(Confirm bounds at build.)*
- **Not unique** anywhere. This is "the name other people see." Nothing keys off it.

### Deferred (parked, not built)
- Timed release of retired usernames after N years.
- Contact-the-holder flow to request release of an in-use username.

## 2. Discovery policy (how users find / add each other)

- **No open search by email.** Email is **exact-match add only** — you must already know the full
  address. No autocomplete, no enumeration.
- **Username:** autocomplete/search permitted, subject to the target's discoverability setting.
- **Handle minimization:** when user A adds user B via a given handle, A sees **only the handle
  they used** — never B's other discovery handles. Enforced in the discovery query/API, not just
  the UI.
- **Per-user discoverability settings** (`account_settings`): `discoverable_by_email`,
  `discoverable_by_username` (default true), extensible to friend_code/phone later.
- **Tenant-scoped:** discovery, adds, and invites happen *within a tenant ecosystem* (Slack-ish).
  Search never crosses a tenant boundary.
- **Email matching is canonical exact equality** — `lower(trim(email))`, no other normalization
  (no Gmail dot-stripping / plus-addressing collapse). Surprising normalization is worse than a
  near-miss. Username matching is canonical-lowercase prefix (autocomplete), min 3 chars.
- **What a discovery result returns** (Step 4 RPCs, migration 010): only the target's public
  handles — `account_id`, `display_name`, and `username`. Never their email/phone/friend_code or
  any *retired* username. On an exact **email** add we still return the username (it's itself a
  public, searchable handle — decisions.md 2026-06-10); handle minimization means "never expose a
  handle the adder didn't use," not "hide the public username." Only `status='active'` profiles are
  discoverable (pending/abandoned signups are invisible).

## 3. DM-initiation policy (tenant-level, swappable)

- Conversations are **independent of the contact graph** (membership-based).
- DM-initiation is gated by a **tenant-level policy** enforced in the application layer, reading
  global defaults from `lib/policies.js` and per-tenant overrides from `tenants.dm_initiation_policy`.
- **Default policy (sole / consumer chat-app tenant — `dm_initiation_policy = {}`):**
  **mutual acceptance required.** Two users must be mutually-accepted contacts before either can
  DM the other. No discovery handle (not even known-email) unlocks a unilateral DM at launch.
- **Override mechanism (future tenants):** a tenant may permit non-mutual DM-initiation keyed on
  how the initiator connected (`via_identifier_type`), e.g. `{"email": "allow",
  "phone": "allow_if_verified", "username": "deny", "invite_link": "deny"}`.
- **Conflict-resolution rule:** mutually-accepted contacts can always DM each other; otherwise a
  non-mutual DM is allowed only where a tenant override permits the *initiator's* handle type.
- **Verification dependency:** "allow_if_verified" tiers are inert until a verification feature
  exists. `is_verified` defaults false.
- **Trust caveat:** "knows my email" is a weak trust signal (emails are scraped/leaked). The real
  anti-spam levers are verification + rate limits + the block/report system — not the handle type.

## 4. Blocking & reporting

- **Block** is stored directionally (`blocks` table records who blocked whom) but **enforced
  bidirectionally**: a block prevents contact/DM initiation in both directions and hides each party
  from the other **symmetrically** — discovery (both the email and username RPCs) returns neither
  account to the other while the block is active. Implemented as an **override layer**: the block
  never mutates the `relationships` row; `active_block_exists(a, b)` is a bidirectional check applied
  on every initiation path and both discovery RPCs (migration 011). `unblocked_at` (nullable; null =
  currently blocked) preserves history rather than deleting the row, leaving room for a future
  unblock surface. See decisions.md 2026-06-10 "Block is an override layer; symmetric hide".
- **Report** (`reports` table): reasons spam / abuse / impersonation / other. Initial behavior:
  records the report and atomically creates a block in the same call (`report_account()` RPC, migration
  011). No moderation queue UI yet; reports accumulate for later review.

## 5. Anti-abuse (layered defense — not handle-type alone)

The handle→DM matrix is one signal. The real levers are: verification (future), rate limits on
adds / DM-initiation / username changes / signups (parked, but the raw timestamped data to compute
rates already exists on every action table), and the block/report system. Do not treat "knows my
email" as strong trust.

## 6. Account lifecycle (signup → active → abandonment)

### Signup stages
- **P1 — email submitted, "Sign up" clicked:** magic link sent. `auth.users` row (uuid) created
  immediately; a DB trigger on that insert creates a `profiles` row with `status='pending'`, a
  random `system_generated` username, and the email identifier.
- **P2 — link clicked, authenticated:** onboarding screen (display name + language picker).
  *P2 is **inferred, not logged.** We do not write a P2 event or a P2 status value. Reaching P2
  is detectable for free from Supabase Auth: `auth.users.last_sign_in_at` / `email_confirmed_at`
  are stamped when the magic link is consumed. So three states are distinguishable with no extra
  instrumentation — never clicked (`pending` + no sign-in timestamp), clicked-but-abandoned-
  onboarding (sign-in timestamp set + `status` still `pending`), and onboarded (`status='active'`).
  Enough for the abandonment/re-prompt logic; explicit onboarding-funnel events are parked (see
  parking-lot.md "Onboarding funnel events").*
- **P3 — onboarding submitted:** `status='active'`, `onboarding_completed_at` set, language
  written to `user_linguistic_profiles` as `explicit`.
- **P4 — first message sent:** engagement milestone, **not** an account status (kept out of the
  `status` column to avoid conflating usage analytics with account state).

### Account status values
The `profiles.status` column has three values: `pending` (P1–P2), `active` (P3+), and
`deactivated` (soft-delete used by the data-deletion job in Step 7 — the account exists in
the DB but is non-functional). Hard deletion goes through `data_deletion_requests` (Step 7).

### Base requirements for a pending account
uuid (mandatory) · email identifier (mandatory) · `tenant_id` (mandatory) · random
`system_generated` username (yes — every profile has one) · `status='pending'`. Display name +
language are required to flip to `active`.

### Abandonment
*Built in Step 6 (migration 012, `server/lib/abandonment.js`, Vercel cron `/api/v1/jobs/abandonment`, daily 08:00 UTC). See decisions.md 2026-06-10 "Step 6 abandonment + abuse monitoring".*
- A pending account with no completed onboarding is **hard-deleted after 30 days**. The sweep
  deletes the underlying `auth.users` row via the Supabase admin API; the FK cascade (007) removes
  the `profiles` / `account_identifiers` / `account_settings` rows.
- Its `system_generated` username is **released automatically by the cascade** — the username rows
  simply vanish, unblocking reuse. There is **no** dedicated release function (it would be
  redundant). Safe to hard-delete because the username is never user-chosen or shared.
- To monitor repeat-abandon / signup-spam **without retaining deleted-user PII**, a keyed
  **HMAC-SHA256** of the canonical email (never plaintext) is recorded in `email_hash_abuse` with
  first-seen, last-seen, and `abandon_count` (atomic insert-or-increment). **Resolved: hash over
  plaintext, confirmed.** The HMAC **pepper lives only in env** (Vercel + gitignored
  `.env.rls-test`), **never in Postgres**, and carries a `key_version` (currently **1**) so it can
  be rotated by bumping the version rather than editing in place. The hash is recorded *before* the
  delete (record-then-delete) so the abuse signal survives a partial failure.
- Re-prompt emails before deletion are **parked — deliberately decoupled to a future CRM**, not
  built server-side (no sending domain yet; lifecycle email belongs in a CRM). Intended cadence
  when built: day-3 and day-14 nudge before the day-30 delete. See parking-lot.md
  "Pending-account re-prompt UX".

### Data deletion / Right to Erasure (GDPR Art. 17)
*Built in Step 7 (migration 013, `server/lib/deletion.js`, Vercel cron `/api/v1/jobs/deletion`, daily 09:00 UTC — an hour after abandonment so the two destructive jobs don't overlap). **Gate PASSED on staging 2026-06-11 — 37/37 GREEN.** See decisions.md 2026-06-11 "Step 7 data deletion".*
- **Two-phase, 30-day grace.** A user calls `request_account_deletion()`, which soft-deletes
  (`profiles.status='deactivated'`) and enqueues a row in `data_deletion_requests` (`status='pending'`,
  `grace_until = now() + 30 days`). `cancel_account_deletion()` reverses it any time before the sweep
  picks it up. This protects against accidental or coerced deletion.
- **Hard delete after grace.** The daily sweep claims each request past `grace_until` (pending→processing),
  records the abuse HMAC, then deletes the underlying `auth.users` row via the admin API and stamps the
  request `completed`. The FK cascade (007/008) removes PII (`profiles` / `account_identifiers` /
  `account_settings` / `user_linguistic_profiles` / `user_profile_events`).
- **Content is de-identified, not deleted.** `messages.sender_id` is **ON DELETE SET NULL**, so message
  content survives with the author link severed — the other party's conversation and the translation
  corpus aren't destroyed. (`translation_corrections` isn't built yet, so its anonymization is a logged
  no-op until it exists.)
- **Audit trail survives its own erasure.** `data_deletion_requests.user_id` is **ON DELETE SET NULL**
  (not CASCADE), so the completed request row remains as proof the erasure happened (with `user_id` nulled
  and a `deleted_fields` jsonb snapshot of what was removed).
- **Abuse HMAC on voluntary erasure too.** The same keyed HMAC-SHA256 used for abandonment is recorded in
  `email_hash_abuse` (shared pepper + `key_version`) *before* the delete — a delete-then-resignup is the
  same weak signal regardless of why the prior account went away. The source split (abandonment vs.
  erasure) is **parked** (parking-lot.md "`email_hash_abuse` source split").
