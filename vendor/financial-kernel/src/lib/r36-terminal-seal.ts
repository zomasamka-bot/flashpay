import {financialNetwork} from './financial-network'
import 'server-only'
import {createHash} from 'node:crypto'
import {query} from './db'
import {serverConfig} from './server-config'
import {numberToExactPositiveStroops,exactPositiveStroopsToStellarAmount} from './financial-amount-stroops'
import {readR36IndependentHorizonProof} from './r36-independent-horizon-proof'
import {recordWalletFinalitySeal,type WalletAuthorityClaim} from './financial-wallet-authority'
import {readRefundPresentation} from './refund-presentation-reader'

// Records completed facts only. It grants no submission, accounting, rotation
// or certificate authority. The independent SQL62 issuer still rechecks them.
// Expired admission certificates remain historical identity evidence here;
// they are NEVER reused as permission for a new financial operation.
type Terminal = WalletAuthorityClaim & {
  destinationWallet:string; recipientUid:string; piPaymentId:string;
  amountStroops:string; amount:string; fee:string; envelope:string;
  idempotencyKey:string|null; certificateDigest:string; sealRecorded:boolean;
}
const digest=(v:string)=>createHash('sha256').update(v).digest('hex')
const object=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null

// Only an admitted, budgeted new right which actually used the wallet can be
// selected. The SQL62 terminal accounting/XOR predicates are applied before
// reading providers. No Redis state participates in this decision.
const selectTerminal = `SELECT jsonb_build_object(
  'network',a.network,'sourceWallet',a.source_wallet,'paymentId',a.owner_payment_id,
  'operationKind',a.operation_kind,'operationId',a.owner_operation_id,
  'preparedHash',a.prepared_tx_hash,'preparedSequence',a.prepared_sequence,
  'destinationWallet',q.binding->>'destinationWallet',
  'recipientUid',CASE WHEN a.operation_kind='refund' THEN r.payer_uid ELSE s.merchant_uid END,
  'piPaymentId',CASE WHEN a.operation_kind='refund' THEN r.refund_payment_id ELSE s.a2u_payment_id END,
  'amountStroops',q.binding->>'amountStroops','amount',(CASE WHEN a.operation_kind='settlement' THEN s.merchant_amount ELSE s.customer_amount END)::text,
  'fee',CASE WHEN a.operation_kind='refund' THEN ra.horizon_fee_stroops::text ELSE s.horizon_fee_stroops::text END,
  'envelope',CASE WHEN a.operation_kind='refund' THEN e.details->>'envelopeXdr' ELSE s.prepared_envelope_xdr END,
  'idempotencyKey',CASE WHEN a.operation_kind='refund' THEN r.idempotency_key ELSE NULL END,
  'certificateDigest',c.payload_digest,'sealRecorded',EXISTS(SELECT 1 FROM public.financial_wallet_finality_seals z
    WHERE z.network=a.network AND z.source_wallet=a.source_wallet AND z.prepared_tx_hash=a.prepared_tx_hash)) AS terminal
 FROM public.financial_wallet_authorities a
 JOIN public.r36_testnet_ingress_reservations ingress ON ingress.payment_id=a.owner_payment_id
  AND ingress.source_wallet=a.source_wallet AND ingress.policy_digest=$2
 JOIN public.r36_recovery_trial_reservations trial ON trial.payment_id=a.owner_payment_id
 JOIN public.r36_certificate_requests q ON q.nonce=trial.nonce AND q.policy_digest=$2
 JOIN public.r36_certificate_receipts c ON c.nonce=q.nonce AND c.payload_digest=trial.payload_digest
 JOIN public.r36_certificate_policies p ON p.policy_digest=q.policy_digest
 JOIN public.settlement_checkpoints s ON s.payment_id=a.owner_payment_id
 JOIN public.financial_wallet_submission_attempts attempt ON attempt.network=a.network
  AND attempt.source_wallet=a.source_wallet AND attempt.owner_payment_id=a.owner_payment_id
  AND attempt.operation_kind=a.operation_kind AND attempt.owner_operation_id=a.owner_operation_id
  AND attempt.prepared_tx_hash=a.prepared_tx_hash AND attempt.prepared_sequence=a.prepared_sequence
 LEFT JOIN public.refund_checkpoints r ON r.payment_id=a.owner_payment_id
 LEFT JOIN public.refund_accounting_records ra ON ra.refund_id=r.refund_id AND ra.payment_id=r.payment_id
 LEFT JOIN public.refund_audit_events e ON e.refund_id=r.refund_id AND e.payment_id=r.payment_id
  AND e.event_id='refund:'||r.refund_id||':blockchain_submit_prepared'
  AND e.idempotency_key=r.idempotency_key AND e.event_type='refund_blockchain_submit_prepared' AND e.actor_type='system'
 WHERE a.network='${financialNetwork()}' AND a.state='prepared' AND ($1::text IS NULL OR a.owner_payment_id=$1)
  AND p.enabled AND NOT p.revoked
  AND extract(epoch FROM clock_timestamp()) BETWEEN p.valid_from AND least(p.valid_until,p.revocation_valid_until)-1
  AND p.revocation_checked_at<=extract(epoch FROM clock_timestamp())
  AND public.r36_policy_subject(p.worker_profile,ingress)
  AND (public.r36_general_policy(p.worker_profile) OR p.worker_profile->'recoveryPilot'->'ingress'->'allowTerminalReservationTurnover'='true'::jsonb)
  AND NOT EXISTS(SELECT 1 FROM public.r36_certificate_revocations x WHERE x.payload_digest=c.payload_digest)
  AND (NOT EXISTS(SELECT 1 FROM public.financial_wallet_finality_seals x
    WHERE x.network=a.network AND x.source_wallet=a.source_wallet AND x.prepared_tx_hash=a.prepared_tx_hash)
    OR (a.operation_kind='refund' AND NOT EXISTS(SELECT 1 FROM public.refund_audit_events x
      WHERE x.refund_id=a.owner_operation_id AND x.event_type='refund_presentation_proof_recorded')))
  AND q.binding->>'network'=a.network AND q.binding->>'sourceWallet'=a.source_wallet
  AND q.binding->>'paymentId'=a.owner_payment_id AND q.binding->>'operationKind'=a.operation_kind
  AND q.binding->>'operationId'=a.owner_operation_id AND q.binding->>'preparedHash'=a.prepared_tx_hash
  AND q.binding->>'preparedSequence'=a.prepared_sequence
  AND q.binding->>'piPaymentId'=s.u2a_identifier AND q.binding->>'u2aTxid'=s.u2a_txid
  AND q.binding->>'amountStroops'=((CASE WHEN a.operation_kind='settlement' THEN s.merchant_amount ELSE s.customer_amount END)*10000000)::bigint::text AND trial.amount_stroops=ingress.amount_stroops
  AND trial.amount_stroops=s.customer_amount*10000000 AND trial.amount_stroops BETWEEN 1 AND public.r36_policy_max_amount(p.worker_profile)
  AND s.customer_amount=s.merchant_amount+s.app_commission AND s.u2a_completed_at IS NOT NULL
  AND ingress.merchant_id=s.merchant_id AND ingress.merchant_uid=s.merchant_uid AND ingress.payer_uid=s.payer_uid
  AND q.binding->>'destinationWallet'=CASE WHEN a.operation_kind='refund' THEN ingress.payer_wallet ELSE ingress.merchant_wallet END
  AND encode(sha256(convert_to(CASE WHEN a.operation_kind='refund' THEN e.details->>'envelopeXdr' ELSE s.prepared_envelope_xdr END,'UTF8')),'hex')=q.binding->>'envelopeXdrTextSha256'
  AND (
   (a.operation_kind='settlement' AND r.refund_id IS NULL AND EXISTS(
    SELECT 1 FROM public.transactions t JOIN public.receipts receipt ON receipt.transaction_id=t.id
    WHERE t.payment_id=s.u2a_identifier AND s.stage='db_finalized'
     AND s.pi_completed_at IS NOT NULL AND s.db_finalized_at IS NOT NULL AND s.horizon_confirmed_at IS NOT NULL
     AND s.a2u_from_address=a.source_wallet AND s.a2u_to_address=q.binding->>'destinationWallet'
     AND s.a2u_payment_id=a.owner_operation_id AND s.a2u_txid=a.prepared_tx_hash
     AND s.prepared_tx_hash=a.prepared_tx_hash AND s.prepared_sequence::text=a.prepared_sequence
     AND t.merchant_id=s.merchant_id AND t.merchant_uid=s.merchant_uid AND t.status='completed' AND t.currency='π'
     AND t.amount=s.merchant_amount AND receipt.merchant_id=s.merchant_id AND receipt.merchant_uid=s.merchant_uid
     AND receipt.currency='π' AND receipt.amount=s.merchant_amount AND receipt.customer_amount=s.customer_amount
     AND receipt.merchant_amount=s.merchant_amount AND receipt.app_commission=s.app_commission AND receipt.txid=s.a2u_txid
     AND receipt.u2a_identifier=s.u2a_identifier AND receipt.u2a_txid=s.u2a_txid
     AND receipt.a2u_identifier=s.a2u_payment_id AND receipt.a2u_txid=s.a2u_txid
     AND receipt.horizon_fee_charged*10000000=s.horizon_fee_stroops AND receipt.app_net_impact=receipt.app_commission-receipt.horizon_fee_charged
     AND receipt.settlement_status='settled_to_merchant'
     AND (SELECT count(*) FROM public.transactions z WHERE z.payment_id=s.u2a_identifier)=1
     AND (SELECT count(*) FROM public.receipts z WHERE z.transaction_id=t.id)=1))
   OR
   (a.operation_kind='refund' AND s.stage='payment_identity'
    AND r.refund_id=a.owner_operation_id AND r.status='completed' AND r.stage='audit_recorded' AND r.refund_txid=a.prepared_tx_hash
    AND r.amount=s.customer_amount AND r.payer_uid=s.payer_uid
    AND ra.refund_txid=r.refund_txid AND ra.refund_payment_id=r.refund_payment_id AND ra.amount=r.amount
    AND ra.payer_uid=r.payer_uid AND ra.currency='π'
    AND e.details->>'phase'='horizon_prepared' AND e.details->>'refundPaymentId'=r.refund_payment_id
    AND e.details->>'preparedHash'=a.prepared_tx_hash AND e.details->>'preparedSequence'=a.prepared_sequence
    AND NOT EXISTS(SELECT 1 FROM public.transactions t WHERE t.payment_id=s.u2a_identifier)
    AND EXISTS(SELECT 1 FROM public.refund_audit_events z WHERE z.refund_id=r.refund_id AND z.payment_id=r.payment_id
     AND z.event_id='refund:'||r.refund_id||':projection_finalized' AND z.event_type='refund_projection_finalized'
     AND z.actor_type='system' AND z.idempotency_key=r.idempotency_key
     AND (z.details=jsonb_build_object('refundPaymentId',r.refund_payment_id,'refundTxid',r.refund_txid)
      OR (jsonb_typeof(z.details)='string' AND (z.details #>> '{}')=concat('{"refundPaymentId":',to_json(r.refund_payment_id)::text,',"refundTxid":',to_json(r.refund_txid)::text,'}'))))
    AND (SELECT count(*) FROM public.refund_audit_events z WHERE z.refund_id=r.refund_id AND z.event_type='refund_projection_finalized')=1))`

export async function recordAdmittedTerminalSeal(subject:string|null,policy:string):Promise<'terminal_seal_recorded'|'terminal_presentation_recorded'|'terminal_seal_held'|null> {
  if(process.env.FLASHPAY_RECOVERY_SCOPE!=='admitted_new'||policy!==process.env.R36_SCOPED_POLICY_DIGEST||
    !/^[0-9a-f]{64}$/.test(policy)||!serverConfig.piApiKey||
    (subject!==null&&!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(subject))) return 'terminal_seal_held'
  try {
    const rows=await query(selectTerminal,[subject,policy]) as {terminal:Terminal}[]
    if(rows.length===0)return null
    if(rows.length!==1)return 'terminal_seal_held'
    const t=rows[0].terminal
    if(!t||t.network!==financialNetwork()||!t.piPaymentId||!/^[A-Za-z0-9_-]{1,128}$/.test(t.piPaymentId))return 'terminal_seal_held'
    if(t.sealRecorded) {
      // The authenticated /refunds/status route already records this proof.
      // Recovery must finish that same durable presentation step after a crash;
      // public customer GET remains read-only and cannot manufacture an audit.
      if(t.operationKind!=='refund')return 'terminal_seal_held'
      const presentation=await readRefundPresentation(t.operationId,undefined,undefined,undefined,'record')
      return presentation.outcome==='FOUND'&&presentation.presentation.paymentId===t.paymentId&&
        presentation.presentation.customerStatus==='refund_completed'?'terminal_presentation_recorded':'terminal_seal_held'
    }
    const response=await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(t.piPaymentId)}`,{
      method:'GET',headers:{Authorization:`Key ${serverConfig.piApiKey}`,Accept:'application/json'},
      redirect:'error',cache:'no-store',signal:AbortSignal.timeout(8000)})
    if(!response.ok)return 'terminal_seal_held'
    const pi=object(await response.json()),status=object(pi?.status),tx=object(pi?.transaction),metadata=object(pi?.metadata)
    if(!pi||!status||!tx||!metadata||pi.network!==financialNetwork()||pi.identifier!==t.piPaymentId||
      pi.direction!=='app_to_user'||pi.user_uid!==t.recipientUid||pi.from_address!==t.sourceWallet||pi.to_address!==t.destinationWallet||
      typeof pi.amount!=='number'||String(numberToExactPositiveStroops(pi.amount))!==t.amountStroops||
      status.developer_approved!==true||status.developer_completed!==true||status.transaction_verified!==true||
      status.cancelled!==false||status.user_cancelled!==false||tx.verified!==true||tx.txid!==t.preparedHash||
      metadata.paymentId!==t.paymentId||metadata.type!==(t.operationKind==='refund'?'refund':'a2u_settlement')||
      (t.operationKind==='refund'&&(metadata.refundId!==t.operationId||metadata.idempotencyKey!==t.idempotencyKey)))return 'terminal_seal_held'
    const amount=exactPositiveStroopsToStellarAmount(Number(t.amountStroops))
    if(!amount)return 'terminal_seal_held'
    const proof=await readR36IndependentHorizonProof({network:t.network,preparedHash:t.preparedHash,preparedSequence:t.preparedSequence,
      sourceWallet:t.sourceWallet,destinationWallet:t.destinationWallet,amount,envelopeXdr:t.envelope,expectedFeeStroops:t.fee})
    if(proof.outcome!=='PROVEN'||!proof.ledger||proof.feeStroops!==t.fee)return 'terminal_seal_held'
    // Stable evidence identity permits concurrent/restarted exact replay; no
    // timestamps or provider fields unrelated to the verified facts are hashed.
    const evidenceDigest=digest(JSON.stringify(['R36_TERMINAL_SEAL_V1',policy,t.network,t.sourceWallet,t.paymentId,t.operationKind,
      t.operationId,t.preparedHash,t.preparedSequence,t.destinationWallet,t.recipientUid,t.piPaymentId,t.amountStroops,
      t.fee,digest(t.envelope),t.certificateDigest,proof.ledger]))
    return await recordWalletFinalitySeal({...t,horizonLedger:proof.ledger,horizonFeeStroops:t.fee,evidenceDigest,
      verifiedBy:'r36-original-terminal-get-v1'})?'terminal_seal_recorded':'terminal_seal_held'
  }catch{return 'terminal_seal_held'}
}
