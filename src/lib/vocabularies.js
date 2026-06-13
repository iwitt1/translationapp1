// ============================================================================
// vocabularies.js — single client-side source of truth for enumerated option
// sets surfaced in the UI (register / context_type, languages).
// ============================================================================
// WHY THIS FILE EXISTS
//   These lists used to be duplicated inline in App.jsx (CONTEXT_TYPES, LANGUAGES)
//   and had to be kept in sync by hand with the server prompt and the DB. Centralising
//   them here gives the *frontend* one edit point. Adding or renaming a register is now:
//     1. edit CONTEXT_TYPES here
//     2. edit the matching modifier in lib/translatePrompt.js (engine behavior)
//     3. ship a migration to move the DB CHECK (see migration 019)
//
//   IMPORTANT — this is the app-layer source of truth, NOT a global one. A JS module
//   cannot back a Postgres CHECK constraint, so the DB still validates independently.
//   The fully data-driven, tenant-scoped version (one source for app + DB, per-tenant
//   option sets) is the deferred "Tenant-scoped option registry" initiative in
//   parking-lot.md. The accessors below are intentionally function-shaped so that
//   future work can swap the static arrays for a tenant-aware fetch without touching
//   call sites.
//
//   The context_type values here MUST stay aligned with:
//     - lib/translatePrompt.js  CONTEXT_TYPE_MODIFIERS  (the behavior each value drives)
//     - the conversations_context_type_check DB constraint (migration 019)
// ============================================================================

// ── Register / context_type ────────────────────────────────────────────────
// `value`  — wire value sent to the engine and stored on conversations.context_type
// `label`  — UI display
// `help`   — one-liner shown by the "?" affordance on the register selector
export const CONTEXT_TYPES = [
  {
    value: 'casual',
    label: 'Casual',
    help: 'Informal, relaxed tone — like talking with friends.',
  },
  {
    value: 'dating',
    label: 'Dating',
    help: 'Warmer and more romantic — preserves flirtation and terms of endearment.',
  },
  {
    value: 'professional',
    label: 'Professional',
    help: 'Formal, workplace-appropriate tone.',
  },
  {
    value: 'academic',
    label: 'Academic',
    help: 'Most formal — precision and formal register over naturalness.',
  },
];

// Default register when none is set (matches the DB column default and the engine fallback).
export const DEFAULT_CONTEXT_TYPE = 'casual';

// ── Languages ──────────────────────────────────────────────────────────────
// Languages a user can pick as their preferred language at onboarding.
export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'ru', label: 'Russian' },
  { code: 'zh', label: 'Chinese' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ar', label: 'Arabic' },
];

// ── Accessors (function-shaped on purpose — see header) ─────────────────────
// `tenantId` is accepted but unused today; it reserves the call-site shape for the
// future tenant-scoped registry so adopting it won't churn every consumer.
export function getContextTypes(/* tenantId */) {
  return CONTEXT_TYPES;
}

export function getLanguages(/* tenantId */) {
  return LANGUAGES;
}

// Lookups by value/code — return undefined for unknown inputs (callers decide fallback).
export function contextTypeLabel(value) {
  return CONTEXT_TYPES.find((c) => c.value === value)?.label;
}

export function contextTypeHelp(value) {
  return CONTEXT_TYPES.find((c) => c.value === value)?.help;
}

export function languageLabel(code) {
  return LANGUAGES.find((l) => l.code === code)?.label;
}
