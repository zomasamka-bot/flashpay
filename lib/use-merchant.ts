"use client"

import { useState, useEffect } from "react"
import { unifiedStore, type MerchantState } from "./unified-store"
import { CoreLogger } from "./core"

/**
 * React hook for merchant state with real-time updates
 *
 * Provides access to merchant setup status, Pi username, wallet connection, and merchant ID
 */
export function useMerchant() {
  const [merchantState, setMerchantState] = useState<MerchantState>(() => unifiedStore.getMerchantState())

  useEffect(() => {
    CoreLogger.sync("useMerchant hook mounted")

    const unsubscribe = unifiedStore.subscribe("merchant", () => {
      CoreLogger.sync("useMerchant received update")
      setMerchantState(unifiedStore.getMerchantState())
    })

    return () => {
      CoreLogger.sync("useMerchant hook unmounted")
      unsubscribe()
    }
  }, [])

  return merchantState
}
