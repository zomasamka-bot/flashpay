import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { classifyDr11OrphanA2UPaymentDto, isDr11OrphanA2UProjectionCandidate } from '../lib/refund-dr11-orphan-a2u-recovery-rules'
import type { Payment, RefundCheckpoint } from '../lib/types'

const must = (ok: boolean, message: string) => { if (!ok) throw new Error(`DR11_ORPHAN_A2U_RECOVERY=FAIL ${message}`) }
const paymentId = '00000000-0000-4000-8000-000000000001'
const refundId = '00000000-0000-4000-8000-000000000002'
const payerUid = 'payer-uid'
const merchantUid = 'merchant-uid'
const a2uPaymentId = 'pi-a2u-id'
const now = new Date(0).toISOString()
const checkpoint: RefundCheckpoint = {
  refundId, paymentId, idempotencyKey: `dr11-live:${paymentId}`, status: 'pending', stage: 'intent_created',
  payerUid, payerUidVerifiedAt: now, amount: 0.1, currency: 'π', sourcePaymentStatus: 'settlement_failed',
  sourceSettlementState: 'refund_pending', createdAt: now, updatedAt: now, attemptCount: 0,
}
const payment: Payment = {
  id: paymentId, merchantId: 'merchant', merchantUid, amount: 0.1, customerAmount: 0.1, note: '', status: 'paid_to_app',
  createdAt: now, payerUid, a2uPaymentId, horizonSuccessFlag: false,
}
must(isDr11OrphanA2UProjectionCandidate(checkpoint, payment), 'exact observed race must classify')
must(!isDr11OrphanA2UProjectionCandidate({ ...checkpoint, idempotencyKey: `auto-refund:${paymentId}` }, payment), 'non-DR11 idempotency must block')
must(!isDr11OrphanA2UProjectionCandidate({ ...checkpoint, amount: 0.2 }, { ...payment, amount: 0.2, customerAmount: 0.2 }), 'non-0.10 amount must block')
must(!isDr11OrphanA2UProjectionCandidate(checkpoint, { ...payment, a2uTxid: 'f'.repeat(64) }), 'A2U txid must block')
must(!isDr11OrphanA2UProjectionCandidate(checkpoint, { ...payment, a2uPreparedTxHash: 'hash' }), 'prepared hash must block')
must(!isDr11OrphanA2UProjectionCandidate(checkpoint, { ...payment, a2uPreparedSequence: '1' }), 'prepared sequence must block')
must(!isDr11OrphanA2UProjectionCandidate(checkpoint, { ...payment, a2uPreparedEnvelopeXdr: 'xdr' }), 'prepared XDR must block')
must(!isDr11OrphanA2UProjectionCandidate(checkpoint, { ...payment, horizonSuccessFlag: true }), 'Horizon success must block')
must(!isDr11OrphanA2UProjectionCandidate(checkpoint, { ...payment, refundPaymentId: 'refund-pi-id' }), 'existing refund payment must block')

const dto = {
  identifier: a2uPaymentId, network: 'Pi Testnet', direction: 'app_to_user', amount: 0.1, user_uid: merchantUid,
  from_address: 'GAPP', to_address: 'GMERCHANT', metadata: { type: 'a2u_settlement', paymentId }, transaction: null,
  status: { developer_approved: false, transaction_verified: false, developer_completed: false, cancelled: false, user_cancelled: false },
}
must(classifyDr11OrphanA2UPaymentDto(dto, { paymentId, a2uPaymentId, merchantUid, amount: 0.1 }) === 'CREATED_UNMOVED', 'exact unmoved A2U must classify')
must(classifyDr11OrphanA2UPaymentDto({ ...dto, status: { ...dto.status, cancelled: true } }, { paymentId, a2uPaymentId, merchantUid, amount: 0.1 }) === 'CANCELLED_UNMOVED', 'cancelled unmoved A2U must classify')
must(classifyDr11OrphanA2UPaymentDto({ ...dto, transaction: { txid: 'a'.repeat(64), verified: false } }, { paymentId, a2uPaymentId, merchantUid, amount: 0.1 }) === 'BLOCKED', 'transaction txid must block')
must(classifyDr11OrphanA2UPaymentDto({ ...dto, transaction: { verified: true } }, { paymentId, a2uPaymentId, merchantUid, amount: 0.1 }) === 'BLOCKED', 'verified transaction must block')
must(classifyDr11OrphanA2UPaymentDto({ ...dto, status: { ...dto.status, developer_completed: true } }, { paymentId, a2uPaymentId, merchantUid, amount: 0.1 }) === 'BLOCKED', 'developer completed must block')
must(classifyDr11OrphanA2UPaymentDto({ ...dto, metadata: { type: 'a2u_settlement', paymentId: 'other' } }, { paymentId, a2uPaymentId, merchantUid, amount: 0.1 }) === 'BLOCKED', 'metadata mismatch must block')
must(classifyDr11OrphanA2UPaymentDto({ ...dto, status: { ...dto.status, user_cancelled: true } }, { paymentId, a2uPaymentId, merchantUid, amount: 0.1 }) === 'BLOCKED', 'unexpected user cancellation must block')

const executor = readFileSync(resolve(__dirname, '../lib/refund-executor.ts'), 'utf8')
must(executor.includes('isDr11OrphanA2UProjectionCandidate(checkpoint, existing)'), 'runtime candidate binding missing')
must(executor.includes('await neutralizeDr11OrphanA2UIdentifier(checkpoint, existing)'), 'runtime neutralization binding missing')
must(executor.includes('/cancel`'), 'Pi cancel endpoint missing')
must(executor.includes("return classifyDr11OrphanA2UPaymentDto(after, expected) === 'CANCELLED_UNMOVED'"), 'post-cancel confirmation gate missing')
must(executor.includes("reason: 'dr11_orphan_a2u_unproven'"), 'uncertainty fail-closed reason missing')
must(executor.includes('(stalePreRefundProjection || dr11OrphanA2UProjection)') && executor.includes('compareAndSwapPaymentProjection(checkpoint.paymentId, existing, projection)'), 'CAS repair after neutralization missing')
must(executor.indexOf('await neutralizeDr11OrphanA2UIdentifier(checkpoint, existing)') < executor.indexOf('compareAndSwapPaymentProjection(checkpoint.paymentId, existing, projection)'), 'CAS repair must occur after neutralization')

console.log('DR11_ORPHAN_A2U_RECOVERY=PASS candidate_cases=9 dto_cases=7 runtime_binding=7 fail_closed=true')
