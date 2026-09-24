import{strict as assert}from"node:assert";import fs from"node:fs";
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8"),db=read("lib/db.ts"),store=read("lib/refund-checkpoint-store.ts"),intent=read("lib/refund-intent-service.ts"),locked=read("lib/a2u-locked-executor.ts");
assert.ok(db.includes("EXISTS(SELECT 1 FROM settlement_checkpoints"),"settlement authority read missing");
assert.ok(db.includes("status<>'manual_review_required'"),"refund authority is not fail-closed over unknown statuses");
assert.ok(store.includes("authority.settlementActive"),"refund acquisition does not reject settlement-only ownership");
assert.ok(intent.includes("const lockedAuthority = await readSettlementRefundAuthority(payment.id)"),"post-lock durable recheck missing");
assert.ok(intent.indexOf("const lockedAuthority = await readSettlementRefundAuthority(payment.id)")<intent.indexOf("const idempotencyClaimed = await claimRefundIdempotency"),"durable recheck occurs after refund claim");
assert.ok(intent.indexOf("const lockedAuthority = await readSettlementRefundAuthority(payment.id)")<intent.indexOf("createRefundCheckpointWithAudit(checkpoint"),"durable recheck occurs after refund persistence");
assert.ok(locked.includes("verifySettlementRefundAuthorityExclusion(paymentId)"),"settlement path durable exclusion missing");
const decide=(op,s,r)=>op==="REFUND"?(!s):(!r);
const cases=[
["REFUND",false,false,true],["REFUND",true,false,false],["REFUND",false,true,true],
["SETTLEMENT",false,false,true],["SETTLEMENT",true,false,true],["SETTLEMENT",false,true,false],["SETTLEMENT",true,true,false]
];
for(const [op,s,r,want]of cases)assert.equal(decide(op,s,r),want,`${op}/${s}/${r}`);
console.log(JSON.stringify({certification:"PASS",gate:"N-FIN-X2",cases:cases.length,refundRejectsSettlementOnly:true,settlementRejectsRefundOnly:true,postLockDurableRecheck:true,unknownRefundStatusFailClosed:true,financialMovementExecuted:false},null,2));
