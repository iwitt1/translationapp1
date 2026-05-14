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

## 2026-05-12 — Normalise source_language codes; detect prompt returns BCP 47

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

## 2026-05-12 — Detect API returns confidence; Spanglish falls back to sender's language

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

## 2026-05-12 — Viewer's own messages are never translated; always show as-typed

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
