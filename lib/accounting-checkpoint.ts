/**
 * ============================================================================
 * ACCOUNTING CHECKPOINT - FINAL VERIFICATION BEFORE DB RECONCILIATION
 * ============================================================================
 *
 * SINGLE AUTHORITATIVE SOURCE FOR ALL ACCOUNTING DATA
 * 
 * This module validates that ALL required accounting identifiers and amounts
 * are EXACTLY present in the Redis checkpoint before ANY DB reconciliation.
 *
 * NO GUESSING. NO RECALCULATION. NO DEFAULTS.
 * Missing or inconsistent data stops reconciliation SAFELY.
 *
 * Required checkpoint fields (MUST be persisted, non-empty):
 *   - piPaymentId: string (Pi payment identifier)
 *   - u2aTxid: string (U2A blockchain transaction ID)
 *   - a2uPaymentId?: string (A2U identifier, optional until Horizon succeeds)
 *   - a2uTxid?: string (A2U blockchain transaction ID, optional until Horizon succeeds)
 *   - customerAmount: number (verified from Pi payment.amount)
 *   - merchantId: string (verified from Pi /v2/me.username)
 *   - merchantUid: string (verified from Pi /v2/me.uid)
 *
 * Calculated fields (MUST be derivable, persisted for consistency check):
 *   - horizonFeeCharged: number (persisted from Horizon submission response)
 *   - appCommission: number (persisted from payment creation or config)
 *   - merchantAmount: number (customerAmount - horizonFeeCharged - appCommission)
 *   - appNetImpact: number (horizonFeeCharged + appCommission)
 *
 * Checkpoint validation gates DB reconciliation:
 * - If ANY required identifier is missing → STOP, return error
 * - If ANY amount is invalid (non-finite, wrong sign) → STOP, return error
 * - If calculated fields don't match persisted values (tolerance 0.01) → STOP, return error
 */

import type { Payment } from "./types"

export interface AccountingCheckpoint {
  // Transaction identifiers (REQUIRED for reconciliation)
  piPaymentId: string
  u2aTxid: string
  a2uPaymentId?: string
  a2uTxid?: string

  // Authoritative amounts (REQUIRED)
  customerAmount: number
  horizonFeeCharged: number
  appCommission: number
  merchantAmount: number
  appNetImpact: number

  // Party identifiers (REQUIRED)
  merchantId: string
  merchantUid: string

  // Derived metadata
  isReadyForReconciliation: boolean
  issuesStopping: string[] // Populated if NOT ready
}

/**
 * Validate and extract accounting checkpoint from payment.
 * This is the SINGLE gate before DB reconciliation.
 *
 * @param payment Payment record from Redis
 * @returns AccountingCheckpoint with readiness flag and issues if not ready
 */
export function validateAccountingCheckpoint(payment: Payment): AccountingCheckpoint {
  const issues: string[] = []

  // =========================================================================
  // STEP 1: Validate required transaction identifiers (MUST be present)
  // =========================================================================

  // U2A identifiers MUST exist for any payment marked paid_to_app or beyond
  const piPaymentId = payment.piPaymentId
  if (!piPaymentId || typeof piPaymentId !== "string" || piPaymentId.trim() === "") {
    issues.push("Missing piPaymentId - cannot reconcile U2A payment")
  }

  const u2aTxid = payment.u2aTxid
  if (!u2aTxid || typeof u2aTxid !== "string" || u2aTxid.trim() === "") {
    issues.push("Missing u2aTxid - U2A transaction not verified")
  }

  // A2U identifiers are optional until Horizon succeeds
  const a2uPaymentId = payment.a2uPaymentId
  if (a2uPaymentId !== undefined && (typeof a2uPaymentId !== "string" || a2uPaymentId.trim() === "")) {
    issues.push("Invalid a2uPaymentId - if present must be non-empty string")
  }

  const a2uTxid = payment.a2uTxid
  if (a2uTxid !== undefined && (typeof a2uTxid !== "string" || a2uTxid.trim() === "")) {
    issues.push("Invalid a2uTxid - if present must be non-empty string")
  }

  // =========================================================================
  // STEP 2: Validate party identifiers (REQUIRED)
  // =========================================================================

  const merchantId = payment.merchantId
  if (!merchantId || typeof merchantId !== "string" || merchantId.trim() === "") {
    issues.push("Missing merchantId - cannot identify party")
  }

  const merchantUid = payment.merchantUid
  if (!merchantUid || typeof merchantUid !== "string" || merchantUid.trim() === "") {
    issues.push("Missing merchantUid - cannot verify Pi settlement identity")
  }

  // =========================================================================
  // STEP 3: Validate authoritative amounts (REQUIRED, MUST be finite)
  // =========================================================================

  // customerAmount MUST be present, finite, positive
  const customerAmount = payment.customerAmount
  if (typeof customerAmount !== "number" || !Number.isFinite(customerAmount) || customerAmount <= 0) {
    issues.push(`Invalid customerAmount: ${customerAmount} - must be finite positive number`)
  }

  // horizonFeeCharged MUST be present (persisted from A2U response), finite, non-negative
  const horizonFeeCharged = payment.horizonFeeCharged
  if (typeof horizonFeeCharged !== "number" || !Number.isFinite(horizonFeeCharged) || horizonFeeCharged < 0) {
    issues.push(`Invalid horizonFeeCharged: ${horizonFeeCharged} - must be finite non-negative number`)
  }

  // appCommission MUST be present (persisted from payment creation), finite, non-negative
  const appCommission = payment.appCommission
  if (typeof appCommission !== "number" || !Number.isFinite(appCommission) || appCommission < 0) {
    issues.push(`Invalid appCommission: ${appCommission} - must be finite non-negative number`)
  }

  // =========================================================================
  // STEP 4: Validate calculated fields (MUST match derivation with tolerance)
  // =========================================================================

  // merchantAmount = customerAmount - horizonFeeCharged - appCommission
  // REQUIRED: must be positive (merchant cannot receive negative or zero amount)
  const merchantAmount = payment.merchantAmount
  const calculatedMerchantAmount =
    typeof customerAmount === "number" && Number.isFinite(customerAmount) &&
    typeof horizonFeeCharged === "number" && Number.isFinite(horizonFeeCharged) &&
    typeof appCommission === "number" && Number.isFinite(appCommission)
      ? customerAmount - horizonFeeCharged - appCommission
      : NaN

  if (typeof merchantAmount !== "number" || !Number.isFinite(merchantAmount)) {
    issues.push(`Invalid merchantAmount: ${merchantAmount} - must be finite number`)
  } else if (merchantAmount <= 0) {
    issues.push(`Invalid merchantAmount: ${merchantAmount} - must be positive (merchant receives nothing or negative)`)
  }

  // Verify merchantAmount calculation matches persisted value
  if (
    typeof merchantAmount === "number" && Number.isFinite(merchantAmount) &&
    !Number.isNaN(calculatedMerchantAmount)
  ) {
    const merchantDifference = Math.abs(calculatedMerchantAmount - merchantAmount)
    const tolerance = 0.01
    if (merchantDifference > tolerance) {
      issues.push(
        `merchantAmount mismatch: stored=${merchantAmount}, calculated=${calculatedMerchantAmount}, diff=${merchantDifference}`,
      )
    }
  }

  // appNetImpact = horizonFeeCharged + appCommission
  // CRITICAL: can be negative if app absorbs fees (e.g., customer pays full to merchant, app pays fee)
  const appNetImpact = payment.appNetImpact
  const calculatedAppNetImpact =
    typeof horizonFeeCharged === "number" && Number.isFinite(horizonFeeCharged) &&
    typeof appCommission === "number" && Number.isFinite(appCommission)
      ? horizonFeeCharged + appCommission
      : NaN

  if (typeof appNetImpact !== "number" || !Number.isFinite(appNetImpact)) {
    issues.push(`Invalid appNetImpact: ${appNetImpact} - must be finite number`)
  }

  // Verify appNetImpact calculation matches persisted value
  if (
    typeof appNetImpact === "number" && Number.isFinite(appNetImpact) &&
    !Number.isNaN(calculatedAppNetImpact)
  ) {
    const netDifference = Math.abs(calculatedAppNetImpact - appNetImpact)
    const tolerance = 0.01
    if (netDifference > tolerance) {
      issues.push(
        `appNetImpact mismatch: stored=${appNetImpact}, calculated=${calculatedAppNetImpact}, diff=${netDifference}`,
      )
    }
  }

  // =========================================================================
  // STEP 5: Cross-check consistency (customerAmount >= merchantAmount)
  // =========================================================================

  if (
    typeof customerAmount === "number" && Number.isFinite(customerAmount) &&
    typeof merchantAmount === "number" && Number.isFinite(merchantAmount)
  ) {
    if (customerAmount < merchantAmount) {
      issues.push(`Impossible amounts: customerAmount (${customerAmount}) < merchantAmount (${merchantAmount})`)
    }
  }

  // =========================================================================
  // RESULT
  // =========================================================================

  const isReadyForReconciliation = issues.length === 0

  return {
    piPaymentId: piPaymentId || "",
    u2aTxid: u2aTxid || "",
    a2uPaymentId,
    a2uTxid,
    customerAmount: typeof customerAmount === "number" ? customerAmount : 0,
    horizonFeeCharged: typeof horizonFeeCharged === "number" ? horizonFeeCharged : 0,
    appCommission: typeof appCommission === "number" ? appCommission : 0,
    merchantAmount: typeof merchantAmount === "number" ? merchantAmount : 0,
    appNetImpact: typeof appNetImpact === "number" ? appNetImpact : 0,
    merchantId: merchantId || "",
    merchantUid: merchantUid || "",
    isReadyForReconciliation,
    issuesStopping: issues,
  }
}

/**
 * Safe reconciliation gate: prevents DB writes if checkpoint is invalid.
 * Called BEFORE any DB reconciliation attempt.
 *
 * @param payment Payment record from Redis
 * @returns { ready: true } or { ready: false, error: string, issues: string[] }
 */
export function checkReconciliationReadiness(
  payment: Payment,
): { ready: true } | { ready: false; error: string; issues: string[] } {
  const checkpoint = validateAccountingCheckpoint(payment)

  if (!checkpoint.isReadyForReconciliation) {
    console.error("[Accounting Checkpoint] BLOCKING DB reconciliation - payment not ready:", {
      paymentId: payment.id,
      issues: checkpoint.issuesStopping,
    })

    return {
      ready: false,
      error: `Payment not ready for DB reconciliation: ${checkpoint.issuesStopping.join("; ")}`,
      issues: checkpoint.issuesStopping,
    }
  }

  console.log("[Accounting Checkpoint] ✓ Payment checkpoint valid - ready for DB reconciliation:", {
    paymentId: payment.id,
    piPaymentId: checkpoint.piPaymentId,
    customerAmount: checkpoint.customerAmount,
    merchantAmount: checkpoint.merchantAmount,
    appNetImpact: checkpoint.appNetImpact,
  })

  return { ready: true }
}
