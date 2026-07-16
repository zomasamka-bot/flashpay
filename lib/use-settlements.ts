import { useEffect, useState } from "react"
import { config } from "./config"

export interface SettlementStats {
  settled: number
  unsettled: number
  pendingCount: number
  lastUpdated: string
}

export interface Settlement {
  id: string
  merchant_id: string
  transaction_id: string
  payment_id?: string
  amount: number
  status: "queued" | "processing" | "completed" | "failed"
  created_at: string
  completed_at?: string
  txid?: string
  error_message?: string
  retry_count: number
  payment_date?: string
}

/**
 * Hook to fetch settlement status and history for merchant
 */
export function useSettlementStatus(merchantId: string | null) {
  const [stats, setStats] = useState<SettlementStats | null>(null)
  const [history, setHistory] = useState<Settlement[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchSettlementStatus = async () => {
    if (!merchantId) {
      setStats(null)
      setHistory([])
      return
    }

    try {
      setLoading(true)
      setError(null)

      console.log("[useSettlementStatus] Fetching for merchant:", merchantId)

      const response = await fetch(
        `${config.appUrl}/api/settlements?merchantId=${encodeURIComponent(merchantId)}`
      )

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`)
      }

      const data = await response.json()

      setStats(data.stats)
      setHistory(data.history || [])

      console.log("[useSettlementStatus] Loaded:", {
        settled: data.stats?.settled,
        unsettled: data.stats?.unsettled,
        pending: data.stats?.pendingCount,
        historyCount: data.history?.length,
      })
    } catch (err) {
      console.error("[useSettlementStatus] Error:", err)
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchSettlementStatus()

    // Refresh every 30 seconds for real-time updates
    const interval = setInterval(fetchSettlementStatus, 30000)
    return () => clearInterval(interval)
  }, [merchantId])

  return { stats, history, loading, error, refetch: fetchSettlementStatus }
}

/**
 * Hook to trigger manual settlement processing
 */
export function useProcessSettlements(merchantId: string | null) {
  const [processing, setProcessing] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  const processSettlements = async () => {
    if (!merchantId) {
      setError("No merchant ID")
      return
    }

    try {
      setProcessing(true)
      setError(null)

      console.log("[useProcessSettlements] Processing settlements for:", merchantId)

      const response = await fetch(`${config.appUrl}/api/settlements`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchantId }),
      })

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`)
      }

      const data = await response.json()
      setResult(data.data)

      console.log("[useProcessSettlements] Completed:", data.data)
    } catch (err) {
      console.error("[useProcessSettlements] Error:", err)
      setError(String(err))
    } finally {
      setProcessing(false)
    }
  }

  return { processSettlements, processing, result, error }
}
