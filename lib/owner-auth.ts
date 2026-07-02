/**
 * Owner-based Role Access Control (RBAC)
 * Determines if the authenticated user is the app owner
 * Required for accessing the Operations Console
 */

import { config } from "./config"

/**
 * Get the configured owner UID
 * This is the only user who can access the Operations Console
 * Reads from config.ownerUid which loads NEXT_PUBLIC_OWNER_UID from environment
 */
export function getOwnerUid(): string {
  return config.ownerUid
}

/**
 * Check if a given UID belongs to the owner
 * @param uid - The user's Pi UID to verify
 * @returns true if the UID is the owner's UID
 */
export function isOwnerUid(uid: string | undefined): boolean {
  if (!uid) return false
  
  const ownerUid = getOwnerUid()
  if (!ownerUid) {
    if (typeof window !== "undefined") {
      console.warn("[v0][owner-auth] No owner UID configured. Operations Console will be inaccessible.")
    }
    return false
  }
  
  const isOwner = uid === ownerUid
  if (typeof window !== "undefined") {
    console.log("[v0][owner-auth] UID verification:", {
      providedUid: uid?.substring(0, 12) + "...",
      configuredOwnerUid: ownerUid?.substring(0, 12) + "...",
      isOwner,
    })
  }
  
  return isOwner
}

/**
 * React hook to check if current user is owner
 * Use this in client components to conditionally render operations features
 */
export function useIsOwner(currentUid: string | undefined): boolean {
  return isOwnerUid(currentUid)
}

/**
 * Backend verification for API routes
 * Call this in server actions and route handlers to verify owner access
 * @param uid - The user's Pi UID
 * @param routeName - The route being accessed (for logging)
 * @returns true if authorized, false otherwise
 */
export function verifyOwnerBackend(uid: string | undefined, routeName?: string): boolean {
  if (!isOwnerUid(uid)) {
    if (routeName) {
      console.warn(`[owner-auth] Unauthorized access to ${routeName} by UID: ${uid?.substring(0, 8)}...`)
    }
    return false
  }
  
  if (routeName) {
    console.log(`[owner-auth] Owner accessed ${routeName}`)
  }
  
  return true
}

/**
 * Format error response for unauthorized access
 */
export function unauthorizedResponse() {
  return {
    status: 403,
    error: "Unauthorized: Operations console is available to owner only.",
  }
}
