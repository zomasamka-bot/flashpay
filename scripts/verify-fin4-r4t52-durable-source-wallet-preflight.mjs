import fs from 'node:fs'
const p='app/api/certification/fin4-r4t-lock-diagnostic/route.ts'
const s=fs.readFileSync(p,'utf8')
const must=[
 "getSettlementCheckpointAuthoritative",
 "process.env.FLASHPAY_FIN4_PAYMENT_B?.trim()",
 "durable.checkpoint.paymentId !== paymentB",
 "durable.checkpoint.stage !== 'a2u_created'",
 "durable.checkpoint.preparedEnvelopeXdr !== undefined",
 "durable.checkpoint.preparedTxHash !== undefined",
 "durable.checkpoint.preparedSequence !== undefined",
 "durable.checkpoint.a2uTxid !== undefined",
 "const sourceWallet = durable.checkpoint.a2uFromAddress",
 "readFin4R4TSubmitLockDiagnostic(sourceWallet)",
 "sourceWalletAuthority: 'postgres_settlement_checkpoint_a2u_created'",
]
for(const x of must) if(!s.includes(x)) throw new Error(`R4T5.2 missing invariant: ${x}`)
const forbidden=[
 "FLASHPAY_PI_PUBLIC_KEY","GCVYA2KC6ANJOW4OMOSUKFLSBMZDYQWZ4S6HA654MIWHG6NZC4ZZOVD5",
 "acquirePiWalletSubmitLock","holdFin4R4TWalletProbe","contendFin4R4TWalletProbe",
 "redis.set(","redis.del(","executeA2U(","executeRefund",
]
for(const x of forbidden) if(s.includes(x)) throw new Error(`R4T5.2 forbidden divergence/mutation: ${x}`)
if(/export\s+async\s+function\s+POST\b/.test(s)) throw new Error('R4T5.2 must remain GET-only')
console.log('PASS verify-fin4-r4t52-durable-source-wallet-preflight')
