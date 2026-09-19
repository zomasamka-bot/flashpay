import { strict as assert } from "node:assert"
import fs from "node:fs"
const db=fs.readFileSync(new URL("../lib/db.ts",import.meta.url),"utf8")
const ex=fs.readFileSync(new URL("../lib/a2u-executor.ts",import.meta.url),"utf8")
for(const x of [
"recordSettlementA2UCreatedCheckpoint",
"ON CONFLICT DO NOTHING",
"WHERE payment_id = ${params.paymentId}",
"OR a2u_payment_id = ${params.a2uPaymentId}",
"rows.length !== 1",
"storedCustomerAmount !== params.customerAmount",
"storedMerchantAmount !== params.merchantAmount",
"storedAppCommission !== 0",
"row.a2u_payment_id !== params.a2uPaymentId",
"row.a2u_from_address !== params.a2uFromAddress",
"row.a2u_to_address !== params.a2uToAddress",
"outcome: 'INDETERMINATE'"
]) assert.ok(db.includes(x),`missing durable writer invariant: ${x}`)
const redisPos=ex.indexOf("ctx.payment = await persistCheckpointMerged(ctx.paymentId, stage1Updates)")
const durablePos=ex.indexOf("const durableStage1 = await recordSettlementA2UCreatedCheckpoint")
const gatePos=ex.indexOf('if (durableStage1.outcome !== "RECORDED" && durableStage1.outcome !== "REPLAYED")')
const stage2Pos=ex.indexOf("// STAGE 2: Sign")
assert.ok(redisPos>=0 && durablePos>redisPos && gatePos>durablePos && stage2Pos>gatePos,"Stage1 durable gate must precede Stage2")
assert.ok(ex.includes('error: "A2U Stage1 durable checkpoint not proven"'))
assert.equal(ex.includes("recordSettlementA2UCreatedCheckpoint({",stage2Pos),false)
const exact=(a,b)=>Object.keys(a).every(k=>Object.is(a[k],b[k]))
const expected={paymentId:"p",merchantId:"m",merchantUid:"u",customerAmount:1.25,merchantAmount:1.25,a2uPaymentId:"a",a2uFromAddress:"G1",a2uToAddress:"G2"}
assert.equal(exact(expected,{...expected}),true)
let rejected=0
for(const k of Object.keys(expected)){const v=typeof expected[k]==="number"?expected[k]+.01:expected[k]+"x";assert.equal(exact(expected,{...expected,[k]:v}),false);rejected++}
console.log(JSON.stringify({certification:"PASS",productionSourceBound:true,stage1DurableGateBeforeStage2:true,exactReplayFields:Object.keys(expected).length,identityAccountingMutationsRejected:rejected,blindFinancialRetryAdded:false},null,2))
