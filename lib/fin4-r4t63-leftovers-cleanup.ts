import "server-only"
import { query, readSettlementU2APretransactionRecoveryCandidate, retireSettlementU2AApprovalAfterCanonicalCancellation, retireCancelledSettlementA2UStage1 } from "@/lib/db"
import { serverConfig } from "@/lib/server-config"
import { proveA2UStage1HorizonAbsence } from "@/lib/a2u-stage1-retirement"

const C_PAYMENT="a0553edf-8784-4758-a246-2da36847a3b8"
const C_PI="JYJ36kpTyzUPuEFd0uJIWAynLCJK"
const B_PAYMENT="870a49eb-f0ce-42b8-8682-e334ded12b84"
const B_A2U="SA5oKLuhfnQuU6x2PVm6PkQd4kCc"

type R=Record<string,unknown>
const rec=(v:unknown):v is R=>typeof v==="object"&&v!==null&&!Array.isArray(v)
const exact=(v:unknown)=>typeof v==="string"&&v.trim()!==""&&v===v.trim()?v:null
const num=(v:unknown)=>{const n=typeof v==="number"?v:typeof v==="string"?Number(v):NaN;return Number.isFinite(n)?n:null}
async function getPi(id:string):Promise<{ok:true;pi:R}|{ok:false;status:number|null}>{try{const r=await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(id)}`,{headers:{Authorization:`Key ${serverConfig.piApiKey}`},cache:"no-store"});if(!r.ok)return{ok:false,status:r.status};const p:unknown=await r.json().catch(()=>null);return rec(p)?{ok:true,pi:p}:{ok:false,status:null}}catch{return{ok:false,status:null}}}
const status=(p:R)=>rec(p.status)?p.status:null
const noTx=(p:R)=>p.transaction==null&&exact(p.txid)==null&&exact(p.transaction_id)==null

export async function retireC(){
 if(!serverConfig.isPiApiKeyConfigured)return{ok:false,outcome:"PI_UNAVAILABLE",piMutationExecuted:false,horizonSubmitExecuted:false}
 const c=await readSettlementU2APretransactionRecoveryCandidate(C_PAYMENT,C_PI)
 if(c.outcome!=="CANDIDATE")return{ok:false,outcome:"C_NOT_CANDIDATE",candidate:c.outcome,piMutationExecuted:false,horizonSubmitExecuted:false}
 const before=await getPi(C_PI);if(!before.ok)return{ok:false,outcome:"C_PI_READ_INDETERMINATE",piMutationExecuted:false,horizonSubmitExecuted:false}
 const s=status(before.pi);const identity=before.pi.identifier===C_PI&&before.pi.metadata!=null&&rec(before.pi.metadata)&&before.pi.metadata.paymentId===C_PAYMENT&&before.pi.network==="Pi Testnet"&&before.pi.direction==="user_to_app"&&before.pi.amount===c.customerAmount&&s?.developer_approved===true&&s?.transaction_verified===false&&s?.developer_completed===false&&(s?.cancelled===true||s?.user_cancelled===true)&&noTx(before.pi)
 if(!identity)return{ok:false,outcome:"C_CANONICAL_CANCELLED_NOT_PROVEN",piMutationExecuted:false,horizonSubmitExecuted:false}
 const h=await proveA2UStage1HorizonAbsence(before.pi,C_PI);if(h.outcome!=="ABSENT")return{ok:false,outcome:"C_HORIZON_ABSENCE_NOT_PROVEN",horizon:h.outcome,piMutationExecuted:false,horizonSubmitExecuted:false}
 const r=await retireSettlementU2AApprovalAfterCanonicalCancellation({paymentId:C_PAYMENT,piPaymentId:C_PI,piCancelledAt:new Date().toISOString()})
 return{ok:r.outcome==="RETIRED"||r.outcome==="REPLAYED",outcome:r.outcome,paymentId:C_PAYMENT,piPaymentId:C_PI,piAlreadyCancelled:true,piMutationExecuted:false,horizonAbsenceProven:true,horizonSubmitExecuted:false,financialAuthorityMutated:r.outcome==="RETIRED"}
}

export async function retireB(){
 if(!serverConfig.isPiApiKeyConfigured)return{ok:false,outcome:"PI_UNAVAILABLE",piMutationExecuted:false,horizonSubmitExecuted:false}
 const rows=await query(`SELECT stage,merchant_uid,customer_amount,a2u_payment_id,a2u_from_address,a2u_to_address,prepared_envelope_xdr,prepared_tx_hash,prepared_sequence,a2u_txid,horizon_fee_stroops,horizon_confirmed_at,pi_completed_at,db_finalized_at FROM settlement_checkpoints WHERE payment_id=$1`,[B_PAYMENT])
 if(!Array.isArray(rows)||rows.length!==1)return{ok:false,outcome:"B_DURABLE_INDETERMINATE",piMutationExecuted:false,horizonSubmitExecuted:false}
 const r=rows[0] as R, amount=num(r.customer_amount), uid=exact(r.merchant_uid)
 const pristine=r.stage==="a2u_created"&&r.a2u_payment_id===B_A2U&&exact(r.a2u_from_address)&&exact(r.a2u_to_address)&&r.prepared_envelope_xdr==null&&r.prepared_tx_hash==null&&r.prepared_sequence==null&&r.a2u_txid==null&&r.horizon_fee_stroops==null&&r.horizon_confirmed_at==null&&r.pi_completed_at==null&&r.db_finalized_at==null
 if(!pristine||amount==null||uid==null)return{ok:false,outcome:"B_PRISTINE_STAGE1_NOT_PROVEN",piMutationExecuted:false,horizonSubmitExecuted:false}
 const before=await getPi(B_A2U);if(!before.ok)return{ok:false,outcome:"B_PI_READ_INDETERMINATE",piMutationExecuted:false,horizonSubmitExecuted:false}
 const bs=status(before.pi);const exactB=before.pi.identifier===B_A2U&&before.pi.network==="Pi Testnet"&&before.pi.direction==="app_to_user"&&before.pi.amount===amount&&before.pi.user_uid===uid&&before.pi.from_address===r.a2u_from_address&&before.pi.to_address===r.a2u_to_address&&rec(before.pi.metadata)&&before.pi.metadata.type==="a2u_settlement"&&before.pi.metadata.paymentId===B_PAYMENT&&bs?.developer_approved===true&&bs?.transaction_verified!==true&&bs?.developer_completed!==true&&noTx(before.pi)
 if(!exactB)return{ok:false,outcome:"B_PI_IDENTITY_NOT_PROVEN",piMutationExecuted:false,horizonSubmitExecuted:false}
 const hb=await proveA2UStage1HorizonAbsence(before.pi,B_A2U);if(hb.outcome!=="ABSENT")return{ok:false,outcome:"B_HORIZON_ABSENCE_NOT_PROVEN_BEFORE",horizon:hb.outcome,piMutationExecuted:false,horizonSubmitExecuted:false}
 let piMutationExecuted=false
 if(bs?.cancelled!==true&&bs?.user_cancelled!==true){piMutationExecuted=true;try{await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(B_A2U)}/cancel`,{method:"POST",headers:{Authorization:`Key ${serverConfig.piApiKey}`,"Content-Type":"application/json"}})}catch{/* mandatory reread decides */}}
 const after=await getPi(B_A2U);if(!after.ok)return{ok:false,outcome:"B_CANCEL_RECONCILIATION_INDETERMINATE",piMutationExecuted,horizonSubmitExecuted:false}
 const as=status(after.pi);const cancelled=after.pi.identifier===B_A2U&&after.pi.user_uid===uid&&after.pi.amount===amount&&after.pi.direction==="app_to_user"&&after.pi.network==="Pi Testnet"&&rec(after.pi.metadata)&&after.pi.metadata.paymentId===B_PAYMENT&&(as?.cancelled===true||as?.user_cancelled===true)&&as?.transaction_verified!==true&&as?.developer_completed!==true&&noTx(after.pi)
 if(!cancelled)return{ok:false,outcome:"B_CANCEL_NOT_PROVEN",piMutationExecuted,horizonSubmitExecuted:false}
 const ha=await proveA2UStage1HorizonAbsence(after.pi,B_A2U);if(ha.outcome!=="ABSENT")return{ok:false,outcome:"B_HORIZON_ABSENCE_NOT_PROVEN_AFTER",horizon:ha.outcome,piMutationExecuted,horizonSubmitExecuted:false}
 const retired=await retireCancelledSettlementA2UStage1({paymentId:B_PAYMENT,a2uPaymentId:B_A2U,piCancelledAt:new Date().toISOString(),horizonAbsenceProvenAt:new Date().toISOString()})
 return{ok:retired.outcome==="RETIRED"||retired.outcome==="REPLAYED",outcome:retired.outcome,paymentId:B_PAYMENT,a2uPaymentId:B_A2U,piCancelled:true,piMutationExecuted,horizonAbsenceProven:true,horizonSubmitExecuted:false,financialAuthorityMutated:retired.outcome==="RETIRED"}
}
