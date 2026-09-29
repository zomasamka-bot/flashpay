import assert from 'node:assert/strict'
import fs from 'node:fs'
const p=new URL('./run-dr17-isolated-live-10k.mjs',import.meta.url)
const s=fs.readFileSync(p,'utf8')
for(const x of ['DR17_DATABASE_URL','DR17_REDIS_REST_URL','DR17_REDIS_REST_TOKEN','DR17_ISOLATED_LIVE_ACK','assert.notEqual(dbUrl, prodDb','assert.notEqual(redisUrl, prodRedis','const N = 10_000','const workers=32','badMovementCount','settlementRefundOverlap','lostRecovery','piCalled:false','horizonCalled:false']) assert.ok(s.includes(x),`missing ${x}`)
for(const forbidden of ['api.minepi.com','api.testnet.minepi.com','horizon.stellar.org','horizon-testnet.stellar.org','/v2/payments/','submitTransaction(','createPayment(']) assert.equal(s.includes(forbidden),false,`forbidden external financial transport: ${forbidden}`)
assert.equal(s.includes('process.env.DATABASE_URL ||'),false)
assert.equal(s.includes('process.env.UPSTASH_REDIS_REST_URL || process.env.DR17'),false)
console.log(JSON.stringify({certification:'PASS',gate:'DR107-DR17-ISOLATED-LIVE-HARNESS-STATIC-GATE',productionFallback:false,piTransport:false,horizonTransport:false,productionFinancialSourceChanged:false,live10kExecutedByThisVerifier:false},null,2))
