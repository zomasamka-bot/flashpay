/** Private automatic queue consumer. No DDL, DML, authority mutation, Redis or
 * financial POST. Missing approved source bundles and historical clearance hold
 * the job; they are never manufactured from a policy flag or a cancelled payment.
 */
import {readFile,lstat,realpath} from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {readR36PreparedSource} from './r36-prepared-evidence-reader'
import type {R36ReadOnlySource} from './r36-live-source'
import {openR36Envelope} from './r36-prepared-evidence-seal'
import {collectR36LiveCandidate,type R36LiveCollectionRequest} from './r36-live-evidence-cli'
import {r36SnapshotDigest} from './r36-evidence-snapshot'
import {appendR36LiveHistories} from './r36-live-history-delta'
import {publishR36LiveEvidenceJob,type R36PublicationPolicy} from './r36-evidence-publication'
import type {R36CertificateResult} from './r36-certificate-consumer'
export const R36_QUEUE_SQL=`SELECT c.payment_id,r.policy_digest,r.payer_wallet,p.enabled,p.revoked,p.valid_from::text,p.valid_until::text,p.max_age_seconds::text,p.revocation_checked_at::text,p.revocation_valid_until::text,p.approval_record_digest,p.worker_profile,
 floor(extract(epoch FROM clock_timestamp()))::bigint::text AS observed_now,
 q.nonce AS original_nonce,cert.expires_at::text AS original_expiry,
 renew.generation AS renewal_generation,renew.issued_at::text AS renewal_issued,renew.expires_at::text AS renewal_expiry,
 renew.evidence_not_before::text AS renewal_evidence_floor,
 fresh.expires_at::text AS renewed_expiry,
 EXISTS(SELECT 1 FROM public.r36_certificate_revocations v WHERE v.payload_digest=cert.payload_digest)
 OR EXISTS(SELECT 1 FROM public.r36_admission_renewal_revocations v JOIN public.r36_admission_renewal_receipts t USING(payload_digest) WHERE t.nonce=q.nonce) AS admission_revoked,
 EXISTS(SELECT 1 FROM public.financial_wallet_authorities a WHERE a.network=c.network AND a.source_wallet=c.source_wallet
 AND a.owner_payment_id=c.payment_id AND a.prepared_tx_hash=c.candidate->>'preparedHash' AND a.prepared_sequence=c.prepared_sequence AND a.state='prepared') AS owns_prepared,
 EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts a WHERE a.network=c.network AND
 (a.owner_payment_id=c.payment_id OR a.source_wallet=c.source_wallet AND (a.prepared_tx_hash=c.candidate->>'preparedHash' OR a.prepared_sequence=c.prepared_sequence))) AS submission_attempted
 FROM public.r36_prepared_evidence_candidates c JOIN public.r36_testnet_ingress_reservations r ON r.payment_id=c.payment_id
 JOIN public.r36_certificate_policies p ON p.policy_digest=r.policy_digest
 LEFT JOIN public.r36_certificate_requests q ON q.policy_digest=r.policy_digest AND q.binding->>'paymentId'=c.payment_id
 AND q.binding->>'network'=c.network AND q.binding->>'sourceWallet'=c.source_wallet AND q.binding->>'preparedSequence'=c.prepared_sequence
 AND q.binding->>'preparedHash'=c.candidate->>'preparedHash' AND q.binding->>'operationKind'=c.candidate->'identity'->>'operationKind'
 AND q.binding->>'operationId'=c.candidate->'identity'->>'operationId'
 LEFT JOIN public.r36_certificate_receipts cert ON cert.nonce=q.nonce
 LEFT JOIN LATERAL (SELECT x.* FROM public.r36_admission_renewal_requests x WHERE x.nonce=q.nonce ORDER BY x.generation DESC LIMIT 1) renew ON true
 LEFT JOIN public.r36_admission_renewal_receipts fresh ON fresh.nonce=renew.nonce AND fresh.generation=renew.generation
 WHERE r.retired_by_payment_id IS NULL
 AND p.enabled AND NOT p.revoked
 -- A completed original operation needs no new admission certificate. Preserve
 -- ambiguous, partial and conflicting rows for the existing guarded review.
 AND NOT EXISTS(SELECT 1 FROM public.settlement_checkpoints s
  WHERE s.payment_id=c.payment_id AND s.stage='db_finalized'
  AND c.candidate->'identity'->>'operationKind'='settlement'
  AND s.a2u_payment_id=c.candidate->'identity'->>'operationId'
  AND s.a2u_from_address=c.source_wallet AND s.a2u_txid=c.candidate->>'preparedHash'
  AND s.prepared_tx_hash=c.candidate->>'preparedHash' AND s.prepared_sequence::text=c.prepared_sequence
  AND NOT EXISTS(SELECT 1 FROM public.refund_checkpoints r2 WHERE r2.payment_id=c.payment_id))
 AND NOT EXISTS(SELECT 1 FROM public.refund_checkpoints r2
  WHERE r2.payment_id=c.payment_id AND r2.status='completed' AND r2.stage='audit_recorded'
  AND c.candidate->'identity'->>'operationKind'='refund'
  AND r2.refund_id=c.candidate->'identity'->>'operationId'
  AND r2.refund_payment_id=c.candidate->'identity'->>'piPaymentId'
  AND r2.refund_txid=c.candidate->>'preparedHash'
  AND NOT EXISTS(SELECT 1 FROM public.settlement_checkpoints s WHERE s.payment_id=c.payment_id AND s.stage<>'payment_identity'))
 ORDER BY c.created_at,c.payment_id LIMIT 101`
const hex=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x)
export type R36DispatchConfig={factsDirectory:string;jobDirectory:string;artifactDirectory:string;custodianPrivateKeyPem:string;custodyDecryptionKey:string;registrarPolicyDigest:string}
export async function dispatchR36EvidenceCycle(db:R36ReadOnlySource,c:R36DispatchConfig,ports:{fetcher:typeof fetch;register(binding:Record<string,unknown>):Promise<R36CertificateResult>;observeOwnerRegistry?(signal:AbortSignal):Promise<void>}):Promise<{status:string;policies:number;jobs:number;published:number;held:number;reasons:string[]}>{
 const result={status:'READONLY_DISPATCH_IDLE',policies:0,jobs:0,published:0,held:0,reasons:[] as string[]}
 try{
  const active=await db.beginReadOnly(tx=>tx.unsafe("SELECT count(*)::int active FROM public.r36_certificate_policies WHERE enabled AND NOT revoked"));result.policies=Number(active[0]?.active)
  if(!Number.isSafeInteger(result.policies)||result.policies<0)throw Error('DISPATCH_POLICY_COUNT')
  if(result.policies&&ports.observeOwnerRegistry)await ports.observeOwnerRegistry(AbortSignal.timeout(8000))
  const queue=result.policies?await db.beginReadOnly(tx=>tx.unsafe(R36_QUEUE_SQL)):[]
  if(queue.length>100)throw Error('DISPATCH_QUEUE_BOUND')
  if(!result.policies){result.status='STANDBY_NO_APPROVED_POLICY';return result}
  result.jobs=queue.length
  for(const row of queue){try{
   if(!hex(row.policy_digest)||row.policy_digest!==c.registrarPolicyDigest)throw Error('DISPATCH_REGISTRAR_POLICY_BINDING')
   // These read-only fields are scheduling hints, never a submission right.
   // The protected registrar and Runtime repeat all financial checks under locks.
   const now=Number(row.observed_now),expiry=Number(row.renewed_expiry??row.original_expiry)
   if(row.admission_revoked===true)throw Error('DISPATCH_ADMISSION_REVOKED')
   if(row.owns_prepared===true&&row.original_nonce){
    if(row.submission_attempted===true){result.published++;continue} // existing reconciliation only, no new certificate
    if(Number.isSafeInteger(expiry)&&expiry>now){result.published++;continue} // do not republish a frozen pre-preparation snapshot
   }
   let renewal:{generation:number;evidenceNotBefore:number}|undefined
   // A committed request is not an issued certificate. SQL NULL must never
   // become epoch zero and route interrupted initial issuance into renewal.
   if(row.original_nonce&&row.original_expiry!==null&&row.original_expiry!==undefined&&Number.isSafeInteger(Number(row.original_expiry))&&Number(row.original_expiry)>0&&Number(row.original_expiry)<=now){
    if(row.submission_attempted!==false)throw Error('DISPATCH_RENEWAL_UNSPENT_REQUIRED')
    // Scheduling only: protected registrar/issuer SQL proves either the exact
    // prepared owner or its already approved, unconsumed successor. No new right.
    const pending=row.renewal_generation!==null&&Number(row.renewal_expiry)>now
    renewal={generation:pending?Number(row.renewal_generation):Number(row.renewal_generation??0)+1,
      evidenceNotBefore:pending?Number(row.renewal_evidence_floor):Math.max(Number(row.original_expiry),Number(row.renewal_expiry??row.original_expiry))}
    if(!Number.isSafeInteger(now)||!Number.isSafeInteger(renewal.generation)||!Number.isSafeInteger(renewal.evidenceNotBefore))throw Error('DISPATCH_RENEWAL_CONTEXT')
   }
   const p=row.worker_profile as Record<string,unknown>;if(!p||!hex(p.liveEvidenceInputsSha256)||!hex(p.finalityPolicyDigest))throw Error('DISPATCH_APPROVED_FACTS_NOT_BOUND')
   const dir=await realpath(c.factsDirectory),file=path.join(dir,row.policy_digest+'.json'),s=await lstat(file)
   if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o077)!==0||s.size>48_000_000)throw Error('DISPATCH_FACTS_STORAGE')
   const raw=await readFile(file);if(createHash('sha256').update(raw).digest('hex')!==p.liveEvidenceInputsSha256)throw Error('DISPATCH_FACTS_DIGEST')
   const facts=JSON.parse(raw.toString('utf8'));if(!facts||Object.keys(facts).sort().join(',')!=='exceptions,histories')throw Error('DISPATCH_FACTS_FIELDS')
   const {snapshot,candidate}=await readR36PreparedSource(db,String(row.payment_id))
   if(candidate.encryptedEnvelope.recipientSpkiSha256!==(p.preparedEvidenceEncryption as {recipientSpkiSha256?:string})?.recipientSpkiSha256)throw Error('DISPATCH_RECIPIENT_PIN')
   const toPolicy=(r:Record<string,unknown>):R36PublicationPolicy=>({policyDigest:String(r.policy_digest),approvalRecordDigest:String(r.approval_record_digest),enabled:r.enabled===true,revoked:r.revoked===true,validFrom:Number(r.valid_from),validUntil:Number(r.valid_until),maxAgeSeconds:Number(r.max_age_seconds),revocationCheckedAt:Number(r.revocation_checked_at),revocationValidUntil:Number(r.revocation_valid_until),workerProfile:r.worker_profile as R36PublicationPolicy['workerProfile']})
   const policy=toPolicy(row)
   if(p.executionScopeDigest!==undefined){
    const scope=(snapshot.rows.executionScopes??[]).filter(s=>s.scope_digest===p.executionScopeDigest&&s.policy_digest===row.policy_digest&&s.source_wallet===candidate.identity.sourceWallet)
    if(scope.length!==1)throw Error('DISPATCH_EXECUTION_SCOPE_NOT_ENROLLED')
   }
   const r=await publishR36LiveEvidenceJob({candidateDigest:candidate.candidateDigest,sourceRowsDigest:r36SnapshotDigest(snapshot.rows),policy,custodianPrivateKeyPem:c.custodianPrivateKeyPem,jobDirectory:c.jobDirectory,artifactDirectory:c.artifactDirectory,renewal},{
    collect:async nonce=>collectR36LiveCandidate(snapshot,{paymentId:candidate.identity.paymentId,kind:candidate.identity.operationKind,sourceWallet:candidate.identity.sourceWallet,payerWallet:String(row.payer_wallet),finalityPolicyDigest:String(p.finalityPolicyDigest),histories:p.liveHistoryPolicy===undefined?facts.histories:await appendR36LiveHistories(facts.histories,p.liveHistoryPolicy,ports.fetcher),exceptions:facts.exceptions,nonce,executionScopeDigest:p.executionScopeDigest,preparedEnvelopeXdr:openR36Envelope(candidate,c.custodyDecryptionKey)} as R36LiveCollectionRequest,'PROXY_OWNS_PROVIDER_KEY',ports.fetcher),register:ports.register,
    refreshPolicy:async signal=>{
     // Read only, fixed query, same protected reservation. This cannot invent a
     // heartbeat or refresh the policy itself; stale source data still blocks.
     if(signal.aborted)throw Error('DISPATCH_POLICY_REFRESH_ABORTED')
     if(ports.observeOwnerRegistry)await ports.observeOwnerRegistry(signal)
     const latest=await db.beginReadOnly(tx=>tx.unsafe(R36_QUEUE_SQL))
     if(signal.aborted||latest.length>100)throw Error('DISPATCH_POLICY_REFRESH_UNAVAILABLE')
     const matches=latest.filter(r=>r.payment_id===row.payment_id&&r.policy_digest===row.policy_digest&&r.payer_wallet===row.payer_wallet)
     if(matches.length!==1)throw Error('DISPATCH_POLICY_REFRESH_BINDING')
     return toPolicy(matches[0])
    }})
   if(r.outcome==='BLOCKED')throw Error(r.reason);result.published++
  }catch(e){result.held++;const why=e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'DISPATCH_SOURCE_OR_PROVIDER_UNAVAILABLE';if(!result.reasons.includes(why))result.reasons.push(why)}}
  result.status=result.held?'HELD_NO_FINANCIAL_RELEASE':result.published?'PUBLISHED_REQUIRES_ORIGINAL_R36_GUARDS':'IDLE_NO_CANDIDATE';return result
 }catch(e){return {...result,status:'DISPATCH_FAIL_CLOSED',reasons:[e instanceof Error&&/^[A-Z0-9_]+$/.test(e.message)?e.message:'DISPATCH_DATABASE_UNAVAILABLE']}}
}
