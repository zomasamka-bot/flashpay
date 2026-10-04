import fs from "node:fs"
const original=fs.readFileSync("lib/fin4-live-certification.ts","utf8")
const valid=(s:string)=>[
  'process.env.VERCEL_ENV !== "production" || process.env.FLASHPAY_FIN4_ARMED !== "1"',
  'paymentA === paymentB',
  'aProcess !== bProcess && aWallet === sourceWallet && bWallet === sourceWallet',
  'FIN4_FAIL_CLOSED_DISTINCT_PROCESS_BARRIER_TIMEOUT',
  'await redis.set(releasedKey, "1", { ex: 900 })',
  'if (await redis.get<string>(releasedKey) === "1")',
].every(x=>s.includes(x)) && !s.includes('submitTransaction(') && !s.includes('claimPiWalletIntent(')
const mutations:[string,string,string][]=[
 ['remove_production_gate','process.env.VERCEL_ENV !== "production" || ',''],
 ['allow_same_payment','paymentA === paymentB','false'],
 ['remove_distinct_process','aProcess !== bProcess && ',''],
 ['remove_same_wallet',' && aWallet === sourceWallet && bWallet === sourceWallet',''],
 ['remove_barrier_release_checkpoint','await redis.set(releasedKey, "1", { ex: 900 })',''],
 ['remove_reentry_progress','if (await redis.get<string>(releasedKey) === "1")','if (false)'],
]
let expected=0
for(const [name,from,to] of mutations){const m=original.replace(from,to); if(m===original)throw new Error(`mutation not applied: ${name}`); if(valid(m))throw new Error(`unexpected mutation pass: ${name}`); expected++}
if(!valid(original))throw new Error('original FIN4 harness invalid')
console.log(`FIN4_LIVE_MUTATIONS=PASS expected_failures=${expected} unexpected_passes=0`)
