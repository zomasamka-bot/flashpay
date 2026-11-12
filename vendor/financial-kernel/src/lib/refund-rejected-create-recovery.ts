import 'server-only'
import {getR36RestrictedClient} from './db'

// Explicit expiring authorization for a proven provider rejection permits ONE
// replacement creation. Never reset the original attempt or admit uncertainty.
// No signing, wallet submission, completion or accounting authority is granted.
export async function claimRejectedRefundCreateRecovery(input:{refundId:string;paymentId:string;idempotencyKey:string}):Promise<boolean> {
  if(process.env.FLASHPAY_RECOVERY_SCOPE!=='admitted_new')return false
  const policy=process.env.R36_SCOPED_POLICY_DIGEST
  if(!policy||!/^[0-9a-f]{64}$/.test(policy)||Object.values(input).some(v=>typeof v!=='string'||!v||v!==v.trim()))return false
  try{
    const db=await getR36RestrictedClient();if(!db)return false
    const rows=await db.unsafe('SELECT public.r36_claim_rejected_refund_create($1,$2,$3,$4) AS outcome',[input.refundId,input.paymentId,input.idempotencyKey,policy])
    return rows.length===1&&rows[0].outcome==='RECORDED'
  }catch{return false}
}
