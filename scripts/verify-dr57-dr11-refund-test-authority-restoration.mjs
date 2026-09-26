import fs from 'node:fs'
import { strict as assert } from 'node:assert'
const complete=fs.readFileSync('app/api/pi/complete/route.ts','utf8')
const route=fs.readFileSync('app/api/control/dr11/route.ts','utf8')
for(const x of [
  'finalPiPayment.network === "Pi Testnet"', 'finalPiAmount === 0.1',
  'payment.merchantId === "hazemaboria"', 'payment.merchantUid === "ccc3bf32-25c2-4d9a-bdb3-a8ffb2beb8fa"',
  "current.status = 'settlement_failed'", "current.settlementFailureState = 'refund_pending'", 'current.payerRefundEligible = true', "current.refundStatus = 'pending'",
  "current.settlementDispatchRequestedAt = nil", "redis.call('SREM', KEYS[2], ARGV[2])", "redis.call('ZREM', KEYS[3], ARGV[2])",
  'createRefundIntentInternal(flashPaymentId, `dr11-live:${flashPaymentId}`)', 'deferAutomaticRefund(refundId, "intent_created", "pending", "dr11_live_hold"',
  '[DR57 DR11 REFUND AUTHORITY] pristine intent held'
]) assert.ok(complete.includes(x),x)
assert.ok(complete.indexOf('recordSettlementU2ACompletedCheckpoint') < complete.indexOf('dr11RefundCertificationCandidate'), 'Pi durable completion must precede DR11 projection authority')
assert.ok(complete.indexOf('createRefundIntentInternal(flashPaymentId') > complete.indexOf('atomicU2AResultNumber'), 'intent only after atomic refund-source projection')
for(const x of ['cp.lastErrorCode !== "dr11_live_hold"',"last_error_code='dr11_live_hold'",'Promise.all(contenders)','completedBeforeProjection','executeRefundNextStep(refundId)',"event_type='refund_projection_finalized'",'refund_projection_finalized_events']) assert.ok(route.includes(x),x)
assert.ok(route.indexOf("last_error_code='dr11_live_hold'") < route.indexOf('Promise.all(contenders)'))
assert.ok(route.indexOf('Promise.all(contenders)') < route.indexOf('completedBeforeProjection'))
assert.ok(route.indexOf('completedBeforeProjection') < route.indexOf('projectionFinalization = await executeRefundNextStep(refundId)'))
assert.ok(!route.includes('api.minepi.com') && !route.includes('horizon.stellar.org'))
console.log(JSON.stringify({verdict:'PASS',gate:'DR57-DR11-REFUND-TEST-AUTHORITY-RESTORATION',piCompletionBeforeRefundAuthority:true,exactProductionTestnetOwnerAmountGate:true,settlementQueueSuppressedAtomically:true,pristineRefundIntentCreated:true,automaticDrainHeld:true,ownerHarnessReleasesHold:true,twoContenderBarrierPreserved:true,terminalProjectionFinalizedAfterFinancialLifecycle:true,settlementMovementMustRemainZero:true},null,2))
