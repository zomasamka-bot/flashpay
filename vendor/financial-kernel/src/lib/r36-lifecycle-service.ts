import {gunzipSync} from 'node:zlib'
/** Private issuer adapter. Only protected original contexts and immutable
 * custodian artifacts are accepted. No caller SQL, policy or financial request. */
import type {R36CertificateDatabase} from './r36-certificate-consumer'
import {consumeR36AdmissionCertificate} from './r36-certificate-consumer'
import {certifyR36PriorClosure,certifyR36BoundSuccessor} from './r36-wallet-lifecycle'
import {certifyR36ProductionAdmission} from './r36-successor-registration'
import {createHash} from 'node:crypto'
import type {R36WorkerPorts} from './r36-certificate-worker'
type Row=Record<string,unknown>
const obj=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v)
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v)
const exact=(v:Row,n:string[])=>Object.keys(v).length===n.length&&n.every(k=>Object.hasOwn(v,k))
const kinds=['wallet_history','accounting','exceptions','exception_isolation','clearance'] as const
const flags={financialAuthority:false,financialSubmission:false}
export function createR36LifecycleHandler(db:R36CertificateDatabase,policyDigest:string,continuation?:Pick<R36WorkerPorts,'readEvidence'>){
 if(!hex(policyDigest))throw Error('LIFECYCLE_POLICY')
 return async(input:unknown):Promise<Row>=>{
  const fail=(reason:string):Row=>({schema:'R36_LIFECYCLE_RESPONSE_V1',outcome:'BLOCKED',reason,...flags})
  try{
   if(!obj(input)||typeof input.action!=='string'||Buffer.byteLength(JSON.stringify(input))>12_100_000)return fail('LIFECYCLE_REQUEST')
   if(input.action==='closed_archive'){
    if(!exact(input,['action','operation','jobKey','payload'])||!['pending','lookup','retain','released','defer'].includes(String(input.operation))||typeof input.jobKey!=='string'||typeof input.payload!=='string')return fail('ARCHIVE_REQUEST')
    let raw=input.payload
    if(input.operation==='retain'){
     const packed=Buffer.from(raw,'base64');if(packed.length>8_000_000||packed.toString('base64')!==raw)return fail('ARCHIVE_ENCODING')
     const plain=gunzipSync(packed,{maxOutputLength:29_000_000});raw=plain.toString('utf8');if(!Buffer.from(raw).equals(plain))return fail('ARCHIVE_ENCODING')
    }
    return await db.begin(async tx=>{
     const r=await tx.unsafe('SELECT public.r36_closed_archive($1,$2,$3,$4) AS archive',[policyDigest,input.operation,input.jobKey,raw])
     return{schema:'R36_LIFECYCLE_RESPONSE_V1',outcome:'ARCHIVE_RESPONSE',archive:r[0]?.archive,...flags}
    })
   }
   if(input.action==='archive_prior'){
    if(!exact(input,['action','wallet','paymentId','bundle'])||typeof input.wallet!=='string'||!/^G[A-Z2-7]{55}$/.test(input.wallet)||
     typeof input.paymentId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.paymentId)||!obj(input.bundle)||!exact(input.bundle,[...kinds]))return fail('ARCHIVE_IDENTITY')
    const body=JSON.stringify(input.bundle),wallet=input.wallet,paymentId=input.paymentId
    return await db.begin(async tx=>{
     const rows=await tx.unsafe('SELECT public.r36_lifecycle_job_receipt($1,$2,$3,$4,$5,$6) AS receipt',
      ['prior_closure',policyDigest,wallet,paymentId,null,body])
     const receipt=rows.length===1?rows[0].receipt:null
     if(!obj(receipt)||!hex(receipt.proofDigest)||receipt.policyDigest!==policyDigest||receipt.scope!=='HISTORICAL_RECORD_ONLY')return fail('ARCHIVE_NOT_RETAINED')
     return{schema:'R36_LIFECYCLE_RESPONSE_V1',outcome:'ARCHIVED',archive:{schema:'R36_PRIOR_ARCHIVE_ACK_V1',policyDigest,
      proofDigest:receipt.proofDigest,bundleSha256:createHash('sha256').update(body).digest('hex')},...flags}
    })
   }
   const q=JSON.parse(JSON.stringify(input)) as Row,prior=q.action==='prior_context'||q.action==='record_prior',bound=q.action==='bound_context'||q.action==='record_bound'
   if(!prior&&!bound)return fail('LIFECYCLE_ACTION')
   const renewal=prior&&Object.hasOwn(q,'nonce')
   const recording=String(q.action).startsWith('record_'),fields=['action',...(prior?['wallet','paymentId',...(renewal?['nonce']:[])]:['nonce','closureDigest']),...(recording?['subjectDigest','bundle']:[])]
   if(!exact(q,fields)||prior&&(typeof q.wallet!=='string'||!/^G[A-Z2-7]{55}$/.test(q.wallet)||typeof q.paymentId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(q.paymentId))||bound&&(!hex(q.nonce)||!hex(q.closureDigest)))return fail('LIFECYCLE_IDENTITY')
   const started=performance.now()
   // The physical-session/ACL adapter is still entered for EVERY request. Keep
   // policy -> request -> wallet locks on one connection until verification and
   // recording finish. Observer refresh remains outside this transaction.
   return await db.begin(async tx=>{
   const scoped:R36CertificateDatabase={begin:fn=>fn(tx)}
   let successor:Row|undefined
   if(renewal){
    if(!hex(q.nonce))return fail('LIFECYCLE_RENEWAL_NONCE')
    const rows=await tx.unsafe('SELECT public.r36_certificate_context($1) AS context',[q.nonce])
    const c=rows.length===1?rows[0].context:null
    if(!obj(c)||!obj(c.binding)||!obj(c.policy)||c.policy.policyDigest!==policyDigest||c.binding.sourceWallet!==q.wallet||c.binding.paymentId===q.paymentId||!obj(c.receipt))return fail('LIFECYCLE_SUCCESSOR_CERTIFICATE_REQUIRED')
    // Re-verify the already stored exact Ed25519 certificate and current SQL
    // revocation. This replays its receipt; it does not request another signature.
    const accepted=await consumeR36AdmissionCertificate(scoped,c.receipt)
    if(accepted.outcome!=='REPLAYED')return fail('LIFECYCLE_SUCCESSOR_CERTIFICATE_NOT_CURRENT')
    successor=c.binding
   }
   const context=await (async()=>{
    const rows=prior?await tx.unsafe('SELECT public.r36_terminal_review_context($1,$2,$3) AS context',[policyDigest,q.wallet,q.paymentId]):await tx.unsafe('SELECT public.r36_bound_lifecycle_context($1,$2) AS context',[q.nonce,q.closureDigest])
    const c=rows.length===1?rows[0].context:null
    if(!obj(c)||!obj(c.policy)||c.policy.policy_digest!==policyDigest)return null
    return c
   })()
   if(!context)return fail('LIFECYCLE_CONTEXT_UNAVAILABLE')
   if(successor){
    if(!obj(context.prior)||!/^\d+$/.test(String(context.prior.prepared_sequence))||!/^\d+$/.test(String(successor.preparedSequence))||BigInt(String(successor.preparedSequence))!==BigInt(String(context.prior.prepared_sequence))+BigInt(1))return fail('LIFECYCLE_SUCCESSOR_SEQUENCE')
    context.successorBinding=successor
   }
   const subject=prior?context.contextDigest:context.bindingDigest
   if(!hex(subject))return fail('LIFECYCLE_CONTEXT_IDENTITY')
   if(!recording){
    let closureCurrent=false
    if(prior&&!renewal){
     const rows=await tx.unsafe('SELECT public.r36_current_prior_observation($1,$2,$3,$4) AS current',[policyDigest,q.wallet,q.paymentId,subject])
     closureCurrent=rows.length===1&&rows[0].current===true
    }
    return{schema:'R36_LIFECYCLE_RESPONSE_V1',outcome:'CONTEXT',context,closureCurrent,...flags}
   }
   const expected=prior?[...kinds]:['clearance']
   if(q.subjectDigest!==subject||!obj(q.bundle)||!exact(q.bundle,expected))return fail('LIFECYCLE_ARTIFACT_BINDING')
   const artifacts=q.bundle
   const contextMs=Math.round(performance.now()-started)
   const result=prior?await certifyR36PriorClosure(scoped,policyDigest,q.wallet as string,q.paymentId as string,artifacts):await certifyR36BoundSuccessor(scoped,q.nonce as string,q.closureDigest as string,artifacts.clearance)
   if(result.outcome==='BLOCKED')throw Error(result.reason)
   const recordedMs=Math.round(performance.now()-started)
   let admission:Awaited<ReturnType<typeof certifyR36ProductionAdmission>>|undefined
   if(bound&&continuation){
    // SQL has bound this successor already. Continue from its EXACT durable
    // certificate, never re-enroll the request or contact the signer. Retain the
    // original seven-artifact review, current policy/key checks and SQL replay.
    // A changed/expired/revoked certificate or failed binding rolls back this
    // entire recording; no readiness acknowledgment can escape before commit.
    if(!hex(context.successorCertificateDigest)||context.successorNonce!==q.nonce)throw Error('BOUND_CERTIFICATE_REQUIRED')
    admission=await certifyR36ProductionAdmission(scoped,q.nonce as string,{
     readEvidence:continuation.readEvidence,
     signOnce:async()=>{throw Error('BOUND_CONTINUATION_CANNOT_SIGN')},
    })
    // The lifecycle binds the permanent original digest. SQL80/81 may supply
    // its current, append-only renewal receipt to the worker under the SAME
    // protected nonce. Never confuse that renewal digest with a replacement.
    if(admission.outcome!=='REPLAYED'||!hex(admission.certificateDigest)||
     admission.successorBinding!=='REPLAYED'||admission.authorizesFinancialRelease!==false||
     admission.authorizesWalletActivation!==false||admission.authorizesRotation!==false)
     throw Error('BOUND_CERTIFICATE_CONTINUATION_DENIED')
   }
   console.info('[R36 LIFECYCLE TIMING]',{action:q.action,contextMs,verificationMs:recordedMs-contextMs,
    continuationMs:Math.round(performance.now()-started)-recordedMs,totalMs:Math.round(performance.now()-started),outcome:result.outcome})
   // This adapter returns only after db.begin commits. Confirm exact immutable
   // artifact retention before the producer may retire its redundant local job.
   let archive:Row|undefined
   if(prior){
    const retained=await tx.unsafe('SELECT public.r36_lifecycle_job_receipt($1,$2,$3,$4,$5,$6) AS receipt',
     ['prior_closure',policyDigest,q.wallet,q.paymentId,null,JSON.stringify(artifacts)])
    const receipt=retained.length===1?retained[0].receipt:null
    if(!obj(receipt)||receipt.proofDigest!==result.proofDigest||receipt.policyDigest!==policyDigest||receipt.scope!=='HISTORICAL_RECORD_ONLY')throw Error('LIFECYCLE_ARCHIVE_UNCONFIRMED')
    archive={schema:'R36_PRIOR_ARCHIVE_ACK_V1',policyDigest,proofDigest:result.proofDigest,
     bundleSha256:createHash('sha256').update(JSON.stringify(artifacts)).digest('hex')}
   }
   return{schema:'R36_LIFECYCLE_RESPONSE_V1',...result,...flags,...(archive?{archive}:{}),...(admission?{
    admission:{...admission,nonce:q.nonce,originalCertificateDigest:context.successorCertificateDigest},
   }:{})}
   })
  }catch(e){return fail(e instanceof Error&&/^[A-Z0-9_]{1,96}$/.test(e.message)?e.message:'LIFECYCLE_REQUEST_FAILED_CLOSED')}
 }
}
