import fs from 'node:fs'
const lib=fs.readFileSync('lib/fin4-r4t61-reverse-horizon-scan.ts','utf8')
const route=fs.readFileSync('app/api/certification/fin4-r4t61-reverse-horizon-scan/route.ts','utf8')
const required=['https://api.testnet.minepi.com','GCVYA2KC6ANJOW4OMOSUKFLSBMZDYQWZ4S6HA654MIWHG6NZC4ZZOVD5','2026-10-05T08:30:00.000Z','2026-10-05T15:30:00.000Z',"new Set(['1.4000000','1.7000000'])",'/payments?order=desc&limit=200','PAGINATION_LOOP','WINDOW_NOT_EXHAUSTIVELY_SCANNED',"type!=='payment'","from!==FIN4_R4T61_SOURCE_WALLET","assetType!=='native'",'horizonSubmitExecuted:false','financialAuthorityMutated:false']
for(const x of required)if(!lib.includes(x))throw new Error(`R4T6.1 missing ${x}`)
for(const x of ['export async function GET','fin4AuthorizeRunId','readFin4R4T61ReverseHorizonScan'])if(!route.includes(x))throw new Error(`R4T6.1 route missing ${x}`)
for(const source of [lib,route])for(const forbidden of ['executeA2U','executeRefund','acquirePiWalletSubmitLock','getPostgresClient','query(','redis.','PI_API_KEY','/v2/payments','method:\'POST\'','method:"POST"','INSERT INTO','UPDATE ','DELETE FROM'])if(source.includes(forbidden))throw new Error(`R4T6.1 forbidden writer/authority surface ${forbidden}`)
if(/export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\b/.test(route))throw new Error('R4T6.1 exposes mutation method')
console.log('FIN4 R4T6.1 reverse Horizon read-only scan verification passed')
