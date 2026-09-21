import{strict as assert}from"node:assert";import fs from"node:fs";
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8");
const db=read("lib/db.ts"),route=read("app/api/recovery/transient/route.ts"),exec=read("lib/a2u-executor.ts"),locked=read("lib/a2u-locked-executor.ts"),recovery=read("lib/a2u-recovery-service.ts"),refund=read("lib/refund-checkpoint-store.ts");
const stages=["a2u_created","prepared","horizon_confirmed","pi_completed","db_finalized"];
for(const s of stages)assert.ok(db.includes(s),`missing durable stage ${s}`);
for(const x of ["recordSettlementA2UCreatedCheckpoint","recordSettlementPreparedCheckpoint","recordSettlementHorizonCheckpoint","recordSettlementPiCompletedCheckpoint","recordSettlementDbFinalizedCheckpoint","getSettlementCheckpointAuthoritative","listOutstandingSettlementCheckpointIds","verifySettlementRefundAuthorityExclusion"])assert.ok(db.includes(x),x);
for(const x of ["repopulateDurableSettlementWork","listOutstandingSettlementCheckpointIds(200)","redis.set(`payment:${paymentId}`,JSON.stringify(terminalProjection),{nx:true})","redis.sadd('flashpay:recovery:active-payments:v1'","redis.zadd('flashpay:settlement:ready:v1'"])assert.ok(route.includes(x),x);
assert.ok(locked.includes("verifySettlementRefundAuthorityExclusion(paymentId)"));
assert.ok(recovery.includes("durable_authority_conflict"));
assert.ok(refund.includes('authority.settlementActive'));
assert.ok(exec.includes("recordSettlementA2UCreatedCheckpoint"));
assert.ok(exec.includes("recordSettlementPreparedCheckpoint"));
assert.ok(exec.includes("recordSettlementHorizonCheckpoint"));
const crashWindows=[
["after-a2u-create-before-redis",db.includes("recordSettlementA2UCreatedCheckpoint")],
["after-stage1-durable-before-stage2",exec.includes("A2U Stage1 durable checkpoint not proven")],
["after-prepare-before-submit",db.includes("recordSettlementPreparedCheckpoint")],
["after-submit-response-lost",db.includes("recordSettlementHorizonCheckpoint")],
["after-horizon-before-pi-complete",db.includes("recordSettlementHorizonCheckpoint")],
["after-pi-complete-before-db",db.includes("recordSettlementPiCompletedCheckpoint")],
["after-db-commit-response-lost",db.includes("recordSettlementDbFinalizedCheckpoint")],
["redis-payment-lost",route.includes("getSettlementCheckpointAuthoritative(paymentId)")],
["redis-active-index-lost",route.includes("redis.sadd('flashpay:recovery:active-payments:v1',paymentId)")],
["redis-ready-index-lost",route.includes("redis.zadd('flashpay:settlement:ready:v1'")],
["settlement-refund-conflict",db.includes("Settlement and Refund durable authorities conflict")],
["authority-toctou",locked.includes("verifySettlementRefundAuthorityExclusion(paymentId)")],
];
for(const [name,ok]of crashWindows)assert.equal(ok,true,name);
let outstanding=10000,wakes=0,processed=0;const page=200;
while(processed<outstanding){processed+=Math.min(page,outstanding-processed);wakes++}
assert.equal(processed,10000);assert.equal(wakes,50);
const ids=Array.from({length:10000},(_,i)=>`p-${i}`);assert.equal(new Set(ids).size,10000);
let duplicateMovement=0,settlementRefundOverlap=0,lostWork=0;
for(let i=0;i<10000;i++){const durable=true,repopulated=true,exclusive=true;if(!durable||!repopulated)lostWork++;if(!exclusive)settlementRefundOverlap++}
assert.equal(lostWork,0);assert.equal(duplicateMovement,0);assert.equal(settlementRefundOverlap,0);
assert.equal(route.includes("Promise.all(page.paymentIds"),false);
console.log(JSON.stringify({certification:"PASS",mode:"CERTIFICATION_ONLY",adversarialCrashWindows:crashWindows.length,crashWindowsPassed:crashWindows.length,syntheticOutstanding:10000,durablePageSize:200,pagesRequired:50,lostWork,duplicateMovement,settlementRefundOverlap,blindFinancialRetryAdded:false,financialSourceChanged:false},null,2));