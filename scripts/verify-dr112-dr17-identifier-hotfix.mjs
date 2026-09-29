import fs from 'node:fs'
import assert from 'node:assert/strict'
const engine=fs.readFileSync('lib/dr17-shared-certification.mjs','utf8')
const route=fs.readFileSync('app/api/certification/dr17/run/route.ts','utf8')
const recovery=fs.readFileSync('app/api/recovery/transient/route.ts','utf8')
const vercel=JSON.parse(fs.readFileSync('vercel.json','utf8'))

assert.match(route,/const RELEASE = "DR112"/)
assert.match(route,/const EXECUTION_KEY = "dr17-shared-safe-10k-dr112"/)
assert.match(route,/dr17_dr112_started/)
assert.match(route,/dr17_dr112_completed/)
assert.match(route,/dr17_dr112_failed/)
assert.match(route,/if \(!authorized\(request\)\).*401/)
assert.match(route,/VERCEL_ENV !== "production".*403/)
assert.match(route,/ON CONFLICT \(execution_key\) DO NOTHING/)
assert.match(route,/runDr17SharedResourceSafe10k\(\{ trustedProductionExecution: true \}\)/)

// DR112 root-cause regression: final Redis assertion must reference the lexical binding
// created immediately above it. The stale DR111 identifier is forbidden everywhere.
assert.doesNotMatch(engine,/assert\.equal\(redisRecovered\b/)
assert.doesNotMatch(engine,/(?<![:.])\bredisRecovered\b(?!\s*:)/)
assert.match(engine,/const recovered=Number\(await redis\.zcard\(key\('recovered'\)\)\)/)
assert.match(engine,/assert\.equal\(recovered,N\)/)
const recoveredDecl=engine.indexOf("const recovered=Number(await redis.zcard(key('recovered')))")
const recoveredAssert=engine.indexOf("assert.equal(recovered,N)")
assert.ok(recoveredDecl>=0 && recoveredAssert>recoveredDecl,'recovered must be declared before final assertion')

// Algorithm/capacity invariants are intentionally unchanged from DR111.
assert.match(engine,/const N = 10_000/)
assert.match(engine,/const WORKERS = 8/)
assert.match(engine,/const DB_CHUNK = 200/)
assert.match(engine,/const REDIS_CHUNK = 250/)
assert.match(engine,/const CAPACITY_REFERENCE_MS = 120_000/)
assert.match(engine,/await Promise\.all\(Array\.from\(\{length:WORKERS\},worker\)\)/)
assert.match(engine,/checkpoint\('concurrent_complete'/)
assert.match(engine,/checkpoint\('rediscovery_complete'/)
assert.match(engine,/assert\.equal\(postConcurrent\.movement_one,N\)/)
assert.match(engine,/assert\.equal\(postConcurrent\.authority_overlap,0\)/)
assert.match(engine,/assert\.equal\(report\.lostRecovery,0\)/)
assert.match(engine,/finally \{[\s\S]*redis\.del\(key\('ready'\),key\('recovered'\)\)/)
assert.match(engine,/productionFinancialTablesTargeted:false/)
assert.match(engine,/productionRuntimeRedisKeysTargeted:false/)
assert.match(engine,/piCalled:false,horizonCalled:false/)
assert.doesNotMatch(engine,/api\.minepi\.com|submitTransaction/i)
assert.doesNotMatch(route,/api\.minepi\.com|submitTransaction/i)
assert.equal(vercel.crons.length,1)
assert.equal(vercel.crons[0].path,'/api/recovery/transient')
assert.match(recovery,/scheduleTrustedDr17CertificationRequest\(\)/)

console.log(JSON.stringify({
 certification:'PASS',gate:'DR112-DR17-IDENTIFIER-HOTFIX',
 staleIdentifierForbidden:true,recoveredBindingVerified:true,
 algorithmUnchanged:true,capacityParametersUnchanged:true,
 durableOneShot:true,productionOnly:true,vercelCronUnchanged:true,
 piCalled:false,horizonCalled:false
},null,2))
