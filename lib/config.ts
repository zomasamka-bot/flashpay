/**
 * Centralized environment configuration.
 * All environment variable access across the application must go through this file.
 * Do NOT read process.env directly outside of this file.
 */

export const config = {
  // App URL — always points to Vercel backend, never window.location.origin
  // This is critical: when the app is opened via flashpay0734.pinet.com,
  // window.location.origin is that PiNet domain, but all APIs live on Vercel.
  appUrl: process.env.NEXT_PUBLIC_APP_URL || "https://flashpay-two.vercel.app",

  // Pi Network API key — used by approve and complete webhook endpoints
  piApiKey: process.env.PI_API_KEY || "",

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
} as const
