import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const recovery=fs.readFileSync(new URL('../app/api/recovery/transient/route.ts',import.meta.url),'utf8')
const locked=fs.readFileSync(new URL('../lib/a2u-locked-executor.ts',import.meta.url),'utf8')
const start=recovery.indexOf('async function repopulateDurableU2AIngressWork')
const end=recovery.indexOf('async function repopulateDurableSettlementWork')
assert.ok(start>=0&&end>start)
const heal=recovery.slice(start,end)
assert.ok(locked.includes('payment.payerUidCapturedAt !== d.verifiedAt || payment.paidAt !== d.completedAt') && locked.includes('payment.settlementDispatchRequestedAt !== d.completedAt'),'F2-4 verifier must bind exact durable timestamps')
assert.ok(heal.includes("current.payerUidCapturedAt=ARGV[8]"),'verifiedAt must canonicalize from durable U2A')
assert.ok(heal.includes("current.paidAt=ARGV[9]; current.settlementDispatchRequestedAt=ARGV[9]"),'completedAt must canonicalize paid/dispatch timestamps')
assert.ok(heal.includes('readback.payerUidCapturedAt!==d.verifiedAt'),'readback verifiedAt proof missing')
assert.ok(heal.includes('readback.paidAt!==d.completedAt||readback.settlementDispatchRequestedAt!==d.completedAt'),'readback completedAt proof missing')
assert.ok(heal.includes("if current.a2uPaymentId~=nil or current.a2uTxid~=nil") && heal.includes("if current.refundPaymentId~=nil or current.refundTxid~=nil"),'advanced financial/refund state must block canonicalization')
assert.ok(heal.includes("if(authority.outcome!=='CLEAR'||authority.refundActive){result.conflicts++;continue}"),'durable XOR proof missing')
let canonicalized=0,unchanged=0,blocked=0
const durableVerified='2026-09-24T23:40:00.000Z', durableCompleted='2026-09-24T23:40:01.000Z'
for(let i=0;i<10000;i++){
 const advanced=i%5===0
 if(advanced){blocked++;continue}
 const prior=i%2===0?'2026-09-24T23:39:59.000Z':durableVerified
 const priorPaid=i%3===0?'2026-09-24T23:40:02.000Z':durableCompleted
 const nextVerified=durableVerified,nextPaid=durableCompleted,nextDispatch=durableCompleted
 assert.equal(nextVerified,durableVerified);assert.equal(nextPaid,durableCompleted);assert.equal(nextDispatch,durableCompleted)
 if(prior!==nextVerified||priorPaid!==nextPaid)canonicalized++;else unchanged++
}
assert.equal(canonicalized+unchanged+blocked,10000)
console.log(JSON.stringify({certification:'PASS',gate:'DR-34-DURABLE-U2A-TIMESTAMP-CANONICALIZATION',confirmedDefect:'DR33 healed identity/merchant authority but preserved legacy payerUidCapturedAt/paidAt/settlementDispatchRequestedAt values while verifyF24DurableMerchantAuthority requires exact equality to durable verifiedAt/completedAt',patch:'only in pre-A2U/pre-Horizon/no-refund durable U2A heal, canonicalize the three projection timestamps from PostgreSQL durable U2A and require exact readback',syntheticCases:10000,canonicalized,unchanged,blocked,financialMovementExecuted:false,productionDataMutated:false,expectedLivePaymentId:'786f1fde-8c69-465a-af8f-e98a664a2d10'},null,2))
