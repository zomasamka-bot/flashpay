import "server-only"

import { query } from "@/lib/db"
import { redis, isRedisConfigured } from "@/lib/redis"
import { reconcileIncompleteA2UPayment, isPiA2UPayment, isRecord } from "@/lib/pi-reconciliation"

type Row = Record<string, unknown>
const s=(v:unknown)=>typeof v==="string"&&v.trim()!==""&&v===v.trim()?v:null
const n=(v:unknown)=>typeof v==="number"&&Number.isFinite(v)?v:typeof v==="string"&&v.trim()!==""&&Number.isFinite(Number(v))?Number(v):null
function safePi(v:unknown){if(!isPiA2UPayment(v))return null;const st=isRecord(v.status)?v.status:null;const tx=isRecord(v.transaction)?v.transaction:null;const md=isRecord(v.metadata)?v.metadata:null;return {identifier:s(v.identifier),network:s(v.network),direction:s(v.direction),amount:n(v.amount),user_uid:s(v.user_uid),from_address:s(v.from_address),to_address:s(v.to_address),metadataPaymentId:s(md?.paymentId),metadataType:s(md?.type),cancelled:v.cancelled===true,rejected:v.rejected===true,completed:v.completed===true,statusCancelled:st?.cancelled===true,statusUserCancelled:st?.user_cancelled===true,statusTransactionVerified:st?.transaction_verified===true,statusDeveloperCompleted:st?.developer_completed===true,transactionPresent:v.transaction!=null,transactionTxid:s(tx?.txid),txid:s(v.txid),transactionId:s(v.transaction_id)}}
export async function readFin4R4QStage1FailureEvidence(paymentA:string,paymentB:string){
 const rows=await query(`SELECT payment_id,stage,merchant_id,merchant_uid,customer_amount,u2a_identifier,u2a_txid,a2u_payment_id,a2u_from_address,a2u_to_address,prepared_tx_hash,prepared_sequence,a2u_txid AS movement_txid,horizon_confirmed_at,pi_completed_at,db_finalized_at,u2a_start_lease_token,u2a_start_lease_expires_at,certification_hold,certification_hold_at,certification_hold_expires_at,updated_at FROM settlement_checkpoints WHERE payment_id IN ($1,$2) ORDER BY payment_id`,[paymentA,paymentB])
 const a=(rows as Row[]).find(r=>r.payment_id===paymentA)??null,b=(rows as Row[]).find(r=>r.payment_id===paymentB)??null
 const observations=await query(`SELECT payment_id,a2u_payment_id,observed_at FROM settlement_a2u_ongoing_observations WHERE payment_id=$1 ORDER BY observed_at DESC`,[paymentA])
 let projection:unknown=null,redisRead="UNAVAILABLE";if(isRedisConfigured){try{projection=await redis.get(`payment:${paymentA}`);redisRead="READ"}catch{redisRead="INDETERMINATE"}}
 const p=isRecord(projection)?projection:null
 const amount=a?n(a.customer_amount):null,merchantUid=a?s(a.merchant_uid):null
 const rec=amount!==null&&amount>0&&merchantUid!==null?await reconcileIncompleteA2UPayment(paymentA,amount,merchantUid):null
 return {ok:true as const,outcome:"READ_ONLY_EVIDENCE" as const,paymentA,paymentB,durableA:a,durableB:b,ongoingObservations:observations,redisRead,redisProjection:p?{id:s(p.id),status:s(p.status),amount:n(p.amount),customerAmount:n(p.customerAmount),piPaymentId:s(p.piPaymentId),u2aTxid:s(p.u2aTxid),a2uPaymentId:s(p.a2uPaymentId),a2uTxid:s(p.a2uTxid),settlementFailureState:s(p.settlementFailureState),refundStatus:s(p.refundStatus),a2uErrorCode:s(p.a2uErrorCode),a2uErrorMessage:s(p.a2uErrorMessage),a2uErrorBody:s(p.a2uErrorBody),lastAttemptAt:s(p.lastAttemptAt),nextRetryAt:s(p.nextRetryAt),retryCount:n(p.retryCount),redisProjectionVersion:n(p.redisProjectionVersion),requiresDbReconciliation:p.requiresDbReconciliation===true,piCompletionPending:p.piCompletionPending===true,piCompleted:p.piCompleted===true,dbRecorded:p.dbRecorded===true}:null,piReconciliation:rec?{outcome:rec.outcome,reason:rec.reason,candidate:safePi(rec.dto)}:null,financialAuthorityMutated:false,piMutationExecuted:false,horizonSubmitExecuted:false,redisMutated:false}
}
