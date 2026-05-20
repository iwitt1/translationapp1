# Translation App

Real-time multilingual chat app backed by an LLM-powered contextual translation API. The chat app is the first-party client of its own translation API; the long-term business is the API itself (sold to dating apps, gaming platforms, legal/immigration tools, healthcare, support SaaS).

## Project documentation

The substantive documentation lives in [`/docs/`](docs/). Read these before touching the codebase:

- [`docs/architecture.md`](docs/architecture.md) — Technical system design
- [`docs/strategy.md`](docs/strategy.md) — Product vision and two-phase plan
- [`docs/operations.md`](docs/operations.md) — Cost model, hiring, workflow
- [`docs/roadmap.md`](docs/roadmap.md) — Phased roadmap with checklists
- [`docs/parking-lot.md`](docs/parking-lot.md) — Ideas not currently committed
- [`docs/decisions.md`](docs/decisions.md) — Decisions log
- [`docs/verification.md`](docs/verification.md) — Post-feature verification and debugging checklists

If you're using Cursor, [`.cursorrules`](.cursorrules) at the repo root encodes the project's never-violate rules and points at `/docs/`.

## Tech stack

- **Frontend:** React 18, Vite, Tailwind CSS
- **Backend (prod):** Vercel serverless functions (`/api/`)
- **Backend (local dev):** Node + Express (`/server/`)
- **Database + realtime:** Supabase (Postgres)
- **AI:** OpenAI (`gpt-4o-mini` currently)
- **Deployment:** GitHub → Vercel auto-deploy

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

MVP. Single global chat room, no auth, contextual translation not yet implemented. See [`docs/roadmap.md`](docs/roadmap.md) for what's next and [`docs/architecture.md`](docs/architecture.md) §2 for what currently works versus what doesn't.

## Repo

https://github.com/iwitt1/translationapp1