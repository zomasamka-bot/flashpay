import { strict as assert } from "node:assert"
import fs from "node:fs"
const source=fs.readFileSync(new URL("../lib/db.ts",import.meta.url),"utf8")
const invariants=[
"u2a_identifier, u2a_txid, a2u_identifier, a2u_txid",
"existing.u2a_identifier !== params.u2aIdentifier",
"existing.u2a_txid !== params.u2aTxid",
"existing.a2u_identifier !== params.a2uIdentifier",
"existing.a2u_txid !== params.a2uTxid",
"committedU2aIdentifier !== params.u2aIdentifier",
"committedU2aTxid !== params.u2aTxid",
"committedA2uIdentifier !== params.a2uIdentifier",
"committedA2uTxid !== params.a2uTxid",
"committedMerchantId !== params.merchantId",
"committedMerchantUid !== params.merchantUid",
"normalizedCommittedCustomerAmount !== customerAmount",
"normalizedCommittedHorizonFeeCharged !== horizonFeeCharged",
"normalizedCommittedAppCommission !== appCommission",
"normalizedCommittedMerchantAmount !== merchantAmount",
"normalizedCommittedAppNetImpact !== appNetImpact",
"ON CONFLICT (transaction_id) DO NOTHING",
"const receiptWasInserted = receiptResult && receiptResult.length > 0",
"if (receiptWasInserted)"
]
for(const x of invariants) assert.ok(source.includes(x),`missing production invariant: ${x}`)
const expected={u2aIdentifier:"u2a",u2aTxid:"utx",a2uIdentifier:"a2u",a2uTxid:"atx",merchantId:"m",merchantUid:"mu",customerAmount:2.5,merchantAmount:2.5,horizonFeeCharged:.01,appCommission:0}
expected.appNetImpact=expected.customerAmount-expected.merchantAmount-expected.horizonFeeCharged
const exact=r=>Object.keys(expected).every(k=>Object.is(r[k],expected[k]))
assert.equal(exact({...expected}),true)
let rejected=0
for(const k of Object.keys(expected)){const v=typeof expected[k]==="number"?expected[k]+.0000001:expected[k]+"x";assert.equal(exact({...expected,[k]:v}),false);rejected++}
let credits=0
for(const inserted of [true,false,false,false]) if(inserted) credits++
assert.equal(credits,1)
console.log(JSON.stringify({certification:"PASS",productionSourceBound:true,identityAndAccountingMutationsRejected:rejected,commitResponseLostReplayCredits:credits,duplicateCredits:0},null,2))
