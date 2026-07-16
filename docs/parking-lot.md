# Translation App — Parking Lot

> Living document. Holds every idea that isn't on the active roadmap but is worth not forgetting. Add to this freely. Promote items into `roadmap.md` when they get committed.
>
> Format: each item has a short description, a "why interesting" note, and (if relevant) a "trigger" — the condition under which it should be reconsidered for the roadmap.
>
> As of 2026-07-07 every item also carries a **Priority** (High/Med/Low) and **Blocks** (which build stage it gates, or `none`) line under its heading. See "How to use this doc" at the bottom.

**Last updated:** 2026-07-07 — docs legibility cleanup: header de-blobbed, Priority/Blocks tags added, resolved items swept to a section at the bottom. Full history in [Changelog](#changelog).
**Owner:** Isaac (iwitt1)

---

## Product features

### Invite someone to the app when adding them by email
**Priority:** High · **Blocks:** none

When starting a conversation by entering an email that isn't a user yet, offer a button to **invite them to the app** — it sends an invite link to that email and tells the recipient which username invited them. Composes the existing `invites` / `redeem_invite` primitive with email delivery.
- **Why interesting:** Turns "this person isn't on the app yet" from a dead end into a growth loop; the who-invited-you context is the friendliest onboarding path.
- **Trigger:** Now buildable — custom email (Resend on jistchat.com) shipped 2026-06-23. Pull into a UX/growth pass.
- **Surfaced:** 2026-07-07 (Isaac).

### Custom signup + invite email templates
**Priority:** High · **Blocks:** none

Customize the emails sent for **signup** (magic link) and **invites** — branding, copy, and the who-invited-you context — instead of the default provider templates.
- **Why interesting:** First impression + trust; the invite email is half of the growth loop above.
- **Trigger:** Now buildable (Resend on jistchat.com). Pairs with the invite-to-app item.
- **Surfaced:** 2026-07-07 (Isaac).

### Conversation threads (multiple topic-chats within one group)
**Priority:** Low · **Blocks:** none

A group of the same people could hold several parallel conversations — e.g. a friend group with regular banter in one thread and trip-planning in another — instead of one flat group chat. A "thread" is a *container* (the friend group) holding multiple `conversations` (banter, trip-planning) under it.
- **Why interesting:** Natural organization for active groups; reduces the "everything in one noisy channel" problem; aligns with where Slack/Discord-style IA eventually goes.
- **Deliberately NOT pre-built in Phase 3 (decisions.md 2026-06-12).** The Phase 3 `conversations` table is kept a clean standalone object precisely so this stays cheap. Adding threads later is a **non-destructive ALTER** — a new `conversation_groups` (container) table plus an *optional, nullable* `group_id` pointer on `conversations` (the same add-a-nullable-column-no-backfill trick used for `messages.conversation_id` in migration 014). Adding a speculative `parent_id`/`group_id` column *now* would just guess at a shape we don't yet know; the seam costs the same to add when the feature is real. Keeping `conversations` standalone **is** the future-proofing.
- **Related:** group dedupe is policy-driven and per-tenant (Spec 6 / decisions.md 2026-06-12) — threads are the richer alternative to "same people, many groups," so revisit dedupe policy and threads together.
- **Trigger:** consumer group chat has real retention and users are creating multiple same-member groups as a workaround for topic separation.

### Conversation garbage-collection (remove a conversation once all members are inactive for N days)
**Priority:** Low · **Blocks:** none

A conversation — direct or group — should persist and stay accessible to everyone remaining as long as **at least one member is still active**. Only once **every** member has become inactive should it eventually be removed, after an inactivity window passes. The window (N days) is TBD and belongs in policies.md.
- **Why interesting:** Closes the lifecycle loop. Migration 017 deliberately decoupled conversation existence from its creator (`created_by ON DELETE SET NULL` — a creator deleting their account does **not** delete the conversation; decisions.md 2026-06-12), which means nothing currently ever reaps a fully-abandoned conversation. This is the job that does.
- **Shape (when built):** a service-role sweep (mirrors the Step 6 abandonment / Step 7 deletion crons) that finds conversations with zero active members (`conversation_members` all `left_at IS NOT NULL`, or members all deactivated/deleted) older than the window, and removes them; `conversation_members` rows cascade (`ON DELETE CASCADE`), and `messages`/`message_translations` handling follows the Spec 7 / sentinel-retirement precedent (decisions.md 2026-06-12 "Retire the global-room sentinel data").
- **Deliberately NOT built in Phase 3 (decisions.md 2026-06-12, build-time decision #2).** Phase 3 Step 1 ships the schema with the right FK semantics so this is purely additive later; the reaping logic + the N-day policy value are out of scope until there's real conversation volume.
- **Trigger:** real conversation retention exists and abandoned conversations accumulate; define N in policies.md first.

### Context type: auto-inferred, not manually set
**Priority:** Low · **Blocks:** none

The context-type dropdown (casual / dating / professional / academic) is a useful dev tool but wrong for end users. The right long-term behavior is for context type to be inferred automatically from conversation content — which is what `conversation_contexts` (Phase 3) is designed for. API clients (B2B) should be able to set it explicitly per-conversation. The manual UI toggle can be removed once auto-inference is wired.
- **Why interesting:** Removes a decision users shouldn't have to make; auto-inference is a better product and a better API.
- **Related:** `conversation_contexts` table already exists from Phase 1 schema. The inference logic and background job are the missing pieces.
- **Trigger:** Phase 3 (conversation model). The `conversation_contexts` table is the natural home for this; wiring the inference job is Phase 3 work.

### Lazy / proximity-based translation on language change
**Priority:** Med · **Blocks:** none

When a user changes their preferred language, only translate messages as they are viewed (or as they approach the viewport), rather than immediately re-translating the entire chat history. This prevents a language toggle from triggering a large batch of OpenAI calls on a long conversation.
- **Why interesting:** Eliminates a credit-burn and latency spike that scales linearly with conversation length. More importantly, it's the architecturally correct behavior — translation is a view-time concern, not a state-change concern.
- **Implementation sketch:** Track scroll position; only fire translate calls for messages within N pixels of the viewport. Messages outside the viewport stay in their cached state until scrolled into range. Already partially aligned with MessageBubble's per-message translate model — needs a visibility/intersection observer rather than a dep-array trigger.
- **Trigger:** Language preference is moved to account settings (above). These two should ship together since they address the same root cause.

### Voice translation and audio messages
**Priority:** Low · **Blocks:** none

Real-time spoken-to-spoken translation, or voice-note translation in chat. Audio in one language, transcript + audio out in another. The user-facing equivalent of what we do for text.
- **Why interesting:** Audio is how most people actually communicate over distance with people they're close to. Text-only is a real limitation for the consumer chat product.
- **Trigger:** Consumer chat has meaningful active-user retention; text translation quality is proven.

### Voice cloning (preserve sender's voice in translated audio)
**Priority:** Low · **Blocks:** none

Translation that sounds like the sender, not a generic TTS voice.
- **Why interesting:** Intent app is doing this and it's a meaningful product moat. Emotionally resonant for the dating use case.
- **Trigger:** Voice translation is shipped; user testing confirms voice identity matters in the use cases we care about.

### Cultural interpretation layer
**Priority:** Low · **Blocks:** none

Inline explanation of cultural references the translation cannot fully convey ("the speaker is making a reference to a Brazilian children's TV show…"). Optional, surfaced as a footnote-style annotation.
- **Why interesting:** Translation is one thing, comprehension is another. This is the "natural-sounding" thesis extended.
- **Trigger:** Translation quality is solved; user research surfaces "I don't get what they meant" as a real friction even with good translations.

### Conversation memory across conversations
**Priority:** Low · **Blocks:** none

The model remembers things about the user from past conversations (their job, their kids' names, that they hate small talk) and uses that in future translations.
- **Why interesting:** Real personalization beyond linguistic profile. Closer to "talking through a friend" than "talking through a tool."
- **Trigger:** User base demonstrates demand for it; privacy framing solved.

### AI-assisted communication beyond translation
**Priority:** Low · **Blocks:** none

Suggested responses, conversation coaching, tone adjustment ("you sound passive-aggressive, want me to soften this?"). Stretches the product from translation to communication-assistant.
- **Why interesting:** Significant TAM expansion if it lands. Also significant scope creep risk.
- **Trigger:** Translation is unambiguously solved and the product needs a new growth vector.

### User-controllable tone knob
**Priority:** Low · **Blocks:** none

A slider in the UI for how casual / formal / playful the user wants outgoing translations to be, overriding inferred register.
- **Why interesting:** Power users will want this; surface complexity that most users won't need.
- **Trigger:** User research shows enough power users to justify the UI complexity.

### Pre-send clarification UX for ambiguous translations
**Priority:** Low · **Blocks:** none

When the user hits send and the translation API returns `ambiguity.detected: true` with multiple plausible interpretations, intercept before the message goes through and ask the user to pick which interpretation they meant. Especially useful for sarcasm, idioms that have literal alternatives, ambiguous pronouns, and similar cases where surface meaning and intent diverge.
- **Why interesting:** Catches the highest-friction translation failures (sarcasm being read literally, idioms being mistranslated) before they're sent rather than after they cause confusion. Higher signal than post-hoc corrections.
- **API contract is already built for this** — the translate response carries `ambiguity.detected`, `ambiguity.confidence`, and `ambiguity.alternatives` as of Phase 1 (see architecture.md §5). The UX surface is what's parked.
- **Open design questions:** How confident does ambiguity need to be before we interrupt the user? Do we let them dismiss without picking? Do we record their pick as a correction-equivalent (high-signal training data — user disambiguating their own meaning)?
- **Trigger:** Phase 1 ships with the ambiguity signal flowing; we have at least anecdotal data on how often it fires and whether the alternatives are meaningfully different.

### Receiver-side ambiguity hints
**Priority:** Low · **Blocks:** none

The viewer's side of the same feature: when a received translation is flagged ambiguous, the message bubble shows a small indicator and the alternatives are viewable on tap/hover.
- **Why interesting:** Even if the sender didn't clarify, the receiver knows to read carefully. Lower-friction than the send-side intervention.
- **Trigger:** Same as above. Could ship before or after the send-side clarification.

### UI improvements (consolidated — deferred from Phase 2 identity/onboarding work)
**Priority:** Med · **Blocks:** none

A single holding pen for UI/UX adjustments surfaced while designing Phase 2 identity, discovery, and onboarding. None are blocking; they're presentation-layer polish on top of the schema/policy work landing in Phase 2. Capture now, design later.

- **Single-entry add field.** One "add a contact" box that accepts either a username or a full email and routes to the right exact-match lookup, rather than separate fields per handle type. Respects discovery policy + handle minimization (policies.md §2).
- **Settings home for identity attributes.** **→ SHIPPED 2026-07-08 (Account settings screen, migration 021 + `SettingsModal.jsx`).** *(was: PROMOTED to roadmap Phase 2.4 2026-07-07.)* A settings screen where the user sets/changes username (subject to the 1-change/365-days rule), display name, language, and discoverability toggles (`discoverable_by_email`, `discoverable_by_username`). Opened from an app-bar gear; sign-out relocated into it. Language/display-name/username go through validated RPCs (`set_preferred_language`, `set_display_name`, `change_username`); discoverability is a direct own-row UPDATE. See decisions.md 2026-07-08. The free system→user-chosen change is consumed at onboarding, so this screen's username section is purely the 365-day change flow (Change control greys out until eligible).
- **Username availability-check RPC (added 2026-07-07).** Onboarding currently validates username availability by submit-and-see-error (`change_username` raises 'unavailable'). A tiny dedicated `is_username_available(text)` SECURITY DEFINER RPC would enable live inline feedback while typing. The existing search RPC can't serve this: it filters by discoverability, so it can't honestly answer "is this taken." Polish, not blocking.
- **Onboarding screen polish.** The post-magic-link screen (display name + language) is functionally specified in policies.md §6 (P2/P3); visual/UX design is open.
- **Block/report surfaces.** Where and how a user blocks or reports from a conversation or profile view. Schema exists (Phase 2); UI placement is open.
- **Pending-account re-prompt UX.** Reminder email cadence + in-app state for pending (un-onboarded) accounts before 30-day deletion (policies.md §6). **Update 2026-06-10 (Step 6):** the *deletion* half shipped — the abandonment sweep (migration 012, `server/lib/abandonment.js`, Vercel cron) hard-deletes aged-pending accounts and records the abuse hash. The *re-prompt email* half is **deliberately parked** and decoupled from the server: no sending domain is set up yet (limited to ~2/hour), and lifecycle/drip email belongs in a CRM, not the API layer. Intended cadence when built: **day-3 and day-14** nudge before the day-30 delete. Owner = a future CRM integration, not the sweep. See decisions.md 2026-06-10 "Step 6 abandonment + abuse monitoring".

- **Translation wait-state: show the original while pending (added 2026-07-05).** With gpt-5.4 medium reasoning, translations take ~7–10s; the recipient stares at "…" the whole time. After a threshold (say 2–3s), show the untranslated original with a "translating…" indicator, then swap in the translation when it lands. Shows progress instead of dead air, and the original is often partially intelligible anyway. Surfaced during the prompt-v2 staging gate.
- **UI localization to the user's language (added 2026-07-05).** Buttons, menus, empty states, and in-message labels (e.g. the "Original" expander on received messages) should render in the user's own language, not English. The user told us their language at signup; the UI ignoring that undercuts the product's core promise. Standard i18n pass (string catalog + the user's `default_language`). **Priority: High** — kept parked; the lighter non-English *symbology* step **shipped as Spec 9, 2026-07-07** (staging gate GREEN; see verification.md "Spec 8 + 9 — Demo-readiness polish").
- **Signup language list shown in native names (added 2026-07-05).** **RESOLVED 2026-07-07** — shipped as Spec 8 (~40 endonym-first entries, commit `69dc68b`); staging gate GREEN, prod merge pending. See verification.md / decisions.md 2026-07-07.
- **Open question — language not in the list (added 2026-07-05).** What happens when someone's language isn't offered at signup? Two sketched options: (a) a free-text field ("type *hello* in your language") routed through the existing detect call to identify it; (b) swap the hand-curated list for a comprehensive standard list (ISO 639 / CLDR data, which also solves native names above). Leaning (b) for coverage with (a) as a fallback affordance, but undecided — needs a real decision before non-curated-language users show up. **Priority: High.** Spec 8 (2026-07-07) shipped the ~40-language interim list as explicitly out of scope of this question — still open.


- **Why interesting:** Keeps Phase 2 scoped to schema + policy + enforcement without scope-creeping into UI design, while not losing the UX threads.
- **Surfaced:** 2026-06-09 during Phase 2 identity/discovery design; wait-state/localization/language-list items added 2026-07-05 during prompt-v2 staging testing.
- **Trigger:** Phase 2 schema + auth land; UI build is the natural next pass.

### DM-initiation control — "Who can message you" (`allow_dms_from` enforcement + UI)
**Priority:** Low · **Blocks:** none

The `account_settings.allow_dms_from` column (`everyone`/`contacts`/`nobody`, default `contacts`) has existed since migration 007 but **nothing reads it** — it's stored, never enforced. It is a distinct axis from discoverability: discoverability governs who can *find/add* you (the discovery RPCs honor `discoverable_by_*`); `allow_dms_from` governs who can *start a conversation* once they've found you (cf. Signal/Telegram message-requests, Discord "allow DMs from server members"). It was considered for the Phase 2.4 settings screen and **pulled (2026-07-08, Isaac)** rather than ship a control that does nothing.
- **To build:** enforce the setting in the conversation-create path (`create_conversation` / conversation-kind `redeem_invite`), layered on top of the existing tenant-level `dm_initiation_policy` (`lib/policies.js`), then surface a "Who can message you" selector in the settings screen.
- **Why deferred:** no enforcement today; shipping the UI first would be a dead control. Also intersects the still-Phase-3 DM *policy values*/tiers.
- **Trigger:** unsolicited-DM friction becomes real (wider discovery / larger tester pool), or a B2B tenant needs per-user DM gating.
- **Surfaced:** 2026-07-08 during the Phase 2.4 settings-screen build.

### Should the onboarding username claim consume the yearly change?
**Priority:** Low · **Blocks:** none

Today the username picked at onboarding is claimed via `change_username()` (migration 020), which sets `username_source='user_set'` and starts the 365-day cadence clock. Consequence: a brand-new user cannot change the handle they just picked for a year, and the settings-screen "Change" control is greyed for ~365 days after signup. Open question: should the onboarding claim be treated as *setup* (not a "change"), leaving the first real change free — e.g. give one free `user_set→user_set` change, or don't start the clock until the first post-onboarding change? Trade-off: friction/typo-regret at signup vs. handle-churn/squatting abuse the cadence is meant to prevent.
- **Why deferred:** nobody's a year in yet, so it bites no one today; and it touches `change_username()` cadence logic (shared by onboarding + settings), so it wants a deliberate policy decision, not a quick patch.
- **Trigger:** first real complaint about being locked into a signup typo, or when we revisit username policy (policies.md §1).
- **Surfaced:** 2026-07-08 during the Phase 2.4 settings-screen build (Isaac parked it).

### Unread state — persistent read cursor + read/unread marker
**Priority:** Med · **Blocks:** none

Persistent, correct read/unread. **Preferred marker treatment (Isaac, 2026-07-08): bold row, no count badge** (bold the conversation name/snippet when unread). **No interim marker ships** — a trial ephemeral bold-row (and the earlier in-memory count badge) was **removed 2026-07-08** because in-memory unread resets on reload (everything reads as *read* after a refresh), which is misleading. The list currently shows no read/unread affordance until this persistent version is built:
- **Read cursor write path:** `conversation_members.last_read_at` exists (migration 017) but has **no writer** — needs a `mark_conversation_read(p_conversation_id)` RPC (SECURITY DEFINER; `conversation_members` has no UPDATE policy, all writes go through RPCs), called on `openConversation`.
- **Compute unread** from messages with `created_at > last_read_at` (and `sender_id != me`) in the `loadConversations` enrichment; drive the bold row off that instead of in-memory count.
- **Manual "mark as read/unread"** action (⋯ menu) — Isaac wants the toggle; also writes/rewinds `last_read_at`.
- **Realtime:** a new inbound message re-bolds; opening clears it (and persists across reload/devices).
- **Why interesting:** Standard chat affordance; the ephemeral version resets on refresh, which is felt.
- **Trigger:** promote when polishing chat quality; small migration + enrichment + one RPC.

### Message-history search (within conversations)
**Priority:** Med · **Blocks:** none

Search message history inside conversations you're in — distinct from discovery search, which finds *people*. Split out of the (now-shipped) conversation switcher.
- **Why interesting:** Expected in any mature chat app once history accumulates.
- **Trigger:** Conversation history grows past what scrolling handles.

### Onboarding funnel events
**Priority:** Low · **Blocks:** none

Explicit event logging for the signup funnel beyond what account state already captures. Today (policies.md §6) the lifecycle distinguishes only the states that matter for the *account*: `pending` vs `active`, with P2 (clicked-but-not-onboarded) inferred for free from the Supabase Auth sign-in timestamps. This item is the *analytics* layer on top: deliberate events for where people drop off — link clicked → onboarding page loaded → started typing → submitted — so we can measure funnel conversion, not just final state.
- **Why interesting:** Tells us *where* onboarding leaks, which the account-state model can't. Useful once we're optimizing signup conversion.
- **Why deferred:** Same usage-analytics-vs-account-state separation we deliberately drew at P4 — engagement/funnel instrumentation is intentionally kept out of the `status` column and the lifecycle policy. The auth timestamps already cover the account-lifecycle need (re-prompt, abandonment) with zero extra logging, so explicit funnel events earn their place only when we actually want drop-off data.
- **Where it'd live:** an analytics/events table (or `user_profile_events`-style append-only log), not the `profiles.status` column.
- **Trigger:** We start optimizing signup conversion, or onboarding drop-off becomes a felt problem.
- **Surfaced:** 2026-06-09, follow-up to the P1–P4 lifecycle design ("is a P2 page load logged?" — no, inferred from auth).

---

## Known technical debt

### Phase 3 conversation-aware frontend — follow-ups (deferred from the 2026-06-12 build)
**Priority:** Med · **Blocks:** none

The conversation-aware `App.jsx` rewrite shipped with three deliberate MVP corners, all fine for the first smoke pass but worth closing before real multi-user load:
- **No conversation-list realtime.** **→ RESOLVED 2026-07-08 (migration 022 + second channel).** *(was: PROMOTED to roadmap Phase 2.4 (Med) 2026-07-07.)* Migration 022 publishes `conversation_members` to `supabase_realtime`; `App.jsx` adds a `conversation_members`-INSERT channel filtered to the viewer's own rows (RLS-scoped) that reloads the list on being added, plus a reload-on-unknown-conversation guard in the messages handler so a conversation surfaces live on its first message. `conversations` deliberately *not* published (no metadata-change subscriber yet). See decisions.md 2026-07-08.
- **List enrichment is N+1.** `loadConversations()` fetches members + the latest message *per conversation* in `Promise.all`. Fine at a handful of conversations; a latency problem at scale. **Sketch:** fold into a single `list_conversations` RPC that returns each row already decorated with display name, last-message snippet/time, and unread count (also the natural home for server-computed unread).
- **`?join=<token>` doesn't deep-link.** Redeeming an invite reloads the conversation list but doesn't open the joined thread (the `redeem_invite` RPC returns `'joined'`, not the conversation id). **Sketch:** have `redeem_invite` return the target conversation id so App can `openConversation()` it.
- **Register "?" tooltip clips off-screen** (logged during the 2026-06-12 staging smoke). The explainer popover in the `ConversationView` overflow menu is absolutely positioned and runs past the viewport edge on narrow widths. **Sketch:** flip/clamp the popover within the viewport (or anchor it left of the "?"); fold into the broader UI-polish pass (Sonnet) rather than a one-off. Cosmetic — feature works.
- **Inviting a third user into a `direct` conversation doesn't promote it to `group`** (logged 2026-06-12 staging smoke). **→ PROMOTED to roadmap Phase 2.5 / Spec 11 (2026-07-16), taking option (a) — server-authoritative promote + null `dedupe_key`, applied in both `add_conversation_member` and `redeem_invite`.** Kept here for the design detail; record the final call in decisions.md on ship. `redeem_invite` (017 L606–632) adds the redeemer to the **existing** target conversation — no new row — but leaves `kind='direct'`, and the frontend renders any `direct` conversation as a 1:1 chat named after a single counterpart, so the now-3-person thread displays as a direct chat and hides the third member. **Two fix options (this is a decisions-worthy call when we build it — changes conversation semantics):** (a) **server-authoritative promote** — in `redeem_invite` (and any add-member path), when an active-member count would exceed 2 on a `kind='direct'` row, set `kind='group'` and null its `dedupe_key` (so it no longer dedupes as a pair); cleaner, one source of truth. (b) **UI gate** — on a direct chat, replace "Invite" with "start a new group" seeded with the current two + invitee, leaving the original 1:1 intact. **Latent dedupe wrinkle either way:** a `direct` row that quietly grew to 3 members still carries the original pair's `dedupe_key`, so a later `create_conversation(direct, samepair)` would dedupe back into the 3-person thread — option (a)'s dedupe_key null-ing fixes this. **Deferred** (Isaac, not blocking the cutover). When built, record the (a)/(b) choice in decisions.md.
- **Empty / message-less conversation is visible to the recipient before the first message** (logged 2026-06-18, prod 2-user smoke). **→ PROMOTED to roadmap.md Phase 2.2 (2026-06-23)** as part of the demo-polished bar (preferred fix = option 1 below). `create_conversation` eagerly inserts the conversation **and both members' rows**, so a conversation A starts but never sends in still shows up in B's list on refresh (a "ghost conversation"). Non-blocking and **not a leak** — B is a legitimate member. **Preferred fix — option 1:** filter message-less conversations out of `loadConversations()` (it already fetches the latest message per conversation), *except* the one the creator is currently viewing so A can still type into a fresh thread. Cheapest, frontend-only, fully resolves the reported symptom; the row still exists in the DB. **Option 2 (noted):** keep B's membership hidden/inactive until A's first send — more correct, but needs a flag/status on the membership row (schema touch). **Option 3 (noted):** lazy create-on-first-send — cleanest model, biggest change (the compose view currently needs a conversation to exist to type into; reworks the optimistic-send path). Fold into the next frontend/UX pass; record the choice in decisions.md if it deviates from option 1. See decisions.md 2026-06-18 "Phase 3 production cutover executed".
- **Why deferred:** none blocks the staging smoke or the prod cutover; all are reloads-work-around-it / polish gaps. **Trigger:** first multi-user testing where reload-to-see-it feels broken, or list latency shows up. See decisions.md 2026-06-12 "Phase 3 conversation-aware frontend".

### `email_hash_abuse` source split — abandonment vs. voluntary erasure (Step 7)
**Priority:** Low · **Blocks:** none

Both the Step 6 abandonment sweep and the Step 7 data-deletion sweep record their abuse-monitoring HMAC into the **same** `email_hash_abuse` table via the **same** `record_abandoned_email_hash` RPC, sharing one pepper + `key_version`. That's deliberate for now (a delete-then-resignup correlates regardless of *why* the prior account went away), and it avoided a schema change for Step 7. But the table can't currently distinguish *how* an email got hashed — an abandoned never-onboarded account and a deliberate GDPR erasure look identical, and the `abandon_count` column name is now a misnomer for the erasure path.
- **Why interesting:** If we ever want the abuse signal to weight these differently (e.g. repeat *erasure*-then-resignup is a stronger gaming signal than repeat abandonment), or to report on them separately, we need to know the source. Conflating them now is cheap; un-conflating retroactively means we can't re-derive the source of already-recorded hashes.
- **Sketch:** Add a `source text` column (CHECK in `'abandonment','erasure'`) to `email_hash_abuse`, thread it through `record_abandoned_email_hash` (or split into two RPCs), and rename/relabel `abandon_count` → a source-neutral `seen_count`. Keep the shared pepper/key_version so cross-source correlation still works.
- **Why deferred:** No consumer of the distinction exists yet; the abuse signal isn't wired into any enforcement. Adding the column before anything reads it is speculative.
- **Trigger:** First time we build logic that reads `email_hash_abuse` for enforcement/reporting, or rotate the pepper (natural moment to also reshape the table). See decisions.md 2026-06-11 "Step 7 data deletion".
- **Surfaced:** 2026-06-11 during Phase 2 Step 7 design (Isaac explicitly asked to park the source split).

### Multi-tenant email uniqueness vs. Supabase project-global auth (Model A tension)
**Priority:** Low · **Blocks:** none

We chose **Model A** (one tenant per user) for Phase 2. Under Model A this is dormant, but it's a known one-way-door risk worth recording. Supabase Auth enforces email uniqueness **globally per project** (`auth.users.email` is unique across the whole project), whereas our app-level identity model scopes discovery handles **within a tenant** (`account_identifiers` keyed on `(tenant_id, type, value)`). For the sole consumer tenant these never collide. But if we ever move to **Model B** (Slack-style — one human with memberships in multiple tenants, e.g. the same email belonging to distinct identities in two B2B customer workspaces), Supabase's global email uniqueness fights the per-tenant identity model directly: one `auth.users` row cannot represent two tenant-scoped identities.

- **Why interesting:** This is the concrete mechanism behind the "Model A is a one-way door" caveat in decisions.md (2026-06-09 identity entry). Resolving it later means either (a) decoupling app identity from Supabase Auth's user table (an `identities`/`memberships` layer above `auth.users`), (b) one Supabase project per tenant, or (c) a different auth provider. All are heavier than anything Model A needs now.
- **Why deferred:** Model A makes it a non-issue at current scale, and Phase 2's job is the consumer chat app, not B2B multi-tenancy. Over-building the auth layer now contradicts "build the structural pieces, not the speculative ones."
- **Trigger:** First serious move toward B2B multi-tenant (Phase 6 / strategic Phase 2), or any requirement that one email map to identities in more than one tenant. Re-open the Model A vs. Model B decision (decisions.md 2026-06-09) at that point.
- **Surfaced:** 2026-06-09 during Phase 2 identity/discovery design.

### Phase 2 RLS / validation gaps (surfaced in Step 2 review, 2026-06-10)
**Priority:** High · **Blocks:** widening access to real users (close before sharing widely)


Gaps spotted reviewing migration 008 + App.jsx (one since resolved; a new one found 2026-07-07). None block the Step 2 gate or matter much in the single consumer tenant, but all three become real once the "build as if the B2B API has external customers" principle meets actual multi-tenancy. Recorded so they're not silently shipped.

1. **`message_translations` cache is poisonable within a tenant.** The RLS policies (`mt_insert_same_tenant`, `mt_update_same_tenant`) gate only on `tenant_id = auth_tenant_id()`. So any authenticated user can INSERT or *overwrite* any translation-cache row for their tenant, and the INSERT check never verifies the `message_id` actually belongs to that tenant. In one shared consumer tenant this is low-risk (derived data, semi-trusted users) — one user could corrupt another's cached translations with garbage, nothing worse. Across B2B customers sharing a project it's a cross-customer integrity hole. *Fix when:* multi-tenant, or cache integrity becomes a felt problem. *Sketch:* scope writes by a join to `messages` ownership, or restrict cache writes to a service role / server path rather than the client.

2. **Realtime subscription doesn't enforce RLS or tenant scope.** App.jsx's `postgres_changes` channel appends every `INSERT` on `public.messages` with no tenant filter; only the initial fetch is tenant-scoped. Supabase Realtime doesn't apply RLS to `postgres_changes` unless realtime authorization (private channels) is configured. Fine for one shared tenant; a cross-tenant message-leak vector the moment a second tenant exists on the project. *Fix when:* before any real multi-tenant data shares a Supabase project. *Sketch:* enable Realtime RLS / private channels, or filter the subscription by `tenant_id` and stop trusting the client filter for isolation.

3. ~~**`display_name` charset not validated server-side.**~~ **RESOLVED 2026-07-07** (migration 020, exactly the predicted "next touch of `complete_onboarding()`"): control characters, DEL, and bidi override/isolate chars are now rejected in the RPC. Implemented as a denylist rather than §1's allowlist sketch so international names pass — policies.md §1 updated. Emoji remain allowed (a product choice, not an oversight). Original item below for history: policies.md §1 specified display-name charset = alphanumeric + space + hyphen + apostrophe; `complete_onboarding()` validated only length, so arbitrary characters (emoji, control chars, RTL overrides) could land in `display_name`.

4. **Three tables have no RLS + permissive `GRANT ALL TO anon, authenticated`** (found 2026-07-07 confirming RLS coverage against the generated `schema.sql`): `tenants`, `translation_events`, `agent_events`. Supabase enforces access *via* RLS, so RLS-off + granted-to-anon means **any client holding the public anon key can read *and* write these tables directly through the REST API (`/rest/v1/…`), bypassing the app's token-auth** — exposing tenant config + the event log (usage/cost/`user_id` metadata, *not* chat text) and allowing tamper/forge/delete, including `tenants` policy columns. Likely a Spec 4a oversight (event tables got `hermes_*` grants, but anon/authenticated were never revoked and RLS never enabled; `tenants` was never locked down). Supabase's Security Advisor should independently flag these. *Fix (staging-first):* `ENABLE ROW LEVEL SECURITY` on all three + `REVOKE` anon/authenticated (deny-by-default like `email_hash_abuse`), keeping `hermes_writer`/`hermes_readonly`/`service_role`; verify nothing legit reads `tenants` client-side first (app uses a `CHAT_APP_TENANT_ID` constant + reads policy server-side → expected safe). **Not critical yet (no real users), so parked — not roadmapped — but High priority: close before widening access.** See decisions.md 2026-07-07.

- **Surfaced:** 2026-06-10, Cowork review of Sonnet's Step 2 implementation.
- **Trigger:** #1 and #2 at first real multi-tenant move (strategic Phase 2 / B2B API); #3 anytime we touch `complete_onboarding()` or build identity validation in Step 4.

### Invite max-uses exhaustion gate coverage gap (Step 5)
**Priority:** Low · **Blocks:** none

The Step 5 social-graph gate (`scripts/social-graph-gate-test.mjs`) exercises invite creation,
redemption, re-redeem rejection, redeem-own rejection, revoked/expired/wrong-kind rejection — but
**not** full `max_uses` exhaustion (create a `max_uses=N` invite, redeem it N times by N distinct
accounts, then assert the N+1th redemption is rejected). Tenant 1 has only two real users (A, B), and
A is the inviter, so at most one other account (B) can redeem — there's no way to drive a counter
past 1. The `use_count >= max_uses` branch in `redeem_invite()` is therefore validated by code
inspection only, not by the gate.
- **Why interesting:** It's the one invite guard the gate can't prove behaviorally. Low risk (the
  check is a simple counter compare), but it's an untested branch on a write path.
- **Cheapest fix:** seed a third tenant-1 user (C is currently re-pointed into tenant 2 for the
  cross-tenant checks; a fourth fixture user, or temporarily a second tenant-1 account, would let the
  gate redeem a `max_uses=2` invite twice and assert the third redemption fails).
- **Trigger:** when a third tenant-1 fixture user is added for any reason, or when invite abuse
  (over-redemption) becomes a felt risk worth a behavioral test.
- **Surfaced:** 2026-06-10, writing the Step 5 gate.

### Live rate-limit enforcement on social-graph writes (Step 5 deferral)
**Priority:** Low · **Blocks:** none

Step 5 ships the contact/block/report/invite write paths (SECURITY DEFINER RPCs) but **no rate
limiting** on them — nothing caps how fast an account can fire `request_contact`, `create_invite`,
`block_account`, or `report_account`. As noted in "Rate-limit counters" below, every one of these
tables already carries actor + timestamp + tenant_id, so rates are computable retroactively with no
schema change; the deferral is the *live enforcement* (reject the Nth action in a window), not the
data to compute it.
- **Why deferred:** single trusted-tester tenant; no abuse surface yet. Premature to build a limiter
  before there's traffic to limit.
- **Trigger:** the app is shared beyond trusted testers, or a spam/abuse pattern appears on any
  social-graph write path. See also `email_hash_abuse` (migration 011) — the abandoned-signup spam
  counterpart, which is structurally present but likewise not yet wired to enforcement.
- **Surfaced:** 2026-06-10, Step 5 design.

### Robust testing, QA, and CI process — staged build-out
**Priority:** Med · **Blocks:** none

Current testing posture is largely manual: smoke-test runbook in `/docs/verification.md`, run by a human after deploys. As the project scales (Hermes online, real users in Phase 2, multiple verticals in Phase 6), the manual approach won't hold. The forward state is a multi-layered testing / QA / CI pipeline with the 2026-05-18 staging smoke-test as its first iteration. Likely build-out order, each layer earning the next:

1. **Automate the staging smoke test as a CI gate.** When Hermes (or anyone) pushes a feature branch, GitHub Actions or Vercel-native checks run the smoke-test runbook automatically against the Preview deploy. First and easiest layer. Catches env-var typos, Realtime-publication gaps, and similar "fresh-deploy state" misses before a human notices.
2. **Unit tests for core translation logic.** `lib/translatePrompt.js`, the `applyInferences` flow, `normalizeLang`, the dialect-consistency guard. Likely Jest or Vitest (existing stack). Highest leverage on the most-changed files.
3. **Integration tests against the translate API path.** Bilingual test conversations with expected outputs — the existing "Autonomous test harness for agent-driven builds" item below is the closest current expression. Becomes essential when Hermes is committing autonomously.
4. **Quality benchmark suite.** The "Internal translation quality benchmark" item (in "Translation quality and intelligence" section) runs translation against a curated hard-cases corpus on prompt changes, reports quality delta. Becomes possible when the corrections corpus is non-trivial; essential when prompt changes happen often.
5. **Staged rollouts.** Feature flags, percentage rollouts, canary deploys. Phase 6 (API) concern; not Phase 1-3.

The smoke test we built 2026-05-18 is the manual seed of layer 1. Each layer builds on the previous; skipping ahead is a known anti-pattern (e.g., trying to do quality benchmarks before there's anything stable to benchmark against).

- **Why interesting:** Testing infrastructure is among the highest-compounding investments — every test catches a future bug forever. But it's also one of the easiest things to over-engineer before the bugs exist to catch. The order matters.
- **Surfaced:** 2026-05-18, as a "what's next" thought after the staging smoke test was built.
- **Trigger:** Hermes online and routinely committing code → start with layer 1 (CI gate on the smoke test). Each subsequent layer triggered when the project's complexity has grown past the previous layer's coverage.
- **Related items:** "Autonomous test harness for agent-driven builds" (next item below), "Internal translation quality benchmark" (in "Translation quality and intelligence" section).

### Per-user IANA timezone (separate from `timestamptz`)
**Priority:** Low · **Blocks:** none

Migration 014 standardized timestamps on `timestamptz` — but `timestamptz` stores only the UTC instant; it does **not** retain the user's local timezone. If we ever want to know "what local time was it for this user" (time-of-day greetings, localized display, time-aware register inference), that needs a separate explicit datum: a nullable IANA string (e.g. `"America/Argentina/Buenos_Aires"`) on the user record (`account_settings` or `profiles`).
- **Why deferred:** No near-term use, and it's a purely additive nullable column — non-destructive to add anytime. Not worth folding into the cutover speculatively.
- **Trigger:** A concrete feature that needs the user's local clock. Add the column then.
- **Surfaced:** 2026-06-11, forward-looking schema review.

### ULID / uuid v7 for high-volume tables (id strategy)
**Priority:** Low · **Blocks:** none

All PKs use `gen_random_uuid()` (uuid v4, random). Random v4 PKs fragment btree indexes and hurt insert locality at scale; time-ordered ids (uuid v7 or ULID) give better locality and let you sort by id. Fine at current scale (hundreds of testers); a PK-type change on a *populated* table is a full rewrite (every FK too), so this is a "decide before the table gets big" call — most relevant for the future high-volume tables (`translation_corrections`, `translation_events`, usage/metering).
- **Why deferred:** v4 is genuinely fine until meaningful volume; the migration cost only bites at scale; and the decision can be made per-table when the high-volume ones are built rather than retrofitting existing low-volume tables.
- **Trigger:** A meaningful number of users or messages, OR building any of the high-volume tables above — pick a time-ordered id strategy for *those* at creation.
- **Surfaced:** 2026-06-11, forward-looking schema review.

### Other config state lives outside `/migrations/` and isn't captured
**Priority:** Med · **Blocks:** none

> **Update 2026-07-07:** the weekly `schema-dump` GitHub Action (decisions.md) partially covers this — an out-of-band change to *schema* objects (tables, columns, constraints, RLS, functions) now surfaces as a diff in `docs/schema.sql`. It does **not** capture non-schema config (realtime publications, Auth settings, UI-enabled extensions), so that audit is still open.

The `messages`-on-realtime-publication item was originally configured via the Supabase Studio UI. Migration `004_enable_realtime_publication.sql` (2026-05-18) backfilled it. But the broader category of risk remains: other Supabase configuration may exist in prod via UI clicks and not in the migrations folder. Candidate suspects (need an audit pass):

- Realtime publications on other tables (known published: `messages` (004) + `conversation_members` (022); audit whether anything else was UI-added)
- RLS policies (none exist yet, but Phase 2 introduces many — they MUST live in migrations from day one)
- Database functions / triggers (none currently expected, but worth checking)
- Storage bucket policies (no Storage usage yet)
- Auth provider config (will become relevant in Phase 2) — **now concrete:** Phase 2.1 token auth requires **asymmetric JWT signing keys** enabled in Supabase Auth (a UI/config setting, not a migration). Enable on staging then prod; record the date when done. Reversible. (decisions.md 2026-06-23 "Token auth on backend API calls".)
- Edge functions (none currently)
- Extensions enabled (e.g. `pg_cron`, `uuid-ossp` — defaults are usually safe but worth confirming)

- **Why interesting:** Doc/DB drift is the same failure mode as the vestigial columns above — anything in prod that isn't in the migrations folder means a fresh deploy (Hermes-driven or otherwise) silently lacks it. The bug usually manifests as "works in prod but not staging," which is a particularly nasty class of bug because staging exists to *prevent* prod surprises.
- **Surfaced:** 2026-05-18, when the staging smoke test revealed realtime wasn't on.
- **Mitigation now:** When introducing new Supabase config (RLS, triggers, etc.), default to capturing in a migration even if also configuring via UI. The migration is the source of truth.
- **Trigger:** Before Phase 2 auth/RLS work begins, do a focused audit of prod Supabase config that isn't in migrations. Easier to catch and codify upfront than chase per-feature.

---

## Translation quality and intelligence

### Prompt A/B testing framework
**Priority:** Low · **Blocks:** none

Once `prompt_version` is flowing on every cached translation, the next step is running two prompt variants simultaneously and comparing quality metrics (correction rate, ambiguity detection rate, user thumbs-down rate) between them. Currently `PROMPT_VERSION` is a global constant — a single version runs for all calls. A/B testing would require routing a percentage of calls to an alternate prompt and tagging their cached translations with the variant version.
- **Why interesting:** Closes the loop between prompt changes and measurable quality outcomes. Right now we change the prompt and hope it helped; A/B testing tells us whether it actually did.
- **Depends on:** Phase 4 corrections capture (need the quality signal to measure against). Prompt versioning infrastructure is already in place as of Phase 1 cleanup.
- **Trigger:** Phase 4 is underway and we have enough translation volume to get statistically meaningful split-test results.

### Multi-model AI routing
**Priority:** Med · **Blocks:** none

Per-message routing between cheap and expensive models. Short literal messages go to a cheap model; long, idiomatic, or context-heavy messages go to a stronger one. **Update 2026-07-07:** the model-comparison harness produced a data-backed candidate policy — casual messages → `gpt-5.4-mini:low` (passed everything except professional register, 4x cheaper, tight ~2.5s latency), professional/formal contextType → `gpt-5.4:low` (the only tier that produces usted forms and full keigo). The 4x cost delta makes this real money at scale; contextType is already in every request, so the routing key exists.
- **Why interesting:** Cost reduction without quality reduction.
- **Trigger:** Small-scale stage; volume makes the cost difference matter financially.

### Fine-tuning on corrections data
**Priority:** Low · **Blocks:** none

Train a model derived from base + our corrections. The pivot from "we call OpenAI" to "we call our own model" makes the product technically defensible in a way it isn't yet.
- **Why interesting:** This is the actual moat. Until we do this we're a smart wrapper. After we do this we have a proprietary asset.
- **Trigger:** ~50k high-quality correction pairs in the corpus. Estimated cost when ready: $200–800 for the first meaningful training run.

### Cross-model AI audit pipeline
**Priority:** Low · **Blocks:** none

A second AI model (different family from the translator) reviews each translation and flags suspicious output. GPT-4o translates, Claude audits. Same-model auditing has a known blind spot — models agree with themselves. Schema already designed (`translation_reviews`); auto-audit not yet running.
- **Why interesting:** Cheap way to generate medium-quality corrections data at scale without needing human review on every translation.
- **Trigger:** Phase 4 begins (corrections capture). Schema is already there from Phase 1–2.

### DeepSeek as alternative model
**Priority:** Low · **Blocks:** none

$0.14/M tokens vs ~$3/M for Claude Sonnet. Strong on CJK languages. Emerging player worth watching.
- **Why interesting:** Cost reduction; potential quality wins on Asian language pairs.
- **Trigger:** Small-scale stage; evaluate as alternative provider once backend is provably model-agnostic.

### Dialect clustering from corrections
**Priority:** Low · **Blocks:** none

Once corrections from regionally-identified users accumulate, cluster them to discover dialect patterns the base model doesn't know. Map regional preferences for vocabulary, idiom, and pronoun use empirically rather than from linguistics literature.
- **Why interesting:** Differentiated dataset; foundation for region-specific fine-tunes.
- **Trigger:** Corrections corpus is non-trivial (thousands of pairs from multiple regions).

### Internal translation quality benchmark
**Priority:** Low · **Blocks:** none

Curated set of hard translation cases drawn from corrections where generic models fail. Used internally to evaluate new model versions, externally as a sales tool when the API opens.
- **Why interesting:** Quantifies our advantage. Sales tool.
- **Trigger:** Phase 4 underway, corrections corpus large enough to draw a meaningful sample.

### Per-context variation in user linguistic profile elements
**Priority:** Low · **Blocks:** none

Some `user_linguistic_profiles` fields plausibly vary by conversation context — a user might be `casual` in dating chats and `formal` at work, or use different gender expression with family vs. acquaintances. Currently the schema has ONE `formality_preference` (and `gender_signal`, etc.) per user per tenant, and `conversation_contexts` holds the conversation's detected register separately. The translate prompt sees both, so the model already blends them implicitly — but the user profile itself has no representation of context-dependence.

**Two interpretations of the same problem:**

1. *Prompt-level fix.* The current schema is fine; the translate prompt + `conversation_contexts` already let the model blend user posture with conversation register. The fix (if needed) is improving how the prompt combines them — e.g., explicitly instructing the model that conversation register overrides user formality when they conflict. Cheap, reversible, no schema change.
2. *Schema-level fix.* Add per-context profile rows (`user_linguistic_profiles` keyed on `(user_id, tenant_id, context_type)`) or a sparse `user_context_overrides` table layered on top of the base profile. Lets the system *learn* that this user is consistently more casual in dating contexts and adjust the inference pipeline accordingly. More accurate; more complex; data migration if retrofitted later.

Both are valid. The current architecture leans toward #1 implicitly. This item exists to revisit the choice deliberately.

- **Why interesting:** It's a real product nuance — users do vary by context, and surface-level translation that doesn't capture that will feel off in exactly the way users notice. But it's also exactly the kind of thing that's easy to over-engineer before knowing whether it matters.
- **Architectural design work to do at trigger:** decide between option 1 and option 2 (or a hybrid where one or two specific fields like `formality_preference` get per-context rows while others stay global). Capture the decision in `decisions.md` before implementation. If option 2, design the migration carefully — `user_linguistic_profiles` is already populated with inference data.
- **Related schema work:** the `_source` tracking convention (`explicit` vs `inferred`) needs to extend cleanly into the per-context model. An explicit per-context override must not be overwritten by inference at the global level.
- **Surfaced:** 2026-05-18 by Isaac while reviewing the post-staging-setup docs.
- **Trigger:** Phase 3 (conversation model). At that point: focused design review of how `user_linguistic_profiles` + `conversation_contexts` interact, decide between options 1 and 2, write a spec, then implement. Implementation comes after the design decision, not bundled with it.

### Additional region inference signals
**Priority:** Low · **Blocks:** none

Beyond the lexical and spelling signals already designed: timestamp/timezone activity patterns, character input patterns (which accented characters used or avoided), IP geolocation (weakest, VPN-vulnerable, used as one signal among many).
- **Why interesting:** More signal sources → better dialect inference.
- **Trigger:** When dialect inference accuracy is measurably weak and we have analytics showing where.

---

## Infrastructure and scale

### Tenant-scoped option registry (data-driven vocabularies)
**Priority:** Low · **Blocks:** none

A single source of truth for enumerated option sets surfaced to users or constraining data — `context_type`/register, languages, and any future field "where options are available" — so adding/adjusting an option is one edit, not the same change smeared across a DB CHECK, `src/lib/vocabularies.js`, and `lib/translatePrompt.js`. Per-tenant, so the eventual B2B customers can define their own register vocabularies (and, later, their own tone behavior).
- **Why interesting:** Directly aligned with the trojan-horse "build the structural pieces as if the API already has external customers" ethos. Vocabularies are exactly the kind of thing a B2B tenant will want to customize. Today the coupling is manual and easy to drift (it already did — see decisions.md 2026-06-12 "Unify context_type vocab"; migration 019 is the hardcoded interim fix this initiative supersedes).
- **Shape (when built) — open design decisions to resolve first:**
  - *Generic table + trigger validation* (`vocab_options(tenant_id, set_key, value, label, sort_order, is_active, config jsonb)`, conversations validated by a trigger that checks an active row exists for `(tenant_id, 'context_type', value)`) **vs. per-set table + FK** (`context_types(tenant_id, value, …)`, `conversations(tenant_id, context_type)` → FK). Generic = add a new set with zero DDL; per-set = more declarative/safer but rigid. Leaning generic+trigger for extensibility.
  - *Where engine behavior lives.* Recommendation: the **table governs the selectable list + labels + ordering + per-tenant active set**; the **prompt-modifier text stays in code** (`translatePrompt.js`) keyed by value, so prompt behavior stays under code review/versioning rather than casually editable in a data row. Tenant-custom prompt modifiers (modifier text in `config` jsonb) is a later layer if a customer needs it. This keeps "what's offered" (data) separate from "what it does" (behavior) — matches the chat/translation layer-separation rule.
  - *Frontend consumption.* A `useVocabulary('context_type')` hook fetches the tenant's active options (RLS-readable), cached; `src/lib/vocabularies.js`'s function-shaped accessors (`getContextTypes(tenantId)`) were written to absorb this without churning call sites.
  - *Migration cost.* Replaces the 019 CHECK with the trigger/FK; seeds the chat tenant's current sets (context_type, languages); needs a gate (valid value accepted, inactive/foreign-tenant value rejected, tenant isolation).
- **Trigger:** the first external tenant (or internal demand to A/B different register sets) — or sooner if a third field needs the same data-driven treatment and the copy-paste cost becomes obvious. Spec it as its own migration + gate when picked up.

### Translation deduplication / orchestration layer
**Priority:** Low · **Blocks:** none
A central layer that dedupes identical concurrent translation requests across users. If 50 users in a group chat all need the same Spanish→English translation, the cache solves serial case; an in-flight queue solves the concurrent case.
- **Why interesting:** Prevents N parallel OpenAI calls for the same translation when N users land on a message simultaneously.
- **Trigger:** Real concurrent traffic; identified instances of the race condition causing real cost.

### Idempotency keys on API calls
**Priority:** Low · **Blocks:** none

Standard API practice — a unique key per call so retries don't double-charge.
- **Why interesting:** Required hygiene for any serious API. Cheap to add early.
- **Trigger:** Phase 0–1; reasonable to fold into the API-first work.

### Async / batch translation endpoint
**Priority:** Low · **Blocks:** none

A separate endpoint for clients submitting large batches of text. Returns a job ID; webhook fires when complete.
- **Why interesting:** Enterprise customers will want it. Different cost/latency tradeoff than the synchronous endpoint.
- **Trigger:** First serious B2B customer interest in batch use cases.

### Webhook support architecture
**Priority:** Low · **Blocks:** none

Standard pattern for delivering async results and event notifications.
- **Why interesting:** Required infrastructure for batch translation and probably for billing/usage notifications.
- **Trigger:** Phase 6 (API open).

### SDKs
**Priority:** Low · **Blocks:** none

Client libraries in JavaScript and Python (priority order) that wrap the API. Reduces friction for developer adoption.
- **Why interesting:** Standard API expectation. Could be community-built, but quality SDKs are usually first-party.
- **Trigger:** Phase 6.

### Migration off Vercel / Supabase to dedicated infrastructure
**Priority:** Low · **Blocks:** none

Containerized backend, dedicated Postgres, Redis cache layer, dedicated realtime infrastructure (Ably or Pusher).
- **Why interesting:** Vercel/Supabase scale fine to small-scale; dedicated infrastructure becomes a meaningful cost win and reliability win at high volume.
- **Trigger:** Costs at the Vercel/Supabase tier exceed roughly the equivalent dedicated infrastructure cost, or reliability becomes a customer concern.

### Translation cache normalization
**Priority:** Low · **Blocks:** none

Before computing the cache key, normalize the input: lowercase, whitespace trim, contraction expansion. So `"don't go"` and `"Don't go"` cache as one entry, not two.
- **Why interesting:** Higher cache hit rate, lower cost.
- **Trigger:** Cache hit rate plateaus below expectations.

### Bulk translation-cache lookup
**Priority:** Med · **Blocks:** none

On page load, the frontend currently fires one `GET /rest/v1/message_translations` per existing message in the conversation history. For a chat with N messages, that's N round-trips just to check the cache. Replace with either (a) a single bulk lookup using `message_id=in.(uuid1,uuid2,...)`, or (b) a server-side join so the messages query returns each message's cached translation in one response.
- **Why interesting:** Linear-with-conversation-length network overhead becomes a real load-time problem at scale. Confirmed in the Phase 0 verification HAR: 17 messages → 17 separate cache GETs.
- **Trigger:** Conversations grow past roughly 50 messages, or page load latency becomes a felt problem in testing. Likely candidate for Phase 1 or Phase 3 when we're already restructuring how the frontend talks to the backend.

### Rate limiting and usage metering
**Priority:** Low · **Blocks:** none

Internal first (catch our own bugs that cause runaway calls), external second (billing infrastructure for the API).
- **Why interesting:** Required for the API; useful for the chat app's own safety.
- **Trigger:** Small-scale; before Phase 6.

### Data residency
**Priority:** Low · **Blocks:** none

Where data physically lives matters for some markets (EU, healthcare). Supabase region is `us-east-1` for both prod and staging (confirmed 2026-05-18 in operations.md §4). Entering an EU market or a regulated US healthcare context likely requires either a regional Supabase project or self-hosted Postgres in-region.
- **Why interesting:** Compliance requirement for some verticals.
- **Trigger:** Entering a market with data residency requirements (EU healthcare especially).

### Vercel prod-deploy wrapper script as defense-in-depth
**Priority:** Low · **Blocks:** none

A shell shim that replaces the `vercel` binary and intercepts `--prod` flag calls, requiring out-of-band confirmation before passing through to the real CLI. Adds a structural enforcement layer under the operating-contract layer (§6.2) for prod deploys.
- **Why interesting:** "The platform refuses" is more robust than "the agent refuses" if §6.2 is ever misinterpreted. Same argument as branch protection on GitHub.
- **Why parked:** Option (a) from Spec 3 OQ3 — §6.2 operating-contract only — confirmed working during ST6 negative path. Wrapper adds maintenance surface (must track CLI updates) without clear benefit while Hermes is in supervised mode.
- **Trigger:** Hermes deploys to prod without a §6.2 confirmation (near-miss). That event is the empirical trigger; add immediately on first occurrence.
- **Surfaced:** 2026-06-03, Spec 3 OQ3 resolution.

### Dedicated hermes@ email alias for git commits
**Priority:** Low · **Blocks:** none

Currently Hermes commits with `user.email = 24737689+iwitt1@users.noreply.github.com` (Isaac's GitHub no-reply address). Functional and associates commits with Isaac's account, but blurs attribution between Isaac and Hermes in the git log.
- **Why interesting:** A dedicated `hermes@<domain>` alias would make it immediately obvious which commits were agent-authored vs. human-authored, which matters for auditability as Hermes becomes more active.
- **Trigger:** When you have a custom domain set up, or when agent-authored commits become frequent enough that the attribution blur causes confusion.
- **Surfaced:** 2026-06-03, Spec 3 git config step.

### GitHub branch protection on `main` — paid-tier upgrade
**Priority:** Low · **Blocks:** none

Enable platform-level branch protection on the `main` branch — the structural mitigation charter §11.1 #7 calls out for the "direct-to-main push" failure mode. Both Rulesets and legacy Branch protection rules require GitHub Pro (individual, ~$4/mo) or Team (org, ~$4/user/mo) on private repositories — confirmed 2026-06-02 during Spec 3 execution. Deferred to behavior-enforcement only for now; see `decisions.md` 2026-06-02 entry "Defer structural GitHub branch protection on `main`".
- **Why interesting:** Adds the second of two §11.1 #7 mitigations as a defense-in-depth layer. "The platform refuses" is more robust than "the agent refuses" if Hermes's operating contract is ever misinterpreted or bypassed.
- **Trigger:** Hermes attempts a direct push to `main` (near-miss), OR Hermes graduates supervised mode at Day 30, OR a second human gains write access to the repo, OR operations.md cost capacity makes $4–8/mo affordable without trade-off.
- **Surfaced:** 2026-06-02 during Spec 3 execution.

---

## Business model

### Vertical-specific API tiers with domain routing
**Priority:** Low · **Blocks:** none

Pricing tiers that map to domain-specific routing (medical, legal, gaming, dating). Each domain has its own fine-tuned model variant or system-prompt addition. Higher-tier customers get higher-quality output for their vertical.
- **Why interesting:** Natural pricing structure that aligns price with delivered value.
- **Trigger:** Phase 6 going well enough to think about pricing tiers.

### Corrections-data revenue share
**Priority:** Low · **Blocks:** none

Tenants who opt in to the shared corrections pool get a price discount. The `shared` ownership tier on `translation_corrections` exists for this. Effectively, customers who contribute data subsidize their own usage.
- **Why interesting:** Self-funding data acquisition at scale.
- **Trigger:** Phase 6; second or third B2B customer onboarded.

### Consumer chat app monetization
**Priority:** Low · **Blocks:** none

Stay free? Freemium with paid tier (priority routing, unlimited messages, premium translations)? Ad-supported? B2C subscription? All open questions.
- **Why interesting:** Eventually need to decide. Strong case for staying free as a data-generation vehicle, but real money would help.
- **Trigger:** Consumer app has retention proven; clear signal on user willingness to pay.

### Target verticals beyond the primary ones
**Priority:** Low · **Blocks:** none

Education (language-learning platforms), publishing (in-flow document translation), travel apps, accessibility (sign-language pipelines?), interpreter staffing tools. Many adjacencies once translation quality is proven.
- **Trigger:** Two named verticals landed (dating + one other), free capacity to explore.

---

## Identity, discovery & social graph (deferred)

> Structural prep for these lands in Phase 2 (normalized discovery handles, contact graph,
> invite primitive). The items below are features built on top of that structure, deferred
> until later phases.
>
> **Substrate status (2026-06-10):** the structural pieces these features sit on have now shipped.
> Migration 010 (Step 4) added the normalized discovery handles + discovery RPCs; migration 011
> (Step 5) added the canonical-pair contact graph (`relationships`), the `invites` +
> `invite_redemptions` deep-link primitive, and the `blocks` / `reports` safety tables. The items
> below remain deferred — only their substrate exists now, not the user-facing features.

### Friend-code discovery handle
**Priority:** Low · **Blocks:** none

A short, shareable, non-PII code (BattleTag / Snapchat-style) users can hand out in person or
embed in a QR code, distinct from username and email.
- **Why interesting:** Stable shareable identifier that isn't PII and isn't tied to the
  username namespace. Trivial to add given the normalized discovery-handle table.
- **Trigger:** When in-person / QR adding becomes desirable (likely alongside mobile).

### Phone number + address-book contact matching
**Priority:** Low · **Blocks:** none

Phone as a discovery handle plus contact-list matching (the WhatsApp/Signal growth mechanic).
- **Why interesting:** Best zero-friction discovery and strongest anti-spam signal (numbers
  are costly to acquire).
- **Why deferred:** Heavy privacy ask + SMS verification infra; conflicts with the low-friction,
  email-first onboarding. Phone is modeled as a possible handle type but not collected.
- **Trigger:** Mobile (Phase 5), or a spam problem that email-add gating can't contain.

### QR codes for add / invite
**Priority:** Low · **Blocks:** none

A client-side feature that encodes an invite link or friend-code as a QR image for in-person adds.
- **Why interesting:** Pure presentation layer over the invite-link / friend-code primitives —
  no schema cost.
- **Trigger:** In-person sharing flows or mobile.

### Per-tenant reserved-word seed automation
**Priority:** Low · **Blocks:** none

Reserved usernames (role/system terms, brand, profanity) are seeded as `reserved` rows in
`account_identifiers` per tenant. Migration 007 seeded them for the **sole tenant** by a hardcoded
INSERT; migration 010's `change_username` only enforces against existing rows. A second tenant
would currently get **no** reserved set. Deferred: a reusable seeding routine (a function called at
tenant-create, or a trigger) that stamps the `lib/policies.js RESERVED_WORDS` list into any new
tenant.
- **Why deferred:** Single tenant today; no second-tenant create path exists yet.
- **Trigger:** Tenant #2 (the same event that forces the Model-A vs Model-B and email-uniqueness calls).

### Original-case username display
**Priority:** Low · **Blocks:** none

`profiles.username` and the `account_identifiers` value store the **canonical lowercase** form
only; uniqueness is case-insensitive. policies.md §1 allows display to preserve original case
("DjangoFan" shown, `djangofan` enforced), but we don't persist the original casing anywhere.
Deferred: a `username_display` column (or storing the as-entered form on the identifier row) if
preserved capitalization becomes a wanted nicety.
- **Why deferred:** Cosmetic; lowercase handles are fine at this stage and avoid an extra column.
- **Trigger:** Users ask for cased handles, or a vanity-handle / verification feature makes casing matter.

### Username timed-release / contact-the-holder reclaim
**Priority:** Low · **Blocks:** none

Usernames are non-reusable by default. A future mechanism could release a retired/squatted
username after N years, or let a requester ask the current holder to release it.
- **Why interesting:** Recovers desirable handles without enabling impersonation of a prior holder.
- **Trigger:** Username squatting becomes a real problem worth operational effort.

### User verification feature (the mechanism, not the flag)
**Priority:** Low · **Blocks:** none

The schema carries an `is_verified` flag and a `verification_method` field from Phase 2, but the
actual ways a user becomes verified (linking an external platform, a manual review, a paid check,
etc.) are unbuilt. Verification also activates the "allow if verified" DM-permission tiers.
- **Why interesting:** Anti-impersonation defense + unlocks higher-trust DM permissions.
- **Trigger:** Impersonation reports rise, a public/known user joins, or a tenant wants a
  verified tier.

### Rate-limit counters (performance optimization)
**Priority:** Low · **Blocks:** none

Rate limiting itself is parked, but note: every action table (relationships, invites,
invite_redemptions, reports, username changes) already carries actor + timestamp + tenant_id, so
rates are computable retroactively with no schema change. A dedicated counters/buckets table would
only be a performance optimization if live rate checks get expensive.
- **Trigger:** Live rate-limit enforcement is built and per-request count queries become a hotspot.

---

## Markets we deliberately deferred

### The at-risk user market (LGBTQ+ in criminalizing countries)
**Priority:** Low · **Blocks:** none

A potential market where the product would serve users whose safety depends on metadata privacy and content secrecy. Real demand exists. Building this responsibly requires:
- Genuine E2EE (not performative). Use audited libraries (libsodium, Signal Protocol). Never roll our own crypto.
- Minimal metadata collection — who talked to whom is as dangerous as content.
- Anonymous account creation; no phone number required.
- Plausible deniability in the app's presentation.
- A formal security audit before claiming to users.
- Acknowledged ethical responsibility — these users' lives can depend on us not screwing up.

**Why parked, not on the roadmap:** This is a separate product with separate requirements, not a feature of the main app. It also raises operational and legal questions that need to be answered before serious work, not during it.

**Trigger to reconsider:** Either (a) the company is in a position to dedicate genuine resources and ethical seriousness to this, or (b) a clear partner with the operational maturity to bear most of the risk emerges.

### On-device translation
**Priority:** Low · **Blocks:** none

The clean architectural resolution to the E2EE / AI-translation tension. Translation happens on the user's device; plaintext never leaves.
- **Why interesting:** Solves a fundamental architectural conflict. Privacy positioning becomes uncomplicated.
- **Why hard:** Significant engineering investment. Either we ship a smaller model that runs locally (quality risk) or we wait for hardware/OS support for the larger models (timing risk).
- **Trigger:** Version 3+ of the product. Not before mobile is shipped. Not before E2EE concerns become commercially important.

---

## Research and exploration (not commitments)

### What the per-user linguistic profile *could* eventually track beyond what's in the schema
**Priority:** Low · **Blocks:** none

- Personality-level signals (verbose vs terse, formal vs playful baseline)
- Topic affinity (this user talks about food more than work)
- Code-switching patterns (when they mix languages and why)
- Time-of-day register shifts (more formal in mornings, casual at night?)
- Mood signals from punctuation, capitalization, and emoji density

None of these are obvious wins. Worth experimentation when we have data to experiment on.

### What the per-conversation context *could* eventually track
**Priority:** Low · **Blocks:** none

- Trajectory of relationship closeness over time, not just current state
- Dominant emotional tone (collaborative, conflictual, supportive)
- Power dynamics (who initiates, who responds)
- Topic flow (this conversation moved from work to personal — register should shift)

Same caveat as above. Speculative.

### "Translation as conversation partner" thesis
**Priority:** Low · **Blocks:** none

A more ambitious framing: the translation engine isn't just rendering A→B, it's an active participant maintaining conversational coherence. It would notice when the literal translation misses the social meaning, when register shifts, when one party's English is failing them. Surfaces those moments to the user.
- **Why parked:** Big product change, unclear demand, ambiguous UX.
- **Trigger:** Translation quality is solved and we're hunting the next product direction.

---

## Resolved & graduated

*Items that shipped, were built, or were promoted to the roadmap. Kept for history + design detail; not active work. See each item's `decisions.md` link for the resolution.*

### Sign-out control: relocate to a menu + confirm + fix mobile kebab overlap
**→ RESOLVED 2026-06-23** (roadmap Phase 2.2): confirmation guard added + sign-out moved into a persistent top app bar (both viewports), which fixes the mobile overlap directly — chosen over the "relocate into a menu" option. Kept here for history.
The sign-out button sits exposed in the top-right of the header. Two problems: (1) **bug — on phone widths it overlaps the conversation kebab (⋯) button**, so a tap meant for the overflow menu can hit sign-out and force an unintended logout; (2) it doesn't follow common pattern — destructive/account actions belong tucked into an account or overflow menu, not a one-tap header button.
- **Minimum first step (cheap, do first):** add a **confirmation prompt** before signing out ("Sign out?") so an accidental tap can't force a logout — this defuses the bug's worst outcome even before the layout is fixed.
- **Proper fix:** move sign-out into a standard account/avatar menu (or the overflow menu), following best-practice placement, which also resolves the mobile overlap by getting it out of the kebab's tap target.
- **Why it matters:** the overlap is a real bug (accidental forced sign-out on mobile), not just polish — and given there's no persistent session yet (see next item), a forced sign-out currently means a full magic-link round-trip to get back in.
- **Trigger:** next frontend/UX pass; the confirmation prompt is small enough to pull forward on its own. Pairs naturally with the persistent-login item below.
- **Surfaced:** 2026-06-18 (Isaac), reviewing the Phase 3 conversation-aware header on mobile.

### Persistent login / stay signed in across refresh & tabs
**→ PROMOTED to roadmap.md Phase 2.2 (2026-06-23).** Kept here for the full design detail.
Keep a user signed in for a period on the same browser — surviving page refreshes, new tabs, and returning later — rather than requiring a fresh magic link each time.
- **Why interesting:** magic-link is the only sign-in path, so every dropped session costs an email round-trip (and bumps the ~2/hr built-in email cap — see "Custom transactional email" above). Persistent sessions are table stakes for a chat app and remove most of that friction.
- **Likely-cheaper-than-it-sounds:** Supabase Auth already persists the session in `localStorage` and auto-refreshes tokens **by default** (`persistSession` + `autoRefreshToken` in the client config). So "stay logged in across refresh/new tab" may be largely a matter of confirming those defaults are on in `src/lib/supabase.js` and tuning the session/refresh-token lifetime in the Supabase Auth settings — not a from-scratch build. First step is to verify current behavior before scoping work.
- **Related:** pairs with the sign-out item above (don't make logout a one-tap accident if sessions are meant to persist); and with custom SMTP (fewer logins = less email pressure).
- **Trigger:** next auth/UX pass, or whenever the re-login friction is felt in testing. Start by checking the current `supabase.js` client options + Auth session-duration settings.
- **Surfaced:** 2026-06-18 (Isaac).

### Apply finalized brand (colors, Outfit wordmark, logo) to the product frontend — RESOLVED
~~The violet/teal color system, Outfit wordmark, and wave-seam logo (decisions.md 2026-07-02) are only applied to the standalone `jistchat-landing.html` case-study page so far. The actual chat app (`/V1/src`, `tailwind.config.js`) still uses its pre-brand styling.~~
- **Resolved 2026-07-02** (same day, follow-up session): all former `indigo-*` Tailwind classes swapped to `violet-*` (no config change needed — the hex values match Tailwind's stock palette exactly), and the top app bar's plain-text logo replaced with the icon (+ wordmark on `sm:` and up). Done on branch `branding/violet-teal-outfit`, staged for Isaac to review/merge. See decisions.md 2026-07-02 "Brand rollout to the product frontend."
- **Surfaced:** 2026-07-02, during the logo/wordmark design session (see decisions.md same date).

### ~~`nonbinary` gender signal regressed out of the schema in migration 008~~ → RESOLVED 2026-06-10 (restored via migration 009)
**Resolution:** Isaac chose to restore. `009_restore_nonbinary_gender_signal.sql` re-adds `nonbinary` to the `ulp_gender_check` CHECK, realigning with migration 003 + decisions.md 2026-05-12. Run on staging, **and replayed on prod 2026-06-11 in the Phase 2 cutover — `ulp_gender_check` now includes `nonbinary` on prod (fully closed).** Original write-up kept below for history.

Migration 003 (`003_prompt_version_and_gender_nonbinary.sql`) deliberately expanded the `gender_signal` enum to include `nonbinary`. When migration 008 **recreated** `user_linguistic_profiles` during the identity cutover, the new `CHECK` constraint is `gender_signal IN ('masculine','feminine','neutral','unknown')` — **`nonbinary` was dropped**. So on staging, any attempt to write `gender_signal='nonbinary'` (explicit *or* inferred) now violates the CHECK and errors. architecture.md §7 still documents `nonbinary` as a supported value, so this is both a schema regression and a doc/intent mismatch.
- **Why it matters:** Quiet loss of a value the product explicitly chose to support (003 was named for it). Right now low blast-radius (inference writes `masculine|feminine|neutral|unknown`; no UI sets `nonbinary` yet), but it'll surface the moment explicit gender-identity setting or richer inference ships — as a hard write error, not a graceful fallback. It also ships to prod inside the 008 cutover unless caught.
- **Open question (needs Isaac's call):** was dropping `nonbinary` intentional (e.g. inference can't reliably distinguish it from `neutral`, so it was folded out) or an oversight in the 008 rewrite? The two fixes diverge: (a) **restore it** — add `nonbinary` back to the 008 CHECK (a small `009_` migration on staging before the prod cutover), realigning with 003 + architecture.md; or (b) **ratify the drop** — update 003's intent note, architecture.md §7, and decisions.md to record that `nonbinary` is deliberately not stored, and document how non-binary speakers are represented instead.
- **Fix when:** before the Phase 2 prod cutover (cheapest to settle while still staging-only). Either path is a one-liner + doc sync.
- **Surfaced:** 2026-06-10, Cowork docs-audit reconciling architecture.md against shipped migrations 007/008.

### Autonomous test harness for agent-driven builds
*[Promoted to roadmap 2026-06-09 → Spec 5 (approved).]*

A scripted, repeatable test conversation that an agent (e.g. Hermes) can run end-to-end without human involvement: create two test users, exchange a fixed set of messages across a known language pair, then assert specific outcomes — translation quality within acceptable range, correct profile inference (right dialect for the Spanish speaker, no dialect bleed onto the English speaker), no duplicate messages, event log clean. Currently testing requires a human to manually run the conversation and eyeball the Supabase tables.
- **Why interesting:** Required infrastructure before an autonomous agent can safely build and deploy. Without it, the agent has no way to verify a change didn't break translation quality or inference logic.
- **Implementation sketch:** A Node.js script (or Supabase edge function) that drives the chat API directly, inserts messages as named test users, then queries the DB and asserts against expected values. Could also drive the UI via browser automation for a fuller end-to-end check.
- **Depends on:** Staging environment (can't run destructive test scripts against prod). Prioritise staging first, then this.
- **Trigger:** Before onboarding any autonomous build agent. Also useful for regression testing after prompt version bumps.

### Move profile inference to server-side (client-side path is now DEAD under Phase 2 RLS)
> **[BUILT 2026-06-10 — Option A shipped.]** `POST /api/v1/infer-profile` (Express + Vercel) + `server/lib/inferProfile.js` (raw pg, `SELECT … FOR UPDATE`); client fires-and-forgets `message_id`; flag renamed `PROFILE_INFERENCE_ENABLED` and flipped on. Trust boundary = message_id (server derives authoritative sender). See `decisions.md` 2026-06-10 "Server-side profile inference (Option A)" and `verification.md` "Server-side profile inference". Kept here (not deleted) for the historical build spec below.

Profile inference (`applyInferences`) ran in each viewer's browser when they translated a message. Original Phase 1 problems: (a) multiple viewers watching the same conversation fire simultaneous writes to the same profile row with no coordination — race condition; (b) the dialect consistency guard relies on `message.source_language` being correct, which is good enough for Phase 1 but is a dependency on detect-call accuracy at send time; (c) inference logic lives in client code, harder to evolve, instrument, or audit.

**Phase 2 escalated this from "race-prone" to "non-functional."** Migration 008 put RLS on `user_linguistic_profiles` and `user_profile_events` restricting writes to `user_id = auth.uid()`. But `applyInferences` only ever runs for *other* users' messages (your own skip translation), so every write is denied by RLS. As of the Step 2 review (2026-06-10) the call is gated off behind `CLIENT_SIDE_INFERENCE_ENABLED = false` in `App.jsx` to stop the doomed writes from logging a console error per translated message. **Net effect: no profile inference happens at all right now.** The dialect/formality/gender columns will never populate until this moves server-side.

The right architecture is a server-side function (Supabase edge function or a dedicated `/api/v1/infer-profile` endpoint) that receives the inference payload, applies the guards, and writes atomically — running with a service role so RLS doesn't block legitimate cross-user profile writes. Client fires and forgets to that endpoint; profile updates are serialized. Flipping `CLIENT_SIDE_INFERENCE_ENABLED` back on without that endpoint will NOT work — the writes are RLS-blocked regardless.

- **Strategic weight:** the data flywheel is the stated point of Phase 1 (consumer app as data-generation vehicle). With inference off, the linguistic-profile half of the flywheel isn't turning. This is the strongest argument for promoting this item onto the roadmap rather than leaving it parked — it's not just tech debt, it's a paused core mechanic.
- **Why parked (historically):** Phase 1 scope; client-side was simpler to ship and the race was low-impact at two users.
- **Trigger:** Promote when we want the flywheel actually generating profile data — which, given the strategy, is plausibly *now* / early Phase 2 rather than "before the API opens." At minimum, make a deliberate call on timing rather than letting it drift. The phase2-implementation.md plan (now archived to `docs/archive/retired/`) already lists "server-side profile inference" as a separable workstream that can run in parallel after Step 1.

#### Build spec — Option A (decided 2026-06-10, build directly in Cowork)
We chose **Option A: dedicated `/api/v1/infer-profile` endpoint with a service-role client**, over Option B (fold inference into the translate path) and Option C (Postgres trigger/RPC). Reasoning: keeps the translation layer clean for the B2B story (layer separation), keeps the inference logic in JS where it already lives (relocate, don't rewrite), and fixes the race condition for free by moving the read+write server-side. Build directly in Cowork (not a Hermes spec) because it touches the trust boundary and the race condition — both judgment calls.

Implementation steps:
1. **New route `POST /api/v1/infer-profile`**, mirroring `/api/v1/translate`. Must exist in *both* `server/index.js` (local Express dev server) and `api/v1/infer-profile.js` (Vercel serverless) — same dual structure as translate, or it works locally and 404s in prod.
2. **Service-role Supabase client**, server-only. New env var `SUPABASE_SERVICE_ROLE_KEY` in `server/.env` next to `OPENAI_API_KEY`. NEVER give it a `VITE_` prefix — that ships it to the browser and hands every visitor full DB access. Lazy-init pattern like `server/lib/events.js`.
3. **Lift `applyInferences` server-side** (currently App.jsx ~lines 98–205) essentially verbatim — confidence threshold, dialect-consistency guard, never-overwrite-explicit, confidence-must-increase. One change: it currently *receives* `currentProfile` from the client; instead the server fetches the sender's current profile row itself via the service-role client. That server-side read-then-write is also the race fix.
4. **Trust boundary (DECISION REQUIRED at build time):** with the service-role key, RLS no longer protects against a malicious client POSTing arbitrary inferences for any `senderId` → profile poisoning. Three options: (1) client sends `message_id` not `senderId`; server looks up the message row, derives authoritative `sender_id` + `tenant_id`, ignores client-supplied identity — closes identity spoofing, still trusts the `inferences` payload, cheap, RECOMMENDED; (2) re-generate inferences server-side from message text — fully closes it but drifts into Option B and couples the layers; (3) accept for now, single-tenant, document — fine for testing only. **Recommend (1).** Log the chosen option in `decisions.md`.
5. **Race condition:** wrap the read+write in a transaction with `SELECT ... FOR UPDATE` on the profile row so concurrent inferences for the same sender serialize instead of last-write-wins clobbering. ~15 lines.
6. **Client change:** call site (App.jsx ~line 329) becomes a fire-and-forget `fetch('/api/v1/infer-profile', ...)` instead of direct Supabase writes. Remove the direct `user_linguistic_profiles` / `user_profile_events` writes from `applyInferences` on the client (the whole helper leaves the client). Rename `CLIENT_SIDE_INFERENCE_ENABLED` → `PROFILE_INFERENCE_ENABLED` and flip to `true` once the endpoint is live.
7. **Resolves the sibling item below** ("Dialect consistency guard uses stored `source_language`") — handle both in the same migration per its trigger note.
8. **Docs in the same commit:** `decisions.md` entry for Option A + the trust-boundary choice; remove/mark this parking-lot item as built; add a `verification.md` gate (two users, confirm a profile row actually updates + an event row lands).

Estimate: ~5–6 hours focused (≈ most of a working day with context-switching). Trust-boundary option (2) instead of (1) adds a few hours + a layer-separation debate.

### Dialect consistency guard uses stored `source_language`, not live re-detection
> **[BUILT 2026-06-10 — resolved with the server-side inference move above.]** The guard now runs in `server/lib/inferProfile.js` and anchors on the authoritative server-read `source_language` (no longer a client-supplied value), falling back to the live translate-time `detected_language` only when the stored code is missing/`unknown`. Closes both edge cases (a: legacy `unknown`; b: wrong original detect).

The guard preventing cross-language dialect contamination (e.g. `es-AR` being written to an English speaker's profile) currently uses `message.source_language` as its reference — the BCP 47 code stored in the DB when the sender originally sent the message. This is correct and reliable for new messages, but has two edge cases: (a) legacy messages with `source_language = 'unknown'` will conservatively block all dialect inference (right behavior, but means some early test messages never build a profile); (b) the original detect call could theoretically have been wrong, making `source_language` the wrong anchor. These are acceptable for Phase 1; ideally the server-side inference move (above) would validate language consistency against the live translate response instead of relying on the stored code.

- **Trigger:** Server-side inference migration. Resolve both issues at once.

### ~~Vestigial columns on `messages` + `architecture.md` §7 doc drift~~ → RESOLVED 2026-06-11 (dropped via migration 014)
The 7 vestigial `messages` columns (`room_id`, `translated_text`, `target_language`, `tone`, `context_id`, `model_version`, `latency_ms`) are **dropped by migration 014** (forward-schema prep), and `architecture.md` §7 now documents the cleaned-up schema. Resolution chose option 1 (drop, not just document) because the pre-cutover empty-prod window made it cheap and an `ALTER … DROP COLUMN` keeps staging + prod matched. Pre-flight confirmed all 7 are superseded elsewhere (telemetry → `translation_events`; cache → `message_translations`; conversation mapping → `conversation_id` + `conversation_contexts`) and unread by live code. See decisions.md 2026-06-11 "Forward-schema prep before prod cutover".

### Punctuation and formatting fidelity in translations — RESOLVED 2026-07-05
**RESOLVED:** shipped as part of prompt v2.0.0 (gpt-5.4 swap). The rewritten system prompt includes a texting-conventions rule (mirror missing final periods/capitals, convert casual laughter, pass emoji through, never make a message more formal or "correct" than the original). See decisions.md 2026-07-05. Original item below for history.

The translation output should preserve the sender's punctuation style exactly — if they didn't end a sentence with a period, the translation shouldn't add one; if they used an ellipsis mid-thought, that carries emotional meaning and should be preserved. More broadly, the model should not introduce punctuation or formatting that wasn't in the source (em dashes are a common AI tell). This is a prompt-level fix: explicit instructions not to add, remove, or substitute punctuation beyond what's grammatically required in the target language.
- **Why interesting:** Punctuation is a register and tone signal. A missing period is casual; a period makes it formal. Unauthorised em dashes make translations feel AI-generated rather than human. Both undermine the product's core promise.
- **Implementation sketch:** Add a rule to the translate system prompt: "Preserve the sender's punctuation exactly. Do not add terminal punctuation if absent in the source. Do not introduce em dashes, ellipses, or other punctuation not present in the original." Bump PROMPT_VERSION on change.
- **Trigger:** Any point — this is a low-effort, high-signal prompt tweak. Good candidate for the next PROMPT_VERSION increment once Phase 1 testing is complete.

### Custom transactional email (SMTP) + sending domain
**→ RESOLVED / BUILT 2026-06-23** (promoted to Phase 2.2, then shipped): Resend on `jistchat.com`, DNS verified, Supabase SMTP configured + rate limit raised, test magic link delivered from the domain. Domain strategy in decisions.md 2026-06-23 "Sending domain now, rebrand later". Kept here for the full design/provider detail + the re-prompt/CRM email follow-on it unblocks.
Replace Supabase's **built-in** email service (used for magic-link / OTP delivery) with a real transactional-email provider (Resend, Postmark, SendGrid, AWS SES, Mailgun) on a verified sending domain, configured under Supabase → Authentication → SMTP settings.
- **Why interesting / why it matters now:** Supabase's built-in email is deliberately throttled (~2–4 emails/hour) and meant only for development. It **capped the Phase 3 prod cutover smoke to 2 users** (couldn't onboard the 3rd-user / group flows in one window — 2026-06-18). More importantly it's a **real production blocker for onboarding actual testers** — magic-link auth is the only sign-in path, so the email limit *is* the signup limit. A verified domain + provider raises the limit to thousands/day and is the production-correct fix.
- **Bonus unblock:** also resolves the standing blocker on the parked **re-prompt / lifecycle email** work ("Pending-account re-prompt UX" + decisions.md 2026-06-10 Step 6 noted "no sending domain yet" as the reason that half was parked → future CRM). Once a sending domain exists, day-3/day-14 re-prompt email becomes buildable.
- **Shape (when built):** pick a provider (Resend = lightest lift, generous free tier; SES = cheapest at scale), verify a sending domain (SPF/DKIM/DMARC DNS records), set the SMTP creds in Supabase Auth, raise the Auth email rate limit, re-test the magic-link flow end-to-end. Then optionally complete the deferred 3rd-user/group prod smoke from the Phase 3 cutover.
- **Interim testing bypass (no prod change):** for smoke tests, mint magic links via the service-role `auth.admin.generateLink()` (returns the link without sending email → no SMTP, no rate limit). Considered for the 2026-06-18 cutover; deferred in favor of a 2-user smoke. Keep in mind for the deferred 3rd-user/group run if custom SMTP isn't up yet.
- **Trigger:** before sharing the app with real testers (the Phase 2 "shareable without the email limit biting" intent), or when the deferred Phase 3 group smoke needs >2 users, or when re-prompt/CRM email is picked up. Its own small spec + a DNS/verification step.
- **Surfaced:** 2026-06-18, during the Phase 3 prod cutover smoke (magic-link rate limit).

### Conversation switcher / inbox IA (multi-conversation navigation) — RESOLVED (backbone shipped)

**Resolved 2026-07-07:** the navigation backbone shipped in the Phase 3 conversation-aware frontend — `ConversationList.jsx` (inbox + switch), wired in `App.jsx`. The two remaining sub-parts from this item's scope — **unread state** and **message-history search** — are split into their own parking-lot items (Med). Original write-up kept for history.

The app currently has no interface to list, search, or switch between conversations — it shows a
single chat. Once discovery (Step 4) and contacts (Step 5) let a user have multiple counterparties,
the app needs the standard chat-client information architecture: an inbox/thread list, switching
between conversations, unread state, and eventually message-history search. **Distinct from
discovery search** — discovery finds *people to add*; this navigates *conversations you're already
in*. The two share the word "search" but are different surfaces with different backends.
- **Why interesting:** It's the navigational backbone every multi-conversation chat app needs; once
  there's more than one conversation per user, its absence is immediately felt.
- **Why deferred:** It's information-architecture over the conversation/membership model, which isn't
  fleshed out yet (conversations are membership-based and independent of the contact graph —
  policies.md §3). Designing a switcher before that model is settled is premature. It's also its own
  design session, not presentation-layer polish — bigger than the "UI improvements" holding pen
  above.
- **Trigger:** The conversation/membership model lands (Phase 3 conversation work), or contacts
  (Step 5) make multi-conversation real. Open it as a dedicated design conversation at that point.
- **Surfaced:** 2026-06-10, while scoping how/when to wire the Step 4 discovery RPCs to the app layer.

---

## How to use this doc

- Add new ideas freely, even half-baked ones. Capture them; refine later.
- When something here gets committed to a phase in `roadmap.md`, remove it from here (or annotate "promoted to roadmap on YYYY-MM-DD").
- When something here is conclusively rejected, remove it (or annotate "killed on YYYY-MM-DD because X").
- **Priority & Blocks (convention since 2026-07-07, reverses the prior "don't prioritize here" rule).** Every item carries a `**Priority:** High/Med/Low · **Blocks:** <stage | none>` line under its heading. *Priority* = rough urgency; *Blocks* = a build stage this gates (most items block nothing — they're *triggered by* a phase, not blockers of it). Set these when adding an item; revisit in review. Detailed effort estimation still lives in the roadmap / implementation conversations, not here.
- This file should grow over time. If it stops growing, we've stopped thinking creatively.


---

## Changelog

*Reverse chronological. One line per change; project events link to `decisions.md`.*

- **2026-07-07** — Reviewed with Isaac: added invite-to-app + custom-email items (High); promoted the account-settings screen, native-name/expanded languages, and conversation-list realtime to roadmap Phase 2.4; kept UI-localization + language-not-found parked at High; moved the conversation switcher to Resolved (unread + search split out); bumped the RLS-gaps item to High and added the no-RLS-on-`tenants`/event-tables finding. (→ decisions.md 2026-07-07 "Roadmap promotions + RLS gap")
- **2026-07-07** — Docs legibility cleanup: header de-blobbed; **Priority/Blocks** convention added (reverses the prior "don't prioritize here" rule); resolved/built/promoted items swept into "Resolved & graduated." (→ decisions.md 2026-07-07 "Docs legibility cleanup + new conventions")
- **2026-07-02** — "Apply finalized brand to the product frontend" added, then RESOLVED same day. (→ decisions.md 2026-07-02)
- **2026-06-23** — Promoted SMTP + persistent-login + sign-out control to roadmap Phase 2.2. (→ decisions.md 2026-06-23)
- **2026-06-18** — Added ghost-conversation, custom-SMTP, sign-out, and persistent-login items (Phase 3 cutover follow-ups). (→ decisions.md 2026-06-18)
- **2026-06-12** — Added tenant-scoped option registry + conversation threads. (→ decisions.md 2026-06-12)
- **2026-06-11** — Added `email_hash_abuse` source-split item (Step 7). (→ decisions.md 2026-06-11)
- **2026-06-10** — Phase 2 Step 4/5/6 items added; profile-inference built (Option A); `nonbinary` resolved; RLS/validation gaps logged. (→ decisions.md 2026-06-10)
- **2026-06-09** — Added identity/discovery/social-graph section; consolidated UI improvements; onboarding funnel events.
