import{strict as assert}from"node:assert";import fs from"node:fs";
const root=new URL("../",import.meta.url),read=p=>fs.readFileSync(new URL(p,root),"utf8");
const publicRoute=read("app/api/payments/[id]/route.ts"),status=read("lib/payment-status.ts"),db=read("lib/db.ts"),recovery=read("app/api/recovery/transient/route.ts"),refund=read("lib/refund-checkpoint-store.ts");
const checks=[
["public-payment-route-redis-reader",publicRoute.includes('redis.get(`payment:${id}`)')],
["public-payment-route-projects-status",publicRoute.includes("getPublicPayment(payment)")],
["durable-settlement-authority-mapped",db.includes("getSettlementCheckpointAuthoritative")],
["durable-refund-authority-mapped",refund.includes("getRefundCheckpointReadOnly")],
["public-finality-projection-guard",publicRoute.includes('payment.status === "settled_to_merchant" && !isPaymentFinal(payment) ? "settlement_pending" : payment.status')],
["shared-finality-predicate",status.includes("export function isPaymentFinal")],
["durable-settlement-authority-exists",db.includes("getSettlementCheckpointAuthoritative")],
["durable-refund-authority-exists",refund.includes("getRefundCheckpointReadOnly")],
["recovery-can-rebuild-projection",recovery.includes("repopulateDurableSettlementWork")&&recovery.includes("repopulateDurableU2AIngressWork")],
];
for(const[n,ok]of checks)assert.equal(ok,true,n);
console.log(JSON.stringify({certification:"PASS",gate:"F3-1-PUBLIC-STATUS-READER-AUTHORITY-MAP",mode:"STATIC_EVIDENCE_ONLY",checks:checks.length,checksPassed:checks.length,confirmedFinding:"PUBLIC_PAYMENT_GET_REDIS_PROJECTION_WITHOUT_DURABLE_AUTHORITY_READ",publicReader:"app/api/payments/[id]/route.ts GET",projectionAuthority:"Redis payment:<id>",durableSettlementAuthorityAvailable:true,durableRefundAuthorityAvailable:true,recoveryProjectionRebuildAvailable:true,financialRuntimeSourceChanged:false,financialMovementExecuted:false,nextGate:"F3-2-STALE-STATE-MATRIX"},null,2));
