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

  if (payment.status !== "pending" && payment.status !== "settlement_failed") {
    const trackingId = errorTracker.logError(operation, "Payment already in progress or completed", { paymentId, status: payment.status })
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
        CoreLogger.operation("U2A callback from Pi Wallet", { txid })

        // CRITICAL FLOW:
        // 1. This callback fires ONLY when Pi Wallet confirms U2A to app is complete
        // 2. Backend /api/pi/complete will be called by Pi with piPaymentId + txid
        // 3. Backend will call /api/pi/a2u to settle to merchant
        // 4. Backend will eventually return settled_to_merchant via polling
        // 5. We ONLY call onSuccess when polling detects settled_to_merchant
        //
        // DO NOT:
        // - Set paid_to_app here (only U2A verified stage before A2U may do this)
        // - Call onSuccess here (must wait for settled_to_merchant confirmation)
        //
        // DO:
        // - Preserve verified U2A identifiers (piPaymentId, u2aTxid)
        // - Clear isPaying to allow polling
        // - Treat paid_to_app/settlement_pending as processing states

        console.log("[v0][PaymentOps] U2A complete - txid:", txid)
        console.log("[v0][PaymentOps] Backend will now handle A2U settlement via polling")
        console.log("[v0][PaymentOps] DO NOT set paid_to_app - let backend do U2A verification")
        console.log("[v0][PaymentOps] onSuccess will be called ONLY when settled_to_merchant is confirmed")

        // DO NOT downgrade from settled_to_merchant
        const currentPayment = unifiedStore.getPayment(paymentId)
        if (currentPayment?.status === "settled_to_merchant") {
          console.log("[v0][PaymentOps] Already settled - no state change needed")
          const trackingId = auditLogger.log(
            "U2ACallbackIdempotent",
            { paymentId, txid, merchantId: payment.merchantId },
            "success",
          )
          return
        }

        // Store U2A txid for polling verification - but do NOT set status here
        const success = unifiedStore.addPaymentIdentifier(paymentId, "u2aTxid", txid)

        if (success) {
          const trackingId = auditLogger.log(
            "U2ATxidStored",
            { paymentId, txid, merchantId: payment.merchantId, amount: payment.amount },
            "success",
          )
          CoreLogger.info("U2A txid stored - awaiting backend settlement confirmation via polling")
          // onSuccess will ONLY be called when polling detects settled_to_merchant from /api/pi/complete
        } else {
          const trackingId = errorTracker.logError(operation, "Failed to store U2A txid")
          CoreLogger.error("Failed to store U2A txid (race condition)")
          // Allow polling to continue - backend will reconcile
        }
      },
      async (error, isCancelled) => {
        const status = isCancelled ? "cancelled" : "failed"
        const prevStatus = unifiedStore.getPayment(paymentId)?.status
        
        // Only set failed for pre-settlement failures
        // settlement_failed is reserved for A2U failure before Horizon
        if (prevStatus && ["pending", "paid_to_app"].includes(prevStatus)) {
          unifiedStore.updatePaymentStatus(paymentId, status)
        }

        const trackingId = errorTracker.logError(operation, error, { paymentId, merchantId: payment.merchantId, status, prevStatus })
        auditLogger.log(operation, { paymentId, error, status }, "failure")
        CoreLogger.error(`Payment ${status.toLowerCase()}:`, error)
        onError(error, trackingId)
      },
    )
}

export function isPaymentPaid(id: string): boolean {
  const payment = unifiedStore.getPayment(id)
  return payment?.status === "settled_to_merchant"
}

export function canRetryPayment(id: string): boolean {
  const payment = unifiedStore.getPayment(id)
  return payment?.status === "settlement_failed" || payment?.status === "cancelled"
}

/**
 * PRECISE RECOVERY ORDERING - Check states in exact order
 * Final success requires: Horizon, Pi /complete, and atomic DB accounting
 * Do NOT mark settled_to_merchant merely because stored IDs were returned
 */
export async function handlePaymentRecovery(
  payment: Payment,
  onSuccess: (txid: string) => void,
  onError: (error: string, trackingId?: string) => void,
): Promise<void> {
  const operation = "handlePaymentRecovery"
  const paymentId = payment.id

  CoreLogger.operation(operation, { paymentId, status: payment.status })

  // 1) settled_to_merchant: Return stored success with NO Pi, Horizon, or DB balance action
  if (payment.status === "settled_to_merchant") {
    console.log("[v0][Recovery] ✅ State 1: settled_to_merchant - returning stored success")
    const txid = payment.txid || (payment as any).u2aTxid || payment.a2uTxid || "unknown"
    auditLogger.log(operation, { paymentId, state: "settled_to_merchant", txid }, "success")
    // Call outer onSuccess - this is the final state
    onSuccess(txid)
    return
  }

  // 2) requiresDbReconciliation with a2uTxid: Run recordA2UTransactionAtomic directly from lib/db.ts
  // using stored trusted values; no A2U or Horizon call
  if (
    (payment as any).requiresDbReconciliation &&
    (payment as any).a2uTxid &&
    (payment as any).horizonSuccessFlag
  ) {
    console.log("[v0][Recovery] 🔄 State 2: requiresDbReconciliation + a2uTxid - DB-only reconciliation")
    const trackingId = auditLogger.log(
      operation,
      { paymentId, state: "requiresDbReconciliation", a2uTxid: (payment as any).a2uTxid },
      "success",
    )

    try {
      // Import recordA2UTransactionAtomic from db.ts
      const { recordA2UTransactionAtomic } = await import("./db")

      // Use stored trusted values - NO new A2U or Horizon calls
      // CRITICAL: Use authoritative financial data from checkpoint, not single amount
      await recordA2UTransactionAtomic({
        u2aIdentifier: (payment as any).u2aIdentifier || "",
        u2aTxid: (payment as any).u2aTxid || "",
        a2uIdentifier: (payment as any).a2uIdentifier || "",
        a2uTxid: (payment as any).a2uTxid,
        merchantId: payment.merchantId,
        merchantUid: payment.merchantUid || "",
        customerAmount: payment.customerAmount || payment.amount,
        merchantAmount: payment.merchantAmount || payment.amount,
        horizonFeeCharged: (payment as any).horizonFeeCharged || 0,
        appCommission: (payment as any).appCommission || 0,
      })

      // Mark as settled
      unifiedStore.updatePaymentStatus(paymentId, "settled_to_merchant", (payment as any).a2uTxid)
      onSuccess((payment as any).a2uTxid)
      return
    } catch (error) {
      const errorTrackingId = errorTracker.logError(operation, String(error), {
        paymentId,
        state: "requiresDbReconciliation",
      })
      CoreLogger.error("DB reconciliation failed:", error)
      onError("Failed to reconcile payment with database", errorTrackingId)
      return
    }
  }

  // 3) settlement_pending with piCompletionPending=true and stored A2U IDs: retry only Pi /complete
  if (
    payment.status === "settlement_pending" &&
    (payment as any).piCompletionPending === true &&
    (payment as any).u2aTxid &&
    (payment as any).a2uTxid
  ) {
    console.log("[v0][Recovery] 🔁 State 3: settlement_pending + piCompletionPending - retry Pi /complete")

    try {
      // Retry ONLY Pi /complete with same identifier and txid - no A2U, no Horizon
      const completeResponse = await fetch("/api/pi/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          piPaymentId: payment.id,
          u2aTxid: (payment as any).u2aTxid,
          a2uTxid: (payment as any).a2uTxid,
          u2aIdentifier: (payment as any).u2aIdentifier,
          a2uIdentifier: (payment as any).a2uIdentifier,
          merchantId: payment.merchantId,
        }),
      })

      if (!completeResponse.ok) {
        const data = await completeResponse.json().catch(() => ({}))
        throw new Error(data.error || "Pi /complete failed")
      }

      const completeData = await completeResponse.json()
      if (completeData.status === "settled_to_merchant") {
        // Mark as settled with final txid
        unifiedStore.updatePaymentStatus(
          paymentId,
          "settled_to_merchant",
          completeData.txid || (payment as any).a2uTxid,
        )
        auditLogger.log(operation, { paymentId, state: "piCompletionRetry_success" }, "success")
        onSuccess(completeData.txid || (payment as any).a2uTxid)
        return
      }

      throw new Error("Pi /complete did not return settled_to_merchant")
    } catch (error) {
      const errorTrackingId = errorTracker.logError(operation, String(error), {
        paymentId,
        state: "piCompletionRetry",
      })
      CoreLogger.error("Pi /complete retry failed:", error)
      onError("Failed to retry payment completion", errorTrackingId)
      return
    }
  }

  // 4) Pi completed but DB pending: perform DB-only reconciliation
  if (
    (payment as any).horizonSuccessFlag === true &&
    (payment as any).a2uTxid &&
    !(payment as any).requiresDbReconciliation
  ) {
    console.log("[v0][Recovery] 📊 State 4: Pi completed but DB pending - DB-only reconciliation")

    try {
      const { recordA2UTransactionAtomic } = await import("./db")
      await recordA2UTransactionAtomic({
        u2aIdentifier: (payment as any).u2aIdentifier || "",
        u2aTxid: (payment as any).u2aTxid || "",
        a2uIdentifier: (payment as any).a2uIdentifier || "",
        a2uTxid: (payment as any).a2uTxid,
        merchantId: payment.merchantId,
        amount: payment.amount,
      })

      unifiedStore.updatePaymentStatus(paymentId, "settled_to_merchant", (payment as any).a2uTxid)
      auditLogger.log(operation, { paymentId, state: "dbReconciliation_success" }, "success")
      onSuccess((payment as any).a2uTxid)
      return
    } catch (error) {
      const errorTrackingId = errorTracker.logError(operation, String(error), {
        paymentId,
        state: "dbReconciliation",
      })
      CoreLogger.error("DB reconciliation failed:", error)
      onError("Failed to reconcile payment", errorTrackingId)
      return
    }
  }

  // 5) settlement_failed: NEVER restart if a2uTxid or horizonSuccessFlag exists
  if (payment.status === "settlement_failed") {
    if ((payment as any).a2uTxid || (payment as any).horizonSuccessFlag) {
      console.log("[v0][Recovery] ❌ State 5: settlement_failed with a2uTxid or horizonSuccessFlag - no recovery")
      const errorTrackingId = errorTracker.logError(operation, "Irreversible settlement failure", {
        paymentId,
        hasA2uTxid: !!(payment as any).a2uTxid,
        hasHorizonFlag: !!(payment as any).horizonSuccessFlag,
      })
      onError("This payment encountered an irreversible error. Please contact support.", errorTrackingId)
      return
    }
    // If no identifiers, may retry
    console.log("[v0][Recovery] 🔄 State 5: settlement_failed - retry eligible (no identifiers)")
    onError("Payment failed. Please try again.", undefined)
    return
  }

  // Default: No recovery path
  console.log("[v0][Recovery] ⚠️ No recovery path matched for status:", payment.status)
  onError(
    "Unable to determine recovery action for this payment state. Please contact support.",
    undefined,
  )
}
