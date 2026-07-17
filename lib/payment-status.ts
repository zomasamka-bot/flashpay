/**
 * Payment Status Utilities — Consistent status model across the app
 * 
 * Status Model (7 states, only settled_to_merchant is final success):
 * - pending: Payment awaiting Pi Wallet confirmation
 * - failed: U2A failed or pre-settlement failure
 * - cancelled: Customer cancelled payment
 * - paid_to_app: U2A completed, settlement starting (intermediate)
 * - settlement_pending: A2U created but not yet signed (intermediate)
 * - settled_to_merchant: A2U complete - FINAL SUCCESS (never downgrades)
 * - settlement_failed: A2U settlement failed
 */

import type { PaymentStatus } from './types'

/**
 * Determine if a status is an intermediate/processing state
 * These should display as "Processing..." to users
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
