import { redis } from "@/lib/redis"
import { recordA2UTransactionAtomic } from "@/lib/db"
import { validateFinancialData } from "@/lib/financial-validation"
import { buildA2USuccessResponse } from "@/lib/a2u-response"
import type { ExecutorContext } from "@/lib/a2u-executor"

/**
 * AUTHORITATIVE A2U RECOVERY SERVICE
 * 
 * PRECISE RECOVERY STATES IN EXACT ORDER:
 * 1. settled_to_merchant           - return stored success only
 * 2. requiresDbReconciliation      - DB-only recovery with a2uTxid
 * 3. settlement_pending            - retry only Pi A2U /complete (handler only)
 * 4. piCompleted + DB pending      - DB-only recovery with a2uTxid
 * 5. settlement_failed             - never restart Horizon if a2uTxid exists
 * 
 * DB RECONCILIATION ORDER: Always check requiresDbReconciliation BEFORE generic settlement_pending
 * 
 * NAMING CONVENTION:
 * - a2uToAddress: Horizon destination address for A2U operation
 * - u2aTxid: Pi to Horizon txid (lowercase d always)
 * - a2uTxid: Horizon to Pi txid (lowercase d always)
 */

interface PaymentState {
  paymentId: string
  status: string
  u2aTxid?: string
  a2uPaymentId?: string
  a2uTxid?: string
  a2uFromAddress?: string
  a2uToAddress?: string
  customerAmount?: number
  merchantAmount?: number
  horizonFeeCharged?: number
  appCommission?: number
  u2aIdentifier?: string
  a2uIdentifier?: string
  merchantId?: string
  merchantUid?: string
  requiresDbReconciliation?: boolean
  horizonSuccessFlag?: boolean
  piCompletionPending?: boolean
  piCompleted?: boolean
}

interface RecoveryResult {
  status: "success" | "db_reconciled" | "manual_review_required" | "pending_pi_complete" | "irreversible"
  state: string
  paymentId: string
  details: {
    u2aTxid?: string
    a2uTxid?: string
    dbTransactionId?: string
    error?: string
  }
}

/**
 * AUTHORITATIVE recovery orchestrator - single source of truth for all recovery states
 * Implements exact state ordering with DB reconciliation before settlement_pending
 */
export async function executeA2URecovery(paymentId: string): Promise<RecoveryResult> {
  console.log("[A2U Recovery] Starting recovery for payment:", paymentId)

  // Load payment state from authoritative Redis
  const paymentKey = `payment:${paymentId}`
  const paymentData = await redis.get(paymentKey)

  if (!paymentData) {
    return {
      status: "manual_review_required",
      state: "payment_not_found",
      paymentId,
      details: { error: "Payment not found in Redis" },
    }
  }

  const payment: PaymentState = typeof paymentData === "string" ? JSON.parse(paymentData) : paymentData

  console.log("[A2U Recovery] Payment status:", payment.status)
  console.log("[A2U Recovery] Flags:", {
    requiresDbReconciliation: payment.requiresDbReconciliation,
    horizonSuccessFlag: payment.horizonSuccessFlag,
    piCompletionPending: payment.piCompletionPending,
    piCompleted: payment.piCompleted,
    a2uTxid: payment.a2uTxid ? "present" : "missing",
  })

  // STATE 1: settled_to_merchant - already complete, return success
  if (payment.status === "settled_to_merchant") {
    console.log("[A2U Recovery] ✅ State 1: settled_to_merchant - no recovery needed")
    return {
      status: "success",
      state: "already_settled",
      paymentId,
      details: {
        u2aTxid: payment.u2aTxid,
        a2uTxid: payment.a2uTxid,
      },
    }
  }

  // STATE 2: requiresDbReconciliation + a2uTxid - DB-only recovery (BEFORE settlement_pending)
  if (payment.requiresDbReconciliation && payment.a2uTxid && payment.horizonSuccessFlag) {
    console.log("[A2U Recovery] 🔄 State 2: requiresDbReconciliation - performing DB-only reconciliation")
    return await reconcileA2UInDatabase(payment, paymentId)
  }

  // STATE 3: settlement_pending + piCompletionPending + a2uTxid
  // Delegated to unified executor which will handle Pi /complete + DB reconciliation
  if (payment.status === "settlement_pending" && payment.piCompletionPending && payment.a2uTxid && payment.a2uPaymentId) {
    console.log("[A2U Recovery] 🔁 State 3: settlement_pending + piCompletionPending - delegating to unified executor")
    
    // Use unified executor to complete Pi and reconcile DB
    const { executeA2U } = await import("@/lib/a2u-executor")
    const executorResult = await executeA2U({
      paymentId,
      payment,
      merchantUid: payment.merchantUid,
      accessToken: payment.accessToken,
      amount: payment.customerAmount || payment.amount,
      piPaymentId: payment.piPaymentId,
      isRecovery: true,
    })

    if (!executorResult.success) {
      return {
        status: "manual_review_required",
        state: "executor_failed_state3",
        paymentId,
        details: { error: executorResult.error },
      }
    }

    // Canonical response
    const canonicalResponse = await buildA2USuccessResponse(paymentId)
    if (!canonicalResponse) {
      return {
        status: "manual_review_required",
        state: "response_building_failed",
        paymentId,
        details: { error: "Response building failed" },
      }
    }

    return {
      status: "db_reconciled",
      state: "settled_to_merchant",
      paymentId,
      details: {
        u2aTxid: payment.u2aTxid,
        a2uTxid: executorResult.txidFromHorizon,
      },
    }
  }

  // STATE 4: piCompleted + DB pending (no requiresDbReconciliation flag yet) - DB-only recovery
  if (payment.piCompleted && !payment.requiresDbReconciliation && payment.a2uTxid && payment.horizonSuccessFlag) {
    console.log("[A2U Recovery] 📊 State 4: piCompleted + DB pending - performing DB-only reconciliation")
    return await reconcileA2UInDatabase(payment, paymentId)
  }

  // STATE 5: settlement_failed - check for irreversibility
  if (payment.status === "settlement_failed") {
    // CRITICAL: If a2uTxid or horizonSuccessFlag exists, never restart Horizon
    if (payment.a2uTxid || payment.horizonSuccessFlag) {
      console.log("[A2U Recovery] ❌ State 5: settlement_failed with identifiers - irreversible")
      return {
        status: "irreversible",
        state: "irreversible_failure",
        paymentId,
        details: {
          error: "Irreversible settlement failure - contact support",
          a2uTxid: payment.a2uTxid,
        },
      }
    }
    // No identifiers = safe to retry
    console.log("[A2U Recovery] 🔄 State 5: settlement_failed - safe to retry")
    return {
      status: "pending_pi_complete",
      state: "failure_safe_to_retry",
      paymentId,
      details: {},
    }
  }

  // No recovery path matched
  console.log("[A2U Recovery] ⚠️ No recovery path matched for status:", payment.status)
  return {
    status: "manual_review_required",
    state: "no_recovery_path",
    paymentId,
    details: { error: `Unable to determine recovery action for status: ${payment.status}` },
  }
}

/**
 * STATE 3: Delegated to unified executor
 * NOTE: completePiA2UAndReconcile removed - use executeA2U from lib/a2u-executor.ts instead
 */

/**
 * DB-ONLY RECONCILIATION: Record A2U transaction atomically using Redis as source of truth
 * Used by State 2 (requiresDbReconciliation), State 3 (after Pi /complete), and State 4 (piCompleted + DB pending)
 */
async function reconcileA2UInDatabase(payment: PaymentState, paymentId: string): Promise<RecoveryResult> {
  console.log("[A2U Recovery] Reconciling A2U transaction in database...")

  // STRICT: Validate ALL financial data before DB operation - NO FALLBACKS
  const validation = validateFinancialData(payment)
  if (!validation.success) {
    console.error("[A2U Recovery] ❌ Financial validation failed:", validation.error)
    return {
      status: "manual_review_required",
      state: "validation_failed",
      paymentId,
      details: { error: validation.error },
    }
  }

  const financialData = validation.data

  // CRITICAL VALIDATION: All required identifiers and financial data must exist before DB write
  if (!payment.piPaymentId) {
    console.error("[A2U Recovery] ❌ AUDIT FAILURE: Missing piPaymentId (u2aIdentifier)")
    return { status: "irreversible", state: "missing_piPaymentId", paymentId, details: { error: "Missing piPaymentId - cannot proceed to DB" } }
  }
  if (!payment.a2uPaymentId) {
    console.error("[A2U Recovery] ❌ AUDIT FAILURE: Missing a2uPaymentId (a2uIdentifier)")
    return { status: "irreversible", state: "missing_a2uPaymentId", paymentId, details: { error: "Missing a2uPaymentId - cannot proceed to DB" } }
  }
  if (!financialData.u2aTxid) {
    console.error("[A2U Recovery] ❌ AUDIT FAILURE: Missing u2aTxid")
    return { status: "irreversible", state: "missing_u2aTxid", paymentId, details: { error: "Missing u2aTxid - cannot proceed to DB" } }
  }
  if (!financialData.a2uTxid) {
    console.error("[A2U Recovery] ❌ AUDIT FAILURE: Missing a2uTxid")
    return { status: "irreversible", state: "missing_a2uTxid", paymentId, details: { error: "Missing a2uTxid - cannot proceed to DB" } }
  }
  if (!financialData.merchantId) {
    console.error("[A2U Recovery] ❌ AUDIT FAILURE: Missing merchantId")
    return { status: "irreversible", state: "missing_merchantId", paymentId, details: { error: "Missing merchantId - cannot proceed to DB" } }
  }
  if (!financialData.merchantUid) {
    console.error("[A2U Recovery] ❌ AUDIT FAILURE: Missing merchantUid")
    return { status: "irreversible", state: "missing_merchantUid", paymentId, details: { error: "Missing merchantUid - cannot proceed to DB" } }
  }
  if (typeof financialData.customerAmount !== "number") {
    console.error("[A2U Recovery] ❌ AUDIT FAILURE: Invalid customerAmount:", financialData.customerAmount)
    return { status: "irreversible", state: "invalid_customerAmount", paymentId, details: { error: "Invalid customerAmount - cannot proceed to DB" } }
  }
  if (typeof financialData.merchantAmount !== "number") {
    console.error("[A2U Recovery] ❌ AUDIT FAILURE: Invalid merchantAmount:", financialData.merchantAmount)
    return { status: "irreversible", state: "invalid_merchantAmount", paymentId, details: { error: "Invalid merchantAmount - cannot proceed to DB" } }
  }
  if (typeof financialData.horizonFeeCharged !== "number") {
    console.error("[A2U Recovery] ❌ AUDIT FAILURE: Invalid horizonFeeCharged:", financialData.horizonFeeCharged)
    return { status: "irreversible", state: "invalid_horizonFeeCharged", paymentId, details: { error: "Invalid horizonFeeCharged - cannot proceed to DB" } }
  }

  try {
    // Call recordA2UTransactionAtomic with VALIDATED, authoritative financial data from Redis
    const dbResult = await recordA2UTransactionAtomic({
      u2aIdentifier: payment.piPaymentId,        // AUDIT: Only use piPaymentId, no fallback
      u2aTxid: financialData.u2aTxid,            // AUDIT: Validated above
      a2uIdentifier: payment.a2uPaymentId,       // AUDIT: Only use a2uPaymentId, no fallback
      a2uTxid: financialData.a2uTxid,            // AUDIT: Validated above
      merchantId: financialData.merchantId,      // AUDIT: Validated above
      merchantUid: financialData.merchantUid,    // AUDIT: Validated above
      customerAmount: financialData.customerAmount,    // AUDIT: Validated above
      merchantAmount: financialData.merchantAmount,    // AUDIT: Validated above
      horizonFeeCharged: financialData.horizonFeeCharged,  // AUDIT: Validated above, no fallback
      appCommission: financialData.appCommission,       // Optional, may be undefined
    })

    // CRITICAL: Check dbResult.success === true BEFORE marking settled_to_merchant
    if (!dbResult || !dbResult.success) {
      console.error("[A2U Recovery] ❌ DB reconciliation returned success=false:", dbResult?.error)

      // For State 2: Keep requiresDbReconciliation flag
      // For State 4: Set requiresDbReconciliation flag so next attempt retries DB
      const updatedPayment = {
        ...payment,
        requiresDbReconciliation: true,
        dbRecorded: false, // CRITICAL: DB failed - mark as not recorded
      }
      await redis.set(`payment:${paymentId}`, JSON.stringify(updatedPayment))

      return {
        status: "manual_review_required",
        state: "db_reconciliation_failed",
        paymentId,
        details: { error: dbResult?.error || "Unknown DB error" },
      }
    }

    // DB SUCCESSFUL: Mark payment as settled
    const updatedPayment = {
      ...payment,
      status: "settled_to_merchant",
      requiresDbReconciliation: false,
      piCompleted: true,
      dbRecorded: true, // CRITICAL: Set ONLY after DB commit succeeds
      settlementCompletedAt: new Date().toISOString(),
    }

    await redis.set(`payment:${paymentId}`, JSON.stringify(updatedPayment))
    console.log("[A2U Recovery] ✅ DB reconciliation completed successfully with txid:", dbResult.transactionId)

    // Return canonical response from authoritative Redis checkpoint
    const canonicalResponse = await buildA2USuccessResponse(paymentId)
    if (!canonicalResponse) {
      console.error("[A2U Recovery] ❌ Failed to build canonical response for settled payment")
      return {
        status: "manual_review_required",
        state: "response_building_failed",
        paymentId,
        details: { error: "Response building failed - data corruption detected" },
      }
    }

    return {
      status: "db_reconciled",
      state: "settled_to_merchant",
      paymentId,
      details: {
        u2aTxid: payment.u2aTxid,
        a2uTxid: payment.a2uTxid,
        dbTransactionId: dbResult.transactionId,
      },
    }
  } catch (dbError) {
    console.error("[A2U Recovery] ❌ DB reconciliation threw error:", dbError)

    // Mark as requiring reconciliation so next attempt retries DB operation
    const updatedPayment = {
      ...payment,
      requiresDbReconciliation: true,
      dbRecorded: false, // CRITICAL: DB threw error - mark as not recorded
    }
    await redis.set(`payment:${paymentId}`, JSON.stringify(updatedPayment))

    return {
      status: "manual_review_required",
      state: "db_reconciliation_error",
      paymentId,
      details: { error: String(dbError) },
    }
  }
}

/**
 * Check if a payment is in a recoverable state
 */
export function isPaymentRecoverable(payment: PaymentState): boolean {
  // Only specific states can be recovered
  const recoverableStates = [
    "settled_to_merchant",
    "settlement_pending",
    "settlement_failed",
  ]

  if (!recoverableStates.includes(payment.status)) {
    return false
  }

  // settlement_failed is only recoverable if no identifiers exist
  if (payment.status === "settlement_failed" && (payment.a2uTxid || payment.horizonSuccessFlag)) {
    return false
  }

  return true
}

/**
 * Extract recovery hints from payment state for logging/diagnostics
 */
export function getRecoveryHints(payment: PaymentState): Record<string, unknown> {
  return {
    status: payment.status,
    hasA2UTxid: !!payment.a2uTxid,
    hasU2ATxid: !!payment.u2aTxid,
    requiresDbReconciliation: payment.requiresDbReconciliation,
    horizonSuccessFlag: payment.horizonSuccessFlag,
    piCompletionPending: payment.piCompletionPending,
    piCompleted: payment.piCompleted,
    isRecoverable: isPaymentRecoverable(payment),
  }
}
