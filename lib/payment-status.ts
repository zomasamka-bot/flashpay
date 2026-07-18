/**
 * Payment Status Utilities — Consistent status model across the app
 * 
 * EXACT 7 STATUS VALUES (never deviate):
 * 1. pending: Initial state, awaiting Pi Wallet confirmation
 * 2. failed: Pre-settlement failure (retryable, no blockchain involvement)
 * 3. cancelled: Customer cancelled payment
 * 4. paid_to_app: U2A complete (processing state, NOT error)
 * 5. settlement_pending: A2U in progress (processing state, NOT error)
 * 6. settled_to_merchant: A2U complete - ONLY FINAL SUCCESS (never downgrades)
 * 7. settlement_failed: A2U failure before Horizon success (terminal with flags)
 * 
 * Terminal State Rule: settlement_failed with a2uTxid or horizonSuccessFlag
 * must NEVER be retried by client - requires server recovery or manual review.
 */

import type { PaymentStatus, Payment } from './types'

/**
 * EXACT valid status values - use for validation
 */
export const VALID_STATUSES: PaymentStatus[] = [
  'pending',
  'failed',
  'cancelled',
  'paid_to_app',
  'settlement_pending',
  'settled_to_merchant',
  'settlement_failed',
]

/**
 * Determine if a status is an intermediate/processing state
 * These should display as "Processing..." to users
 * paid_to_app and settlement_pending are NOT errors
 */
export function isProcessingStatus(status: PaymentStatus): boolean {
  return status === 'paid_to_app' || status === 'settlement_pending'
}

/**
 * Determine if a status is final
 * Only settled_to_merchant is final payment success
 */
export function isFinalStatus(status: PaymentStatus): boolean {
  return status === 'settled_to_merchant'
}

/**
 * Determine if a payment is actually paid/settled
 * Only count settled_to_merchant as successfully paid
 */
export function isPaid(status: PaymentStatus): boolean {
  return status === 'settled_to_merchant'
}

/**
 * Determine if a payment is in a failure state
 */
export function isFailedStatus(status: PaymentStatus): boolean {
  return status === 'failed' || status === 'settlement_failed' || status === 'cancelled'
}

/**
 * CRITICAL: Check if a payment is in a terminal state that blocks retry
 * settlement_failed with a2uTxid or horizonSuccessFlag CANNOT be retried by client
 */
export function isTerminalState(payment: Payment): boolean {
  if (payment.status !== 'settlement_failed') {
    return false
  }
  
  // Terminal if it has Horizon success indicators
  const hasA2uTxid = !!(payment as any)?.a2uTxid
  const hasHorizonFlag = !!(payment as any)?.horizonSuccessFlag
  
  return hasA2uTxid || hasHorizonFlag
}

/**
 * CRITICAL: Can a payment be retried by client?
 * Returns false if payment is in a terminal state (a2uTxid or horizonSuccessFlag present)
 * settlement_failed with terminal flags goes to server recovery, NOT client retry
 */
export function canClientRetryPayment(payment: Payment): boolean {
  // Only 'failed' and 'cancelled' can be retried by client
  // settlement_failed without terminal flags can be retried
  // settlement_failed WITH terminal flags (a2uTxid/horizonSuccessFlag) is BLOCKED
  
  if (isTerminalState(payment)) {
    return false
  }
  
  return payment.status === 'failed' || payment.status === 'cancelled'
}

/**
 * Get human-readable status label for UI display
 */
export function getStatusLabel(status: PaymentStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending'
    case 'paid_to_app':
      return 'Processing'
    case 'settlement_pending':
      return 'Processing Settlement'
    case 'settled_to_merchant':
      return 'Paid'
    case 'settlement_failed':
      return 'Settlement Failed'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    default:
      const _exhaustive: never = status
      return _exhaustive
  }
}

/**
 * Get display color for status badge
 */
export function getStatusColor(status: PaymentStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'pending':
      return 'secondary'
    case 'paid_to_app':
      return 'secondary'
    case 'settlement_pending':
      return 'secondary'
    case 'settled_to_merchant':
      return 'default'
    case 'settlement_failed':
      return 'destructive'
    case 'failed':
      return 'destructive'
    case 'cancelled':
      return 'outline'
    default:
      const _exhaustive: never = status
      return _exhaustive
  }
}

/**
 * Validate that a status never downgrades from settled_to_merchant
 * Throws if invalid downgrade is attempted
 */
export function validateStatusTransition(fromStatus: PaymentStatus, toStatus: PaymentStatus): void {
  // settled_to_merchant is final - never downgrade
  if (fromStatus === 'settled_to_merchant' && toStatus !== 'settled_to_merchant') {
    throw new Error(
      `Invalid status transition: cannot downgrade from settled_to_merchant to ${toStatus}`
    )
  }
}

/**
 * Get settlement status for intermediate states
 * For display purposes: paid_to_app and settlement_pending show as "Processing"
 */
export function getSettlementDisplay(status: PaymentStatus): string {
  if (isProcessingStatus(status)) {
    return 'Processing'
  }
  if (isPaid(status)) {
    return 'Settled'
  }
  if (status === 'settlement_failed') {
    return 'Settlement Failed'
  }
  if (status === 'failed') {
    return 'Payment Failed'
  }
  if (status === 'cancelled') {
    return 'Cancelled'
  }
  return 'Pending'
}

/**
 * Count payments in paid state for statistics
 * ONLY settled_to_merchant counts as successfully paid
 */
export function countPaidPayments(payments: Array<{ status: PaymentStatus }>): number {
  return payments.filter(p => isPaid(p.status)).length
}

/**
 * Calculate settlement statistics
 */
export function getSettlementStats(payments: Array<{ status: PaymentStatus, amount: number }>): {
  paidCount: number
  paidAmount: number
  processingCount: number
  processingAmount: number
  failedCount: number
  failedAmount: number
} {
  return {
    paidCount: payments.filter(p => isPaid(p.status)).length,
    paidAmount: payments.filter(p => isPaid(p.status)).reduce((sum, p) => sum + p.amount, 0),
    processingCount: payments.filter(p => isProcessingStatus(p.status)).length,
    processingAmount: payments.filter(p => isProcessingStatus(p.status)).reduce((sum, p) => sum + p.amount, 0),
    failedCount: payments.filter(p => isFailedStatus(p.status)).length,
    failedAmount: payments.filter(p => isFailedStatus(p.status)).reduce((sum, p) => sum + p.amount, 0),
  }
}
