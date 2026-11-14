import {decodeR36Artifact,R36_ARTIFACT_TEXT_BYTES} from './r36-artifact-codec'
import {financialNetwork} from './financial-network'
/** NOT_FOR_DEPLOY. Issuer-side two-phase lifecycle. No private key, financial POST,
 * wallet activation or Runtime enrollment. Signed evidence must be produced by the
 * separately enrolled custodians; supplying synthetic bundles never proves real trust.
 */
import {createHash,createPublicKey,verify} from 'node:crypto'
import {numberToExactPositiveStroops} from './financial-amount-stroops'
import {reviewR36TerminalSnapshot} from './r36-evidence-snapshot'
import {assertR36ExecutionScopePolicy} from './r36-wallet-execution-scope'
import {verifyR36IndependentHorizonRecord,type R36HorizonProofInput} from './r36-independent-horizon-proof'
import type {R36CertificateDatabase} from './r36-certificate-consumer'
type Row=Record<string,unknown>
const obj=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v)
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const fields=['schema','kind','policyDigest','subjectDigest','artifactDigest','issuerId','keyId','network','sourceWallet','cutoffLedger','issuedAt','expiresAt']
const kinds=['wallet_history','accounting','exceptions','exception_isolation','clearance'] as const
const equalKeys=(v:Row,keys:readonly string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k))
const requireProof=(v:unknown,reason:string)=>{if(!v)throw Error(reason)}
const flags={authorizesFinancialRelease:false,authorizesWalletActivation:false,authorizesSubmission:false,authorizesRotation:false} as const
type Result={outcome:'BLOCKED'|'RECORDED'|'REPLAYED';reason:string;proofDigest?:string}&typeof flags
const blocked=(reason:string):Result=>({outcome:'BLOCKED',reason,...flags})
function freezeInput(input:unknown):unknown{
 const text=JSON.stringify(input);if(typeof text!=='string'||text.length>12_000_000)throw Error('EVIDENCE_SIZE')
 return JSON.parse(text)
}
function policy(context:Row){
 const p=context.policy,now=context.nowSeconds
 requireProof(obj(p)&&typeof now==='number'&&Number.isSafeInteger(now),'POLICY_CONTEXT')
 const v=p as Row,n=now as number,profile=v.worker_profile
 requireProof(v.enabled===true&&v.revoked===false&&hex(v.policy_digest)&&obj(profile)&&
  profile.schema==='R36_INDEPENDENT_WORKER_PROFILE_V1'&&profile.approvalDigest===v.approval_record_digest&&
  hex(profile.finalityPolicyDigest)&&profile.issuerId===v.issuer_id&&profile.keyId===v.key_id,'POLICY_IDENTITY')
 const pr=profile as Row,operators=[pr.issuerOperatorId,pr.runtimeOperatorId,pr.migrationOperatorId]
 requireProof(operators.every(x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x))&&new Set(operators).size===3,'POLICY_SEPARATION')
 requireProof(['valid_from','valid_until','max_age_seconds','revocation_checked_at','revocation_valid_until'].every(k=>Number.isSafeInteger(v[k]))&&
  n>=Number(v.valid_from)&&n<Math.min(Number(v.valid_until),Number(v.revocation_valid_until))&&Number(v.revocation_checked_at)<=n&&Number(v.max_age_seconds)>0,'POLICY_VALIDITY')
 return {p:v,profile:pr,now:n}
}
function authenticate(context:Row,kind:string,subject:string,cutoff:string,envelope:unknown){
 const {p,profile,now}=policy(context)
 requireProof(obj(context.prior)&&obj(envelope)&&equalKeys(envelope,['text','manifest','signature']),'ENVELOPE')
 const e=envelope as Row,m=e.manifest
 requireProof(typeof e.text==='string'&&Buffer.byteLength(e.text)<=R36_ARTIFACT_TEXT_BYTES&&obj(m)&&equalKeys(m,fields)&&typeof e.signature==='string','ENVELOPE_FIELDS')
 const v=m as Row
 requireProof(fields.every(k=>typeof v[k]==='string'&&/^[\x20-\x7e]{1,256}$/.test(v[k] as string))&&
  v.schema==='R36_INDEPENDENT_ARTIFACT_V1'&&v.kind===kind&&v.policyDigest===p.policy_digest&&v.subjectDigest===subject&&
  v.artifactDigest===sha(e.text as string)&&v.network===financialNetwork()&&v.sourceWallet===(context.prior as Row).source_wallet&&v.cutoffLedger===cutoff,'EVIDENCE_SCOPE')
 requireProof(Array.isArray(profile.authorities),'EVIDENCE_AUTHORITIES')
 const roots=(profile.authorities as unknown[]).filter(r=>obj(r)&&r.kind===kind&&r.issuerId===v.issuerId&&r.keyId===v.keyId)
 requireProof(roots.length===1&&obj(roots[0]),'EVIDENCE_AUTHORITY')
 const root=roots[0] as Row,start=Number(v.issuedAt),end=Number(v.expiresAt)
 requireProof(root.revoked===false&&typeof root.operatorId==='string'&&root.operatorId!==profile.runtimeOperatorId&&root.operatorId!==profile.migrationOperatorId&&
  [start,end,root.validFrom,root.validUntil,root.revocationCheckedAt,root.revocationValidUntil].every(Number.isSafeInteger)&&
  start>=Number(root.validFrom)&&start<=now&&end>now&&end>start&&end<=Number(root.validUntil)&&
  Number(root.revocationCheckedAt)>=start&&Number(root.revocationCheckedAt)<=now&&Number(root.revocationValidUntil)>now,'EVIDENCE_VALIDITY')
 requireProof(typeof root.publicKeyPem==='string'&&hex(root.publicKeySpkiSha256),'EVIDENCE_KEY')
 const key=createPublicKey(root.publicKeyPem as string),sig=Buffer.from(e.signature as string,'base64')
 requireProof(key.asymmetricKeyType==='ed25519'&&sha(key.export({type:'spki',format:'der'}))===root.publicKeySpkiSha256&&sig.length===64&&
  sig.toString('base64')===e.signature&&verify(null,Buffer.from('FLASHpay:R36:INDEPENDENT_ARTIFACT:V1\n'+JSON.stringify(fields.map(k=>v[k]))),key,sig),'EVIDENCE_SIGNATURE')
 const body:unknown=decodeR36Artifact(e.text as string);requireProof(obj(body),'EVIDENCE_BODY')
 return {body:body as Row,issued:start,expires:Math.min(end,Number(root.revocationValidUntil),Number(p.valid_until),Number(p.revocation_valid_until))}
}
function stroops(v:unknown){
 if(typeof v==='number'){const s=numberToExactPositiveStroops(v);if(s!==null)return String(s)}
 if(typeof v==='string'&&/^(0|[1-9]\d*)(\.\d{1,7})?$/.test(v)){const [a,b='']=v.split('.');return String(BigInt(a)*BigInt(10000000)+BigInt(b.padEnd(7,'0')))}
 throw Error('EXACT_AMOUNT')
}

export async function certifyR36PriorClosure(db:R36CertificateDatabase,policyDigest:string,wallet:string,paymentId:string,input:unknown):Promise<Result>{
 try{
  if(!hex(policyDigest)||!/^G[A-Z2-7]{55}$/.test(wallet)||!/^[A-Za-z0-9_.:-]{1,128}$/.test(paymentId))return blocked('INVALID_CLOSURE_IDENTITY')
  const bundle=freezeInput(input);if(!obj(bundle)||!equalKeys(bundle,kinds))return blocked('FIVE_SIGNED_ARTIFACTS_REQUIRED')
  return await db.begin(async tx=>{
   const stored=await tx.unsafe('SELECT public.r36_lifecycle_job_receipt($1,$2,$3,$4,$5,$6) AS receipt',
    ['prior_closure',policyDigest,wallet,paymentId,null,JSON.stringify(bundle)])
   const receipt=stored.length===1?stored[0].receipt:null
   if(obj(receipt)&&hex(receipt.proofDigest)&&receipt.policyDigest===policyDigest&&receipt.scope==='HISTORICAL_RECORD_ONLY')
    return {outcome:'REPLAYED',reason:'HISTORICAL_RECORD_ONLY_NO_CURRENT_AUTHORITY',proofDigest:receipt.proofDigest,...flags}
   const rows=await tx.unsafe('SELECT public.r36_terminal_review_context($1,$2,$3) AS context',[policyDigest,wallet,paymentId])
   const c=rows.length===1?rows[0].context:null
   if(!obj(c)||!obj(c.prior)||!obj(c.seal)||!obj(c.terminal)||!hex(c.contextDigest))return blocked('TERMINAL_CONTEXT_UNAVAILABLE')
   const {p,profile,now}=policy(c),prior=c.prior,seal=c.seal,terminal=c.terminal
   const clearance=bundle.clearance
   requireProof(obj(clearance)&&obj(clearance.manifest)&&typeof clearance.manifest.cutoffLedger==='string'&&/^[1-9]\d*$/.test(clearance.manifest.cutoffLedger),'CUTOFF')
   const cutoff=(clearance as Row).manifest as Row,cutoffLedger=cutoff.cutoffLedger as string
   const artifacts:Record<string,Row>={},proofs=kinds.map(k=>{const a=authenticate(c,k,c.contextDigest as string,cutoffLedger,bundle[k]);artifacts[k]=a.body;return a})
   const f=artifacts.clearance,pi=f.piRecord,hi=f.horizonInput,hr=f.horizonRecord
   requireProof(f.schema==='R36_TERMINAL_FINALITY_V1'&&f.contextDigest===c.contextDigest&&f.finalityPolicyDigest===profile.finalityPolicyDigest&&
    obj(pi)&&obj(hi)&&obj(hr),'TERMINAL_FINALITY')
   const q=pi as Row,h=hi as Row
   requireProof(h.network===financialNetwork()&&h.sourceWallet===wallet&&h.preparedHash===prior.prepared_tx_hash&&
    h.preparedSequence===prior.prepared_sequence&&h.expectedFeeStroops===seal.horizon_fee_stroops&&stroops(h.amount)===terminal.amountStroops&&
    q.network===financialNetwork()&&q.identifier===terminal.piPaymentId&&q.direction==='app_to_user'&&q.user_uid===terminal.recipientUid&&
    q.from_address===wallet&&q.to_address===h.destinationWallet&&stroops(q.amount)===terminal.amountStroops&&obj(q.status)&&
    q.status.developer_approved===true&&q.status.developer_completed===true&&q.status.transaction_verified===true&&
    q.status.cancelled===false&&q.status.user_cancelled===false&&obj(q.transaction)&&q.transaction.txid===prior.prepared_tx_hash&&q.transaction.verified===true,'PI_TERMINAL_IDENTITY')
   const horizon=verifyR36IndependentHorizonRecord(h as R36HorizonProofInput,hr as Row)
   requireProof(horizon.outcome==='PROVEN'&&horizon.ledger===seal.horizon_ledger&&BigInt(cutoffLedger)>=BigInt(String(seal.horizon_ledger)),'TERMINAL_HORIZON')
   assertR36ExecutionScopePolicy(profile,artifacts,wallet)
   const review=reviewR36TerminalSnapshot({network:financialNetwork(),sourceWallet:wallet,paymentId,operationKind:prior.operation_kind,
    operationId:prior.owner_operation_id,preparedHash:prior.prepared_tx_hash,preparedSequence:prior.prepared_sequence,
    amountStroops:terminal.amountStroops,feeStroops:seal.horizon_fee_stroops,receiptId:terminal.receiptId,entryId:terminal.entryId,cutoffLedger},artifacts)
   requireProof(review.outcome==='VERIFIED_SNAPSHOT','TERMINAL_SNAPSHOT_'+review.reason)
   // Bind the separately supplied finality record to the exact record in full history.
   const history=artifacts.wallet_history.snapshot as Row
   const records=(history.transactions as Row[]).filter(t=>obj(t.input)&&t.input.preparedHash===prior.prepared_tx_hash)
   requireProof(records.length===1&&JSON.stringify(records[0].input)===JSON.stringify(h)&&JSON.stringify(records[0].record)===JSON.stringify(hr),'TERMINAL_HISTORY_FINALITY_CONFLICT')
   const issued=Math.max(...proofs.map(v=>v.issued)),expires=Math.min(...proofs.map(v=>v.expires),issued+Number(p.max_age_seconds))
   requireProof(issued>=Math.floor(Date.parse(String(seal.sealed_at))/1000)&&expires>now,'CLOSURE_VALIDITY')
   const text=JSON.stringify({schema:'R36_VERIFIED_CLOSURE_BUNDLE_V1',contextDigest:c.contextDigest,inventoryDigest:artifacts.wallet_history.transactionsDigest,reviewDigest:review.reviewDigest,artifacts:bundle}),digest=sha(text)
   const out=await tx.unsafe('SELECT public.r36_record_prior_closure($1,$2,$3,$4,$5,$6,$7) AS outcome',[policyDigest,wallet,paymentId,text,digest,issued,expires])
   const outcome=out.length===1?out[0].outcome:null
   if(outcome!=='RECORDED'&&outcome!=='REPLAYED')throw Error('CLOSURE_COMMIT')
   return {outcome,reason:'PRIOR_ONLY_CLOSURE_NO_SUCCESSOR_AUTHORITY',proofDigest:digest,...flags}
  })
 }catch(e){return blocked(e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'CLOSURE_FAILED')}
}

export async function certifyR36BoundSuccessor(db:R36CertificateDatabase,nonce:string,closureDigest:string,input:unknown):Promise<Result>{
 try{
  if(!hex(nonce)||!hex(closureDigest))return blocked('INVALID_SUCCESSOR_IDENTITY')
  const envelope=freezeInput(input)
  return await db.begin(async tx=>{
   const stored=await tx.unsafe('SELECT public.r36_lifecycle_job_receipt($1,$2,$3,$4,$5,$6) AS receipt',
    ['bound_successor',null,null,nonce,closureDigest,JSON.stringify(envelope)])
   const receipt=stored.length===1?stored[0].receipt:null
   if(obj(receipt)&&hex(receipt.proofDigest)&&receipt.scope==='HISTORICAL_RECORD_ONLY')
    return {outcome:'REPLAYED',reason:'HISTORICAL_RECORD_ONLY_NO_CURRENT_AUTHORITY',proofDigest:receipt.proofDigest,...flags}
   const rows=await tx.unsafe('SELECT public.r36_bound_lifecycle_context($1,$2) AS context',[nonce,closureDigest])
   const c=rows.length===1?rows[0].context:null
   if(!obj(c)||!hex(c.bindingDigest)||!obj(envelope)||!obj(envelope.manifest))return blocked('BOUND_CONTEXT_UNAVAILABLE')
   const {p,now}=policy(c),cutoff=envelope.manifest.cutoffLedger
   requireProof(typeof cutoff==='string'&&/^[1-9]\d*$/.test(cutoff),'BOUND_CUTOFF')
   const a=authenticate(c,'clearance',c.bindingDigest,cutoff as string,envelope)
   const expected={schema:'R36_BOUND_SUCCESSOR_CLEARANCE_V1',bindingDigest:c.bindingDigest,closureDigest,successorNonce:nonce,successorCertificateDigest:c.successorCertificateDigest}
   requireProof(equalKeys(a.body,Object.keys(expected))&&Object.entries(expected).every(([k,v])=>a.body[k]===v),'BOUND_SCOPE')
   const expires=Math.min(a.expires,Number(c.closureExpiresAt),Number(c.certificateExpiresAt),a.issued+Number(p.max_age_seconds))
   requireProof(Number.isSafeInteger(expires)&&expires>now,'BOUND_VALIDITY')
   const text=JSON.stringify(envelope),digest=sha(text)
   const result=await tx.unsafe('SELECT public.r36_record_bound_lifecycle($1,$2,$3,$4,$5,$6) AS outcome',[nonce,closureDigest,text,digest,a.issued,expires])
   const outcome=result.length===1?result[0].outcome:null
   if(outcome!=='RECORDED'&&outcome!=='REPLAYED')throw Error('BOUND_COMMIT')
   return {outcome,reason:'EXACT_SUCCESSOR_REGISTERED_ORIGINAL_RUNTIME_GUARDS_REQUIRED',proofDigest:digest,...flags}
  })
 }catch(e){return blocked(e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'BOUND_FAILED')}
}
