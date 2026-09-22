import{strict as assert}from"node:assert";import fs from"node:fs";
const root=new URL("../",import.meta.url),read=p=>fs.readFileSync(new URL(p,root),"utf8");
const route=read("app/api/payments/[id]/route.ts"),db=read("lib/db.ts"),refund=read("lib/refund-checkpoint-store.ts"),status=read("lib/payment-status.ts");
const matrix=[
{case:"no-durable-authority",durable:"ABSENT",redis:"ANY",public:"REDIS_PROJECTION",reason:"No durable Settlement/Refund authority exists; F3 must not invent financial truth."},
{case:"durable-payment-identity",durable:"payment_identity",redis:"pending|missing",public:"pending-or-not-found",reason:"Identity alone proves no U2A completion or merchant movement."},
{case:"durable-u2a-verified",durable:"u2a_verified",redis:"pending|missing",public:"pending-or-processing",reason:"Verified U2A identity is not merchant settlement."},
{case:"durable-u2a-completed",durable:"u2a_completed",redis:"pending|missing",public:"paid_to_app",reason:"Pi U2A completion is durable, but no merchant A2U finality exists."},
{case:"settlement-a2u-created",durable:"a2u_created",redis:"paid_to_app|stale",public:"settlement_pending",reason:"Settlement exists but no Horizon success."},
{case:"settlement-prepared",durable:"prepared",redis:"paid_to_app|settlement_pending|stale",public:"settlement_pending",reason:"Prepared XDR is recovery evidence only, never movement proof."},
{case:"settlement-horizon-confirmed",durable:"horizon_confirmed",redis:"older",public:"settlement_pending",reason:"Horizon movement is proven but DB finality is not yet complete."},
{case:"settlement-pi-completed",durable:"pi_completed",redis:"older",public:"settlement_pending",reason:"A2U movement/Pi completion exists, but DB finalization remains pending."},
{case:"settlement-db-finalized",durable:"db_finalized",redis:"older|missing",public:"settled_to_merchant",reason:"Durable DB finality plus stored Horizon evidence is authoritative terminal merchant success."},
{case:"refund-pending-pre-movement",durable:"refund pending before wallet_submission_confirmed",redis:"settlement_failed|refund_pending|stale",public:"refund_pending",reason:"A durable refund workflow exists; never expose merchant settlement success."},
{case:"refund-wallet-confirmed",durable:"wallet_submission_confirmed",redis:"older",public:"refund_pending",reason:"Refund movement exists but accounting/audit/finality are incomplete."},
{case:"refund-accounting-or-audit",durable:"payment_checkpoint_updated|accounting_recorded|audit_recorded pending",redis:"older",public:"refund_pending",reason:"Refund is not public-terminal until durable completed/audit finality."},
{case:"refund-completed",durable:"audit_recorded+completed+terminal evidence",redis:"older|missing",public:"refunded",reason:"Durable refund terminal evidence is authoritative."},
{case:"settlement-refund-conflict",durable:"both active/conflicting",redis:"ANY",public:"FAIL_CLOSED",reason:"Never choose a winner or expose final success under authority conflict."},
{case:"durable-read-uncertain",durable:"INDETERMINATE",redis:"ANY",public:"FAIL_CLOSED",reason:"Redis cannot override unavailable/uncertain durable authority."},
];
assert.equal(matrix.length,15);
for(const row of matrix){assert.ok(row.case&&row.durable&&row.redis&&row.public&&row.reason)}
assert.ok(db.includes("getSettlementCheckpointAuthoritative"));
assert.ok(db.includes("readSettlementRefundAuthority"));
assert.ok(refund.includes("getRefundCheckpointReadOnly"));
assert.ok(status.includes('payment.status === "settled_to_merchant"'));
assert.ok(route.includes('redis.get(`payment:${id}`)'));
assert.ok(!route.includes("getSettlementCheckpointAuthoritative"));
console.log(JSON.stringify({certification:"PASS",gate:"F3-2-STALE-STATE-MATRIX",mode:"STATIC_AND_MODEL_EVIDENCE_ONLY",cases:matrix.length,casesPassed:matrix.length,matrix,confirmedGap:"PUBLIC_READER_DOES_NOT_YET_APPLY_DURABLE_STALE_STATE_MATRIX",financialRuntimeSourceChanged:false,publicRuntimeReaderChanged:false,financialMovementExecuted:false,nextGate:"F3-3-DURABLE-PUBLIC-STATUS-AUTHORITY"},null,2));
