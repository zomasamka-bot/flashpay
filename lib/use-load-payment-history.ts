import { useEffect, useState } from "react"
import { unifiedStore } from "./unified-store"
import { config } from "./config"
import { CoreLogger } from "./core"
import type { Payment } from "./types"

/**
 * Hook to load persistent payment history on app mount
 * Reads verified indexed history and a PostgreSQL-backed accounting summary.
 * Automatically loads payment history for the current merchant
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
        
        if (!merchantId) {
          CoreLogger.info("useLoadPaymentHistory: No merchant ID yet, skipping")
          return
        }

        CoreLogger.info("useLoadPaymentHistory: Loading payment history for merchant:", merchantId)

        const merchantState = unifiedStore.getMerchantState()
        const accessToken = merchantState.accessToken

        const response = await fetch(
          `${config.appUrl}/api/payments/history?merchantId=${encodeURIComponent(merchantId)}&limit=100`,
          {
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
          CoreLogger.error("useLoadPaymentHistory: Failed to fetch history, status:", response.status)
          return
        }

        const data = await response.json()
        if (!current()) return
        const balance = data?.balance
        if (!balance || balance.source !== "postgres" || balance.scope !== "all_time_settled" ||
            typeof balance.total !== "number" || !Number.isFinite(balance.total) || balance.total < 0 ||
            !Number.isSafeInteger(balance.settledTransactions) || balance.settledTransactions < 0) return
        setSummary({ total: balance.total, settledTransactions: balance.settledTransactions })
        
        if (data.payments && Array.isArray(data.payments)) {
          CoreLogger.info(
            "useLoadPaymentHistory: Loaded",
            data.payments.length,
            "payments from",
            data.source || "unknown"
          )

          // Load payments into the unified store
          for (const payment of data.payments) {
            const paymentObj: Payment = {
              id: payment.id,
              merchantId: payment.merchantId,
              amount: payment.amount,
              note: payment.note || "",
              status: payment.status as any,
              createdAt: typeof payment.createdAt === "string" ? payment.createdAt : new Date(payment.createdAt).toISOString(),
              paidAt: payment.paidAt ? (typeof payment.paidAt === "string" ? payment.paidAt : new Date(payment.paidAt).toISOString()) : undefined,
              accessToken: payment.accessToken || "",
              u2aTxid: (payment as any).u2aTxid,
              a2uTxid: (payment as any).a2uTxid,
            }
            
            // Use existing addPayment method to add to store
            unifiedStore.addPayment(paymentObj)
          }

          CoreLogger.info("useLoadPaymentHistory: Payment history loaded successfully")
        }
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
