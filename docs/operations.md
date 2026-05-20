# Translation App — Operations

> Living document. Owns cost model, hiring plan, development workflow, and vendor decisions.

**Last updated:** 2026-05-18 (staging environment added; §3 expanded with a new "Staging environment" subsection)

---

## 1. Cost model

### MVP (current, fewer than 100 users)

| Service | Cost |
|---|---|
| OpenAI API (`gpt-4o-mini`, low volume) | ~$1–2/month |
| Supabase | Free tier |
| Vercel | Free tier |
| GitHub | Free |
| **Total** | **~$0–5/month** |

Below the $30/month tools budget by an order of magnitude. Translation message tokens are small; the binding constraint at MVP is not cost.

### Small scale (1,000–10,000 active users, ~60% cache hit rate)

| Service | Cost |
|---|---|
| OpenAI (`gpt-4o-mini` only) | ~$15–40/month |
| OpenAI (with `gpt-4o` routing for idiomatic cases) | ~$200–500/month |
| Supabase Pro | $25/month |
| Vercel Pro | $20/month |
| **Total** | **~$60–600/month** |

Model choice becomes the dominant cost variable. The 15x cost delta between `gpt-4o-mini` and `gpt-4o` is what makes Phase 2's per-message model-routing logic worth building.

### Funded / large scale (100k–1M+ users)

| Service | Cost |
|---|---|
| AI API (negotiated enterprise pricing) | $3,000–15,000/month |
| Dedicated Postgres (Railway/AWS RDS) | $200–800/month |
| Redis cache layer (Upstash) | $0–100/month |
| Containerized backend | $100–400/month |
| Realtime infrastructure (Ably/Pusher) | $100–500/month |
| **Total** | **~$4,000–17,000/month** |

At this scale the architecture itself has shifted significantly; the Vercel/Supabase MVP stack is replaced. Numbers are rough planning ranges, not commitments.

### The cost lever to remember

Token counts are the single largest cost driver. A 2,000-token call costs 10x a 200-token call. Context injection that isn't disciplined balloons costs faster than user growth. The structured 60–80 token context object versus a 400+ token natural-language equivalent is a real financial decision at scale, not a stylistic preference. See architecture.md §6.

---

## 2. Hiring roadmap (product side only)

### MVP — solo + occasional contract

No full-time hires needed. Cursor + Cowork handle the build loop. If a specific feature requires expertise we lack, contract a full-stack React/Node engineer for a defined deliverable rather than retaining.

### Small scale — first three hires

In rough priority order:

1. **Full-stack engineer (React + Node).** Owns the existing stack. Builds features without architectural hand-holding. The first person who lets us move on more than one thing at a time.
2. **Mobile engineer (React Native preferred).** A messaging app needs to live on mobile to be a real consumer product. React Native shares logic with the existing React codebase, which compresses the bring-up.
3. **NLP linguist (consultant or advisor).** Audits dialect detection logic, identifies edge cases in register inference, validates training-data schema. Academic background is fine; part-time or advisory.

**Plus one contractor at this stage:**

4. **Security engineer (one-time engagement).** Specifically to audit the E2EE integration if/when we adopt it. Not a full-time hire — a defined engagement with a deliverable.

### Funded — scaling the team

5. **AI/ML engineer.** LLM application specialist, not ML researcher. Owns the corrections pipeline, fine-tuning runs, context-injection architecture, model evaluation. Highest leverage *after* meaningful correction data exists, which is why this hire is deferred. Compensation range varies dramatically by geography — $140–180k US, viable offshore at meaningful discount.
6. **Backend / infrastructure engineer.** Owns the migration off Vercel/Supabase to dedicated infrastructure when growth demands it. DevOps fluency required.

### What we deliberately won't hire (yet)

- A product manager. Isaac fills that role through Phase 1 and most of Phase 2; that's the point.
- A designer beyond contract engagements. The product's value is translation quality, not UI novelty.
- An ML researcher. We are not building a new model; we are deploying and tuning existing ones.
- Sales. Until there's a working API with one paying customer, sales is Isaac's job.

---

## 3. Development workflow

### The toolchain (committed 2026-05-12)

**Two tools, period:**

- **Cowork (Claude desktop app, file access mode):** strategy and architecture conversations, doc maintenance, multi-file code changes, code reviews, schema work, anything that benefits from cross-file context or shell access. Persistent memory across sessions.
- **Cursor:** line-level edits, the dev server loop, the live preview in browser, visual file navigation, the moment-to-moment coding experience.

**What we explicitly dropped:**

- Claude Chat (the regular web chat app) as a routine tool. It's fine for an outside-the-loop second opinion, but it's not part of the regular flow. Cowork covers the same strategy/spec ground with the bonus that decisions flow into doc updates in the same session.
- Any expectation that we maintain four documents (Claude Chat thread + CLAUDE.md + Cursor rules + Cowork notes) describing the same architecture. We maintain one set of `/docs/` files; Cursor reads `.cursorrules`; both tools read the same docs.

### The build loop

For most changes:

1. Open Cowork (this), describe the change in plain language, decide together on the approach.
2. Cowork either makes the change directly or describes what Cursor should do.
3. Open Cursor, review the diff, test locally, hit save.
4. Commit and push. Vercel auto-deploys.
5. Cowork updates `/docs/` to reflect what was built. Decisions of consequence land in `/docs/decisions.md`.

### Staging environment

Set up 2026-05-18, pulled forward from Phase 2 to give Hermes (and us) a safe target to deploy and validate against before anything touches production. See decisions.md.

**Topology:**
- **Production:** Supabase project `translationapp1` + Vercel production environment. Deploys from `main` branch.
- **Staging:** Supabase project `translationapp1-staging` (same region as prod, free tier) + Vercel Preview environment. Auto-deploys from any branch other than `main`.
- **Local dev:** Unchanged. Your local Express server (`server/index.js`) and frontend dev (`npm run dev`) still talk to prod Supabase via the root `.env`. The local workflow isn't routed through staging.

**How env-var routing works:**
- Vercel's Preview environment has `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `OPENAI_API_KEY` set as Project-scoped env vars pointing at staging. Vercel applies them at build time to any Preview deployment.
- Production env vars are untouched and continue pointing at prod Supabase.
- A push to any branch other than `main` triggers a Preview build using the staging values. A merge to `main` triggers a Production build using the prod values. The branch determines which database the deploy talks to.

**Migration workflow:**
1. New schema changes are written as new `.sql` files in `/migrations/` with a sequential number prefix.
2. Run the migration against staging Supabase first (SQL Editor → New query → paste → run).
3. Verify on staging using the verification queries embedded in each migration.
4. Run the same migration against prod Supabase.
5. Verify on prod.
6. The migration file lives in the repo as the canonical record. Any future fresh deploy can replay all migrations in order to reach the same state.

**What's in `/migrations/` today (running them in order against an empty Postgres reproduces the prod schema):**
- `000_base_schema.sql` — base tables (`messages`, `message_translations`, `user_profiles`). Captures the pre-migration state of those tables, which were created via Supabase Studio UI before the migrations folder existed. See parking-lot.md for cleanup of vestigial columns surfaced during this work.
- `001_tenants_and_tenant_id.sql` — adds the `tenants` table, seeds the chat-app tenant row, retrofits `tenant_id` on the base tables.
- `002_phase1_schema.sql` — adds `user_linguistic_profiles`, `conversation_contexts`, `user_profile_events`.
- `003_prompt_version_and_gender_nonbinary.sql` — adds `prompt_version` to `message_translations`, expands `gender_signal` enum.
- `004_enable_realtime_publication.sql` — adds `messages` to the `supabase_realtime` publication. Captures a setting previously configured only via Supabase Studio UI on prod.

**Test users seeded on staging (not prod):**
- `staging_test_a` (display name "Staging Test A (EN)", `default_language = 'en'`)
- `staging_test_b` (display name "Staging Test B (ES)", `default_language = 'es'`)

Use these to smoke-test without polluting any real-looking data.

**Smoke-test runbook:** see `/docs/verification.md` "Staging environment" section.

### When to use Cowork vs Cursor

- **Cowork:** Architectural decisions. Multi-file changes. Schema migrations. Doc work. Tracing through unfamiliar code. Anything where you'd want to talk through it.
- **Cursor:** Knowing exactly what change you want to make on a specific line. Running the dev server. Watching the live browser preview iterate. The 80% of editing that's mechanical.

### What Cursor's AI is for

Cursor has its own AI built in (`Cmd-K` for inline edits, the chat panel for questions). It's fine for small in-context edits. For anything architectural, prefer Cowork — it has the memory and the docs in context.

### Memory and continuity

- Cowork keeps persistent memory across sessions automatically. Things like "Isaac prefers casual, concise responses with jargon explained" don't need to be re-said.
- For anything load-bearing in the architecture, the source of truth is `/docs/`, not Cowork memory. Memory is for collaboration preferences and recent context; docs are for decisions.
- Before starting a new Cowork session on a technical topic, the docs are auto-context if I open them; you don't need to paste anything in.

---

## 4. Vendor and technology decisions

### Current commitments

- **Supabase** for database + realtime through small scale. Reasonable price/performance for our size. May need migration to dedicated Postgres at funded scale; that's a known future migration, not a regret.
- **Vercel** for hosting frontend + serverless backend through small scale. Same logic — fine for now, will migrate when growth demands.
- **OpenAI** as primary LLM provider. Stays primary at MVP. Evaluate alternatives (DeepSeek, fine-tuned models) at small scale; backend model-agnostic so swap is configuration, not refactor.
- **GitHub** for source. Not changing.

### Decisions we have NOT yet made

- Authentication provider. Supabase Auth is the obvious choice given the existing Supabase project, but worth a brief evaluation versus Clerk or Auth0 at Phase 2 boundary.
- Mobile framework. React Native is the leading candidate (shares codebase with web React), but Expo vs bare React Native, native modules vs JS-only — all open.
- Data residency region. Supabase region was chosen by default at project creation. May matter when entering regulated markets; decision deferred until that's a real question.
- Whether to monetize the consumer app or keep it free as a data-generation vehicle. Strategy doc notes this; decision deferred until we have signal on consumer demand.

---

## 5. Time budget

- Isaac targets 10–15 hours per week on the project.
- No hard deadline. Goal: working MVP-quality contextual translation faster than a month; "meaningful AI fluency" as a personal outcome within roughly the same window.
- Phase order is firm (see roadmap.md): Phase 0 → Phase 1 → Phase 2 → Phase 3.
