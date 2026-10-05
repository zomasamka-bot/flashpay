import "server-only"
import { query, retireCancelledSettlementA2UStage1 } from "@/lib/db"
import { serverConfig } from "@/lib/server-config"
import { proveA2UStage1HorizonAbsence } from "@/lib/a2u-stage1-retirement"
import { redis, isRedisConfigured } from "@/lib/redis"
import { compareAndSwapPaymentProjection } from "@/lib/payment-projection-cas"
import type { Payment } from "@/lib/types"

const TARGET_PAYMENT_ID = "7e95c0ef-bd41-4db7-9100-ece47ad703d7"
const TARGET_A2U_PAYMENT_ID = "pCkAqNfNr1GVd5OJktiKdTmHkrjl"

type Row = Record<string, unknown>
const exact=(v:unknown):string|null=>typeof v==="string"&&v.trim()!==""&&v===v.trim()?v:null
const isRecord=(v:unknown):v is Row=>typeof v==="object"&&v!==null&&!Array.isArray(v)
const num=(v:unknown):number|null=>{const n=typeof v==="number"?v:typeof v==="string"?Number(v):NaN;return Number.isFinite(n)?n:null}
function parseProjection(v:unknown):Payment|null{try{const p=typeof v==="string"?JSON.parse(v):v;return isRecord(p)?p as Payment:null}catch{return null}}

export async function executeFin4R4P1GuardedRetirement(requestedPaymentId:string){
  if(requestedPaymentId!==TARGET_PAYMENT_ID)return{ok:false as const,outcome:"TARGET_NOT_ALLOWED" as const,financialAuthorityMutated:false,piMutationExecuted:false,horizonSubmitExecuted:false,redisMutated:false}
  const rows=await query(`SELECT payment_id,stage,merchant_uid,customer_amount,a2u_payment_id,a2u_from_address,a2u_to_address,prepared_envelope_xdr,prepared_tx_hash,prepared_sequence,a2u_txid,horizon_fee_stroops,horizon_confirmed_at,pi_completed_at,db_finalized_at FROM settlement_checkpoints WHERE payment_id=$1`,[TARGET_PAYMENT_ID])
  if(!Array.isArray(rows)||rows.length!==1)return{ok:false as const,outcome:"DURABLE_PRECONDITION_INDETERMINATE" as const,financialAuthorityMutated:false,piMutationExecuted:false,horizonSubmitExecuted:false,redisMutated:false}
  const r=rows[0] as Row, amount=num(r.customer_amount), merchantUid=exact(r.merchant_uid)
  const pristineStage1=r.stage==="a2u_created"&&r.a2u_payment_id===TARGET_A2U_PAYMENT_ID&&exact(r.a2u_from_address)!==null&&exact(r.a2u_to_address)!==null&&r.prepared_envelope_xdr==null&&r.prepared_tx_hash==null&&r.prepared_sequence==null&&r.a2u_txid==null&&r.horizon_fee_stroops==null&&r.horizon_confirmed_at==null&&r.pi_completed_at==null&&r.db_finalized_at==null
  if(!pristineStage1||amount===null||amount<=0||merchantUid===null)return{ok:false as const,outcome:"DURABLE_PRECONDITION_NOT_PROVEN" as const,financialAuthorityMutated:false,piMutationExecuted:false,horizonSubmitExecuted:false,redisMutated:false}
  if(!serverConfig.isPiApiKeyConfigured)return{ok:false as const,outcome:"PI_READ_UNAVAILABLE" as const,financialAuthorityMutated:false,piMutationExecuted:false,horizonSubmitExecuted:false,redisMutated:false}
  let response:Response;try{response=await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(TARGET_A2U_PAYMENT_ID)}`,{headers:{Authorization:`Key ${serverConfig.piApiKey}`},cache:"no-store"})}catch{return{ok:false as const,outcome:"PI_READ_INDETERMINATE" as const,financialAuthorityMutated:false,piMutationExecuted:false,horizonSubmitExecuted:false,redisMutated:false}}
  if(!response.ok)return{ok:false as const,outcome:"PI_READ_INDETERMINATE" as const,piHttpStatus:response.status,financialAuthorityMutated:false,piMutationExecuted:false,horizonSubmitExecuted:false,redisMutated:false}
  const pi:unknown=await response.json().catch(()=>null);if(!isRecord(pi)||!isRecord(pi.status)||!isRecord(pi.metadata))return{ok:false as const,outcome:"PI_SHAPE_INDETERMINATE" as const,financialAuthorityMutated:false,piMutationExecuted:false,horizonSubmitExecuted:false,redisMutated:false}
  const tx=isRecord(pi.transaction)?pi.transaction:null
  const exactCancelled=pi.identifier===TARGET_A2U_PAYMENT_ID&&pi.network==="Pi Testnet"&&pi.direction==="app_to_user"&&pi.amount===amount&&pi.user_uid===merchantUid&&pi.from_address===r.a2u_from_address&&pi.to_address===r.a2u_to_address&&pi.metadata.type==="a2u_settlement"&&pi.metadata.paymentId===TARGET_PAYMENT_ID&&(pi.status.cancelled===true||pi.status.user_cancelled===true)&&pi.status.transaction_verified!==true&&pi.status.developer_completed!==true&&pi.transaction==null&&exact(pi.txid)===null&&exact(pi.transaction_id)===null&&exact(tx?.txid)===null
  if(!exactCancelled)return{ok:false as const,outcome:"PI_CANCELLED_IDENTITY_NOT_PROVEN" as const,financialAuthorityMutated:false,piMutationExecuted:false,horizonSubmitExecuted:false,redisMutated:false}
  const horizon=await proveA2UStage1HorizonAbsence(pi,TARGET_A2U_PAYMENT_ID)
  if(horizon.outcome!=="ABSENT")return{ok:false as const,outcome:"HORIZON_ABSENCE_NOT_PROVEN" as const,horizonOutcome:horizon.outcome,horizonReason:"reason" in horizon?horizon.reason:null,financialAuthorityMutated:false,piMutationExecuted:false,horizonSubmitExecuted:false,redisMutated:false}
  const provenAt=new Date().toISOString()
  const retired=await retireCancelledSettlementA2UStage1({paymentId:TARGET_PAYMENT_ID,a2uPaymentId:TARGET_A2U_PAYMENT_ID,piCancelledAt:provenAt,horizonAbsenceProvenAt:provenAt})
  if(retired.outcome!=="RETIRED"&&retired.outcome!=="REPLAYED")return{ok:false as const,outcome:"DURABLE_RETIREMENT_NOT_PROVEN" as const,durableOutcome:retired.outcome,financialAuthorityMutated:false,piMutationExecuted:false,horizonSubmitExecuted:false,redisMutated:false}
  const post=await query(`SELECT s.stage,s.a2u_payment_id,s.a2u_from_address,s.a2u_to_address,s.prepared_envelope_xdr,s.prepared_tx_hash,s.prepared_sequence,s.a2u_txid,s.horizon_fee_stroops,s.horizon_confirmed_at,s.pi_completed_at,s.db_finalized_at,EXISTS(SELECT 1 FROM settlement_a2u_stage1_retirements r WHERE r.payment_id=$1 AND r.a2u_payment_id=$2 AND r.reason='pi_cancelled_before_transaction') AS retirement_evidence FROM settlement_checkpoints s WHERE s.payment_id=$1`,[TARGET_PAYMENT_ID,TARGET_A2U_PAYMENT_ID])
  const p=Array.isArray(post)&&post.length===1?post[0] as Row:null
  const postProven=Boolean(p&&p.stage==="payment_identity"&&p.a2u_payment_id==null&&p.a2u_from_address==null&&p.a2u_to_address==null&&p.prepared_envelope_xdr==null&&p.prepared_tx_hash==null&&p.prepared_sequence==null&&p.a2u_txid==null&&p.horizon_fee_stroops==null&&p.horizon_confirmed_at==null&&p.pi_completed_at==null&&p.db_finalized_at==null&&p.retirement_evidence===true)
  if(!postProven)return{ok:false as const,outcome:"DURABLE_POSTCONDITION_INDETERMINATE" as const,durableOutcome:retired.outcome,financialAuthorityMutated:true,piMutationExecuted:false,horizonSubmitExecuted:false,redisMutated:false}
  let redisProjectionOutcome="UNAVAILABLE";let redisMutated=false
  if(isRedisConfigured){
    try{const latest=parseProjection(await redis.get(`payment:${TARGET_PAYMENT_ID}`));if(latest&&latest.id===TARGET_PAYMENT_ID){const cleaned:Payment={...latest};delete cleaned.a2uPaymentId;delete cleaned.a2uFromAddress;delete cleaned.a2uToAddress;delete cleaned.a2uPreparedEnvelopeXdr;delete cleaned.a2uPreparedTxHash;delete cleaned.a2uPreparedSequence;delete cleaned.a2uTxid;delete cleaned.horizonFeeCharged;delete cleaned.horizonSuccessAt;delete cleaned.settledAt;cleaned.status="paid_to_app";cleaned.settlementFailureState="retryable";cleaned.refundStatus="not_started";cleaned.a2uErrorCode="a2u_stage1_retired_cancelled";cleaned.a2uErrorMessage="Cancelled A2U retired after exact Pi and Horizon absence proof";const cas=await compareAndSwapPaymentProjection(TARGET_PAYMENT_ID,latest,cleaned);redisProjectionOutcome=cas.outcome;redisMutated=cas.outcome==="UPDATED"}else redisProjectionOutcome=latest?"INVALID_ID":"MISSING"}catch{redisProjectionOutcome="UNAVAILABLE"}
  }
  return{ok:true as const,outcome:"RETIRED_CANCELLED_STAGE1" as const,paymentId:TARGET_PAYMENT_ID,a2uPaymentId:TARGET_A2U_PAYMENT_ID,piExactCancelled:true,horizonAbsenceProven:true,durableOutcome:retired.outcome,durablePostconditionProven:true,redisProjectionOutcome,financialAuthorityMutated:true,piMutationExecuted:false,horizonSubmitExecuted:false,redisMutated}
}
