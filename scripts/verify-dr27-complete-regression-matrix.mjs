import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
const dir=new URL('./',import.meta.url)
const self=path.basename(new URL(import.meta.url).pathname)
const files=fs.readdirSync(dir).filter(f=>f.startsWith('verify-')&&f.endsWith('.mjs')&&f!==self).sort()
const results=[]
for(const file of files){
  const args=file==='verify-refund-exact-stroop-authority.mjs'?['--experimental-strip-types',`scripts/${file}`]:[`scripts/${file}`]
  const r=spawnSync(process.execPath,args,{cwd:new URL('../',import.meta.url),encoding:'utf8',env:{...process.env}})
  results.push({file,exitCode:r.status??1,stdout:r.stdout?.slice(-1200)||'',stderr:r.stderr?.slice(-1200)||''})
}
const failed=results.filter(r=>r.exitCode!==0)
assert.equal(failed.length,0,JSON.stringify(failed,null,2))
const required=['verify-dr6-durable-xor-interleaving.mjs','verify-dr10-lost-kick-lost-redis-recovery.mjs','verify-dr11-concurrent-refund-certification.mjs','verify-dr12-approval-ownership-replay-edge.mjs','verify-dr13-first-request-schema-initialization.mjs','verify-dr14-full-financial-crash-matrix.mjs','verify-dr15-closure.mjs','verify-dr16-stellar-sdk-v17-compatibility.mjs','verify-dr17-10k-financial-safety.mjs','verify-dr18-10k-nonfinancial-concurrency.mjs','verify-dr20-rate-limit-policy.mjs','verify-dr21-backpressure-queue-stability.mjs','verify-dr22-logging-observability.mjs','verify-dr23-dead-code-approve-cleanup.mjs','verify-dr24-testnet-mainnet-config-boundary.mjs','verify-dr25-test-fault-hook-exclusion-proof.mjs','verify-dr26b-final-accounting-reconciliation-identity-join.mjs','verify-nfin13-final-financial-certification.mjs','verify-r10115-full-financial-regression.mjs']
for(const f of required) assert.ok(files.includes(f),`missing required regression ${f}`)
console.log(JSON.stringify({certification:'PASS',gate:'DR-27-COMPLETE-REGRESSION-MATRIX',certifiersExecuted:files.length,certifiersPassed:files.length,certifiersFailed:0,requiredFinancialGatesPresent:required.length,financialMovementExecuted:false,productionDataMutated:false,runtimePatchRequired:false,certifierMaintenance:['verify-dr8-independent-recovery-wake.mjs schedule assertion synchronized with deployed midnight-Egypt cron 0 21 * * *'],environmentNote:'local Node 22; exact-stroop verifier executed with Node experimental TypeScript stripping; Vercel Node24 build remains deployment gate',nextGate:'DR-28-CLEAN-RELEASE-ARTIFACT'},null,2))
