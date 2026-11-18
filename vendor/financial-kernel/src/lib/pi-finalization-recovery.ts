import 'server-only'
// Only replay metadata transitions on an immutable Pi payment. Never create,
// cancel, sign or submit money here. The caller must first verify canonical Pi
// state and hold the original payment transaction lock/identity checks.
export async function claimPiFinalizationRecovery(tx:any,p:{kind:string;paymentId:string;externalPaymentId:string;txid?:string;refundId?:string},originalAt:unknown):Promise<boolean>{
 if(!['u2a_approve','u2a_complete','a2u_complete','refund_complete'].includes(p.kind))return false
 const policy=await tx`SELECT r.payment_id FROM r36_testnet_ingress_reservations r
 JOIN r36_certificate_policies p ON p.policy_digest=r.policy_digest
 JOIN financial_wallet_activation w ON w.source_wallet=r.source_wallet AND w.network=public.r36_network() AND w.state='enabled'
 WHERE r.payment_id=${p.paymentId} AND r.retired_by_payment_id IS NULL AND p.enabled AND NOT p.revoked
 AND (${p.kind}='u2a_approve' OR public.r36_policy_subject(p.worker_profile,r))
 AND extract(epoch FROM clock_timestamp()) BETWEEN p.valid_from AND least(p.valid_until,p.revocation_valid_until)-1
 AND NOT EXISTS(SELECT 1 FROM r36_legacy_right_holds WHERE payment_id=r.payment_id)
 AND ${originalAt}::timestamptz<=clock_timestamp()-interval '30 seconds'
 FOR SHARE OF r,p,w`
 if(policy.length!==1)return false
 const rows=await tx`INSERT INTO financial_pi_finalization_recovery(mutation_kind,payment_id,external_payment_id,txid,refund_id,generation,attempted_at)
 VALUES(${p.kind},${p.paymentId},${p.externalPaymentId},${p.txid??null},${p.refundId??null},1,clock_timestamp())
 ON CONFLICT(mutation_kind,payment_id) DO UPDATE SET generation=financial_pi_finalization_recovery.generation+1,attempted_at=clock_timestamp()
 WHERE financial_pi_finalization_recovery.external_payment_id=excluded.external_payment_id
 AND financial_pi_finalization_recovery.txid IS NOT DISTINCT FROM excluded.txid
 AND financial_pi_finalization_recovery.refund_id IS NOT DISTINCT FROM excluded.refund_id
 AND financial_pi_finalization_recovery.attempted_at<=clock_timestamp()-interval '30 seconds'
 RETURNING generation`
 return rows.length===1
}
