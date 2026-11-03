/** NOT_FOR_DEPLOY. Privileged isolated verifier worker; never a runtime/public route.
 * It has no embedded key, credential, evidence URL, signer, activation or financial POST.
 * Protected policy enrollment and genuinely independent evidence/signing services remain
 * external prerequisites. Synthetic fixtures never establish real independence.
 */
import {createHash,createPublicKey,verify} from 'node:crypto'
import {reviewR36EvidenceSnapshot} from './r36-evidence-snapshot'
import {Transaction,TransactionBuilder} from '@stellar/stellar-sdk'
import {consumeR36AdmissionCertificate,R36_ADMISSION_FIELDS,type R36CertificateDatabase,type R36CertificateResult} from './r36-certificate-consumer'
import {verifyR36IndependentHorizonRecord,type R36HorizonProofInput,type R36HorizonRecord} from './r36-independent-horizon-proof'

export const R36_WORKER_KINDS=['intent','inbound_finality','wallet_history','accounting','exceptions','exception_isolation','clearance'] as const
type Kind=typeof R36_WORKER_KINDS[number]
type ObjectValue=Record<string,unknown>
export type R36WorkerPorts={
 /** Must read the approved immutable artifact by digest, never caller-selected URLs. */
 readEvidence(kind:Kind,digest:string,signal:AbortSignal,subjectDigest:string):Promise<unknown>;
 /** Independently controlled signer MUST persist idempotencyKey before acknowledging.
  * The same key/bytes must return the same signed result after crashes, never reissue. */
 signOnce(request:{issuerId:string;keyId:string;policyDigest:string;idempotencyKey:string;bytesBase64:string},signal:AbortSignal):Promise<{signature:string;payloadDigest:string;keyId:string;idempotencyKey:string}>;
}
const hex=/^[0-9a-f]{64}$/
const obj=(v:unknown):v is ObjectValue=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const str=(v:unknown):v is string=>typeof v==='string'&&v.length>0
const fail=(reason:string):R36CertificateResult=>({outcome:'BLOCKED',reason,authorizesFinancialRelease:false,authorizesRotation:false,authorizesWalletActivation:false})
const digestFields:Record<Kind,string>={intent:'immutableIntentDigest',inbound_finality:'inboundFinalityDigest',wallet_history:'walletHistoryDigest',accounting:'accountingDigest',exceptions:'exceptionsDigest',exception_isolation:'exceptionIsolationDigest',clearance:'clearanceDigest'}
const evidenceFields=['schema','kind','policyDigest','subjectDigest','artifactDigest','issuerId','keyId','network','sourceWallet','cutoffLedger','issuedAt','expiresAt']
const certificateFields=['schema','purpose','issuerId','keyId','policyDigest',...R36_ADMISSION_FIELDS,'issuedAt','expiresAt']
const exact=(v:ObjectValue,keys:readonly string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k))
const amount=(v:unknown)=>{if(typeof v!=='string'||!/^(0|[1-9]\d*)(\.\d{1,7})?$/.test(v))throw Error('AMOUNT');const [a,b='']=v.split('.');return (BigInt(a)*BigInt(10000000)+BigInt(b.padEnd(7,'0'))).toString()}
const ids=(v:unknown):v is string[]=>Array.isArray(v)&&v.every(x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x))&&v.join('|')===[...new Set(v)].sort().join('|')

/** Enforce the deadline even if an injected/provider implementation ignores AbortSignal. */
async function bounded<T>(operation:(signal:AbortSignal)=>Promise<T>):Promise<T>{
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined
 try{return await Promise.race([operation(controller.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('PROVIDER_DEADLINE'))},8000)})])}
 finally{if(timer)clearTimeout(timer)}
}

/** A complete trusted artifact chain is required before the first signing request.
 * The transaction serializes workers on the protected nonce. A durable receipt is
 * checked before fetching/signing again; the original consumer rechecks revocation.
 */
export async function runR36CertificateWorker(db:R36CertificateDatabase,nonce:string,ports:R36WorkerPorts):Promise<R36CertificateResult>{
 if(!hex.test(nonce))return fail('INVALID_NONCE')
 try{return await db.begin(async tx=>{
  const rows=await tx.unsafe('SELECT public.r36_certificate_context($1) AS context',[nonce])
  const c=rows.length===1?rows[0].context:null
  if(!obj(c)||!obj(c.binding)||!obj(c.policy)||typeof c.nowSeconds!=='number'||typeof c.requestCreatedAt!=='number')return fail('WORKER_CONTEXT_UNAVAILABLE')
  const b=c.binding,p=c.policy,profile=p.workerProfile,now=c.nowSeconds
  if(!exact(b,R36_ADMISSION_FIELDS)||!R36_ADMISSION_FIELDS.every(k=>str(b[k]))||b.nonce!==nonce||b.network!=='Pi Testnet')return fail('INVALID_PROTECTED_BINDING')
  if(!obj(profile)||profile.schema!=='R36_INDEPENDENT_WORKER_PROFILE_V1'||profile.approvalDigest!==p.approvalRecordDigest||!str(profile.approvalDigest)||!hex.test(profile.approvalDigest)||!str(profile.finalityPolicyDigest)||!hex.test(profile.finalityPolicyDigest)||!Array.isArray(profile.authorities))return fail('INDEPENDENT_WORKER_NOT_ENROLLED')
  const operators=[profile.issuerOperatorId,profile.runtimeOperatorId,profile.migrationOperatorId]
  if(!operators.every(x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x))||new Set(operators).size!==3||profile.issuerId!==p.issuerId||profile.keyId!==p.keyId)return fail('ISSUER_IDENTITY_NOT_SEPARATE')
  // This is a policy-bound identity assertion. The enrollment approver must establish
  // actual organizational independence; distinct strings alone do not establish it.
  if(c.receipt!==null&&c.receipt!==undefined)return consumeR36AdmissionCertificate({begin:fn=>fn(tx)},c.receipt)
  if(typeof p.validUntil!=='number'||typeof p.maxAgeSeconds!=='number'||typeof p.validFrom!=='number')return fail('INVALID_WORKER_VALIDITY')
  const issued=c.requestCreatedAt,expires=Math.min(p.validUntil,issued+p.maxAgeSeconds)
  if(![now,issued,expires].every(Number.isSafeInteger)||issued<p.validFrom||issued>now||expires<=now)return fail('WORKER_REQUEST_EXPIRED')
  const subject=hash(JSON.stringify(R36_ADMISSION_FIELDS.map(k=>b[k])))
  const artifacts={} as Record<Kind,ObjectValue>
  for(const kind of R36_WORKER_KINDS){
   const expected=b[digestFields[kind]];if(typeof expected!=='string'||!hex.test(expected))return fail('MISSING_EVIDENCE_DIGEST')
   const e=await bounded(signal=>ports.readEvidence(kind,expected,signal,subject))
   if(!obj(e)||!exact(e,['text','manifest','signature'])||typeof e.text!=='string'||e.text.length>2_000_000||!obj(e.manifest)||typeof e.signature!=='string'||hash(e.text)!==expected)return fail('EVIDENCE_ARTIFACT_INVALID')
   const m=e.manifest
   if(!exact(m,evidenceFields)||!evidenceFields.every(k=>typeof m[k]==='string'&&/^[\x20-\x7e]{1,256}$/.test(m[k] as string))||m.schema!=='R36_INDEPENDENT_ARTIFACT_V1'||m.kind!==kind||m.policyDigest!==p.policyDigest||m.subjectDigest!==subject||m.artifactDigest!==expected||m.network!==b.network||m.sourceWallet!==b.sourceWallet||m.cutoffLedger!==b.cutoffLedger)return fail('EVIDENCE_SCOPE_MISMATCH')
   const roots=profile.authorities.filter(x=>obj(x)&&x.kind===kind&&x.issuerId===m.issuerId&&x.keyId===m.keyId)
   if(roots.length!==1||!obj(roots[0]))return fail('EVIDENCE_AUTHORITY_NOT_APPROVED')
   const root=roots[0],start=Number(m.issuedAt),end=Number(m.expiresAt)
   if(root.revoked!==false||!str(root.operatorId)||root.operatorId===profile.runtimeOperatorId||root.operatorId===profile.migrationOperatorId||typeof root.validFrom!=='number'||typeof root.validUntil!=='number'||typeof root.revocationCheckedAt!=='number'||typeof root.revocationValidUntil!=='number'||![start,end,root.validFrom,root.validUntil,root.revocationCheckedAt,root.revocationValidUntil].every(Number.isSafeInteger)||start<root.validFrom||start>now||end<expires||end>root.validUntil||root.revocationCheckedAt<start||root.revocationCheckedAt>now||now>=root.revocationValidUntil)return fail('EVIDENCE_AUTHORITY_NOT_CURRENT')
   if(typeof root.publicKeyPem!=='string'||typeof root.publicKeySpkiSha256!=='string')return fail('EVIDENCE_KEY_MISSING')
   const key=createPublicKey(root.publicKeyPem),sig=Buffer.from(e.signature,'base64')
   if(key.asymmetricKeyType!=='ed25519'||hash(key.export({type:'spki',format:'der'}))!==root.publicKeySpkiSha256||sig.length!==64||sig.toString('base64')!==e.signature||!verify(null,Buffer.from('FLASHpay:R36:INDEPENDENT_ARTIFACT:V1\n'+JSON.stringify(evidenceFields.map(k=>m[k]))),key,sig))return fail('EVIDENCE_SIGNATURE_INVALID')
   const body:unknown=JSON.parse(e.text);if(!obj(body))return fail('EVIDENCE_CONTENT_INVALID');artifacts[kind]=body
  }
  const i=artifacts.intent,f=artifacts.inbound_finality,h=artifacts.wallet_history,a=artifacts.accounting,x=artifacts.exceptions,s=artifacts.exception_isolation,g=artifacts.clearance
  const identity=['network','sourceWallet','paymentId','operationKind','operationId','preparedHash','preparedSequence','piPaymentId','u2aTxid','destinationWallet','amountStroops']
  if(typeof i.customerUid!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(i.customerUid)||i.schema!=='R36_ORIGINAL_INTENT_V1'||!identity.every(k=>i[k]===b[k])||typeof i.envelopeXdr!=='string'||hash(i.envelopeXdr)!==b.envelopeXdrTextSha256||typeof i.inboundAmountStroops!=='string'||!/^[1-9]\d*$/.test(i.inboundAmountStroops))return fail('ORIGINAL_INTENT_MISMATCH')
  const prepared=TransactionBuilder.fromXDR(i.envelopeXdr,'Pi Testnet')
  if(!(prepared instanceof Transaction)||prepared.toXDR()!==i.envelopeXdr||Buffer.from(prepared.hash()).toString('hex')!==b.preparedHash||prepared.source!==b.sourceWallet||prepared.sequence!==b.preparedSequence||prepared.operations.length!==1)return fail('PREPARED_XDR_MISMATCH')
  const op=prepared.operations[0]
  if(op.type!=='payment'||op.source!==undefined||!op.asset.isNative()||op.destination!==b.destinationWallet||amount(op.amount)!==b.amountStroops)return fail('PREPARED_OPERATION_MISMATCH')
  if(f.schema!=='R36_INBOUND_FINALITY_V1'||!obj(f.horizonInput)||!obj(f.horizonRecord)||!obj(f.piRecord)||f.finalityPolicyDigest!==profile.finalityPolicyDigest||typeof f.ledgerHash!=='string'||!hex.test(f.ledgerHash))return fail('INBOUND_FINALITY_MISSING')
  const pi=f.piRecord,hi=f.horizonInput
  if(pi.network!==b.network||pi.user_uid!==i.customerUid||pi.identifier!==b.piPaymentId||pi.direction!=='user_to_app'||pi.to_address!==b.sourceWallet||pi.from_address!==hi.sourceWallet||amount(pi.amount)!==i.inboundAmountStroops||!obj(pi.transaction)||pi.transaction.txid!==b.u2aTxid||pi.transaction.verified!==true||!obj(pi.status)||pi.status.developer_approved!==true||pi.status.transaction_verified!==true||pi.status.developer_completed!==true||pi.status.cancelled!==false||pi.status.user_cancelled!==false||hi.network!=='Pi Testnet'||hi.destinationWallet!==b.sourceWallet||hi.preparedHash!==b.u2aTxid||amount(hi.amount)!==i.inboundAmountStroops)return fail('PI_INBOUND_IDENTITY_OR_COMPLETION_MISMATCH')
  const inbound=verifyR36IndependentHorizonRecord(hi as R36HorizonProofInput,f.horizonRecord as R36HorizonRecord)
  if(inbound.outcome!=='PROVEN'||!inbound.ledger||BigInt(inbound.ledger)>BigInt(b.cutoffLedger as string))return fail('INBOUND_HORIZON_NOT_PROVEN')
  for(const body of [h,a,g])if(body.network!==b.network||body.sourceWallet!==b.sourceWallet||body.cutoffLedger!==b.cutoffLedger)return fail('HISTORY_ACCOUNTING_SCOPE_MISMATCH')
  if(h.schema!=='R36_COMPLETE_HISTORY_V1'||typeof h.genesisLedger!=='string'||!/^[1-9]\d*$/.test(h.genesisLedger)||BigInt(h.genesisLedger)>BigInt(b.cutoffLedger as string)||!['cutoffHash','transactionsDigest','operationsDigest','controlledWalletsInventoryDigest','continuityProofDigest'].every(k=>typeof h[k]==='string'&&hex.test(h[k] as string)))return fail('HISTORY_COMPLETENESS_MISSING')
  if(a.schema!=='R36_ACCOUNTING_CLEARANCE_V1'||a.unbalancedStroops!=='0'||!Array.isArray(a.duplicateFinancialKeys)||a.duplicateFinancialKeys.length!==0||!Array.isArray(a.xorViolations)||a.xorViolations.length!==0||!['pgSnapshotDigest','reconciliationDigest','currentRightsDigest'].every(k=>typeof a[k]==='string'&&hex.test(a[k] as string))||a.ledgerInventoryDigest!==h.transactionsDigest)return fail('ACCOUNTING_NOT_CLEARED')
  if(x.schema!=='R36_HISTORICAL_EXCEPTIONS_V1'||!ids(x.ids)||typeof x.recordsDigest!=='string'||!hex.test(x.recordsDigest)||s.schema!=='R36_EXCEPTION_ISOLATION_V1'||!ids(s.exceptionIds)||JSON.stringify(s.exceptionIds)!==JSON.stringify(x.ids)||s.currentRightsDigest!==a.currentRightsDigest||s.disposition!=='ISOLATED_NO_CURRENT_RIGHTS_IMPACT'||typeof s.evidenceDigest!=='string'||!hex.test(s.evidenceDigest))return fail('EXCEPTION_RIGHTS_ISOLATION_MISSING')
  if(g.schema!=='R36_WALLET_CLEARANCE_V1'||g.authorityDisposition!=='CLEARED_FOR_BOUND_INTENT'||g.currentRightsDigest!==a.currentRightsDigest||!['walletHistoryDigest','accountingDigest','exceptionsDigest','exceptionIsolationDigest'].every(k=>g[k]===b[k]))return fail('WALLET_CLEARANCE_MISMATCH')
  const snapshotReview=reviewR36EvidenceSnapshot(b,artifacts)
  if(snapshotReview.outcome!=='VERIFIED_SNAPSHOT')return fail('SNAPSHOT_'+snapshotReview.reason)
  const manifest={schema:'R36_ADMISSION_CERTIFICATE_V1',purpose:'INITIAL_PREPARED_ADMISSION',issuerId:p.issuerId,keyId:p.keyId,policyDigest:p.policyDigest,...b,issuedAt:String(issued),expiresAt:String(expires)} as Record<string,unknown>
  const bytes=Buffer.from('FLASHpay:R36:INITIAL_ADMISSION:V1\n'+JSON.stringify(certificateFields.map(k=>manifest[k]))),digest=hash(bytes)
  if(typeof p.issuerId!=='string'||typeof p.keyId!=='string'||typeof p.policyDigest!=='string')return fail('SIGNER_POLICY_MISSING')
  const signed=await bounded(signal=>ports.signOnce({issuerId:p.issuerId as string,keyId:p.keyId as string,policyDigest:p.policyDigest as string,idempotencyKey:digest,bytesBase64:bytes.toString('base64')},signal))
  if(signed.payloadDigest!==digest||signed.idempotencyKey!==digest||signed.keyId!==p.keyId)return fail('SIGNER_RESPONSE_MISMATCH')
  return consumeR36AdmissionCertificate({begin:fn=>fn(tx)},{manifest,signature:signed.signature})
 })}catch{return fail('WORKER_EVIDENCE_OR_TRANSACTION_FAILED')}
}
