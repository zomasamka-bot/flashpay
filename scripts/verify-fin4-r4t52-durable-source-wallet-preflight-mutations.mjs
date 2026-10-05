import fs from 'node:fs'
const s=fs.readFileSync('app/api/certification/fin4-r4t-lock-diagnostic/route.ts','utf8')
function valid(x){
 const must=["getSettlementCheckpointAuthoritative","process.env.FLASHPAY_FIN4_PAYMENT_B?.trim()","durable.checkpoint.paymentId !== paymentB","durable.checkpoint.stage !== 'a2u_created'","durable.checkpoint.preparedEnvelopeXdr !== undefined","durable.checkpoint.preparedTxHash !== undefined","durable.checkpoint.preparedSequence !== undefined","durable.checkpoint.a2uTxid !== undefined","const sourceWallet = durable.checkpoint.a2uFromAddress","readFin4R4TSubmitLockDiagnostic(sourceWallet)","sourceWalletAuthority: 'postgres_settlement_checkpoint_a2u_created'"]
 if(must.some(k=>!x.includes(k))) return false
 const bad=["FLASHPAY_PI_PUBLIC_KEY","GCVYA2KC6ANJOW4OMOSUKFLSBMZDYQWZ4S6HA654MIWHG6NZC4ZZOVD5","acquirePiWalletSubmitLock","holdFin4R4TWalletProbe","contendFin4R4TWalletProbe","redis.set(","redis.del(","executeA2U(","executeRefund"]
 if(bad.some(k=>x.includes(k))) return false
 return !/export\s+async\s+function\s+POST\b/.test(x)
}
const muts=[
 ['drop payment binding',s.replace("durable.checkpoint.paymentId !== paymentB","false")],
 ['drop stage1 gate',s.replace("durable.checkpoint.stage !== 'a2u_created'","false")],
 ['drop prepared xdr gate',s.replace("durable.checkpoint.preparedEnvelopeXdr !== undefined","false")],
 ['drop prepared hash gate',s.replace("durable.checkpoint.preparedTxHash !== undefined","false")],
 ['drop prepared sequence gate',s.replace("durable.checkpoint.preparedSequence !== undefined","false")],
 ['drop movement gate',s.replace("durable.checkpoint.a2uTxid !== undefined","false")],
 ['use old env wallet',s.replace("const sourceWallet = durable.checkpoint.a2uFromAddress","const sourceWallet = process.env.FLASHPAY_PI_PUBLIC_KEY ?? ''")],
 ['hardcode wallet',s.replace("const sourceWallet = durable.checkpoint.a2uFromAddress","const sourceWallet = 'GCVYA2KC6ANJOW4OMOSUKFLSBMZDYQWZ4S6HA654MIWHG6NZC4ZZOVD5'")],
 ['add acquisition',s+"\n// acquirePiWalletSubmitLock"],
]
for(const [n,x] of muts) if(valid(x)) throw new Error(`SURVIVED mutation: ${n}`)
console.log(`PASS verify-fin4-r4t52-durable-source-wallet-preflight-mutations (${muts.length} killed)`)
