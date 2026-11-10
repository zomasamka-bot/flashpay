/** One consistent read-only source snapshot, including the durable handoff.
 * The caller cannot substitute a newly constructed envelope for the stored one. */
import {readR36LiveSource,type R36ReadOnlySource} from './r36-live-source'
import {verifyR36EvidenceCandidate,type R36Candidate} from './r36-prepared-evidence'
export async function readR36PreparedSource(db:R36ReadOnlySource,paymentId:string){
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(paymentId))throw Error('PREPARED_SOURCE_IDENTITY')
 return db.beginReadOnly(async tx=>{
  const snapshot=await readR36LiveSource({beginReadOnly:fn=>fn(tx)},'service')
  // UUID grammar above excludes all SQL syntax. The source port accepts fixed SQL only.
  const rows=await tx.unsafe(`SELECT candidate FROM public.r36_prepared_evidence_candidates WHERE payment_id='${paymentId}' LIMIT 2`)
  if(rows.length!==1)throw Error('PREPARED_SOURCE_CARDINALITY')
  const c=rows[0].candidate as R36Candidate
  if(!c||c.identity?.paymentId!==paymentId||!/^[0-9a-f]{64}$/.test(c.candidateDigest))throw Error('PREPARED_SOURCE_BINDING')
  verifyR36EvidenceCandidate(c.identity,c)
  return {snapshot,candidate:c}
 })
}
