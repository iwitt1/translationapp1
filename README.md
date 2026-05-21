# Translation App

Real-time multilingual chat app backed by an LLM-powered contextual translation API. The chat app is the first-party client of its own translation API; the long-term business is the API itself (sold to dating apps, gaming platforms, legal/immigration tools, healthcare, support SaaS).

## Project documentation

The substantive documentation lives in [`/docs/`](docs/). Read these before touching the codebase:

- [`docs/architecture.md`](docs/architecture.md) — Technical system design
- [`docs/strategy.md`](docs/strategy.md) — Product vision and two-phase plan
- [`docs/operations.md`](docs/operations.md) — Cost model, hiring, workflow, staging environment
- [`docs/roadmap.md`](docs/roadmap.md) — Phased roadmap with checklists
- [`docs/parking-lot.md`](docs/parking-lot.md) — Ideas not currently committed
- [`docs/decisions.md`](docs/decisions.md) — Decisions log
- [`docs/verification.md`](docs/verification.md) — Post-feature verification and debugging checklists
- [`docs/hermes.md`](docs/hermes.md) — Operating charter for the Hermes Agent (operational AI executor)
- [`docs/specs.md`](docs/specs.md) — Active and recent feature specs in flight

If you're using Cursor, [`.cursorrules`](.cursorrules) at the repo root encodes the project's never-violate rules and points at `/docs/`.

## Tech stack

- **Frontend:** React 18, Vite, Tailwind CSS
- **Backend (prod):** Vercel serverless functions (`/api/`)
- **Backend (local dev):** Node + Express (`/server/`)
- **Database + realtime:** Supabase (Postgres), region `us-east-1`
- **AI (translation):** OpenAI (`gpt-4o-mini` currently)
- **Deployment:** GitHub → Vercel auto-deploy
- **Environments:** Production (`main` branch → prod Supabase) and Staging (any non-main branch → `translationapp1-staging` Supabase via Vercel Preview)
- **Build agents:** Cowork (Claude Opus desktop app — strategy + planning), Hermes Agent (NousResearch framework on VPS — operational execution; Phase 1.5 setup pending). See [`docs/hermes.md`](docs/hermes.md).

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
```

Neither file is committed. Production secrets are set in Vercel's environment variables panel.

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

Push to `main`. Vercel auto-deploys both the Vite build (frontend) and the `/api/` folder (serverless functions). No manual deploy step.

## Status

Phase 1 (contextual translation) near-complete; staging environment built 2026-05-18; Phase 1.5 (Hermes Agent setup) is the next phase. See [`docs/roadmap.md`](docs/roadmap.md) for what's next and [`docs/architecture.md`](docs/architecture.md) §2 for what currently works versus what doesn't.

## Repo

https://github.com/iwitt1/translationapp1