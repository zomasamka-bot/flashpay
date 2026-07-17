/**
 * SECURITY: Configuration split into public and server modules
 * 
 * This file provides safe re-exports only.
 * - publicConfig: Safe for client code ("use client" modules)
 * - serverConfig: Server-only, MUST NEVER be imported from client
 * 
 * If you need server secrets, import from lib/server-config.ts in a server-only context.
 * If you only need appUrl/ownerUid, import from lib/public-config.ts (safe everywhere).
 */

// Safe for client: only NEXT_PUBLIC values
export { publicConfig } from "./public-config"

// Server-only: contains PI_API_KEY, A2U_INTERNAL_SECRET, Redis, Database credentials
// NEVER import this into files with "use client"
export { serverConfig } from "./server-config"

// Deprecated: config object is split for security
// Use publicConfig for NEXT_PUBLIC values
// Use serverConfig for server secrets (server-only context)
export const config = {
  // Re-export from publicConfig for backward compatibility (appUrl, ownerUid safe)
  appUrl: process.env.NEXT_PUBLIC_APP_URL || "https://flashpay-two.vercel.app",
  ownerUid: process.env.NEXT_PUBLIC_OWNER_UID || "",
} as const
