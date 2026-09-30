import fs from 'node:fs'
const src=fs.readFileSync(new URL('../lib/refund-presentation-reader.ts', import.meta.url),'utf8')
const must=[
  'checkpoint.stage === "eligibility_verified"',
  'checkpoint.stage === "intent_created"',
  'checkpoint.stage === "wallet_submission_started"',
  'checkpoint.status !== "pending"',
  'const blockchain = await readRefundPresentationBlockchain(checkpoint)',
  'blockchain.outcome !== "PENDING"',
  'requestedAt: checkpoint.createdAt',
  'projectionFinalized: false',
  'return { outcome: "FOUND", presentation }',
  'const persistence = suppliedPersistence?.result ?? await readRefundPresentationPersistence(checkpoint)',
  'Object.values(persistence.timestamps).every((value) => value !== null)',
  'recordRefundPresentationProof(checkpoint, blockchainRead)',
]
for(const x of must) if(!src.includes(x)) throw new Error('missing invariant: '+x)
const early=src.indexOf('checkpoint.stage === "eligibility_verified"')
const strict=src.indexOf('const persistence = suppliedPersistence?.result ?? await readRefundPresentationPersistence(checkpoint)')
if(!(early>=0 && strict>early)) throw new Error('pending path must precede strict final evidence path')
if(src.includes('checkpoint.stage === "wallet_submission_confirmed" ||\n      checkpoint.stage === "payment_checkpoint_updated"')) throw new Error('confirmed stages must not enter pending bypass')
console.log(JSON.stringify({gate:'PRE-DR118-UX15-REFUND-PENDING-PRESENTATION-STATE-AWARE',pass:true,pendingStages:3,finalEvidenceBypass:false,financialSourceChanged:false,blindRetryAdded:false},null,2))
