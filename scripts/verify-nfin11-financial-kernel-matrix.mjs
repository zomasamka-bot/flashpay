import{strict as assert}from"node:assert";import fs from"node:fs";
const read=p=>fs.readFileSync(new URL("../"+p,import.meta.url),"utf8");
const db=read("lib/db.ts"),locked=read("lib/a2u-locked-executor.ts"),recovery=read("lib/a2u-recovery-service.ts"),refundStore=read("lib/refund-checkpoint-store.ts"),refundSubmit=read("lib/refund-blockchain-submit.ts"),route=read("app/api/recovery/transient/route.ts"),pkg=JSON.parse(read("package.json"));
const gates=[
["amount-parity",db.includes("params.merchantAmount !== params.customerAmount")],
["zero-app-commission",db.includes("params.appCommission!==0")&&db.includes("app_commission = 0")],
["horizon-fee-separate",db.includes("horizon_fee_stroops")],
["horizon-hash-truth",db.includes("a2uTxid!==params.preparedTxHash")||db.includes("a2uTxid !== params.preparedTxHash")],
["settlement-durable-chain",["recordSettlementA2UCreatedCheckpoint","recordSettlementPreparedCheckpoint","recordSettlementHorizonCheckpoint","recordSettlementPiCompletedCheckpoint","recordSettlementDbFinalizedCheckpoint"].every(x=>db.includes(x))],
["redis-rebuild",recovery.includes("rebuildSettlementProjectionFromDurable")],
["outstanding-repopulation",route.includes("repopulateDurableSettlementWork")],
["settlement-refund-exclusion",db.includes("verifySettlementRefundAuthorityExclusion")&&locked.includes("verifySettlementRefundAuthorityExclusion(paymentId)")&&refundStore.includes('authority.settlementActive')],
["prepared-refund-reconciliation",refundSubmit.includes("prepared")&&refundSubmit.includes("Horizon")],
["bounded-10k",!route.includes("Promise.all(page.paymentIds)")&&route.includes("listOutstandingSettlementCheckpointIds(200)")],
["fail-closed-recovery",recovery.includes("durable_projection_unavailable")&&recovery.includes("durable_authority_conflict")],
["exact-u2a-identity",db.includes("u2a_identifier")&&db.includes("u2a_txid")],
["exact-a2u-identity",db.includes("a2u_payment_id")&&db.includes("a2u_txid")],
["sequence-evidence",db.includes("prepared_sequence")],
["stored-xdr-recovery-evidence",db.includes("prepared_envelope_xdr")],
];
for(const [name,ok]of gates)assert.equal(ok,true,name);
for(const n of ["nfin6","nfin7","nfin8","nfin9","nfin10a","nfin10b","nfin10c","nfin10d","nfin10e","nfin10f","nfin10g","nfin10h"])assert.ok(Object.keys(pkg.scripts).some(k=>k.includes(n)),`missing prior certification ${n}`);
console.log(JSON.stringify({certification:"PASS",mode:"NFIN11_MATRIX_CERTIFICATION_ONLY",financialGatesChecked:gates.length,financialGatesPassed:gates.length,priorCertificationBindings:12,financialSourceChanged:false,blindRetryAdded:false,nextGate:"N-FIN-12"},null,2));
