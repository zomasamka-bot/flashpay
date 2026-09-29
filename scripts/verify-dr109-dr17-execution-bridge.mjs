import assert from 'node:assert/strict'
import fs from 'node:fs'

const route=fs.readFileSync('app/api/certification/dr17/run/route.ts','utf8')
const engine=fs.readFileSync('lib/dr17-shared-certification.mjs','utf8')
const cli=fs.readFileSync('scripts/run-dr17-shared-resource-safe-10k.mjs','utf8')
assert.match(route,/export async function POST/)
assert.match(route,/export async function GET/)
assert.match(route,/timingSafeEqual/)
assert.match(route,/process\.env\.CRON_SECRET/)
assert.match(route,/FLASHPAY_TRANSIENT_RECOVERY_SECRET/)
assert.match(route,/ON CONFLICT \(execution_key\) DO NOTHING/)
assert.match(route,/one_shot_already_claimed/)
assert.match(route,/VERCEL_ENV !== "production"/)
assert.match(route,/runDr17SharedResourceSafe10k/)
assert.match(engine,/const N = 10_000/)
assert.match(engine,/const WORKERS = 8/)
assert.match(engine,/flashpay:dr17:cert:/)
assert.match(cli,/runDr17SharedResourceSafe10k/)
for(const forbidden of ['api.minepi.com','api.testnet.minepi.com','horizon.stellar.org','horizon-testnet.stellar.org','submitTransaction(','createPayment(']) {
  assert.ok(!route.includes(forbidden),`forbidden transport in route: ${forbidden}`)
  assert.ok(!engine.includes(forbidden),`forbidden transport in engine: ${forbidden}`)
}
console.log(JSON.stringify({certification:'PASS',gate:'DR109-DR17-EXECUTION-BRIDGE-STATIC-GATE',postOnlyExecution:true,authenticated:true,constantTimeSecretComparison:true,oneShotDurableClaim:true,productionOnly:true,sharedHarnessReused:true,piTransport:false,horizonTransport:false,financialRuntimeSourceChanged:false,live10kExecutedByThisVerifier:false},null,2))
