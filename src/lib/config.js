// Project-wide non-secret constants referenced from the frontend.
// Single source of truth — change here, not at the call sites.

// The chat app's own tenant ID. Seeded in migration 001_tenants_and_tenant_id.sql.
// When the translation API opens to external tenants in Phase 2, this becomes
// one tenant among many; until then it's the only one.
export const CHAT_APP_TENANT_ID = "00000000-0000-0000-0000-000000000001";
