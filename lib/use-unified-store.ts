"use client"

/**
 * React hooks for the unified state store
 * Provides real-time synchronization across all pages and tabs
 */

import { useState, useEffect } from "react"
import { unifiedStore } from "./unified-store"
import type { Payment } from "./types"
import type { UserSession, WalletStatus, UIState } from "./unified-store"

// ============================================================================
// PAYMENTS HOOKS
// ============================================================================

export function usePayments() {
  const [payments, setPayments] = useState<Payment[]>([])

  useEffect(() => {
    setPayments(unifiedStore.getAllPayments())

    const unsubscribe = unifiedStore.subscribe("payments", () => {
      setPayments(unifiedStore.getAllPayments())
    })

    return unsubscribe
  }, [])

  return payments
}

export function usePayment(id: string) {
  const [payment, setPayment] = useState<Payment | undefined>()

  useEffect(() => {
    setPayment(unifiedStore.getPayment(id))

    const unsubscribe = unifiedStore.subscribe("payments", () => {
      setPayment(unifiedStore.getPayment(id))
    })

    return unsubscribe
  }, [id])

  return payment
}

export function usePaymentStats() {
  const [stats, setStats] = useState(() => unifiedStore.getPaymentStats())

  useEffect(() => {
    const unsubscribe = unifiedStore.subscribe("payments", () => {
      setStats(unifiedStore.getPaymentStats())
    })

    return unsubscribe
  }, [])

  return stats
}

// ============================================================================
// DOMAINS HOOKS
// ============================================================================

export function useDomains() {
  const [, forceUpdate] = useState({})

  useEffect(() => {
    const unsubscribe = unifiedStore.subscribe("domainState", () => {
      forceUpdate({})
    })
    return unsubscribe
  }, [])

  return {
    masterEnabled: unifiedStore.isMasterEnabled(),
    setMasterEnabled: (enabled: boolean) => unifiedStore.setMasterEnabled(enabled),
    domains: unifiedStore.getAllDomains(),
    setDomainEnabled: (domainId: string, enabled: boolean) => unifiedStore.setDomainEnabled(domainId, enabled),
    isDomainEnabled: (domainId: string) => unifiedStore.isDomainEnabled(domainId),
  }
}

// ============================================================================
// SESSION HOOKS
// ============================================================================

export function useSession() {
  const [session, setSession] = useState<UserSession>(() => unifiedStore.getSession())

  useEffect(() => {
    const unsubscribe = unifiedStore.subscribe("session", () => {
      setSession(unifiedStore.getSession())
    })
    return unsubscribe
  }, [])

  return {
    session,
    updateSession: (updates: Partial<UserSession>) => unifiedStore.updateSession(updates),
  }
}

// ============================================================================
// WALLET HOOKS
// ============================================================================

export function useWallet() {
  const [wallet, setWallet] = useState<WalletStatus>(() => unifiedStore.getWalletStatus())

  useEffect(() => {
    const unsubscribe = unifiedStore.subscribe("wallet", () => {
      setWallet(unifiedStore.getWalletStatus())
    })
    return unsubscribe
  }, [])

  return {
    wallet,
    updateWalletStatus: (updates: Partial<WalletStatus>) => unifiedStore.updateWalletStatus(updates),
  }
}

// ============================================================================
// UI STATE HOOKS
// ============================================================================

export function useUIState() {
  const [ui, setUI] = useState<UIState>(() => unifiedStore.getUIState())

  useEffect(() => {
    const unsubscribe = unifiedStore.subscribe("ui", () => {
      setUI(unifiedStore.getUIState())
    })
    return unsubscribe
  }, [])

  return {
    ui,
    updateUI: (updates: Partial<UIState>) => unifiedStore.updateUIState(updates),
  }
}

// ============================================================================
// FULL STATE HOOK (for debugging/control panel)
// ============================================================================

export function useUnifiedState() {
  const [, forceUpdate] = useState({})

  useEffect(() => {
    const unsubscribe = unifiedStore.subscribe("all", () => {
      forceUpdate({})
    })
    return unsubscribe
  }, [])

  return unifiedStore.getFullState()
}
