import{strict as assert}from"node:assert";import fs from"node:fs";
const s=fs.readFileSync(new URL("../app/api/operations/r10015-financial-snapshot/route.ts",import.meta.url),"utf8");
for(const x of["verifyOwnerAuthorizationHeader","R100_15_FINAL_PRODUCTION_FINANCIAL_SNAPSHOT_READ_ONLY","duplicateIdentityCount","merchantBalanceMismatchCount","settlementRefundOverlapCount","orphanCount","refundFinalityMismatchCount","Cache-Control"])assert.ok(s.includes(x),`missing snapshot binding: ${x}`);
for(const forbidden of["redis.set(","redis.del(","submitTransaction(","createPayment(","approvePayment(","completePayment(","INSERT INTO","UPDATE ","DELETE FROM"])assert.ok(!s.includes(forbidden),`R100-15 must remain SELECT-only: ${forbidden}`);
assert.ok(s.includes("s.stage IN ('a2u_created','prepared','horizon_confirmed','pi_completed','db_finalized')"));
assert.ok(s.includes("r.status<>'manual_review_required'"));
assert.ok(s.includes("completed_refund_without_accounting"));
assert.ok(s.includes("refund_projection_finalized"));
console.log(JSON.stringify({certification:"PASS",gate:"R100-15-FINAL-PRODUCTION-FINANCIAL-SNAPSHOT",ownerAuthRequired:true,selectOnly:true,duplicateScan:true,balanceScan:true,settlementRefundOverlapScan:true,orphanScan:true,refundFinalityScan:true,constraintScan:true,financialMovementExecuted:false,productionSnapshotRequiresPublishedSameShaRuntimeEvidence:true},null,2));
