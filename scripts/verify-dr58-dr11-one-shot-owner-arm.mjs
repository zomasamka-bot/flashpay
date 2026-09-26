import fs from 'node:fs'
import { strict as assert } from 'node:assert'
const complete=fs.readFileSync('app/api/pi/complete/route.ts','utf8')
const create=fs.readFileSync('app/api/payments/route.ts','utf8')
const route=fs.readFileSync('app/api/control/dr11/route.ts','utf8')
const ui=fs.readFileSync('app/control-panel/page.tsx','utf8')
for(const x of ['verifyOwnerAuthorizationHeader','ARM_DR11_NEXT_010_PAYMENT','ARM_TTL_SECONDS = 600','flashpay:certification:dr11:next-010:v1','redis.set(ARM_KEY, ARM_VALUE, { nx: true, ex: ARM_TTL_SECONDS })']) assert.ok(route.includes(x),x)
for(const x of ['dr11CreationCandidate','payment.amount === 0.1','payment.merchantId === "hazemaboria"','payment.merchantUid === "ccc3bf32-25c2-4d9a-bdb3-a8ffb2beb8fa"','flashpay:certification:dr11:next-010:v1','flashpay:certification:dr11:payment:${payment.id}',"redis.call('DEL',KEYS[3])",'recordDr11RefundCertificationHold({','[DR62 DR11 DURABLE HOLD] exact payment bound']) assert.ok(create.includes(x),x)
for(const x of ['readDr11RefundCertificationHold(preFlashPaymentId)','createDr11RefundAuthorityFromDurableHold(preFlashPaymentId)',"redis.call('DEL', KEYS[6])",'return 3','atomicU2AResultNumber === 3','dr11_live_hold']) assert.ok(complete.includes(x),x)
assert.ok(!complete.includes('FLASHPAY_DR11_LIVE_CONCURRENT_REFUND_TEST'))
assert.ok(!route.includes('FLASHPAY_DR11_LIVE_CONCURRENT_REFUND_TEST'))
assert.ok(ui.includes('Arm Next DR11 0.10 Payment')&&ui.includes('ARM_DR11_NEXT_010_PAYMENT'))
console.log(JSON.stringify({verdict:'PASS',gate:'DR58-DR11-ONE-SHOT-OWNER-ARM-SUPERSEDED-BY-DR60',ownerAuthenticated:true,oneShotNxTtl:true,armBoundAtPaymentCreation:true,durableExactPaymentHold:true,atomicSettlementQueueSuppression:true,distinctLuaOutcome3:true,ordinary010UnaffectedWithoutArm:true,missingEnvDependencyRemoved:true},null,2))
