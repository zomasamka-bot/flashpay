import type { Payment, RefundCheckpoint } from './types'

export type Dr11OrphanA2UDtoState = 'CREATED_UNMOVED' | 'CANCELLED_UNMOVED' | 'BLOCKED'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

export function isDr11OrphanA2UProjectionCandidate(checkpoint: RefundCheckpoint, payment: Payment): boolean {
  return checkpoint.idempotencyKey === `dr11-live:${checkpoint.paymentId}` &&
    checkpoint.amount === 0.1 && checkpoint.status === 'pending' && checkpoint.stage === 'intent_created' &&
    checkpoint.sourcePaymentStatus === 'settlement_failed' && checkpoint.sourceSettlementState === 'refund_pending' &&
    !checkpoint.refundPaymentId && !checkpoint.refundTxid &&
    payment.id === checkpoint.paymentId && payment.amount === checkpoint.amount && payment.customerAmount === checkpoint.amount &&
    payment.payerUid === checkpoint.payerUid && canonicalString(payment.merchantUid) &&
    payment.status === 'paid_to_app' && canonicalString(payment.a2uPaymentId) && !payment.a2uTxid &&
    payment.a2uPreparedTxHash == null && payment.a2uPreparedSequence == null && payment.a2uPreparedEnvelopeXdr == null &&
    payment.horizonSuccessFlag !== true && !payment.refundPaymentId && !payment.refundTxid && payment.refundStatus !== 'completed'
}

export function classifyDr11OrphanA2UPaymentDto(
  value: unknown,
  expected: { paymentId: string; a2uPaymentId: string; merchantUid: string; amount: number },
): Dr11OrphanA2UDtoState {
  if (!isRecord(value) || !canonicalString(expected.paymentId) || !canonicalString(expected.a2uPaymentId) || !canonicalString(expected.merchantUid) || expected.amount !== 0.1) return 'BLOCKED'
  const metadata = isRecord(value.metadata) ? value.metadata : null
  const status = isRecord(value.status) ? value.status : null
  if (
    value.identifier !== expected.a2uPaymentId || value.network !== 'Pi Testnet' || value.direction !== 'app_to_user' ||
    value.amount !== expected.amount || value.user_uid !== expected.merchantUid ||
    !canonicalString(value.from_address) || !canonicalString(value.to_address) ||
    metadata?.type !== 'a2u_settlement' || metadata?.paymentId !== expected.paymentId || status === null
  ) return 'BLOCKED'

  const transaction = value.transaction
  const transferEvidence =
    typeof value.txid === 'string' || typeof value.transaction_id === 'string' || value.completed === true ||
    (isRecord(transaction) && (typeof transaction.txid === 'string' || transaction.verified === true)) ||
    status.transaction_verified === true || status.developer_completed === true
  if (transferEvidence) return 'BLOCKED'
  if (status.user_cancelled === true) return 'BLOCKED'
  if (status.cancelled === true || value.cancelled === true || value.rejected === true) return 'CANCELLED_UNMOVED'
  if (status.cancelled !== false && status.cancelled !== undefined) return 'BLOCKED'
  return 'CREATED_UNMOVED'
}
