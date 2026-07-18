/**
 * SINGLE AUTHORITATIVE RETRY DECISION FUNCTION
 * 
 * All retry logic flows through this one function.
 * Blocks: a2uTxid, horizonSuccessFlag, processing states, final success.
 * Routes: settlement_failed → server recovery, not client retry.
 */

import type { Payment } from "./types"
import { isProcessingStatus, isTerminalState, canClientRetryPayment as canRetryFromStatus } from "./payment-status"

export interface RetryDecision {
  canRetry: boolean
  reason: string
  routeToServerRecovery: boolean
  isProcessing: boolean
  isTerminal: boolean
}

/**
 * AUTHORITATIVE: Can this payment be retried by the customer?
 * 
 * ✅ CAN RETRY:
 *   - status === "failed" (pre-settlement)
 *   - status === "cancelled" (customer cancelled)
 *   - status === "settlement_failed" (A2U failed before Horizon) WITHOUT terminal flags
 *
 * ❌ CANNOT RETRY (BLOCKED):
 *   - status === "paid_to_app" (processing, not failure)
 *   - status === "settlement_pending" (processing, not failure)
 *   - status === "settled_to_merchant" (final success, immutable)
 *   - status === "settlement_failed" WITH a2uTxid (Horizon sent, needs server recovery)
 *   - status === "settlement_failed" WITH horizonSuccessFlag (Horizon succeeded, needs manual review)
 *   - Any payment with a2uTxid (already broadcast to blockchain)
 *   - Any payment with horizonSuccessFlag (already confirmed on Horizon)
 *
 * ROUTE TO SERVER RECOVERY (not client retry):
 *   - settlement_failed WITH terminal flags → requires /api/recovery/[id] endpoint
 *   - Cannot call createPiPayment again (would create duplicate U2A)
 */
export function getRetryDecision(payment: Payment): RetryDecision {
  // Check for processing states first (these are NOT retryable but also NOT errors)
  if (isProcessingStatus(payment.status)) {
    return {
      canRetry: false,
      reason: `Payment is in ${payment.status} state - still processing, do not retry`,
      routeToServerRecovery: false,
      isProcessing: true,
      isTerminal: false,
    }
  }

  // Check for terminal state (settlement_failed with a2uTxid or horizonSuccessFlag)
  if (isTerminalState(payment)) {
    return {
      canRetry: false,
      reason: "Payment is in terminal settlement_failed state (blockchain present) - requires server recovery, not retry",
      routeToServerRecovery: true,
      isProcessing: false,
      isTerminal: true,
    }
  }

  // Check for final success (settled_to_merchant is immutable)
  if (payment.status === "settled_to_merchant") {
    return {
      canRetry: false,
      reason: "Payment already successfully settled",
      routeToServerRecovery: false,
      isProcessing: false,
      isTerminal: false,
    }
  }

  // Check for blocked identifiers (a2uTxid, horizonSuccessFlag) that would prevent Horizon resubmission
  const hasA2uTxid = !!(payment as any)?.a2uTxid
  const hasHorizonFlag = !!(payment as any)?.horizonSuccessFlag
  
  if (hasA2uTxid || hasHorizonFlag) {
    return {
      canRetry: false,
      reason: "Payment blocked from repayment: already sent to Horizon blockchain",
      routeToServerRecovery: hasA2uTxid && payment.status === "settlement_failed" ? true : false,
      isProcessing: false,
      isTerminal: true,
    }
  }

  // Retryable states: failed, cancelled, settlement_failed (without terminal flags)
  if (payment.status === "failed" || payment.status === "cancelled" || payment.status === "settlement_failed") {
    return {
      canRetry: true,
      reason: `Payment in ${payment.status} state can be retried by customer`,
      routeToServerRecovery: false,
      isProcessing: false,
      isTerminal: false,
    }
  }

  // Fail-safe: unknown status
  return {
    canRetry: false,
    reason: `Unknown payment status: ${payment.status}`,
    routeToServerRecovery: false,
    isProcessing: false,
    isTerminal: false,
  }
}

/**
 * Check if payment is in a state that should NOT trigger failure callback
 * (processing states that are being retried server-side)
 */
export function shouldSuppressErrorCallback(payment: Payment): boolean {
  // Processing states: do NOT call onError
  // These are not failures, just in-flight states
  if (isProcessingStatus(payment.status)) {
    return true
  }

  // Terminal state: do NOT call onError
  // This requires manual review or server recovery
  if (isTerminalState(payment)) {
    return true
  }

  return false
}

/**
 * Check if payment settlement is complete and should NOT be retried/recovered
 */
export function isPaymentSettled(payment: Payment): boolean {
  return payment.status === "settled_to_merchant"
}
