import { redis } from "@/lib/redis"

/**
 * Canonical A2U success response shape - used by ALL success paths.
 * Re-reads Redis to ensure authoritative data, never trusts HTTP response fields.
 */
export interface A2USuccessResponse {
  success: true
  status: "settled_to_merchant"
  paymentId: string
  a2uPaymentId: string
  a2uTxid: string
  u2aTxid: string
  fromAddress: string
  toAddress: string
  customerAmount: number
  merchantAmount: number
  horizonFeeCharged: number
  appCommission: number
  appNetImpact: number
  piCompleted: boolean
}

/**
 * Build canonical A2U success response by re-reading Redis checkpoint.
 * Never use internal HTTP response fields; always trust the persistent Redis record.
 * 
 * This ensures consistency across:
 * - Initial approval (new payment)
 * - Pi /complete flow (settlement)
 * - Recovery flows (idempotent retry)
 */
export async function buildA2USuccessResponse(
  paymentId: string
): Promise<A2USuccessResponse | null> {
  const paymentKey = `payment:${paymentId}`
  const paymentData = await redis.get(paymentKey)

  if (!paymentData) {
    console.error("[A2UResponse] Payment not found in Redis:", paymentId)
    return null
  }

  const payment = typeof paymentData === "string" ? JSON.parse(paymentData) : paymentData

  // CRITICAL: All these fields must exist in the checkpoint
  if (
    !payment.paymentId ||
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
      paymentId: payment.paymentId,
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

  // Build canonical response from authoritative Redis checkpoint
  const response: A2USuccessResponse = {
    success: true,
    status: "settled_to_merchant",
    paymentId: payment.paymentId,
    a2uPaymentId: payment.a2uPaymentId,
    a2uTxid: payment.a2uTxid,
    u2aTxid: payment.u2aTxid,
    fromAddress: payment.a2uFromAddress,
    toAddress: payment.a2uToAddress,
    customerAmount: payment.customerAmount,
    merchantAmount: payment.merchantAmount,
    horizonFeeCharged: payment.horizonFeeCharged,
    appCommission: payment.appCommission,
    appNetImpact: payment.appNetImpact,
    piCompleted: payment.piCompleted === true,
  }

  return response
}
