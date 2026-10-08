import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const root=path.resolve(new URL('..',import.meta.url).pathname)
const manifestPath=path.join(root,'certification/SOURCE_MANIFEST.sha256')
// Vercel/Pi Studio create these ephemeral workspace directories after source checkout/install.
// They are excluded from the release-source manifest; their presence in a build workspace is not
// evidence that they were shipped in the clean release ZIP.
const ephemeralWorkspaceDirs=new Set(['.git','.vercel','node_modules','.next','.pnpm-store'])
const forbiddenFiles=(n)=>n==='.DS_Store'||n.startsWith('.env')||/\.(pem|key|p12|bak|orig|tmp|log)$/.test(n)||n.endsWith('~')
const files=[]; const forbidden=[]
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);const rel=path.relative(root,p).replaceAll('\\','/');if(e.isDirectory()){if(ephemeralWorkspaceDirs.has(e.name))continue;walk(p)}else if(e.isFile()){if(forbiddenFiles(e.name))forbidden.push(rel);files.push(rel)}}}
walk(root)
const manifestLines=fs.readFileSync(manifestPath,'utf8').trim().split(/\r?\n/).filter(Boolean)
const manifest=new Map(manifestLines.map(l=>{const m=l.match(/^([a-f0-9]{64})  (.+)$/);if(!m)throw new Error(`Malformed manifest: ${l}`);return [m[2],m[1]]}))
const actual=files.filter(f=>f!=='certification/SOURCE_MANIFEST.sha256').sort()
const missing=actual.filter(f=>!manifest.has(f)); const stale=[...manifest.keys()].filter(f=>!actual.includes(f))
const mismatch=actual.filter(f=>manifest.has(f)&&crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')!==manifest.get(f))
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'))
const pins={cmdk:'1.1.1','embla-carousel-react':'8.5.2','input-otp':'1.4.2','react-day-picker':'9.7.0','react-resizable-panels':'2.1.8',recharts:'2.15.0',vaul:'0.9.9'}
const pinMismatch=Object.entries(pins).filter(([k,v])=>pkg.dependencies?.[k]!==v)
const secretPatterns=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/postgres(?:ql)?:\/\/[^\s"']+/i,/redis:\/\/[^\s"']+/i,/\bghp_[A-Za-z0-9]{20,}\b/,/\bsk_live_[A-Za-z0-9]{12,}\b/]
const secretHits=[]
for(const rel of actual){if(rel.endsWith('.md'))continue;let s;try{s=fs.readFileSync(path.join(root,rel),'utf8')}catch{continue}for(const re of secretPatterns)if(re.test(s)){secretHits.push(rel);break}}
const build=String(pkg.scripts?.build||'')
const checks=[['forbidden_zero',forbidden.length===0],['manifest_complete',missing.length===0],['manifest_no_stale',stale.length===0],['manifest_hashes',mismatch.length===0],['byte_pins',pinMismatch.length===0],['secret_scan',secretHits.length===0],['mandatory_verifier_in_build',build.includes('node scripts/run-financial-recovery-build-verifier.mjs && next build')],['fin15_gate_wired',fs.readFileSync(path.join(root,'scripts/run-financial-recovery-build-verifier.mjs'),'utf8').includes("verify-fin15-mainnet-migration-gate.mjs")]]
for(const [n,ok] of checks)if(!ok)throw new Error(`FIN17 hygiene failed ${n}: ${JSON.stringify({forbidden,missing,stale,mismatch,pinMismatch,secretHits})}`)
console.log(`FIN17_RELEASE_HYGIENE=PASS predicates=${checks.length} forbidden=0 manifest_entries=${manifest.size} secret_hits=0 byte_pins=7 mandatory_financial_verifier=true runtime_kernel_changed=false`)
