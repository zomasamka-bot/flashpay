import fs from "node:fs"
const p="app/api/certification/step8-redis-cleanup/route.ts"
const s=fs.readFileSync(p,"utf8")
const keys=[...s.matchAll(/"(flashpay:cert:fin4:r4e:v1:FIN4-[^"]+:events)"/g)].map(m=>m[1])
const gates={exactSeven:keys.length===7&&new Set(keys).size===7,onlyCertKeys:keys.every(k=>k.startsWith("flashpay:cert:fin4:r4e:v1:")&&k.endsWith(":events")),atomic:s.includes("ATOMIC_EXACT_CLEANUP")&&s.includes("redis.call('TYPE'")&&s.includes("redis.call('DEL'"),preflight:s.includes('item.exists !== 1 || item.type !== "list"'),exactAction:s.includes('delete-exact-seven-fin4-event-lists'),readback:s.includes("exactRemaining.length === 0 && r4ePrefixCount === 0 && r4tPrefixCount === 0"),noWildcardMutation:!s.includes("redis.del(...")&&!s.includes("FLUSHDB")&&!s.includes("FLUSHALL"),noFinancialNamespace:!keys.some(k=>/payment|wallet|intent|recovery|queue|lease|index/.test(k))}
for(const [k,v] of Object.entries(gates)){console.log(`${k} ${v?'PASS':'FAIL'}`);if(!v)process.exitCode=1}
if(!process.exitCode)console.log("FIN4_STEP8C_EXACT_REDIS_CLEANUP PASS")
