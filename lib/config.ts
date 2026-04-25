/**
 * Centralized environment configuration.
 * All environment variable access across the application must go through this file.
 * Do NOT read process.env directly outside of this file.
 */

export const config = {
  // App URL — always points to Vercel backend, never window.location.origin
  // This is critical: when the app is opened via flashpay0734.pi,
  // window.location.origin is that PiNet domain, but all APIs live on Vercel.
  appUrl: process.env.NEXT_PUBLIC_APP_URL || "https://flashpay-two.vercel.app",

  // Pi Network Subdomain Configuration
  // IMPORTANT: This must match the subdomain registered in the Pi Developer Portal
  // For flashpay, the registered subdomain is: flashpay0734.pi
  piNetSubdomain: process.env.NEXT_PUBLIC_PI_NET_SUBDOMAIN || "flashpay0734.pi",

  // Pi Network Configuration
  piApiKey: process.env.PI_API_KEY || "",
  piApiBaseUrl: "https://api.minepi.com", // Pi Testnet and Mainnet use same API
  piEnvironment: (process.env.PI_ENVIRONMENT || "testnet") as "testnet" | "mainnet",
  
  // Pi Testnet Configuration (used for wallet operations)
  piTestnetWalletAddress: process.env.PI_TESTNET_WALLET_ADDRESS || "",
  piTestnetPrivateKey: process.env.PI_TESTNET_PRIVATE_KEY || "", // For signing transfers if needed
  
  // Upstash Redis
  redisUrl: process.env.UPSTASH_REDIS_REST_URL || "",
  redisToken: process.env.UPSTASH_REDIS_REST_TOKEN || "",

  // PostgreSQL (Neon) — for transaction history and receipts
  databaseUrl: process.env.DATABASE_URL || "",

  // Email Configuration (for future email notifications)
  emailProvider: process.env.EMAIL_PROVIDER || "sendgrid", // sendgrid, resend, mailgun, etc
  emailApiKey: process.env.EMAIL_API_KEY || "",
  emailFromAddress: process.env.EMAIL_FROM_ADDRESS || "noreply@flashpay.pi",

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

  get isPiTestnetConfigured(): boolean {
    return !!this.piTestnetWalletAddress
  },

  get isEmailConfigured(): boolean {
    return !!this.emailApiKey && !!this.emailFromAddress
  },

  // Get Pi API endpoint based on environment
  getPiApiUrl(path: string): string {
    return `${this.piApiBaseUrl}/v2${path}`
  },
} as const
