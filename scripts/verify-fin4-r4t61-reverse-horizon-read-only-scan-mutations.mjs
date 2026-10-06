import fs from 'node:fs'
const original=fs.readFileSync('lib/fin4-r4t61-reverse-horizon-scan.ts','utf8')
const route=fs.readFileSync('app/api/certification/fin4-r4t61-reverse-horizon-scan/route.ts','utf8')
function accepts(lib,r){const req=['GCVYA2KC6ANJOW4OMOSUKFLSBMZDYQWZ4S6HA654MIWHG6NZC4ZZOVD5','2026-10-05T08:30:00.000Z','2026-10-05T15:30:00.000Z',"new Set(['1.4000000','1.7000000'])",'/payments?order=desc&limit=200','PAGINATION_LOOP','WINDOW_NOT_EXHAUSTIVELY_SCANNED',"type!=='payment'","from!==FIN4_R4T61_SOURCE_WALLET","assetType!=='native'",'horizonSubmitExecuted:false','financialAuthorityMutated:false'];return req.every(x=>lib.includes(x))&&!/export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\b/.test(r)}
const cases=[
 ['wallet',original.replace('GCVYA2KC6ANJOW4OMOSUKFLSBMZDYQWZ4S6HA654MIWHG6NZC4ZZOVD5','BAD'),route],
 ['start',original.replace('2026-10-05T08:30:00.000Z','2026-10-05T09:30:00.000Z'),route],
 ['end',original.replace('2026-10-05T15:30:00.000Z','2026-10-05T14:30:00.000Z'),route],
 ['amount',original.replace("new Set(['1.4000000','1.7000000'])","new Set(['1.4000000'])"),route],
 ['pagination',original.replace('/payments?order=desc&limit=200','/payments?order=asc&limit=1'),route],
 ['loop',original.replace("fail('PAGINATION_LOOP'","fail('LOOP_BROKEN'"),route],
 ['exhaustion',original.replace("fail('WINDOW_NOT_EXHAUSTIVELY_SCANNED'","fail('EXHAUSTION_BROKEN'"),route],
 ['direction',original.replace("type!=='payment'","type!=='BROKEN'"),route],
 ['from',original.replace('from!==FIN4_R4T61_SOURCE_WALLET','from===FIN4_R4T61_SOURCE_WALLET'),route],
 ['asset',original.replace("assetType!=='native'","assetType!=='BROKEN'"),route],
 ['submit',original.replaceAll('horizonSubmitExecuted:false','horizonSubmitExecuted:true'),route],
 ['post',original,route+'\nexport async function POST(){}\n'],
]
let killed=0;for(const [name,l,r] of cases){if(accepts(l,r))throw new Error(`R4T6.1 mutation survived: ${name}`);killed++}console.log(`FIN4 R4T6.1 mutations passed: ${killed}/${cases.length} KILLED`)
