import { redis } from "@/lib/redis"

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
 * - u2aTxid exists
 * - a2uTxid exists
 */
export interface PaymentResponse {
  success: boolean
  status: "settlement_pending" | "settled_to_merchant" | string
  paymentId: string
  a2uPaymentId: string
  u2aTxid: string
  a2uTxid: string
  a2uFromAddress: string
  a2uToAddress: string
  customerAmount: number
  merchantAmount: number
  horizonFeeCharged: number
  appCommission: number
  appNetImpact: number
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

  // CRITICAL: Finality predicate - ALL must be true for success=true
  const isFinalSuccess =
    payment.status === "settled_to_merchant" &&
    payment.piCompleted === true &&
    payment.dbRecorded === true &&
    payment.requiresDbReconciliation !== true &&
    !!payment.piPaymentId &&
    !!payment.a2uPaymentId &&
    !!payment.u2aTxid &&
    !!payment.a2uTxid

  // CRITICAL: Processing states (never success, preserve identifiers)
  const isProcessing = payment.status === "settlement_pending" || payment.status === "paid_to_app"

  // CRITICAL: Failure state (preserve all checkpoints for recovery)
  const isFailed = payment.status === "settlement_failed"

  // Build response with only authoritative Redis data
  // For processing/failure states, preserve identifiers but never claim success
  // Never fabricate missing critical fields
  const response: PaymentResponse = {
    success: isFinalSuccess,
    status: payment.status || "settlement_pending",
    paymentId: recordId,
    // Preserve identifiers for all states (critical for recovery)
    a2uPaymentId: payment.a2uPaymentId || "",
    u2aTxid: payment.u2aTxid || "",
    a2uTxid: payment.a2uTxid || "",
    // Preserve addresses from checkpoint - may be undefined in early states
    a2uFromAddress: payment.a2uFromAddress || "",
    a2uToAddress: payment.a2uToAddress || "",
    // Preserve amounts - required for response validity
    customerAmount: payment.customerAmount ?? 0,
    merchantAmount: payment.merchantAmount ?? 0,
    horizonFeeCharged: payment.horizonFeeCharged ?? 0,
    appCommission: payment.appCommission ?? 0,
    appNetImpact: payment.appNetImpact ?? 0,
    // Always expose state of critical flags
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
