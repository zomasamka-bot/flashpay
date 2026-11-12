import {financialHorizonOrigin} from './financial-network'
import {financialIncomingWallet} from './financial-network'
import {type FinancialNetwork,financialNetwork} from './financial-network'
/** Private evidence-service input adapter. No public route, DB mutation, signing,
 * financial POST or retries. Its output is an unsigned observation, not approval.
 * Expected identity must be supplied by the protected original-intent reader.
 */
import {createHash} from 'node:crypto'
import {Transaction,TransactionBuilder} from '@stellar/stellar-sdk'
import {numberToExactPositiveStroops,stellarAmountToExactPositiveStroops,exactPositiveStroopsToStellarAmount} from './financial-amount-stroops'
import {verifyR36IndependentHorizonRecord,type R36HorizonProofInput} from './r36-independent-horizon-proof'

type Row=Record<string,unknown>
export type R36InboundExpected=Readonly<{
 network:FinancialNetwork;paymentId:string;customerUid:string;piPaymentId:string;
 u2aTxid:string;sourceWallet:string;payerWallet:string;amountStroops:string;
 finalityPolicyDigest:string;cutoffLedger:string;
}>
export type R36InboundObservation=Readonly<{
 outcome:'OBSERVATION_VERIFIED_NOT_CERTIFIED'|'BLOCKED';reason:string;
 authorizesFinancialRelease:false;authorizesWalletActivation:false;
 artifact?:Row;sourceDigests?:ReadonlyArray<{url:string;bodySha256:string}>;
}>
const object=(x:unknown):x is Row=>!!x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype
const digest=(x:string)=>createHash('sha256').update(x).digest('hex')
const hex=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x)
const uint=(x:unknown):x is string=>typeof x==='string'&&/^[1-9][0-9]{0,18}$/.test(x)
const wallet=(x:unknown):x is string=>typeof x==='string'&&/^G[A-Z2-7]{55}$/.test(x)
const id=(x:unknown):x is string=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x)
const blocked=(reason:string):R36InboundObservation=>({outcome:'BLOCKED',reason,authorizesFinancialRelease:false,authorizesWalletActivation:false})
const fields=['network','paymentId','customerUid','piPaymentId','u2aTxid','sourceWallet','payerWallet','amountStroops','finalityPolicyDigest','cutoffLedger']

/** Bodies are bounded and redirects are prohibited. Credentials are sent only to
 * the fixed Pi API origin, never to Horizon or a URL returned by a provider. */
export async function collectR36InboundEvidence(expected:R36InboundExpected,piApiKey:string,fetcher:typeof fetch=fetch):Promise<R36InboundObservation>{
 if(!object(expected)||Object.keys(expected).length!==fields.length||!fields.every(k=>Object.hasOwn(expected,k))||
  expected.network!==financialNetwork()||!id(expected.paymentId)||!id(expected.customerUid)||!id(expected.piPaymentId)||
  !hex(expected.u2aTxid)||!hex(expected.finalityPolicyDigest)||!wallet(expected.sourceWallet)||!wallet(expected.payerWallet)||
  expected.sourceWallet===expected.payerWallet||!uint(expected.amountStroops)||!Number.isSafeInteger(Number(expected.amountStroops))||
  !uint(expected.cutoffLedger)||BigInt(expected.cutoffLedger)>BigInt(2147483647)||typeof piApiKey!=='string'||!piApiKey||/[\r\n]/.test(piApiKey))return blocked('INVALID_PROTECTED_EXPECTATION')
 // Do not let an asynchronous caller change the identity after the first read.
 const b=Object.freeze({...expected}),sources:{url:string;bodySha256:string}[]=[]
 async function read(url:string,authenticated=false):Promise<Row>{
  const signal=AbortSignal.timeout(8000)
  // The outer race also bounds injected transports that ignore AbortSignal.
  let timer:ReturnType<typeof setTimeout>|undefined
  try{return await Promise.race([(async()=>{
   const res=await fetcher(url,{method:'GET',redirect:'error',cache:'no-store',signal,
    headers:authenticated?{Authorization:'Key '+piApiKey}:undefined})
   if(res.status!==200||res.redirected)throw Error('PROVIDER_UNAVAILABLE')
   const length=res.headers.get('content-length');if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)>2_000_000))throw Error('BODY_SIZE')
   if(!res.body)throw Error('BODY_MISSING')
   const reader=res.body.getReader(),chunks:Uint8Array[]=[];let size=0
   try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>2_000_000)throw Error('BODY_SIZE');chunks.push(next.value)}}finally{await reader.cancel().catch(()=>{})}
   const text=Buffer.concat(chunks).toString('utf8'),value:unknown=JSON.parse(text)
   if(!object(value))throw Error('BODY_SHAPE')
   sources.push({url,bodySha256:digest(text)});return value
  })(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('PROVIDER_DEADLINE')),8000)})])}finally{if(timer)clearTimeout(timer)}
 }
 try{
  const pi=await read('https://api.minepi.com/v2/payments/'+encodeURIComponent(b.piPaymentId),true)
  const amount=typeof pi.amount==='number'?numberToExactPositiveStroops(pi.amount):stellarAmountToExactPositiveStroops(pi.amount)
  if(pi.identifier!==b.piPaymentId||pi.network!==b.network||pi.direction!=='user_to_app'||pi.user_uid!==b.customerUid||
   pi.from_address!==b.payerWallet||pi.to_address!==financialIncomingWallet()||amount===null||String(amount)!==b.amountStroops||
   !object(pi.metadata)||pi.metadata.paymentId!==b.paymentId||!object(pi.status)||!object(pi.transaction)||
   pi.transaction.txid!==b.u2aTxid||pi.transaction.verified!==true||pi.status.developer_approved!==true||
   pi.status.transaction_verified!==true||pi.status.developer_completed!==true||pi.status.cancelled!==false||pi.status.user_cancelled!==false)
    return blocked('PI_ORIGINAL_IDENTITY_OR_COMPLETION_MISMATCH')
  const h=await read((financialHorizonOrigin()+'/transactions/')+b.u2aTxid)
  if(typeof h.envelope_xdr!=='string'||!uint(String(h.ledger))||BigInt(String(h.ledger))>BigInt(b.cutoffLedger)||
   !/^(0|[1-9][0-9]*)$/.test(String(h.fee_charged)))return blocked('HORIZON_SCOPE_MISMATCH')
  const tx=TransactionBuilder.fromXDR(h.envelope_xdr,financialNetwork())
  if(!(tx instanceof Transaction))return blocked('HORIZON_TRANSACTION_TYPE')
  const input:R36HorizonProofInput={network:financialNetwork(),preparedHash:b.u2aTxid,preparedSequence:tx.sequence,
   sourceWallet:b.payerWallet,destinationWallet:financialIncomingWallet(),amount:exactPositiveStroopsToStellarAmount(Number(b.amountStroops))!,
   envelopeXdr:h.envelope_xdr,expectedFeeStroops:String(h.fee_charged)}
  const proof=verifyR36IndependentHorizonRecord(input,h)
  if(proof.outcome!=='PROVEN')return blocked('HORIZON_'+proof.reason)
  const ledger=await read((financialHorizonOrigin()+'/ledgers/')+String(h.ledger))
  if(String(ledger.sequence)!==String(h.ledger)||!hex(ledger.hash)||typeof ledger.closed_at!=='string'||
   !Number.isFinite(Date.parse(ledger.closed_at))||Date.parse(ledger.closed_at)>Date.now())return blocked('LEDGER_IDENTITY_OR_CLOSURE_MISMATCH')
  const cutoff=String(h.ledger)===b.cutoffLedger?ledger:await read((financialHorizonOrigin()+'/ledgers/')+b.cutoffLedger)
  if(String(cutoff.sequence)!==b.cutoffLedger||!hex(cutoff.hash)||typeof cutoff.closed_at!=='string'||
   !Number.isFinite(Date.parse(cutoff.closed_at))||Date.parse(cutoff.closed_at)<Date.parse(ledger.closed_at)||Date.parse(cutoff.closed_at)>Date.now())return blocked('CUTOFF_IDENTITY_OR_CLOSURE_MISMATCH')
  // Whitelist returned fields: bearer/API keys and arbitrary provider metadata
  // are not copied into artifacts. Whole-body digests preserve audit correlation.
  const piRecord={identifier:pi.identifier,network:pi.network,direction:pi.direction,user_uid:pi.user_uid,from_address:pi.from_address,to_address:pi.to_address,amount:pi.amount,
   metadata:{paymentId:b.paymentId},transaction:{txid:pi.transaction.txid,verified:true},status:{developer_approved:true,transaction_verified:true,developer_completed:true,cancelled:false,user_cancelled:false}}
  const horizonRecord=Object.fromEntries(['hash','successful','ledger','fee_charged','source_account','source_account_sequence','envelope_xdr','result_xdr'].map(k=>[k,h[k]]))
  return {outcome:'OBSERVATION_VERIFIED_NOT_CERTIFIED',reason:'ORIGINAL_PI_HORIZON_AND_LEDGER_LINK_VERIFIED',
   authorizesFinancialRelease:false,authorizesWalletActivation:false,
   artifact:{schema:'R36_INBOUND_FINALITY_V1',finalityPolicyDigest:b.finalityPolicyDigest,ledgerHash:ledger.hash,horizonInput:input,horizonRecord,piRecord},sourceDigests:sources}
 }catch{return blocked('ORIGINAL_PROVIDER_READ_OR_PROOF_FAILED')}
}
