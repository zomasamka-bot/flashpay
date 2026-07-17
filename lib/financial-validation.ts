import { Payment } from "./types"

export interface ValidatedFinancialData {
  piPaymentId: string
  u2aTxid: string
  a2uPaymentId: string
  a2uTxid: string
  merchantId: string
  merchantUid: string
  customerAmount: number
  merchantAmount: number
  horizonFeeCharged: number
  appCommission: number
}

/**
 * Strict financial validation for DB accounting.
 * NO FALLBACKS. NO GUESSING.
 * 
 * ALL authoritative values must be present and finite.
 * If ANY required field is missing, returns error — never proceeds to DB.
 * 
 * @param payment Payment record from Redis
 * @returns { success: true, data: ValidatedFinancialData } or { success: false, error: string }
 */
export function validateFinancialData(payment: Payment): 
  | { success: true; data: ValidatedFinancialData }
  | { success: false; error: string } {
  
  // Check ALL required identifiers (no fallbacks)
  if (!payment.piPaymentId || typeof payment.piPaymentId !== "string") {
    return { success: false, error: "Missing piPaymentId" }
  }
  if (!payment.u2aTxid || typeof payment.u2aTxid !== "string") {
    return { success: false, error: "Missing u2aTxid" }
  }
  if (!payment.a2uPaymentId || typeof payment.a2uPaymentId !== "string") {
    return { success: false, error: "Missing a2uPaymentId" }
  }
  if (!payment.a2uTxid || typeof payment.a2uTxid !== "string") {
    return { success: false, error: "Missing a2uTxid" }
  }
  if (!payment.merchantId || typeof payment.merchantId !== "string") {
    return { success: false, error: "Missing merchantId" }
  }
  if (!payment.merchantUid || typeof payment.merchantUid !== "string") {
    return { success: false, error: "Missing merchantUid" }
  }

  // Check ALL required amounts (must be finite numbers, NO FALLBACKS like || 0 or || payment.amount)
  if (
    typeof payment.customerAmount !== "number" ||
    !Number.isFinite(payment.customerAmount) ||
    payment.customerAmount <= 0
  ) {
    return { success: false, error: `Invalid customerAmount: ${payment.customerAmount}` }
  }

  if (
    typeof payment.merchantAmount !== "number" ||
    !Number.isFinite(payment.merchantAmount) ||
    payment.merchantAmount <= 0
  ) {
    return { success: false, error: `Invalid merchantAmount: ${payment.merchantAmount}` }
  }

  if (
    typeof payment.horizonFeeCharged !== "number" ||
    !Number.isFinite(payment.horizonFeeCharged) ||
    payment.horizonFeeCharged < 0
  ) {
    return { success: false, error: `Invalid horizonFeeCharged: ${payment.horizonFeeCharged}` }
  }

  if (
    typeof payment.appCommission !== "number" ||
    !Number.isFinite(payment.appCommission) ||
    payment.appCommission < 0
  ) {
    return { success: false, error: `Invalid appCommission: ${payment.appCommission}` }
  }

  // Verify financial relationship: customerAmount must cover merchantAmount + horizonFeeCharged
  const totalCost = payment.merchantAmount + payment.horizonFeeCharged
  if (payment.customerAmount < totalCost) {
    return {
      success: false,
      error: `Insufficient customer amount: ${payment.customerAmount} < ${totalCost} (merchant: ${payment.merchantAmount} + fee: ${payment.horizonFeeCharged})`,
    }
  }

  return {
    success: true,
    data: {
      piPaymentId: payment.piPaymentId,
      u2aTxid: payment.u2aTxid,
      a2uPaymentId: payment.a2uPaymentId,
      a2uTxid: payment.a2uTxid,
      merchantId: payment.merchantId,
      merchantUid: payment.merchantUid,
      customerAmount: payment.customerAmount,
      merchantAmount: payment.merchantAmount,
      horizonFeeCharged: payment.horizonFeeCharged,
      appCommission: payment.appCommission,
    },
  }
}
