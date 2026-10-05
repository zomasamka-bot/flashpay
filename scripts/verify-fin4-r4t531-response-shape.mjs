import fs from 'node:fs'
const paths=[
 'app/api/certification/fin4-r4t-lock-diagnostic/route.ts',
 'app/api/certification/fin4-r4t-lock-holder/route.ts',
 'app/api/certification/fin4-r4t-lock-contender/route.ts',
]
for(const p of paths){
 const s=fs.readFileSync(p,'utf8')
 if(/\{\s*ok\s*:\s*false[^}]*\.\.\.resolved/.test(s)) throw new Error(`${p}: duplicate ok before resolved spread`)
 if(/\{\s*acquired\s*:\s*false[^}]*\.\.\.resolved/.test(s)) throw new Error(`${p}: response field before resolved spread`)
 if(!s.includes('if(!resolved.ok)')) throw new Error(`${p}: fail-closed resolver gate missing`)
}
console.log('PASS verify-fin4-r4t531-response-shape')
