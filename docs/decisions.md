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
