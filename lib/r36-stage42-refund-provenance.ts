/** Stage42/1D read-only, fail-closed refund provenance diagnostic.
 * An authority claim and a prepared event are evidence of intent, NOT independent
 * proof of money movement, complete wallet history, or rotation clearance.
 */
export type PgRead = {query:(sql:string,params?:readonly unknown[])=>Promise<{rows:Record<string,unknown>[]}>};
export type RefundProvenanceResult = Readonly<{
 outcome:'BLOCKED'; reason:string; authorizesRotation:false;
 totalRefunds:number; matchedPrepared:number; unresolved:number;
}>;
const SQL = `SELECT c.refund_id,c.payment_id,c.refund_payment_id,c.refund_txid,c.status,c.stage,
 a.source_wallet,a.prepared_tx_hash,a.prepared_sequence,a.network,
 e.details AS prepared_details,
 a.operation_kind AS authority_kind
 FROM refund_checkpoints c
 LEFT JOIN financial_wallet_authorities a ON a.owner_payment_id=c.payment_id
   AND a.owner_operation_id=c.refund_id AND a.operation_kind='refund'
 LEFT JOIN refund_audit_events e ON e.refund_id=c.refund_id
   AND e.payment_id=c.payment_id AND e.idempotency_key=c.idempotency_key
   AND e.event_type='refund_blockchain_submit_prepared' AND e.actor_type='system'
 ORDER BY c.refund_id`;
export async function diagnoseRefundProvenance(pg:PgRead,wallet:string):Promise<RefundProvenanceResult>{
 let begun=false,totalRefunds=0,matchedPrepared=0,unresolved=0;
 const deny=(reason:string):RefundProvenanceResult=>({outcome:'BLOCKED',reason,authorizesRotation:false,totalRefunds,matchedPrepared,unresolved});
 if(!/^G[A-Z2-7]{55}$/.test(wallet))return deny('INVALID_WALLET');
 try{
  await pg.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
  const {rows}=await pg.query(SQL);totalRefunds=rows.length;
  const seen=new Set<string>();let invalid=false;
  for(const row of rows){
   const id=row.refund_id;
   if(typeof id!=='string'||seen.has(id)){invalid=true;continue}seen.add(id);
   const details=row.prepared_details;
   const d=details&&typeof details==='object'&&!Array.isArray(details)?details as Record<string,unknown>:null;
   const bound=row.source_wallet===wallet && row.network==='Pi Testnet' && row.authority_kind==='refund' &&
    typeof row.prepared_tx_hash==='string' && /^[0-9a-f]{64}$/.test(row.prepared_tx_hash) &&
    typeof row.prepared_sequence==='string' && /^[1-9][0-9]*$/.test(row.prepared_sequence) &&
    d?.preparedHash===row.prepared_tx_hash && d?.preparedSequence===row.prepared_sequence &&
    d?.refundPaymentId===row.refund_payment_id && d?.phase==='horizon_prepared' &&
    typeof d?.envelopeXdr==='string' && d.envelopeXdr.length>0;
   if(bound)matchedPrepared++;
   // A refund lacking authoritative provenance cannot be assigned to another
   // wallet merely because its authority row is absent or no longer current.
   if(!bound)unresolved++;
   if(d && d.sourceWallet!==undefined && d.sourceWallet!==wallet)invalid=true;
   if(row.refund_txid!=null && row.refund_txid!==row.prepared_tx_hash)invalid=true;
  }
  await pg.query('COMMIT');begun=false;
  if(invalid)return deny('CONFLICTING_OR_DUPLICATE_EVIDENCE');
  if(unresolved)return deny('REFUND_PROVENANCE_INCOMPLETE');
  // Even exact prepared intent is not independent Horizon finality, and the
  // current-owner table cannot enumerate historic rotated owners.
  return deny('HISTORICAL_WALLET_AND_HORIZON_FINALITY_NOT_CERTIFIED');
 }catch{if(begun)try{await pg.query('ROLLBACK')}catch{};return deny('PROVENANCE_SNAPSHOT_FAILED')}
}
export const R36_REFUND_PROVENANCE_QUERY=SQL;
