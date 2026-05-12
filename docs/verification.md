# Translation App — Verification & Debugging Checklists

> Living document. One section per shipped feature or phase. Each section is a self-contained checklist of what to verify in production after the change ships, plus the most likely failure modes and how to diagnose them.
>
> **When to add a section:** after a phase or significant feature ships. The "verify" steps are also the natural seed for what eventually becomes automated tests.
>
> **When to revise a section:** when a failure mode is observed in the wild and the existing checklist would have missed it.

**Last updated:** 2026-05-12

---

## Phase 0 — Foundation (2026-05-12)

**What shipped:** Versioned API routes (`/api/v1/translate`), reconciled translate prompts, `tenants` table + `tenant_id` columns on existing tables, frontend updates to send `tenant_id`, docs structure under `/docs/`, README rewrite.

### Pre-push order

1. Run `migrations/001_tenants_and_tenant_id.sql` in Supabase SQL editor first.
2. Push code to `main`. Vercel auto-deploys in ~30 seconds.
3. Do NOT try to send a message between these two steps — the schema and code are briefly out of sync.

### Verification (production, after deploy completes)

Open the live URL with browser dev tools open: right-click → Inspect → Network tab + Console tab.

**Loading**
- [ ] Page loads without blank screen
- [ ] No red errors in Console on initial load
- [ ] Network tab: all assets (`.js`, `.css`) return 200

**Login**
- [ ] Typing a username and clicking Join produces no console errors
- [ ] Network tab: request to `/rest/v1/user_profiles` returns 200 (or 201)
- [ ] Supabase → Table Editor → `user_profiles`: new row has `tenant_id = 00000000-0000-0000-0000-000000000001`

**Send a message**
- [ ] After Send, Network tab shows a `POST` to `/api/v1/translate` (NOT `/api/translate` — if you see the old path, the deploy is using a stale build)
- [ ] The translate request returns 200 with `{"detected_language": "..."}`
- [ ] A request to Supabase `/rest/v1/messages` returns 200 (or 201)
- [ ] Supabase → `messages` table: new row has `tenant_id` populated, `source_language` populated, `original_text` matches what you typed

**Receive a message + translation**
- [ ] In a second browser tab, log in as a different username with `default_language` set to something other than `en` (manually edit in Supabase Table Editor if no UI exists yet)
- [ ] Send a message from the first tab. The second tab receives it via realtime, no refresh needed.
- [ ] Network tab in second tab: `POST` to `/api/v1/translate` with `mode: "translate"` returns 200
- [ ] Supabase → `message_translations` table: new row has `tenant_id` populated, correct `message_id`, correct `language`

**Cache behavior**
- [ ] Refresh the receiving tab. Same translation appears instantly. Network tab confirms no new `/api/v1/translate` call.

**Vercel side**
- [ ] Vercel Dashboard → Deployments: latest is green
- [ ] Vercel Dashboard → Runtime Logs: no 500 errors during your testing

### Known failure modes and how to diagnose

| Symptom | Likely cause | Fix |
|---|---|---|
| 404 on translate calls (Network tab) | Vercel hasn't picked up the new `/api/v1/translate.js` file | Hard refresh (Cmd-Shift-R). If persistent, manually redeploy from Vercel dashboard. |
| `column "tenant_id" does not exist` | Migration didn't run, or ran against the wrong project | In Supabase SQL editor: `SELECT column_name FROM information_schema.columns WHERE table_name = 'messages';` Confirm `tenant_id` is listed. Re-run migration if missing. |
| `violates not-null constraint` on tenant_id | Migration ran (column exists with NOT NULL) but frontend isn't sending `tenant_id` | Frontend has a stale build. Check Vercel deployment is the latest. Hard refresh. |
| Translation never appears in second tab | Supabase Realtime subscription failed or message_translations cache returning the wrong row | Check Console for subscription errors. Check that the message's `id` matches the cache lookup key. |
| OpenAI returns malformed JSON | Prompt drift or an OpenAI quirk on edge-case input | Check `Vercel Runtime Logs` for the raw `model_output` and verify the prompt structure. |

---

## Phase 1 — Contextual translation (NOT YET SHIPPED)

Section seeded in advance. Fill in after Phase 1 ships. The shape will be:

- Verification of structured JSON response (translation + inferences + ambiguity)
- Verification of context object assembly (correct user-level data, correct conversation history)
- Verification of `user_linguistic_profiles` updates (inferences land where expected, explicit values are never overwritten)
- Verification of `conversation_contexts` updates
- A test conversation that demonstrates qualitative translation improvement vs Phase 0 output
- Known failure modes specific to JSON-mode and prompt restructuring

---

## How to use this doc

- Before shipping a feature, draft its verification section first. Easier than scrambling after.
- Run through the relevant section in production immediately after deploy.
- Check failures back into the table at the bottom of each section — when something breaks in a way the checklist would have missed, that's data.
- This doc lives alongside the code; if you ever hand the project off, this is the runbook your successor needs.
