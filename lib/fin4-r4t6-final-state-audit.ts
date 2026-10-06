import 'server-only'
import { getDurableU2AIngressAuthoritative, getSettlementCheckpointAuthoritative, query } from './db'
import { readSettlementCreatePiEvidence } from './financial-recovery-settlement-create-pi-reader'
import { readSettlementSubmitHorizonEvidence } from './financial-recovery-settlement-submit-horizon-reader'

export const FIN4_R4T6_PAYMENT_A='d50d0a46-a305-4008-9843-e50b8d3c265c' as const
export const FIN4_R4T6_PAYMENT_B='870a49eb-f0ce-42b8-8682-e334ded12b84' as const

type PaymentId=typeof FIN4_R4T6_PAYMENT_A|typeof FIN4_R4T6_PAYMENT_B

async function readRefundState(paymentId:PaymentId){
  const checkpointRows=await query(`SELECT refund_id,payment_id,status,stage,amount,currency,refund_payment_id,refund_txid,attempt_count,last_error_code,last_error_message,next_retry_at,created_at,updated_at FROM refund_checkpoints WHERE payment_id=$1 ORDER BY created_at ASC,refund_id ASC`,[paymentId])
  if(!Array.isArray(checkpointRows))return{outcome:'INDETERMINATE' as const,reason:'REFUND_CHECKPOINT_READ_FAILED' as const}
  const checkpoints=checkpointRows.map((r:any)=>({refundId:String(r.refund_id),paymentId:String(r.payment_id),status:String(r.status),stage:String(r.stage),amount:Number(r.amount),currency:String(r.currency),refundPaymentId:typeof r.refund_payment_id==='string'?r.refund_payment_id:null,refundTxid:typeof r.refund_txid==='string'?r.refund_txid:null,attemptCount:Number(r.attempt_count),lastErrorCode:typeof r.last_error_code==='string'?r.last_error_code:null,lastErrorMessage:typeof r.last_error_message==='string'?r.last_error_message:null,nextRetryAt:r.next_retry_at?new Date(r.next_retry_at).toISOString():null,createdAt:new Date(r.created_at).toISOString(),updatedAt:new Date(r.updated_at).toISOString()}))
  const retirementRows=await query(`SELECT refund_id,payment_id,reason,evidence_code,created_at FROM refund_automatic_retirements WHERE payment_id=$1 ORDER BY created_at ASC,refund_id ASC`,[paymentId])
  if(!Array.isArray(retirementRows))return{outcome:'INDETERMINATE' as const,reason:'REFUND_RETIREMENT_READ_FAILED' as const,checkpoints}
  const retirements=retirementRows.map((r:any)=>({refundId:String(r.refund_id),paymentId:String(r.payment_id),reason:String(r.reason),evidenceCode:String(r.evidence_code),createdAt:new Date(r.created_at).toISOString()}))
  return{outcome:'READ' as const,checkpoints,retirements}
}

async function readOne(paymentId:PaymentId){
  const [ingress,settlement,refund]=await Promise.all([
    getDurableU2AIngressAuthoritative(paymentId),
    getSettlementCheckpointAuthoritative(paymentId),
    readRefundState(paymentId),
  ])
  const durableIdentity=settlement.outcome==='FOUND'?settlement.checkpoint:ingress.outcome==='FOUND'?ingress.checkpoint:null
  const pi=durableIdentity?await readSettlementCreatePiEvidence(durableIdentity.u2aIdentifier):{outcome:'INDETERMINATE' as const,reason:'DURABLE_PI_IDENTITY_UNPROVEN' as const}
  const horizon=settlement.outcome==='FOUND'&&settlement.checkpoint.preparedTxHash&&settlement.checkpoint.preparedSequence
    ? await readSettlementSubmitHorizonEvidence(settlement.checkpoint.preparedTxHash,settlement.checkpoint.preparedSequence,settlement.checkpoint.a2uFromAddress)
    : {authorizesFinancialAction:false as const,outcome:'NOT_ADDRESSABLE_BY_PREPARED_HASH' as const}
  return {paymentId,postgres:{ingress,settlement,refund},pi,horizon}
}

export async function readFin4R4T6FinalStateAudit(){
  const [a,b]=await Promise.all([readOne(FIN4_R4T6_PAYMENT_A),readOne(FIN4_R4T6_PAYMENT_B)])
  const sourceWallet=a.postgres.settlement.outcome==='FOUND'?a.postgres.settlement.checkpoint.a2uFromAddress:b.postgres.settlement.outcome==='FOUND'?b.postgres.settlement.checkpoint.a2uFromAddress:null
  return {
    ok:true as const,
    action:'fin4-r4t6-final-state-read-only-audit' as const,
    authority:'postgres_first_external_read_reconciliation' as const,
    payments:{A:a,B:b},
    sourceWallet,
    mutationContract:{postgresMutationExecuted:false,redisReadExecuted:false,redisMutationExecuted:false,piMutationExecuted:false,horizonSubmitExecuted:false,financialAuthorityMutated:false} as const,
  }
}
