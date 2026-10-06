import fs from 'node:fs'
import path from 'node:path'
const root=process.cwd()
const assert=(c,m)=>{if(!c)throw new Error(`FIN4_STEP8_FINAL_SURFACE_HYGIENE=FAIL ${m}`)}
const walk=d=>fs.existsSync(d)?fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]):[]
const prodFiles=[...walk(path.join(root,'app')),...walk(path.join(root,'lib'))].filter(p=>/\.(ts|tsx|js|mjs)$/.test(p))
const prod=prodFiles.map(p=>fs.readFileSync(p,'utf8')).join('\n')
const certRoutes=walk(path.join(root,'app/api/certification'))
assert(certRoutes.filter(p=>p.includes('/step8-')).length===0,'Step-8 certification route remains')
assert(!prod.includes('flashpay:cert:fin4:'),'FIN-4 certification Redis namespace remains in production app/lib')
assert(!prod.includes('step8-redis-cleanup'),'Step-8 cleanup surface marker remains in production app/lib')
assert(!prod.includes('step8-redis-inventory'),'Step-8 inventory surface marker remains in production app/lib')
const runner=fs.readFileSync(path.join(root,'scripts/run-financial-recovery-build-verifier.mjs'),'utf8')
assert(!runner.includes('verify-fin4-step8-redis-read-only-inventory'),'temporary Step-8 inventory verifier still wired')
assert(!runner.includes('verify-fin4-step8c-redis-exact-cleanup'),'temporary Step-8 cleanup verifier still wired')
console.log('FIN4_STEP8_FINAL_SURFACE_HYGIENE=PASS step8_routes=0 fin4_cert_redis_prod_refs=0 temporary_step8_verifiers=0')
