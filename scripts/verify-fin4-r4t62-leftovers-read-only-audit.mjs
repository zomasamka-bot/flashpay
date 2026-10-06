import fs from "node:fs"
const lib=fs.readFileSync("lib/fin4-r4t62-leftovers-audit.ts","utf8")
const route=fs.readFileSync("app/api/certification/fin4-r4t62-leftovers-audit/route.ts","utf8")
const required=[
"d50d0a46-a305-4008-9843-e50b8d3c265c","870a49eb-f0ce-42b8-8682-e334ded12b84","a0553edf-8784-4758-a246-2da36847a3b8",
"settlement_checkpoints","settlement_u2a_approval_retirements","settlement_a2u_stage1_retirements",
"settlement_a2u_ongoing_observations","refund_checkpoints","refund_automatic_retirements","refund_accounting_records",
"readSettlementCreatePiEvidence","financialAuthorityMutated:false"
]
for(const x of required)if(!lib.includes(x))throw new Error("R4T6.2 missing "+x)
if(!route.includes("export async function GET")||!route.includes("fin4AuthorizeRunId"))throw new Error("R4T6.2 GET/auth binding missing")
if(!route.includes("const runId=fin4AuthorizeRunId")||!route.includes("if(!runId)")||!route.includes("runId}"))throw new Error("R4T6.2 nullable run-id auth contract missing")
if(/export async function (POST|PUT|PATCH|DELETE)/.test(route))throw new Error("R4T6.2 mutation HTTP method present")
const sql=[...lib.matchAll(/query\(`([\s\S]*?)`/g)].map(m=>m[1].trim())
if(sql.length!==7||sql.some(q=>!/^SELECT\b/i.test(q)))throw new Error("R4T6.2 SQL is not exactly seven SELECT-only reads")
if(sql.some(q=>/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|MERGE)\b/i.test(q)))throw new Error("R4T6.2 mutating SQL token present")
const forbidden=["executeA2U","executeRefund","acquirePiWalletSubmitLock","fetch("]
for(const x of forbidden)if(lib.includes(x))throw new Error("R4T6.2 forbidden surface "+x)
if(/from\s+["'][^"']*redis|@\/lib\/redis|\bredis\.|\bgetRedis\b/i.test(lib))throw new Error("R4T6.2 Redis access surface present")
console.log("FIN4 R4T6.2 A/B/C leftovers read-only audit verification passed")
