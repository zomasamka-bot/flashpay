import fs from 'node:fs'
import path from 'node:path'
const fail=m=>{throw new Error(`FIN4_STEP14_FINAL_EVIDENCE_HYGIENE_FAIL: ${m}`)}
const need=(c,m)=>{if(!c)fail(m)}
const walk=d=>fs.existsSync(d)?fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]):[]
const evidencePath='certification/FIN4_FINAL_EVIDENCE.md'
need(fs.existsSync(evidencePath),'evidence file missing')
const e=fs.readFileSync(evidencePath,'utf8')
for(const x of ['FIN4-20261005-1643-D50D','eight concurrent contenders','six distinct Vercel processes','distinctInstanceProven=true','wallet-level cross-instance serialization','matchCount=0','91b09b990184fa73bd8c893a2b514a1d4576be42ae933140511df25b9e682c87','DB_PI_HORIZON_RECONCILED','Duplicate financial identities: `0`','Merchant balance mismatches: `0`','Settlement/Refund overlap: `0`']) need(e.includes(x),`evidence missing: ${x}`)
need(e.includes('does not claim that twenty real financial payments were submitted concurrently'),'overclaim guard missing')
need(!fs.existsSync('app/api/operations/fin4-step13-final-reconciliation'),'temporary Step13 runtime surface remains')
need(!fs.existsSync('scripts/verify-fin4-step13-read-only-reconciliation.mjs'),'temporary Step13 verifier remains')
const runner=fs.readFileSync('scripts/run-financial-recovery-build-verifier.mjs','utf8')
need(!runner.includes('verify-fin4-step13-read-only-reconciliation'),'temporary Step13 verifier still wired')
const prod=[...walk('app'),...walk('lib'),...walk('components')].filter(p=>/\.(ts|tsx|js|mjs)$/.test(p)).map(p=>fs.readFileSync(p,'utf8')).join('\n')
for(const x of ['FLASHPAY_FIN4_','flashpay:cert:fin4','FIN4_STAGE1_PREPARE','fin4-step13-final-reconciliation']) need(!prod.includes(x),`production FIN4 residue: ${x}`)
for(const p of ['app/api/certification','app/api/test','app/api/debug']) need(!fs.existsSync(p),`temporary API surface remains: ${p}`)
const secretArtifacts=walk('.').filter(p=>{
  const base=path.basename(p).toLowerCase()
  return base==='.env' || base.startsWith('.env.') || base.endsWith('.pem') || base.endsWith('.key') || /^(credentials?|service-account)(\.|$)/i.test(base)
})
need(secretArtifacts.length===0,`secret/env artifact present: ${secretArtifacts.join(', ')}`)
console.log('FIN4_STEP14_FINAL_EVIDENCE_HYGIENE=PASS')
console.log('step13_runtime_surface=0')
console.log('fin4_runtime_residue=0')
console.log('temporary_api_surfaces=0')
console.log('evidence_overclaim_guard=PASS')
