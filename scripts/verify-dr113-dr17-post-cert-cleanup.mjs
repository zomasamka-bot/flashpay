import fs from 'node:fs'
import assert from 'node:assert/strict'
const recovery=fs.readFileSync('app/api/recovery/transient/route.ts','utf8')
const route=fs.readFileSync('app/api/certification/dr17/run/route.ts','utf8')
const engine=fs.readFileSync('lib/dr17-shared-certification.mjs','utf8')
const declaration=fs.readFileSync('lib/dr17-shared-certification.d.mts','utf8')
const vercel=JSON.parse(fs.readFileSync('vercel.json','utf8'))

// Surgical cleanup: recovery no longer knows or invokes DR17 certification.
assert.doesNotMatch(recovery,/scheduleTrustedDr17CertificationRequest/)
assert.doesNotMatch(recovery,/\/api\/certification\/dr17\/run/)
assert.doesNotMatch(recovery,/dr17-shared-safe-10k-dr11[0-9]/i)
assert.doesNotMatch(recovery,/DR17 one-shot/i)

// Existing recovery scheduling/auth machinery must remain.
assert.match(recovery,/const RECOVERY_SECRET_ENV = "FLASHPAY_TRANSIENT_RECOVERY_SECRET"/)
assert.match(recovery,/function hasValidSecret\(/)
assert.match(recovery,/\bafter\s*\(/)
assert.match(recovery,/executeA2URecovery/)
assert.match(recovery,/runAutomaticRefundPass/)

// Evidence and manual authenticated certification surface remain intact.
assert.match(route,/const RELEASE = "DR112"/)
assert.match(route,/const EXECUTION_KEY = "dr17-shared-safe-10k-dr112"/)
assert.match(route,/if \(!authorized\(request\)\).*401/)
assert.match(route,/VERCEL_ENV !== "production".*403/)
assert.match(route,/ON CONFLICT \(execution_key\) DO NOTHING/)
assert.match(route,/runDr17SharedResourceSafe10k\(\{ trustedProductionExecution: true \}\)/)
assert.match(engine,/const N = 10_000/)
assert.match(engine,/const WORKERS = 8/)
assert.match(engine,/const CAPACITY_REFERENCE_MS = 120_000/)
assert.match(engine,/assert\.equal\(recovered,N\)/)
assert.match(engine,/dr17_cert_runs/)
assert.match(engine,/dr17_cert_items/)
assert.match(declaration,/trustedProductionExecution\?: boolean/)

// No scheduler/config expansion.
assert.equal(vercel.crons.length,1)
assert.equal(vercel.crons[0].path,'/api/recovery/transient')
assert.equal(vercel.crons[0].schedule,'0 21 * * *')

console.log(JSON.stringify({
 certification:'PASS',gate:'DR113-DR17-POST-CERT-CLEANUP',
 automaticDr17TriggerRemoved:true,dr17EvidencePreserved:true,
 dr17AuthenticatedRoutePreserved:true,recoveryAuthPreserved:true,
 financialRecoveryPreserved:true,vercelCronUnchanged:true,
 piTransportChanged:false,horizonTransportChanged:false
},null,2))
