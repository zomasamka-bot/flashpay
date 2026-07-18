"use server"

/**
 * Server-only configuration
 * MUST NEVER be imported from client code ("use client" modules)
 * 
 * Contains all secrets: PI_API_KEY, A2U_INTERNAL_SECRET, Redis credentials, DATABASE_URL
 * If this file is bundled into the client, the app is INSECURE.
 * 
 * CRITICAL: Must be imported DIRECTLY from lib/server-config.ts in server-only contexts.
 * NEVER import from lib/config.ts to prevent accidental client bundling.
 */

// Fail-closed: throw if server secrets are missing in production
function requireSecret(name: string, value: string | undefined): string {
  if (!value) {
    console.error(`[FATAL] Required secret not configured: ${name}`)
    if (process.env.NODE_ENV === "production") {
      throw new Error(`Fatal: Missing required secret ${name}`)
    }
    // Development: return empty string to allow local testing
    return ""
  }
  return value
}

export const serverConfig = {
  // Pi Network API key — used by approve and complete webhook endpoints
  piApiKey: requireSecret("PI_API_KEY", process.env.PI_API_KEY),

  // A2U Internal Secret — server-only, used to secure internal A2U calls
  // Must be set in environment; no fallback - fail closed if missing
  a2uInternalSecret: requireSecret("A2U_INTERNAL_SECRET", process.env.A2U_INTERNAL_SECRET),

  // Upstash Redis
  redisUrl: process.env.UPSTASH_REDIS_REST_URL || "",
  redisToken: process.env.UPSTASH_REDIS_REST_TOKEN || "",

  // PostgreSQL (Neon) — for transaction history and receipts
  databaseUrl: process.env.DATABASE_URL || "",

  // Derived flags
  get isRedisConfigured(): boolean {
    return !!(this.redisUrl && this.redisToken)
  },

  get isPiApiKeyConfigured(): boolean {
    return !!this.piApiKey
  },

  get isPostgresConfigured(): boolean {
    return !!this.databaseUrl
  },

  get isA2uSecretConfigured(): boolean {
    return !!this.a2uInternalSecret
  },
} as const
