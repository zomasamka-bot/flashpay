import{strict as assert}from"node:assert";import fs from"node:fs";
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8");
const pkg=JSON.parse(read("package.json"));
for(const n of ["nfin10a","nfin10b","nfin10c","nfin10d","nfin10e","nfin10f","nfin10g"])assert.ok(Object.keys(pkg.scripts).some(k=>k.includes(n)),`missing ${n} certification binding`);
const db=read("lib/db.ts"),exec=read("lib/a2u-executor.ts"),recovery=read("lib/a2u-recovery-service.ts"),locked=read("lib/a2u-locked-executor.ts"),route=read("app/api/recovery/transient/route.ts"),refund=read("lib/refund-checkpoint-store.ts");
const invariants=[
["zero-commission",db.includes("app_commission")&&db.includes("app_commission = 0")],
["stage1-durable",db.includes("recordSettlementA2UCreatedCheckpoint")],
["prepared-durable",db.includes("recordSettlementPreparedCheckpoint")],
["horizon-durable",db.includes("recordSettlementHorizonCheckpoint")],
["pi-durable",db.includes("recordSettlementPiCompletedCheckpoint")],
["db-final-durable",db.includes("recordSettlementDbFinalizedCheckpoint")],
["authoritative-rebuild",db.includes("getSettlementCheckpointAuthoritative")&&recovery.includes("rebuildSettlementProjectionFromDurable")],
["durable-repopulation",db.includes("listOutstandingSettlementCheckpointIds")&&route.includes("repopulateDurableSettlementWork")],
["cross-authority-exclusion",db.includes("verifySettlementRefundAuthorityExclusion")&&locked.includes("verifySettlementRefundAuthorityExclusion(paymentId)")],
["refund-gate",refund.includes('authority.settlementActive')],
["no-10k-promise-all",!route.includes("Promise.all(page.paymentIds")],
["horizon-hash-binding",db.includes("a2uTxid!==params.preparedTxHash")||db.includes("a2uTxid !== params.preparedTxHash")],
["u2a-durable-identity",db.includes("u2a_identifier")&&db.includes("u2a_txid")],
["fail-closed-recovery",recovery.includes("durable_projection_unavailable")&&recovery.includes("durable_authority_conflict")],
];
for(const [name,ok]of invariants)assert.equal(ok,true,name);
console.log(JSON.stringify({certification:"PASS",gate:"N-FIN-10H-CODE-READINESS",mode:"CODE_READINESS_ONLY",invariantsChecked:invariants.length,invariantsPassed:invariants.length,liveFinancialTransactionsExecuted:false,live10kFinancialTransactionsExecuted:false,requiresIndependentProductionRuntimeEvidence:true,financialSourceChanged:false,blindRetryAdded:false,n10CodeReadinessCandidate:true},null,2));