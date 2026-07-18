/**
 * SECURITY: Configuration split into public and server modules
 * 
 * This file provides ONLY safe re-exports for client code.
 * 
 * CLIENT CODE ("use client"):
 *   - Use: publicConfig or config (contains only NEXT_PUBLIC values)
 *   - Location: lib/config.ts or lib/public-config.ts
 * 
 * SERVER CODE (Route Handlers, Server Actions, etc):
 *   - Use: import { serverConfig } from "./server-config"
 *   - NEVER import from lib/config.ts in server code
 *   - serverConfig contains secrets: PI_API_KEY, A2U_INTERNAL_SECRET, Redis, Database credentials
 * 
 * ⚠️  CRITICAL: serverConfig is INTENTIONALLY NOT re-exported from this file to prevent
 *    accidental bundling into client code. Server files must import directly from server-config.ts.
 */

// Safe for client: only NEXT_PUBLIC values
export { publicConfig } from "./public-config"

// Deprecated: config object is split for security
// Use publicConfig for NEXT_PUBLIC values (safe everywhere)
// Use serverConfig only in server-only context (direct import from lib/server-config.ts)
export const config = {
  // Re-export from publicConfig for backward compatibility (appUrl, ownerUid safe)
  appUrl: process.env.NEXT_PUBLIC_APP_URL || "https://flashpay-two.vercel.app",
  ownerUid: process.env.NEXT_PUBLIC_OWNER_UID || "",
} as const
