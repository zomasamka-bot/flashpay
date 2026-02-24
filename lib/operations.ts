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

// Use window.location.origin for browser requests, or fallback to Vercel URL
const API_BASE_URL = typeof window !== "undefined" 
  ? window.location.origin 
  : (process.env.NEXT_PUBLIC_APP_URL || "https://flashpay-two.vercel.app")

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
      
      // CRITICAL: Also store in localStorage for Preview environments without KV
      // This allows payment to be retrieved even if customer hits different instance
      if (typeof window !== "undefined") {
        try {
          const paymentCache = {
            id: payment.id,
            amount: payment.amount,
            note: payment.note,
            status: payment.status,
            createdAt: payment.createdAt.toISOString(),
            merchantId: payment.merchantId,
          }
          localStorage.setItem(`flashpay_payment_${payment.id}`, JSON.stringify(paymentCache))
          console.log("[v0] Payment cached in localStorage for cross-instance access")
        } catch (e) {
          console.warn("[v0] Could not cache payment in localStorage:", e)
        }
      }

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
  console.log("[v0] ========== getPaymentFromServer START ==========")
  console.log("[v0] Looking for payment ID:", id)
  console.log("[v0] API_BASE_URL:", API_BASE_URL)
  console.log("[v0] window.location.origin:", typeof window !== "undefined" ? window.location.origin : "N/A")
  
  try {
    // First check unified store (in-memory)
    const localPayment = unifiedStore.getPayment(id)
    if (localPayment) {
      console.log("[v0] ✅ Payment found in unified store:", id)
      console.log("[v0] Payment data:", localPayment)
      return localPayment
    }
    
    // Check localStorage cache (for Preview environments without KV)
    if (typeof window !== "undefined") {
      try {
        const cached = localStorage.getItem(`flashpay_payment_${id}`)
        if (cached) {
          console.log("[v0] ✅ Payment found in localStorage cache")
          const paymentData = JSON.parse(cached)
          const cachedPayment: Payment = {
            ...paymentData,
            createdAt: new Date(paymentData.createdAt),
            paidAt: paymentData.paidAt ? new Date(paymentData.paidAt) : undefined,
          }
          // Store in unified store for future access
          unifiedStore.addPayment(cachedPayment)
          console.log("[v0] Payment restored from localStorage and added to unified store")
          return cachedPayment
        }
      } catch (e) {
        console.warn("[v0] Could not read from localStorage:", e)
      }
    }

    // If not in local storage, try fetching from server
    console.log("[v0] Payment NOT in local storage, fetching from server...")
    const apiUrl = `${API_BASE_URL}/api/payments/${id}`
    console.log("[v0] Full API URL:", apiUrl)
    console.log("[v0] Making fetch request NOW...")
    
    const response = await fetch(apiUrl)
    console.log("[v0] Fetch response received")
    console.log("[v0] Response status:", response.status)
    console.log("[v0] Response statusText:", response.statusText)
    console.log("[v0] Response headers:", Object.fromEntries(response.headers.entries()))

    if (!response.ok) {
      console.error("[v0] ❌ Server fetch failed")
      console.error("[v0] Status:", response.status)
      console.error("[v0] Status text:", response.statusText)
      
      // Try to read the error response body
      try {
        const errorText = await response.text()
        console.error("[v0] Error response body:", errorText)
      } catch (e) {
        console.error("[v0] Could not read error response body")
      }
      
      return null
    }

    console.log("[v0] Response OK, checking content type...")
    // Check if response is JSON before parsing
    const contentType = response.headers.get("content-type")
    console.log("[v0] Content-Type:", contentType)
    
    if (!contentType || !contentType.includes("application/json")) {
      console.error("[v0] ❌ Response is not JSON!")
      const text = await response.text()
      console.error("[v0] Response body (first 200 chars):", text.substring(0, 200))
      return null
    }

    console.log("[v0] Parsing JSON response...")
    const data = await response.json()
    console.log("[v0] Parsed data:", data)
    console.log("[v0] data.success:", data.success)
    console.log("[v0] data.payment exists:", !!data.payment)
    
    if (!data.success || !data.payment) {
      console.error("[v0] ❌ Invalid server response structure")
      console.error("[v0] Full data:", JSON.stringify(data))
      return null
    }
    
    console.log("[v0] ✅ Valid payment data received from server")

    // Convert date strings back to Date objects
    const payment = data.payment
    console.log("[v0] Converting payment dates...")
    const convertedPayment = {
      ...payment,
      createdAt: new Date(payment.createdAt),
      paidAt: payment.paidAt ? new Date(payment.paidAt) : undefined,
    }

    console.log("[v0] Storing payment in local cache...")
    // Store in local cache
    unifiedStore.addPayment(convertedPayment)
    console.log("[v0] ✅ Payment stored in local cache")

    console.log("[v0] ========== getPaymentFromServer SUCCESS ==========")
    return convertedPayment
  } catch (error) {
    console.error("[v0] ========== getPaymentFromServer ERROR ==========")
    console.error("[v0] Exception occurred:", error)
    console.error("[v0] Error type:", error instanceof Error ? error.constructor.name : typeof error)
    console.error("[v0] Error message:", error instanceof Error ? error.message : String(error))
    console.error("[v0] Error stack:", error instanceof Error ? error.stack : "N/A")
    
    // Return local payment as fallback
    console.log("[v0] Checking local cache as fallback...")
    const fallback = unifiedStore.getPayment(id) || null
    console.log("[v0] Fallback result:", fallback ? "Found in cache" : "Not found")
    return fallback
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
