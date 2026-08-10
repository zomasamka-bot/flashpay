import { redis, isRedisConfigured } from './redis'
import {
  ensurePaymentOperationLock,
  getRefundCheckpointAuthoritative,
  persistRefundPaymentIdWithAudit,
  refundPreflight,
  beginRefundSubmissionAttempt,
} from './refund-checkpoint-store'
import { isRefundEligible, type Payment, type RefundAuditEvent, type RefundCheckpoint } from './types'
import { reconcileRefundWithPi } from './refund-pi-reconciliation'
import { serverConfig } from './server-config'

export type RefundExecutionResult =
  | { outcome: 'ready_for_submission' | 'found'; refundId: string; paymentId: string; amount: number; refundPaymentId?: string }
  | { outcome: 'blocked'; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function paymentFromRedis(value: unknown): Payment | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === 'string' ? value.id : ''
  const payerUid = typeof value.payerUid === 'string' ? value.payerUid : typeof value.payer_uid === 'string' ? value.payer_uid : ''
  const customerAmount = typeof value.customerAmount === 'number' ? value.customerAmount : Number(value.customerAmount ?? value.customer_amount)
  if (!id || !payerUid || !Number.isFinite(customerAmount) || customerAmount <= 0) return null
  return { ...value, id, payerUid, customerAmount, payerUidSource: value.payerUidSource ?? value.payer_uid_source, payerUidCapturedAt: value.payerUidCapturedAt ?? value.payer_uid_captured_at, settlementFailureState: value.settlementFailureState ?? value.settlement_failure_state, refundStatus: value.refundStatus ?? value.refund_status } as Payment
}
function guarded(checkpoint: RefundCheckpoint, payment: Payment): boolean {
  const merchant = payment.a2uTxid || payment.horizonSuccessFlag === true || payment.status === 'settled_to_merchant'
  const refund = payment.refundPaymentId || payment.refundTxid || payment.refundStatus === 'completed'
  return !merchant && !refund && isRefundEligible(payment) && refundPreflight(checkpoint, payment, { paymentId: checkpoint.paymentId, payerUid: checkpoint.payerUid, amount: checkpoint.amount })
}

export async function executeRefundCreation(refundId: string): Promise<RefundExecutionResult> {
  if (!isRedisConfigured || !serverConfig.piApiKey) return { outcome: 'blocked', reason: 'unavailable' }
  let checkpoint = await getRefundCheckpointAuthoritative(refundId)
  if (!checkpoint) return { outcome: 'blocked', reason: 'not_found' }
  const firstPayment = paymentFromRedis(await redis.get(`payment:${checkpoint.paymentId}`))
  if (!firstPayment || (checkpoint.stage === 'intent_created' && !guarded(checkpoint, firstPayment))) return { outcome: 'blocked', reason: 'preflight_failed' }
  if (checkpoint.stage !== 'intent_created' && checkpoint.stage !== 'wallet_submission_started') return { outcome: 'blocked', reason: 'invalid_stage' }
  if (!await ensurePaymentOperationLock(checkpoint.paymentId, checkpoint.refundId)) return { outcome: 'blocked', reason: 'lock_conflict' }
  checkpoint = await getRefundCheckpointAuthoritative(refundId) as typeof checkpoint
  const payment = paymentFromRedis(await redis.get(`payment:${checkpoint?.paymentId}`))
  if (!checkpoint || !payment) return { outcome: 'blocked', reason: 'preflight_failed' }
  const merchantEvidence = payment.a2uTxid || payment.horizonSuccessFlag === true || payment.status === 'settled_to_merchant'
  const refundEvidence = payment.refundTxid || payment.refundStatus === 'completed'
  if (checkpoint.stage === 'intent_created' && (!guarded(checkpoint, payment) || merchantEvidence || refundEvidence)) return { outcome: 'blocked', reason: 'preflight_failed' }
  if (checkpoint.stage === 'wallet_submission_started' && (checkpoint.status !== 'pending' || checkpoint.paymentId !== payment.id || checkpoint.payerUid !== payment.payerUid || checkpoint.amount !== payment.customerAmount || merchantEvidence || refundEvidence)) return { outcome: 'blocked', reason: 'preflight_failed' }
  const reconciliation = await reconcileRefundWithPi({ paymentId: checkpoint.paymentId, refundId, idempotencyKey: checkpoint.idempotencyKey, payerUid: checkpoint.payerUid, amount: checkpoint.amount, refundPaymentId: checkpoint.refundPaymentId })
  if (reconciliation.outcome === 'INDETERMINATE') return { outcome: 'blocked', reason: 'reconciliation_uncertain' }
  if (reconciliation.outcome === 'FOUND' && reconciliation.payment) {
    if (reconciliation.payment.status.cancelled || reconciliation.payment.status.user_cancelled) return { outcome: 'blocked', reason: 'refund_cancelled' }
    if (checkpoint.refundPaymentId && checkpoint.refundPaymentId !== reconciliation.payment.identifier) return { outcome: 'blocked', reason: 'refund_id_conflict' }
    if (checkpoint.stage === 'intent_created') {
      const event: RefundAuditEvent = { eventId: crypto.randomUUID(), refundId, paymentId: checkpoint.paymentId, eventType: 'refund_submission_started', actorType: 'system', idempotencyKey: checkpoint.idempotencyKey, createdAt: new Date().toISOString(), details: { phase: 'recovered_before_create' } }
      const attempt = await beginRefundSubmissionAttempt(refundId, event)
      if (!attempt) return { outcome: 'blocked', reason: 'attempt_conflict' }
      if (!attempt.startedNow) {
        const latest = await getRefundCheckpointAuthoritative(refundId)
        if (!latest || latest.stage !== 'wallet_submission_started' || latest.status !== 'pending') return { outcome: 'blocked', reason: 'attempt_conflict' }
        const recoveryPayment = paymentFromRedis(await redis.get(`payment:${latest.paymentId}`))
        const recoveryMerchantEvidence = recoveryPayment?.a2uPaymentId || recoveryPayment?.a2uTxid || recoveryPayment?.horizonSuccessFlag === true || recoveryPayment?.status === 'settled_to_merchant'
        const recoveryRefundEvidence = recoveryPayment?.refundPaymentId || recoveryPayment?.refundTxid || recoveryPayment?.refundStatus === 'completed'
        if (!recoveryPayment || latest.paymentId !== recoveryPayment.id || latest.payerUid !== recoveryPayment.payerUid || latest.amount !== recoveryPayment.customerAmount || recoveryMerchantEvidence || recoveryRefundEvidence) return { outcome: 'blocked', reason: 'attempt_conflict' }
        const recovery = await reconcileRefundWithPi({ paymentId: latest.paymentId, refundId, idempotencyKey: latest.idempotencyKey, payerUid: latest.payerUid, amount: latest.amount, refundPaymentId: latest.refundPaymentId })
        if (recovery.outcome !== 'FOUND' || !recovery.payment || recovery.payment.status.cancelled || recovery.payment.status.user_cancelled) return { outcome: 'blocked', reason: recovery.payment?.status.cancelled || recovery.payment?.status.user_cancelled ? 'refund_cancelled' : 'attempt_conflict' }
        checkpoint = latest
        if (checkpoint.refundPaymentId && checkpoint.refundPaymentId !== recovery.payment.identifier) return { outcome: 'blocked', reason: 'refund_id_conflict' }
        const persisted = await persistRefundPaymentIdWithAudit(refundId, checkpoint.paymentId, checkpoint.idempotencyKey, recovery.payment.identifier, { eventId: crypto.randomUUID(), refundId, paymentId: checkpoint.paymentId, eventType: 'refund_payment_identified', actorType: 'system', idempotencyKey: checkpoint.idempotencyKey, createdAt: new Date().toISOString(), details: { refundPaymentId: recovery.payment.identifier, recovered: true } })
        return persisted ? { outcome: 'found', refundId, paymentId: checkpoint.paymentId, amount: checkpoint.amount, refundPaymentId: recovery.payment.identifier } : { outcome: 'blocked', reason: 'refund_id_persistence_conflict' }
      }
      checkpoint = attempt.checkpoint
    }
    if (!checkpoint.refundPaymentId) {
      const persisted = await persistRefundPaymentIdWithAudit(refundId, checkpoint.paymentId, checkpoint.idempotencyKey, reconciliation.payment.identifier, { eventId: crypto.randomUUID(), refundId, paymentId: checkpoint.paymentId, eventType: 'refund_payment_identified', actorType: 'system', idempotencyKey: checkpoint.idempotencyKey, createdAt: new Date().toISOString(), details: { refundPaymentId: reconciliation.payment.identifier, recovered: true } })
      if (!persisted) return { outcome: 'blocked', reason: 'refund_id_persistence_conflict' }
    }
    return { outcome: 'found', refundId, paymentId: checkpoint.paymentId, amount: checkpoint.amount, refundPaymentId: reconciliation.payment.identifier }
  }
  if (checkpoint.stage === 'wallet_submission_started') return { outcome: 'blocked', reason: 'submission_outcome_uncertain' }
  if (checkpoint.stage !== 'intent_created') return { outcome: 'blocked', reason: 'invalid_stage' }
  if (checkpoint.stage === 'intent_created') {
    const event: RefundAuditEvent = { eventId: crypto.randomUUID(), refundId, paymentId: checkpoint.paymentId, eventType: 'refund_submission_started', actorType: 'system', idempotencyKey: checkpoint.idempotencyKey, createdAt: new Date().toISOString(), details: { phase: 'refund_create' } }
    const attempt = await beginRefundSubmissionAttempt(refundId, event)
    if (!attempt || !attempt.startedNow) return { outcome: 'blocked', reason: 'attempt_conflict' }
    checkpoint = attempt.checkpoint
  }
  const response = await fetch('https://api.minepi.com/v2/payments', { method: 'POST', headers: { Authorization: `Key ${serverConfig.piApiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ payment: { amount: checkpoint.amount, memo: `FlashPay refund for ${checkpoint.paymentId}`, metadata: { type: 'refund', paymentId: checkpoint.paymentId, refundId: checkpoint.refundId, idempotencyKey: checkpoint.idempotencyKey }, uid: checkpoint.payerUid } }) }).catch(() => null)
  const reconcileAfterUncertainty = async (): Promise<RefundExecutionResult> => {
    const recovered = await reconcileRefundWithPi({ paymentId: checkpoint.paymentId, refundId, idempotencyKey: checkpoint.idempotencyKey, payerUid: checkpoint.payerUid, amount: checkpoint.amount, refundPaymentId: checkpoint.refundPaymentId })
    if (recovered.outcome !== 'FOUND' || !recovered.payment || recovered.payment.status.cancelled || recovered.payment.status.user_cancelled) return { outcome: 'blocked', reason: recovered.payment?.status.cancelled || recovered.payment?.status.user_cancelled ? 'refund_cancelled' : 'refund_create_uncertain' }
    if (checkpoint.refundPaymentId && checkpoint.refundPaymentId !== recovered.payment.identifier) return { outcome: 'blocked', reason: 'refund_id_conflict' }
    const persisted = await persistRefundPaymentIdWithAudit(refundId, checkpoint.paymentId, checkpoint.idempotencyKey, recovered.payment.identifier, { eventId: crypto.randomUUID(), refundId, paymentId: checkpoint.paymentId, eventType: 'refund_payment_identified', actorType: 'system', idempotencyKey: checkpoint.idempotencyKey, createdAt: new Date().toISOString(), details: { refundPaymentId: recovered.payment.identifier, recovered: true } })
    return persisted ? { outcome: 'found', refundId, paymentId: checkpoint.paymentId, amount: checkpoint.amount, refundPaymentId: recovered.payment.identifier } : { outcome: 'blocked', reason: 'refund_id_persistence_conflict' }
  }
  if (!response || !response.ok) return reconcileAfterUncertainty()
  const body: unknown = await response.json().catch(() => null)
  if (!isRecord(body) || typeof body.identifier !== 'string') return reconcileAfterUncertainty()
  const verified = await reconcileRefundWithPi({ paymentId: checkpoint.paymentId, refundId, idempotencyKey: checkpoint.idempotencyKey, payerUid: checkpoint.payerUid, amount: checkpoint.amount, refundPaymentId: body.identifier })
  if (verified.outcome !== 'FOUND' || !verified.payment || verified.payment.identifier !== body.identifier) return { outcome: 'blocked', reason: 'refund_create_uncertain' }
  const persisted = await persistRefundPaymentIdWithAudit(refundId, checkpoint.paymentId, checkpoint.idempotencyKey, body.identifier, { eventId: crypto.randomUUID(), refundId, paymentId: checkpoint.paymentId, eventType: 'refund_payment_identified', actorType: 'system', idempotencyKey: checkpoint.idempotencyKey, createdAt: new Date().toISOString(), details: { refundPaymentId: body.identifier } })
  if (!persisted) return { outcome: 'blocked', reason: 'refund_id_persistence_conflict' }
  return { outcome: 'found', refundId, paymentId: checkpoint.paymentId, amount: checkpoint.amount, refundPaymentId: body.identifier }
}

export async function prepareRefundExecution(refundId: string): Promise<RefundExecutionResult> {
  if (!isRedisConfigured || !refundId) return { outcome: 'blocked', reason: 'unavailable' }
  const checkpoint = await getRefundCheckpointAuthoritative(refundId)
  if (!checkpoint) return { outcome: 'blocked', reason: 'not_found' }
  const payment = paymentFromRedis(await redis.get(`payment:${checkpoint.paymentId}`))
  if (!payment || !guarded(checkpoint, payment)) return { outcome: 'blocked', reason: 'preflight_failed' }
  if (!await ensurePaymentOperationLock(checkpoint.paymentId, checkpoint.refundId)) return { outcome: 'blocked', reason: 'lock_conflict' }
  const reloaded = await getRefundCheckpointAuthoritative(refundId)
  const finalPayment = reloaded ? paymentFromRedis(await redis.get(`payment:${reloaded.paymentId}`)) : null
  if (!reloaded || reloaded.stage !== 'intent_created' || reloaded.status !== 'pending' || !finalPayment || !guarded(reloaded, finalPayment)) return { outcome: 'blocked', reason: 'preflight_failed' }
  return { outcome: 'ready_for_submission', refundId: reloaded.refundId, paymentId: reloaded.paymentId, amount: reloaded.amount }
}
