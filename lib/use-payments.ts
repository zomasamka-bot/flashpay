"use client"

import { useState, useEffect } from "react"
import { unifiedStore } from "./unified-store"
import type { Payment } from "./types"
import { CoreLogger } from "./core"

/**
 * React hooks for unified payments store
 *
 * These hooks provide real-time synchronization across all pages.
 * Any change in the store immediately updates all subscribed components.
 */

/**
 * Hook to get all payments with real-time updates
 */
export function usePayments() {
  const [payments, setPayments] = useState<Payment[]>([])

  useEffect(() => {
    CoreLogger.sync("usePayments hook mounted")

    // Initial load
    setPayments(unifiedStore.getAllPayments())

    const unsubscribe = unifiedStore.subscribe("payments", () => {
      CoreLogger.sync("usePayments received update")
      setPayments(unifiedStore.getAllPayments())
    })

    return () => {
      CoreLogger.sync("usePayments hook unmounted")
      unsubscribe()
    }
  }, [])

  return payments
}

/**
 * Hook to get a single payment by ID with real-time updates
 */
export function usePayment(id: string) {
  const [payment, setPayment] = useState<Payment | undefined>()

  useEffect(() => {
    CoreLogger.sync(`usePayment hook mounted for ${id}`)

    // Initial load
    setPayment(unifiedStore.getPayment(id))

    const unsubscribe = unifiedStore.subscribe("payments", () => {
      CoreLogger.sync(`usePayment received update for ${id}`)
      setPayment(unifiedStore.getPayment(id))
    })

    return () => {
      CoreLogger.sync(`usePayment hook unmounted for ${id}`)
      unsubscribe()
    }
  }, [id])

  return payment
}

/**
 * Hook to get payment statistics with real-time updates
 */
export function usePaymentStats() {
  const [stats, setStats] = useState(() => unifiedStore.getPaymentStats())

  useEffect(() => {
    CoreLogger.sync("usePaymentStats hook mounted")

    // Subscribe to updates
    const unsubscribe = unifiedStore.subscribe("payments", () => {
      CoreLogger.sync("usePaymentStats received update")
      setStats(unifiedStore.getPaymentStats())
    })

    return () => {
      CoreLogger.sync("usePaymentStats hook unmounted")
      unsubscribe()
    }
  }, [])

  return stats
}

export { usePayment as usePaymentById }
