/**
 * ============================================================================
 * OWNER UID ISOLATED STORE
 * ============================================================================
 *
 * This is a COMPLETELY SEPARATE storage system for owner operations.
 * It does NOT interact with the payment system in any way.
 *
 * ISOLATION GUARANTEE:
 * - No imports from lib/operations.ts
 * - No imports from lib/use-payments.ts
 * - No imports from lib/payments-store.ts
 * - Independent localStorage key: "flashpay_owner_uid"
 * - Independent initialization
 * - Independent error handling
 */

export interface OwnerUidData {
  uid: string | null
  accessToken: string | null
  walletAddress: string | null
  lastUpdated: number | null
  status: "idle" | "pending" | "success" | "error"
  error: string | null
}

const OWNER_UID_STORAGE_KEY = "flashpay_owner_uid"

class OwnerUidStore {
  private data: OwnerUidData = {
    uid: null,
    accessToken: null,
    walletAddress: null,
    lastUpdated: null,
    status: "idle",
    error: null,
  }

  /**
   * Initialize: Load from localStorage if available
   */
  initialize(): void {
    if (typeof window === "undefined") {
      console.log("[OwnerUID] Skipping initialization (server-side)")
      return
    }

    try {
      const stored = localStorage.getItem(OWNER_UID_STORAGE_KEY)
      if (stored) {
        this.data = JSON.parse(stored)
        console.log("[OwnerUID] Loaded from localStorage")
      } else {
        console.log("[OwnerUID] No stored data found, using defaults")
      }
    } catch (err) {
      console.error("[OwnerUID] Failed to load from localStorage:", err)
      // Continue with defaults on error
    }
  }

  /**
   * Set UID and related data
   */
  setUid(uid: string, accessToken?: string, walletAddress?: string): void {
    this.data.uid = uid
    this.data.accessToken = accessToken || null
    this.data.walletAddress = walletAddress || null
    this.data.lastUpdated = Date.now()
    this.data.status = "success"
    this.data.error = null
    this.persist()
    console.log("[OwnerUID] UID set and persisted")
  }

  /**
   * Get current UID data
   */
  getUid(): OwnerUidData {
    return { ...this.data }
  }

  /**
   * Set pending status
   */
  setPending(): void {
    this.data.status = "pending"
    this.data.error = null
    this.persist()
  }

  /**
   * Set error
   */
  setError(error: string): void {
    this.data.status = "error"
    this.data.error = error
    this.persist()
    console.error("[OwnerUID] Error stored:", error)
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.data = {
      uid: null,
      accessToken: null,
      walletAddress: null,
      lastUpdated: null,
      status: "idle",
      error: null,
    }
    this.persist()
    console.log("[OwnerUID] Data cleared")
  }

  /**
   * Persist to localStorage
   */
  private persist(): void {
    if (typeof window === "undefined") {
      return
    }

    try {
      localStorage.setItem(OWNER_UID_STORAGE_KEY, JSON.stringify(this.data))
    } catch (err) {
      console.error("[OwnerUID] Failed to persist to localStorage:", err)
    }
  }
}

// Export singleton instance
export const ownerUidStore = new OwnerUidStore()

// Auto-initialize on module load
if (typeof window !== "undefined") {
  ownerUidStore.initialize()
}
