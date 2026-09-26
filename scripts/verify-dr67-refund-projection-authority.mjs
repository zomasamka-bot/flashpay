import fs from 'node:fs'
const get = (p) => fs.readFileSync(p, 'utf8')
const paymentRoute = get('app/api/payments/[id]/route.ts')
const executor = get('lib/refund-executor.ts')
const dr11 = get('app/api/control/dr11/route.ts')
const checks = [
  ['GET keeps refund_pending presentation-only', paymentRoute.includes('refund_pending is a customer-facing presentation state') && !paymentRoute.includes('status: durableStatus,\n          settlementFailureState: durableStatus === "refunded"')],
  ['intent_created does not accept presentation-only projection', executor.includes("checkpoint.stage === 'intent_created' && checkpoint.status === 'pending' && !guarded(checkpoint, existing)")],
  ['repair only stale pre-refund projection', executor.includes("existing.status === 'settlement_failed' || existing.status === 'refund_pending'") && executor.includes("existing.refundStatus === 'pending'") && executor.includes("checkpoint.stage === 'intent_created'")],
  ['repair rejects merchant/refund/Horizon evidence', executor.includes('!existing.a2uPaymentId && !existing.a2uTxid') && executor.includes('existing.horizonSuccessFlag !== true') && executor.includes('!existing.refundPaymentId && !existing.refundTxid')],
  ['repair re-proves durable authority', executor.includes('const durable = await verifyOriginalU2AForRefundRecovery(checkpoint)')],
  ['repair is CAS fenced', executor.includes('compareAndSwapPaymentProjection(checkpoint.paymentId, existing, projection)')],
  ['DR11 recovery exact legacy failure only', dr11.includes("c.last_error_code='automatic_refund_blocked'") && dr11.includes("c.last_error_message='projection_conflict'")],
  ['DR11 recovery proves no accounting/audit movement', dr11.includes('count(*) FROM refund_accounting_records') && dr11.includes("count(*) FROM refund_audit_events a WHERE a.refund_id=c.refund_id)=1") && dr11.includes("a.event_type='refund_requested'")],
  ['DR11 recovery proves no merchant settlement movement', dr11.includes('s.a2u_txid IS NOT NULL')],
  ['DR11 final proof uses A2U not U2A', dr11.includes('settlement_checkpoints WHERE payment_id=$1 AND a2u_txid IS NOT NULL') && !dr11.includes('settlement_checkpoints WHERE payment_id=$1 AND u2a_txid IS NOT NULL')],
]
const failed = checks.filter(([,ok]) => !ok)
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
if (failed.length) process.exit(1)
console.log('DR67 refund projection authority certification: PASS')
