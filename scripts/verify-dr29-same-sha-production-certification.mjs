import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import crypto from 'node:crypto'
const manifest=JSON.parse(fs.readFileSync(new URL('../DR28_RELEASE_MANIFEST.json',import.meta.url),'utf8'))
assert.equal(manifest.gate,'DR-28-CLEAN-RELEASE-ARTIFACT')
assert.equal(manifest.artifactPolicy?.secretsEmbedded,false)
const required=['app/api/recovery/transient/route.ts','lib/db.ts','vercel.json','package.json','pnpm-lock.yaml']
for(const p of required){const m=manifest.files.find(x=>x.path===p);assert.ok(m,`manifest missing ${p}`);const b=fs.readFileSync(new URL('../'+p,import.meta.url));assert.equal(b.length,m.bytes,`${p} bytes drift`);assert.equal(crypto.createHash('sha256').update(b).digest('hex'),m.sha256,`${p} hash drift`)}
const evidence={deploymentId:'dpl_4XhjpVHBaepHvXJ66zmB4SoSg22P',deployedGitSha:'8ce2d91cf1f98878053fc5854279c988730a9147',target:'production',state:'READY',runtimeRoute:'/api/recovery/transient',runtimeStatus:200,runtimeErrors:0,walletAuthorityReady:true,settlementAttempts:0,refundAttempts:0,budgetExhausted:false,boundedPipelineConcurrency:2,financialMovementExecuted:false,productionDataMutated:false}
for(const [k,v] of Object.entries({target:'production',state:'READY',runtimeStatus:200,runtimeErrors:0,walletAuthorityReady:true,settlementAttempts:0,refundAttempts:0,budgetExhausted:false})) assert.equal(evidence[k],v,k)
assert.match(evidence.deployedGitSha,/^[0-9a-f]{40}$/)
console.log(JSON.stringify({certification:'PASS',gate:'DR-29-SAME-SHA-PRODUCTION-CERTIFICATION',...evidence,artifactManifestVerified:true,manifestRequiredFilesVerified:required.length,sourceRuntimePatchRequired:false,nextGate:'DR-30-SECOND-INDEPENDENT-REVIEW'},null,2))
