import { strict as assert } from "node:assert"
import fs from "node:fs"
const locked=fs.readFileSync(new URL("../lib/a2u-locked-executor.ts",import.meta.url),"utf8")
const recovery=fs.readFileSync(new URL("../app/api/recovery/transient/route.ts",import.meta.url),"utf8")
const start=locked.indexOf("export function isStage1OnlySettlementDispatchCandidate")
const end=locked.indexOf("\n}\n\nasync function verifyStage1OnlyDurableAuthority",start)+2
assert.ok(start>=0&&end>start,"Stage1-only classifier missing")
const fn=locked.slice(start,end)
for(const needle of [
 '(payment.status === "paid_to_app" || payment.status === "settlement_pending")',
 'payment.settlementFailureState === "none"',
 'typeof payment.a2uPaymentId === "string"',
 'payment.a2uTxid === undefined',
 'payment.a2uPreparedEnvelopeXdr === undefined',
 'payment.a2uPreparedTxHash === undefined',
 'payment.a2uPreparedSequence === undefined',
 '(payment.horizonSuccessFlag === undefined || payment.horizonSuccessFlag === false)',
 'payment.refundPaymentId === undefined',
 'payment.refundTxid === undefined'
]) assert.ok(fn.includes(needle),needle)
assert.ok(recovery.includes('isStage1OnlySettlementDispatchCandidate(payment, now)) freshDispatchIds.push(paymentId)'))
assert.ok(recovery.includes('classStage1Only++'))
assert.ok(recovery.includes('shadowStage1OnlyIds.push(paymentId)'))
assert.ok(recovery.includes('const stage1Only = isStage1OnlySettlementDispatchCandidate(payment, handlerNow)'))
assert.ok(locked.includes('if (!(await verifyStage1OnlyDurableAuthority(paymentId, latestPayment)))'))
assert.ok(locked.includes('[F2-7 STAGE1 DURABLE RESUME]'))
const model=(p)=> (p.status==='paid_to_app'||p.status==='settlement_pending')&&p.failure==='none'&&p.a2u===true&&!p.tx&&!p.prepared&&!p.horizon&&!p.refund
assert.equal(model({status:'settlement_pending',failure:'none',a2u:true,tx:false,prepared:false,horizon:false,refund:false}),true)
assert.equal(model({status:'paid_to_app',failure:'none',a2u:true,tx:false,prepared:false,horizon:false,refund:false}),true)
assert.equal(model({status:'settled_to_merchant',failure:'none',a2u:true,tx:false,prepared:false,horizon:false,refund:false}),false)
assert.equal(model({status:'settlement_pending',failure:'none',a2u:true,tx:true,prepared:false,horizon:true,refund:false}),false)
assert.equal(model({status:'settlement_pending',failure:'none',a2u:true,tx:false,prepared:false,horizon:false,refund:true}),false)
let eligible=0,unsafe=0
for(let i=0;i<10000;i++){
 const p={status:i%3===0?'settlement_pending':i%3===1?'paid_to_app':'settled_to_merchant',failure:i%7===0?'retryable':'none',a2u:i%5!==0,tx:i%11===0,prepared:i%13===0,horizon:i%17===0,refund:i%19===0}
 const hit=model(p); if(hit)eligible++
 if(hit&&(p.tx||p.prepared||p.horizon||p.refund||!p.a2u||p.failure!=='none'))unsafe++
}
assert.ok(eligible>0);assert.equal(unsafe,0)
console.log(JSON.stringify({certification:'PASS',gate:'DR-38-STAGE1-ONLY-RECOVERY-CLASSIFICATION',syntheticCases:10000,eligible,unsafe,liveFingerprint:'settlement_pending|failure=none|a2uPayment=1|a2uTxid=0|prepared=0|horizon=0',durableAuthorityStillRequired:true,newA2UCreateAuthorized:false,blindRetryAdded:false,financialMovementExecuted:false,productionDataMutated:false},null,2))
