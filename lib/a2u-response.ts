import { redis } from "@/lib/redis"
import { isPaymentFinal } from "@/lib/payment-status"

/**
 * Unified payment response shape - used by ALL response paths (processing or final).
 * Re-reads Redis to ensure authoritative data, never trusts HTTP response fields.
 * 
 * Contains all critical fields for transparency. Status determines finality:
 * - status="settled_to_merchant" + success=true: Final success (all reconciliation complete)
 * - status="settlement_pending": Processing (incomplete, client may retry)
 * 
 * FINALITY CONDITIONS (all must be true for final success):
 * - status === "settled_to_merchant"
 * - piCompleted === true
 * - dbRecorded === true
 * - requiresDbReconciliation !== true
 * - piPaymentId exists
 * - a2uPaymentId exists
 * - u2aTxid exists
 * - a2uTxid exists
 */
export interface PaymentResponse {
  success: boolean
  status: string
  paymentId: string
  // Identifiers - only present if checkpoint has them
  piPaymentId?: string
  a2uPaymentId?: string
  u2aTxid?: string
  a2uTxid?: string
  // Addresses - only present after Horizon broadcast
  a2uFromAddress?: string
  a2uToAddress?: string
  // Amounts - only present after amounts confirmed
  customerAmount?: number
  merchantAmount?: number
  horizonFeeCharged?: number
  appCommission?: number
  appNetImpact?: number
  // State flags - always present to show current state
  piCompleted: boolean
  dbRecorded: boolean
}

/**
 * Build unified payment response by re-reading Redis checkpoint.
 * CRITICAL: Always use latest Redis record as sole authority - never trust caller data.
 * 
 * Response contract (FINAL AND BINDING):
 * - FINAL SUCCESS (success=true, status="settled_to_merchant"):
 *   ALL conditions must be true:
 *   * status === "settled_to_merchant"
 *   * piCompleted === true
 *   * dbRecorded === true
 *   * requiresDbReconciliation !== true (must be false or undefined)
 *   * piPaymentId exists
 *   * a2uPaymentId exists
 *   * u2aTxid exists
 *   * a2uTxid exists
 * 
 * - PROCESSING (success=false): For "settlement_pending" and "paid_to_app"
 *   * NEVER return success=true
 *   * PRESERVE all identifiers currently stored
 *   * DO NOT fabricate missing values (return null if critical field missing)
 *   * Allows client polling and server-side recovery
 * 
 * - FAILURE (success=false): For "settlement_failed"
 *   * NEVER return success=true
 *   * PRESERVE all checkpoints (identifiers, timestamps, flags)
 *   * Allows recovery with existing evidence
 * 
 * Idempotency: Repeated requests for same paymentId return identical response
 * from Redis record without re-executing A2U, Horizon, Pi /complete, or DB.
 */
export async function buildA2USuccessResponse(
  paymentId: string
): Promise<PaymentResponse | null> {
  const paymentKey = `payment:${paymentId}`
  const paymentData = await redis.get(paymentKey)

  if (!paymentData) {
    console.error("[A2UResponse] Payment not found in Redis:", paymentId)
    return null
  }

  const payment = typeof paymentData === "string" ? JSON.parse(paymentData) : paymentData

  // CRITICAL: Verify payment record identity
  const recordId = payment.id || payment.paymentId
  if (!recordId) {
    console.error("[A2UResponse] Payment missing both id and paymentId fields")
    return null
  }

  // CRITICAL: Validate status exists and is a known value
  const validStatuses = ["settlement_pending", "paid_to_app", "settlement_failed", "settled_to_merchant"]
  if (!payment.status || typeof payment.status !== "string" || !validStatuses.includes(payment.status)) {
    console.error("[A2UResponse] Missing or invalid status in checkpoint - record corrupted:", {
      status: payment.status,
      paymentId,
    })
    return null
  }

  // CRITICAL: Use single source of truth finality predicate
  const isFinalSuccess = isPaymentFinal(payment)

  // CRITICAL: Processing states (never success, preserve identifiers)
  const isProcessing = payment.status === "settlement_pending" || payment.status === "paid_to_app"

  // CRITICAL: Failure state (preserve all checkpoints for recovery)
  const isFailed = payment.status === "settlement_failed"

  // Build response with ONLY values actually stored in Redis checkpoint
  // Never fabricate missing fields - use optional properties to indicate what exists
  const response: PaymentResponse = {
    success: isFinalSuccess,
    status: payment.status,
    paymentId: recordId,
    // Include identifiers only if they exist in checkpoint (never empty string fallbacks)
    ...(payment.piPaymentId && { piPaymentId: payment.piPaymentId }),
    ...(payment.a2uPaymentId && { a2uPaymentId: payment.a2uPaymentId }),
    ...(payment.u2aTxid && { u2aTxid: payment.u2aTxid }),
    ...(payment.a2uTxid && { a2uTxid: payment.a2uTxid }),
    // Include addresses only if they exist (may be undefined in early processing states)
    ...(payment.a2uFromAddress && { a2uFromAddress: payment.a2uFromAddress }),
    ...(payment.a2uToAddress && { a2uToAddress: payment.a2uToAddress }),
    // Include amounts only if they exist (may be undefined until confirmed)
    ...(payment.customerAmount !== undefined && { customerAmount: payment.customerAmount }),
    ...(payment.merchantAmount !== undefined && { merchantAmount: payment.merchantAmount }),
    ...(payment.horizonFeeCharged !== undefined && { horizonFeeCharged: payment.horizonFeeCharged }),
    ...(payment.appCommission !== undefined && { appCommission: payment.appCommission }),
    ...(payment.appNetImpact !== undefined && { appNetImpact: payment.appNetImpact }),
    // Always expose state of critical flags to show progression
    piCompleted: payment.piCompleted === true,
    dbRecorded: payment.dbRecorded === true,
  }

  console.log("[A2UResponse] Built response:", {
    success: response.success,
    status: response.status,
    isFinalSuccess,
    isProcessing,
    isFailed,
    piCompleted: response.piCompleted,
    dbRecorded: response.dbRecorded,
    requiresDbReconciliation: payment.requiresDbReconciliation,
    identifiers: {
      piPaymentId: !!payment.piPaymentId,
      a2uPaymentId: !!payment.a2uPaymentId,
      u2aTxid: !!payment.u2aTxid,
      a2uTxid: !!payment.a2uTxid,
    },
  })

  return response
}
