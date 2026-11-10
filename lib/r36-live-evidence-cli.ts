/** Private unsigned producer. Secrets arrive on stdin only. Fixed provider GETs;
 * no financial POST, certificate signing, authority enrollment or Redis fallback. */
import postgres from 'postgres'
import {openR36Envelope} from './r36-prepared-evidence-seal'
import {readR36PreparedSource} from './r36-prepared-evidence-reader'
import {readR36LiveSource,type R36LiveSnapshot} from './r36-live-source'
import {produceR36LiveEvidence,type R36ProducedEvidence} from './r36-live-evidence-producer'
import {collectR36InboundEvidence} from './r36-inbound-evidence-collector'
import {scopeR36LiveSnapshot} from './r36-wallet-execution-scope'
type CompleteInput=Parameters<typeof produceR36LiveEvidence>[0]
export type R36LiveCollectionRequest=Omit<CompleteInput,'snapshot'|'inboundFinality'|'outboundPi'>&{payerWallet:string;finalityPolicyDigest:string}
const blocked=(reason:string):R36ProducedEvidence=>({outcome:'BLOCKED',reason,authorizesFinancialRelease:false,authorizesSubmission:false,authorizesWalletActivation:false,independentCertification:false})
const HOST='ep-falling-bonus-albeetu0.c-3.eu-central-1.aws.neon.tech'
export async function collectR36LiveCandidate(snapshot:R36LiveSnapshot,input:R36LiveCollectionRequest,piApiKey:string,fetcher:typeof fetch=fetch):Promise<R36ProducedEvidence>{
 try{
  if(Buffer.byteLength(JSON.stringify(input))>48_000_000)return blocked('SOURCE_SIZE')
  const q=JSON.parse(JSON.stringify(input)) as R36LiveCollectionRequest
  const observed=JSON.parse(JSON.stringify(snapshot)) as R36LiveSnapshot;let d=observed.rows
  if(observed.session.read_only!=='on'||observed.session.isolation!=='repeatable read')return blocked('CONSISTENT_READONLY_SNAPSHOT_REQUIRED')
  if(q.executionScopeDigest!==undefined){
   const scopes=(d.executionScopes??[]).filter(r=>r.scope_digest===q.executionScopeDigest&&r.source_wallet===q.sourceWallet)
   if(scopes.length!==1)return blocked('APPROVED_EXECUTION_SCOPE_REQUIRED')
   d=scopeR36LiveSnapshot(observed,String(scopes[0].scope_text),q.executionScopeDigest,q.sourceWallet).snapshot.rows
  }
  // Reject unresolved old rights before any provider work. No guessed isolation.
  if(d.refunds.some(r=>r.payment_id!==q.paymentId&&['pending','manual_review_required'].includes(String(r.status))&&
    !d.authorities.some(a=>a.network==='Pi Testnet'&&a.operation_kind==='refund'&&a.owner_payment_id===r.payment_id&&a.owner_operation_id===r.refund_id&&a.state==='prepared'&&a.source_wallet!==q.sourceWallet)))return blocked('UNRESOLVED_REFUND_RIGHT_NOT_ISOLATED')
  if(d.settlements.some(s=>s.payment_id!==q.paymentId&&['a2u_created','prepared','horizon_confirmed','pi_completed'].includes(String(s.stage))&&(!s.a2u_from_address||s.a2u_from_address===q.sourceWallet)))return blocked('UNRESOLVED_SETTLEMENT_RIGHT')
  const cps=d.settlements.filter(s=>s.payment_id===q.paymentId);if(cps.length!==1)return blocked('ORIGINAL_SETTLEMENT_IDENTITY_REQUIRED')
  const cp=cps[0],raw=cp.customer_amount
  if(typeof raw!=='string'||!/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,18})?$/.test(raw))return blocked('ORIGINAL_AMOUNT_INVALID')
  const [whole,decimal='']=raw.split('.');if(!/^0*$/.test(decimal.slice(7)))return blocked('ORIGINAL_AMOUNT_PRECISION')
  const units=String(BigInt(whole)*BigInt(10000000)+BigInt(decimal.slice(0,7).padEnd(7,'0')))
  const refunds=d.refunds.filter(r=>r.payment_id===q.paymentId)
  const piOutId=q.kind==='settlement'?cp.a2u_payment_id:refunds.length===1?refunds[0].refund_payment_id:null
  if(typeof piOutId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(piOutId))return blocked('ORIGINAL_OUTBOUND_IDENTITY_REQUIRED')
  const primary=q.histories.filter(h=>h.wallet===q.sourceWallet);if(primary.length!==1)return blocked('PRIMARY_HISTORY_REQUIRED')
  const inbound=await collectR36InboundEvidence({network:'Pi Testnet',paymentId:q.paymentId,customerUid:String(cp.payer_uid),piPaymentId:String(cp.u2a_identifier),u2aTxid:String(cp.u2a_txid),sourceWallet:q.sourceWallet,payerWallet:q.payerWallet,amountStroops:units,finalityPolicyDigest:q.finalityPolicyDigest,cutoffLedger:primary[0].cutoffLedger},piApiKey,fetcher)
  if(inbound.outcome!=='OBSERVATION_VERIFIED_NOT_CERTIFIED'||!inbound.artifact)return blocked(inbound.reason)
  let timer:ReturnType<typeof setTimeout>|undefined
  const outboundPi=await Promise.race([(async()=>{
   const r=await fetcher('https://api.minepi.com/v2/payments/'+encodeURIComponent(piOutId),{method:'GET',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(8000),headers:{Authorization:'Key '+piApiKey}})
   if(r.status!==200||r.redirected||!r.body)throw Error('OUTBOUND_PROVIDER_READ')
   const reader=r.body.getReader(),chunks:Uint8Array[]=[];let size=0
   try{for(;;){const b=await reader.read();if(b.done)break;size+=b.value.byteLength;if(size>2_000_000)throw Error('OUTBOUND_BODY_SIZE');chunks.push(b.value)}}finally{await reader.cancel().catch(()=>{})}
   return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>
  })(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('OUTBOUND_PROVIDER_DEADLINE')),8000)})]).finally(()=>{if(timer)clearTimeout(timer)})
  return produceR36LiveEvidence({...q,snapshot:observed,inboundFinality:inbound.artifact,outboundPi})
 }catch{return blocked('LIVE_COLLECTION_FAILED_CLOSED')}
}
if(require.main===module){
 void(async()=>{
  const chunks:Buffer[]=[];let size=0
  for await(const raw of process.stdin){const b=Buffer.from(raw);size+=b.length;if(size>50_000_000)throw Error('CONFIG_SIZE');chunks.push(b)}
  const c=JSON.parse(Buffer.concat(chunks).toString('utf8'));chunks.length=0
  if(!c||typeof c!=='object'||Object.keys(c).sort().join(',')!=='custodyDecryptionKey,database,piApiKey,request')throw Error('CONFIG_FIELDS')
  const u=new URL(c.database)
  if(u.protocol!=='postgresql:'||u.hostname!==HOST||u.username!=='r36_evidence_reader'||u.pathname!=='/neondb'||u.search||u.hash||!u.password)throw Error('DATABASE_TARGET')
  const sql=postgres(c.database,{max:1,prepare:false,connect_timeout:10,ssl:{rejectUnauthorized:true,servername:HOST},onnotice:()=>{},connection:{application_name:'flashpay_r36_readonly_evidence',default_transaction_read_only:true,statement_timeout:30000,lock_timeout:3000}})
  try{
   if(!c.request||Object.prototype.hasOwnProperty.call(c.request,'preparedEnvelopeXdr'))throw Error('CALLER_ENVELOPE_FORBIDDEN')
   const {snapshot,candidate}=await readR36PreparedSource({beginReadOnly:async<T>(fn:Parameters<Parameters<typeof readR36LiveSource>[0]['beginReadOnly']>[0])=>sql.begin('isolation level repeatable read read only',async tx=>fn({unsafe:async s=>tx.unsafe(s)})) as Promise<T>},c.request.paymentId)
   if(candidate.identity.operationKind!==c.request.kind||candidate.identity.sourceWallet!==c.request.sourceWallet)throw Error('CANDIDATE_REQUEST_CONFLICT')
   const out=await collectR36LiveCandidate(snapshot,{...c.request,preparedEnvelopeXdr:openR36Envelope(candidate,c.custodyDecryptionKey)},c.piApiKey);process.stdout.write(JSON.stringify(out)+'\n');if(out.outcome==='BLOCKED')process.exitCode=2
  }finally{await sql.end({timeout:3})}
 })().catch(()=>{process.stderr.write('R36_LIVE_PRODUCER_FAIL_CLOSED\n');process.exitCode=2})
}
