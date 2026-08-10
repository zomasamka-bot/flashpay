import { redis, isRedisConfigured } from './redis'
import {
  ensurePaymentOperationLock,
  getRefundCheckpointAuthoritative,
  persistRefundPaymentIdWithAudit,
  refundPreflight,
  beginRefundSubmissionAttempt,
  beginRefundBlockchainSubmissionClaim,
  persistRefundBlockchainTxWithAudit,
  advanceRefundPaymentCheckpointWithAudit,
} from './refund-checkpoint-store'
import { isRefundEligible, type Payment, type RefundAuditEvent, type RefundCheckpoint } from './types'
import { reconcileRefundWithPi } from './refund-pi-reconciliation'
import { verifyRefundBlockchainEvidence } from './refund-blockchain-evidence'
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
  if (verified.payment.status.cancelled || verified.payment.status.user_cancelled) return { outcome: 'blocked', reason: 'refund_cancelled' }
  const persisted = await persistRefundPaymentIdWithAudit(refundId, checkpoint.paymentId, checkpoint.idempotencyKey, body.identifier, { eventId: crypto.randomUUID(), refundId, paymentId: checkpoint.paymentId, eventType: 'refund_payment_identified', actorType: 'system', idempotencyKey: checkpoint.idempotencyKey, createdAt: new Date().toISOString(), details: { refundPaymentId: body.identifier } })
  if (!persisted) return { outcome: 'blocked', reason: 'refund_id_persistence_conflict' }
  return { outcome: 'found', refundId, paymentId: checkpoint.paymentId, amount: checkpoint.amount, refundPaymentId: body.identifier }
}

export async function executeRefundBlockchain(refundId: string): Promise<RefundExecutionResult> {
  if (!isRedisConfigured || !serverConfig.piApiKey) return { outcome: 'blocked', reason: 'unavailable' }
  let checkpoint = await getRefundCheckpointAuthoritative(refundId)
  if (!checkpoint || checkpoint.stage !== 'wallet_submission_started' || checkpoint.status !== 'pending' || !checkpoint.refundPaymentId) return { outcome: 'blocked', reason: 'invalid_stage' }
  if (!await ensurePaymentOperationLock(checkpoint.paymentId, checkpoint.refundId)) return { outcome: 'blocked', reason: 'lock_conflict' }
  checkpoint = await getRefundCheckpointAuthoritative(refundId)
  const payment = checkpoint ? paymentFromRedis(await redis.get(`payment:${checkpoint.paymentId}`)) : null
  const merchant = payment?.a2uPaymentId || payment?.a2uTxid || payment?.horizonSuccessFlag === true || payment?.status === 'settled_to_merchant'
  const refund = payment?.refundPaymentId || payment?.refundTxid || payment?.refundStatus === 'completed'
  if (!checkpoint || !payment || checkpoint.stage !== 'wallet_submission_started' || checkpoint.status !== 'pending' || checkpoint.refundPaymentId === undefined || checkpoint.paymentId !== payment.id || checkpoint.payerUid !== payment.payerUid || checkpoint.amount !== payment.customerAmount || merchant || refund) return { outcome: 'blocked', reason: 'preflight_failed' }
  const refundPaymentId = checkpoint.refundPaymentId
  const reconciliation = await reconcileRefundWithPi({ paymentId: checkpoint.paymentId, refundId, idempotencyKey: checkpoint.idempotencyKey, payerUid: checkpoint.payerUid, amount: checkpoint.amount, refundPaymentId: checkpoint.refundPaymentId })
  if (reconciliation.outcome === 'INDETERMINATE' || !reconciliation.payment) return { outcome: 'blocked', reason: 'reconciliation_uncertain' }
  if (reconciliation.payment.status.cancelled || reconciliation.payment.status.user_cancelled) return { outcome: 'blocked', reason: 'refund_cancelled' }
  const evidence = await import('./refund-blockchain-evidence').then(({ verifyRefundBlockchainEvidence }) => verifyRefundBlockchainEvidence({ checkpoint, payment: reconciliation.payment! }))
  if (evidence.outcome === 'VERIFIED_TX') {
    const persisted = await persistRefundBlockchainTxWithAudit(refundId, checkpoint.paymentId, checkpoint.idempotencyKey, refundPaymentId, evidence.txid, { eventId: crypto.randomUUID(), refundId, paymentId: checkpoint.paymentId, eventType: 'refund_submission_confirmed', actorType: 'system', idempotencyKey: checkpoint.idempotencyKey, createdAt: new Date().toISOString(), details: { refundPaymentId, refundTxid: evidence.txid, recovered: true } })
    return persisted ? { outcome: 'found', refundId, paymentId: checkpoint.paymentId, amount: checkpoint.amount, refundPaymentId } : { outcome: 'blocked', reason: 'tx_persistence_conflict' }
  }
  if (evidence.outcome === 'INDETERMINATE') return { outcome: 'blocked', reason: 'blockchain_uncertain' }
  const claim = await beginRefundBlockchainSubmissionClaim(refundId, checkpoint.paymentId, checkpoint.idempotencyKey, checkpoint.refundPaymentId)
  if (!claim || !claim.startedNow) return { outcome: 'blocked', reason: 'blockchain_claim_conflict' }
  const submission = await import('./refund-blockchain-submit').then(({ submitRefundBlockchainOnce }) => submitRefundBlockchainOnce({ checkpoint: claim.checkpoint, payment: reconciliation.payment! }))
  if (submission.outcome !== 'CONFIRMED_TX') return { outcome: 'blocked', reason: submission.code }
  const persisted = await persistRefundBlockchainTxWithAudit(refundId, checkpoint.paymentId, checkpoint.idempotencyKey, checkpoint.refundPaymentId, submission.txid, { eventId: crypto.randomUUID(), refundId, paymentId: checkpoint.paymentId, eventType: 'refund_submission_confirmed', actorType: 'system', idempotencyKey: checkpoint.idempotencyKey, createdAt: new Date().toISOString(), details: { refundPaymentId: checkpoint.refundPaymentId, refundTxid: submission.txid } })
  return persisted ? { outcome: 'found', refundId, paymentId: checkpoint.paymentId, amount: checkpoint.amount, refundPaymentId: checkpoint.refundPaymentId } : { outcome: 'blocked', reason: 'tx_persistence_conflict' }
}

export async function executeRefundCompletion(refundId: string): Promise<RefundExecutionResult> {
  if (!isRedisConfigured || !serverConfig.piApiKey) return { outcome: 'blocked', reason: 'unavailable' }
  let checkpoint = await getRefundCheckpointAuthoritative(refundId)
  if (!checkpoint || (checkpoint.stage !== 'wallet_submission_confirmed' && checkpoint.stage !== 'payment_checkpoint_updated') || checkpoint.status !== 'pending' || !checkpoint.refundPaymentId || !checkpoint.refundTxid) return { outcome: 'blocked', reason: 'invalid_stage' }
  if (!await ensurePaymentOperationLock(checkpoint.paymentId, checkpoint.refundId)) return { outcome: 'blocked', reason: 'lock_conflict' }
  checkpoint = await getRefundCheckpointAuthoritative(refundId)
  const payment = checkpoint ? paymentFromRedis(await redis.get(`payment:${checkpoint.paymentId}`)) : null
  if (checkpoint?.stage === 'payment_checkpoint_updated') {
    if (!payment || checkpoint.status !== 'pending' || checkpoint.paymentId !== payment.id || checkpoint.refundPaymentId !== payment.refundPaymentId || checkpoint.refundTxid !== payment.refundTxid || payment.status !== 'refund_pending' || payment.refundStatus !== 'submitted') return { outcome: 'blocked', reason: 'checkpoint_conflict' }
    return { outcome: 'found', refundId, paymentId: checkpoint.paymentId, amount: checkpoint.amount, refundPaymentId: checkpoint.refundPaymentId }
  }
  const merchant = payment?.a2uPaymentId || payment?.a2uTxid || payment?.horizonSuccessFlag === true || payment?.status === 'settled_to_merchant'
  if (!checkpoint || !payment || checkpoint.stage !== 'wallet_submission_confirmed' || checkpoint.status !== 'pending' || checkpoint.paymentId !== payment.id || checkpoint.payerUid !== payment.payerUid || checkpoint.amount !== payment.customerAmount || payment.refundPaymentId && payment.refundPaymentId !== checkpoint.refundPaymentId || payment.refundTxid && payment.refundTxid !== checkpoint.refundTxid || merchant || payment.refundStatus === 'completed') return { outcome: 'blocked', reason: 'preflight_failed' }
  const reconciliation = await reconcileRefundWithPi({ paymentId: checkpoint.paymentId, refundId, idempotencyKey: checkpoint.idempotencyKey, payerUid: checkpoint.payerUid, amount: checkpoint.amount, refundPaymentId: checkpoint.refundPaymentId })
  if (reconciliation.outcome !== 'FOUND' || !reconciliation.payment || reconciliation.payment.status.cancelled || reconciliation.payment.status.user_cancelled) return { outcome: 'blocked', reason: 'pi_evidence_uncertain' }
  const blockchainEvidence = await verifyRefundBlockchainEvidence({ checkpoint, payment: reconciliation.payment })
  if (blockchainEvidence.outcome !== 'VERIFIED_TX' || blockchainEvidence.txid !== checkpoint.refundTxid) return { outcome: 'blocked', reason: 'blockchain_evidence_uncertain' }
  if (reconciliation.payment.transaction === null || reconciliation.payment.transaction.txid !== checkpoint.refundTxid || !reconciliation.payment.transaction.verified || !reconciliation.payment.status.transaction_verified || !reconciliation.payment.status.developer_completed) return { outcome: 'blocked', reason: 'pi_evidence_uncertain' }
  const response = await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(checkpoint.refundPaymentId)}/complete`, { method: 'POST', headers: { Authorization: `Key ${serverConfig.piApiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ txid: checkpoint.refundTxid }) }).catch(() => null)
  let completed = false
  if (response?.ok) {
    const body: unknown = await response.json().catch(() => null)
    if (isRecord(body) && body.identifier === checkpoint.refundPaymentId) completed = true
  }
  const confirmed = await reconcileRefundWithPi({ paymentId: checkpoint.paymentId, refundId, idempotencyKey: checkpoint.idempotencyKey, payerUid: checkpoint.payerUid, amount: checkpoint.amount, refundPaymentId: checkpoint.refundPaymentId })
  if (confirmed.outcome !== 'FOUND' || !confirmed.payment || confirmed.payment.identifier !== checkpoint.refundPaymentId || confirmed.payment.transaction === null || confirmed.payment.transaction.txid !== checkpoint.refundTxid || !confirmed.payment.transaction.verified || !confirmed.payment.status.transaction_verified || !confirmed.payment.status.developer_completed || confirmed.payment.status.cancelled || confirmed.payment.status.user_cancelled) return { outcome: 'blocked', reason: completed ? 'completion_unverified' : 'completion_uncertain' }
  const updatedPayment: Payment = { ...payment, status: 'refund_pending', refundStatus: 'submitted', refundPaymentId: checkpoint.refundPaymentId, refundTxid: checkpoint.refundTxid, settlementFailureState: 'refund_pending' } as Payment
  await redis.set(`payment:${payment.id}`, updatedPayment)
  const advanced = await advanceRefundPaymentCheckpointWithAudit(refundId, checkpoint.paymentId, checkpoint.idempotencyKey, checkpoint.refundPaymentId, checkpoint.refundTxid, { eventId: crypto.randomUUID(), refundId, paymentId: checkpoint.paymentId, eventType: 'refund_payment_checkpoint_updated', actorType: 'system', idempotencyKey: checkpoint.idempotencyKey, createdAt: new Date().toISOString(), details: { refundPaymentId: checkpoint.refundPaymentId, refundTxid: checkpoint.refundTxid } })
  return advanced ? { outcome: 'found', refundId, paymentId: checkpoint.paymentId, amount: checkpoint.amount, refundPaymentId: checkpoint.refundPaymentId } : { outcome: 'blocked', reason: 'checkpoint_conflict' }
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
