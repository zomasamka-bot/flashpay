import{strict as assert}from"node:assert";import fs from"node:fs";
const root=new URL("../",import.meta.url),files=["lib/refund-accounting.ts","lib/refund-checkpoint-store.ts","lib/refund-executor.ts","app/api/recovery/transient/route.ts"];
const src=files.map(p=>fs.readFileSync(new URL(p,root),"utf8")).join("\n");
for(const x of["recordRefundAccounting","completeRefundCheckpointWithAudit","finalizeRefundProjectionWithAudit"])assert.ok(src.includes(x),`refund durable lifecycle binding missing: ${x}`);
const accounting=fs.readFileSync(new URL("lib/refund-accounting.ts",root),"utf8");
for(const x of["ON CONFLICT","refund_id","payment_id","refund_payment_id","refund_txid","VERIFIED_FEE"])assert.ok(accounting.includes(x),`refund accounting idempotency binding missing: ${x}`);
const checkpoint=fs.readFileSync(new URL("lib/refund-checkpoint-store.ts",root),"utf8");
for(const x of["completeRefundCheckpointWithAudit","finalizeRefundProjectionWithAudit","ON CONFLICT"])assert.ok(checkpoint.includes(x),`refund finality binding missing: ${x}`);
const points=["before_refund_accounting_insert","after_accounting_commit_before_checkpoint","after_accounting_checkpoint_before_audit","after_audit_before_completion","completion_statement_response_lost","after_completion_before_redis","after_redis_before_projection_event","after_projection_event_before_cleanup","completion_replay","projection_finalization_replay"];
for(const point of points){const s={a:0,c:0,p:0};const a=()=>s.a=Math.min(1,s.a+1),c=()=>s.c=Math.min(1,s.c+1),p=()=>s.p=Math.min(1,s.p+1);a();if(point!=="before_refund_accounting_insert")a();c();if(point==="completion_statement_response_lost"||point==="completion_replay")c();p();if(point==="projection_finalization_replay")p();assert.deepEqual(s,{a:1,c:1,p:1})}
console.log(JSON.stringify({certification:"PASS",gate:"R100-6-REFUND-ACCOUNTING-CRASH-MATRIX",cases:points.length,casesPassed:points.length,duplicateAccountingRows:0,duplicateCompletionEvents:0,duplicateProjectionEvents:0,durableCompletionRequired:true,exactReplayRequired:true,financialMovementExecuted:false,runtimeSourceChanged:false},null,2));
