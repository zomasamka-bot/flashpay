import { redis, isRedisConfigured } from './redis'
import {
  ensurePaymentOperationLock,
  getRefundCheckpointAuthoritative,
  refundPreflight,
} from './refund-checkpoint-store'
import { isRefundEligible, type Payment } from './types'

export type RefundExecutionResult =
  | { outcome: 'ready_for_submission'; refundId: string; paymentId: string; amount: number }
  | { outcome: 'blocked'; reason: 'unavailable' | 'not_found' | 'stale' | 'ineligible' | 'lock_conflict' | 'checkpoint_conflict' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function paymentFromRedis(value: unknown): Payment | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === 'string' ? value.id : ''
  const payerUid = typeof value.payerUid === 'string' ? value.payerUid : typeof value.payer_uid === 'string' ? value.payer_uid : ''
  const customerAmount = typeof value.customerAmount === 'number' ? value.customerAmount : typeof value.customer_amount === 'number' ? value.customer_amount : Number(value.customerAmount ?? value.customer_amount)
  if (!id || !payerUid || !Number.isFinite(customerAmount) || customerAmount <= 0) return null
  return {
    ...value,
    id,
    payerUid,
    customerAmount,
    payerUidSource: value.payerUidSource ?? value.payer_uid_source,
    payerUidCapturedAt: value.payerUidCapturedAt ?? value.payer_uid_captured_at,
    settlementFailureState: value.settlementFailureState ?? value.settlement_failure_state,
    refundStatus: value.refundStatus ?? value.refund_status,
  } as Payment
}

export async function prepareRefundExecution(refundId: string): Promise<RefundExecutionResult> {
  if (!isRedisConfigured || !refundId) return { outcome: 'blocked', reason: 'unavailable' }
  const checkpoint = await getRefundCheckpointAuthoritative(refundId)
  if (!checkpoint) return { outcome: 'blocked', reason: 'not_found' }
  const stored = await redis.get(`payment:${checkpoint.paymentId}`)
  const payment = paymentFromRedis(stored)
  if (!payment) return { outcome: 'blocked', reason: 'stale' }
  if (!isRefundEligible(payment)) return { outcome: 'blocked', reason: 'ineligible' }
  if (!await ensurePaymentOperationLock(checkpoint.paymentId, checkpoint.refundId)) {
    return { outcome: 'blocked', reason: 'lock_conflict' }
  }
  const reloaded = await getRefundCheckpointAuthoritative(refundId)
  if (!reloaded || reloaded.stage !== 'intent_created' || reloaded.status !== 'pending') {
    return { outcome: 'blocked', reason: 'stale' }
  }
  const finalPayment = paymentFromRedis(await redis.get(`payment:${reloaded.paymentId}`))
  const merchantEvidence = finalPayment?.a2uTxid || finalPayment?.horizonSuccessFlag === true || finalPayment?.status === 'settled_to_merchant' || finalPayment?.settlementStage === 'settled'
  const refundEvidence = finalPayment?.refundTxid || finalPayment?.refundStatus === 'completed'
  if (!finalPayment || merchantEvidence || refundEvidence || !isRefundEligible(finalPayment) || !refundPreflight(reloaded, finalPayment, {
    paymentId: reloaded.paymentId,
    payerUid: reloaded.payerUid,
    amount: reloaded.amount,
  })) return { outcome: 'blocked', reason: 'ineligible' }
  return { outcome: 'ready_for_submission', refundId: reloaded.refundId, paymentId: reloaded.paymentId, amount: reloaded.amount }
}
