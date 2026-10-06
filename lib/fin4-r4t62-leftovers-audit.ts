import { query } from "./db"
import { readSettlementCreatePiEvidence } from "./financial-recovery-settlement-create-pi-reader"

const PAYMENT_A="d50d0a46-a305-4008-9843-e50b8d3c265c"
const PAYMENT_B="870a49eb-f0ce-42b8-8682-e334ded12b84"
const PAYMENT_C="a0553edf-8784-4758-a246-2da36847a3b8"
const IDS=[PAYMENT_A,PAYMENT_B,PAYMENT_C] as const

function iso(v:any){return v==null?null:new Date(v).toISOString()}
function rowsOrIndeterminate(rows:unknown){return Array.isArray(rows)?rows:null}

async function readOne(paymentId:string){
  const settlement=rowsOrIndeterminate(await query(`SELECT payment_id,version,stage,merchant_id,merchant_uid,customer_amount,merchant_amount,app_commission,u2a_approval_identifier,u2a_approval_claimed_at,u2a_identifier,u2a_txid,payer_uid,u2a_verified_at,u2a_completed_at,a2u_payment_id,a2u_from_address,a2u_to_address,prepared_tx_hash,prepared_sequence,a2u_txid,horizon_confirmed_at,pi_completed_at,db_finalized_at,certification_hold,certification_hold_at,certification_hold_expires_at,created_at,updated_at FROM settlement_checkpoints WHERE payment_id=$1`,[paymentId]))
  const approvalRetirements=rowsOrIndeterminate(await query(`SELECT payment_id,pi_payment_id,reason,pi_cancelled_at,retired_at FROM settlement_u2a_approval_retirements WHERE payment_id=$1 ORDER BY retired_at ASC`,[paymentId]))
  const stage1Retirements=rowsOrIndeterminate(await query(`SELECT payment_id,a2u_payment_id,reason,pi_cancelled_at,horizon_absence_proven_at,retired_at FROM settlement_a2u_stage1_retirements WHERE payment_id=$1 ORDER BY retired_at ASC`,[paymentId]))
  const ongoingObservations=rowsOrIndeterminate(await query(`SELECT payment_id,a2u_payment_id,observed_at FROM settlement_a2u_ongoing_observations WHERE payment_id=$1 ORDER BY observed_at ASC`,[paymentId]))
  const refunds=rowsOrIndeterminate(await query(`SELECT refund_id,payment_id,status,stage,payer_uid,amount,currency,refund_payment_id,refund_txid,attempt_count,last_error_code,last_error_message,next_retry_at,created_at,updated_at FROM refund_checkpoints WHERE payment_id=$1 ORDER BY created_at ASC,refund_id ASC`,[paymentId]))
  const refundRetirements=rowsOrIndeterminate(await query(`SELECT refund_id,payment_id,reason,evidence_code,created_at FROM refund_automatic_retirements WHERE payment_id=$1 ORDER BY created_at ASC,refund_id ASC`,[paymentId]))
  const refundAccounting=rowsOrIndeterminate(await query(`SELECT refund_id,payment_id,refund_payment_id,refund_txid,payer_uid,amount,currency,horizon_fee_stroops,created_at FROM refund_accounting_records WHERE payment_id=$1 ORDER BY created_at ASC,refund_id ASC`,[paymentId]))
  if([settlement,approvalRetirements,stage1Retirements,ongoingObservations,refunds,refundRetirements,refundAccounting].some(v=>v===null))
    return {paymentId,outcome:"INDETERMINATE" as const,reason:"POSTGRES_READ_FAILED" as const}
  if(settlement!.length>1)return{paymentId,outcome:"INDETERMINATE" as const,reason:"SETTLEMENT_IDENTITY_AMBIGUOUS" as const}
  const s:any=settlement![0]??null
  const piIdentifier=s&&typeof s.u2a_identifier==="string"&&s.u2a_identifier?s.u2a_identifier:
    s&&typeof s.u2a_approval_identifier==="string"&&s.u2a_approval_identifier?s.u2a_approval_identifier:null
  const pi=piIdentifier?await readSettlementCreatePiEvidence(piIdentifier):{outcome:"NOT_ADDRESSABLE" as const}
  return {
    paymentId,outcome:"READ" as const,
    postgres:{
      settlement:s?{...s,u2a_approval_claimed_at:iso(s.u2a_approval_claimed_at),u2a_verified_at:iso(s.u2a_verified_at),u2a_completed_at:iso(s.u2a_completed_at),horizon_confirmed_at:iso(s.horizon_confirmed_at),pi_completed_at:iso(s.pi_completed_at),db_finalized_at:iso(s.db_finalized_at),certification_hold_at:iso(s.certification_hold_at),certification_hold_expires_at:iso(s.certification_hold_expires_at),created_at:iso(s.created_at),updated_at:iso(s.updated_at)}:null,
      approvalRetirements,stage1Retirements,ongoingObservations,refunds,refundRetirements,refundAccounting
    },
    pi:{identifier:piIdentifier,evidence:pi}
  }
}

export async function readFin4R4T62LeftoversAudit(){
  const [A,B,C]=await Promise.all(IDS.map(readOne))
  return {
    ok:[A,B,C].every(x=>x.outcome==="READ"),
    action:"fin4-r4t62-abc-leftovers-read-only-audit",
    authority:"postgres_first_leftover_inventory_with_pi_readback",
    payments:{A,B,C},
    mutationContract:{
      postgresMutationExecuted:false,redisReadExecuted:false,redisMutationExecuted:false,
      piReadExecuted:true,piMutationExecuted:false,horizonReadExecuted:false,horizonSubmitExecuted:false,
      financialAuthorityMutated:false
    }
  }
}
