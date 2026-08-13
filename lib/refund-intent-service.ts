import "server-only"

import { redis } from '@/lib/redis'
import { createRefundCheckpointWithAudit, claimRefundIdempotency, getRefundCheckpointByIdempotency, releaseRefundIdempotency, acquirePaymentOperationLock, releasePaymentOperationLock, transitionRefundCheckpointWithAudit } from '@/lib/refund-checkpoint-store'
import type { Payment, RefundCheckpoint, RefundAuditEvent } from '@/lib/types'
import { isRefundEligible as checkEligibility } from '@/lib/types'
import { randomUUID } from 'node:crypto'
import { getRefundReadiness } from '@/lib/refund-readiness'

export type RefundIntentInternalResult = { status: number; body: unknown }

export async function createRefundIntentInternal(paymentId: string, idempotencyKey: string): Promise<RefundIntentInternalResult> {
  if (typeof paymentId !== 'string' || paymentId.length === 0) return { status: 400, body: { error: 'Missing or invalid paymentId' } }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) return { status: 400, body: { error: 'Missing or invalid idempotencyKey' } }

  const existingBeforeReadiness = await getRefundCheckpointByIdempotency(idempotencyKey)
  if (existingBeforeReadiness) {
    if (existingBeforeReadiness.paymentId !== paymentId) return { status: 409, body: { error: 'Idempotency key is bound to different refund inputs' } }
    if (existingBeforeReadiness.stage === 'eligibility_verified' && existingBeforeReadiness.status === 'pending') {
      const transitioned = await transitionRefundCheckpointWithAudit(existingBeforeReadiness.refundId, 'eligibility_verified', 'intent_created', 'pending', { eventId: randomUUID(), refundId: existingBeforeReadiness.refundId, paymentId, eventType: 'refund_requested', actorType: 'system', idempotencyKey, createdAt: new Date().toISOString(), details: { resumed: true } })
      if (transitioned) return { status: 200, body: { success: true, refund: transitioned } }
      const reread = await getRefundCheckpointByIdempotency(idempotencyKey)
      if (reread && reread.paymentId === paymentId && reread.stage !== 'eligibility_verified') return { status: 200, body: { success: true, refund: reread } }
      return { status: 409, body: { error: 'Refund intent transition conflict' } }
    }
    return { status: 200, body: { success: true, refund: existingBeforeReadiness } }
  }

  const readiness = await getRefundReadiness()
  if (readiness.ready !== true) { console.warn("[refunds/intent] Readiness blocked:", readiness.checks); return { status: 503, body: { error: 'Refund system unavailable' } } }

  const stored = await redis.get(`payment:${paymentId}`)
  if (!stored) return { status: 404, body: { error: 'Payment not found' } }
  const paymentRecord: any = typeof stored === 'string' ? JSON.parse(stored) : stored
  const payment: Payment = {
    id: paymentRecord.id,
    merchantId: paymentRecord.merchant_id || paymentRecord.merchantId,
    merchantUid: paymentRecord.merchant_uid || paymentRecord.merchantUid,
    merchantAddress: paymentRecord.merchant_address || paymentRecord.merchantAddress,
    accessToken: paymentRecord.access_token || paymentRecord.accessToken,
    amount: Number(paymentRecord.amount),
    customerAmount: paymentRecord.customerAmount !== undefined && paymentRecord.customerAmount !== null ? Number(paymentRecord.customerAmount) : paymentRecord.customer_amount !== undefined && paymentRecord.customer_amount !== null ? Number(paymentRecord.customer_amount) : undefined,
    note: paymentRecord.note,
    status: paymentRecord.status,
    settlementFailureState: paymentRecord.settlement_failure_state || paymentRecord.settlementFailureState,
    payerUid: paymentRecord.payerUid,
    payerUidSource: paymentRecord.payerUidSource,
    payerUidCapturedAt: paymentRecord.payerUidCapturedAt,
    payerRefundEligible: paymentRecord.payerRefundEligible === true,
    a2uPaymentId: paymentRecord.a2uPaymentId,
    a2uTxid: paymentRecord.a2uTxid,
    horizonSuccessFlag: paymentRecord.horizonSuccessFlag === true,
    refundStatus: paymentRecord.refund_status || paymentRecord.refundStatus,
    refundPaymentId: paymentRecord.refund_payment_id || paymentRecord.refundPaymentId,
    refundTxid: paymentRecord.refund_txid || paymentRecord.refundTxid,
    createdAt: paymentRecord.created_at || paymentRecord.createdAt,
  }
  if (payment.id !== paymentId || !payment.id) return { status: 422, body: { error: 'Payment ID mismatch' } }
  if (payment.refundPaymentId || payment.refundTxid) return { status: 422, body: { error: 'Refund transfer evidence already exists' } }
  const canonicalAmount = paymentRecord.customerAmount
  const legacyAmount = paymentRecord.customer_amount
  if (canonicalAmount !== undefined && canonicalAmount !== null && legacyAmount !== undefined && legacyAmount !== null && (!Number.isFinite(Number(canonicalAmount)) || !Number.isFinite(Number(legacyAmount)) || Number(canonicalAmount) !== Number(legacyAmount))) return { status: 422, body: { error: 'Conflicting customerAmount values' } }
  console.log('[refunds/intent] Payment loaded:', { id: payment.id, status: payment.status, settlementFailureState: payment.settlementFailureState, payerRefundEligible: payment.payerRefundEligible, refundStatus: payment.refundStatus })
  if (typeof payment.customerAmount !== 'number' || !Number.isFinite(payment.customerAmount) || payment.customerAmount <= 0) return { status: 422, body: { error: 'Verified customerAmount is required' } }
  if (!checkEligibility(payment)) {
    console.warn('[refunds/intent] Payment ineligible for refund:', { status: payment.status, settlementFailureState: payment.settlementFailureState, payerRefundEligible: payment.payerRefundEligible, payerUid: !!payment.payerUid, refundStatus: payment.refundStatus })
    return { status: 422, body: { error: 'Payment is not eligible for refund' } }
  }
  const existing = await getRefundCheckpointByIdempotency(idempotencyKey)
  if (existing) {
    if (existing.paymentId !== payment.id || existing.payerUid !== payment.payerUid || existing.amount !== payment.customerAmount) return { status: 409, body: { error: 'Idempotency key is bound to different refund inputs' } }
    if (existing.stage === 'eligibility_verified' && existing.status === 'pending') {
      const transitioned = await transitionRefundCheckpointWithAudit(existing.refundId, 'eligibility_verified', 'intent_created', 'pending', { eventId: randomUUID(), refundId: existing.refundId, paymentId: existing.paymentId, eventType: 'refund_requested', actorType: 'system', idempotencyKey, createdAt: new Date().toISOString(), details: { resumed: true } })
      if (transitioned) return { status: 200, body: { success: true, refund: transitioned } }
      const reread = await getRefundCheckpointByIdempotency(idempotencyKey)
      if (reread && reread.paymentId === payment.id && reread.stage !== 'eligibility_verified') return { status: 200, body: { success: true, refund: reread } }
      return { status: 409, body: { error: 'Refund intent transition conflict' } }
    }
    return { status: 200, body: { success: true, refund: existing } }
  }
  const refundId = randomUUID()
  const paymentLockAcquired = await acquirePaymentOperationLock(payment.id, refundId)
  if (!paymentLockAcquired) return { status: 409, body: { error: 'Payment is already being processed' } }
  const idempotencyClaimed = await claimRefundIdempotency(idempotencyKey, refundId)
  if (!idempotencyClaimed) { await releasePaymentOperationLock(payment.id, refundId); return { status: 409, body: { error: 'Idempotency key already in use' } } }
  const now = new Date().toISOString()
  const checkpoint: RefundCheckpoint = { refundId, paymentId: payment.id, idempotencyKey, status: 'pending', stage: 'eligibility_verified', payerUid: payment.payerUid!, payerUidVerifiedAt: payment.payerUidCapturedAt || now, amount: payment.customerAmount, currency: 'π', sourcePaymentStatus: payment.status, sourceSettlementState: payment.settlementFailureState!, createdAt: now, updatedAt: now, attemptCount: 0 }
  console.log('[refunds/intent] Creating checkpoint:', { refundId, paymentId: payment.id, amount: checkpoint.amount, stage: checkpoint.stage })
  const auditEventId = randomUUID()
  const auditEvent: RefundAuditEvent = { eventId: auditEventId, refundId, paymentId: payment.id, eventType: 'eligibility_verified', actorType: 'system', idempotencyKey, createdAt: now, details: { refundAmount: checkpoint.amount, payerUid: checkpoint.payerUid.substring(0, 8), stage: checkpoint.stage } }
  const persistedCheckpoint = await createRefundCheckpointWithAudit(checkpoint, auditEvent)
  if (!persistedCheckpoint) { await releaseRefundIdempotency(idempotencyKey, refundId); await releasePaymentOperationLock(payment.id, refundId); return { status: 409, body: { error: 'Refund intent creation failed - checkpoint and audit were not persisted' } } }
  const transitioned = await transitionRefundCheckpointWithAudit(refundId, 'eligibility_verified', 'intent_created', 'pending', { eventId: randomUUID(), refundId, paymentId: payment.id, eventType: 'refund_requested', actorType: 'system', idempotencyKey, createdAt: now, details: { stage: 'intent_created' } })
  if (!transitioned) return { status: 409, body: { error: 'Refund intent transition conflict', refundId } }
  console.log('[refunds/intent] Refund intent created successfully:', refundId)
  return { status: 201, body: { success: true, refund: { id: refundId, paymentId: payment.id, status: transitioned.status, stage: transitioned.stage, amount: transitioned.amount, currency: transitioned.currency, createdAt: transitioned.createdAt } } }
}
