import {financialNetwork} from './financial-network'
/** Private unsigned terminal producer. The issuer re-reads protected context and
 * authenticates all five artifacts. No policy, signing key, SQL writer or POST. */
import {composeR36OriginalWalletEvidence,type R36ObservedHistory} from './r36-live-evidence-producer'
import {reviewR36TerminalSnapshot} from './r36-evidence-snapshot'
import {verifyR36IndependentHorizonRecord,type R36HorizonProofInput} from './r36-independent-horizon-proof'
import {numberToExactPositiveStroops} from './financial-amount-stroops'
import type {R36LiveSnapshot,R36SourceRow as Row} from './r36-live-source'
const object=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v)
const must=(v:unknown,s:string)=>{if(!v)throw Error(s)}
const flags={authorizesFinancialRelease:false,authorizesSubmission:false,independentCertification:false} as const
const units=(v:unknown)=>{if(typeof v==='number'){const x=numberToExactPositiveStroops(v);if(x!==null)return String(x)}if(typeof v==='string'&&/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(v)){const[a,b='']=v.split('.');if(!/^0*$/.test(b.slice(7)))throw Error('TERMINAL_AMOUNT_PRECISION');return String(BigInt(a)*BigInt(10000000)+BigInt(b.slice(0,7).padEnd(7,'0')))}throw Error('TERMINAL_AMOUNT')}
export function produceR36TerminalEvidence(input:{context:Row;snapshot:R36LiveSnapshot;histories:R36ObservedHistory[];outboundPi:Row;exceptions:{records:Row[];isolation:Row[]};executionScopeDigest?:string}){
 try{
  if(Buffer.byteLength(JSON.stringify(input))>128_000_000)throw Error('TERMINAL_SOURCE_SIZE')
  const q=JSON.parse(JSON.stringify(input)) as typeof input,c=q.context,prior=c.prior as Row,seal=c.seal as Row,t=c.terminal as Row,p=c.policy as Row;
  must(object(prior)&&object(seal)&&object(t)&&object(p)&&object(p.worker_profile)&&typeof c.contextDigest==='string'&&/^[0-9a-f]{64}$/.test(c.contextDigest),'TERMINAL_PROTECTED_CONTEXT')
  const wallet=String(prior.source_wallet),paymentId=String(prior.owner_payment_id),kind=String(prior.operation_kind),profile=p.worker_profile as Row
  must(prior.network===financialNetwork()&&/^G[A-Z2-7]{55}$/.test(wallet)&&['settlement','refund'].includes(kind)&&
   prior.source_wallet===seal.source_wallet&&prior.prepared_tx_hash===seal.prepared_tx_hash&&
   prior.owner_payment_id===seal.owner_payment_id&&prior.owner_operation_id===seal.owner_operation_id&&
   prior.prepared_sequence===seal.prepared_sequence&&prior.operation_kind===seal.operation_kind,'TERMINAL_SEAL_BINDING')
  let subjectPayment=paymentId
  if(c.successorBinding!==undefined){
   const b=c.successorBinding;must(object(b)&&b.network===financialNetwork()&&b.sourceWallet===wallet&&typeof b.paymentId==='string'&&b.paymentId!==paymentId&&/^[0-9a-f]{64}$/.test(String(b.nonce))&&/^[1-9][0-9]*$/.test(String(b.preparedSequence))&&BigInt(String(b.preparedSequence))===BigInt(String(prior.prepared_sequence))+BigInt(1),'TERMINAL_SUCCESSOR_CONTEXT')
   const s=q.snapshot.rows.settlements.filter(x=>x.payment_id===(b as Row).paymentId)
   must(s.length===1&&s[0].u2a_identifier===(b as Row).piPaymentId&&s[0].u2a_txid===(b as Row).u2aTxid&&units((b as Row).operationKind==='settlement'?s[0].merchant_amount:s[0].customer_amount)===(b as Row).amountStroops,'TERMINAL_SUCCESSOR_DURABLE_BINDING')
   subjectPayment=String((b as Row).paymentId)
  }
  const artifacts=composeR36OriginalWalletEvidence({snapshot:q.snapshot,histories:q.histories,sourceWallet:wallet,paymentId:subjectPayment,exceptions:q.exceptions,executionScopeDigest:q.executionScopeDigest});
  const history=artifacts.wallet_history.snapshot as Row,rows=history.transactions as Row[];
  const matches=rows.filter(x=>object(x.input)&&x.input.preparedHash===prior.prepared_tx_hash);must(matches.length===1,'TERMINAL_HISTORY_CARDINALITY')
  const h=matches[0].input as Row,r=matches[0].record as Row,pi=q.outboundPi
  must(pi.network===financialNetwork()&&pi.identifier===t.piPaymentId&&pi.direction==='app_to_user'&&pi.user_uid===t.recipientUid&&pi.from_address===wallet&&pi.to_address===h.destinationWallet&&units(pi.amount)===t.amountStroops&&
   object(pi.status)&&pi.status.developer_approved===true&&pi.status.developer_completed===true&&pi.status.transaction_verified===true&&pi.status.cancelled===false&&pi.status.user_cancelled===false&&
   object(pi.transaction)&&pi.transaction.txid===prior.prepared_tx_hash&&pi.transaction.verified===true,'TERMINAL_ORIGINAL_PI_MISMATCH')
  const proof=verifyR36IndependentHorizonRecord(h as R36HorizonProofInput,r)
  must(proof.outcome==='PROVEN'&&proof.ledger===seal.horizon_ledger&&h.preparedSequence===prior.prepared_sequence&&h.expectedFeeStroops===seal.horizon_fee_stroops&&units(h.amount)===t.amountStroops,'TERMINAL_ORIGINAL_HORIZON_MISMATCH')
  const binding={network:financialNetwork(),sourceWallet:wallet,paymentId,operationKind:kind,operationId:prior.owner_operation_id,preparedHash:prior.prepared_tx_hash,preparedSequence:prior.prepared_sequence,amountStroops:t.amountStroops,feeStroops:seal.horizon_fee_stroops,receiptId:t.receiptId,entryId:t.entryId,cutoffLedger:artifacts.wallet_history.cutoffLedger};
  const review=reviewR36TerminalSnapshot(binding,artifacts);must(review.outcome==='VERIFIED_SNAPSHOT','TERMINAL_ACCOUNTING_'+review.reason)
  artifacts.clearance={schema:'R36_TERMINAL_FINALITY_V1',contextDigest:c.contextDigest,finalityPolicyDigest:profile.finalityPolicyDigest,piRecord:pi,horizonInput:h,horizonRecord:r}
  return {outcome:'UNSIGNED_TERMINAL_REQUIRES_CUSTODIAN' as const,contextDigest:c.contextDigest,cutoffLedger:artifacts.wallet_history.cutoffLedger,artifacts,review,...flags}
 }catch(e){return{outcome:'BLOCKED' as const,reason:e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'TERMINAL_SOURCE_INVALID',...flags}}
}
