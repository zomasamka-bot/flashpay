/** Private issuer adapter. Only protected original contexts and immutable
 * custodian artifacts are accepted. No caller SQL, policy or financial request. */
import type {R36CertificateDatabase} from './r36-certificate-consumer'
import {consumeR36AdmissionCertificate} from './r36-certificate-consumer'
import {certifyR36PriorClosure,certifyR36BoundSuccessor} from './r36-wallet-lifecycle'
type Row=Record<string,unknown>
const obj=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v)
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v)
const exact=(v:Row,n:string[])=>Object.keys(v).length===n.length&&n.every(k=>Object.hasOwn(v,k))
const kinds=['wallet_history','accounting','exceptions','exception_isolation','clearance'] as const
const flags={financialAuthority:false,financialSubmission:false}
export function createR36LifecycleHandler(db:R36CertificateDatabase,policyDigest:string){
 if(!hex(policyDigest))throw Error('LIFECYCLE_POLICY')
 return async(input:unknown):Promise<Row>=>{
  const fail=(reason:string):Row=>({schema:'R36_LIFECYCLE_RESPONSE_V1',outcome:'BLOCKED',reason,...flags})
  try{
   if(!obj(input)||typeof input.action!=='string'||Buffer.byteLength(JSON.stringify(input))>12_100_000)return fail('LIFECYCLE_REQUEST')
   const q=JSON.parse(JSON.stringify(input)) as Row,prior=q.action==='prior_context'||q.action==='record_prior',bound=q.action==='bound_context'||q.action==='record_bound'
   if(!prior&&!bound)return fail('LIFECYCLE_ACTION')
   const renewal=prior&&Object.hasOwn(q,'nonce')
   const recording=String(q.action).startsWith('record_'),fields=['action',...(prior?['wallet','paymentId',...(renewal?['nonce']:[])]:['nonce','closureDigest']),...(recording?['subjectDigest','bundle']:[])]
   if(!exact(q,fields)||prior&&(typeof q.wallet!=='string'||!/^G[A-Z2-7]{55}$/.test(q.wallet)||typeof q.paymentId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(q.paymentId))||bound&&(!hex(q.nonce)||!hex(q.closureDigest)))return fail('LIFECYCLE_IDENTITY')
   let successor:Row|undefined
   if(renewal){
    if(!hex(q.nonce))return fail('LIFECYCLE_RENEWAL_NONCE')
    const c=await db.begin(async tx=>{const rows=await tx.unsafe('SELECT public.r36_certificate_context($1) AS context',[q.nonce]);return rows.length===1?rows[0].context:null})
    if(!obj(c)||!obj(c.binding)||!obj(c.policy)||c.policy.policyDigest!==policyDigest||c.binding.sourceWallet!==q.wallet||c.binding.paymentId===q.paymentId||!obj(c.receipt))return fail('LIFECYCLE_SUCCESSOR_CERTIFICATE_REQUIRED')
    // Re-verify the already stored exact Ed25519 certificate and current SQL
    // revocation. This replays its receipt; it does not request another signature.
    const accepted=await consumeR36AdmissionCertificate(db,c.receipt)
    if(accepted.outcome!=='REPLAYED')return fail('LIFECYCLE_SUCCESSOR_CERTIFICATE_NOT_CURRENT')
    successor=c.binding
   }
   const context=await db.begin(async tx=>{
    const rows=prior?await tx.unsafe('SELECT public.r36_terminal_review_context($1,$2,$3) AS context',[policyDigest,q.wallet,q.paymentId]):await tx.unsafe('SELECT public.r36_bound_lifecycle_context($1,$2) AS context',[q.nonce,q.closureDigest])
    const c=rows.length===1?rows[0].context:null
    if(!obj(c)||!obj(c.policy)||c.policy.policy_digest!==policyDigest)return null
    return c
   })
   if(!context)return fail('LIFECYCLE_CONTEXT_UNAVAILABLE')
   if(successor){
    if(!obj(context.prior)||!/^\d+$/.test(String(context.prior.prepared_sequence))||!/^\d+$/.test(String(successor.preparedSequence))||BigInt(String(successor.preparedSequence))!==BigInt(String(context.prior.prepared_sequence))+BigInt(1))return fail('LIFECYCLE_SUCCESSOR_SEQUENCE')
    context.successorBinding=successor
   }
   const subject=prior?context.contextDigest:context.bindingDigest
   if(!hex(subject))return fail('LIFECYCLE_CONTEXT_IDENTITY')
   if(!recording)return{schema:'R36_LIFECYCLE_RESPONSE_V1',outcome:'CONTEXT',context,...flags}
   const expected=prior?[...kinds]:['clearance']
   if(q.subjectDigest!==subject||!obj(q.bundle)||!exact(q.bundle,expected))return fail('LIFECYCLE_ARTIFACT_BINDING')
   const artifacts=q.bundle
   const result=prior?await certifyR36PriorClosure(db,policyDigest,q.wallet as string,q.paymentId as string,artifacts):await certifyR36BoundSuccessor(db,q.nonce as string,q.closureDigest as string,artifacts.clearance)
   return{schema:'R36_LIFECYCLE_RESPONSE_V1',...result,...flags}
  }catch{return fail('LIFECYCLE_REQUEST_FAILED_CLOSED')}
 }
}
