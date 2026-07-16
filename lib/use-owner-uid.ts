/**
 * ============================================================================
 * OWNER UID HOOK (ISOLATED)
 * ============================================================================
 *
 * React hook for managing owner UID operations.
 * Completely independent from payment system.
 *
 * ISOLATION GUARANTEE:
 * - No dependency on usePayments hook
 * - No dependency on payment store
 * - Own state management
 * - Own API endpoints
 */

import { useEffect, useState, useCallback } from "react"
import { ownerUidStore, type OwnerUidData } from "@/lib/owner-uid-store"

export function useOwnerUid() {
  const [uidData, setUidData] = useState<OwnerUidData>(() => ownerUidStore.getUid())

  // Subscribe to store changes on mount
  useEffect(() => {
    const unsubscribe = ownerUidStore.subscribe(() => {
      setUidData(ownerUidStore.getUid())
    })

    return () => {
      unsubscribe()
    }
  }, [])

  /**
   * Verify UID with backend
   * This is a NON-BLOCKING operation for owner operations only
   */
  const verifyUid = useCallback(async (uid: string, accessToken: string, username?: string) => {
    ownerUidStore.setPending()
    setUidData(ownerUidStore.getUid())

    try {
      const response = await fetch("/api/owner/verify-uid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid, accessToken }),
      })

      if (!response.ok) {
        let errorMessage = response.statusText
        try {
          const errorData = await response.json()
          errorMessage = errorData.error || response.statusText
        } catch {
          // If JSON parsing fails, use statusText
        }
        throw new Error(errorMessage)
      }

      const result = await response.json()

      if (result.success) {
        // Store will notify subscribers automatically
        ownerUidStore.setUid(uid, accessToken, result.walletAddress, username)
        return { success: true }
      } else {
        throw new Error(result.error || "Verification failed")
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error"
      ownerUidStore.setError(errorMsg)
      return { success: false, error: errorMsg }
    }
  }, [])

  /**
   * Clear stored UID
   */
  const clearUid = useCallback(() => {
    // Store will notify subscribers automatically
    ownerUidStore.clear()
  }, [])

  return {
    uidData,
    verifyUid,
    clearUid,
    isReady: uidData.uid !== null && uidData.status === "success",
    isPending: uidData.status === "pending",
    error: uidData.error,
  }
}
