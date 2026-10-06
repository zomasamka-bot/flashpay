import fs from 'node:fs'
const lib=fs.readFileSync('lib/fin4-r4t6-final-state-audit.ts','utf8')
const route=fs.readFileSync('app/api/certification/fin4-r4t6-final-state-audit/route.ts','utf8')
const required=[
 "FIN4_R4T6_PAYMENT_A='d50d0a46-a305-4008-9843-e50b8d3c265c'",
 "FIN4_R4T6_PAYMENT_B='870a49eb-f0ce-42b8-8682-e334ded12b84'",
 'getDurableU2AIngressAuthoritative','getSettlementCheckpointAuthoritative','query','SELECT refund_id,payment_id,status,stage','SELECT refund_id,payment_id,reason,evidence_code',
 'readSettlementCreatePiEvidence','readSettlementSubmitHorizonEvidence','NOT_ADDRESSABLE_BY_PREPARED_HASH',
 'postgresMutationExecuted:false','redisReadExecuted:false','redisMutationExecuted:false','piMutationExecuted:false','horizonSubmitExecuted:false','financialAuthorityMutated:false'
]
for(const token of required)if(!lib.includes(token))throw new Error(`R4T6 missing ${token}`)
for(const token of ["export async function GET",'fin4AuthorizeRunId','readFin4R4T6FinalStateAudit'])if(!route.includes(token))throw new Error(`R4T6 route missing ${token}`)
for(const requiredSelect of ['FROM refund_checkpoints WHERE payment_id=$1','FROM refund_automatic_retirements WHERE payment_id=$1'])if(!lib.includes(requiredSelect))throw new Error(`R4T6 missing SELECT-only refund evidence ${requiredSelect}`)
for(const source of [lib,route])for(const forbidden of ['executeA2U','executeRefund','acquirePiWalletSubmitLock','redis.','redis\n','POST(','PUT(','PATCH(','DELETE(','INSERT INTO','UPDATE ','DELETE FROM'])if(source.includes(forbidden))throw new Error(`R4T6 forbidden writer surface ${forbidden}`)
if(/export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\b/.test(route))throw new Error('R4T6 route exposes mutation method')
console.log('FIN4 R4T6 final-state read-only audit verification passed')
