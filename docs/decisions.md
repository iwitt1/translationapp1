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
