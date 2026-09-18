/**
 * ============================================================================
 * OWNER UID ISOLATED STORE
 * ============================================================================
 *
 * This is a COMPLETELY SEPARATE in-memory store for owner operations.
 * It does NOT interact with the payment system in any way.
 *
 * SECURITY / ISOLATION GUARANTEE:
 * - Owner Pi access tokens are session-memory-only and are never persisted to
 *   localStorage or other browser storage by this store.
 * - Any legacy "flashpay_owner_uid" localStorage record is removed on client
 *   initialization/clear so a token persisted by an older build is discarded.
 * - No imports from lib/operations.ts
 * - No imports from lib/use-payments.ts
 * - No imports from lib/payments-store.ts
 * - Independent initialization
 * - Independent error handling
 */

export interface OwnerUidData {
  uid: string | null
  accessToken: string | null
  walletAddress: string | null
  username: string | null
  lastUpdated: number | null
  status: "idle" | "pending" | "success" | "error"
  error: string | null
}

const LEGACY_OWNER_UID_STORAGE_KEY = "flashpay_owner_uid"

type StateListener = () => void

const createDefaultData = (): OwnerUidData => ({
  uid: null,
  accessToken: null,
  walletAddress: null,
  username: null,
  lastUpdated: null,
  status: "idle",
  error: null,
})

class OwnerUidStore {
  private data: OwnerUidData = createDefaultData()
  private listeners: Set<StateListener> = new Set()

  /**
   * Initialize client storage boundary.
   *
   * Owner credentials deliberately do not survive a reload. Remove the legacy
   * persisted record rather than hydrating it into memory.
   */
  initialize(): void {
    if (typeof window === "undefined") {
      console.log("[OwnerUID] Skipping initialization (server-side)")
      return
    }

    try {
      localStorage.removeItem(LEGACY_OWNER_UID_STORAGE_KEY)
      console.log("[OwnerUID] Owner credentials are memory-only; legacy storage cleared")
    } catch (err) {
      console.error("[OwnerUID] Failed to clear legacy localStorage:", err)
    }
  }

  /**
   * Set UID and related data in memory for the current page session only.
   */
  setUid(uid: string, accessToken?: string, walletAddress?: string, username?: string): void {
    this.data.uid = uid
    this.data.accessToken = accessToken || null
    this.data.walletAddress = walletAddress || null
    this.data.username = username || null
    this.data.lastUpdated = Date.now()
    this.data.status = "success"
    this.data.error = null
    this.notifyListeners()
  }

  /**
   * Get current UID data.
   */
  getUid(): OwnerUidData {
    return { ...this.data }
  }

  /**
   * Set pending status.
   */
  setPending(): void {
    this.data.status = "pending"
    this.data.error = null
    this.notifyListeners()
  }

  /**
   * Set error.
   */
  setError(error: string): void {
    this.data.status = "error"
    this.data.error = error
    this.notifyListeners()
    console.error("[OwnerUID] Error stored:", error)
  }

  /**
   * Clear all in-memory data and remove any legacy persisted owner record.
   */
  clear(): void {
    this.data = createDefaultData()

    if (typeof window !== "undefined") {
      try {
        localStorage.removeItem(LEGACY_OWNER_UID_STORAGE_KEY)
      } catch (err) {
        console.error("[OwnerUID] Failed to clear legacy localStorage:", err)
      }
    }

    this.notifyListeners()
    console.log("[OwnerUID] In-memory data cleared")
  }

  /**
   * Subscribe to state changes.
   */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Notify all subscribers.
   */
  private notifyListeners(): void {
    this.listeners.forEach((listener) => {
      listener()
    })
  }
}

// Export singleton instance. The token exists only in this module instance.
export const ownerUidStore = new OwnerUidStore()

// Auto-initialize on module load to remove credentials persisted by older builds.
if (typeof window !== "undefined") {
  ownerUidStore.initialize()
}
