import fs from 'node:fs'
const d=fs.readFileSync('app/api/certification/fin4-r4t-lock-diagnostic/route.ts','utf8')
const h=fs.readFileSync('app/api/certification/fin4-r4t-lock-holder/route.ts','utf8')
const c=fs.readFileSync('app/api/certification/fin4-r4t-lock-contender/route.ts','utf8')
function valid(s){return !/\{\s*ok\s*:\s*false[^}]*\.\.\.resolved/.test(s)&&!/\{\s*acquired\s*:\s*false[^}]*\.\.\.resolved/.test(s)}
const muts=[
 d.replace('{...resolved,action:', '{ok:false,...resolved,action:'),
 h.replace('{...resolved,runId,financialMovementExecuted:false}', '{ok:false,...resolved,runId,financialMovementExecuted:false}'),
 c.replace('{...resolved,acquired:false,runId,financialMovementExecuted:false}', '{acquired:false,...resolved,runId,financialMovementExecuted:false}'),
]
for(const x of muts) if(valid(x)) throw new Error('SURVIVED duplicate-discriminant mutation')
console.log(`PASS verify-fin4-r4t531-response-shape-mutations (${muts.length} killed)`)
