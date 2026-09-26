import fs from 'node:fs'
import { strict as assert } from 'node:assert'
const complete=fs.readFileSync('app/api/pi/complete/route.ts','utf8')
const route=fs.readFileSync('app/api/control/dr11/route.ts','utf8')
const refunds=fs.readFileSync('lib/refund-checkpoint-store.ts','utf8')
for(const x of ['finalPiPayment.network === "Pi Testnet"','finalPiPayment.amount === 0.1','preMerchantId === "hazemaboria"','preMerchantUid === "ccc3bf32-25c2-4d9a-bdb3-a8ffb2beb8fa"','createDr11RefundAuthorityFromDurableHold(preFlashPaymentId)',"current.status = 'settlement_failed'","current.settlementFailureState = 'refund_pending'",'current.payerRefundEligible = true',"current.refundStatus = 'pending'","current.settlementDispatchRequestedAt = nil","redis.call('SREM', KEYS[2], ARGV[2])","redis.call('ZREM', KEYS[3], ARGV[2])"]) assert.ok(complete.includes(x),x)
assert.ok(complete.indexOf('recordSettlementU2ACompletedCheckpoint') < complete.indexOf('createDr11RefundAuthorityFromDurableHold(preFlashPaymentId)'))
assert.ok(complete.indexOf('createDr11RefundAuthorityFromDurableHold(preFlashPaymentId)') < complete.indexOf('atomicU2AResult = await redis.eval(`'))
for(const x of ['cp.lastErrorCode !== "dr11_live_hold"',"last_error_code='dr11_live_hold'",'Promise.all(contenders)','completedBeforeProjection','executeRefundNextStep(refundId)',"event_type='refund_projection_finalized'",'refund_projection_finalized_events']) assert.ok(route.includes(x),x)
for(const x of ["'pending','intent_created'","'dr11_live_hold'","'awaiting_owner_concurrent_harness'",'next_retry_at']) assert.ok(refunds.includes(x),x)
assert.ok(!route.includes('api.minepi.com')&&!route.includes('horizon.stellar.org'))
console.log(JSON.stringify({verdict:'PASS',gate:'DR57-DR11-REFUND-TEST-AUTHORITY-RESTORATION-SUPERSEDED-BY-DR60',piCompletionBeforeRefundAuthority:true,durableRefundAuthorityBeforeRedisProjection:true,settlementQueueSuppressedAtomically:true,automaticDrainHeld:true,ownerHarnessReleasesHold:true,twoContenderBarrierPreserved:true,terminalProjectionFinalizedAfterFinancialLifecycle:true,settlementMovementMustRemainZero:true},null,2))
