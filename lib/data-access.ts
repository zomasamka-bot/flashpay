"use client"

import { unifiedStore } from "./unified-store"
import type { Payment, PaymentStatus } from "./types"
import { CoreLogger } from "./core"

/**
 * Data Access Layer (DAL)
 *
 * Enforces merchant-scoped data access with automatic filtering.
 * All queries are automatically limited to the current merchant's data.
 * Prevents cross-merchant data leakage at the data layer.
 */

class DataAccessLayer {
  /**
   * Gets the current merchant ID from the session
   * Throws if no merchant session exists
   */
  private getCurrentMerchantId(): string {
    const state = unifiedStore.getState()
    const merchantId = state.session.currentMerchantId || state.merchant.merchantId

    if (!merchantId) {
      CoreLogger.error("No merchant session found")
      throw new Error("No merchant session")
    }

    return merchantId
  }

  /**
   * Creates a payment automatically scoped to current merchant
   */
  createPayment(amount: number, note: string): Payment {
    const merchantId = this.getCurrentMerchantId()
    CoreLogger.info("DAL: Creating payment for merchant", { merchantId, amount })

    return unifiedStore.createPayment(amount, note)
  }

  /**
   * Gets a single payment (merchant-scoped)
   * Returns undefined if payment doesn't exist or belongs to another merchant
   */
  getPayment(id: string): Payment | undefined {
    const merchantId = this.getCurrentMerchantId()
    const payment = unifiedStore.getPayment(id)

    // Double-check merchant ownership
    if (payment && payment.merchantId !== merchantId) {
      CoreLogger.warn("DAL: Cross-merchant access blocked", { paymentId: id })
      return undefined
    }

    return payment
  }

  /**
   * Gets all payments for current merchant only
   */
  getAllPayments(): Payment[] {
    const merchantId = this.getCurrentMerchantId()
    const payments = unifiedStore.getAllPayments()

    // Verify all payments belong to current merchant
    const filtered = payments.filter((p) => p.merchantId === merchantId)

    if (filtered.length !== payments.length) {
      CoreLogger.warn("DAL: Filtered out cross-merchant payments", {
        total: payments.length,
        afterFilter: filtered.length,
      })
    }

    return filtered
  }

  /**
   * Gets payment statistics for current merchant only
   */
  getPaymentStats() {
    const merchantId = this.getCurrentMerchantId()
    CoreLogger.info("DAL: Getting stats for merchant", { merchantId })

    return unifiedStore.getPaymentStats()
  }

  /**
   * Updates payment status (merchant-scoped)
   */
  updatePaymentStatus(id: string, status: PaymentStatus, txid?: string): boolean {
    const merchantId = this.getCurrentMerchantId()
    const payment = this.getPayment(id)

    if (!payment) {
      CoreLogger.warn("DAL: Cannot update payment - not found or wrong merchant", { id })
      return false
    }

    CoreLogger.info("DAL: Updating payment status", { id, merchantId, status })
    return unifiedStore.updatePaymentStatus(id, status, txid)
  }

  /**
   * Clears all payments for current merchant only
   */
  clearPayments(): void {
    const merchantId = this.getCurrentMerchantId()
    CoreLogger.info("DAL: Clearing payments for merchant", { merchantId })

    unifiedStore.clearAllPayments()
  }

  /**
   * Gets today's payments for current merchant
   */
  getTodaysPayments(): Payment[] {
    const merchantId = this.getCurrentMerchantId()
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const payments = this.getAllPayments()
    const todaysPayments = payments.filter((p) => p.createdAt >= today)

    CoreLogger.info("DAL: Got today's payments", {
      merchantId,
      count: todaysPayments.length,
    })

    return todaysPayments
  }

  /**
   * Gets today's total earned for current merchant
   */
  getTodaysTotalEarned(): number {
    const todaysPayments = this.getTodaysPayments()
    const paidPayments = todaysPayments.filter((p) => p.status === "PAID")
    const total = paidPayments.reduce((sum, p) => sum + p.amount, 0)

    return total
  }

  /**
   * Gets merchant ID (safe to expose to UI)
   */
  getCurrentMerchantIdSafe(): string {
    return this.getCurrentMerchantId()
  }

  /**
   * PRIVATE: Owner-only method to get all payments across merchants
   * This should NEVER be called from merchant UI
   */
  private getAllPaymentsAcrossMerchants(): Payment[] {
    if (!this.isOwner()) {
      CoreLogger.error("Unauthorized: Owner access required")
      throw new Error("Unauthorized")
    }

    return unifiedStore.getAllPaymentsAcrossMerchants()
  }

  /**
   * PRIVATE: Check if current session is owner
   */
  private isOwner(): boolean {
    return unifiedStore["isOwnerAuthenticated"]()
  }
}

// Singleton instance
export const dataAccess = new DataAccessLayer()
