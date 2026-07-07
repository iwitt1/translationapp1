# Translation App

Real-time multilingual chat app backed by an LLM-powered contextual translation API. The chat app is the first-party client of its own translation API; the long-term business is the API itself (sold to dating apps, gaming platforms, legal/immigration tools, healthcare, support SaaS).

**Live:** https://app.jistchat.com — sign in by email magic link (open for account creation).

## Project documentation

The substantive documentation lives in [`/docs/`](docs/). **New here? Read in this order:**
[strategy](docs/strategy.md) → [architecture](docs/architecture.md) → [roadmap](docs/roadmap.md) → [decisions](docs/decisions.md).

**Strategy & product**

- [`docs/strategy.md`](docs/strategy.md) — Product vision, two-phase (trojan-horse) plan, target verticals

**Build & architecture**

- [`docs/architecture.md`](docs/architecture.md) — Technical system design: principles, layer separation, API contract, schema
- [`docs/schema.sql`](docs/schema.sql) — Generated current-state DB schema snapshot (the *what*; architecture §7 owns the *why*)
- [`docs/roadmap.md`](docs/roadmap.md) — Phased roadmap with checklists + per-phase status
- [`docs/specs.md`](docs/specs.md) — Feature specs (mostly historical / Hermes-era)

**Process & ops**

- [`docs/operations.md`](docs/operations.md) — Cost model, hiring, dev workflow, staging, migration runbook
- [`docs/verification.md`](docs/verification.md) — Post-feature verification & debugging checklists
- [`docs/policies.md`](docs/policies.md) — Trust & safety / identity governance (living, audited)

**History & reference**

- [`docs/decisions.md`](docs/decisions.md) — Append-only dated decisions log (the canonical "why")
- [`docs/parking-lot.md`](docs/parking-lot.md) — Ideas not currently committed (Priority/Blocks tagged)

**Paused / historical**

- [`docs/hermes.md`](docs/hermes.md) — Hermes Agent charter — ⏸ paused (not currently in use)
- [`docs/cowork-handoff.md`](docs/cowork-handoff.md) — Hermes→Cowork weekly briefing — ⏸ paused
- [`docs/archive/`](docs/archive/) — Frozen doc snapshots + retired docs (e.g. `phase2-implementation.md`); see [`docs/archive/README.md`](docs/archive/README.md)

**Conventions:** each doc keeps a **Changelog** at its bottom (one line per change); `decisions.md` is the canonical dated record of *why*.

If you're using Cursor, [`.cursorrules`](.cursorrules) at the repo root encodes the project's never-violate rules and points at `/docs/`.

## Tech stack

- **Frontend:** React 18, Vite, Tailwind CSS
- **Backend (prod):** Vercel serverless functions (`/api/`)
- **Backend (local dev):** Node + Express (`/server/`)
- **Database + realtime:** Supabase (Postgres), region `us-east-1`
- **AI (translation):** `gpt-5.4` (reasoning effort `low`) for translate + `gpt-4o-mini` for language detect (as of 2026-07-07)
- **Deployment:** GitHub → Vercel auto-deploy
- **Environments:** Production (`main` branch → prod Supabase) and Staging (any non-main branch → `translationapp1-staging` Supabase via Vercel Preview)
- **Build agents:** Cowork (Claude desktop app — strategy, architecture, planning) + Cursor (line-level edits, local dev loop). Hermes Agent (VPS execution agent) was set up but is **not currently in use** — see [`docs/hermes.md`](docs/hermes.md).

## Local development

### Prerequisites

- Node.js 18+
- npm
- A Supabase project (URL and anon key)
- An OpenAI API key

### Environment variables

Create `.env` at the repo root for the frontend:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Create `server/.env` for the local backend:

```
OPENAI_API_KEY=sk-...
# Required as of Phase 2.1 — the backend verifies user tokens (server/lib/auth.js):
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
# Optional — enables server-side profile inference (no-ops if unset):
# DATABASE_URL_PROFILE_WRITER=postgres://...
```

Neither file is committed. Production secrets are set in Vercel's environment variables panel.

> **Note (Phase 2.1):** every backend API call (`/api/v1/translate`, `/api/v1/infer-profile`) now requires a valid Supabase user token, so you must be signed in for translation to work — locally and in prod. See [`docs/architecture.md`](docs/architecture.md) §10.

### Run it

In one terminal, start the local backend:

```
cd server
node index.js
```

Backend listens on `http://localhost:3001`.

In a second terminal, start the frontend:

```
npm install      # first time only
npm run dev
```

Vite serves the frontend at `http://localhost:5173` (or similar). The frontend automatically targets the local backend when `import.meta.env.DEV` is true.

## Deployment

Push to `main`. Vercel auto-deploys both the Vite build (frontend) and the `/api/` folder (serverless functions). No manual deploy step. Production is served at **`https://app.jistchat.com`** (Vercel custom domain). Transactional/auth email (magic links) is sent via **Resend** from `jistchat.com`, configured in Supabase Auth → SMTP.

For the staging-vs-prod git workflow (branch → Vercel Preview vs merge-to-`main` → prod), and how to avoid an accidental push to `main`, see the **"Git & deploy: staging vs prod"** runbook in [`docs/operations.md`](docs/operations.md) §3.

## Status

Phase 2 (multi-tenant identity + social graph) shipped; identity cutover GREEN 2026-06-11. Phase 1.5 (Hermes Agent) was set up but is **paused** — Cowork + Cursor is the working toolchain. Staging environment built 2026-05-18. Phase 3 (real conversation model) **shipped to prod 2026-06-18** — migrations 016–019 + the conversation-aware frontend. **Phase 2.1 (auth hardening): token auth on all backend API calls — DONE, prod-verified 2026-06-23.** **Phase 2.2 (public demo readiness): live on `app.jistchat.com`, custom email via Resend (magic-link rate cap removed), persistent login — DONE 2026-06-23; the app is open for external account creation.** Remaining before wide sharing: a sign-out confirmation, hiding empty "ghost" conversations, and a 3+-user smoke (all small). Phase 2.3 (case-study landing page at `jistchat.com` root) planned. See [`docs/roadmap.md`](docs/roadmap.md) for what's next and [`docs/architecture.md`](docs/architecture.md) §2 for what currently works versus what doesn't. **Most recent (2026-07-07):** translate model moved to `gpt-5.4` effort `low` + prompt v2.1.0, and username choice moved into onboarding (migration 020) — both on prod.

## Repo

https://github.com/iwitt1/translationapp1