import {withR36RestrictedPaymentTransaction} from './db'
import type {R36Candidate,R36CandidateStore,R36PreparedIdentity} from './r36-prepared-evidence'
const call=async(action:'read'|'stage',identity:R36PreparedIdentity,payload:unknown)=>{
 const result=await withR36RestrictedPaymentTransaction(identity.paymentId,async tx=>{
  const rows=await tx.unsafe('SELECT public.r36_prepared_evidence_candidate($1,$2::text::jsonb) AS result',[action,JSON.stringify(payload)])
  if(rows.length!==1||!rows[0].result)throw Error('EVIDENCE_CANDIDATE_NOT_DURABLE');return rows[0].result
 })
 if(!result)throw Error('EVIDENCE_CANDIDATE_UNAVAILABLE');return result
}
export const r36PreparedEvidenceStore:R36CandidateStore={
 read:async identity=>call('read',identity,identity),
 stage:async candidate=>{
  const result=await call('stage',candidate.identity,candidate)
  if(result.state!=='present'||!result.candidate)throw Error('EVIDENCE_CANDIDATE_NOT_COMMITTED')
  return result.candidate as R36Candidate
 },
}
