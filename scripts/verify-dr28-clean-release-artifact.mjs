import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const root=path.resolve(new URL('../',import.meta.url).pathname)
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)])
const files=walk(root).filter(p=>!p.includes(`${path.sep}node_modules${path.sep}`)).sort()
const rel=p=>path.relative(root,p).replaceAll(path.sep,'/')
const forbidden=files.map(rel).filter(p=>/(^|\/)(\.env(?:\.|$)|\.DS_Store$|tsconfig\.tsbuildinfo$)|(^|\/)(node_modules|\.next|\.git)(\/|$)/.test(p))
assert.deepEqual(forbidden,[])
for(const required of ['package.json','pnpm-lock.yaml','tsconfig.json','vercel.json','app/api/recovery/transient/route.ts','lib/db.ts','scripts/verify-dr27-complete-regression-matrix.mjs']) assert.ok(files.map(rel).includes(required),`missing ${required}`)
const suspicious=[]
for(const p of files){if(fs.statSync(p).size>2_000_000)continue;const b=fs.readFileSync(p);if(b.includes(0))continue;const s=b.toString('utf8');if(rel(p)!=='scripts/verify-dr28-clean-release-artifact.mjs' && /BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY|sk_live_|postgres(?:ql)?:\/\/[^\s:]+:[^\s@]+@/i.test(s)) suspicious.push(rel(p))}
assert.deepEqual(suspicious,[])
const entries=files.map(p=>({path:rel(p),bytes:fs.statSync(p).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}))
const manifest={gate:'DR-28-CLEAN-RELEASE-ARTIFACT',schemaVersion:1,artifactPolicy:{forbidden:['.env*','node_modules','.next','.git','*.tsbuildinfo','.DS_Store','private-key/signing-secret literals'],secretsEmbedded:false},fileCount:entries.length,totalBytes:entries.reduce((n,e)=>n+e.bytes,0),files:entries}
fs.writeFileSync(path.join(root,'DR28_RELEASE_MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n')
console.log(JSON.stringify({certification:'PASS',gate:manifest.gate,fileCountBeforeManifest:manifest.fileCount,totalBytesBeforeManifest:manifest.totalBytes,forbiddenArtifacts:0,suspiciousSecretLiterals:0,manifest:'DR28_RELEASE_MANIFEST.json',runtimePatchRequired:false,financialMovementExecuted:false,productionDataMutated:false,nextGate:'DR-29-SAME-SHA-PRODUCTION-CERTIFICATION'},null,2))
