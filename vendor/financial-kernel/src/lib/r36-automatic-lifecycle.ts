import {financialNetwork} from './financial-network'
import {generalOperationPolicy} from "./r36-operation-policy"
/** Private producer orchestration. All durable writes stay in the separately
 * authenticated issuer. This module only reads original rows/providers, signs
 * enrolled evidence and submits it to the existing guarded lifecycle functions. */
import {readFile,lstat,realpath} from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {readR36LiveSource,readR36LifecycleHead,type R36ReadOnlySource} from './r36-live-source'
import {appendR36LiveHistories} from './r36-live-history-delta'
import {produceR36TerminalEvidence} from './r36-terminal-evidence-producer'
import {publishR36LifecycleJob} from './r36-lifecycle-publication'
import type {R36DispatchConfig} from './r36-evidence-dispatcher'
import type {R36CertificateResult} from './r36-certificate-consumer'
type Row=Record<string,unknown>
const obj=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v),hex=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v)
function requireFact(v:unknown,s:string):asserts v{if(!v)throw Error(s)}
export function createR36AutomaticLifecycle(db:R36ReadOnlySource,c:R36DispatchConfig,ports:{fetcher:typeof fetch;observe(signal:AbortSignal):Promise<void>;lifecycle(body:Row,signal:AbortSignal):Promise<Row>;register(binding:Row):Promise<R36CertificateResult>}){
 let prior:{context:Row;proofDigest:string;cutoffLedger:string;expiresAt:number}|undefined
 const call=(body:Row)=>ports.lifecycle(body,AbortSignal.timeout(70000))
 async function context(body:Row){await ports.observe(AbortSignal.timeout(8000));const r=await call(body);if(body.action==='prior_context'&&r.outcome==='BLOCKED'&&r.reason==='LIFECYCLE_CONTEXT_UNAVAILABLE')throw Error('AUTOMATIC_TERMINAL_FACTS_PENDING');requireFact(r.outcome==='CONTEXT'&&obj(r.context)&&obj(r.context.policy)&&r.context.policy.policy_digest===c.registrarPolicyDigest,'AUTOMATIC_LIFECYCLE_CONTEXT');return r.context as Row}
 async function facts(p:Row){
  requireFact(hex(p.liveEvidenceInputsSha256),'AUTOMATIC_FACTS_NOT_BOUND')
  const dir=await realpath(c.factsDirectory),file=path.join(dir,c.registrarPolicyDigest+'.json'),s=await lstat(file)
  requireFact(s.isFile()&&!s.isSymbolicLink()&&(s.mode&0o077)===0&&s.size<=48_000_000,'AUTOMATIC_FACTS_STORAGE')
  const raw=await readFile(file);requireFact(createHash('sha256').update(raw).digest('hex')===p.liveEvidenceInputsSha256,'AUTOMATIC_FACTS_DIGEST')
  const f=JSON.parse(raw.toString('utf8'));requireFact(obj(f)&&Object.keys(f).sort().join(',')==='exceptions,histories','AUTOMATIC_FACTS_FIELDS');return f
 }
 async function piRecord(id:unknown):Promise<Row>{
  requireFact(typeof id==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(id),'AUTOMATIC_PI_IDENTITY')
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined
  try{return await Promise.race([(async()=>{
   const r=await ports.fetcher('https://api.minepi.com/v2/payments/'+encodeURIComponent(String(id)),{method:'GET',redirect:'error',cache:'no-store',signal:controller.signal})
   requireFact(r.status===200&&!r.redirected&&r.body,'AUTOMATIC_PI_READ');const reader=r.body!.getReader(),chunks:Uint8Array[]=[];let size=0
   try{for(;;){const b=await reader.read();if(b.done)break;size+=b.value.byteLength;requireFact(size<=2_000_000,'AUTOMATIC_PI_SIZE');chunks.push(b.value)}}finally{await reader.cancel().catch(()=>{})}
   const out=JSON.parse(Buffer.concat(chunks).toString('utf8'));requireFact(obj(out),'AUTOMATIC_PI_RECORD');return out as Row
  })(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('AUTOMATIC_PI_DEADLINE'))},8000)})])}finally{if(timer)clearTimeout(timer)}
 }
 async function prepare(successor?:Row):Promise<Row>{
  try{
   const policies=await db.beginReadOnly(tx=>tx.unsafe('SELECT policy_digest,worker_profile FROM public.r36_certificate_policies WHERE enabled AND NOT revoked'))
   const ps=policies.filter(p=>p.policy_digest===c.registrarPolicyDigest);if(ps.length===0){prior=undefined;return{status:'STANDBY_NO_APPROVED_POLICY'}}
   requireFact(ps.length===1&&obj(ps[0].worker_profile),'AUTOMATIC_POLICY');const profile=ps[0].worker_profile as Row,pilot=profile.recoveryPilot as Row,ingress=pilot?.ingress as Row,wallet=generalOperationPolicy(profile)?.sourceWallet??ingress?.sourceWallet
   requireFact(typeof wallet==='string'&&/^G[A-Z2-7]{55}$/.test(wallet)&&hex(profile.executionScopeDigest),'AUTOMATIC_NEW_WALLET_SCOPE')
   const head=await readR36LifecycleHead(db,wallet),a=head.authority
   if(!a){prior=undefined;return{status:'FIRST_CERTIFICATE_PATH_READY'}}
   if(!head.completed){prior=undefined;return{status:'WAITING_FOR_ORIGINAL_TERMINAL_CHECKPOINT'}}
   if(successor)requireFact(successor.sourceWallet===wallet&&hex(successor.nonce),'AUTOMATIC_SUCCESSOR_IDENTITY')
   const request={action:'prior_context',wallet,paymentId:a.owner_payment_id,...(successor?{nonce:successor.nonce}:{})},ctx=await context(request)
   // An idle wallet has no successor to bind. Keep the original protected
   // context/terminal-fact checks above, but do not persist another identical
   // closure every idle cycle. register(binding) still proves and records the
   // full fresh closure before an actual successor can acquire authority.
   if(!successor)return{status:'WAITING_FOR_SUCCESSOR'}
   const f=await facts(profile)
   // Independent read-only acquisitions may overlap. Nothing is published or
   // accepted until every source succeeds and the original joint review passes.
   const [snapshot,histories,outboundPi]=await Promise.all([
    readR36LiveSource(db,'service'),
    appendR36LiveHistories(f.histories as Parameters<typeof appendR36LiveHistories>[0],profile.liveHistoryPolicy,ports.fetcher),
    piRecord((ctx.terminal as Row).piPaymentId)
   ])
   const as=snapshot.rows.authorities.filter(x=>x.network===financialNetwork()&&x.source_wallet===wallet)
   requireFact(as.length===1&&Object.keys(a).every(k=>as[0][k]===a[k]),'AUTOMATIC_AUTHORITY_CHANGED')
   const completed=a.operation_kind==='settlement'?snapshot.rows.settlements.some(s=>s.payment_id===a.owner_payment_id&&s.stage==='db_finalized'):snapshot.rows.refunds.some(r=>r.payment_id===a.owner_payment_id&&r.refund_id===a.owner_operation_id&&r.status==='completed'&&r.stage==='audit_recorded')
   requireFact(completed,'AUTOMATIC_TERMINAL_CHANGED')
   const made=produceR36TerminalEvidence({context:ctx,snapshot,histories,outboundPi,exceptions:f.exceptions as {records:Row[];isolation:Row[]},executionScopeDigest:profile.executionScopeDigest as string})
   requireFact(made.outcome==='UNSIGNED_TERMINAL_REQUIRES_CUSTODIAN'&&made.artifacts,'AUTOMATIC_TERMINAL_EVIDENCE_'+('reason'in made?made.reason:'MISSING'))
   const r=await publishR36LifecycleJob({kind:'prior',context:ctx,cutoffLedger:String(made.cutoffLedger),artifacts:made.artifacts!,privateKeyPem:c.custodianPrivateKeyPem,jobDirectory:c.jobDirectory,request:{...request,action:'record_prior'}},{refresh:()=>context(request),submit:call})
   requireFact(['RECORDED','REPLAYED'].includes(String(r.outcome))&&hex(r.proofDigest),'AUTOMATIC_PRIOR_NOT_RECORDED')
   // Cache only briefly. The issuer and Runtime revalidate actual stored expiry;
   // this local observation never becomes a financial authority.
   requireFact(Number.isSafeInteger(r.evidenceIssuedAt),'AUTOMATIC_OBSERVATION_TIME')
   prior={context:ctx,proofDigest:String(r.proofDigest),cutoffLedger:String(made.cutoffLedger),expiresAt:Number(r.evidenceIssuedAt)+60}
   return{status:'PRIOR_CLOSURE_RECORDED',proofDigest:r.proofDigest}
  }catch(e){if(e instanceof Error&&e.message==='AUTOMATIC_TERMINAL_FACTS_PENDING'){prior=undefined;return{status:'WAITING_FOR_ORIGINAL_TERMINAL_FACTS'}}return{status:'AUTOMATIC_LIFECYCLE_HELD',reason:e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'AUTOMATIC_SOURCE_UNAVAILABLE'}}
 }
 let registeredStatus:Row|undefined
 function beginCycle(){registeredStatus=undefined}
 // Observation for the scheduler only. It exists only after the exact original
 // registrar/issuer path succeeds in THIS cycle; it grants no financial right.
 function registeredResult(){return registeredStatus?{...registeredStatus}:undefined}
 function cycleResult(fallback:Row){
  // A later, original registrar success may resolve this cycle's earlier
  // unbound-successor observation. Never suppress another evidence failure.
  return fallback.status==='AUTOMATIC_LIFECYCLE_HELD'&&(fallback.reason==='AUTOMATIC_TERMINAL_EVIDENCE_UNRESOLVED_SETTLEMENT_RIGHT'||fallback.reason==='AUTOMATIC_TERMINAL_EVIDENCE_UNRESOLVED_REFUND_RIGHT_NOT_ISOLATED')&&registeredStatus?registeredStatus:fallback
 }
 async function register(binding:Row):Promise<R36CertificateResult>{
  try{const r=await ports.register(binding);requireFact(['RECORDED','REPLAYED'].includes(r.outcome)&&hex(r.certificateDigest)&&r.authorizesFinancialRelease===false&&r.authorizesWalletActivation===false&&r.authorizesRotation===false,'ORIGINAL_REGISTRATION_HELD');registeredStatus={status:'SUCCESSOR_ADMISSION_VERIFIED'};return r}catch(first){
   // A certificate may already be committed. Bind that exact nonce only after
   // the old right has an independently verified original terminal closure.
   const prepared=await prepare(binding)
   if(prepared.status!=='PRIOR_CLOSURE_RECORDED'||!prior||!hex(binding.nonce)||binding.sourceWallet!==(prior.context.prior as Row).source_wallet||binding.paymentId===(prior.context.prior as Row).owner_payment_id)throw first
   const request={action:'bound_context',nonce:binding.nonce,closureDigest:prior.proofDigest},ctx=await context(request)
   const clearance={schema:'R36_BOUND_SUCCESSOR_CLEARANCE_V1',bindingDigest:ctx.bindingDigest,closureDigest:prior.proofDigest,successorNonce:binding.nonce,successorCertificateDigest:ctx.successorCertificateDigest}
   const r=await publishR36LifecycleJob({kind:'bound',context:ctx,cutoffLedger:prior.cutoffLedger,artifacts:{clearance},privateKeyPem:c.custodianPrivateKeyPem,jobDirectory:c.jobDirectory,request:{...request,action:'record_bound'}},{refresh:()=>context(request),submit:call})
   requireFact(['RECORDED','REPLAYED'].includes(String(r.outcome)),'AUTOMATIC_BOUND_NOT_RECORDED')
   // The issuer atomically completed the original certificate replay and exact
   // successor binding. Do not restart the registrar's seven-artifact enrollment.
   // Missing continuation (including an older issuer) fails closed, never falls
   // back to treating a lifecycle proof as financial admission.
   const registered=r.admission
   requireFact(obj(registered)&&registered.outcome==='REPLAYED'&&registered.successorBinding==='REPLAYED'&&
    registered.nonce===binding.nonce&&registered.originalCertificateDigest===ctx.successorCertificateDigest&&hex(registered.certificateDigest)&&
    typeof registered.reason==='string'&&registered.authorizesFinancialRelease===false&&
    registered.authorizesWalletActivation===false&&registered.authorizesRotation===false,'ORIGINAL_REGISTRATION_HELD')
   registeredStatus={status:'SUCCESSOR_ADMISSION_VERIFIED'}
   return{outcome:'REPLAYED',reason:String(registered.reason),certificateDigest:String(registered.certificateDigest),
    authorizesFinancialRelease:false,authorizesWalletActivation:false,authorizesRotation:false}
  }
 }
 return{prepare,register,beginCycle,cycleResult,registeredResult}
}
