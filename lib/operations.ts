"use client"

import { unifiedStore } from "./unified-store"
import { createPiPayment, authenticateMerchant } from "./pi-sdk"
import type { Payment } from "./types"
import { CoreLogger } from "./core"
import { SecurityGuard, InputValidator, rateLimiter, errorTracker, auditLogger } from "./security"
import { config } from "./config"
import { isProcessingStatus, isTerminalState } from "./payment-status"
import { getRetryDecision, shouldSuppressErrorCallback } from "./retry-decision"

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

    // CRITICAL: Send amount, note, and accessToken for server verification.
    // Do NOT send merchantId or merchantUid - server will verify from /v2/me call.
    // The server will call Pi /v2/me with the accessToken to derive verified username and UID.
    const response = await fetch(`${config.appUrl}/api/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        amount, 
        note,
        accessToken
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
    // CRITICAL: Use VERIFIED merchantId and merchantUid from server response, not client values
    // The server verified the identity via Pi /v2/me and derived the authoritative username and UID
    const payment = unifiedStore.createPaymentWithId(
      result.payment.id, 
      amount, 
      note, 
      result.payment.createdAt,
      result.payment.merchantId,           // VERIFIED by server via /v2/me
      result.payment.merchantAddress || undefined,
      result.payment.merchantUid,          // VERIFIED by server via /v2/me, no fallback
      accessToken           // Store accessToken for A2U verification at settlement time
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
        // 1. Pi Wallet callback fires when U2A to app is complete
        // 2. /api/pi/complete endpoint processes settlement (may take time)
        // 3. /api/pi/complete returns status: paid_to_app, settlement_pending, or settled_to_merchant
        // 4. Processing states (paid_to_app, settlement_pending) do NOT trigger callback
        // 5. ONLY settled_to_merchant status triggers onSuccess
        // 6. onSuccess called exactly once with verified U2A txid + settledAt timestamp
        //
        // DO:
        // - Store verified U2A identifiers (piPaymentId, u2aTxid, a2uTxid if present)
        // - Preserve settlement timestamps and status flags
        // - Call onSuccess only after Pi /complete confirms settled_to_merchant
        // - Call onSuccess exactly once with final txid
        //
        // DO NOT:
        // - Call onSuccess for paid_to_app or settlement_pending (processing states)
        // - Downgrade from settled_to_merchant
        // - Restart createPiPayment for settlement_failed with a2uTxid

        console.log("[v0][PaymentOps] U2A callback fired - txid from Pi Wallet:", txid)

        // DO NOT downgrade from settled_to_merchant
        const currentPayment = unifiedStore.getPayment(paymentId)
        if (currentPayment?.status === "settled_to_merchant") {
          console.log("[v0][PaymentOps] Already in settled_to_merchant - returning stored success")
          auditLogger.log(
            "U2ACallbackAlreadySettled",
            { paymentId, txid, merchantId: payment.merchantId },
            "success",
          )
          // Call onSuccess exactly once with the U2A txid
          onSuccess(txid)
          return
        }

        // Store U2A txid and set to settled_to_merchant - this is the final success state after Pi /complete
        // Set settledAt timestamp for accounting precision
        const settledAt = new Date().toISOString()
        const success = unifiedStore.updatePaymentStatus(paymentId, "settled_to_merchant", txid)

        if (success) {
          const trackingId = auditLogger.log(
            "U2ACallbackSuccess",
            { paymentId, txid, merchantId: payment.merchantId, u2aTxid: txid, settledAt },
            "success",
          )
          CoreLogger.info("U2A callback: payment settled to merchant - calling final onSuccess exactly once")
          // Pi /complete confirmed settled_to_merchant - this is the final success state
          // Call onSuccess exactly once with verified U2A txid
          onSuccess(txid)
        } else {
          const trackingId = errorTracker.logError(operation, "Failed to update payment status to settled_to_merchant")
          CoreLogger.error("Failed to mark payment as settled_to_merchant")
          onError("Payment settlement failed", trackingId)
        }
      },
      async (error, isCancelled) => {
        const status = isCancelled ? "cancelled" : "failed"
        const currentPayment = unifiedStore.getPayment(paymentId)
        const prevStatus = currentPayment?.status
        
        // CRITICAL: Use authoritative retry decision function
        const decision = getRetryDecision(currentPayment || { status: prevStatus } as Payment)
        
        // If callback should be suppressed (processing or terminal), do NOT call onError
        if (currentPayment && shouldSuppressErrorCallback(currentPayment)) {
          console.log("[v0][PaymentOps] Suppressing error callback - payment is in", prevStatus)
          console.log("[v0][PaymentOps] Recovery routing:", decision.routeToServerRecovery ? "SERVER" : "CLIENT")
          // Let polling/recovery continue without showing error to user
          return
        }
        
        // Only set failed status for pre-settlement failures
        // settlement_failed with terminal flags stays blocked
        if (prevStatus && ["pending", "failed", "cancelled"].includes(prevStatus)) {
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

/**
 * UNIFIED AUTHORITATIVE RETRY DECISION
 * All client retry logic flows through getRetryDecision
 */
export function canRetryPayment(id: string): boolean {
  const payment = unifiedStore.getPayment(id)
  
  if (!payment) {
    return false
  }
  
  // Use authoritative retry decision function
  const decision = getRetryDecision(payment)
  
  if (!decision.canRetry) {
    if (decision.routeToServerRecovery) {
      CoreLogger.guard("Blocked retry - requires server recovery", true)
      console.log("[v0] canRetryPayment: Blocking retry -", decision.reason)
    }
  }
  
  return decision.canRetry
}

/**
 * PRECISE RECOVERY ORDERING - Check states in exact order
 * Final success requires: Horizon, Pi /complete, and atomic DB accounting
 * 
 * CRITICAL ROUTING:
 * - settled_to_merchant: Return stored success (no action)
 * - paid_to_app, settlement_pending: Poll for /complete
 * - settlement_failed WITHOUT terminal flags: Client can retry
 * - settlement_failed WITH a2uTxid or horizonSuccessFlag: ROUTE TO SERVER RECOVERY
 */
export async function handlePaymentRecovery(
  payment: Payment,
  onSuccess: (txid: string) => void,
  onError: (error: string, trackingId?: string) => void,
): Promise<void> {
  const operation = "handlePaymentRecovery"
  const paymentId = payment.id

  CoreLogger.operation(operation, { paymentId, status: payment.status })

  // Use authoritative retry decision
  const decision = getRetryDecision(payment)
  
  // If terminal state with blockchain involvement, route to server recovery (not client retry)
  if (decision.routeToServerRecovery) {
    console.log("[v0][Recovery] Terminal state detected - routing to server recovery endpoint")
    console.log("[v0][Recovery] Reason:", decision.reason)
    onError("This payment requires server-side recovery. Please contact support.", undefined)
    return
  }

  // 1) settled_to_merchant: Return stored success with NO Pi, Horizon, or DB balance action
  if (payment.status === "settled_to_merchant") {
    console.log("[v0][Recovery] ✅ State 1: settled_to_merchant - returning stored success")
    const txid = payment.txid || (payment as any).u2aTxid || payment.a2uTxid || "unknown"
    auditLogger.log(operation, { paymentId, state: "settled_to_merchant", txid }, "success")
    // Call outer onSuccess - this is the final state
    onSuccess(txid)
    return
  }

  // 2) requiresDbReconciliation with a2uTxid: This is a terminal state
  // Requires server-side recovery via internal endpoint only - client cannot recover
  if (
    (payment as any).requiresDbReconciliation &&
    (payment as any).a2uTxid &&
    (payment as any).horizonSuccessFlag
  ) {
    console.log("[v0][Recovery] 🔄 State 2: requiresDbReconciliation + a2uTxid - server recovery required")
    const trackingId = auditLogger.log(
      operation,
      { paymentId, state: "requiresDbReconciliation", message: "Server recovery required" },
      "pending",
    )

    // CRITICAL: State 2 requires server-side DB reconciliation
    // Client cannot call internal endpoints - this must be handled by server-only code
    // Return status to UI indicating recovery is in progress
    const errorTrackingId = errorTracker.logError(
      operation,
      "Payment requires server-side DB reconciliation - not eligible for client recovery",
      { paymentId, state: "requiresDbReconciliation" }
    )
    CoreLogger.error("Payment in terminal state requiring server recovery - blocking client recovery")
    onError("Payment recovery in progress on server. Please wait or contact support if this persists.", errorTrackingId)

    return
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

  // 4) Pi completed but DB pending: This is a terminal state
  // Requires server-side DB reconciliation via internal endpoint only - client cannot recover
  if (
    (payment as any).horizonSuccessFlag === true &&
    (payment as any).a2uTxid &&
    !(payment as any).requiresDbReconciliation
  ) {
    console.log("[v0][Recovery] 📊 State 4: Pi completed but DB pending - server recovery required")
    const trackingId = auditLogger.log(
      operation,
      { paymentId, state: "piCompletedDbPending", message: "Server recovery required" },
      "pending",
    )

    // CRITICAL: State 4 requires server-side DB reconciliation
    // Client cannot call internal endpoints - this must be handled by server-only code
    // Return status to UI indicating recovery is in progress
    const errorTrackingId = errorTracker.logError(
      operation,
      "Payment requires server-side DB reconciliation - not eligible for client recovery",
      { paymentId, state: "piCompletedDbPending" }
    )
    CoreLogger.error("Payment in state requiring server recovery - blocking client recovery")
    onError("Payment recovery in progress on server. Please wait or contact support if this persists.", errorTrackingId)
    return
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
