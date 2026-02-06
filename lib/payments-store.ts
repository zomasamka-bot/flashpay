"use client"

/**
 * ============================================================================
 * DEPRECATED: This file is no longer used
 * ============================================================================
 *
 * All payment storage has been migrated to lib/unified-store.ts
 * This file is kept for reference only and will be removed in a future update.
 *
 * DO NOT IMPORT OR USE THIS FILE
 *
 * Use instead:
 * - import { unifiedStore } from "./unified-store"
 * - unifiedStore.createPayment()
 * - unifiedStore.getPayment()
 * - unifiedStore.getAllPayments()
 * ============================================================================
 */

import type { Payment, PaymentStatus } from "./types"
import { CoreLogger } from "./core"

/**
 * @deprecated Use unifiedStore from lib/unified-store.ts instead
 */
class PaymentsStore {
  private payments: Map<string, Payment> = new Map()
  private listeners: Set<() => void> = new Set()
  private processingPayments: Set<string> = new Set()
  private initialized = false

  constructor() {
    if (typeof window !== "undefined") {
      CoreLogger.warn("⚠️ DEPRECATED: PaymentsStore is deprecated. Use unifiedStore instead.")
      this.initialized = true
    }
  }

  private loadFromLocalStorage() {
    // This method is deprecated and not used
  }

  private saveToLocalStorage() {
    // This method is deprecated and not used
  }

  private notify() {
    // This method is deprecated and not used
  }

  /**
   * @deprecated Use unifiedStore.subscribe('payments', listener) instead
   */
  subscribe(listener: () => void) {
    CoreLogger.warn("⚠️ DEPRECATED: Use unifiedStore.subscribe('payments', listener) instead")
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * @deprecated
   */
  createPayment(amount: number, note: string): Payment {
    throw new Error("DEPRECATED: Use unifiedStore.createPayment() instead")
  }

  /**
   * @deprecated
   */
  getPayment(id: string): Payment | undefined {
    throw new Error("DEPRECATED: Use unifiedStore.getPayment() instead")
  }

  /**
   * @deprecated
   */
  getAllPayments(): Payment[] {
    throw new Error("DEPRECATED: Use unifiedStore.getAllPayments() instead")
  }

  /**
   * @deprecated
   */
  updatePaymentStatus(id: string, status: PaymentStatus, txid?: string): boolean {
    throw new Error("DEPRECATED: Use unifiedStore.updatePaymentStatus() instead")
  }

  /**
   * @deprecated
   */
  isPaymentPaid(id: string): boolean {
    throw new Error("DEPRECATED: Use unifiedStore.getPayment() and check status instead")
  }

  /**
   * @deprecated
   */
  getStats() {
    throw new Error("DEPRECATED: Use unifiedStore.getPaymentStats() instead")
  }

  /**
   * @deprecated
   */
  isInitialized(): boolean {
    return this.initialized
  }
}

/**
 * @deprecated Use unifiedStore from lib/unified-store.ts instead
 */
export const paymentsStore = new PaymentsStore()
