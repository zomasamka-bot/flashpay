/**
 * ============================================================================
 * DB RECONCILIATION GUARD - PREVENTS CORRUPT ACCOUNTING DATA
 * ============================================================================
 *
 * This module enforces STRICT data quality gates before ANY database writes.
 * 
 * Gate checks (in order):
 * 1. Accounting checkpoint valid (all identifiers & amounts present & consistent)
 * 2. Payment is in compatible status (paid_to_app, settlement_pending, settled_to_merchant)
 * 3. No double-reconciliation (payment.dbRecorded flag not already set)
 * 4. Recovery state preserved (a2uTxid, horizonSuccessFlag, etc.)
 *
 * If ANY gate fails → STOP IMMEDIATELY. Do not proceed to DB.
 * Missing or conflicting data is preserved in Redis checkpoint for manual review.
 */

import type { Payment } from "./types"
import { checkReconciliationReadiness } from "./accounting-checkpoint"

export interface ReconciliationGuardResult {
  canProceed: boolean
  gatesPassed: string[]
  gatesFailed: string[]
  blocking: string | null // If canProceed=false, this explains why
}

/**
 * Check if a payment is safe to reconcile to the database.
 * This is the FINAL gate before recordTransactionToPG.
 *
 * @param payment Payment record from Redis
 * @returns Result with gates passed/failed and blocking reason if applicable
 */
export function checkReconciliationGuard(payment: Payment): ReconciliationGuardResult {
  const gatesPassed: string[] = []
  const gatesFailed: string[] = []
  let blocking: string | null = null

  // =========================================================================
  // GATE 1: Accounting checkpoint must be valid
  // =========================================================================

  const checkpointResult = checkReconciliationReadiness(payment)

  if (!checkpointResult.ready) {
    gatesFailed.push(`Accounting checkpoint invalid: ${checkpointResult.error}`)
    blocking = `Accounting checkpoint blocked reconciliation: ${checkpointResult.issues.join("; ")}`
  } else {
    gatesPassed.push("Accounting checkpoint valid")
  }

  // =========================================================================
  // GATE 2: Payment status must be compatible for DB recording
  // =========================================================================

  const compatibleStatuses = ["paid_to_app", "settlement_pending", "settled_to_merchant"]
  const currentStatus = payment.status

  if (!compatibleStatuses.includes(currentStatus)) {
    gatesFailed.push(
      `Payment status incompatible: ${currentStatus} (must be one of: ${compatibleStatuses.join(", ")})`,
    )
    blocking = `Cannot reconcile payment with status: ${currentStatus}`
  } else {
    gatesPassed.push(`Payment status compatible: ${currentStatus}`)
  }

  // =========================================================================
  // GATE 3: Double-reconciliation prevention
  // =========================================================================

  if (payment.dbRecorded === true) {
    gatesFailed.push("Payment already recorded to database (dbRecorded=true)")
    blocking = "Payment was already reconciled to database - double reconciliation blocked"
  } else {
    gatesPassed.push("Payment not yet reconciled to database")
  }

  // =========================================================================
  // GATE 4: Recovery state preservation
  // =========================================================================

  // If A2U recovery flags are set, they must be consistent
  const hasA2USuccessFlag = payment.horizonSuccessFlag === true
  const hasA2UTxid = !!payment.a2uTxid

  if (hasA2USuccessFlag && !hasA2UTxid) {
    gatesFailed.push("Recovery state inconsistent: horizonSuccessFlag set but a2uTxid missing")
    blocking = "Recovery state corrupted - cannot reconcile"
  } else if (!hasA2USuccessFlag && hasA2UTxid) {
    // a2uTxid can exist without horizonSuccessFlag (e.g., payment is still in settlement_pending)
    // but this is acceptable
    gatesPassed.push("A2U recovery state preserved (a2uTxid present)")
  } else if (hasA2USuccessFlag && hasA2UTxid) {
    gatesPassed.push("A2U recovery state preserved (both horizonSuccessFlag and a2uTxid)")
  } else {
    gatesPassed.push("A2U recovery state not yet applicable (payment pre-settlement)")
  }

  // =========================================================================
  // RESULT
  // =========================================================================

  const canProceed = gatesFailed.length === 0

  return {
    canProceed,
    gatesPassed,
    gatesFailed,
    blocking,
  }
}

/**
 * Assert reconciliation is safe, throwing error if any gate fails.
 * Used at the beginning of recordTransactionToPG.
 *
 * @param payment Payment record from Redis
 * @throws Error if reconciliation is blocked
 */
export function assertReconciliationSafe(payment: Payment): void {
  const result = checkReconciliationGuard(payment)

  if (!result.canProceed) {
    console.error("[Reconciliation Guard] BLOCKING DB reconciliation:", {
      paymentId: payment.id,
      gatesFailed: result.gatesFailed,
      blocking: result.blocking,
    })

    throw new Error(`Reconciliation blocked: ${result.blocking}`)
  }

  console.log("[Reconciliation Guard] ✓ All gates passed - safe to reconcile:", {
    paymentId: payment.id,
    gates: result.gatesPassed,
  })
}
