import 'server-only'
import {withPaymentAuthorityTransaction} from './db'
import {numberToExactPositiveStroops} from './financial-amount-stroops'

// A bounded identity-preparation retry does not reset the original create claim
// or authorize funds. The existing immutable refund writer selects one Pi ID;
// all original payer, certificate, wallet, XOR and submission checks still run.
export async function claimRefundIdentityRecovery(input:{refundId:string;paymentId:string;idempotencyKey:string;payerUid:string;amount:number}):Promise<{outcome:'RECORDED'|'HELD';generation?:number}>{
 const held={outcome:'HELD' as const},policy=process.env.R36_SCOPED_POLICY_DIGEST
 if(process.env.FLASHPAY_RECOVERY_SCOPE!=='admitted_new'||!policy||!/^[0-9a-f]{64}$/.test(policy)||
 Object.entries(input).some(([k,v])=>k!=='amount'&&(typeof v!=='string'||!v||v!==v.trim()))||numberToExactPositiveStroops(input.amount)===null)return held
 try{
  return await withPaymentAuthorityTransaction(input.paymentId,async(tx:any)=>{
   const rows=await tx`SELECT c.refund_id FROM refund_checkpoints c
    JOIN settlement_checkpoints s ON s.payment_id=c.payment_id
    JOIN refund_pi_create_attempts a ON a.refund_id=c.refund_id AND a.payment_id=c.payment_id AND a.idempotency_key=c.idempotency_key
    JOIN r36_testnet_ingress_reservations r ON r.payment_id=c.payment_id
    JOIN r36_certificate_policies p ON p.policy_digest=r.policy_digest
    JOIN financial_wallet_activation w ON w.source_wallet=r.source_wallet AND w.network=public.r36_network() AND w.state='enabled'
    WHERE public.r36_network()='Pi Testnet' AND c.refund_id=${input.refundId} AND c.payment_id=${input.paymentId} AND c.idempotency_key=${input.idempotencyKey}
     AND c.payer_uid=${input.payerUid} AND c.amount=${input.amount}
     AND c.status='pending' AND c.stage='wallet_submission_started' AND c.pi_mutation_guard_version='fin7_v2'
     AND c.refund_payment_id IS NULL AND c.refund_txid IS NULL
     AND (c.next_retry_at IS NULL OR c.next_retry_at AT TIME ZONE 'UTC'<=clock_timestamp())
     AND a.attempted_at<=clock_timestamp()-interval '30 seconds'
     AND s.stage='payment_identity' AND s.payer_uid=c.payer_uid AND s.customer_amount=c.amount
     AND s.u2a_identifier IS NOT NULL AND s.u2a_txid IS NOT NULL AND s.u2a_verified_at IS NOT NULL AND s.u2a_completed_at IS NOT NULL
     AND public.r36_contract_valid(to_jsonb(s))
     AND s.a2u_create_attempted_at IS NULL AND s.a2u_payment_id IS NULL AND s.a2u_from_address IS NULL AND s.a2u_to_address IS NULL
     AND s.prepared_envelope_xdr IS NULL AND s.prepared_tx_hash IS NULL AND s.prepared_sequence IS NULL
     AND s.a2u_txid IS NULL AND s.horizon_fee_stroops IS NULL AND s.horizon_confirmed_at IS NULL AND s.pi_completed_at IS NULL AND s.db_finalized_at IS NULL
     AND (s.certification_hold IS NULL OR s.certification_hold='dr11_refund')
     AND r.policy_digest=${policy} AND r.retired_by_payment_id IS NULL AND r.payer_uid=c.payer_uid AND r.payer_wallet IS NOT NULL
     AND r.amount_stroops=c.amount*10000000 AND p.enabled AND NOT p.revoked
     AND public.r36_policy_subject(p.worker_profile,r)
     AND extract(epoch FROM clock_timestamp()) BETWEEN p.valid_from AND least(p.valid_until,p.revocation_valid_until)-1
     AND NOT EXISTS(SELECT 1 FROM r36_legacy_right_holds WHERE payment_id=c.payment_id)
     AND NOT EXISTS(SELECT 1 FROM refund_automatic_retirements WHERE refund_id=c.refund_id OR payment_id=c.payment_id)
     AND NOT EXISTS(SELECT 1 FROM financial_wallet_authorities WHERE owner_payment_id=c.payment_id)
     AND NOT EXISTS(SELECT 1 FROM financial_wallet_submission_attempts WHERE owner_payment_id=c.payment_id)
     AND NOT EXISTS(SELECT 1 FROM refund_accounting_records WHERE refund_id=c.refund_id OR payment_id=c.payment_id)
     AND NOT EXISTS(SELECT 1 FROM transactions WHERE payment_id=s.u2a_identifier)
     AND NOT EXISTS(SELECT 1 FROM refund_audit_events WHERE refund_id=c.refund_id AND event_type IN ('refund_blockchain_submission_started','refund_blockchain_submit_prepared','refund_blockchain_submit_authorized','refund_payment_identified'))
    FOR UPDATE OF c,s FOR SHARE OF r,p,w`
   if(rows.length!==1)return held
   const previous=await tx`SELECT payment_id,generation,response_status,response_code,attempted_at<=clock_timestamp()-interval '30 seconds' AS due
    FROM refund_pi_identity_recovery WHERE refund_id=${input.refundId} FOR UPDATE`
   if(previous.length>1||(previous.length===1&&(previous[0].payment_id!==input.paymentId||previous[0].due!==true||
    (previous[0].response_status!==null&&previous[0].response_status<500&&previous[0].response_status!==429&&previous[0].response_code!=='too_many_payments'))))return held
   const written=await tx`INSERT INTO refund_pi_identity_recovery(refund_id,payment_id,generation,attempted_at)
    VALUES(${input.refundId},${input.paymentId},1,clock_timestamp()) ON CONFLICT(refund_id) DO UPDATE
    SET generation=refund_pi_identity_recovery.generation+1,attempted_at=clock_timestamp(),response_status=NULL,response_code=NULL,response_request_id=NULL,response_sha256=NULL,observed_at=NULL
    WHERE refund_pi_identity_recovery.payment_id=${input.paymentId} AND refund_pi_identity_recovery.attempted_at<=clock_timestamp()-interval '30 seconds'
    RETURNING generation`
   const generation=Number(written[0]?.generation)
   return written.length===1&&Number.isSafeInteger(generation)&&generation>0?{outcome:'RECORDED' as const,generation}:held
  })??held
 }catch{console.warn('[Refund identity recovery] durable scheduling unavailable');return held}
}

export async function observeRefundIdentityRecovery(input:{refundId:string;paymentId:string;generation:number;httpStatus:number|null;code:string;requestId:string;sha256:string}):Promise<void>{
 if(!Number.isSafeInteger(input.generation)||input.generation<1||(input.httpStatus!==null&&(!Number.isInteger(input.httpStatus)||input.httpStatus<100||input.httpStatus>599))||
 !/^[0-9a-f]{64}$/.test(input.sha256)||input.code.length>100||input.requestId.length>128)return
 try{await withPaymentAuthorityTransaction(input.paymentId,async(tx:any)=>tx`UPDATE refund_pi_identity_recovery
  SET response_status=${input.httpStatus},response_code=${input.code},response_request_id=${input.requestId},response_sha256=${input.sha256},observed_at=clock_timestamp()
  WHERE refund_id=${input.refundId} AND payment_id=${input.paymentId} AND generation=${input.generation} AND observed_at IS NULL`)}
 catch{console.warn('[Refund identity recovery] observation not persisted')}
}
