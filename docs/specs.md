# Translation App — Specs

> Living document. Holds active and recent feature specs in the format described in `/docs/hermes.md` §9.1. One file rather than one-per-spec until volume justifies splitting (estimated ~10-15 specs before needing a `/docs/specs/` folder).
>
> Spec lifecycle: **draft** → **approved** → **in-flight** → **shipped** → **archived**. When a spec ships, mark it `shipped` here with the commit reference and move the verification details to `/docs/verification.md`. Archive specs after one cycle of "shipped" review (typically 2-4 weeks) — move them to a future `/docs/specs-archive.md` if/when this file exceeds ~600 lines.

**Last updated:** 2026-07-16 — added **Spec 11** (add-to-conversation: search-to-add + "X was added" system message + migration 023) and **Spec 12** (group-chat sender attribution), both from 3-user testing; **approved 2026-07-16, Cowork-built** (build pending Isaac's go-ahead; migration 023 run by Isaac on staging). Full history in [Changelog](#changelog).
**Owner:** Isaac (iwitt1)

---

## Spec 13 — Group naming (smart default + user-set title) — Cowork-built (migration 024 = Isaac-run on staging)

**Linked roadmap item:** Phase 2.5 — Group-chat polish → name conversations / groups (promoted from parking-lot)
**Author:** Isaac (with Cowork)
**Drafted / built:** 2026-07-16
**Status:** **shipped — on prod 2026-07-16** (Cowork): migration `024_set_conversation_title.sql` (amended to post the rename system message) + frontend. Staging smoke GREEN → 024 replayed on prod → merged to `main` → prod smoke GREEN (rename pill confirmed live). Verification: verification.md "Spec 13 — Group naming".

### Goal
Groups should be named, like any messenger. Two parts: (1) an **unnamed** group (including a `direct` just promoted by Spec 11) displays the **other members' names** joined ("Ana, Kenji, Cai", truncated "Ana, Kenji +3") instead of the literal "Group"; (2) a member can **set/rename** the group title, which then wins over the default.

### What was built
- **Migration 024:** `set_conversation_title(p_conversation_id, p_title)` — SECURITY DEFINER, member-gated (`is_active_member`), tenant-scoped; trims input, empty→NULL (clears → member-list fallback), 100-char cap. Mirrors `set_conversation_context_type`. **On an actual change (groups only) it posts a `group_renamed` / `group_name_cleared` system message** (kind='system', 023) carrying the actor + new title — so a rename shows in the thread and, because system rows ride the messages realtime channel, **propagates to other members live** (not just on reload). In-transaction verification block. Function-only, no table change.
- **Frontend:** `conversations.js` `setConversationTitle()` wrapper; `App.jsx` `groupNameFromMembers()` used in `loadConversations()`'s `displayName` (replaces the literal "Group") + `handleSetTitle()`; `ConversationView` ⋯ menu gains a **Group name** rename field (groups only; Enter or Save → `onSetTitle`), and `systemMessageText` renders the two rename events. **Per-viewer default:** `groupNameFromMembers` is fed `otherNames` (already filtered to `account_id !== userId`), so each member sees the *other* members' names, never their own; a set title is stored once and shown identically to everyone.

### Acceptance criteria
- Unnamed group shows the joined other-member names (≤3 full, else "A, B +N"); a Spec 11-promoted direct→group now reads as its members, not "Group".
- Renaming in the ⋯ menu persists (`conversations.title`) and updates the header + list; clearing it (empty) reverts to the member-list default.
- A non-member can't rename (RPC `not a member`); title >100 chars rejected.
- Direct 1:1 conversations still show the other person's name (unchanged); rename field is groups-only.

### Out of scope
Per-member nicknames; group avatars/photos. *(Rename propagation to other members is now handled live via the `group_renamed` system message, so it's no longer deferred.)*

### Verification plan (→ verification.md)
Migration 024 embedded checks + staging smoke: unnamed group shows member names; rename persists + reverts on clear; non-member/too-long rejected; direct chats unchanged. Migration staging-first, prod-replay before frontend merge.

---

## Spec 11 — Add-to-conversation: search-to-add + "X was added" system message — Cowork-built (migration 023 = Isaac-run on staging)

**Linked roadmap item:** Phase 2.5 — Group-chat polish → add-member UX
**Author:** Isaac (drafted with Cowork, from 3-user share-ready testing 2026-07-16)
**Drafted:** 2026-07-16
**Status:** **shipped — on prod 2026-07-16** (Cowork): migration `023_add_member_and_system_messages.sql` + frontend (`conversations.js`, `InviteModal`, `ConversationView`, `App.jsx`). Staging smoke GREEN; 023 replayed on prod, frontend merged to `main` (feat/spec11-add-member) + deployed via `vercel --prod`; prod add-member smoke GREEN. Verification: verification.md "Spec 11 — Add-to-conversation + system message". Deferred polish → parking-lot "Name conversations / groups".

### Goal
The current invite flow is link-first: `InviteModal` mints a join link and you copy/send it. Flip the primary path to **search a username/email and add the person directly** to the conversation, with **"copy link instead"** demoted to a secondary fallback. When someone is added, drop an iMessage-style **"X was added to the conversation"** system message into the feed — persisted, visible to every member, and surviving reload. Adding a third person to a 1:1 `direct` conversation **promotes it to `group`** (this also closes the known parking-lot quirk).

### Acceptance criteria — UI (Cursor)
- `InviteModal` becomes an "Add people" modal whose **primary** action is a people-picker: port `NewConversationModal`'s discovery search (`findAccountByEmail` / `searchAccountsByUsername`, picked-chips, avatar rows) — same server contract, no client-side filtering.
- Picking one or more accounts and confirming calls the new `addConversationMember` path (below) for each; the modal closes on success and the thread refreshes.
- A **secondary** "Copy link instead" control — styled as a plain hyperlink/text button, **not** the primary CTA — mints the existing conversation invite (`createConversationInvite`) and copies it to the clipboard (reuse the current copy behavior).
- On a successful add, the feed shows a centered system message **"{display_name} was added to the conversation"** for all members, in realtime and after reload (rendered as a centered pill, not a chat bubble; never translated).
- Adding into a `direct` conversation promotes it to `group`; the conversation-list label reflects the change.
- Errors surface inline (blocked/blocking account, non-member caller, already-a-member no-ops cleanly).

### Acceptance criteria — backend (migration 023, Isaac runs on staging first)
- `messages.kind` column: `text NOT NULL DEFAULT 'user'`, `CHECK (kind IN ('user','system'))`. Existing rows backfill to `'user'` via the default. Membership-scoped RLS (018) already covers reads; **ALTER, not recreate** (operations.md §3).
- System messages: `sender_id` NULL + a structured payload capturing event type (`member_added`) and the target `account_id` (see open question on storage).
- `add_conversation_member(p_conversation_id, p_account_id)` — SECURITY DEFINER, tenant-scoped: caller must be an **active member**; respects `blocks` (both directions); inserts/reactivates `conversation_members` (idempotent if already active); **promotes `conversations.kind` `direct`→`group` and NULLs its `dedupe_key`** (parking-lot option (a) — without the null, a later `create_conversation(direct, samepair)` would dedupe back into the now-3-person thread); inserts the `'system'` "member_added" message. Returns the affected membership row. **Also apply the same promotion in `redeem_invite`** (the copy-link fallback path) so both add routes behave identically.
- `conversations.js` gains an `addConversationMember(conversationId, accountId)` wrapper.

### Out of scope
Removing members / kicking; roles or admin permissions (any active member can add, for now); invite expiry/max-uses UI; a system message for *leaves* (only adds this spec); DM-initiation policy enforcement (still parked).

### Resolved (2026-07-16)
1. **System-message storage → `messages` column (decided).** Add `payload jsonb` on `messages` (holds `{event:'member_added', target_account_id}`) with `kind='system'` — reuses the existing membership-scoped RLS + the realtime `messages` channel + the `MessageBubble` render path (branch on `kind`). The separate-`conversation_events`-table alternative was rejected (extra subscription + RLS for no gain here).
2. **Add policy → open direct-add (decided).** Any active member can add any discoverable, non-blocking account; **not** restricted to existing contacts (fine for demo scale). policies.md gets an entry on ship. Re-tighten later if abuse shows up.

### Technical sketch
Migration 023: `messages.kind` (+ `payload jsonb` if option 1) → `add_conversation_member` RPC → direct→group promotion inside the RPC. Frontend: rename/rework `InviteModal` (keep filename or → `AddPeopleModal`), reusing `discovery.js` + the `NewConversationModal` picker markup; `App.jsx` already subscribes to `messages` INSERT so `system` rows arrive live — `ConversationView`/`MessageBubble` branch on `kind==='system'` to render the pill and skip translation/inference. Files: `migrations/023_*.sql`, `src/lib/conversations.js`, `src/components/InviteModal.jsx`, `src/components/MessageBubble.jsx`, `src/components/ConversationView.jsx`, `src/App.jsx`.

### Verification plan (→ verification.md, on ship)
Migration 023 embedded checks (column default+CHECK, RPC grants, block-deny, non-member-deny, direct→group promotion, idempotent re-add, system-row insert). Then a 3-account staging smoke: A adds C by username → C is a member; "C was added" shows for A/B/C live + after reload; the copy-link fallback still joins a 4th; adding into a direct chat promotes it to group. Docs to reconcile on ship: architecture.md §7 (`messages.kind`/payload + the new RPC in the DB-functions list), policies.md (add policy), roadmap.md, parking-lot.md ("direct→group promotion on invite" → RESOLVED), regenerate `schema.sql`, decisions.md entry (storage + policy choices). Migration runs **staging first**, then prod-replay-before-frontend-merge (deploy-order rule).

---

## Spec 12 — Group-chat sender attribution: colored avatar + name (Option B) — Cowork-built

**Linked roadmap item:** Phase 2.5 — Group-chat polish → sender attribution
**Author:** Isaac (drafted with Cowork; Option B + color approach chosen from the 2026-07-16 mockups)
**Drafted:** 2026-07-16
**Status:** **shipped — merged to `main` 2026-07-16 (fast-forward, commit `c681d2b`), on prod via Vercel** (Cowork, frontend-only, no migration). Staging GREEN on a CLI-deployed Preview; local `vite build` GREEN + palette classes verified in CSS. Merge also carried the 2.1 wrap-up commit. Prod eyeball recommended. Verification: verification.md "Spec 12 — Group-chat sender attribution".

### Goal
In a group conversation you can't tell who sent which received message at a glance — no avatar, no color, name (if any) undifferentiated. Add the iMessage/Signal pattern (Option B from the mockup): a **colored initials avatar + colored sender name** on received messages in groups. Consistent per-person color is the load-bearing cue for this app's multilingual audience — someone who can't read the name can still track "the purple person."

### Acceptance criteria
- In a **group** conversation, each **received** message shows a colored initials avatar (reuse `ConversationList`'s `avatarColor()` + `initials()`) to the left of the bubble, and the sender's display name above it, both tinted with the same per-sender color.
- Color is a **stable function of the sender's `account_id`** (not `display_name`) against a **12-color palette** (see Color assignment below), so the same person is usually the same color everywhere and renames don't drift it.
- **Within a conversation, no two members share a color** (up to 12 members) via a deterministic de-collision pass — the actual legibility guarantee.
- **Run grouping:** the avatar + name render only on the **first message of a consecutive run** from the same sender; later messages in the run align/indent with no repeated avatar or name.
- **Direct (1:1)** conversations: received messages show no avatar/name (unchanged). **Own/sent** messages: never show avatar/name, stay right-aligned (unchanged).
- No regression to `MessageBubble`'s translation, "Original" caret, or optimistic-send behavior.

### Out of scope
Profile photos (initials only — no upload yet); online/presence dots; tap-avatar-to-profile; user-customizable colors; attribution in direct chats.

### Color assignment (decided 2026-07-16)
Hybrid: a global `account_id` hash into a **12-color palette**, then **de-collide within each conversation**. Same person is usually the same color everywhere (recognizability, and it's stateless — no DB column); within any given conversation the render pass guarantees distinctness. Rationale + best-practice comparison (WhatsApp/Signal per-conversation vs. Telegram small global hash) in the 2026-07-16 session; recorded in decisions.md on ship.
- **Palette:** expand `PALETTE` in `ConversationList.jsx` from the current 6 to **12** genuinely-distinct hues (Tailwind `bg-*-500`-class equivalents, white initials, legible in light + dark). Not more than ~12–16 — beyond that hues stop being distinguishable, and since the name + initials always accompany the color, color is *reinforcement*, not the sole identifier.
- **Base color:** `hash(account_id) % 12`. Re-key `avatarColor()` off `display_name` → an explicit key arg (default preserves current callers; the people-picker keeps passing `display_name`, message attribution passes `account_id`).
- **De-collision (the guarantee):** `ConversationView` computes an `account_id → colorClass` map **once per conversation** — sort active members by `account_id`, assign each its base color, and if a color is already taken by an earlier member, bump to the next free palette slot. Deterministic and stable across reloads. Only wraps (reuses a color) past 12 members — rare, and the name/initials still disambiguate.
- **No persistence storage.** Cross-conversation consistency falls out of the hash; a per-conversation collision may locally shift one person's color, which is expected and fine.

### Technical sketch
`ConversationView` builds the per-conversation `account_id → colorClass` map (from `listConversationMembers` + the de-collision pass) and, per received message, computes `isRunStart` (compare `sender_id` to the previous message). It passes `showAvatar` + `senderColorClass` + `isRunStart` alongside the existing `showSenderName`/`senderName` into `MessageBubble`, which renders the avatar/name block only on `showAvatar && isRunStart`. `ConversationList.avatarColor(key)` takes an explicit key and the expanded 12-color `PALETTE`. Files: `src/components/ConversationView.jsx`, `src/components/MessageBubble.jsx`, `src/components/ConversationList.jsx`.

### Verification plan (→ verification.md, on ship)
3-account group on staging: each of three senders shows a distinct, stable color on both avatar and name; consecutive messages from one sender group under a single avatar/name; a rename keeps the same color (`account_id` keying); direct chats show no attribution; own messages unchanged; translation + "Original" caret intact. Reconcile roadmap.md + parking-lot.md on ship.

---

## Spec 10 — Account settings screen (Phase 2.4) — Cowork-executed

**Linked roadmap item:** Phase 2.4 — Demo-readiness polish → Account settings screen
**Author:** Isaac (drafted with Cowork, mockup iterated in-session)
**Drafted / built:** 2026-07-08
**Status:** **shipped — on prod 2026-07-08.** Code + migration 021 written in Cowork this session (Isaac's call to build here rather than hand to Cursor). Staging GREEN, then 021 applied prod-first and the frontend merged to `main`; prod smoke GREEN. Verification: verification.md "Spec 10 — Account settings screen (2026-07-08)".

### Goal
One screen to manage the account: change **username** (the once-a-year `change_username`), **display name**, **preferred language**, and **discoverability** — moving language out of the chat header (stops accidental full-history re-translation). Opened from an **app-bar gear**; **sign-out relocated** into it.

### What shipped
- `src/components/SettingsModal.jsx` — modal (matches the in-session mockup): username display line + gated "Change" drop-down (submit-and-error; greyed until the 365-day cadence elapses, computed by `usernameChangeEligibility`); display name (inline, validated); language (`LANGUAGES` endonym list, "affects new messages only" note); discoverability checkboxes (username / email); sign-out row.
- `src/lib/settings.js` — data layer: `getAccountSettings`, `updateDiscoverability`, `changeUsername`, `setDisplayName`, `setPreferredLanguage`, `usernameChangeEligibility`.
- `src/App.jsx` — app-bar sign-out button replaced by a **Settings gear**; `SettingsModal` rendered; `onSaved` reloads profile + linguistic profile.
- `migrations/021_settings_screen.sql` — `set_preferred_language()` + `set_display_name()` RPCs; `account_settings.discoverable_by_email` default true→false + `handle_new_user` trigger + backfill.

### Decisions (see decisions.md 2026-07-08)
Language/display-name via validated RPCs (not raw client UPDATE); discoverability via own-row UPDATE; discoverability default → username-only (email-off, backfilled); "Who can message you" (`allow_dms_from`) **pulled** (unenforced → parking-lot); settings entry = app-bar gear (not a second kebab); username availability = submit-and-error (availability RPC stays parked).

### Out of scope
Account-deletion UI (built server-side, no UI yet); DM-initiation enforcement + its UI (parked); live username availability check (parked); UI localization (parked).

### Verification plan (→ verification.md)
Migration 021 embedded checks (RPC signatures/grants, default=false, backfill=0, fresh-signup trigger smoke, RPC happy/deny paths) + app smoke: gear opens settings; change display name → app-bar name updates + persists; change language → new received messages translate to it, existing history untouched; toggle discoverability → discovery search honors it; username "Change" greyed for a fresh account (clear `username_last_changed_at` on staging to exercise the change + taken/invalid errors); sign-out from settings works.

---

## Spec 8 — Onboarding language list: native names + expanded set (~40) — Cursor/Sonnet-executed

**Linked roadmap item:** Phase 2.4 — Demo-readiness polish
**Author:** Isaac (drafted with Cowork)
**Drafted:** 2026-07-07
**Status:** **shipped** — staging gate GREEN 2026-07-07 (commit `69dc68b`); **merged to `main` 2026-07-07** (commit `1c37b14`), deploying to prod via Vercel; prod smoke still pending. Verification: verification.md "Spec 8 + 9 — Demo-readiness polish (2026-07-07)". Executed in-session by Cowork rather than Cursor (Isaac was already in the session). One deviation from the technical sketch below: `LANGUAGES` entries kept the existing `code` field name instead of switching to `value` — `value` would have broken `App.jsx`'s `l.code` call site and `languageLabel()`, contradicting this spec's own "call sites untouched" acceptance criterion. See decisions.md 2026-07-07.

### Goal
A first-time user who doesn't read English should be able to find their language at onboarding. Today the picker is a short, English-labelled (exonym) `LANGUAGES` array in `src/lib/vocabularies.js`, rendered as a native `<select>` in `App.jsx`. Expand it to ~40 of the most-spoken languages and label each **endonym-first with English in parentheses** — e.g. `Español (Spanish)` — so both a native speaker and an English speaker (and text search) can find it.

### Acceptance criteria
- `LANGUAGES` in `src/lib/vocabularies.js` holds the ~40 entries below, each `{ value: <ISO 639-1 code>, label: "<Endonym> (<English>)" }` (English label is exactly `English`, no parens).
- The onboarding `<select>` (App.jsx ~line 479) renders all ~40 with the new labels; the wire value written to `complete_onboarding(p_preferred_language)` is still the ISO code (unchanged behavior).
- Codes stay valid ISO 639-1 / BCP 47 that the detect + translate engine already accepts. No new dialect/region codes (dialect lives separately in `dialect_region`).
- No duplicates; order is common-languages-first (as listed).
- The `getLanguages()` accessor shape is unchanged (call sites untouched); `CONTEXT_TYPES` and other `vocabularies.js` exports are untouched.
- Default remains `'en'`; existing stored profiles keep working.

### Out of scope
- The "language not in the list" solution (free-text / comprehensive CLDR list + searchable picker) — stays parked (High).
- A custom-styled dropdown (endonym bold / English muted) — we chose the plain `<select>` with parens.
- UI localization (translating the app's own text) — separate parked item.
- Any backend/schema change.

### Open questions
- **RTL labels:** Arabic/Hebrew/Persian/Urdu endonyms + a parenthesized English word can bidi-reorder oddly in `<option>` text. Acceptable cosmetic quirk for v1? (If it bothers, wrap the English in LTR marks later.)
- Final sort order — proposed common-first (below); confirm or switch to alpha-by-English.

### Technical sketch
- File: `src/lib/vocabularies.js` — replace the `LANGUAGES` array with the below. `src/App.jsx` needs no change (it already maps `LANGUAGES` → `<option>`), just confirm the `<option>` uses `l.label`.
- Drop-in array:

```js
export const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español (Spanish)' },
  { value: 'zh', label: '中文 (Chinese)' },
  { value: 'hi', label: 'हिन्दी (Hindi)' },
  { value: 'ar', label: 'العربية (Arabic)' },
  { value: 'pt', label: 'Português (Portuguese)' },
  { value: 'bn', label: 'বাংলা (Bengali)' },
  { value: 'ru', label: 'Русский (Russian)' },
  { value: 'ja', label: '日本語 (Japanese)' },
  { value: 'de', label: 'Deutsch (German)' },
  { value: 'fr', label: 'Français (French)' },
  { value: 'ko', label: '한국어 (Korean)' },
  { value: 'it', label: 'Italiano (Italian)' },
  { value: 'tr', label: 'Türkçe (Turkish)' },
  { value: 'vi', label: 'Tiếng Việt (Vietnamese)' },
  { value: 'pl', label: 'Polski (Polish)' },
  { value: 'uk', label: 'Українська (Ukrainian)' },
  { value: 'nl', label: 'Nederlands (Dutch)' },
  { value: 'th', label: 'ไทย (Thai)' },
  { value: 'fa', label: 'فارسی (Persian)' },
  { value: 'id', label: 'Bahasa Indonesia (Indonesian)' },
  { value: 'he', label: 'עברית (Hebrew)' },
  { value: 'el', label: 'Ελληνικά (Greek)' },
  { value: 'sv', label: 'Svenska (Swedish)' },
  { value: 'cs', label: 'Čeština (Czech)' },
  { value: 'ro', label: 'Română (Romanian)' },
  { value: 'hu', label: 'Magyar (Hungarian)' },
  { value: 'da', label: 'Dansk (Danish)' },
  { value: 'fi', label: 'Suomi (Finnish)' },
  { value: 'no', label: 'Norsk (Norwegian)' },
  { value: 'ur', label: 'اردو (Urdu)' },
  { value: 'ta', label: 'தமிழ் (Tamil)' },
  { value: 'te', label: 'తెలుగు (Telugu)' },
  { value: 'mr', label: 'मराठी (Marathi)' },
  { value: 'gu', label: 'ગુજરાતી (Gujarati)' },
  { value: 'sw', label: 'Kiswahili (Swahili)' },
  { value: 'tl', label: 'Tagalog (Filipino)' },
  { value: 'ms', label: 'Bahasa Melayu (Malay)' },
  { value: 'sk', label: 'Slovenčina (Slovak)' },
  { value: 'bg', label: 'Български (Bulgarian)' },
];
```

### Verification plan (→ verification.md after ship)
- Open onboarding → language picker shows ~40 endonym `(English)` labels.
- Pick a non-English one (e.g. `日本語 (Japanese)`) → complete onboarding → confirm `user_linguistic_profiles.preferred_language = 'ja'` and that received messages translate to Japanese.
- No console errors; register/context selector unaffected.

---

## Spec 9 — Core-controls UI symbology (lucide-react) — Cursor/Sonnet-executed

**Linked roadmap item:** Phase 2.4 — Demo-readiness polish
**Author:** Isaac (drafted with Cowork)
**Drafted:** 2026-07-07
**Status:** **shipped** — staging gate GREEN 2026-07-07 (commit `c4eacbc`); **merged to `main` 2026-07-07** (commit `1c37b14`), deploying to prod via Vercel; prod smoke still pending. Verification: verification.md "Spec 8 + 9 — Demo-readiness polish (2026-07-07)". Executed in-session by Cowork rather than Cursor (Isaac was already in the session). Settings-entry icon skipped — that screen doesn't exist yet (Phase 2.4's first checklist item); the spec allows deferring it as a placeholder. See decisions.md 2026-07-07.

### Goal
Make the app navigable by a first-time user who doesn't read English. Icons today are hand-inlined SVGs with inconsistent coverage (some controls are icon-buttons, others text-only). Add `lucide-react` and put a clear icon on each **core** control, **keeping** existing text labels/tooltips (icons aid non-English users without removing info from English ones).

### Acceptance criteria
- `lucide-react` installed; icons imported per-icon (tree-shaken), sized ~18–20px, `strokeWidth` ~2, color via `currentColor` (matches the existing inline SVGs).
- Every core control has a clear icon **and** an `aria-label` + `title`/tooltip: send message · new conversation · invite / copy-invite-link · back · close (modals) · sign-out · settings entry (or its placeholder if the settings screen isn't built yet) · register/context (⋯) menu · the "Original" expander on translated messages · add-person/search in the new-conversation modal.
- Controls that currently show a **text label keep the label** with the icon beside it (belt-and-suspenders); icon-only controls get the aria-label/tooltip.
- No behavior change — presentation only; all handlers/labels still work.

### Out of scope
- Full sweep (secondary/state/empty/error/onboarding affordances — the register "?", empty states, "translating…", "⚠ Translation failed"/retry, sign-in screen, status ticks, "Copied!", per-message language indicator, timestamps). Parked as the follow-up.
- Full UI localization (translated text) — separate parked item.
- Any restyle beyond adding icons.

### Open questions
- On the few text-labelled controls (e.g. "Sign out"), keep text+icon (recommended) or go icon-only+tooltip? Default: keep text+icon.
- Confirm the icon mapping below (or swap any).

### Technical sketch
- `npm install lucide-react`. Import e.g. `import { Send, SquarePen, UserPlus, Copy, ArrowLeft, X, LogOut, Settings, MoreVertical, ChevronDown, Search } from 'lucide-react'`.
- Files: `ConversationView.jsx` (send, ⋯/register), `ConversationList.jsx` (new conversation), `MessageBubble.jsx` (Original expander), `NewConversationModal.jsx` (search/add, close), `InviteModal.jsx` (copy, close), `App.jsx` app bar (sign-out, settings entry, back).
- Suggested mapping: send→`Send`; new conversation→`SquarePen` (or `Plus`); invite→`UserPlus`; copy link→`Copy`; back→`ArrowLeft`; close→`X`; sign-out→`LogOut`; settings→`Settings`; overflow/register→`MoreVertical`; Original expander→`ChevronDown`; add-person/search→`Search`.
- Optional (if quick): swap the existing hand-inlined SVGs for these controls to their lucide equivalents for one consistent set; otherwise leave them and just match sizing.

### Verification plan (→ verification.md after ship)
- Each listed core control shows its icon at consistent size/stroke; existing labels/tooltips intact.
- Each icon-only control has an `aria-label` (spot-check in devtools).
- Send / new / invite / back / close / sign-out / register menu / Original expander all still function.
- "English-blind" pass: with the text mentally removed, the core flows are recognizable by icon alone.

---

> **Mostly historical.** Specs 1–4b are Hermes-era infrastructure (Hermes is currently **paused** — see decisions.md 2026-07-05); Specs 6–7 were Cowork-executed and shipped. This file is a spec archive — a fuller review/prune is deferred (a follow-up to the 2026-07-07 docs cleanup).

## Spec 6 — Phase 3 Step 1: Conversations schema + write RPCs (migration 017) — Cowork-executed

**Linked roadmap item:** Phase 3 — Real conversation model → Schema (conversations, conversation_members, messages.conversation_id promotion, conversation_contexts RLS)
**Author:** Isaac
**Drafted:** 2026-06-12
**Status:** **shipped** — migration 017; staging gate 35/35 GREEN 2026-06-12; **applied on prod 2026-06-18** in the Phase 3 cutover (commit `3136280`; deployed with the conversation-aware frontend `5251669..c13f8ae`). Verification: verification.md "Phase 3 — Step 1" + "Phase 3 — Step 4".

### Goal

End the "one global room" model at the schema layer. Introduce `conversations` and `conversation_members` so a user can belong to many distinct conversations, promote the already-pre-staged `messages.conversation_id` column to a real FK + NOT NULL (zero backfill — migration 014 defaulted every row to the global-conversation sentinel `00000000-0000-0000-0000-000000000002`), and finally give `conversation_contexts` its outstanding RLS policy. This spec is **schema + write RPCs only**; the membership-scoped read authorization on `messages` (the security-sensitive RLS change) is Spec 7, and all UI is later Phase 3 steps. Data-model shape is fixed by decisions.md 2026-06-12 ("Phase 3 data model: conversations as the single membership-scoped primitive").

### Prerequisites

- Migration 014 applied (staging + prod — done): `messages.conversation_id` exists, nullable, defaulted to `…0002`, indexed.
- Migrations 007–013 applied (`profiles`, `auth_tenant_id()`, the social/invite primitives). `redeem_invite()` exists and currently rejects `conversation`-kind invites.
- Runs on `translationapp1-staging` first; prod replay only after the Spec 6 gate is GREEN (operations.md §3).

### Acceptance criteria

Each is pass/fail against staging after migration 017 runs.

- [ ] `conversations` table exists: `id uuid PK`, `tenant_id uuid NOT NULL FK tenants`, `kind text NOT NULL CHECK (kind IN ('direct','group'))`, `title text NULL`, `context_type text NOT NULL DEFAULT 'casual' CHECK (context_type IN ('professional','casual','romantic','family','support'))`, `created_by uuid FK profiles`, `created_at`/`updated_at timestamptz NOT NULL DEFAULT now()`. RLS enabled.
- [ ] The global-conversation row is inserted: `id = 00000000-0000-0000-0000-000000000002`, `kind='group'`, sole-tenant `tenant_id`, so every pre-existing message FK-resolves.
- [ ] `conversation_members` table exists: `id uuid PK`, `conversation_id uuid NOT NULL FK conversations ON DELETE CASCADE`, `account_id uuid NOT NULL FK profiles ON DELETE CASCADE`, `tenant_id uuid NOT NULL FK tenants`, `role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member'))`, `joined_at timestamptz NOT NULL DEFAULT now()`, `left_at timestamptz NULL`, `last_read_at timestamptz NULL`. RLS enabled.
- [ ] Partial unique index `conversation_members_active_unique (conversation_id, account_id) WHERE left_at IS NULL` — one active membership per pair, history rows coexist (mirrors `blocks_active_unique`).
- [ ] FK indexes present: `conversation_members(account_id)`, `conversation_members(conversation_id)`, `conversations(tenant_id)` (Postgres does not auto-index FK columns; RLS predicates read them).
- [ ] `messages.conversation_id` promoted: FK → `conversations(id)` added, `SET NOT NULL`, **migration-014 default dropped**. No backfill (verify 0 NULLs and 0 unresolved FKs before/after).
- [ ] `conversation_contexts` RLS added: SELECT to `authenticated` where `tenant_id = auth_tenant_id()` AND caller is an active member of `conversation_id`; no INSERT/UPDATE/DELETE policy (writes via the background context job / service role). This closes the Phase-1 RLS gap flagged in architecture.md §7.
- [ ] Write RPCs exist (all `SECURITY DEFINER SET search_path = public`, tenant-scoped via `auth_tenant_id()`, deny-by-default, mirroring migration 011 idioms):
  - `create_conversation(p_kind text, p_member_ids uuid[], p_title text DEFAULT NULL, p_context_type text DEFAULT 'casual') RETURNS uuid` — inserts the conversation (caller = `created_by`, `role='owner'`), inserts the caller + each member as active members. Rejects: any member not an active profile in the caller's tenant (single-tenant invariant); `kind='direct'` with member count ≠ 2; self-only conversations. **Dedupe is policy-driven, not hardcoded:** for `kind='direct'` the RPC returns the existing active 1:1 conversation between the two accounts if one exists (one DM thread per pair); for `kind='group'` it always mints a new conversation. The default (`direct: dedupe`, `group: always-new`) lives in `lib/policies.js` and is overridable per tenant via the tenants conversation-policy jsonb (same pattern as `dm_initiation_policy`). The override is read at creation time only and affects only newly-created conversations — there is no user-facing toggle and no retroactive merge.
- [ ] Direct-dedupe is race-safe: two simultaneous "message X" taps resolve to the same single DM conversation, not two (the glare race — same concern the `relationships` canonical-pair model guards; enforce via a unique constraint or lock, not a check-then-insert).
  - `leave_conversation(p_conversation_id uuid) RETURNS void` — soft-leave (`left_at = now()` on the caller's active membership). No-op-safe if already left.
  - `set_conversation_context_type(p_conversation_id uuid, p_context_type text) RETURNS void` — caller must be an active member; validates against the CHECK set.
  - `redeem_invite()` amended: `conversation`-kind invites **un-rejected** — redeeming one inserts an active `conversation_members` row for `redeemed_by` on the invite's `target_conversation_id` (single-tenant + block checks first), reusing the existing invite/redemption plumbing. `contact`-kind behavior unchanged.
- [ ] Single-tenant invariant proven: `create_conversation` with a member from a different tenant raises (cross-tenant = "not found", same opaque-error posture as `request_contact`).
- [ ] Idempotent + ALTER-only: re-running 017 is a no-op; no table recreate (operations.md §3 recreate checklist not triggered).
- [ ] Embedded verification block at the bottom of the migration (the 011/014 convention) returns the documented results.

### Out of scope

- Membership-scoped `messages` read RLS + the realtime/translate path changes → **Spec 7** (the security-sensitive change; own adversarial gate).
- All UI (conversation list, create flow, invite-to-conversation surface, relocating the context/register dropdown) → later Phase 3 steps.
- Unread counts / read receipts (the `last_read_at` column lands here but nothing reads it), group admin (rename/kick/roles beyond owner-member), archive-vs-leave UX, auto-inferred context type. Per decisions.md 2026-06-12.
- Cross-conversation translation dedup / shared cache → parking-lot.md.

### Open questions

- **Resolved 2026-06-12 (with Isaac).** Dedupe is policy-driven, not hardcoded: `direct` dedupes (one thread per pair), `group` is always-new. Defaults live in `lib/policies.js`, overridable per tenant via the tenants conversation-policy jsonb — this is the Phase 6 seam (a B2B customer could opt into group dedupe with a config change, no code change). It is **not** a user-facing toggle, and a flip would affect only newly-created groups (the rule is consulted at creation time only; it never merges or alters existing conversations). Confirmed against the actual cross-app convention: groups are first-class objects, not derived from their member set — iMessage's member-set merging is inconsistent and widely complained-about, and WhatsApp allows duplicate-member groups freely.

### Technical sketch (for implementation — Cowork)

- New file `migrations/017_phase3_conversations.sql`. Single `begin; … commit;`. Order: create `conversations` (+ RLS, + global row) → create `conversation_members` (+ indexes + RLS) → promote `messages.conversation_id` (add FK, SET NOT NULL, drop default) → add `conversation_contexts` RLS → RPCs (`CREATE OR REPLACE`) → amend `redeem_invite()`. Mirror migration 011 for table/RLS/RPC idioms (`auth_tenant_id()`, `text + CHECK`, `DROP POLICY IF EXISTS` before `CREATE POLICY`, `SECURITY DEFINER SET search_path = public`, opaque cross-tenant errors).
- The `messages.conversation_id` promotion must run *after* the global row insert, or the FK validation fails on pre-existing sentinel rows.
- Membership-check helper: add `is_active_member(p_conversation_id uuid, p_account_id uuid) RETURNS boolean` (SECURITY DEFINER, tenant-scoped) — reused by the `conversation_contexts` RLS policy, the three RPCs, and Spec 7's `messages` policy. Define it here so Spec 7 only writes the policy.
- Doc reconciliation in the same commit (DoD #3): architecture.md §7 (new tables + `conversation_contexts` RLS-now-present + `messages.conversation_id` FK/NOT NULL promoted + DB-functions list), §13 file map (017), §10 (membership-scoped authorization note), operations.md migrations list, roadmap.md Phase 3 Schema checkboxes, verification.md (gate result). parking-lot.md: mark the dedup/caching item as deferred-by-decision if not already.

### Verification plan

- New gate `scripts/conversations-gate-test.mjs` (mirrors `social-graph-gate-test.mjs`): exercises `create_conversation` (direct + group), the single-tenant rejection, soft-leave + re-join, `set_conversation_context_type`, `conversation_contexts` SELECT allowed for members / denied for non-members, the `conversation`-kind invite redemption, and confirms `messages.conversation_id` is NOT NULL with the default dropped and 0 unresolved FKs. Target GREEN on staging before any prod replay.
- Record the gate result + counts in verification.md under "Phase 3 Step 1 — conversations schema (Spec 6)". Prod replay of 017 noted as pending until Isaac approves the merge (DoD #5).

---

## Spec 7 — Phase 3 Step 2: Membership-scoped messages RLS (migration 018) — Cowork-executed

**Linked roadmap item:** Phase 3 — Real conversation model → the read/write authorization change implied by `conversation_members` (decisions.md 2026-06-12, decision #4)
**Author:** Isaac
**Drafted:** 2026-06-12
**Status:** **shipped** — migration 018; staging gate 27/27 GREEN 2026-06-12 (sentinel purged first); **applied on prod 2026-06-18** after 017 in the Phase 3 cutover (commits `07c7eb8`/`aa99fa5`; prod sentinel purge a no-op, messages=0). Verification: verification.md "Phase 3 — Step 2" + "Phase 3 — Step 4".

### Goal

Flip the authorization on `messages` and its translation cache from **tenant-scoped** to **membership-scoped**: a user can read or post a message only if they are an *active member* of its conversation. This is the security-sensitive half of Phase 3 — it ends the "one global room" posture at the authorization layer (Spec 6 ends it at the schema layer). It is deliberately a **separate migration (018) and a separate adversarial gate** from Spec 6, because an RLS change on the message tables is the highest-blast-radius change in the system and deserves its own isolation and verification.

### Prerequisites

- **Spec 6 (migration 017) on staging:** `conversations` + `conversation_members` exist, `messages.conversation_id` is FK + NOT NULL, and the `is_active_member(p_conversation_id uuid, p_account_id uuid) RETURNS boolean` helper exists, defined `STABLE SECURITY DEFINER SET search_path = public` (so the policy reads `conversation_members` under the function's own privilege — the caller needs no direct SELECT on that table, and the policy doesn't recurse). If 017 didn't define it STABLE/SECURITY DEFINER, amend 017 before this runs.
- **Current state (migration 008):** `messages` SELECT/INSERT are tenant-scoped (`messages_select_same_tenant` USING `tenant_id = auth_tenant_id()`; `messages_insert_own` WITH CHECK `sender_id = auth.uid() AND tenant_id = auth_tenant_id()`). `message_translations` SELECT/INSERT/UPDATE are tenant-scoped.
- **Enforcement surface confirmed:** the frontend reads `messages` + `message_translations` and subscribes to realtime via the **anon (RLS-bound) key** (`src/lib/supabase.js`), so these policies *are* the boundary. `/api/v1/translate` is **stateless** — it receives `history` in the request body and never reads the message tables — so it needs no change.

### Acceptance criteria

- [ ] **`messages` SELECT** replaced: `USING (tenant_id = auth_tenant_id() AND is_active_member(conversation_id, auth.uid()))`. A tenant member who is *not* a member of a given conversation cannot read its messages.
- [ ] **`messages` INSERT** tightened: `WITH CHECK (sender_id = auth.uid() AND tenant_id = auth_tenant_id() AND is_active_member(conversation_id, auth.uid()))`. You can only post to a conversation you're an active member of.
- [ ] **`message_translations` follows `messages` (the cache-leak fix):** SELECT/INSERT/UPDATE policies require membership of the *parent message's* conversation — `EXISTS (SELECT 1 FROM public.messages m WHERE m.id = message_translations.message_id AND m.tenant_id = auth_tenant_id() AND is_active_member(m.conversation_id, auth.uid()))`. Without this, a non-member could read a conversation's translations even though they can't read its messages. This is the easy-to-miss half of the change.
- [ ] **Realtime delivery respects the new SELECT policy:** a non-member subscribed to the `messages` channel receives no rows for conversations they're not in (Supabase `postgres_changes` applies the SELECT policy for the `authenticated` role). Verify explicitly — realtime RLS is a known footgun, not something to assume.
- [ ] **Soft-leave is honored:** a user who has left a conversation (`left_at` set → `is_active_member` false) loses read + write + cache + realtime access; re-joining restores all of it.
- [ ] `messages` remains immutable — no UPDATE/DELETE policy (unchanged).
- [ ] Idempotent; `DROP POLICY IF EXISTS` before each `CREATE POLICY`; no table recreate; no data changes.

### Out of scope

- The `conversations`/`conversation_members` schema + write RPCs (Spec 6).
- **Per-conversation realtime subscription in the UI** (later Phase 3 step). Spec 7 makes the authorization correct *regardless* of what the client subscribes to; narrowing the subscription to the open conversation is a later efficiency/UX change, not a security boundary.
- Any change to `/api/v1/translate` (stateless; history passed in body).

### Open questions

- **Legacy messages on the global sentinel `…0002`. RESOLVED 2026-06-12 — option (a), accept invisibility.** After 018, sentinel rows are visible only to members of conversation `…0002`, of which there are none, so they go dark. This is intended: they're pre-Phase-3 throwaway data and the global room is being retired. Isaac will run the read-only inventory SQL (below) on staging + prod to see exactly what falls dark, then purge it (`message_translations` cascade-deletes with their parent `messages` — delete the messages, translations follow). Purge and migrations are order-independent (the rows are simply unreachable either way), but purging is cleaner done before the prod replay so 017's `SET NOT NULL` + FK promotion validate against a smaller set. See decisions.md 2026-06-12 "Retire the global-room sentinel data". *(was: option (b) seed all profiles as members — rejected, pointless history-preservation for throwaway data.)*
- **Performance (note, not a blocker):** the `message_translations` EXISTS subquery + `is_active_member` run per cache row. Negligible at current scale (tens of testers) and index-backed (`messages(conversation_id)`, the `conversation_members` active lookup). Revisit only if per-conversation message volume grows large.

### Technical sketch (for implementation — Cowork)

- New file `migrations/018_phase3_messages_rls.sql`. Single `begin; … commit;`. Drops + recreates exactly five policies (`messages` SELECT + INSERT; `message_translations` SELECT + INSERT + UPDATE) with the membership predicate. No DDL beyond policies; no data changes. `is_active_member()` comes from 017.
- Sequencing: 018 runs *after* 017 on staging, gate GREEN, then both replay to prod in order (017 → 018). 018 must never reach prod before 017 (the helper + tables won't exist).
- Doc reconciliation in the same commit (DoD #3): architecture.md §7 (`messages` + `message_translations` RLS now membership-scoped), §10 (headline: global-room → membership authorization — the most security-relevant change since the Phase 2 RLS cutover), §13 file map (018); operations.md migrations list; roadmap.md Phase 3 (the messages-RLS line); verification.md (gate result).

### Verification plan

- New gate `scripts/messages-rls-gate-test.mjs` (extends the `scripts/rls-adversarial-test.mjs` patterns). Adversarial matrix: two users in one tenant; create a conversation with only user A; assert B **cannot** SELECT A's messages, **cannot** INSERT into the conversation, **cannot** read its cached translations, and **receives nothing** on realtime; add B as a member → assert B now **can** on all four; B soft-leaves → assert all four revoked again. Target GREEN on staging before any prod replay.
- Record the result + the full matrix in verification.md under "Phase 3 Step 2 — membership-scoped messages RLS (Spec 7)". Prod replay of 018 pending Isaac's merge approval and gated behind 017 being on prod first.

---

## Spec 4b — Event log wiring (Hermes-executed)

**Linked roadmap item:** Phase 1.5 → Infrastructure (checkbox 6 — `translation_events` and `agent_events` tables created and wired)
**Author:** Isaac (drafted with Cowork, 2026-06-02)
**Status:** **shipped 2026-06-10** (commits 8cfa0a2, a4131b2, 2dd38df on `main`). `translation_events` wired in `api/v1/translate.js` and `server/index.js`; `agent_events` wired via VPS hook. Verified on staging: `chat_app` rows appear after every translate call. Known gaps: `hermes_writer_user` role on staging has a Supabase JS-client permission quirk (staging uses `postgres` superuser credential for now); `agent_events` staging INSERT not yet verified end-to-end. See verification.md.
**Estimated time:** ~60-75 min
**Executor:** Hermes

### Goal

Wire `translation_events` writes into the translation call site so every translation call produces a row, and wire `agent_events` writes into Hermes's task lifecycle so every task produces an audit row. End state: after any translation, `SELECT * FROM translation_events ORDER BY created_at DESC LIMIT 1` shows a populated row; after any Hermes task, `SELECT * FROM agent_events ORDER BY created_at DESC LIMIT 1` shows a populated row.

### Prerequisites

- Spec 4a fully shipped (migrations 005 and 006 run against staging **and** prod; `hermes_writer` role provisioned; `DATABASE_URL_PROD_WRITER` in `~/.hermes/.env`)
- Hermes's working directory is `/home/hermes/work/translation-app` (confirmed in Spec 3)

### Acceptance criteria

**`translation_events` wiring**
- Every call to the translation pipeline in `api/v1/translate.js` (server-side) appends one row to `translation_events` using `DATABASE_URL_STAGING` on staging and `DATABASE_URL_PROD_WRITER` on prod. Client-side wiring is explicitly out of scope — write happens server-side where all required fields are known.
- Row captures all non-nullable fields: `schema_version=1`, `tenant_id` (from request context), `timestamp`, `target_language`, `was_cached`, `model_used`, `prompt_version`, `latency_ms`, `character_count`. Nullable fields (`task_id`, `user_id`, `input_tokens`, `output_tokens`, `cost_cents`, `retry_count`, `error_type`) populated where already available in the translate function; null otherwise.
- Write failure is non-blocking: if the `translation_events` INSERT fails, the translation response is still returned to the user. Log the error; do not surface it.
- No client-side changes. This is a server-side instrumentation concern only.

**`agent_events` wiring**
- Hermes generates a `task_id` UUID at the start of every task and threads it through all tool calls and sub-events for that task.
- At task completion (status: `completed`, `failed`, `escalated`, or `aborted`), Hermes inserts one row into `agent_events` using `DATABASE_URL_PROD_WRITER`. The row captures: `task_id`, `tenant_id` (hardcoded to the chat-app tenant UUID for now), `started_at`, `completed_at`, `status`, `task_summary`, `gateway`, `channel_id`, `channel_name`, `thread_id` (if applicable), `triggered_by`, `model_tier`, `model_used`, `tokens_in`, `tokens_out`, `cost_cents`, `files_changed`, `commits`, `deploys`, `decisions_drafted`, `skills_created`, `errors`, `approval_log`, `raw_report`. `schema_version=1`.
- If the INSERT fails, Hermes logs the failure in its end-of-task report under "What I noticed but didn't fix." Task is still marked complete; the failure does not trigger a retry.
- Idempotency: if `idempotency_key` is set and a row with that key already exists, the INSERT is silently skipped (ON CONFLICT DO NOTHING).

**Verification**
- Run a translation via the staging UI → `SELECT * FROM translation_events ORDER BY created_at DESC LIMIT 1;` returns a row with all non-nullable fields populated.
- Ask Hermes to do a trivial task (e.g. "confirm your working directory") → `SELECT * FROM agent_events ORDER BY created_at DESC LIMIT 1;` returns a populated row.
- Force a translation-events write failure (temporarily point to a bad connection string) → translation still succeeds; error appears in server logs.

### Out of scope
- Dashboard or query tooling on top of the event tables → §7.4, deferred
- `translation_events` wiring for any path other than `api/v1/translate.js` (e.g. future batch endpoints) → separate spec when those endpoints exist
- GDPR anonymisation pipeline on event tables → deferred per architecture.md §10

### Technical sketch (for Hermes)
1. Read `api/v1/translate.js` and locate the translate call site. Identify where `latency_ms`, `model_used`, `prompt_version`, `was_cached`, and `character_count` are already available or computable.
2. Add a `logTranslationEvent(fields)` helper (in a new `server/lib/events.js` module) that does the `translation_events` INSERT via the Postgres client. Non-blocking: wrapped in try/catch, logs errors, never throws.
3. Call `logTranslationEvent(...)` immediately after the translate response is obtained, before returning to the caller.
4. For `agent_events`: implement `startTask()` → returns `task_id`; `finishTask(task_id, fields)` → does the INSERT. Wire these into Hermes's task lifecycle hooks (consult Hermes Agent docs for the correct hook points — likely `on_task_start` and `on_task_complete` callbacks or equivalent).
5. Feature branch `hermes/event-log-wiring`, commit with descriptive message + why paragraph, open draft PR per §8.1.
6. Run both verification queries against staging. Report per §8.1.

---

## Spec 4a — Event log schema (Cowork-executed)

**Linked roadmap item:** Phase 1.5 → Infrastructure (checkbox 6 — `translation_events` and `agent_events` tables created and wired)
**Author:** Isaac (drafted with Cowork, 2026-06-02)
**Status:** **shipped 2026-06-02** (0f909a7). Migrations 005 and 006 run on staging and prod. `hermes_writer` role provisioned. hermes.md §7.2 and §7.3 finalized. Verification record: `/docs/verification.md` "Event log schema — Spec 4a". Decisions: 2026-06-02 entry in `/docs/decisions.md` (hermes_writer role scope).
**Estimated time:** ~45 min
**Executor:** Cowork (this session)

### Goal

Create the `translation_events` and `agent_events` tables via migrations, add `task_id` to `user_profile_events`, provision the `hermes_writer` Postgres role with INSERT-only access on the two new event tables, and update hermes.md §7 to reflect the finalized schemas. End state: migrations are run on staging and prod; Hermes has a write credential in `~/.hermes/.env`; hermes.md is the authoritative schema reference.

### Schema drift note

`supabase db diff` during Spec 3 showed prod tables as "to create" on staging — a known benign delta from the pre-migrations era. This is treated as a known delta, not a blocking issue. It is documented in `/docs/parking-lot.md` and is not addressed in this spec.

### Acceptance criteria

**Migration 005 — new event tables**
- `agent_events` created first (so `translation_events.task_id` can reference it logically, even though no FK is enforced).
- `translation_events` created second, per the finalized schema in `hermes.md` §7.2.
- `agent_events` per the finalized schema in `hermes.md` §7.3.
- Both tables created with correct indexes: `agent_events(tenant_id, channel_id, started_at DESC)` and `agent_events(task_id)`; `translation_events(tenant_id, timestamp DESC)` and `translation_events(task_id)`.
- Migration run against staging first, verified, then run against prod.
- Migration file: `005_event_log_tables.sql` with embedded verification queries at the bottom.

**Migration 006 — `task_id` on `user_profile_events`**
- `ALTER TABLE user_profile_events ADD COLUMN task_id uuid;` (nullable, no FK constraint — loose reference).
- Migration run against staging first, verified, then run against prod.
- Migration file: `006_user_profile_events_task_id.sql`.

**`hermes_writer` Postgres role**
- Role `hermes_writer` created on prod with INSERT-only on `translation_events` and `agent_events`. No SELECT, no UPDATE, no DELETE, no other tables.
- User `hermes_writer_user` created and granted the role.
- Connection string stored as `DATABASE_URL_PROD_WRITER` in `~/.hermes/.env` on the droplet (same pooler pattern as `DATABASE_URL_PROD_READONLY` from Spec 3, Session mode, port 5432).
- Smoke test: `psql $DATABASE_URL_PROD_WRITER -c "INSERT INTO agent_events ..."` succeeds; `SELECT` on the same table fails with permission denied; INSERT into any other table fails.

**hermes.md §7 updated**
- §7.2 and §7.3 reflect the finalized schemas (done — completed before this spec was written).
- No further §7 changes needed in this spec.

**Docs hygiene**
- `decisions.md` entry drafted for `hermes_writer` role scope choice (follows same pattern as `hermes_readonly` entry from Spec 3).
- `roadmap.md` Phase 1.5 checkbox 6 marked done with commit reference after migrations run on prod.
- `verification.md` gets a new "Event log schema — Spec 4a" section with: migration run order, verification queries for each migration, `hermes_writer` smoke test checklist.
- Spec status updated to shipped with commit reference.

### Out of scope
- Wiring `translation_events` or `agent_events` writes into the application → **Spec 4b** (Hermes-executed)
- Dashboard tooling on top of the event tables → §7.4, deferred
- Schema drift cleanup (vestigial columns on `messages`) → parking-lot item, separate spec

### Technical sketch
1. Write `migrations/005_event_log_tables.sql` — `agent_events` then `translation_events`, indexes, verification queries.
2. Write `migrations/006_user_profile_events_task_id.sql` — ALTER TABLE, verification query.
3. Run 005 against staging SQL editor → verify → run against prod → verify.
4. Run 006 against staging → verify → run against prod → verify.
5. Create `hermes_writer` role on prod via SQL editor; store connection string in `~/.hermes/.env` on droplet; run smoke test.
6. Docs cleanup: decisions.md entry, verification.md section, roadmap checkbox, spec status → shipped.

### Verification queries (embedded in migration files; re-run anytime)

```sql
-- After 005:
SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name = 'agent_events' ORDER BY ordinal_position;
SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name = 'translation_events' ORDER BY ordinal_position;
SELECT indexname FROM pg_indexes WHERE tablename IN ('agent_events','translation_events');

-- After 006:
SELECT column_name FROM information_schema.columns
  WHERE table_name = 'user_profile_events' AND column_name = 'task_id';

-- hermes_writer smoke test:
-- (run as hermes_writer_user via DATABASE_URL_PROD_WRITER)
INSERT INTO agent_events (task_id, tenant_id, started_at, status, task_summary, gateway, model_tier, model_used, schema_version)
  VALUES (gen_random_uuid(), '<chat_app_tenant_id>', now(), 'completed', 'smoke test', 'cli', 'sonnet', 'claude-sonnet-4-6', 1);
-- expect: INSERT 0 1
SELECT count(*) FROM agent_events;
-- expect: permission denied for table agent_events
INSERT INTO messages (sender_id, original_text) VALUES ('test', 'test');
-- expect: permission denied for table messages
```

---

## Spec 3 — Hermes Agent access credentials (GitHub / Supabase / Vercel)

**Linked roadmap item:** Phase 1.5 → Infrastructure (checkbox 5 — Hermes access credentials)
**Author:** Isaac (drafted with Cowork/Opus, 2026-06-02)
**Status:** **shipped 2026-06-03** (73835e5). All six smoke tests passed or partial-passed with known caveats. Verification record: `/docs/verification.md` "Hermes access credentials — Spec 3 (2026-06-03)". Decisions: 2026-06-03 entries in `/docs/decisions.md` (GitHub PAT scope; Supabase readonly role; Vercel prod-deploy gating). Side-effects noted: Docker Engine installed on VPS (required by `supabase db diff`); Node.js v20 + npm-global config installed (required by Vercel CLI); `DATABASE_URL_STAGING` added to `.env` (gap discovered during ST4); `terminal.cwd` set in `config.yaml` (`MESSAGING_CWD` env var is not a real Hermes variable).
**Estimated time:** ~75 min (branch protection step removed; readonly Postgres role still in scope per OQ2)

### Goal
Give Hermes the access it needs to actually touch the Translation App project end-to-end: clone the repo, branch, commit, push, open a PR, run migrations against staging, deploy to staging. End state: Isaac sends Hermes a spec via Discord; Hermes can take it from "read the brief" through "branch + code + test + staging deploy + PR + report per §8.1" without any further infra setup. Prod merges and prod migrations still require Isaac's explicit "yes" each time — same two-confirm pattern that already governs every destructive op, leveraging the framework's native dangerous-command approval (per Hermes Agent security docs §3.2) plus charter §6.2.

### Acceptance criteria

**GitHub access**
- Fine-grained Personal Access Token created in Isaac's GitHub account, scoped to the single Translation App repository (not "all repositories"), with permissions: *Contents: read+write, Pull requests: read+write, Metadata: read* (auto). No admin, no workflows, no actions, no repository secrets. **Created 2026-06-02; expires 2026-09-01.** Rotation reminder set; rotation event documented in operations.md ritual.
- Token stored as `GITHUB_TOKEN` in `~/.hermes/.env` (mode 600). Never in tracked files; verified via `git status` clean + `grep -r GITHUB_TOKEN` showing only docs references.
- `gh` CLI installed on the droplet (`apt install gh` or distro equivalent; `gh --version` returns ≥ 2.x). Authenticated via `gh auth login --with-token` reading the same token; `gh auth status` returns green.
- Repo cloned to `/home/hermes/work/translation-app/` (HTTPS clone using PAT — no SSH key for the repo). `git config user.name "Hermes Agent"` and `git config user.email <Isaac decides: noreply or aliased>` set for the hermes user.
- **Smoke test 1 — clone + pull.** `git clone https://x-access-token:$GITHUB_TOKEN@github.com/<owner>/<repo>.git /home/hermes/work/translation-app` succeeds. `cd` in; `git pull` works; `git status` clean.
- **Smoke test 2 — branch, push, PR.** Hermes creates a `hermes-test-spec3` branch, makes a trivial change (touches `/tmp/throwaway.md` then reverts in working tree — no actual repo content modified), pushes via `git push --set-upstream origin hermes-test-spec3`, opens a draft PR via `gh pr create --draft --title "Spec 3 smoke test" --body "Verifies push + PR auth"`. PR appears in GitHub UI. Hermes closes the PR + deletes the branch (local and remote) at the end.
- **Branch protection: deferred.** Both Rulesets and legacy Branch protection rules require a paid GitHub tier (Pro/Team) for private repos — confirmed 2026-06-02. Decisions.md 2026-06-02 entry captures the deferral with revisit triggers. Behavior-enforcement only for now: charter §6.1 (no direct pushes to main) + the framework-level git wrapper described in charter §11.1 #7 (agent's git wrapper aborts on main without explicit authorization). One of two §11.1 #7 mitigations holds; the platform-level one waits until cost justification or a near-miss.

**Supabase access**
- Supabase personal access token created at `https://supabase.com/dashboard/account/tokens`, named "hermes-prod". **Created 2026-06-02; expires 2026-09-01.** Stored as `SUPABASE_ACCESS_TOKEN` in `~/.hermes/.env` (mode 600). Rotation reminder set.
- Supabase CLI installed on the droplet (`npm install -g supabase` or distro package; `supabase --version` ≥ current stable). `supabase login --token $SUPABASE_ACCESS_TOKEN` succeeds non-interactively. `supabase projects list` returns both `translationapp1` (prod) and `translationapp1-staging`.
- Both project refs added to `~/.hermes/.env` as `SUPABASE_PROJECT_REF_PROD=...` and `SUPABASE_PROJECT_REF_STAGING=...`.
- **Smoke test 3 — staging diff.** `supabase db diff --linked --project-ref $SUPABASE_PROJECT_REF_STAGING` runs cleanly (read-only; surfaces drift between `/V1/migrations/` and remote schema). Expected output: no drift, or minor expected drift that Isaac eyeballs.
- **Smoke test 4 — destructive prompt fires.** Hermes attempts a `DROP TABLE test_xyz` against staging via `supabase db execute`. Framework's dangerous-cmd approval (per security docs §3.2) prompts on Discord. Isaac replies "no" → command blocked. No table actually needs to exist; the prompt firing is what's being verified.
- *(If Open Question 2 = b or c)* Whichever read-isolation mechanism is chosen is implemented + smoke-tested: under (b), `DATABASE_URL_PROD_READONLY` connection string created with a SELECT-only Postgres role, stored in `~/.hermes/.env`, and `psql $DATABASE_URL_PROD_READONLY -c "SELECT count(*) FROM messages;"` returns a number; `INSERT` against the same role fails as expected. Under (c), Hermes's Supabase account has prod scoped to read-only via invitation, verified by attempting a staging-write (succeeds) and a prod-write (fails with permission error).

**Vercel access**
- Vercel personal access token created at `https://vercel.com/account/tokens`, named "hermes-prod". **Created 2026-06-02; expires 2026-08-31 (earliest expiry across the three — this is the rotation trigger date).** Stored as `VERCEL_TOKEN` in `~/.hermes/.env` (mode 600). Rotation reminder set.
- Vercel CLI installed on the droplet (`npm install -g vercel`; `vercel --version` ≥ current stable). `vercel whoami --token $VERCEL_TOKEN` returns Isaac's Vercel handle (or team if project lives under one).
- From inside `/home/hermes/work/translation-app/`, `vercel link --yes --token $VERCEL_TOKEN` connects to the existing Translation App Vercel project; `.vercel/project.json` written. (This file is per-clone, not committed.)
- **Smoke test 5 — preview deploy.** Hermes creates `hermes-test-spec3-deploy`, makes a no-op commit, runs `vercel deploy --token $VERCEL_TOKEN` (default = preview). Returns a `*.vercel.app` URL. Isaac visits → confirms it's pointed at staging Supabase (per Phase 2 staging env-var config from 2026-05-18). Branch deleted after.
- **Smoke test 6 — prod-deploy gating.** Hermes is asked to do a prod deploy. Per charter §6.2, Hermes posts a confirmation plan to Discord *before* running `vercel deploy --prod`. Isaac replies "no" → no deploy. Then test the positive path on a real (or trivially-no-op) prod-worthy change: Isaac replies "yes" → deploy happens → confirm via Vercel dashboard.

**Working directory + gateway**
- `MESSAGING_CWD=/home/hermes/work/translation-app` added to `~/.hermes/.env`. Gateway picks it up after `sudo systemctl restart hermes-gateway`. Verified by DM'ing Hermes "what is your current working directory?" → returns `/home/hermes/work/translation-app`.
- Reboot persistence from Spec 2 still passes: `sudo reboot`, SSH back in, `systemctl status hermes-gateway` shows active running, working directory still correct.

**Approval-mode posture preserved**
- `~/.hermes/config.yaml` `approvals` block remains: `mode: manual`, `cron_mode: deny`, `mcp_reload_confirm: true`, `destructive_slash_confirm: true`. No YOLO mode introduced anywhere. No new entries to `command_allowlist` unless a specific smoke test legitimately requires one (none anticipated).

**Docs hygiene**
- `decisions.md` entries drafted by Cowork for: (a) GitHub fine-grained-PAT scope choice; (b) Supabase auth model chosen per Open Question 2; (c) Vercel prod-deploy gating mechanism per Open Question 3. Per-entry approval per charter §2.
- `verification.md` gets a new "Hermes access credentials — Spec 3 (YYYY-MM-DD)" section: the six smoke tests above as a re-runnable checklist, a `~/.hermes/.env` variable-name inventory (names only, never values), a post-rotation checklist (re-run all six smokes after any PAT rotation), and a known-failure-modes table.
- `hermes.md` §10.7 updated to reflect actual mechanisms (currently aspirational; this spec operationalizes them).
- `roadmap.md` Phase 1.5 checkbox 5 marked done with commit reference; line updated.

### Out of scope (later specs)
- `translation_events` and `agent_events` schema → **Spec 4**
- First Hermes-touches-codebase real task → **Spec 5+**
- Supabase backups beyond DO's weekly snapshots → defer; staging restore drill is its own spec once Hermes is doing real work
- Secrets-management upgrade (Doppler / 1Password Connect / Vault) → defer; `~/.hermes/.env` is sufficient for single-VPS, single-operator
- GitHub Actions / CI integration → defer; no CI today
- Token rotation automation → manual rotation on 90-day calendar; automate later if it becomes painful

### Open questions (resolved 2026-06-02)

1. **Enable GitHub branch protection on `main`?** *Resolved: **yes intent → deferred in practice.*** Both Rulesets and legacy Branch protection rules require GitHub Pro/Team for private repos (Isaac verified 2026-06-02). Deferred to a future trigger (cost-justifiable upgrade or first agent-initiated near-miss). Behavior-enforcement only for now via charter §6.1 + framework git wrapper. Full reasoning + revisit triggers in decisions.md 2026-06-02 entry. Captured as a parking-lot item under Infrastructure.

2. **Supabase prod write-access model.** *Resolved: **(b)** — single PAT + separate read-only Postgres role + `DATABASE_URL_PROD_READONLY` for prod inspection.* Read/write separation at the connection-string layer; writes still go through PAT and §6.2 gating. Captures most of option (c)'s blast-radius story without the second-account overhead.

3. **Vercel prod-deploy gating mechanism.** *Resolved: **(a)** — operating-contract only.* Charter §2 + §6.2 require Hermes to post a confirmation plan to Discord before running `vercel deploy --prod`. Same enforcement layer as every other §6.2-gated op. Wrapper-script option (c) captured as a parking-lot item to add if (a) ever fails in practice.

4. **PAT expiry / rotation cadence.** *Resolved: **90 days** across all three (GitHub, Supabase, Vercel).* Actual creation dates 2026-06-02; expiry dates 2026-08-31 (Vercel) and 2026-09-01 (GitHub, Supabase). **Rotation trigger date: 2026-08-31** (earliest expiry; rotate all three in the same sitting to keep one calendar slot). Ritual added to `operations.md` and monthly digest. **PAT** = Personal Access Token; the GitHub-issued credential (and the equivalent in Supabase / Vercel) that acts like a scoped, revocable password for CLI + API access. Fine-grained PATs are scoped to specific repos with specific permission slices (Contents read+write, Pull requests read+write, etc.) — narrower blast radius than the classic per-account PAT.

### Technical sketch (fill out fully at execution; key sequencing only here)

1. **Open questions resolved with Isaac** (~10 min). Walk OQ 1–4, lock answers, mark spec **approved**, capture the resolution in the spec body.
2. **GitHub** (~20 min). PAT already created (token in Isaac's password manager); install `gh` on the droplet → `gh auth login --with-token` → store `GITHUB_TOKEN` in `~/.hermes/.env` → clone repo → set git config → smoke tests 1 + 2.
3. ~~Branch protection~~ — deferred per OQ1 resolution; no work this session.
4. **Supabase** (~25 min — OQ2 = b path). PAT already created; install supabase CLI → `supabase login --token` → store `SUPABASE_ACCESS_TOKEN` + both project refs in `~/.hermes/.env` → smoke tests 3 + 4. Then: create read-only Postgres role on prod via SQL editor (CREATE ROLE hermes_readonly with SELECT-only grants on app schemas), capture connection string, store as `DATABASE_URL_PROD_READONLY` in `~/.hermes/.env`, verify read works + write fails.
5. **Vercel** (~15 min). Token already created; install CLI → store `VERCEL_TOKEN` in `~/.hermes/.env` → `vercel link` → smoke test 5 → smoke test 6 (gating walkthrough negative path; positive path deferred until first real prod-worthy deploy is queued).
6. **Working directory + gateway restart** (~5 min). Set `MESSAGING_CWD` → restart `hermes-gateway` → verify cwd via DM.
7. **Docs cleanup** (~15–20 min). Decisions entries drafted + per-entry approval per charter §2 (entries a/b/c per Docs Hygiene below — note: branch-protection deferral entry already landed in this session's pre-execution commit, so not re-drafted at execution time); verification.md section created; hermes.md §10.7 updated; roadmap checkbox 5 done; spec status → shipped; one commit covers it.

### Verification plan
Full record lives in `/docs/verification.md` "Hermes access credentials — Spec 3 (YYYY-MM-DD)" after ship. Includes: the six smoke tests above as a re-runnable checklist, `~/.hermes/.env` inventory (names only), post-rotation checklist, known-failure-modes table seeded with the obvious candidates (token expired; PAT scoped wrong; supabase project ref typo; vercel project not linked; etc.).

---

## Spec 5 — Autonomous test harness

**Linked roadmap item:** Phase 1.5 → "Promote items pulled from parking lot" (Autonomous test harness for agent-driven builds)
**Author:** Isaac (drafted with Cowork, 2026-06-09)
**Status:** approved
**Estimated time:** ~60–90 min
**Executor:** Hermes

### Goal

Build a scripted, repeatable integration test that Hermes can run end-to-end without human involvement before any staging deploy. End state: `node scripts/test-harness.js` runs from the VPS, drives the staging translate API through a fixed set of test cases, asserts expected DB state, and exits 0 (pass) or non-zero (fail) with descriptive output. This is the prerequisite for Hermes operating beyond supervised mode — without it, there is no automated check that a change didn't break translation quality, profile inference, or the event log.

### Acceptance criteria

**Script setup**
- Script at `scripts/test-harness.js`, runnable via `node scripts/test-harness.js` from `/home/hermes/work/translation-app/`.
- Reads all credentials from env vars already present in `~/.hermes/.env` (staging Supabase URL + anon key + staging translate endpoint). No new env vars added; no credentials hardcoded.
- Outputs a per-assertion result line: `[PASS] translation_events row written` / `[FAIL] was_cached=false expected, got true`.
- Exits 0 if all assertions pass, non-zero on any failure. Compatible with being called from a shell one-liner.
- All test data written during the run (messages, translations, profile rows, event rows) is cleaned up in a `finally` block — runs regardless of pass or fail.

**Translation path assertions**
- Sends a fixed Spanish message (`"Che, vamos al cine esta noche?"`) through the staging translate endpoint with `target_language: "en"` and a minimal test user context (preferred_language + tenant_id).
- Asserts response structure: `translated_text` (non-empty), `detected_language: "es"`, `inferences` object present with at least `detected_dialect`, `detected_register`, `gender_signal` fields.
- Sends the identical message a second time. Asserts `was_cached: true` on the second response.
- DB check: `translation_events` has one row per call; `was_cached` matches expected; `latency_ms`, `character_count`, and `model_used` are non-null.

**No dialect contamination check**
- Sends an English message (`"Hey, what are you up to tonight?"`) through the endpoint using the same test user (who now has a Spanish dialect in their inferred profile from the prior step).
- Asserts that `user_linguistic_profiles.dialect_region` for the test user is NOT updated with a Spanish dialect code as a result of the English-source message.

**Failure mode check**
- Calls the translate endpoint with a malformed request (missing `target_language`). Asserts the response is a non-2xx error, not a hallucinated translation.

**Hermes pre-deploy protocol**
- `hermes.md` updated (per §4 #11 proposal + Isaac approval) to document that Hermes runs `node scripts/test-harness.js` and confirms a 0 exit before every staging deploy. If the harness exits non-zero, deploy is blocked and Isaac is notified per §8.4 failure format.
- A new Hermes skill (`run_test_harness`) proposed per §6.8 (Hermes surfaces it in the task report; Isaac approves on first use).

### Out of scope
- UI / browser automation — this drives the API directly, not the frontend
- CI gate (GitHub Actions) — Layer 1 of the testing pyramid; this spec builds Layer 3; CI gate is a later spec
- Translation quality benchmark — needs a corrections corpus; separate spec when Phase 4 begins
- Testing against prod — staging only; prod test traffic would pollute `translation_events` with `event_source='hermes_test'` rows

### Open questions (resolve at execution)
1. **Stable staging URL?** Is there a fixed staging Vercel URL, or does it rotate per branch? If no stable URL, the script should derive it from `vercel ls --token $VERCEL_TOKEN` at run time and pick the most recent non-main preview deploy.
2. **Profile row cleanup safety.** The test writes inferred rows to `user_linguistic_profiles`. Deletion is safe (history remains in `user_profile_events`), but confirm the test user's `user_id` won't collide with any real staging data before deleting. Staging has only `staging_test_a` and `staging_test_b` seeded — use one of those or a clearly namespaced UUID.

### Technical sketch (for Hermes)
1. Read `api/v1/translate.js` and `server/lib/events.js` to understand the request shape, response shape, and what fields are written to `translation_events`.
2. Read `src/lib/config.js` for the chat-app tenant UUID.
3. Write `scripts/test-harness.js` using Node built-in `fetch` (Node 18+, no new npm dependency). Structure: `setup()` → test cases in sequence → `teardown()` in a `finally` block. Each test case is a named function that returns `{passed: bool, message: string}`.
4. Use the Supabase REST API (same anon key as the frontend) for DB assertions — query `translation_events`, `message_translations`, `user_linguistic_profiles` directly via fetch.
5. Feature branch `hermes/test-harness`, commit with descriptive message + why paragraph, open draft PR per §8.1.
6. Run the harness from the VPS (`node scripts/test-harness.js`) and include the full output in the task report.
7. Propose the `hermes.md` pre-deploy protocol update per §4 #11 — wait for Isaac's explicit approval before that doc change lands.

### Verification plan
After ship: Hermes runs the harness and pastes the full output in the Discord task report. Isaac spot-checks one assertion (e.g., queries `translation_events` in the Supabase staging dashboard and confirms a matching row). Spec marked shipped when all assertions green and cleanup confirmed.

---

## Spec 2.1 — Hermes Agent — Opus tier override, Hermes-internal cost caps, browser tools activation

**Linked roadmap item:** Phase 1.5 → Infrastructure (checkbox 3 follow-up — finish the *tiered* part of tiered model routing)
**Author:** Isaac (drafted with Cowork, 2026-06-02; carved out of Spec 2 on ship day)
**Status:** **approved** (usage signal confirmed — Spec 4b executed end-to-end on Discord 2026-06-10; ready to schedule)
**Estimated time:** ~45-60 min

### Goal
Close the residual items from Spec 2's narrowed scope: implement the per-agent tier override that routes specific Hermes-side tasks to Opus per `/docs/hermes.md` §3 escalation rules; layer Hermes-internal cost caps under the Anthropic console-side caps as defense-in-depth; activate the optional browser tools that warned at startup (`websockets` module + Playwright); minor operator-experience improvements like adding `hermes` to the `systemd-journal` group so debugging doesn't require `sudo`.

### Acceptance criteria
- Hermes's `~/.hermes/config.yaml` defines per-agent tier overrides that map the §3 escalation triggers (touches >3 files; touches translate prompt/API/schema; second-attempt failure; ambiguous task; pre-implementation checklist hit) to Opus 4.6 (`claude-opus-4-6` or current equivalent). Exact YAML structure resolved against the Hermes Agent docs at ship time.
- A deterministic smoke test exists: a known prompt or test agent triggers Opus on first turn, Sonnet on a follow-up turn. Verified via Anthropic console showing both models used in the smoke-test window.
- Hermes-internal `limits:` block (or equivalent — schema confirmed against docs) layered under the Anthropic vendor-side cap. Daily soft = $1, daily hard = $3 (returns to spec wording now that we can express this at the Hermes layer). Anthropic monthly cap stays at $64 as the outer safety net.
- Browser tools cleanly registered: `pip install websockets` in the venv eliminates the `browser_dialog_tool` import warning at startup. Playwright Python package installed in the venv and `playwright install chromium` run; system Chromium libs from Spec 1 Phase C are reused. `hermes acp --setup-browser` (or successor) runs cleanly. Smoke test: ask Hermes to fetch a known URL and summarize.
- `sudo usermod -aG systemd-journal hermes` so hermes user can `journalctl -u hermes-gateway` without sudo. Verified by a fresh shell.
- No regressions: Spec 2's verification record (`/docs/verification.md` "Hermes model routing + Discord gateway") still passes end-to-end after these changes.
- `decisions.md` entries drafted by Cowork for the non-trivial choices that surface (e.g. exact tier YAML structure if unusual; any Playwright/browser config that requires explanation). Per-entry approval per charter §2.

### Out of scope (later specs)
- Access credentials (GitHub PAT, Supabase CLI, Vercel CLI) → **Spec 3**
- `translation_events` / `agent_events` schema → **Spec 4**
- First Hermes-touches-codebase task → **Spec 5+**
- Multi-gateway expansion (Telegram/Slack/email alongside Discord) → deferred per Spec 2

### Open questions (resolve at execution)
1. Exact YAML structure for per-agent tier overrides in Hermes Agent v0.14.0 — read docs first, draft against schema.
2. Whether browser tools want the `pip install hermes-agent[browser]` extra or a manual `pip install websockets playwright` — confirm against docs.
3. Cost-cap config: env-var keys (`LIMITS_DAILY_SOFT_USD=...`) vs config.yaml `limits:` block — pick whichever matches v0.14.0's actual schema.

### Technical sketch (skeletal — fill out at execution)
1. Read Hermes Agent docs for tier overrides + limits + browser tools (~10 min).
2. Edit `~/.hermes/config.yaml` for tier overrides + Hermes-internal limits (~10 min).
3. `pip install websockets` and Playwright per docs (~10 min).
4. `hermes acp --setup-browser` (or equivalent) and verify browser tool registration (~5 min).
5. `sudo systemctl restart hermes-gateway` and verify clean startup with no warnings (~3 min).
6. Smoke tests: Opus escalation triggered + browser fetch + non-allowed user ignored (~10 min).
7. `sudo usermod -aG systemd-journal hermes` + verify (~2 min).
8. Docs cleanup: update spec status → shipped, append decisions entries, refresh verification.md "Hermes model routing + Discord gateway" with the new items, mark Phase 1.5 checkbox 3 fully done (~15 min).

### Verification plan
Will be merged into the existing `/docs/verification.md` "Hermes model routing + Discord gateway" section as a `2026-XX-XX update` paragraph rather than a fresh section — same shipped surface, just hardened.

---

## Spec 2 — Hermes Agent model routing + Discord gateway

**Linked roadmap item:** Phase 1.5 → Infrastructure (checkboxes 3 and 4 — configure tiered model routing; wire up one messaging gateway)
**Author:** Isaac (drafted with Cowork, 2026-06-01)
**Status:** **shipped 2026-06-02 (narrowed).** What shipped: Sonnet default routing, Discord gateway as a systemd service, allowlist enforcement, reboot persistence, vendor-side cost caps. What got carved out into **Spec 2.1**: per-agent Opus tier override; Hermes-internal cost-cap layer; full browser tools activation; `systemd-journal` group add for hermes. Verification record: `/docs/verification.md` "Hermes model routing + Discord gateway (2026-06-02)". Decisions: 2026-06-02 entries in `/docs/decisions.md` (Anthropic direct provider; vendor-side cost caps via Anthropic console).
**Estimated time:** 1.5–2 hours. Actual: ~2 hours for the execution session (browser prep + droplet config + reboot test); docs cleanup added ~25 min.

### Goal
Get Hermes responsive on Discord with Sonnet as the default model and Opus available via per-task escalation, gated by the rules in `/docs/hermes.md` §3. End state: Isaac sends a Discord DM (or channel message) to the Hermes bot from his phone; Hermes receives it, routes to Sonnet by default, responds with a §8.1-style task report; Anthropic billing reflects the call. No actual project work executed yet — that's Spec 3 (access credentials) and beyond.

### Acceptance criteria
- Discord bot application created in Isaac's Developer Portal account, bot user enabled, "Public Bot" disabled (single-user posture per `/docs/hermes.md` §6.3).
- Message Content Intent enabled on the bot (required for Hermes to read DMs and channel messages).
- Bot token saved in Isaac's password manager and exported on the droplet via `~/.hermes/.env` (mode 600), referenced from Hermes Agent's config — Option B per the 2026-06-01 spec-approval session.
- Private Discord server created by Isaac, dedicated channel (e.g. `#hermes-prod`) inside it, bot invited via OAuth2 URL with `bot` + `applications.commands` scopes and the minimum permissions Hermes Agent requires.
- `hermes gateway setup` run against Discord; gateway configured and able to start cleanly. Hermes Agent's slash-command registration succeeds on first start.
- Hermes's `config.yaml` (path TBD per Hermes Agent convention — likely `~/.hermes/config.yaml`) sets the default model to Sonnet 4.6 (exact provider string resolved at execution time per `hermes model`), with per-agent tier overrides defined for the escalation triggers in `/docs/hermes.md` §3 routing to Opus 4.6 or current equivalent.
- AI provider: **Anthropic direct** (decided 2026-06-01). Switching to OpenRouter remains a ~15-20 min config-only change plus a `decisions.md` entry if we ever want to A/B-test other providers; the abstraction boundary at `architecture.md` §3.10 makes this cheap.
- Anthropic API key stored in `~/.hermes/.env` only, never in committed config. Confirmed not present in any tracked file via `git status` and `grep -r ANTHROPIC_API_KEY .` (the latter should only show documentation references).
- **Conservative cost caps for first 72 hours:** $1/day Claude API soft cap / $3/day hard cap (vs charter §6.5 defaults of $5/$15). Auto-pause at hard cap. Caps raised to charter defaults via a follow-up `decisions.md` entry once we have signal on actual usage. Decided 2026-06-01.
- Charter §6.3 enforcement: Hermes is configured to treat *only* Isaac's Discord user ID as an authorized sender; messages from any other user ID are logged but not acted on. Mechanism is a Hermes Agent config setting; exact key confirmed during `hermes gateway setup`.
- Hermes Agent runs as a persistent systemd service (`/etc/systemd/system/hermes-agent.service`) configured to restart on boot, so the droplet rebooting doesn't take Hermes offline. Service status checks documented.
- End-to-end smoke test 1 (version check): Isaac DMs the bot "what's your version?" from his phone. Hermes responds with `hermes --version` output (or equivalent) within ~10 seconds. Anthropic dashboard shows one API call. No errors in `journalctl -u hermes-agent`.
- End-to-end smoke test 2 (escalation): Isaac issues a task that should trigger §3 Opus escalation rules (specific prompt TBD per open question 7 — resolved during execution). Hermes uses Opus for that turn; Sonnet for the next. Verified via Anthropic billing showing both models used.
- Cost telemetry: first 24 hours of Discord traffic totals under the tightened $1/day soft cap. Documented in the verification record.
- `decisions.md` entries drafted by Cowork for the non-trivial choices captured during execution (provider choice, cost-cap conservative posture, private-server posture, any model-string specifics that surface). Awaits Isaac's per-entry approval per charter §2.

### Out of scope (later specs)
- GitHub PAT, Supabase CLI auth, Vercel CLI auth → **Spec 3** (access credentials)
- `translation_events` and `agent_events` tables → **Spec 4**
- Hermes-touches-the-codebase tasks (first real spec executed by Hermes) → **Spec 5+**
- Multi-gateway (Slack/email/Telegram in addition to Discord) → deferred indefinitely; revisit after 30-day Discord operation
- Voice mode → not in scope; if interesting later, separate spec
- Skill installation / customization beyond what `hermes gateway setup` registers by default → deferred to a Hermes-operations spec post-Day 7

### Open questions (resolved 2026-06-01 / 2026-06-02)
1. **AI provider** — *Resolved (06-01):* **Anthropic direct**. Switching to OpenRouter remains a config-only change later if we want to A/B-test providers. See decisions.md 2026-06-02 entry.
2. **Cost caps** — *Resolved (06-02):* **Anthropic vendor-side caps**, not Hermes-internal. $1/day target + $64/month max with email warnings at $15 and $40 of monthly spend. Spec's original "$1 soft / $3 hard daily" wording doesn't translate well to monthly billing — captured in decisions.md 2026-06-02 entry. Hermes-internal layer of caps deferred to Spec 2.1.
3. **Where the API key lives** — *Resolved (06-01):* **Option B**, `~/.hermes/.env` (mode 600). Confirmed by Hermes Agent docs as the canonical location for `ANTHROPIC_API_KEY` (and `DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_USERS`).
4. **Private Discord server or DM-only** — *Resolved (06-01):* **Private server with a dedicated channel** (`#hermes-prod`). Bot configured with home channel ID for cron output / proactive messages.
5. **Exact model strings** — *Resolved (06-02):* Active model is `claude-sonnet-4-6` (hyphen-separated, no provider prefix in `hermes model` flow). Set via `hermes model` → Anthropic → "Use existing credentials" → model picker.
6. **Single-user identity verification config** — *Resolved (06-02):* `DISCORD_ALLOWED_USERS` in `~/.hermes/.env` (comma-separated user IDs). Gateway denies all users without this set. Verified enforcement: the wizard explicitly required setting this before completing.
7. **Smoke-test trigger for Opus escalation** — *Deferred to Spec 2.1.* The per-agent tier override mechanism needs more docs deep-dive than this session warranted; carving into a focused follow-up rather than improvising config schema.

### Technical sketch — as executed 2026-06-02 (status of each step)
1. **Anthropic API key obtained.** *Done.* Existing console account; new key tagged "hermes-prod" generated; saved to password manager. Billing already enabled.
2. **Discord bot created.** *Done.* Developer Portal → New Application → "Hermes-prod" → Bot tab → Public Bot OFF + Message Content Intent ON + Reset Token → token saved to password manager. **Note:** Installation tab also required Install Link → "None" to allow Public Bot OFF (newer Discord UI mechanic; documented in failure-mode table).
3. **Private Discord server created.** *Done.* "Hermes" server with `#hermes-prod` channel. OAuth2 URL Generator → `bot` + `applications.commands` scopes + read/send/history/slash perms → bot invited and member-listed (offline until gateway started).
4. **Env vars on droplet.** *Done.* `~/.hermes/.env` populated with `ANTHROPIC_API_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_USERS`. Mode 600, owner hermes. Auto-loaded by Hermes Agent (no extra config.yaml wiring needed — framework reads `~/.hermes/.env` natively).
5. **`hermes model`** *Done.* Anthropic provider detected from env (showed `Anthropic credentials: sk-ant-api03... ✓` and `(-)` against Anthropic in the picker). "Use existing credentials" → model picker → Sonnet 4.6 selected. Resolved model string: `claude-sonnet-4-6`.
6. **`hermes gateway setup` for Discord.** *Done.* Interactive wizard saved Discord token, allowlist (Isaac's user ID), and home channel ID (`#hermes-prod` channel) into `.env` and config.
7. **Cost caps.** *Done at Anthropic console layer (not Hermes-internal).* See decisions.md 2026-06-02 entry. Hermes-internal layer deferred to Spec 2.1.
8. **Persistent service via systemd.** *Done.* Service: `hermes-gateway.service` at `/etc/systemd/system/`. Installed via `sudo /home/hermes/.hermes/venv/bin/hermes gateway install --system --run-as-user hermes` (sudo strips PATH, hence the full path — captured in verification.md known failures). `systemctl status` shows active running with hermes as the service user. Enabled (auto-start on boot).
9. **Smoke test 1: version check.** *Done.* DM "@Hermes-prod what version are you running?" → Hermes responded by actually running `pip show hermes-agent` on the droplet and reporting "Hermes Agent v0.14.0 by Nous Research." End-to-end Discord → Sonnet → tool use → response chain validated.
10. **Configure Opus escalation tier.** *Carved out to Spec 2.1.*
11. **Smoke test 2: escalation.** *Carved out to Spec 2.1.*
12. **Reboot persistence test.** *Done (replaces the original "24-hour cost observation" item — observation continues passively post-ship).* `sudo reboot`, SSH back in, `systemctl status hermes-gateway` showed `active (running)` with newer `ActiveEnterTimestamp` (PID 3395 → 772). Bot Online in Discord without intervention. systemd `enabled` is doing its job.
13. **Document and decide.** *In flight as part of the ship commit.*

### Verification plan
Full verification record (run-after-any-change checklist, operational notes, known failure modes) lives in `/docs/verification.md` "Hermes model routing + Discord gateway (2026-06-02)". Re-run after any infra or config change.

### Failure-mode preview (rolled into the verification.md section above)
| Symptom | Likely cause | Fix |
|---|---|---|
| Bot shows online but never responds to DMs | Message Content Intent not enabled in Developer Portal | Bot page → Privileged Gateway Intents → toggle on, Save Changes, restart `hermes-gateway` |
| Developer Portal blocks toggling Public Bot OFF | Install Link set to public-discoverable mode | Installation tab → Install Link → **None** → save → return to Bot tab → toggle Public Bot OFF |
| `sudo hermes ...` returns "command not found" | sudo strips PATH; venv binary not in default sudo path | Use full path: `sudo /home/hermes/.hermes/venv/bin/hermes ...` |
| `journalctl -u hermes-gateway` shows no Discord connection logs (just one warning) | hermes user isn't in `systemd-journal` group; can only see process's own log lines | Use `sudo journalctl ...` for now; Spec 2.1 adds hermes to `systemd-journal` group |
| `hermes gateway setup` fails with "invalid token" | Token copied with trailing whitespace, or token was reset after copy | Reset Token in Developer Portal, recopy carefully, re-run `hermes gateway setup` and choose Reconfigure |
| 401 from Anthropic on first call | API key not in `~/.hermes/.env`; key has no billing enabled | Verify file contents + perms; check Anthropic console billing |
| Daily cost spike | Retry loop or runaway prompt | Anthropic console enforces cap (calls 4xx after limit); manual fallback: `sudo systemctl stop hermes-gateway` and investigate `journalctl -u hermes-gateway` |
| Slash commands missing in Discord | Gateway never registered them; another follower gateway took registration | Re-run `hermes gateway setup`; if running multiple gateways against the same bot, set `gateway.platforms.discord.extra.slash_commands: false` on the follower |
| Hermes drops offline after droplet reboot | systemd unit not enabled, or `EnvironmentFile` path wrong | `systemctl is-enabled hermes-gateway` should return `enabled`; verify `~/.hermes/.env` exists; check `journalctl -u hermes-gateway -b` for the failed startup |
| Startup warnings: "Opus codec not found" and "websockets module" | Optional voice + browser tool subsystems not provisioned | Both benign for current scope. Voice intentionally OOS forever (no plan to use). Browser tools activated in Spec 2.1 (`pip install websockets`, Playwright + `hermes acp --setup-browser`) |
| Wizard can't install systemd unit ("requires sudo") | Interactive TUI can't escalate cleanly | Wizard prints the exact `sudo …` commands to run; copy-paste them with the full venv path |

---

## Spec 1 — VPS provisioning + Hermes Agent install

**Linked roadmap item:** Phase 1.5 → Infrastructure (first two checkboxes — provision VPS, install Hermes Agent with version pin)
**Author:** Isaac (drafted with Cowork, 2026-05-18; execution 2026-05-21 / 2026-05-26 / 2026-06-01)
**Status:** **shipped 2026-06-01.** Verification record lives in `/docs/verification.md` "Hermes infrastructure — Spec 1 (2026-06-01)". Decisions logged in `/docs/decisions.md` (2026-06-01 entries: DigitalOcean as VPS provider; Pin Hermes Agent to v0.14.0).
**Time spent:** Original estimate 1-1.5 hours; actual ~4 hours across three sessions. Drivers of the overrun captured in the decisions entries and in `verification.md`'s SSH lockout debugging playbook.

### Goal
Stand up the VPS where Hermes will live, install the Hermes Agent framework on it, verify the install. End state: an SSH-able DigitalOcean droplet running an idle Hermes Agent process, ready for model routing + Discord gateway configuration in Spec 2.

### Acceptance criteria
- DigitalOcean droplet exists: **1GB RAM / 1 vCPU, Ubuntu 24.04 LTS, NYC region** (closest DigitalOcean region to Supabase's `us-east-1`), name `hermes-prod`.
- Weekly backup snapshots enabled at provisioning (~$1.60/mo additional). Cost added to `/docs/operations.md` §1 cost model once the first DigitalOcean invoice confirms the actual charge.
- SSH key auth set up — new key generated for this droplet (`~/.ssh/id_ed25519` or similar; Isaac has no existing key per 2026-05-18 check).
- UFW firewall enabled on the droplet with port 22 (SSH) open only.
- Root SSH login disabled; non-root `hermes` user owns the install and has sudo access.
- Root password set (saved in password manager) so DigitalOcean's web console retains a fallback auth path after `PermitRootLogin no`. *Added during session 2 after a misdiagnosed lockout — see verification.md "SSH lockout debugging playbook" for the full story.*
- Hermes Agent v0.14.0 (git tag `v2026.5.16`) installed at `/home/hermes/.hermes/venv/` via pip into a Python 3.12 virtualenv. Venv auto-activates on SSH login via `~/.bashrc`.
- `hermes --version` returns `Hermes Agent v0.14.0 (2026.5.16)`.
- Droplet IP address (`167.71.161.145`) documented in Isaac's password manager alongside SSH key passphrase, hermes user password, and root password.
- `decisions.md` entries drafted by Cowork capturing: provider (DigitalOcean) and version pin (v0.14.0). Both appended 2026-06-01 with Isaac's per-entry approval.

### Out of scope (these are later specs)
- Model routing configuration (Sonnet default / Opus escalation) → **Spec 2**
- Discord gateway setup → **Spec 2**
- Hermes credentials for GitHub / Supabase / Vercel → **Spec 3**
- `translation_events` and `agent_events` tables → **Spec 4**
- Any actual Hermes work against the codebase → **Spec 5**

### Open questions (answers below; carried in from session 2026-05-18)
1. ~~Supabase prod region?~~ **`us-east-1`.** Provision the droplet in DigitalOcean's NYC region (closest match) — NYC3 if available (newest hardware), otherwise NYC1/NYC2.
2. ~~SSH key already on Isaac's Mac?~~ **No.** Generate a fresh one during execution: `ssh-keygen -t ed25519 -C "isaac-hermes-2026-05-18"`. Save passphrase in password manager.
3. ~~Backup strategy?~~ **Yes, enable backups at provisioning.** ~$1.20/mo for weekly snapshots. Justified given Hermes will accumulate skill library state we'd rather not lose. Update `operations.md` §1 cost model once first invoice confirms the line item.

### Technical sketch (as executed across sessions 2026-05-21 / 2026-05-26 / 2026-06-01)
1. **DigitalOcean account setup** (~10 min). Sign up, add payment, create a project called "Translation App."
2. **Generate SSH key on Isaac's Mac** (~5 min). `ssh-keygen -t ed25519` with a passphrase. Save key + passphrase in password manager. Add public key to DigitalOcean account.
3. **Create droplet** (~10 min). Basic / Premium Intel, $8/mo (1GB RAM / 1 vCPU / 35 GB SSD), Ubuntu 24.04 LTS, NYC3 region, name `hermes-prod`, attach the SSH key, enable backups (~$1.60/mo, weekly).
4. **Initial server hardening** (~20 min). SSH in as root → create non-root `hermes` user with sudo → copy SSH key to hermes user → enable UFW with port 22 open → run `apt update && apt upgrade -y`.
5. **Set root password before locking root SSH** (~3 min). `sudo passwd root`, save to password manager. Required so DigitalOcean's web console (older Recovery Console, VNC-based) retains a fallback auth path after `PermitRootLogin no`. The newer Droplet Console (one-click, hypervisor-level) doesn't require this, but the fallback is belt-and-suspenders. *Added after the session-1 lockout misdiagnosis; see decisions.md 2026-06-01 entries and verification.md.*
6. **Disable root SSH** (~5 min). Set `PermitRootLogin no` in `/etc/ssh/sshd_config`, verify effective config with `sudo sshd -T | grep -i permitrootlogin`. Verify from a separate terminal that `ssh root@…` fails and `ssh hermes@…` still succeeds.
7. **Install dependencies** (~10 min). Python 3.12 (Noble default), pip, venv, build-essential, git, curl, ca-certificates, pkg-config. Plus Chromium runtime libs for future Playwright use (libnss3, libnspr4, libatk*-t64, libcups2t64, libgbm1, libxshmfence1, etc. — Noble uses `t64` variants). Chromium itself stays managed by Playwright inside the venv when Hermes browser tools are activated later.
8. **Install Hermes Agent v0.14.0** (~10 min). As hermes user: `python3 -m venv ~/.hermes/venv && source ~/.hermes/venv/bin/activate && pip install --upgrade pip && pip install hermes-agent==0.14.0`. Append `source ~/.hermes/venv/bin/activate` to `~/.bashrc` so the venv auto-activates on SSH login.
9. **Verify** (~5 min). `hermes --version` returns `Hermes Agent v0.14.0 (2026.5.16)`. SSH out and back in; confirm `(venv)` shows in prompt automatically. Walk the verification checklist in `/docs/verification.md` "Hermes infrastructure — Spec 1 (2026-06-01)".
10. **Document and decide** (~30 min). Draft the two `decisions.md` entries (DO provider; version pin) for Isaac's per-entry approval, draft the `verification.md` "Hermes infrastructure" section, update `roadmap.md` Phase 1.5 checkboxes, update `hermes.md` version references, mark this spec shipped. One commit covers all of it.

### Verification plan
Verification ran end-to-end 2026-06-01 against the droplet at `167.71.161.145`. Full checklist (including post-ship failure-mode table and SSH lockout debugging playbook) lives in `/docs/verification.md` "Hermes infrastructure — Spec 1 (2026-06-01)" — re-run after any infra change. Acceptance criteria above all met at ship time.

### Lessons baked into other docs (rather than living here)
- **SSH lockout debugging playbook + operational safeguards** (set root password before locking root SSH; `ssh -v` first when diagnosing) → `/docs/verification.md` "Hermes infrastructure" section.
- **Provider choice rationale + version pin rationale** → `/docs/decisions.md` 2026-06-01 entries.
- **Verify spec-stated facts before provisioning** (the meta-lesson from why we needed a v0.2.0→v0.14.0 correction at all) → Cowork auto-memory `feedback_verify_speculative_claims_early`.

### Out-of-date "Resume notes" — removed 2026-06-01
The earlier Resume notes section (session 1, 2026-05-21) was built on a misdiagnosed lockout. Session 2 (2026-05-26) established that the lockout was a passphrase-prompt fumble on Isaac's local SSH client, not a server-side auth break. The diagnostic steps and "fix the hermes auth issue" path the resume notes prescribed were therefore moot. Removed to avoid future readers following a broken trail. The misdiagnosis is preserved in `/docs/verification.md` as a teaching example in the SSH lockout debugging playbook.

---

*(Future specs will be added below as drafted. Newest at top within a section; section order: draft → approved → in-flight → shipped.)*

---

## Changelog

*Reverse chronological. One line per change; project events link to `decisions.md`.*

- **2026-07-16** — Added Spec 11 (add-to-conversation: search-to-add + "X was added" system message + migration 023 `messages.kind`+`payload`/`add_conversation_member`/direct→group) + Spec 12 (group-chat sender attribution, avatar+name Option B, 12-color hash + within-conversation de-collision) for new roadmap Phase 2.5; both from 3-user testing, **approved 2026-07-16, Cowork-built** (migration 023 Isaac-run on staging). Open questions resolved: system-message storage → `messages` column, add policy → open direct-add, color keying → `account_id`. (→ roadmap.md Phase 2.5)
- **2026-07-07** — Added Spec 8 (onboarding language list: ~40 native-name languages) + Spec 9 (core-controls symbology via lucide-react) for roadmap Phase 2.4; both Cursor/Sonnet-executed. (→ roadmap.md Phase 2.4)
- **2026-07-07** — Docs legibility cleanup: header de-blobbed; added this Changelog + a "mostly historical" banner. (→ decisions.md 2026-07-07 "Docs legibility cleanup + new conventions")
- **2026-06-18** — Specs 6 & 7 marked shipped to prod (Phase 3 cutover, migrations 017/018). (→ decisions.md 2026-06-18)
- **2026-06-12** — Migration renumber: Phase 3 specs shifted to 017/018 after the FK-cascade fix took 016; Spec 6 drafted (Cowork-executed); Spec 7 drafted. (→ decisions.md 2026-06-12)
