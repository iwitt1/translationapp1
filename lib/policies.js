/**
 * Translation App — Global Policy Defaults
 *
 * Machine source of truth for global enforcement values.
 * Human-readable policy rationale lives in /docs/policies.md.
 * Per-tenant overrides live in tenants.dm_initiation_policy (jsonb).
 *
 * Rule: keep this in sync with policies.md. Any material change here
 * requires a matching update to policies.md and a decisions.md entry.
 *
 * Created: 2026-06-09 (Phase 2 Step 0)
 */

// ---------------------------------------------------------------------------
// 1. Username policy
// ---------------------------------------------------------------------------

export const USERNAME = {
  /** Allowed characters. Stored and compared as lowercase canonical form. */
  CHARSET_REGEX: /^[a-z0-9_]+$/,

  /** Raw input is lowercased before validation and storage. */
  CANONICALIZE: (raw) => raw.toLowerCase().trim(),

  /** Inclusive bounds. Confirm at build if UX differs. */
  MIN_LENGTH: 3,
  MAX_LENGTH: 20,

  /**
   * Max username changes per period. The first change from a system-generated
   * handle to a user-chosen one is FREE and starts the clock from that point.
   */
  CHANGES_PER_PERIOD: 1,
  PERIOD_DAYS: 365,

  /**
   * Reserved words. Seeded as 'reserved'-status rows in account_identifiers
   * at migration time. Enforcement in the query layer reads from the DB rows,
   * not this list directly — but this is the canonical source for what gets seeded.
   *
   * Categories: role/system terms, product brand, profanity.
   * Profanity list is intentionally short here; extend at build with a proper list.
   */
  RESERVED_WORDS: [
    // Role / system terms
    'admin', 'root', 'support', 'help', 'official', 'mod', 'moderator',
    'staff', 'system', 'api', 'billing', 'security', 'service', 'bot',
    'operator', 'ops', 'devops', 'sysadmin', 'superuser', 'sudo',
    // Product / brand — update with actual brand name before launch
    'translationapp', 'transapp',
    // Profanity — extend before launch with a complete list
    // (placeholder entries only; do not ship these as-is)
    'fuck', 'shit', 'cunt', 'nigger', 'faggot',
  ],

  /** Username source values matching the profiles.username_source enum. */
  SOURCE: {
    SYSTEM_GENERATED: 'system_generated',
    USER_SET: 'user_set',
  },
};

// ---------------------------------------------------------------------------
// 2. Display name policy
// ---------------------------------------------------------------------------

export const DISPLAY_NAME = {
  /** Allowed characters: alphanumeric, space, hyphen, apostrophe. */
  CHARSET_REGEX: /^[a-zA-Z0-9 '-]+$/,

  /** Trimmed on save; no leading/trailing space. */
  SANITIZE: (raw) => raw.trim().replace(/\s+/g, ' '),

  /** Inclusive bounds. Confirm at build if UX differs. */
  MIN_LENGTH: 1,
  MAX_LENGTH: 50,
};

// ---------------------------------------------------------------------------
// 3. DM-initiation policy
// ---------------------------------------------------------------------------

/**
 * Global default DM-initiation policy.
 *
 * Resolution order (policies.md §3):
 *   1. Mutually-accepted contacts can always DM each other — no override can block this.
 *   2. Otherwise, check tenants.dm_initiation_policy for the initiator's via_identifier_type.
 *   3. If no tenant override, fall through to DEFAULTS here.
 *
 * Values per handle type:
 *   'allow'              — non-mutual DM permitted
 *   'allow_if_verified'  — permitted only if initiator is verified (is_verified = true);
 *                          inert until a verification feature exists
 *   'deny'               — not permitted unless mutually accepted
 */
export const DM_INITIATION = {
  DEFAULTS: {
    email:        'deny',
    username:     'deny',
    phone:        'deny',
    friend_code:  'deny',
    invite_link:  'deny',
  },

  /**
   * Resolve the effective policy for a given identifier type, merging the
   * tenant override (tenants.dm_initiation_policy jsonb) on top of DEFAULTS.
   *
   * @param {string} viaIdentifierType  — e.g. 'email', 'username'
   * @param {object} tenantOverride     — parsed jsonb from tenants row (may be {})
   * @returns {'allow'|'allow_if_verified'|'deny'}
   */
  resolve(viaIdentifierType, tenantOverride = {}) {
    return tenantOverride[viaIdentifierType] ?? this.DEFAULTS[viaIdentifierType] ?? 'deny';
  },

  /**
   * Evaluate whether initiation is permitted.
   * Always returns true for mutually-accepted contacts (caller must check before calling this).
   *
   * @param {string}  viaIdentifierType
   * @param {object}  tenantOverride
   * @param {boolean} initiatorIsVerified  — profiles.is_verified of the initiator
   * @returns {boolean}
   */
  isPermitted(viaIdentifierType, tenantOverride = {}, initiatorIsVerified = false) {
    const rule = this.resolve(viaIdentifierType, tenantOverride);
    if (rule === 'allow') return true;
    if (rule === 'allow_if_verified') return initiatorIsVerified;
    return false; // 'deny'
  },
};

// ---------------------------------------------------------------------------
// 4. Discovery policy
// ---------------------------------------------------------------------------

export const DISCOVERY = {
  /**
   * Whether email can be used for open search / autocomplete.
   * false = exact-match add only (must know the full address). No enumeration.
   */
  EMAIL_SEARCH_PERMITTED: false,

  /**
   * Whether username autocomplete is permitted (subject to the target's
   * account_settings.discoverable_by_username preference).
   */
  USERNAME_AUTOCOMPLETE_PERMITTED: true,

  /**
   * Handle minimization: a discovery query returns only the handle used to find
   * a user — never their other identifiers. Enforced in the query/API layer,
   * not just the UI. This flag is a documentation anchor; enforcement is in code.
   */
  HANDLE_MINIMIZATION: true,
};

// ---------------------------------------------------------------------------
// 5. Account lifecycle policy
// ---------------------------------------------------------------------------

export const LIFECYCLE = {
  /**
   * Days before an incomplete (pending) account is deleted.
   * The system-generated username is released on deletion.
   */
  PENDING_DELETION_DAYS: 30,

  /**
   * Account status enum values (mirrors profiles.status DB enum).
   */
  STATUS: {
    PENDING:      'pending',
    ACTIVE:       'active',
    DEACTIVATED:  'deactivated',
  },

  /**
   * Email hash algorithm for the abuse-monitoring table.
   * Hash over plaintext chosen for GDPR cleanliness (no PII retained after deletion).
   * Confirm implementation uses a well-salted approach at build.
   */
  EMAIL_HASH_ALGORITHM: 'sha256',
};

// ---------------------------------------------------------------------------
// 6. Account identifier policy
// ---------------------------------------------------------------------------

export const IDENTIFIER = {
  /** Status values matching account_identifiers.status DB enum. */
  STATUS: {
    ACTIVE:   'active',
    RETIRED:  'retired',   // former handle; row kept to prevent reuse
    RESERVED: 'reserved',  // seeded reserved word; no holder
  },

  /** Type values matching account_identifiers.type DB enum. */
  TYPE: {
    EMAIL:       'email',
    USERNAME:    'username',
    PHONE:       'phone',
    FRIEND_CODE: 'friend_code',
  },
};
