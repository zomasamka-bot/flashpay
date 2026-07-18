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
  appNetImpact: number
}

/**
 * Strict financial validation for DB accounting.
 * NO FALLBACKS. NO GUESSING. NO INCORRECT RELATIONSHIP ASSUMPTIONS.
 * 
 * PRECISE REQUIREMENTS:
 * - All required identifiers must exist and be non-empty strings
 * - customerAmount and merchantAmount must be finite positive numbers
 * - horizonFeeCharged and appCommission must be finite nonnegative numbers
 * - appNetImpact is calculated and validated, allowing negative values (app subsidizes)
 * 
 * If ANY required field is missing or invalid, returns error — never proceeds to DB.
 * 
 * @param payment Payment record from Redis
 * @returns { success: true, data: ValidatedFinancialData } or { success: false, error: string }
 */
export function validateFinancialData(payment: Payment): 
  | { success: true; data: ValidatedFinancialData }
  | { success: false; error: string } {
  
  // STEP 1: Validate ALL required identifiers (no fallbacks)
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

  // STEP 2: Validate customerAmount (must be finite positive)
  if (
    typeof payment.customerAmount !== "number" ||
    !Number.isFinite(payment.customerAmount) ||
    payment.customerAmount <= 0
  ) {
    return { success: false, error: `Invalid customerAmount: ${payment.customerAmount}` }
  }

  // STEP 3: Validate merchantAmount (must be finite positive)
  if (
    typeof payment.merchantAmount !== "number" ||
    !Number.isFinite(payment.merchantAmount) ||
    payment.merchantAmount <= 0
  ) {
    return { success: false, error: `Invalid merchantAmount: ${payment.merchantAmount}` }
  }

  // STEP 4: Validate horizonFeeCharged (must be finite nonnegative)
  if (
    typeof payment.horizonFeeCharged !== "number" ||
    !Number.isFinite(payment.horizonFeeCharged) ||
    payment.horizonFeeCharged < 0
  ) {
    return { success: false, error: `Invalid horizonFeeCharged: ${payment.horizonFeeCharged}` }
  }

  // STEP 5: Validate appCommission (must be finite nonnegative)
  if (
    typeof payment.appCommission !== "number" ||
    !Number.isFinite(payment.appCommission) ||
    payment.appCommission < 0
  ) {
    return { success: false, error: `Invalid appCommission: ${payment.appCommission}` }
  }

  // STEP 6: Validate appNetImpact (must be finite, can be negative if app subsidizes)
  if (
    typeof payment.appNetImpact !== "number" ||
    !Number.isFinite(payment.appNetImpact)
  ) {
    return { success: false, error: `Invalid appNetImpact: ${payment.appNetImpact}` }
  }

  // STEP 7: Verify appNetImpact calculation with tolerance
  // CRITICAL: appNetImpact = customerAmount - merchantAmount - horizonFeeCharged
  // Allow small tolerance for floating-point rounding (0.01 units)
  const calculatedNetImpact = payment.customerAmount - payment.merchantAmount - (payment.horizonFeeCharged ?? 0)
  const tolerance = 0.01
  const difference = Math.abs(calculatedNetImpact - payment.appNetImpact)
  
  if (difference > tolerance) {
    return {
      success: false,
      error: `appNetImpact mismatch: stored=${payment.appNetImpact}, calculated=${calculatedNetImpact}, diff=${difference}`,
    }
  }

  // VALID: All amounts are finite, signs are correct, calculation is accurate
  // Note: appNetImpact can be negative if app absorbs fees (customer pays full amount to merchant, app pays fee)
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
      appNetImpact: payment.appNetImpact,
    },
  }
}
