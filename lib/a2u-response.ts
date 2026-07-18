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
 * Never use internal HTTP response fields; always trust the persistent Redis record.
 * 
 * Response validity rules (CRITICAL):
 * - FINAL SUCCESS (success=true, status="settled_to_merchant"): ONLY when ALL true:
 *   * status === "settled_to_merchant"
 *   * piCompleted === true
 *   * dbRecorded === true
 *   * requiresDbReconciliation !== true (must be false or undefined)
 *   * u2aTxid exists
 *   * a2uTxid exists
 * - PROCESSING (success=false, status="settlement_pending"): Processing, never final
 * - Other statuses: Return authoritative state without claiming success
 * 
 * This ensures consistency across:
 * - Initial approval (new payment)
 * - Pi /complete flow (settlement)
 * - Recovery flows (idempotent retry)
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

  // CRITICAL: Verify payment uses correct field name (payment.id, not paymentId)
  const recordId = payment.id || payment.paymentId
  if (!recordId) {
    console.error("[A2UResponse] Payment missing both id and paymentId fields")
    return null
  }

  // CRITICAL: All these fields must exist in the checkpoint
  if (
    !payment.a2uPaymentId ||
    !payment.a2uTxid ||
    !payment.u2aTxid ||
    !payment.a2uFromAddress ||
    !payment.a2uToAddress ||
    payment.customerAmount === undefined ||
    payment.merchantAmount === undefined ||
    payment.horizonFeeCharged === undefined ||
    payment.appCommission === undefined ||
    payment.appNetImpact === undefined
  ) {
    console.error("[A2UResponse] Missing required fields in Redis checkpoint:", {
      a2uPaymentId: payment.a2uPaymentId,
      a2uTxid: payment.a2uTxid,
      u2aTxid: payment.u2aTxid,
      a2uFromAddress: payment.a2uFromAddress,
      a2uToAddress: payment.a2uToAddress,
      customerAmount: payment.customerAmount,
      merchantAmount: payment.merchantAmount,
      horizonFeeCharged: payment.horizonFeeCharged,
      appCommission: payment.appCommission,
      appNetImpact: payment.appNetImpact,
    })
    return null
  }

  // CRITICAL: Determine response finality based on PRECISE conditions
  const isFinalSuccess =
    payment.status === "settled_to_merchant" &&
    payment.piCompleted === true &&
    payment.dbRecorded === true &&
    payment.requiresDbReconciliation !== true &&
    !!payment.u2aTxid &&
    !!payment.a2uTxid

  // CRITICAL: settlement_pending NEVER returns success=true, even if other fields exist
  const isProcessing = payment.status === "settlement_pending"

  // Build unified response from authoritative Redis checkpoint
  const response: PaymentResponse = {
    success: isFinalSuccess,
    status: payment.status || "settlement_pending",
    paymentId: recordId,
    a2uPaymentId: payment.a2uPaymentId,
    u2aTxid: payment.u2aTxid,
    a2uTxid: payment.a2uTxid,
    a2uFromAddress: payment.a2uFromAddress,
    a2uToAddress: payment.a2uToAddress,
    customerAmount: payment.customerAmount,
    merchantAmount: payment.merchantAmount,
    horizonFeeCharged: payment.horizonFeeCharged,
    appCommission: payment.appCommission,
    appNetImpact: payment.appNetImpact,
    piCompleted: payment.piCompleted === true,
    dbRecorded: payment.dbRecorded === true,
  }

  console.log("[A2UResponse] Built response:", {
    success: response.success,
    status: response.status,
    isFinalSuccess,
    isProcessing,
    piCompleted: response.piCompleted,
    dbRecorded: response.dbRecorded,
    requiresDbReconciliation: payment.requiresDbReconciliation,
  })

  return response
}
