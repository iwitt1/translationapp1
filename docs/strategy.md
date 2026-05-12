# Translation App — Strategy

> Living document. Owns product vision, business strategy, competitive positioning, target markets, and the differentiation thesis.

**Last updated:** 2026-05-12
**Owner:** Isaac (iwitt1)

---

## 1. The product, in one paragraph

A real-time multilingual chat application where people speaking different languages communicate naturally through automatic AI-powered translation. Every user sees every message in their preferred language. The translation is invisible — the experience feels like talking to someone in your own language, and the translation handles things generic engines fail at: idiomatic expressions, pronouns, register, dialect, conversational context.

---

## 2. The two-phase strategy (Trojan horse)

### Phase 1 — Consumer chat app (the distribution + data vehicle)

A full-featured messaging app framed as a Telegram-class chat product, but with native cross-language conversation as its single biggest differentiator. The consumer app exists to do four things:

1. Build a user base that can hand-test translation quality in real conversations.
2. Generate training data — every user edit, thumbs-down, and correction is a labeled pair.
3. Prove the translation-quality thesis (that LLM-driven contextual translation reads natively in a way DeepL and Google never will).
4. Accumulate the corrections dataset that makes the API defensible by the time we open it.

The consumer app is not the destination. It is the distribution vehicle and data flywheel.

### Phase 2 — Translation API (the actual business)

A contextual, natural-language translation API sold to verticals where bad translation causes embarrassment or real harm:

- Dating apps (the original use case, where awkward translations kill connection)
- Gaming platforms (chat in multiplayer games, especially MMO/MOBA)
- Legal and immigration tools (where mistranslation has actual consequences)
- Healthcare (patient intake, telehealth, multilingual clinics)
- Customer support / SaaS (multilingual ticketing without hiring per language)

The Phase 2 API is what funds the business. The Phase 1 chat app is what makes the API defensible.

### Why we are committing to over-engineering Phase 1 for Phase 2

Every architectural choice in Phase 1 is made as if the API already exists and the chat app is its first customer. This is cheap to do now (a few hours of careful schema and route design) and prohibitively expensive to retrofit later (one of the most-cited regrets in API product history is "we'll add multi-tenancy when we need it"). Decision recorded 2026-05-12.

---

## 3. Why this is different from existing players

### The gap in the market

| Player | Strength | The gap |
|---|---|---|
| DeepL | Best current NMT quality on its supported languages | Only 33 languages; no conversational adaptability; no dialect distinction within languages |
| Google Translate | 133 languages, free, ubiquitous | Often literal; no register awareness; no per-user personalization |
| Microsoft Translator | Strong enterprise integration | Session-based not persistent; weak on idiom |
| GPT-4o raw | Good on context and idiom out of the box | Not productized as translation; no latency optimization; no pronoun/register handling as first-class API features |
| DeepSeek | Very cheap ($0.14/M tokens), strong on CJK languages | Emerging; not yet a serious translation product |
| Intent app | Closest consumer competitor — persistent chat, voice cloning | Hasn't won a vertical; less aggressive on dialect / register |
| VAYSS | Group chat rooms with real-time translation | Only 10 languages; small user base |

### The unoccupied position

Persistent, conversational, group text chat with per-user dialect-aware translation + a clean API for developers who need the same capability in their own products. Nobody has both. Owning both is what creates the moat.

---

## 4. The differentiation thesis (the "Translation Quality Features" pillar)

Five things our translation does that generic APIs don't:

1. **Dialect and regional intelligence.** Spanish is not Spanish. We distinguish Rioplatense (Argentina/Uruguay, "vos" constructions, specific vocab) from Castilian (Spain) from Mexican Spanish. Same pattern for Brazilian vs European Portuguese, Levantine vs Gulf Arabic, Taiwanese vs Mainland Mandarin.
2. **Formality and register.** Grammatically critical in Japanese, Korean, Thai, Arabic, and others. Inferred from conversation context (workplace vs dating vs friend group) and explicit user setting. Register errors are the ones users feel most viscerally.
3. **Gendered language.** Romance, Slavic, Semitic languages need gender agreement throughout. We accumulate implicit gender signals per user and apply them to outgoing translations. Prevents the jarring experience of being addressed with the wrong gender.
4. **Relationship-aware tone.** Social graph signals (message count, days active, response time) inform closeness, which affects translation tone. People talk to close friends differently than new acquaintances. Particularly valuable for dating.
5. **Domain routing.** A `domain` field in the per-call context object (medical, legal, gaming, null) enables routing to domain-specific prompts and eventually domain-specific fine-tuned models. Foundation for vertical pricing tiers.

None of these are individually hard for an LLM — they already know what dialect, register, and gender mean. The value we add is *capturing the per-user signal* and *injecting it at translation time* in a way that's reliable, low-latency, and structured.

---

## 5. The corrections data flywheel — the actual moat

This is the only piece that competitors cannot buy.

Every correction is a labeled training pair: model output → human judgment. Over thousands of corrections we accumulate ground truth on exactly where LLM translation fails in casual, idiomatic, real-world conversation.

This dataset becomes:
- The fuel for fine-tuning runs that make our model diverge from the base model along our specific dimension.
- Our internal benchmark of hard cases where generic models fail — the primary sales tool for the API.
- The basis for dialect clustering (corrections from regionally-identified users map regional patterns at scale).
- A corpus of tacit native-speaker knowledge that simply cannot be scraped from the public internet.

Correction sources in descending order of value:

1. Bilingual user explicit edit — highest, a native speaker of both languages made a deliberate fix.
2. AI audit flagged + human reviewed — high, human-validated.
3. AI audit suggestion alone — medium, useful for patterns, needs validation.
4. Thumbs-down only — lowest signal, says something was wrong but not what.

The schema for capturing corrections is described in `architecture.md` and adopted in Phase 1. We start collecting corrections as soon as the consumer app has a way for users to express dissatisfaction.

---

## 6. Privacy positioning

True end-to-end encryption (E2EE) and AI translation are architecturally in tension — E2EE means no server sees plaintext, AI translation needs a server to read plaintext. The honest, marketable position is:

> *"Messages are encrypted in transit and at rest. Plaintext exists only transiently during translation processing, is never logged or stored, and is never used for training without explicit opt-in consent."*

This is a strong and defensible stance that the great majority of users will accept. Don't ever claim E2EE if it isn't true; the architectural conversation about on-device translation lives in the parking lot.

A separate, riskier market — LGBTQ+ users in criminalizing countries — would require genuine E2EE, minimal metadata, anonymous accounts, and significant ethical responsibility. That market is deliberately out of scope for the near term. Recorded in the parking lot.

---

## 7. Market sizing

- Translation app market: ~$6.5B by 2025, ~8.6% CAGR.
- Real-time text translation services: ~$3.5B by 2031, ~13% CAGR.
- Real-time is the fastest-growing segment of the broader translation software market.

These are addressable-market numbers, not target capture. The interesting B2B subset — translation APIs sold to consumer apps and SaaS — is a small but growing slice within these.

---

## 8. Target verticals for the Phase 2 API

In rough order of fit, where "fit" = product where bad translation causes real harm or where users will pay for quality.

1. **Dating apps.** Mistranslation kills connection. Already the original use case driving this project. Highest fit.
2. **Gaming chat (MMO / MOBA / co-op).** Cross-region matchmaking is universal; in-game chat is universally garbage at translation today.
3. **Legal / immigration tools.** Mistranslation has consequences. Liability concerns drive willingness to pay for quality.
4. **Healthcare (telehealth, intake forms, patient communication).** Regulated; risk-averse; bad translation has real harm.
5. **Customer support / SaaS.** Multilingual ticketing without hiring per language. High-volume, lower-margin, but easier to land.

We don't have to win all of these. Winning one well — most likely dating — gives the case study and corrections corpus to enter the next.

---

## 9. What's out of scope (for now)

- Voice translation, audio messages, voice cloning. Parked.
- AI tone adaptation as a user-controllable knob beyond the register defaults. Parked.
- Cultural interpretation layer (explaining cultural references). Parked.
- Conversation memory across conversations / users. Parked.
- On-device translation for full E2EE. Parked, version 3+.
- The at-risk-user market (LGBTQ+ in criminalizing countries). Parked with a separate file in the parking lot — this would require a dedicated security review and is not a feature, it's a different product.

All of these are catalogued in `/docs/parking-lot.md` so they aren't forgotten.

---

## 10. What success looks like

### End of Phase 1 (consumer chat app)
- Hundreds of testers using it for real conversations (not synthetic tests).
- Translation quality is qualitatively better than DeepL/Google on the same content — judged by bilingual users we trust, not by us.
- A corrections corpus in the thousands of high-quality pairs.
- A clean, versioned API that the chat app calls — provably ready to open to a first external customer.

### End of Phase 2 (API)
- At least one paying customer in the dating vertical.
- A second vertical landed (likely gaming or legal).
- Fine-tuned model that demonstrably outperforms baseline on our internal benchmark.
- Revenue path that can sustain a small team.
