# Mobile / PWA — Considerations for a Potential Next Step

> **Status:** Parked design reference — *not* an active roadmap phase. This is the standing
> scoping doc for taking jistchat to mobile. It's referenced from `parking-lot.md`
> ("PWA implementation", Med). If we decide to act, the natural homes are `roadmap.md`
> Phase 5 (native mobile, already parked) and the parking-lot entry (PWA-first) — with a
> `decisions.md` entry for the magic-link-vs-OTP call before any build starts.
>
> **Current standing (2026-07-18):** Phase 4 (corrections capture) goes first. PWA is deferred
> — it's an *engagement / usability* upgrade, not a product feature, so it earns its slot only
> when there's a felt need for it (see §0). See decisions.md 2026-07-18.

---

## 0. Current standing & this session's additions (2026-07-18)

**Decision made this session:** build **Phase 4 as it exists today first**, then pick up PWA
"if the need is there." Rationale: PWA is about *how you reach and re-engage* users
(installability, push, passive engagement), not a new capability of the product. Corrections
capture is the strategic core — the data flywheel behind the Phase 2 API — so it takes priority.
Crucially, deferring PWA costs us almost nothing in rework (see the collision note below), so
there's no double-build penalty for doing Phase 4 first. **Revisit when** engagement/retention
(people not coming back without a nudge) or a demo need makes home-screen-plus-push worth the
~2 days.

Three analytical points this session added to the existing write-up below:

**a) "PWA" is two separable layers — and only one of them ever collides with feature work.**
- *Packaging / installability* — manifest + service worker + install-to-home-screen + icons.
  This wraps *around* the app; it touches app-shell files, not product surfaces.
- *Mobile-UX redesign* — touch targets, gestures, small-screen relayout of the message bubbles.
  This is the expensive half, and it's the only half that would collide with Phase 4's per-bubble
  correction affordances (thumbs / inline edit live in `MessageBubble` + `ConversationView`).

  The engagement-driven PWA Isaac wants is almost entirely the *packaging* layer (plus push),
  which barely touches Phase 4's files. So "reduce double-building" between Phase 4 and this PWA
  is largely a non-issue — they live in different layers. (The real fork-the-codebase double-build
  risk is React Native / Phase 5, which §4 already covers.)

**b) The one real double-build to design around is push infra, not UI — decide the push vendor up front.**
Push is deferred for a demo (§8), but when it *is* built, the choice of push mechanism is where
web-now-vs-native-later either duplicates work or doesn't:
- **Raw Web Push (VAPID keys, self-owned):** free, no dependency, but web-only — rebuilt for native.
- **OneSignal / cross-platform vendor:** one integration spans web + native; fastest to working
  push; third-party dependency + cost at scale.
- **Expo push:** only sensible if Phase 5 commits to Expo/React Native — then web + native unify.

  Decide this deliberately (and log it) rather than defaulting into VAPID because it's free; the
  vendor choice is the lever that keeps the push pipeline from being built twice.

**c) iOS reality checks (set expectations, none are blockers):**
- On iPhone, push and standalone launch require the user to manually tap Share → "Add to Home
  Screen" — iOS Safari gives no auto-install prompt. So on iOS the *adoption of the install step*
  is the bottleneck, not the tech (95%+ of iPhones are on iOS 16.4+, which supports web push).
- **EU / DMA gotcha:** Apple has at times forced iOS PWAs in the EU to open in a plain Safari tab
  with no push. Check this if we have EU users before leaning on PWA push there.
- **Auth ceiling:** sign-in is magic-link only (no password/biometric), so even installed, a session
  eventually expires into a "log in again" moment. §7's OTP-code path removes the *standalone-launch*
  break but not the eventual re-auth. Don't oversell the frictionlessness.

*(Everything from §1 down is the prior session's write-up, still accurate and unchanged except the
push-vendor note folded into §8 and the recommendation in §11.)*

---

## 1. The framing

The question was: what would it take to port the web chat app to mobile (iPhone first), what's the
scope/cost/time/complexity/tradeoffs, when is the best time relative to the roadmap, and would a
"shortcut" mobile app (like Sniffies) work instead of a full native build.

Short answer: a shortcut app works and is the right first move. The key realization is that there
isn't a binary "web vs. native" choice — there's a **ladder of three options**, and two of the three
reuse the existing React codebase while only the third duplicates it.

Relevant stack facts (confirmed against the repo, current as of this write-up):

- Frontend is a plain **Vite 5 + React 18 SPA** (`src/App.jsx` orchestrator + components in
  `src/components/`, data layer in `src/lib/`). Tailwind 3. Builds to `dist/`, deployed on Vercel.
- Backend is **Supabase** (Postgres + Realtime + Auth) and **Vercel serverless functions**; AI is
  OpenAI. Auth is **magic-link / email OTP**.
- The Supabase client runs on defaults, so **persistent sessions are already on** (`persistSession` /
  `autoRefreshToken`) — verified during Phase 2.2.
- There is a `public/` dir with favicon + apple-touch-icon assets (added with the brand work), but
  **no manifest, full icon set, or service worker** yet. So PWA work is still purely additive —
  nothing to refactor. *(Update 2026-07-18: the `index.html` apple-touch-icon is explicitly seeded
  as "the future PWA icon set.")*

---

## 2. The three options (the ladder)

| | **PWA** (the "Sniffies" route) | **Capacitor wrapper** | **React Native / Expo** (roadmap Phase 5) |
|---|---|---|---|
| What it is | The web app, installable to the home screen, fullscreen, web push | The web app wrapped in a native shell, shipped to the App Store | A separate native codebase rebuilt in RN |
| Codebase | Same one, **zero fork** | Same one (runs in a native webview) | **Second codebase** to build + maintain forever |
| Time | Days | ~1–2 weeks + Apple review | Weeks to a couple months for parity |
| Cost | ~free | $99/yr Apple + review overhead | Real eng time, ongoing |
| App Store presence | No (home-screen only) | Yes | Yes |
| Push notifications | iOS 16.4+ web push, but only *after* "Add to Home Screen" | Real native push (APNs) | Real native push (APNs) |
| Native feel | Good-enough | Good-enough (still a webview) | Best |

---

## 3. On the "Sniffies" question specifically

Sniffies is a deliberate **PWA** — browser-based, no App Store app, on purpose: adult-content App
Store policy, avoiding Apple's 30% cut, no review friction, instant iteration. The mechanism is a web
app manifest + a service worker. Users tap Share → "Add to Home Screen" from Safari and it behaves
like an app: fullscreen, its own icon, an offline shell, and — since iOS 16.4 — push notifications.

For jistchat this is nearly free, because the app is *already* React and already responsive (mobile
layout was hardened across Phases 2.2 and 2.4). Turning it into a real PWA is a manifest, a service
worker, and testing — days, not a roadmap phase.

---

## 4. The insight that answers "when"

The reason the roadmap correctly puts native at **Phase 5 (last)** is the **codebase fork.** Every
frontend feature still to build — the Phase 4 corrections UI (thumbs up/down, inline edits) and
beyond — would have to be built *twice* if we go React Native now. A native rewrite before the web
feature set stabilizes means double-building everything.

The PWA and Capacitor routes don't have that problem — they reuse the same React code, so they keep
improving for free as the web app grows. That makes them essentially **timing-independent**.

So "when" splits cleanly by option:

- **PWA — now / opportunistic.** Cheap, reuses everything, serves both the demo and early adoption.
  No reason to gate it behind roadmap phases. *(2026-07-18: chosen order is still Phase 4 first,
  since PWA is engagement/usability not a feature and deferring it costs ~no rework.)*
- **Native RN — genuinely Phase 5.** Do it *after* Phase 4 corrections and after the product is
  actually differentiated. Per the trojan-horse strategy, the mobile client is a distribution
  vehicle, not the business — don't sink native-rewrite cost until there's something worth
  distributing.
- **Capacitor — the optional middle.** Only if App Store *presence* itself (discoverability,
  credibility) becomes the thing we need; it buys a store listing without the rewrite.

---

## 5. Adoption claim, examined

The intuition that "adoption is faster as a mobile app" is right for a chat app — home-screen presence
and push notifications drive retention. But a **PWA captures most of that** (home screen + web push)
at roughly 5% of the cost. What a store-listed native app adds on top is **discoverability and
credibility**, plus push that doesn't require the awkward "Add to Home Screen first" step. That — not
layout or performance — is the real reason to eventually climb past the PWA. For the current
**demo goal**, a home-screen PWA is already plenty.

---

## 6. What a demo-grade PWA actually involves

Grounded in the current repo. All additive.

**a) Manifest + icons (the installability core).** Add a web app manifest (name "jistchat",
`display: standalone`, `start_url: /`, theme/background colors) and app icons at 192px, 512px, a
maskable variant, and a 180px Apple touch icon. Source art is the logo in the landing-page folder
(`~/Documents/Claude/Projects/Translation App`); the generated icons + manifest land in the **repo**
(`~/Developer/translationapp`, in `public/`). Cleanest mechanism on Vite: add
**`vite-plugin-pwa`** (one devDependency, wires into the existing `vite.config.js`) instead of
hand-rolling a service worker — it generates the manifest injection + a Workbox app-shell service
worker.

**b) iOS-specific `<head>` tags in `index.html`.** iOS largely ignores the manifest for home-screen
behavior and uses its own meta tags: `apple-touch-icon`, `apple-mobile-web-app-capable`,
`apple-mobile-web-app-status-bar-style`, a `theme-color`, and crucially `viewport-fit=cover` on the
existing viewport tag so the app can draw into the notch area.

**c) Safe-area CSS polish.** In standalone mode (no browser chrome) the Phase 2.2 top app bar collides
with the notch and the message composer with the home indicator. Fix is `env(safe-area-inset-*)`
padding on the app bar and composer — touches `index.css`, the app bar in `App.jsx`, and
`ConversationView`. A few hours, but it's the difference between "real app" and "webpage."

**d) iOS "Add to Home Screen" hint.** iOS Safari gives no install button — the user must tap Share →
Add to Home Screen manually. For a demo, a small one-time instructional nudge for iOS Safari visitors
keeps interviewers from missing the install. Optional but recommended.

---

## 7. The one real gotcha: auth in standalone mode

This is the piece to decide **before** anything else.

Sign-in is currently magic-link. When someone launches the installed PWA from the home screen and then
taps the magic link in Mail, iOS opens it in **Safari** — a separate storage context from the
standalone app — so the session lands in the browser, not the installed app, and the PWA still looks
logged out. This is the classic iOS PWA auth break.

**Robust fix:** add a **6-digit OTP code path.** Supabase already sends the email; switch the template
to include the code, add a code-input field to the email auth view in `App.jsx`, and call `verifyOtp`
instead of relying on the link. The user types the code and never leaves the app. It's a small,
contained change — one auth view + one Supabase call + an email-template tweak — and it's the **only
real code change** in the whole effort; everything else is assets and config. *(2026-07-18: this fixes
the standalone-launch break, but note the separate magic-link-only re-auth ceiling in §0c.)*

---

## 8. What to skip for a demo

- **Push notifications.** The fiddly part (requires add-to-home-screen first, a permission prompt, a
  push service, and a backend to send). Not what sells a demo. Defer to Capacitor/native.
  - *2026-07-18 note:* push is exactly what an **engagement-driven** PWA is *for* (passive
    re-engagement without opening the app), so if the motivation is retention rather than demo,
    push moves from "skip" to "the whole point" — and the **push-vendor decision (§0b)** must be
    made up front so it isn't rebuilt for native later.
- **Offline support beyond the basic app-shell cache.** A chat app is online-only anyway.

---

## 9. Effort and how to run it

Realistically **~1.5–2 days** (demo-grade, push excluded):

- ~half a day: `vite-plugin-pwa` + manifest + icons + iOS meta tags
- a few hours: safe-area polish
- a few hours: OTP auth path
- device testing: install on a real iPhone, launch standalone, verify the auth round-trip and that
  Supabase Realtime still delivers (it will — it's just websockets); finish with a Lighthouse PWA
  audit.

Add push (if the goal is engagement, not just demo) and the estimate grows by the push-service
integration + a backend send path + the subscription table — scoped by the §0b vendor choice.

Almost all of this is **routine frontend implementation**, so per the Cowork/Cursor split it should go
to **Cursor/Sonnet as a spec** (§9.1 format, recorded in `specs.md`) rather than being built in Cowork.
The only parts that want judgment are the auth decision (§7, §10) and the push-vendor decision (§0b).

---

## 10. The decision to make first

**Magic-link vs. OTP-code for the standalone app.** Recommendation: **add the OTP-code path** — it's
what makes the installed app actually usable on iOS, and it's cheap. But it's a real auth-flow change,
so it should be surfaced as a `decisions.md` entry (with the magic-link-only alternative and its
standalone-login failure mode) if we proceed. *(If push is in scope, the §0b push-vendor call is the
second up-front decision.)*

---

## 11. Recommendation (summary)

Ship the **PWA** as the near-term mobile play *when the need arises* — it's the Sniffies move, it's
cheap, it reuses the codebase, and it's a strong demo/adoption unlock. **Order (decided 2026-07-18):
Phase 4 corrections first; PWA after, since it's engagement/usability rather than a feature and
deferring it carries essentially no rework.** Hold the **React Native** rewrite at Phase 5 as written,
after corrections. Treat **Capacitor** as a later decision, only if App Store presence specifically
becomes worth the $99/yr + review cycles. Decide the **auth approach** (OTP-code recommended) — and,
if push is in scope, the **push vendor** (§0b) — before scoping the build.

---

## Changelog

*Reverse chronological. One line per change; project events link to `decisions.md`.*

- **2026-07-18** — Reframed from a demo-only scoping artifact into the standing parked design
  reference; added §0 (this session's decision — Phase 4 before PWA — plus the layer-disaggregation,
  push-vendor fork, and iOS/EU/auth reality checks); folded the push-vendor note into §8/§9 and the
  deferral into §11. Now referenced from `parking-lot.md`. (→ decisions.md 2026-07-18)
- **(prior session)** — Original write-up: the three-option ladder, the Sniffies analysis, the
  demo-grade build breakdown, and the standalone-auth gotcha. (§1–§11)
