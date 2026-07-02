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
  const [uidData, setUidData] = useState<OwnerUidData>({
    uid: null,
    accessToken: null,
    walletAddress: null,
    lastUpdated: null,
    status: "idle",
    error: null,
  })

  // Load from store on mount
  useEffect(() => {
    const data = ownerUidStore.getUid()
    setUidData(data)
  }, [])

  /**
   * Verify UID with backend
   * This is a NON-BLOCKING operation for owner operations only
   */
  const verifyUid = useCallback(async (uid: string, accessToken: string) => {
    ownerUidStore.setPending()
    setUidData(ownerUidStore.getUid())

    try {
      const response = await fetch("/api/owner/verify-uid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid, accessToken }),
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`Verification failed: ${response.statusText}`)
      }

      const result = await response.json()

      if (result.success) {
        ownerUidStore.setUid(uid, accessToken, result.walletAddress)
        setUidData(ownerUidStore.getUid())
        return { success: true }
      } else {
        throw new Error(result.error || "Verification failed")
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error"
      ownerUidStore.setError(errorMsg)
      setUidData(ownerUidStore.getUid())
      return { success: false, error: errorMsg }
    }
  }, [])

  /**
   * Clear stored UID
   */
  const clearUid = useCallback(() => {
    ownerUidStore.clear()
    setUidData(ownerUidStore.getUid())
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
