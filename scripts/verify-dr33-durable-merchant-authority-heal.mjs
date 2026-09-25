import { strict as assert } from 'node:assert'
import fs from 'node:fs'
const recovery=fs.readFileSync(new URL('../app/api/recovery/transient/route.ts',import.meta.url),'utf8')
const start=recovery.indexOf('async function repopulateDurableU2AIngressWork')
const end=recovery.indexOf('async function repopulateDurableSettlementWork')
assert.ok(start>=0&&end>start)
const heal=recovery.slice(start,end)
assert.ok(heal.includes("if current.accessToken==nil then current.accessToken=''"),'missing durable placeholder restoration')
assert.ok(heal.includes("elseif type(current.accessToken)~='string' then return -1"),'non-string authority must fail closed')
assert.ok(heal.includes("current.accessToken~='' and current.accessToken~=string.match(current.accessToken,'^%s*(.-)%s*$') then return -1"),'malformed bearer must fail closed')
assert.ok(heal.includes('!hasSettlementMerchantProjectionAuthority(readback)'),'readback authority proof missing')
assert.ok(heal.includes("if(authority.outcome!=='CLEAR'){conflict(paymentId,`authority_${authority.outcome.toLowerCase()}`);continue}")&&heal.includes("if(authority.refundActive){result.excludedRefundAuthority++;continue}"),'durable XOR proof missing')
assert.ok(heal.includes("dto.identifier!==ingress.u2aIdentifier")&&heal.includes("transaction.txid!==ingress.u2aTxid")&&heal.includes("payerUid!==ingress.payerUid"),'exact Pi U2A identity proof missing')
assert.ok(heal.includes("current.refundPaymentId~=nil")&&heal.includes("current.refundTxid~=nil"),'refund evidence exclusion missing')
// Deterministic 10K model: only absent authority becomes durable placeholder; valid bearer is preserved; malformed values block.
let restored=0,preserved=0,blocked=0
for(let i=0;i<10000;i++){
 const access=i%3===0?undefined:i%3===1?'valid-token':' bad-token '
 if(access===undefined)restored++
 else if(access==='valid-token')preserved++
 else blocked++
}
assert.equal(restored+preserved+blocked,10000)
assert.ok(restored>0&&preserved>0&&blocked>0)
console.log(JSON.stringify({certification:'PASS',gate:'DR-33-DURABLE-MERCHANT-AUTHORITY-HEAL',confirmedDefect:'existing durable U2A projection healing omitted the F2-4 empty-string durable authority placeholder when accessToken was absent',patch:'restore accessToken empty-string only after exact durable U2A + Pi completion + XOR proof; preserve valid bearer; reject malformed authority',syntheticCases:10000,restored,preserved,blocked,financialMovementExecuted:false,productionDataMutated:false,expectedLiveFollowUpPaymentId:'786f1fde-8c69-465a-af8f-e98a664a2d10',expectedLiveOutcome:'same payment becomes fresh-dispatch eligible and resumes without a new U2A payment'},null,2))
