# Translation App — Parking Lot

> Living document. Holds every idea that isn't on the active roadmap but is worth not forgetting. Add to this freely. Promote items into `roadmap.md` when they get committed.
>
> Format: each item has a short description, a "why interesting" note, and (if relevant) a "trigger" — the condition under which it should be reconsidered for the roadmap.

**Last updated:** 2026-06-09 (added "Identity, discovery & social graph (deferred)" section — friend-code, phone/contact-matching, QR, username reclaim, verification feature, rate-limit counters — during Phase 2 identity/discovery design.)

---

## Product features

### Language preference as account setting, not session toggle
The language selector is currently in the chat header — accessible mid-conversation. This makes it easy to accidentally trigger a full re-translation of chat history and burn credits. Language preference should live in user account/profile settings and be changed deliberately, not casually.
- **Why interesting:** Prevents unintended credit burn; better UX signal — language is a stable identity attribute, not a per-session mode.
- **Trigger:** Phase 2 (real auth + user profiles). Natural moment to move this out of the header and into a settings screen.

### Context type: auto-inferred, not manually set
The context-type dropdown (casual / dating / professional / academic) is a useful dev tool but wrong for end users. The right long-term behavior is for context type to be inferred automatically from conversation content — which is what `conversation_contexts` (Phase 3) is designed for. API clients (B2B) should be able to set it explicitly per-conversation. The manual UI toggle can be removed once auto-inference is wired.
- **Why interesting:** Removes a decision users shouldn't have to make; auto-inference is a better product and a better API.
- **Related:** `conversation_contexts` table already exists from Phase 1 schema. The inference logic and background job are the missing pieces.
- **Trigger:** Phase 3 (conversation model). The `conversation_contexts` table is the natural home for this; wiring the inference job is Phase 3 work.

### Lazy / proximity-based translation on language change
When a user changes their preferred language, only translate messages as they are viewed (or as they approach the viewport), rather than immediately re-translating the entire chat history. This prevents a language toggle from triggering a large batch of OpenAI calls on a long conversation.
- **Why interesting:** Eliminates a credit-burn and latency spike that scales linearly with conversation length. More importantly, it's the architecturally correct behavior — translation is a view-time concern, not a state-change concern.
- **Implementation sketch:** Track scroll position; only fire translate calls for messages within N pixels of the viewport. Messages outside the viewport stay in their cached state until scrolled into range. Already partially aligned with MessageBubble's per-message translate model — needs a visibility/intersection observer rather than a dep-array trigger.
- **Trigger:** Language preference is moved to account settings (above). These two should ship together since they address the same root cause.

### Voice translation and audio messages
Real-time spoken-to-spoken translation, or voice-note translation in chat. Audio in one language, transcript + audio out in another. The user-facing equivalent of what we do for text.
- **Why interesting:** Audio is how most people actually communicate over distance with people they're close to. Text-only is a real limitation for the consumer chat product.
- **Trigger:** Consumer chat has meaningful active-user retention; text translation quality is proven.

### Voice cloning (preserve sender's voice in translated audio)
Translation that sounds like the sender, not a generic TTS voice.
- **Why interesting:** Intent app is doing this and it's a meaningful product moat. Emotionally resonant for the dating use case.
- **Trigger:** Voice translation is shipped; user testing confirms voice identity matters in the use cases we care about.

### Cultural interpretation layer
Inline explanation of cultural references the translation cannot fully convey ("the speaker is making a reference to a Brazilian children's TV show…"). Optional, surfaced as a footnote-style annotation.
- **Why interesting:** Translation is one thing, comprehension is another. This is the "natural-sounding" thesis extended.
- **Trigger:** Translation quality is solved; user research surfaces "I don't get what they meant" as a real friction even with good translations.

### Conversation memory across conversations
The model remembers things about the user from past conversations (their job, their kids' names, that they hate small talk) and uses that in future translations.
- **Why interesting:** Real personalization beyond linguistic profile. Closer to "talking through a friend" than "talking through a tool."
- **Trigger:** User base demonstrates demand for it; privacy framing solved.

### AI-assisted communication beyond translation
Suggested responses, conversation coaching, tone adjustment ("you sound passive-aggressive, want me to soften this?"). Stretches the product from translation to communication-assistant.
- **Why interesting:** Significant TAM expansion if it lands. Also significant scope creep risk.
- **Trigger:** Translation is unambiguously solved and the product needs a new growth vector.

### User-controllable tone knob
A slider in the UI for how casual / formal / playful the user wants outgoing translations to be, overriding inferred register.
- **Why interesting:** Power users will want this; surface complexity that most users won't need.
- **Trigger:** User research shows enough power users to justify the UI complexity.

### Pre-send clarification UX for ambiguous translations
When the user hits send and the translation API returns `ambiguity.detected: true` with multiple plausible interpretations, intercept before the message goes through and ask the user to pick which interpretation they meant. Especially useful for sarcasm, idioms that have literal alternatives, ambiguous pronouns, and similar cases where surface meaning and intent diverge.
- **Why interesting:** Catches the highest-friction translation failures (sarcasm being read literally, idioms being mistranslated) before they're sent rather than after they cause confusion. Higher signal than post-hoc corrections.
- **API contract is already built for this** — the translate response carries `ambiguity.detected`, `ambiguity.confidence`, and `ambiguity.alternatives` as of Phase 1 (see architecture.md §5). The UX surface is what's parked.
- **Open design questions:** How confident does ambiguity need to be before we interrupt the user? Do we let them dismiss without picking? Do we record their pick as a correction-equivalent (high-signal training data — user disambiguating their own meaning)?
- **Trigger:** Phase 1 ships with the ambiguity signal flowing; we have at least anecdotal data on how often it fires and whether the alternatives are meaningfully different.

### Receiver-side ambiguity hints
The viewer's side of the same feature: when a received translation is flagged ambiguous, the message bubble shows a small indicator and the alternatives are viewable on tap/hover.
- **Why interesting:** Even if the sender didn't clarify, the receiver knows to read carefully. Lower-friction than the send-side intervention.
- **Trigger:** Same as above. Could ship before or after the send-side clarification.

---

## Known technical debt

### Robust testing, QA, and CI process — staged build-out
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

### Autonomous test harness for agent-driven builds
*[Promoted to roadmap 2026-06-09 → Spec 5 (approved).]*

A scripted, repeatable test conversation that an agent (e.g. Hermes) can run end-to-end without human involvement: create two test users, exchange a fixed set of messages across a known language pair, then assert specific outcomes — translation quality within acceptable range, correct profile inference (right dialect for the Spanish speaker, no dialect bleed onto the English speaker), no duplicate messages, event log clean. Currently testing requires a human to manually run the conversation and eyeball the Supabase tables.
- **Why interesting:** Required infrastructure before an autonomous agent can safely build and deploy. Without it, the agent has no way to verify a change didn't break translation quality or inference logic.
- **Implementation sketch:** A Node.js script (or Supabase edge function) that drives the chat API directly, inserts messages as named test users, then queries the DB and asserts against expected values. Could also drive the UI via browser automation for a fuller end-to-end check.
- **Depends on:** Staging environment (can't run destructive test scripts against prod). Prioritise staging first, then this.
- **Trigger:** Before onboarding any autonomous build agent. Also useful for regression testing after prompt version bumps.

### Move profile inference to server-side (current approach is client-side, race-prone)
Profile inference (`applyInferences`) currently runs in each viewer's browser when they translate a message. This means: (a) multiple viewers watching the same conversation fire simultaneous writes to the same profile row with no coordination — race condition; (b) the dialect consistency guard relies on `message.source_language` being correct, which is good enough for Phase 1 but is a dependency on detect-call accuracy at send time; (c) inference logic lives in client code, harder to evolve, instrument, or audit.

The right architecture is a server-side function (Supabase edge function or a dedicated `/api/v1/infer-profile` endpoint) that receives the inference payload, applies the guards, and writes atomically. Client fires and forgets to that endpoint; profile updates are serialized.

- **Why parked:** Phase 1 scope. Client-side inference is simpler to ship and the race condition is low-impact at current scale (two users).
- **Trigger:** Multiple concurrent users or any evidence of race-condition corruption in `user_linguistic_profiles`. Definitely before Phase 2 API opens.

### Dialect consistency guard uses stored `source_language`, not live re-detection
The guard preventing cross-language dialect contamination (e.g. `es-AR` being written to an English speaker's profile) currently uses `message.source_language` as its reference — the BCP 47 code stored in the DB when the sender originally sent the message. This is correct and reliable for new messages, but has two edge cases: (a) legacy messages with `source_language = 'unknown'` will conservatively block all dialect inference (right behavior, but means some early test messages never build a profile); (b) the original detect call could theoretically have been wrong, making `source_language` the wrong anchor. These are acceptable for Phase 1; ideally the server-side inference move (above) would validate language consistency against the live translate response instead of relying on the stored code.

- **Trigger:** Server-side inference migration. Resolve both issues at once.

### Vestigial columns on `messages` + `architecture.md` §7 doc drift
The prod `messages` table has columns that predate the `/migrations/` folder and aren't used by the live code: `room_id` (uuid), `translated_text` (text), `target_language` (text), `tone` (text), `context_id` (text), `model_version` (text, default `'V1'`), `latency_ms` (numeric). All nullable; all ignored by `App.jsx` and the translation pipeline. They survived because removing them was unrelated cleanup work that was never the highest priority.

`architecture.md` §7 documents the *intended* `messages` schema (`id`, `sender_id`, `original_text`, `source_language`, `created_at`) and doesn't mention these extras — so the doc and the actual database disagree. Two reasonable resolutions:

1. **Drop the columns** via a migration. Cleanest end state. Requires a careful pre-flight that nothing reads them (grep confirms no, but a deliberate review before dropping anything is warranted).
2. **Update `architecture.md` §7** to describe the actual schema and explicitly mark these columns as vestigial / unused.

- **Why interesting:** Doc/DB drift is a category of bug that hides until someone (Hermes, a new collaborator, or future you) reads `architecture.md`, trusts it, and is surprised. Either resolution collapses the gap.
- **Surfaced:** 2026-05-18, during staging setup when migration 001 couldn't be run against an empty DB because the base tables it `ALTER`s weren't represented anywhere in the migrations folder. Resolved short-term by writing `000_base_schema.sql` to mirror prod (vestigial columns included), but that codifies the debt rather than removing it.
- **Trigger:** Phase 2 schema work, or anytime we're already doing migrations against `messages`. Strong candidate for an early Hermes task once the agent is online — small, well-bounded, requires careful verification.

### Other config state lives outside `/migrations/` and isn't captured
The `messages`-on-realtime-publication item was originally configured via the Supabase Studio UI. Migration `004_enable_realtime_publication.sql` (2026-05-18) backfilled it. But the broader category of risk remains: other Supabase configuration may exist in prod via UI clicks and not in the migrations folder. Candidate suspects (need an audit pass):

- Realtime publications on other tables (we currently only know `messages` is published)
- RLS policies (none exist yet, but Phase 2 introduces many — they MUST live in migrations from day one)
- Database functions / triggers (none currently expected, but worth checking)
- Storage bucket policies (no Storage usage yet)
- Auth provider config (will become relevant in Phase 2)
- Edge functions (none currently)
- Extensions enabled (e.g. `pg_cron`, `uuid-ossp` — defaults are usually safe but worth confirming)

- **Why interesting:** Doc/DB drift is the same failure mode as the vestigial columns above — anything in prod that isn't in the migrations folder means a fresh deploy (Hermes-driven or otherwise) silently lacks it. The bug usually manifests as "works in prod but not staging," which is a particularly nasty class of bug because staging exists to *prevent* prod surprises.
- **Surfaced:** 2026-05-18, when the staging smoke test revealed realtime wasn't on.
- **Mitigation now:** When introducing new Supabase config (RLS, triggers, etc.), default to capturing in a migration even if also configuring via UI. The migration is the source of truth.
- **Trigger:** Before Phase 2 auth/RLS work begins, do a focused audit of prod Supabase config that isn't in migrations. Easier to catch and codify upfront than chase per-feature.

---

## Translation quality and intelligence

### Punctuation and formatting fidelity in translations
The translation output should preserve the sender's punctuation style exactly — if they didn't end a sentence with a period, the translation shouldn't add one; if they used an ellipsis mid-thought, that carries emotional meaning and should be preserved. More broadly, the model should not introduce punctuation or formatting that wasn't in the source (em dashes are a common AI tell). This is a prompt-level fix: explicit instructions not to add, remove, or substitute punctuation beyond what's grammatically required in the target language.
- **Why interesting:** Punctuation is a register and tone signal. A missing period is casual; a period makes it formal. Unauthorised em dashes make translations feel AI-generated rather than human. Both undermine the product's core promise.
- **Implementation sketch:** Add a rule to the translate system prompt: "Preserve the sender's punctuation exactly. Do not add terminal punctuation if absent in the source. Do not introduce em dashes, ellipses, or other punctuation not present in the original." Bump PROMPT_VERSION on change.
- **Trigger:** Any point — this is a low-effort, high-signal prompt tweak. Good candidate for the next PROMPT_VERSION increment once Phase 1 testing is complete.

### Prompt A/B testing framework
Once `prompt_version` is flowing on every cached translation, the next step is running two prompt variants simultaneously and comparing quality metrics (correction rate, ambiguity detection rate, user thumbs-down rate) between them. Currently `PROMPT_VERSION` is a global constant — a single version runs for all calls. A/B testing would require routing a percentage of calls to an alternate prompt and tagging their cached translations with the variant version.
- **Why interesting:** Closes the loop between prompt changes and measurable quality outcomes. Right now we change the prompt and hope it helped; A/B testing tells us whether it actually did.
- **Depends on:** Phase 4 corrections capture (need the quality signal to measure against). Prompt versioning infrastructure is already in place as of Phase 1 cleanup.
- **Trigger:** Phase 4 is underway and we have enough translation volume to get statistically meaningful split-test results.

### Multi-model AI routing
Per-message routing between cheap and expensive models. Short literal messages go to `gpt-4o-mini`. Long, idiomatic, or context-heavy messages go to `gpt-4o` or a fine-tuned model. 15x cost delta makes this real money at scale.
- **Why interesting:** Cost reduction without quality reduction.
- **Trigger:** Small-scale stage; volume makes the cost difference matter financially.

### Fine-tuning on corrections data
Train a model derived from base + our corrections. The pivot from "we call OpenAI" to "we call our own model" makes the product technically defensible in a way it isn't yet.
- **Why interesting:** This is the actual moat. Until we do this we're a smart wrapper. After we do this we have a proprietary asset.
- **Trigger:** ~50k high-quality correction pairs in the corpus. Estimated cost when ready: $200–800 for the first meaningful training run.

### Cross-model AI audit pipeline
A second AI model (different family from the translator) reviews each translation and flags suspicious output. GPT-4o translates, Claude audits. Same-model auditing has a known blind spot — models agree with themselves. Schema already designed (`translation_reviews`); auto-audit not yet running.
- **Why interesting:** Cheap way to generate medium-quality corrections data at scale without needing human review on every translation.
- **Trigger:** Phase 4 begins (corrections capture). Schema is already there from Phase 1–2.

### DeepSeek as alternative model
$0.14/M tokens vs ~$3/M for Claude Sonnet. Strong on CJK languages. Emerging player worth watching.
- **Why interesting:** Cost reduction; potential quality wins on Asian language pairs.
- **Trigger:** Small-scale stage; evaluate as alternative provider once backend is provably model-agnostic.

### Dialect clustering from corrections
Once corrections from regionally-identified users accumulate, cluster them to discover dialect patterns the base model doesn't know. Map regional preferences for vocabulary, idiom, and pronoun use empirically rather than from linguistics literature.
- **Why interesting:** Differentiated dataset; foundation for region-specific fine-tunes.
- **Trigger:** Corrections corpus is non-trivial (thousands of pairs from multiple regions).

### Internal translation quality benchmark
Curated set of hard translation cases drawn from corrections where generic models fail. Used internally to evaluate new model versions, externally as a sales tool when the API opens.
- **Why interesting:** Quantifies our advantage. Sales tool.
- **Trigger:** Phase 4 underway, corrections corpus large enough to draw a meaningful sample.

### Per-context variation in user linguistic profile elements
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
Beyond the lexical and spelling signals already designed: timestamp/timezone activity patterns, character input patterns (which accented characters used or avoided), IP geolocation (weakest, VPN-vulnerable, used as one signal among many).
- **Why interesting:** More signal sources → better dialect inference.
- **Trigger:** When dialect inference accuracy is measurably weak and we have analytics showing where.

---

## Infrastructure and scale

### Translation deduplication / orchestration layer
A central layer that dedupes identical concurrent translation requests across users. If 50 users in a group chat all need the same Spanish→English translation, the cache solves serial case; an in-flight queue solves the concurrent case.
- **Why interesting:** Prevents N parallel OpenAI calls for the same translation when N users land on a message simultaneously.
- **Trigger:** Real concurrent traffic; identified instances of the race condition causing real cost.

### Idempotency keys on API calls
Standard API practice — a unique key per call so retries don't double-charge.
- **Why interesting:** Required hygiene for any serious API. Cheap to add early.
- **Trigger:** Phase 0–1; reasonable to fold into the API-first work.

### Async / batch translation endpoint
A separate endpoint for clients submitting large batches of text. Returns a job ID; webhook fires when complete.
- **Why interesting:** Enterprise customers will want it. Different cost/latency tradeoff than the synchronous endpoint.
- **Trigger:** First serious B2B customer interest in batch use cases.

### Webhook support architecture
Standard pattern for delivering async results and event notifications.
- **Why interesting:** Required infrastructure for batch translation and probably for billing/usage notifications.
- **Trigger:** Phase 6 (API open).

### SDKs
Client libraries in JavaScript and Python (priority order) that wrap the API. Reduces friction for developer adoption.
- **Why interesting:** Standard API expectation. Could be community-built, but quality SDKs are usually first-party.
- **Trigger:** Phase 6.

### Migration off Vercel / Supabase to dedicated infrastructure
Containerized backend, dedicated Postgres, Redis cache layer, dedicated realtime infrastructure (Ably or Pusher).
- **Why interesting:** Vercel/Supabase scale fine to small-scale; dedicated infrastructure becomes a meaningful cost win and reliability win at high volume.
- **Trigger:** Costs at the Vercel/Supabase tier exceed roughly the equivalent dedicated infrastructure cost, or reliability becomes a customer concern.

### Translation cache normalization
Before computing the cache key, normalize the input: lowercase, whitespace trim, contraction expansion. So `"don't go"` and `"Don't go"` cache as one entry, not two.
- **Why interesting:** Higher cache hit rate, lower cost.
- **Trigger:** Cache hit rate plateaus below expectations.

### Bulk translation-cache lookup
On page load, the frontend currently fires one `GET /rest/v1/message_translations` per existing message in the conversation history. For a chat with N messages, that's N round-trips just to check the cache. Replace with either (a) a single bulk lookup using `message_id=in.(uuid1,uuid2,...)`, or (b) a server-side join so the messages query returns each message's cached translation in one response.
- **Why interesting:** Linear-with-conversation-length network overhead becomes a real load-time problem at scale. Confirmed in the Phase 0 verification HAR: 17 messages → 17 separate cache GETs.
- **Trigger:** Conversations grow past roughly 50 messages, or page load latency becomes a felt problem in testing. Likely candidate for Phase 1 or Phase 3 when we're already restructuring how the frontend talks to the backend.

### Rate limiting and usage metering
Internal first (catch our own bugs that cause runaway calls), external second (billing infrastructure for the API).
- **Why interesting:** Required for the API; useful for the chat app's own safety.
- **Trigger:** Small-scale; before Phase 6.

### Data residency
Where data physically lives matters for some markets (EU, healthcare). Supabase region is `us-east-1` for both prod and staging (confirmed 2026-05-18 in operations.md §4). Entering an EU market or a regulated US healthcare context likely requires either a regional Supabase project or self-hosted Postgres in-region.
- **Why interesting:** Compliance requirement for some verticals.
- **Trigger:** Entering a market with data residency requirements (EU healthcare especially).

### Vercel prod-deploy wrapper script as defense-in-depth
A shell shim that replaces the `vercel` binary and intercepts `--prod` flag calls, requiring out-of-band confirmation before passing through to the real CLI. Adds a structural enforcement layer under the operating-contract layer (§6.2) for prod deploys.
- **Why interesting:** "The platform refuses" is more robust than "the agent refuses" if §6.2 is ever misinterpreted. Same argument as branch protection on GitHub.
- **Why parked:** Option (a) from Spec 3 OQ3 — §6.2 operating-contract only — confirmed working during ST6 negative path. Wrapper adds maintenance surface (must track CLI updates) without clear benefit while Hermes is in supervised mode.
- **Trigger:** Hermes deploys to prod without a §6.2 confirmation (near-miss). That event is the empirical trigger; add immediately on first occurrence.
- **Surfaced:** 2026-06-03, Spec 3 OQ3 resolution.

### Dedicated hermes@ email alias for git commits
Currently Hermes commits with `user.email = 24737689+iwitt1@users.noreply.github.com` (Isaac's GitHub no-reply address). Functional and associates commits with Isaac's account, but blurs attribution between Isaac and Hermes in the git log.
- **Why interesting:** A dedicated `hermes@<domain>` alias would make it immediately obvious which commits were agent-authored vs. human-authored, which matters for auditability as Hermes becomes more active.
- **Trigger:** When you have a custom domain set up, or when agent-authored commits become frequent enough that the attribution blur causes confusion.
- **Surfaced:** 2026-06-03, Spec 3 git config step.

### GitHub branch protection on `main` — paid-tier upgrade
Enable platform-level branch protection on the `main` branch — the structural mitigation charter §11.1 #7 calls out for the "direct-to-main push" failure mode. Both Rulesets and legacy Branch protection rules require GitHub Pro (individual, ~$4/mo) or Team (org, ~$4/user/mo) on private repositories — confirmed 2026-06-02 during Spec 3 execution. Deferred to behavior-enforcement only for now; see `decisions.md` 2026-06-02 entry "Defer structural GitHub branch protection on `main`".
- **Why interesting:** Adds the second of two §11.1 #7 mitigations as a defense-in-depth layer. "The platform refuses" is more robust than "the agent refuses" if Hermes's operating contract is ever misinterpreted or bypassed.
- **Trigger:** Hermes attempts a direct push to `main` (near-miss), OR Hermes graduates supervised mode at Day 30, OR a second human gains write access to the repo, OR operations.md cost capacity makes $4–8/mo affordable without trade-off.
- **Surfaced:** 2026-06-02 during Spec 3 execution.

---

## Business model

### Vertical-specific API tiers with domain routing
Pricing tiers that map to domain-specific routing (medical, legal, gaming, dating). Each domain has its own fine-tuned model variant or system-prompt addition. Higher-tier customers get higher-quality output for their vertical.
- **Why interesting:** Natural pricing structure that aligns price with delivered value.
- **Trigger:** Phase 6 going well enough to think about pricing tiers.

### Corrections-data revenue share
Tenants who opt in to the shared corrections pool get a price discount. The `shared` ownership tier on `translation_corrections` exists for this. Effectively, customers who contribute data subsidize their own usage.
- **Why interesting:** Self-funding data acquisition at scale.
- **Trigger:** Phase 6; second or third B2B customer onboarded.

### Consumer chat app monetization
Stay free? Freemium with paid tier (priority routing, unlimited messages, premium translations)? Ad-supported? B2C subscription? All open questions.
- **Why interesting:** Eventually need to decide. Strong case for staying free as a data-generation vehicle, but real money would help.
- **Trigger:** Consumer app has retention proven; clear signal on user willingness to pay.

### Target verticals beyond the primary ones
Education (language-learning platforms), publishing (in-flow document translation), travel apps, accessibility (sign-language pipelines?), interpreter staffing tools. Many adjacencies once translation quality is proven.
- **Trigger:** Two named verticals landed (dating + one other), free capacity to explore.

---

## Identity, discovery & social graph (deferred)

> Structural prep for these lands in Phase 2 (normalized discovery handles, contact graph,
> invite primitive). The items below are features built on top of that structure, deferred
> until later phases.

### Friend-code discovery handle
A short, shareable, non-PII code (BattleTag / Snapchat-style) users can hand out in person or
embed in a QR code, distinct from username and email.
- **Why interesting:** Stable shareable identifier that isn't PII and isn't tied to the
  username namespace. Trivial to add given the normalized discovery-handle table.
- **Trigger:** When in-person / QR adding becomes desirable (likely alongside mobile).

### Phone number + address-book contact matching
Phone as a discovery handle plus contact-list matching (the WhatsApp/Signal growth mechanic).
- **Why interesting:** Best zero-friction discovery and strongest anti-spam signal (numbers
  are costly to acquire).
- **Why deferred:** Heavy privacy ask + SMS verification infra; conflicts with the low-friction,
  email-first onboarding. Phone is modeled as a possible handle type but not collected.
- **Trigger:** Mobile (Phase 5), or a spam problem that email-add gating can't contain.

### QR codes for add / invite
A client-side feature that encodes an invite link or friend-code as a QR image for in-person adds.
- **Why interesting:** Pure presentation layer over the invite-link / friend-code primitives —
  no schema cost.
- **Trigger:** In-person sharing flows or mobile.

### Username timed-release / contact-the-holder reclaim
Usernames are non-reusable by default. A future mechanism could release a retired/squatted
username after N years, or let a requester ask the current holder to release it.
- **Why interesting:** Recovers desirable handles without enabling impersonation of a prior holder.
- **Trigger:** Username squatting becomes a real problem worth operational effort.

### User verification feature (the mechanism, not the flag)
The schema carries an `is_verified` flag and a `verification_method` field from Phase 2, but the
actual ways a user becomes verified (linking an external platform, a manual review, a paid check,
etc.) are unbuilt. Verification also activates the "allow if verified" DM-permission tiers.
- **Why interesting:** Anti-impersonation defense + unlocks higher-trust DM permissions.
- **Trigger:** Impersonation reports rise, a public/known user joins, or a tenant wants a
  verified tier.

### Rate-limit counters (performance optimization)
Rate limiting itself is parked, but note: every action table (relationships, invites,
invite_redemptions, reports, username changes) already carries actor + timestamp + tenant_id, so
rates are computable retroactively with no schema change. A dedicated counters/buckets table would
only be a performance optimization if live rate checks get expensive.
- **Trigger:** Live rate-limit enforcement is built and per-request count queries become a hotspot.

---

## Markets we deliberately deferred

### The at-risk user market (LGBTQ+ in criminalizing countries)
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
The clean architectural resolution to the E2EE / AI-translation tension. Translation happens on the user's device; plaintext never leaves.
- **Why interesting:** Solves a fundamental architectural conflict. Privacy positioning becomes uncomplicated.
- **Why hard:** Significant engineering investment. Either we ship a smaller model that runs locally (quality risk) or we wait for hardware/OS support for the larger models (timing risk).
- **Trigger:** Version 3+ of the product. Not before mobile is shipped. Not before E2EE concerns become commercially important.

---

## Research and exploration (not commitments)

### What the per-user linguistic profile *could* eventually track beyond what's in the schema
- Personality-level signals (verbose vs terse, formal vs playful baseline)
- Topic affinity (this user talks about food more than work)
- Code-switching patterns (when they mix languages and why)
- Time-of-day register shifts (more formal in mornings, casual at night?)
- Mood signals from punctuation, capitalization, and emoji density

None of these are obvious wins. Worth experimentation when we have data to experiment on.

### What the per-conversation context *could* eventually track
- Trajectory of relationship closeness over time, not just current state
- Dominant emotional tone (collaborative, conflictual, supportive)
- Power dynamics (who initiates, who responds)
- Topic flow (this conversation moved from work to personal — register should shift)

Same caveat as above. Speculative.

### "Translation as conversation partner" thesis
A more ambitious framing: the translation engine isn't just rendering A→B, it's an active participant maintaining conversational coherence. It would notice when the literal translation misses the social meaning, when register shifts, when one party's English is failing them. Surfaces those moments to the user.
- **Why parked:** Big product change, unclear demand, ambiguous UX.
- **Trigger:** Translation quality is solved and we're hunting the next product direction.

---

## How to use this doc

- Add new ideas freely, even half-baked ones. Capture them; refine later.
- When something here gets committed to a phase in `roadmap.md`, remove it from here (or annotate "promoted to roadmap on YYYY-MM-DD").
- When something here is conclusively rejected, remove it (or annotate "killed on YYYY-MM-DD because X").
- Don't try to estimate or prioritize items in this file. Estimation lives in the roadmap or in implementation conversations.
- This file should grow over time. If it stops growing, we've stopped thinking creatively.
