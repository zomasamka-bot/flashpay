import fs from "node:fs"; import path from "node:path";
const root=process.cwd(); const e=fs.readFileSync(path.join(root,"lib/a2u-executor.ts"),"utf8"); const t=fs.readFileSync(path.join(root,"lib/types.ts"),"utf8");
function must(v:boolean,n:string){if(!v)throw new Error(`FAIL ${n}`);console.log(`PASS ${n}`)}
const foreign='"a2u_foreign_ongoing_payment"';
must(e.includes(`const failClosedStage1=[${foreign}`),"foreign ongoing is fail-closed before refund reconciliation");
const fail=e.indexOf("const failClosedStage1="); const reconcile=e.indexOf("reconcileIncompleteA2UPayment",fail); const refund=e.indexOf("markRefundPendingAfterFailedSettlement",fail);
must(fail>=0&&reconcile>fail&&refund>reconcile,"stage1 failure ordering preserved");
must(t.includes('failure.code === "a2u_foreign_ongoing_payment" ||'),"refund eligibility helper independently rejects foreign ongoing");
const guard=t.indexOf('failure.code === "a2u_foreign_ongoing_payment" ||'); const eligible=t.indexOf('settlementFailureState: "refund_pending"',guard);
must(guard>=0&&eligible>guard,"foreign guard precedes refund eligibility mutation");
console.log("FIN4_R4S_FOREIGN_ONGOING_REFUND_CONTAINMENT PASS")
