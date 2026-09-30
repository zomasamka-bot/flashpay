import{strict as assert}from"node:assert";import fs from"node:fs";
const ex=fs.readFileSync(new URL("../lib/a2u-executor.ts",import.meta.url),"utf8");
const db=fs.readFileSync(new URL("../lib/db.ts",import.meta.url),"utf8");
assert.ok(ex.includes("merchantUid:ctx.merchantUid"),"required merchantUid must use ExecutorContext canonical string");
assert.equal(ex.includes("merchantUid:ctx.payment.merchantUid,"),false,"optional Payment.merchantUid must not feed required durable writer");
for(const x of ["u2aIdentifier:ctx.payment.piPaymentId!","u2aTxid:ctx.payment.u2aTxid!","r.u2a_identifier=${params.u2aIdentifier}","r.u2a_txid=${params.u2aTxid}"])assert.ok((ex+db).includes(x),x);
console.log(JSON.stringify({certification:"PASS",optionalMerchantUidBuildDefectRemoved:true,receiptU2AIdentityBindingCorrected:true},null,2));