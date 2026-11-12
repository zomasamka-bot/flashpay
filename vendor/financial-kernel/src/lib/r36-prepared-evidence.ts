import {type FinancialNetwork,financialNetwork} from './financial-network'
/** Non-authorizing durable handoff. An evidence candidate is never a prepared
 * checkpoint, wallet claim, certificate, submission attempt or accounting entry. */
import {Transaction,TransactionBuilder} from '@stellar/stellar-sdk'
import {createHash} from 'node:crypto'
import {sealR36Envelope,verifyR36SignedEnvelope,type R36EnvelopeSeal} from './r36-prepared-evidence-seal'
export type R36PreparedIdentity={network:FinancialNetwork;sourceWallet:string;destinationWallet:string;paymentId:string;
 operationKind:'settlement'|'refund';operationId:string;piPaymentId:string;amountStroops:string}
export type R36Candidate={identity:R36PreparedIdentity;envelopeXdr:string;preparedHash:string;preparedSequence:string;candidateDigest:string;signedEnvelopeSha256:string;encryptedEnvelope:R36EnvelopeSeal}
export type R36CandidateStore={read(i:R36PreparedIdentity):Promise<{state:'absent'}|{state:'present';candidate:R36Candidate}>;
 stage(c:Omit<R36Candidate,'candidateDigest'>):Promise<R36Candidate>}
const hash=(x:string)=>createHash('sha256').update(x).digest('hex')
const fields=['network','sourceWallet','destinationWallet','paymentId','operationKind','operationId','piPaymentId','amountStroops'] as const
export function verifyR36EvidenceCandidate(identity:R36PreparedIdentity,c:Omit<R36Candidate,'candidateDigest'>):Transaction{
 if(!c||!c.identity||!fields.every(k=>c.identity[k]===identity[k])||Object.keys(c.identity).length!==fields.length||identity.network!==financialNetwork()||
  !['settlement','refund'].includes(identity.operationKind)||!['sourceWallet','destinationWallet'].every(k=>/^G[A-Z2-7]{55}$/.test(identity[k as 'sourceWallet']))||
  !['paymentId','operationId','piPaymentId'].every(k=>/^[A-Za-z0-9_.:-]{1,128}$/.test(identity[k as 'paymentId']))||
  !/^[1-9][0-9]{0,13}$/.test(identity.amountStroops)||BigInt(identity.amountStroops)>BigInt('10000000000000')||typeof c.envelopeXdr!=='string'||c.envelopeXdr.length>32768)
  throw Error('EVIDENCE_CANDIDATE_IDENTITY')
 const t=TransactionBuilder.fromXDR(c.envelopeXdr,financialNetwork())
 if(!(t instanceof Transaction)||t.toXDR()!==c.envelopeXdr||Buffer.from(t.hash()).toString('hex')!==c.preparedHash||t.sequence!==c.preparedSequence||
  t.source!==identity.sourceWallet||t.operations.length!==1||t.operations[0].type!=='payment'||t.operations[0].source!==undefined||!t.operations[0].asset.isNative()||
  t.operations[0].destination!==identity.destinationWallet||t.timeBounds?.minTime!=='0'||t.timeBounds?.maxTime!=='0'||t.memo.type!=='text')throw Error('EVIDENCE_CANDIDATE_XDR')
 const [whole,fraction='']=t.operations[0].amount.split('.')
 if(!/^[0-9]+$/.test(whole)||!/^[0-9]{0,7}$/.test(fraction)||String(BigInt(whole)*BigInt(10000000)+BigInt(fraction.padEnd(7,'0')))!==identity.amountStroops)
  throw Error('EVIDENCE_CANDIDATE_AMOUNT')
 const memo=typeof t.memo.value==='string'?t.memo.value:Buffer.from(t.memo.value as Uint8Array).toString('utf8')
 if(memo!==(identity.operationKind==='settlement'?identity.piPaymentId.substring(0,28):identity.piPaymentId)||t.signatures.length!==0)throw Error('EVIDENCE_CANDIDATE_UNSIGNED_BODY')
 return t
}
export async function prepareR36EvidenceCandidate(identity:R36PreparedIdentity,currentSequence:string,minimumFee:string,
 build:()=>Promise<Transaction>,store:R36CandidateStore,security:{recipientPublicKeyPem:string;sign:(t:Transaction)=>void}):Promise<{outcome:'READY_FOR_ORIGINAL_GUARDS';transaction:Transaction;candidate:R36Candidate}|{outcome:'BLOCKED'}>{
 try{
  const i={...identity};if(!/^(0|[1-9][0-9]*)$/.test(currentSequence)||!/^[1-9][0-9]*$/.test(minimumFee))return{outcome:'BLOCKED'}
  const found=await store.read(i);let candidate:R36Candidate
  if(found.state==='present')candidate=found.candidate
  else if(found.state==='absent'){
   const t=await build(),c={identity:i,...sealR36Envelope(t,security.recipientPublicKeyPem),preparedHash:Buffer.from(t.hash()).toString('hex'),preparedSequence:t.sequence}
   verifyR36EvidenceCandidate(i,c);candidate=await store.stage(c)
   if(candidate.envelopeXdr!==c.envelopeXdr||candidate.preparedHash!==c.preparedHash||candidate.preparedSequence!==c.preparedSequence||candidate.signedEnvelopeSha256!==c.signedEnvelopeSha256)return{outcome:'BLOCKED'}
  }else return{outcome:'BLOCKED'}
  const transaction=verifyR36EvidenceCandidate(i,candidate)
  if(!/^[0-9a-f]{64}$/.test(candidate.candidateDigest)||BigInt(candidate.preparedSequence)!==BigInt(currentSequence)+BigInt(1)||
   !/^[0-9]+$/.test(transaction.fee)||BigInt(transaction.fee)<BigInt(minimumFee))return{outcome:'BLOCKED'}
  security.sign(transaction)
  verifyR36SignedEnvelope(transaction,candidate.envelopeXdr,candidate.signedEnvelopeSha256)
  return{outcome:'READY_FOR_ORIGINAL_GUARDS',transaction,candidate}
 }catch{return{outcome:'BLOCKED'}}
}
export const r36CandidateEnvelopeDigest=(c:R36Candidate)=>hash(c.envelopeXdr)
