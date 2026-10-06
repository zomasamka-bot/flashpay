import fs from 'node:fs'
const lib=fs.readFileSync('lib/fin4-r4t6-final-state-audit.ts','utf8')
const route=fs.readFileSync('app/api/certification/fin4-r4t6-final-state-audit/route.ts','utf8')
const cases=[
 ['swap-A',lib.replace('d50d0a46-a305-4008-9843-e50b8d3c265c','BAD-A'),route],
 ['swap-B',lib.replace('870a49eb-f0ce-42b8-8682-e334ded12b84','BAD-B'),route],
 ['drop-postgres',lib.replaceAll('getSettlementCheckpointAuthoritative','getSettlementCheckpointBROKEN'),route],
 ['drop-refund-select',lib.replace('FROM refund_checkpoints WHERE payment_id=$1','FROM refund_checkpoints WHERE payment_id=$2'),route],
 ['drop-retirement-select',lib.replace('FROM refund_automatic_retirements WHERE payment_id=$1','FROM refund_automatic_retirements WHERE payment_id=$2'),route],
 ['drop-pi',lib.replaceAll('readSettlementCreatePiEvidence','readSettlementCreatePiBROKEN'),route],
 ['drop-horizon',lib.replaceAll('readSettlementSubmitHorizonEvidence','readSettlementSubmitHorizonBROKEN'),route],
 ['enable-pi-mutation',lib.replace('piMutationExecuted:false','piMutationExecuted:true'),route],
 ['enable-horizon-submit',lib.replace('horizonSubmitExecuted:false','horizonSubmitExecuted:true'),route],
 ['add-post',lib,route+'\nexport async function POST(){}\n'],
]
function accepts(l,r){
 const required=["FIN4_R4T6_PAYMENT_A='d50d0a46-a305-4008-9843-e50b8d3c265c'","FIN4_R4T6_PAYMENT_B='870a49eb-f0ce-42b8-8682-e334ded12b84'",'getSettlementCheckpointAuthoritative','FROM refund_checkpoints WHERE payment_id=$1','FROM refund_automatic_retirements WHERE payment_id=$1','readSettlementCreatePiEvidence','readSettlementSubmitHorizonEvidence','piMutationExecuted:false','horizonSubmitExecuted:false']
 return required.every(x=>l.includes(x))&&!/export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\b/.test(r)
}
let killed=0
for(const [name,l,r] of cases){if(accepts(l,r))throw new Error(`R4T6 mutation survived: ${name}`);killed++}
console.log(`FIN4 R4T6 mutations passed: ${killed}/${cases.length} KILLED`)
