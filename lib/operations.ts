"use client"

import { unifiedStore } from "./unified-store"
import { createPiPayment, authenticateMerchant } from "./pi-sdk"
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

    // Get merchant state snapshot
    const merchantState = unifiedStore.getMerchantState()
    const merchantId = merchantState.merchantId
    let merchantUid = merchantState.uid || ""
    
    console.log("[v0] ===== PAYMENT CREATION - UID EXTRACTION =====")
    console.log("[v0] merchantId (merchantId field):", merchantId)
    console.log("[v0] merchantUid (uid field):", merchantUid)
    console.log("[v0] merchantUid type:", typeof merchantUid)
    console.log("[v0] merchantUid length:", merchantUid.length)
    console.log("[v0] merchantUid has leading/trailing spaces:", /^\s|\s$/.test(merchantUid))
    console.log("[v0]")
    
    if (!merchantId) {
      const trackingId = errorTracker.logError(operation, "Merchant not authenticated - no merchantId in merchant state")
      return { success: false, error: "Merchant not authenticated. Please log in first.", trackingId }
    }
    
    // CRITICAL: If merchantUid is empty, STOP - do not allow payment creation
    if (!merchantUid) {
      console.error("[v0] ❌ PAYMENT CREATION BLOCKED: Merchant UID is empty")
      console.error("[v0] This means Pi.authenticate() has not been called successfully")
      const trackingId = errorTracker.logError(operation, "Merchant UID is empty - payment blocked")
      return { 
        success: false, 
        error: "Your wallet must be authenticated first. Please refresh the page and authenticate with Pi Wallet.",
        trackingId 
      }
    }

    console.log("[v0] ✓ Payment creation - UID is valid:", merchantUid.substring(0, 10) + "...")

    // Get the accessToken for UID verification
    const accessToken = merchantState.accessToken
    if (!accessToken) {
      console.error("[v0] ❌ accessToken not available for UID verification")
      const trackingId = errorTracker.logError(operation, "accessToken missing for UID verification")
      return { 
        success: false, 
        error: "Payment creation requires authentication. Please log in again.",
        trackingId 
      }
    }

    console.log("[v0] ===== PAYMENT CREATION - TOKEN FRESHNESS CHECK =====")
    console.log("[v0] accessToken retrieved from unifiedStore")
    console.log("[v0] accessToken length:", accessToken.length)
    console.log("[v0] accessToken first 30 chars:", accessToken.substring(0, 30))
    console.log("[v0] merchantUid matches merchant state UID:", merchantUid === merchantState.uid)
    console.log("[v0]")

    console.log("[v0] ===== PAYMENT CREATION - UID FLOW SUMMARY =====")
    console.log("[v0] Frontend Context (Pi Browser):")
    console.log("[v0]   - merchantUid from state = " + merchantUid)
    console.log("[v0]   - accessToken available = YES")
    console.log("[v0] Sending to /api/payments with:")
    console.log("[v0]   - merchantUid = " + merchantUid)
    console.log("[v0]   - accessToken = PROVIDED")
    console.log("[v0]")
    console.log("[v0] Backend will:")
    console.log("[v0]   1. Call /v2/me(accessToken) to verify UID")
    console.log("[v0]   2. Get fresh verified UID from /v2/me response")
    console.log("[v0]   3. Store fresh verified UID in Redis (may differ from frontend UID)")
    console.log("[v0]   4. Include accessToken in Redis for later A2U verification")
    console.log("[v0]")
    console.log("[v0] Later during A2U settlement:")
    console.log("[v0]   1. A2U retrieves payment from Redis")
    console.log("[v0]   2. Gets merchantUid from Redis (the verified one, not frontend's)")
    console.log("[v0]   3. Gets accessToken from Redis")
    console.log("[v0]   4. Calls /v2/me(accessToken) again to verify accessToken still valid")
    console.log("[v0]   5. Sends UID to Pi createPayment API using PI_API_KEY")
    console.log("[v0]   → If Pi rejects: user_not_found = UID is valid but not in PI_API_KEY's app")
    console.log("[v0]")

    const response = await fetch(`${config.appUrl}/api/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        amount, 
        note, 
        merchantId, 
        merchantUid,
        accessToken // Send accessToken for Pi /v2/me verification
      }),
    })

    if (!response.ok) {
      throw new Error(`Failed to create payment: ${response.statusText}`)
    }

    const contentType = response.headers.get("content-type")
    if (!contentType || !contentType.includes("application/json")) {
      const text = await response.text()
      throw new Error(`API returned non-JSON response: ${text.substring(0, 100)}`)
    }

    const result = await response.json()
    // Pass merchantId, merchantAddress, and merchantUid to ensure they match what was created
    const payment = unifiedStore.createPaymentWithId(
      result.payment.id, 
      amount, 
      note, 
      result.payment.createdAt,
      merchantId,           // Pass the EXACT merchantId that was sent to API
      result.payment.merchantAddress || undefined, // Use API response if available
      result.payment.merchantUid || merchantUid,   // Pass merchantUid for A2U transfers
      accessToken           // Pass accessToken for A2U verification at settlement time
    )

    const trackingId = auditLogger.log(
      operation,
      { paymentId: payment.id, merchantId: payment.merchantId, merchantAddress: payment.merchantAddress, amount, noteLength: note.length },
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
    const convertedPayment: Payment = {
      ...payment,
      createdAt: typeof payment.createdAt === "string" ? payment.createdAt : new Date(payment.createdAt).toISOString(),
      paidAt: payment.paidAt ? (typeof payment.paidAt === "string" ? payment.paidAt : new Date(payment.paidAt).toISOString()) : undefined,
      merchantId: payment.merchantId,
      merchantAddress: payment.merchantAddress || "",
      accessToken: payment.accessToken || "",
      id: payment.id,
      amount: payment.amount,
      note: payment.note,
      status: payment.status as any,
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

  if (payment.status === "paid") {
    const trackingId = errorTracker.logError(operation, "Payment already completed", { paymentId })
    CoreLogger.guard("Double payment check", true)
    onError("This payment has already been completed", trackingId)
    return
  }

  CoreLogger.guard("Double payment check", false)
  CoreLogger.info("Starting Pi Wallet payment flow...")

  auditLogger.log(operation, { paymentId, merchantId: payment.merchantId, amount: payment.amount }, "success")

    createPiPayment(
      payment.amount,
      payment.note,
      paymentId,
      payment.merchantId,
      payment.merchantAddress || "",
      payment.merchantUid || "",
      async (txid) => {
        CoreLogger.operation("Payment success callback", { txid })

        const success = unifiedStore.updatePaymentStatus(paymentId, "paid", txid)

        if (success) {
          const trackingId = auditLogger.log(
            "paymentCompleted",
            { paymentId, txid, merchantId: payment.merchantId, amount: payment.amount },
            "success",
          )
          CoreLogger.info("Payment status updated to paid")
          onSuccess(txid)
        } else {
          const trackingId = errorTracker.logError(operation, "Failed to update payment status (race condition)")
          CoreLogger.error("Failed to update payment status (race condition)")
          onError("Payment was already completed by another transaction", trackingId)
        }
      },
      async (error, isCancelled) => {
        const status = isCancelled ? "cancelled" : "failed"
        unifiedStore.updatePaymentStatus(paymentId, status)

        const trackingId = errorTracker.logError(operation, error, { paymentId, merchantId: payment.merchantId, status })
        auditLogger.log(operation, { paymentId, error, status }, "failure")
        CoreLogger.error(`Payment ${status.toLowerCase()}:`, error)
        onError(error, trackingId)
      },
    )
}

export function isPaymentPaid(id: string): boolean {
  const payment = unifiedStore.getPayment(id)
  return payment?.status === "paid"
}

export function canRetryPayment(id: string): boolean {
  const payment = unifiedStore.getPayment(id)
  return payment?.status === "failed" || payment?.status === "cancelled"
}
