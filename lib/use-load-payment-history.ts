import { useEffect, useState } from "react"
import { unifiedStore } from "./unified-store"
import { config } from "./config"
import { CoreLogger } from "./core"

/**
 * Home needs the existing PostgreSQL accounting summary, not certification of
 * every historical request's original creation time. Receipt/history pages use
 * their own authenticated read models. Never turn transaction IDs or later
 * accounting timestamps into application payment identities in the local store.
 */
export function useLoadPaymentHistory() {
  const [summary, setSummary] = useState<{ total: number; settledTransactions: number } | null>(null)
  useEffect(() => {
    let disposed = false
    let generation = 0
    const identity = () => { const m = unifiedStore.getMerchantState(); return `${m.merchantId}\u0000${m.accessToken}` }
    let currentIdentity = identity()
    const loadHistory = async () => {
      const requestGeneration = ++generation
      const requestIdentity = identity()
      const current = () => !disposed && requestGeneration === generation && requestIdentity === identity()
      setSummary(null)
      try {
        const merchantId = unifiedStore.getMerchantState().merchantId
        
        if (!merchantId || !unifiedStore.getMerchantState().accessToken) {
          return
        }

        const merchantState = unifiedStore.getMerchantState()
        const accessToken = merchantState.accessToken

        const response = await fetch(
          `${config.appUrl}/api/merchant/payments?merchantId=${encodeURIComponent(merchantId)}&limit=1`,
          {
            cache: "no-store",
            headers: {
              'Authorization': accessToken ? `Bearer ${accessToken}` : '',
            },
          }
        )

        if (!current()) return
        if (response.status === 401) {
          // A persisted merchant token can expire between sessions. Fail closed:
          // discard the stale merchant authentication and let the existing
          // explicit Pi authentication flow obtain a fresh token. Do not
          // auto-authenticate or blindly retry from this background hook.
          unifiedStore.clearMerchantAuth()
          unifiedStore.updateWalletStatus({ isConnected: false })
          CoreLogger.warn("useLoadPaymentHistory: Merchant authorization expired; fresh Pi authentication required")
          return
        }

        if (!response.ok) {
          CoreLogger.error("useLoadPaymentHistory: Accounting summary unavailable, status:", response.status)
          return
        }

        const data = await response.json()
        if (!current()) return
        const balance = data?.summary
        if (!balance || typeof balance.total_settled_amount !== "number" ||
            !Number.isFinite(balance.total_settled_amount) || balance.total_settled_amount < 0 ||
            !Number.isSafeInteger(balance.settled_transactions) || balance.settled_transactions < 0) return
        setSummary({ total: balance.total_settled_amount, settledTransactions: balance.settled_transactions })
      } catch (error) {
        CoreLogger.error("useLoadPaymentHistory: Error loading payment history:", error)
      }
    }

    // Load on mount
    loadHistory()

    // Optionally reload periodically (e.g., every 5 minutes)
    const interval = setInterval(loadHistory, 5 * 60 * 1000)

    const unsubscribe = unifiedStore.subscribe("merchant", () => {
      const nextIdentity = identity()
      if (nextIdentity !== currentIdentity) { currentIdentity = nextIdentity; void loadHistory() }
    })
    return () => { disposed = true; generation++; clearInterval(interval); unsubscribe() }
  }, [])
  return summary
}
