// ============================================================================
// auth.js — request authentication for the translation engine API.
// ============================================================================
// Single chokepoint that turns an incoming HTTP request into a verified
// principal { userId }, or rejects it. Used by every backend handler
// (api/v1/translate.js, api/v1/infer-profile.js, and their server/index.js
// mirrors).
//
// WHY A HELPER (not an inline check per handler): per the project's "build the
// B2B seam now" rule, this is the one place an external customer's API-key auth
// path slots in later (additive) without touching the handlers. Today it only
// knows Supabase end-user JWTs (the chat app is the first-party client of its
// own API).
//
// VERIFICATION METHOD: uses supabase.auth.getClaims(), which verifies the JWT
// LOCALLY against the project's JWKS when asymmetric signing keys are enabled
// (no per-call network hop — the scale-correct path for the future B2B engine),
// and falls back to a network verification on the legacy symmetric secret. The
// call site is identical either way, so flipping on asymmetric keys is a config
// change with zero code change. Tradeoff: local verification doesn't instantly
// notice a just-revoked token — it stays valid until expiry (~1h default);
// bounded by keeping the access-token lifetime short.
//
// CREDENTIALS: deliberately uses the ANON key (VITE_SUPABASE_URL +
// VITE_SUPABASE_ANON_KEY), NOT the service-role key. getClaims() only needs the
// project URL (the JWKS endpoint is public) + any apikey, so the least-privilege
// anon key is sufficient. This keeps the full-access service-role key off the
// API hot path, consistent with the scoped-role / not-BYPASSRLS posture in
// decisions.md 2026-06-11 ("profile_writer role"). It also means no new Vercel
// secret — these two vars are already present in Preview and Production.
//
// TENANT: not resolved here. We return only the verified userId; the sole-tenant
// constant is correct today, so handlers stamp tenant_id from their existing
// constant. The multi-tenant-correct path is to carry tenant_id as a JWT claim
// (via a Supabase access-token auth hook) — no lookup, no privileged key — added
// when multi-tenant lands. (decisions.md 2026-06-23 "Token auth on backend API
// calls".)
// ============================================================================

import { createClient } from '@supabase/supabase-js';

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

// Lazy singleton. Created with the anon key + project URL. getClaims() verifies
// the *user's* token regardless of which key the client carries; the anon key is
// just the apikey header. No row access happens here, so no privileged key is
// needed. Note: VITE_-prefixed vars are exposed to the client bundle by Vite,
// but server-side (Vercel functions / local Express) they're plain process.env
// values — safe to read here, and the anon key is non-secret by design.
let _client = null;
function getClient() {
  if (_client) return _client;
  const url = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    // Misconfiguration, not a client auth failure → surfaces as 500.
    throw new AuthError(
      'Auth not configured (missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)',
      500,
    );
  }
  _client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

function extractBearer(req) {
  const header = req.headers?.authorization || req.headers?.Authorization;
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Verify the request's bearer token and resolve the principal.
 * @returns {Promise<{ userId: string }>}
 * @throws {AuthError} 401 missing/invalid token; 500 misconfigured.
 */
export async function authenticateRequest(req) {
  const token = extractBearer(req);
  if (!token) {
    throw new AuthError('Missing or malformed Authorization header');
  }

  const client = getClient();

  const { data, error } = await client.auth.getClaims(token);
  if (error || !data?.claims?.sub) {
    throw new AuthError('Invalid or expired token');
  }

  return { userId: data.claims.sub };
}

/**
 * Handler convenience (Express + Vercel share the (req, res) shape): run auth,
 * and on failure write the right status + JSON and return null. On success
 * returns the principal.
 *
 *   const principal = await requireAuth(req, res);
 *   if (!principal) return; // response already sent
 */
export async function requireAuth(req, res) {
  try {
    return await authenticateRequest(req);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return null;
    }
    console.error('[auth] unexpected error:', err);
    res.status(500).json({ error: 'Auth check failed' });
    return null;
  }
}
