"use client"

import { unifiedStore } from "./unified-store"
import { createPiPayment } from "./pi-sdk"
import type { Payment } from "./types"
import { CoreLogger } from "./core"
import { SecurityGuard, InputValidator, rateLimiter, errorTracker, auditLogger } from "./security"

// Browser-compatible UUID generation (crypto module doesn't work in browser)
function generateUUID(): string {
  if (typeof window !== "undefined" && window.crypto && window.crypto.randomUUID) {
    return window.crypto.randomUUID()
  }
  // Fallback for older browsers
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0
    const v = c === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

const API_BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "https://flashpay-two.vercel.app"

/**
 * Unified Operational Control Layer
 *
 * Enhanced with comprehensive security, validation, and error handling
 * All operations are automatically scoped to the current merchant
 */

interface OperationResult<T> {
  success: boolean
  data?: T
  error?: string
  trackingId?: string
}

const RATE_LIMITS = {
  CREATE_PAYMENT: { maxAttempts: 10, windowMs: 60000 },
  EXECUTE_PAYMENT: { maxAttempts: 5, windowMs: 60000 },
}

export async function createPayment(amount: number, note = ""): Promise<OperationResult<Payment>> {
  const operation = "createPayment"
  CoreLogger.operation(operation, { amount, noteLength: note.length })

  console.log("[v0] ===== PAYMENT CREATION START =====")
  console.log("[v0] Amount:", amount)
  console.log("[v0] Note:", note)

  try {
    const rateLimitCheck = rateLimiter.check("create_payment", RATE_LIMITS.CREATE_PAYMENT)
    if (!rateLimitCheck.allowed) {
      console.log("[v0] Rate limit exceeded")
      const trackingId = errorTracker.logError(
        operation,
        "Rate limit exceeded. Please wait before creating another payment.",
      )
      return { success: false, error: "Too many requests. Please wait a moment.", trackingId }
    }
    console.log("[v0] Rate limit check passed")

    const amountValidation = InputValidator.validateAmount(amount)
    if (!amountValidation.valid) {
      console.log("[v0] Amount validation failed:", amountValidation.error)
      const trackingId = errorTracker.logError(operation, amountValidation.error!)
      CoreLogger.guard("Amount validation", true)
      return { success: false, error: amountValidation.error, trackingId }
    }
    console.log("[v0] Amount validation passed")

    const noteValidation = InputValidator.validateNote(note)
    if (!noteValidation.valid) {
      console.log("[v0] Note validation failed:", noteValidation.error)
      const trackingId = errorTracker.logError(operation, noteValidation.error!)
      CoreLogger.guard("Note validation", true)
      return { success: false, error: noteValidation.error, trackingId }
    }
    console.log("[v0] Note validation passed")

    CoreLogger.guard("Input validation", false)

    const securityCheck = SecurityGuard.preOperationCheck(operation, "flashpay")
    if (!securityCheck.passed) {
      console.log("[v0] Security check failed:", securityCheck.reason)
      const trackingId = errorTracker.logError(operation, securityCheck.reason || "Security check failed")
      return { success: false, error: securityCheck.reason, trackingId }
    }
    console.log("[v0] Security check passed")

    console.log("[v0] Creating payment on server...")

    const paymentId = generateUUID()

    try {
      const response = await fetch(`${API_BASE_URL}/api/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, note }),
      })

      console.log("[v0] Server response status:", response.status)

    if (!response.ok) {
      throw new Error(`Failed to create payment: ${response.statusText}`)
    }

    // Check if response is JSON before parsing
    const contentType = response.headers.get("content-type")
    if (!contentType || !contentType.includes("application/json")) {
      const text = await response.text()
      throw new Error(`API returned non-JSON response: ${text.substring(0, 100)}`)
    }

    const result = await response.json()
      console.log("[v0] Payment created on server:", result.payment.id)

      // Store locally as well for offline access
      const payment = unifiedStore.createPaymentWithId(result.payment.id, amount, note, result.payment.createdAt)

      const trackingId = auditLogger.log(
        operation,
        { paymentId: payment.id, merchantId: payment.merchantId, amount, noteLength: note.length },
        "success",
      )

      console.log("[v0] ===== PAYMENT CREATION SUCCESS =====")
      console.log("[v0] Payment ID:", payment.id)

      CoreLogger.info("Payment created successfully:", payment.id)
      return { success: true, data: payment, trackingId }
    } catch (error) {
      console.error("[v0] ===== PAYMENT CREATION ERROR =====")
      console.error("[v0] Error:", error)

      const trackingId = errorTracker.logError(
        operation,
        error instanceof Error ? error.message : "Unknown error",
        error,
      )
      CoreLogger.error("Failed to create payment:", error)
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create payment",
        trackingId,
      }
    }
  } catch (error) {
    console.error("[v0] ===== PAYMENT CREATION ERROR =====")
    console.error("[v0] Error:", error)

    const trackingId = errorTracker.logError(operation, error instanceof Error ? error.message : "Unknown error", error)
    CoreLogger.error("Failed to create payment:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to create payment",
      trackingId,
    }
  }
}

/**
 * Fetches a payment by ID with validation
 */
export function getPaymentById(id: string): Payment | undefined {
  const validation = InputValidator.validatePaymentId(id)
  if (!validation.valid) {
    CoreLogger.guard("Payment ID validation", true)
    return undefined
  }

  const payment = unifiedStore.getPayment(id)

  if (!payment) {
    CoreLogger.warn("Payment not found:", id)
  }

  return payment
}

/**
 * Gets all payments for current merchant only
 */
export function getAllPayments(): Payment[] {
  return unifiedStore.getAllPayments()
}

/**
 * Gets payment statistics for current merchant only
 */
export function getPaymentStats() {
  return unifiedStore.getPaymentStats()
}

export async function getPaymentFromServer(id: string): Promise<Payment | null> {
  try {
    // First check local storage
    const localPayment = unifiedStore.getPayment(id)
    if (localPayment) {
      console.log("[v0] Payment found in local storage:", id)
      return localPayment
    }

    // If not in local storage, try fetching from server
    console.log("[v0] Payment not in local storage, fetching from server:", id)
    const apiUrl = `${API_BASE_URL}/api/payments?id=${id}`
    const response = await fetch(apiUrl)

    if (!response.ok) {
      console.log("[v0] Server fetch failed with status:", response.status)
      return null
    }

    // Check if response is JSON before parsing
    const contentType = response.headers.get("content-type")
    if (!contentType || !contentType.includes("application/json")) {
      console.error("[v0] Response is not JSON. Content-Type:", contentType)
      const text = await response.text()
      console.error("[v0] Response body:", text.substring(0, 200))
      return null
    }

    const data = await response.json()
    if (!data.success || !data.payment) {
      console.log("[v0] Invalid server response:", data)
      return null
    }

    // Convert date strings back to Date objects
    const payment = data.payment
    const convertedPayment = {
      ...payment,
      createdAt: new Date(payment.createdAt),
      paidAt: payment.paidAt ? new Date(payment.paidAt) : undefined,
    }

    // Store in local cache
    unifiedStore.addPayment(convertedPayment)

    return convertedPayment
  } catch (error) {
    console.error("[v0] Error fetching payment from server:", error)
    // Return local payment as fallback
    return unifiedStore.getPayment(id) || null
  }
}

export function executePayment(
  paymentId: string,
  onSuccess: (txid: string) => void,
  onError: (error: string, trackingId?: string) => void,
): void {
  const operation = "executePayment"
  console.log("[v0] executePayment called for:", paymentId)
  CoreLogger.operation(operation, { paymentId })

  const rateLimitCheck = rateLimiter.check(`execute_payment_${paymentId}`, RATE_LIMITS.EXECUTE_PAYMENT)
  if (!rateLimitCheck.allowed) {
    const trackingId = errorTracker.logError(operation, "Rate limit exceeded for payment execution")
    console.log("[v0] Rate limit exceeded")
    onError("Too many payment attempts. Please wait a moment.", trackingId)
    return
  }

  const idValidation = InputValidator.validatePaymentId(paymentId)
  if (!idValidation.valid) {
    const trackingId = errorTracker.logError(operation, idValidation.error!)
    console.log("[v0] Invalid payment ID:", idValidation.error)
    onError(idValidation.error!, trackingId)
    return
  }

  const payment = unifiedStore.getPayment(paymentId)

  if (!payment) {
    const trackingId = errorTracker.logError(operation, "Payment not found", { paymentId })
    CoreLogger.guard("Payment existence check", true)
    console.log("[v0] Payment not found in unifiedStore")
    onError("Payment not found", trackingId)
    return
  }
  console.log("[v0] Payment found in store:", payment)
  CoreLogger.guard("Payment existence check", false)

  if (payment.status === "PAID") {
    const trackingId = errorTracker.logError(operation, "Payment already completed", { paymentId })
    CoreLogger.guard("Double payment check", true)
    console.log("[v0] Payment already completed")
    onError("This payment has already been completed", trackingId)
    return
  }

  if (payment.status === "FAILED") {
    CoreLogger.warn("Retrying failed payment", { paymentId })
    console.log("[v0] Retrying failed payment")
  }

  if (payment.status === "CANCELLED") {
    CoreLogger.warn("Retrying cancelled payment", { paymentId })
    console.log("[v0] Retrying cancelled payment")
  }

  CoreLogger.guard("Double payment check", false)

  // Note: Customers don't need wallet connected beforehand
  // Pi SDK will handle wallet authentication when Pi.createPayment() is called

  // Domain check removed for customer payments - customers should always be able to pay
  // regardless of domain configuration (merchant-side restriction only)

  CoreLogger.info("Starting Pi Wallet payment flow...")
  console.log("[v0] Calling createPiPayment with:", { amount: payment.amount, note: payment.note, paymentId })
  auditLogger.log(operation, { paymentId, merchantId: payment.merchantId, amount: payment.amount }, "success")

  createPiPayment(
    payment.amount,
    payment.note,
    paymentId,
    async (txid) => {
      console.log("[v0] createPiPayment success callback, txid:", txid)
      CoreLogger.operation("Payment success callback", { txid })

      const success = unifiedStore.updatePaymentStatus(paymentId, "PAID", txid)

      // Try to sync with backend, but don't fail if it doesn't work
      try {
        await fetch(`${API_BASE_URL}/api/payments/${paymentId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "PAID", txid }),
        })
      } catch (error) {
        console.log("[v0] Backend sync failed (expected in Pi Browser):", error)
      }

      if (success) {
        const trackingId = auditLogger.log(
          "paymentCompleted",
          { paymentId, txid, merchantId: payment.merchantId, amount: payment.amount },
          "success",
        )
        CoreLogger.info("Payment status updated to PAID")
        onSuccess(txid)
      } else {
        const trackingId = errorTracker.logError(operation, "Failed to update payment status (race condition)")
        CoreLogger.error("Failed to update payment status (race condition)")
        onError("Payment was already completed by another transaction", trackingId)
      }
    },
    async (error, isCancelled) => {
      const status = isCancelled ? "CANCELLED" : "FAILED"
      unifiedStore.updatePaymentStatus(paymentId, status)

      // Try to sync with backend, but don't fail if it doesn't work
      try {
        await fetch(`${API_BASE_URL}/api/payments/${paymentId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        })
      } catch (err) {
        console.log("[v0] Backend sync failed (expected in Pi Browser):", err)
      }

      const trackingId = errorTracker.logError(operation, error, { paymentId, merchantId: payment.merchantId, status })
      auditLogger.log(operation, { paymentId, error, status }, "failure")
      CoreLogger.error(`Payment ${status.toLowerCase()}:`, error)
      onError(error, trackingId)
    },
  )
}

export function isPaymentPaid(id: string): boolean {
  const payment = unifiedStore.getPayment(id)
  return payment?.status === "PAID"
}

export function canRetryPayment(id: string): boolean {
  const payment = unifiedStore.getPayment(id)
  return payment?.status === "FAILED" || payment?.status === "CANCELLED"
}
