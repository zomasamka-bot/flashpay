import { useEffect } from "react"
import { unifiedStore } from "./unified-store"
import { config } from "./config"
import { CoreLogger } from "./core"
import type { Payment } from "./types"

/**
 * Hook to load persistent payment history on app mount
 * Fetches from PostgreSQL (persistent) with Redis fallback
 * Automatically loads payment history for the current merchant
 */
export function useLoadPaymentHistory() {
  useEffect(() => {
    const loadHistory = async () => {
      try {
        const merchantId = unifiedStore.state.merchant?.merchantId
        
        if (!merchantId) {
          CoreLogger.info("useLoadPaymentHistory: No merchant ID yet, skipping")
          return
        }

        CoreLogger.info("useLoadPaymentHistory: Loading payment history for merchant:", merchantId)

        const response = await fetch(
          `${config.appUrl}/api/payments/history?merchantId=${encodeURIComponent(merchantId)}&limit=100`
        )

        if (!response.ok) {
          CoreLogger.error("useLoadPaymentHistory: Failed to fetch history, status:", response.status)
          return
        }

        const data = await response.json()
        
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
              createdAt: typeof payment.createdAt === "string" ? new Date(payment.createdAt) : payment.createdAt,
              paidAt: payment.paidAt ? (typeof payment.paidAt === "string" ? new Date(payment.paidAt) : payment.paidAt) : undefined,
              txid: payment.txid,
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

    return () => clearInterval(interval)
  }, [])
}
