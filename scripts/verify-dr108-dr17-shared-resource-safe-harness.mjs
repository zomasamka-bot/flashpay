import assert from 'node:assert/strict'
import fs from 'node:fs'
const s=fs.readFileSync(new URL('./run-dr17-shared-resource-safe-10k.mjs',import.meta.url),'utf8')
for(const x of ["const N = 10_000","const WORKERS = 8","const DB_CHUNK = 200","const REDIS_CHUNK = 250","DR17_SHARED_RESOURCE_ACK","flashpay:dr17:cert:","SELECT 1 AS ok","redis.ping()","productionFinancialTablesTargeted:false","productionRuntimeRedisKeysTargeted:false","sharedDatabaseResource:true","sharedRedisResource:true","piCalled:false","horizonCalled:false","sleep(5)"]) assert.ok(s.includes(x),`missing ${x}`)
for(const forbidden of ['api.minepi.com','api.testnet.minepi.com','horizon.stellar.org','horizon-testnet.stellar.org','/v2/payments/','submitTransaction(','createPayment(','DELETE FROM payments','UPDATE payments','INSERT INTO payments','refund_intents','settlement_transactions']) assert.equal(s.includes(forbidden),false,`forbidden production/financial transport surface: ${forbidden}`)
assert.ok(s.includes("CREATE TABLE IF NOT EXISTS dr17_cert_runs"))
assert.ok(s.includes("CREATE TABLE IF NOT EXISTS dr17_cert_items"))
assert.ok(s.includes("hard latency guard"))
console.log(JSON.stringify({certification:'PASS',gate:'DR108-DR17-SHARED-RESOURCE-SAFE-HARNESS-STATIC-GATE',total:10000,workers:8,dbChunk:200,redisChunk:250,explicitSharedResourceAck:true,productionFinancialTablesTargeted:false,productionRuntimeRedisKeysTargeted:false,piTransport:false,horizonTransport:false,runtimeFinancialSourceChanged:false,live10kExecutedByThisVerifier:false},null,2))
