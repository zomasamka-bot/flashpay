"use client"

import { unifiedStore } from "./unified-store"
import { createPiPayment } from "./pi-sdk"
import type { Payment } from "./types"
import { CoreLogger } from "./core"
import { SecurityGuard, InputValidator, rateLimiter, errorTracker, auditLogger } from "./security"
import { config } from "./config"

function generateUUID(): string {
  if (typeof window !== "undefined" && window.crypto && window.crypto.randomUUID) {
    return window.crypto.randomUUID()
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0
    const v = c === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

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

  try {
    const rateLimitCheck = rateLimiter.check("create_payment", RATE_LIMITS.CREATE_PAYMENT)
    if (!rateLimitCheck.allowed) {
      const trackingId = errorTracker.logError(operation, "Rate limit exceeded.")
      return { success: false, error: "Too many requests. Please wait a moment.", trackingId }
    }

    const amountValidation = InputValidator.validateAmount(amount)
    if (!amountValidation.valid) {
      const trackingId = errorTracker.logError(operation, amountValidation.error!)
      return { success: false, error: amountValidation.error, trackingId }
    }

    const noteValidation = InputValidator.validateNote(note)
    if (!noteValidation.valid) {
      const trackingId = errorTracker.logError(operation, noteValidation.error!)
      return { success: false, error: noteValidation.error, trackingId }
    }

    const securityCheck = SecurityGuard.preOperationCheck(operation, "flashpay")
    if (!securityCheck.passed) {
      const trackingId = errorTracker.logError(operation, securityCheck.reason || "Security check failed")
      return { success: false, error: securityCheck.reason, trackingId }
    }

    // Get merchantId from unified store
    const merchantId = unifiedStore.state.session.currentMerchantId || unifiedStore.state.merchant.merchantId
    if (!merchantId) {
      const trackingId = errorTracker.logError(operation, "No merchant ID available")
      return { success: false, error: "Merchant not authenticated", trackingId }
    }

    // Get merchant wallet address - captured from Pi authentication
    // walletAddress contains the uid (Pi's wallet identifier for A2U transfers)
    const merchantAddress = unifiedStore.state.merchant.walletAddress || ""

    const response = await fetch(`${config.appUrl}/api/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount, note, merchantId, merchantAddress }),
    })

    const contentType = response.headers.get("content-type")
    if (!contentType || !contentType.includes("application/json")) {
      const text = await response.text()
      throw new Error(`API returned non-JSON response: ${text.substring(0, 100)}`)
    }

    const result = await response.json()
    
    // Create payment with all fields from API response, including merchantId and merchantAddress
    const payment = unifiedStore.createPaymentWithId(
      result.payment.id, 
      amount, 
      note, 
      result.payment.createdAt,
      result.payment.merchantId,
      result.payment.merchantAddress
    )

    const trackingId = auditLogger.log(
      operation,
      { paymentId: payment.id, merchantId: payment.merchantId, amount, noteLength: note.length },
      "success",
    )

    CoreLogger.info("Payment created successfully:", payment.id)
    return { success: true, data: payment, trackingId }

  } catch (error) {
    const trackingId = errorTracker.logError(operation, error instanceof Error ? error.message : "Unknown error", error)
    CoreLogger.error("Failed to create payment:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to create payment",
      trackingId,
    }
  }
}

export function getPaymentById(id: string): Payment | undefined {
  const validation = InputValidator.validatePaymentId(id)
  if (!validation.valid) {
    CoreLogger.guard("Payment ID validation", true)
    return undefined
  }
  return unifiedStore.getPayment(id)
}

export function getAllPayments(): Payment[] {
  return unifiedStore.getAllPayments()
}

export function getPaymentStats() {
  return unifiedStore.getPaymentStats()
}

export async function getPaymentFromServer(id: string): Promise<Payment | null> {
  try {
    // Check in-memory store first
    const localPayment = unifiedStore.getPayment(id)
    if (localPayment) {
      return localPayment
    }

    // Fetch from Redis via API
    const response = await fetch(`${config.appUrl}/api/payments/${id}`)

    if (!response.ok) {
      return null
    }

    const contentType = response.headers.get("content-type")
    if (!contentType || !contentType.includes("application/json")) {
      return null
    }

    const data = await response.json()

    if (!data.success || !data.payment) {
      return null
    }

    const payment = data.payment
    const convertedPayment = {
      ...payment,
      createdAt: new Date(payment.createdAt),
      paidAt: payment.paidAt ? new Date(payment.paidAt) : undefined,
    }

    unifiedStore.addPayment(convertedPayment)
    return convertedPayment

  } catch (error) {
    CoreLogger.error("getPaymentFromServer failed:", error)
    return unifiedStore.getPayment(id) || null
  }
}

export function executePayment(
  paymentId: string,
  onSuccess: (txid: string) => void,
  onError: (error: string, trackingId?: string) => void,
): void {
  const operation = "executePayment"
  CoreLogger.operation(operation, { paymentId })

  const rateLimitCheck = rateLimiter.check(`execute_payment_${paymentId}`, RATE_LIMITS.EXECUTE_PAYMENT)
  if (!rateLimitCheck.allowed) {
    const trackingId = errorTracker.logError(operation, "Rate limit exceeded for payment execution")
    onError("Too many payment attempts. Please wait a moment.", trackingId)
    return
  }

  const idValidation = InputValidator.validatePaymentId(paymentId)
  if (!idValidation.valid) {
    const trackingId = errorTracker.logError(operation, idValidation.error!)
    onError(idValidation.error!, trackingId)
    return
  }

  const payment = unifiedStore.getPayment(paymentId)

  if (!payment) {
    const trackingId = errorTracker.logError(operation, "Payment not found", { paymentId })
    CoreLogger.guard("Payment existence check", true)
    onError("Payment not found", trackingId)
    return
  }

  CoreLogger.guard("Payment existence check", false)

  if (payment.status === "PAID") {
    const trackingId = errorTracker.logError(operation, "Payment already completed", { paymentId })
    CoreLogger.guard("Double payment check", true)
    onError("This payment has already been completed", trackingId)
    return
  }

  CoreLogger.guard("Double payment check", false)
  CoreLogger.info("Starting Pi Wallet payment flow...")

  console.log("[Operations] ========================================")
  console.log("[Operations] CRITICAL: Extracting merchant data from payment store")
  console.log("[Operations] Payment ID:", payment.id)
  console.log("[Operations] Amount:", payment.amount)
  console.log("[Operations] Note:", payment.note)
  console.log("[Operations] Merchant ID:", payment.merchantId)
  console.log("[Operations] Merchant Address:", payment.merchantAddress)
  console.log("[Operations] Payment status:", payment.status)
  console.log("[Operations] ========================================")

  // CRITICAL: Validate merchant data BEFORE passing to Pi SDK
  if (!payment.merchantId || payment.merchantId === "unknown") {
    console.error("[Operations] ❌ CRITICAL: Merchant ID is invalid!")
    console.error("[Operations] This will cause Pi SDK errors!")
  }

  if (!payment.merchantAddress || payment.merchantAddress === "unknown") {
    console.warn("[Operations] ⚠️  WARNING: Merchant Address is missing or unknown")
    console.warn("[Operations] This may cause issues with Pi transfers!")
  }

  auditLogger.log(operation, { paymentId, merchantId: payment.merchantId, amount: payment.amount }, "success")

  createPiPayment(
    payment.amount,
    payment.note,
    paymentId,
    payment.merchantId,
    payment.merchantAddress || "",
    async (txid) => {
      CoreLogger.operation("Payment success callback", { txid })

      const success = unifiedStore.updatePaymentStatus(paymentId, "PAID", txid)

      try {
        await fetch(`${config.appUrl}/api/payments/${paymentId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "PAID", txid }),
        })
      } catch (error) {
        CoreLogger.warn("Backend sync failed:", error)
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

      try {
        await fetch(`${config.appUrl}/api/payments/${paymentId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        })
      } catch (err) {
        CoreLogger.warn("Backend sync failed:", err)
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
  return payment?.status?.toUpperCase() === "PAID"
}

export function canRetryPayment(id: string): boolean {
  const payment = unifiedStore.getPayment(id)
  return payment?.status === "FAILED" || payment?.status === "CANCELLED"
}
