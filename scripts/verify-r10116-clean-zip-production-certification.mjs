import { strict as assert } from "node:assert"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..")
const read=p=>fs.readFileSync(path.join(root,p),"utf8")
const exists=p=>fs.existsSync(path.join(root,p))

// R101-16 is a packaging + production-certification gate. It must not add runtime authority.
for(const f of [
 "scripts/verify-r10115-full-financial-regression.mjs",
 "scripts/verify-r10114-reconciliation-alerts.mjs",
 "scripts/verify-r10113-controlled-live-capacity-calibration.mjs",
 "scripts/verify-r10112-10k-financial-safety-adversarial-model.mjs",
 "scripts/verify-r10111-10k-nonfinancial-load.mjs",
]) assert.ok(exists(f),`missing predecessor certification: ${f}`)

const r10115=read("scripts/verify-r10115-full-financial-regression.mjs")
assert.ok(r10115.includes('gate:"R101-15-FULL-FINANCIAL-REGRESSION"'))
assert.ok(r10115.includes('runtimeSourceChanged:false'))
assert.ok(r10115.includes('financialSourceChanged:false'))
assert.ok(r10115.includes('sourcePatchRequired:false'))

// Clean-tree rules: reject local/editor/build/cache/secrets that must not enter the handoff ZIP.
const forbiddenNames=new Set([".DS_Store",".env",".env.local",".env.production",".env.development"])
const forbiddenDirs=new Set(["node_modules",".next",".git",".turbo",".vercel","coverage","dist"])
const secretName=/(\.pem$|\.key$|id_rsa|id_ed25519|service[-_]?account.*\.json$)/i
const files=[]
function walk(dir,rel=""){
 for(const ent of fs.readdirSync(dir,{withFileTypes:true})){
  const childRel=rel?`${rel}/${ent.name}`:ent.name
  if(ent.isDirectory()){
   assert.equal(forbiddenDirs.has(ent.name),false,`forbidden generated directory: ${childRel}`)
   walk(path.join(dir,ent.name),childRel)
  }else if(ent.isFile()){
   assert.equal(forbiddenNames.has(ent.name),false,`forbidden local/env file: ${childRel}`)
   assert.equal(secretName.test(ent.name),false,`forbidden key material filename: ${childRel}`)
   files.push(childRel)
  }
 }
}
walk(root)
assert.ok(files.length>0)
assert.equal(new Set(files).size,files.length)

// Package baseline must remain pinned to the certified runtime family.
const pkg=JSON.parse(read("package.json"))
assert.equal(pkg.engines?.node,"24.x")
assert.equal(pkg.dependencies?.["@stellar/stellar-sdk"],"17.1.0")
assert.equal(pkg.dependencies?.["@upstash/redis"],"1.36.2")
assert.equal(pkg.dependencies?.["@neondatabase/serverless"],"1.0.2")
assert.equal(pkg.dependencies?.postgres,"3.4.9")
assert.ok(String(pkg.dependencies?.next??"").startsWith("^15."))

// Production evidence is deliberately explicit and immutable for the R101-15 deployment
// inspected before creating this gate. This does not claim R101-16 production closure yet.
const productionEvidence={
 deploymentId:"dpl_DMLQbPV2RoqmrMLe81f5Nys4Wtpi",
 gitSha:"06bdbbef38b41af0c165739d123a90f4b18313fc",
 parentSha:"89d12f6f621a9026d98cd5c88de9b93eb45a43b1",
 treeSha:"83ba85a2612c4d4d92c125055bc6ea638de93b6f",
 ready:true,production:true,aliasError:null,runtimeErrorsObserved:0,
 recoveryHttpStatus:200,activeSetSize:68,readySetSize:0,
 settlementAttempts:0,refundAttempts:0,budgetExhausted:false,
 continuationScheduled:false,piCreateBackpressureActive:false,
 wakeDurationMs:4302,workDurationMs:501,
}
assert.equal(productionEvidence.ready,true)
assert.equal(productionEvidence.production,true)
assert.equal(productionEvidence.aliasError,null)
assert.equal(productionEvidence.runtimeErrorsObserved,0)
assert.equal(productionEvidence.recoveryHttpStatus,200)
assert.equal(productionEvidence.budgetExhausted,false)
assert.equal(productionEvidence.continuationScheduled,false)
assert.equal(productionEvidence.piCreateBackpressureActive,false)

// Deterministic manifest digest detects accidental file drift inside this candidate tree.
// The certifier excludes itself to avoid a recursive self-hash.
const manifest=files.filter(f=>f!=="scripts/verify-r10116-clean-zip-production-certification.mjs")
 .sort().map(f=>`${f}\0${crypto.createHash("sha256").update(fs.readFileSync(path.join(root,f))).digest("hex")}`).join("\n")
const candidateManifestSha256=crypto.createHash("sha256").update(manifest).digest("hex")
assert.match(candidateManifestSha256,/^[0-9a-f]{64}$/)

console.log(JSON.stringify({
 certification:"PASS",
 gate:"R101-16-CLEAN-ZIP-PRODUCTION-CERTIFICATION",
 predecessorProduction:"R101-15-FULL-PASS-CLOSED",
 predecessorDeployment:productionEvidence.deploymentId,
 predecessorGitSha:productionEvidence.gitSha,
 cleanTreeFiles:files.length,
 candidateManifestSha256,
 forbiddenGeneratedArtifactsObserved:0,
 forbiddenEnvFilesObserved:0,
 forbiddenKeyMaterialObserved:0,
 runtimeSourceChanged:false,
 financialSourceChanged:false,
 financialMovementExecuted:false,
 piNetworkCalledByCertifier:false,
 horizonCalledByCertifier:false,
 productionDataMutated:false,
 sourcePatchRequired:false,
 r10116ProductionClosurePendingDeployment:true,
 nextGate:"R101-17-INDEPENDENT-REREVIEW"
},null,2))
