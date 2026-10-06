import fs from "node:fs"
const p="lib/fin4-r4t62-leftovers-audit.ts", q="app/api/certification/fin4-r4t62-leftovers-audit/route.ts"
const a=fs.readFileSync(p,"utf8"),b=fs.readFileSync(q,"utf8")
const muts=[
["drop-A",a.replace("d50d0a46-a305-4008-9843-e50b8d3c265c","x"),b],
["drop-B",a.replace("870a49eb-f0ce-42b8-8682-e334ded12b84","x"),b],
["drop-C",a.replace("a0553edf-8784-4758-a246-2da36847a3b8","x"),b],
["sql-write",a.replace("SELECT payment_id,version","UPDATE settlement_checkpoints SET version=version RETURNING payment_id,version"),b],
["drop-refund-retirement",a.replace("refund_automatic_retirements","refund_x"),b],
["drop-accounting",a.replace("refund_accounting_records","refund_x"),b],
["drop-approval-retirement",a.replace("settlement_u2a_approval_retirements","settlement_x"),b],
["drop-stage1-retirement",a.replace("settlement_a2u_stage1_retirements","settlement_x"),b],
["drop-observation",a.replace("settlement_a2u_ongoing_observations","settlement_x"),b],
["drop-pi-reader",a.replace("readSettlementCreatePiEvidence","readX"),b],
["mutation-marker",a.replaceAll("financialAuthorityMutated:false","financialAuthorityMutated:true"),b],
["post-route",a,b.replace("export async function GET","export async function POST")],
["drop-null-auth",a,b.replace("if(!runId)","if(false)")]
]
function survives([name,x,y]){
 const req=["d50d0a46-a305-4008-9843-e50b8d3c265c","870a49eb-f0ce-42b8-8682-e334ded12b84","a0553edf-8784-4758-a246-2da36847a3b8","settlement_u2a_approval_retirements","settlement_a2u_stage1_retirements","settlement_a2u_ongoing_observations","refund_automatic_retirements","refund_accounting_records","readSettlementCreatePiEvidence","financialAuthorityMutated:false"]
 const ok=req.every(z=>x.includes(z))&&y.includes("export async function GET")&&y.includes("const runId=fin4AuthorizeRunId")&&y.includes("if(!runId)")&&!/export async function (POST|PUT|PATCH|DELETE)/.test(y)&&!/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|MERGE)\b/i.test(x)
 return ok?name:null
}
const alive=muts.map(survives).filter(Boolean)
if(alive.length)throw new Error("R4T6.2 mutations survived: "+alive.join(","))
console.log(`FIN4 R4T6.2 mutations passed: ${muts.length}/${muts.length} KILLED`)
