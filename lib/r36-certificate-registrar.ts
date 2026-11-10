/** NOT_FOR_DEPLOY. Protected registrar service, never a Runtime/public route.
 * Uses the original seven-artifact verifier without permitting signing or certificate
 * consumption. SQL atomically enrolls the reviewed request and its exact signing bytes.
 * The independently enrolled registrar is a trust principal; possession of this module
 * or synthetic fixtures does not establish evidence custody or financial authority.
 */
import {createHash,createPublicKey} from 'node:crypto'
import {R36_ADMISSION_FIELDS,type R36CertificateDatabase} from './r36-certificate-consumer'
import {runR36CertificateWorker,type R36WorkerPorts} from './r36-certificate-worker'

const hash=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex')
const hex=/^[0-9a-f]{64}$/
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype
const noAuthority={authorizesFinancialRelease:false,authorizesWalletActivation:false,authorizesRotation:false} as const
type Result={outcome:'BLOCKED'|'ENROLLED'|'REPLAYED';reason:string;payloadDigest?:string}&typeof noAuthority
const blocked=(reason:string):Result=>({outcome:'BLOCKED',reason,...noAuthority})

/** The caller supplies only an independently recovered immutable intent, not a browser
 * assertion. SQL supplies the policy, clock, and stable issuedAt on retry. No signing
 * key is accepted. Existing issuer/signer services remain the only certificate path.
 */
export async function registerR36CertificateRequest(db:R36CertificateDatabase,policyDigest:string,binding:unknown,
  readEvidence:R36WorkerPorts['readEvidence'],requestStartedAt?:number):Promise<Result>{
 try{
  if(!hex.test(policyDigest)||!object(binding)||Object.keys(binding).length!==R36_ADMISSION_FIELDS.length||
   !R36_ADMISSION_FIELDS.every(k=>typeof binding[k]==='string'&&/^[\x20-\x7e]{1,256}$/.test(binding[k] as string)))return blocked('INVALID_REGISTRATION_BINDING')
  const b={...binding} as Record<typeof R36_ADMISSION_FIELDS[number],string>
  if(b.network!=='Pi Testnet'||!hex.test(b.nonce)||!['settlement','refund'].includes(b.operationKind)||
   !['sourceWallet','destinationWallet'].every(k=>/^G[A-Z2-7]{55}$/.test(b[k as keyof typeof b]))||
   !['paymentId','operationId','piPaymentId'].every(k=>/^[A-Za-z0-9_.:-]{1,128}$/.test(b[k as keyof typeof b]))||
   !['preparedSequence','amountStroops','cutoffLedger'].every(k=>/^[1-9][0-9]{0,29}$/.test(b[k as keyof typeof b]))||
   !['preparedHash','u2aTxid','envelopeXdrTextSha256','immutableIntentDigest','inboundFinalityDigest','walletHistoryDigest',
    'accountingDigest','clearanceDigest','exceptionsDigest','exceptionIsolationDigest'].every(k=>hex.test(b[k as keyof typeof b])))return blocked('INVALID_REGISTRATION_SCOPE')
  return await db.begin(async tx=>{
   const rows=await tx.unsafe('SELECT r36_registration.context($1,$2) AS context',[policyDigest,b.nonce])
   const c=rows.length===1?rows[0].context:null
   if(!object(c)||!object(c.policy)||typeof c.nowSeconds!=='number'||typeof c.requestCreatedAt!=='number')return blocked('REGISTRATION_CONTEXT_UNAVAILABLE')
   if(c.renewalUnavailable===true)return blocked('RENEWAL_NOT_ELIGIBLE')
   // The private operator may capture the DB clock before refreshing revocation.
   // Existing requests retain their durable issuance time. Never backdate to the
   // previous revocation observation or accept a browser-supplied timestamp.
   if(requestStartedAt!==undefined&&(!Number.isSafeInteger(requestStartedAt)||typeof c.requestExists!=='boolean'))return blocked('INVALID_REGISTRATION_START')
   const p=c.policy,now=c.nowSeconds,issued=requestStartedAt!==undefined&&c.requestExists===false?requestStartedAt:c.requestCreatedAt
   if(p.policyDigest!==policyDigest||p.enabled!==true||p.revoked!==false||typeof p.validFrom!=='number'||typeof p.validUntil!=='number'||
    typeof p.maxAgeSeconds!=='number'||typeof p.revocationCheckedAt!=='number'||typeof p.revocationValidUntil!=='number'||
    ![now,issued,p.validFrom,p.validUntil,p.maxAgeSeconds,p.revocationCheckedAt,p.revocationValidUntil].every(Number.isSafeInteger)||
    issued<p.validFrom||issued>now||now<p.validFrom||now>=p.validUntil||p.maxAgeSeconds<=0||p.revocationCheckedAt<issued||
    p.revocationCheckedAt>now||now>=p.revocationValidUntil)return blocked('REGISTRATION_POLICY_NOT_CURRENT')
   if(typeof p.publicKeyPem!=='string'||typeof p.publicKeySpkiSha256!=='string'||!hex.test(p.publicKeySpkiSha256))return blocked('REGISTRATION_KEY_UNAVAILABLE')
   const key=createPublicKey(p.publicKeyPem)
   if(key.asymmetricKeyType!=='ed25519'||hash(key.export({type:'spki',format:'der'}))!==p.publicKeySpkiSha256)return blocked('REGISTRATION_KEY_PIN_INVALID')
   const expires=Math.min(p.validUntil,issued+p.maxAgeSeconds)
   if(expires<=now)return blocked('REGISTRATION_REQUEST_EXPIRED')
   let approved:Parameters<R36WorkerPorts['signOnce']>[0]|undefined
   // A read-only adapter deliberately stops at signOnce: no real signer or SQL writer
   // is reachable. Original verifier validates all seven signed artifacts and snapshots.
   const review=await runR36CertificateWorker({begin:fn=>fn({unsafe:async(q,v)=>{
    if(q!=='SELECT public.r36_certificate_context($1) AS context'||v?.length!==1||v[0]!==b.nonce)throw Error('READ_ONLY_REVIEW')
    return [{context:{binding:b,policy:p,nowSeconds:now,requestCreatedAt:issued,receipt:null,...(c.renewalGeneration===undefined?{}:{renewalGeneration:c.renewalGeneration,evidenceNotBefore:c.evidenceNotBefore})}}]
   }})},b.nonce,{readEvidence,signOnce:async request=>{approved={...request};throw Error('REVIEW_END_BEFORE_SIGNING')}})
   if(!approved)return blocked('REGISTRATION_'+review.reason)
   const request=approved as Parameters<R36WorkerPorts['signOnce']>[0]
   const reviewDigest=hash(JSON.stringify({schema:'R36_REGISTRATION_REVIEW_V1',policyDigest,approvalRecordDigest:p.approvalRecordDigest,
    binding:R36_ADMISSION_FIELDS.map(k=>b[k]),payloadDigest:request.idempotencyKey,issued,expires}))
   const recordedReview=c.renewalGeneration===undefined?reviewDigest:hash('FLASHpay:R36:RENEWAL_REVIEW:V1\n'+[policyDigest,b.nonce,request.idempotencyKey,String(c.renewalGeneration),String(c.evidenceNotBefore)].join('\n'))
   const result=await tx.unsafe('SELECT r36_registration.enroll($1,$2::text::jsonb,$3,$4,$5,$6,$7) AS outcome',
    [policyDigest,JSON.stringify(b),request.bytesBase64,request.idempotencyKey,issued,expires,recordedReview])
   const outcome=result.length===1?result[0].outcome:null
   if(outcome!=='ENROLLED'&&outcome!=='REPLAYED')throw Error('REGISTRATION_NOT_COMMITTED')
   return {outcome,reason:'REQUEST_AND_SIGNING_PERMISSION_ATOMIC_NOT_A_CERTIFICATE',payloadDigest:request.idempotencyKey,...noAuthority}
  })
 }catch{return blocked('REGISTRATION_TRANSACTION_FAILED')}
}
