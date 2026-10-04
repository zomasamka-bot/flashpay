import type { Payment } from './types'

export function hasAnySettlementOrRefundExecutionEvidence(payment: Payment): boolean {
  return Boolean(
    payment.paidAt || payment.u2aTxid || payment.a2uPaymentId || payment.a2uTxid ||
    payment.a2uPreparedTxHash || payment.a2uPreparedSequence || payment.a2uPreparedEnvelopeXdr ||
    payment.a2uFromAddress || payment.a2uToAddress || payment.settlementDispatchRequestedAt ||
    payment.horizonSuccessFlag === true || payment.piCompletionPending === true || payment.piCompleted === true ||
    payment.requiresDbReconciliation === true || payment.dbRecorded === true ||
    payment.refundPaymentId || payment.refundTxid ||
    (payment.refundStatus !== undefined && payment.refundStatus !== 'not_started')
  )
}

export function isTerminalNoMovementProjectionCandidate(payment: Payment): boolean {
  return (payment.status === 'cancelled' || payment.status === 'failed') && !hasAnySettlementOrRefundExecutionEvidence(payment)
}
