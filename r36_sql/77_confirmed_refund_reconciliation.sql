-- Confirmed refund reconciliation only. No submission, renewal, reset or financial write.
BEGIN;
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'; SET LOCAL search_path=pg_catalog,pg_temp;
DO $$ BEGIN
 IF current_database()<>'neondb' OR session_user<>'neondb_owner' OR current_user<>session_user
 OR (current_setting('neon.branch_id',true) IS DISTINCT FROM 'br-tiny-mode-aliatv40'
 AND current_setting('flashpay.isolated_certificate_test',true) IS DISTINCT FROM 'yes')
 OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
 OR to_regprocedure('public.r36_select_confirmed_settlement_reconciliation(text,text)') IS NULL
 OR to_regprocedure('public.r36_select_confirmed_refund_reconciliation(text,text)') IS NOT NULL
 THEN RAISE EXCEPTION 'CONFIRMED_RECONCILIATION_TARGET_NOT_PROVEN'; END IF;
END $$;
GRANT r36_owner TO neondb_owner WITH INHERIT FALSE,SET TRUE;
GRANT CREATE ON SCHEMA public TO r36_owner;
SET LOCAL ROLE r36_owner;
CREATE FUNCTION public.r36_select_confirmed_refund_reconciliation(p_subject text,p_policy text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $function$
DECLARE v record;
BEGIN
 IF session_user<>'r36_runtime' OR current_setting('transaction_isolation')<>'read committed'
 OR p_policy IS NULL OR p_policy!~'^[0-9a-f]{64}$'
 OR (p_subject IS NOT NULL AND p_subject!~'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN RETURN NULL; END IF;
 SELECT i.payment_id AS id,a.source_wallet AS wallet,a.operation_kind AS kind,a.owner_operation_id AS op,
        a.prepared_tx_hash AS hash,a.prepared_sequence AS seq,q.nonce,c.payload_digest AS digest,
        (i.customer_amount*10000000)::bigint AS amount,
        CASE WHEN a.operation_kind='settlement' THEN s.stage WHEN r.status='completed' THEN 'completed_projection' ELSE r.stage END AS stage
 INTO v
 FROM public.payment_create_intents i
 JOIN public.r36_testnet_ingress_reservations ingress ON ingress.payment_id=i.payment_id AND ingress.policy_digest=p_policy
 LEFT JOIN public.r36_recovery_trial_reservations prior ON prior.payment_id=i.payment_id
 JOIN public.settlement_checkpoints s ON s.payment_id=i.payment_id
 JOIN public.financial_wallet_authorities a ON a.owner_payment_id=i.payment_id AND a.network='Pi Testnet' AND a.state='prepared'
 JOIN public.r36_certificate_requests q ON q.policy_digest=p_policy AND q.binding->>'paymentId'=i.payment_id
     AND q.binding->>'network'=a.network AND q.binding->>'sourceWallet'=a.source_wallet
     AND q.binding->>'operationKind'=a.operation_kind AND q.binding->>'operationId'=a.owner_operation_id
     AND q.binding->>'preparedHash'=a.prepared_tx_hash AND q.binding->>'preparedSequence'=a.prepared_sequence
 JOIN public.r36_certificate_receipts c ON c.nonce=q.nonce
 JOIN public.r36_certificate_policies p ON p.policy_digest=q.policy_digest
 JOIN public.financial_wallet_submission_attempts attempt ON attempt.network=a.network
  AND attempt.source_wallet=a.source_wallet AND attempt.owner_payment_id=a.owner_payment_id
  AND attempt.operation_kind=a.operation_kind AND attempt.owner_operation_id=a.owner_operation_id
  AND attempt.prepared_tx_hash=a.prepared_tx_hash AND attempt.prepared_sequence=a.prepared_sequence
 LEFT JOIN public.refund_checkpoints r ON r.payment_id=i.payment_id
 LEFT JOIN public.refund_audit_events e ON a.operation_kind='refund' AND e.payment_id=i.payment_id AND e.refund_id=r.refund_id
     AND e.event_id='refund:'||r.refund_id||':blockchain_submit_prepared' AND e.idempotency_key=r.idempotency_key
     AND e.actor_type='system' AND e.event_type='refund_blockchain_submit_prepared'
 WHERE ingress.amount_stroops=i.customer_amount*10000000 AND ingress.merchant_uid=i.merchant_uid
   AND ingress.merchant_id=i.merchant_id AND ingress.payer_uid=s.payer_uid AND ingress.source_wallet=a.source_wallet
   AND q.binding->>'destinationWallet'=CASE WHEN a.operation_kind='settlement' THEN ingress.merchant_wallet ELSE ingress.payer_wallet END
   AND (p_subject IS NULL OR i.payment_id=p_subject) AND i.payment_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     AND i.created_at>'2026-11-04T10:28:42.166721Z'::timestamptz AND i.created_at<=statement_timestamp()
     AND encode(sha256(convert_to(i.payment_id,'UTF8')),'hex') NOT IN
     ('7cad03c1a69a025362c64bf87079ed7397fcb6bfdd42b22341aef24bdaeb81b2','ee15246aef237459dc61c9fbb495123d0a7dfccec0560c4087e62841c406d1be',
      'f8f2a12f2f46ace8844ba5f804b1ebcb35739bac4ab23b73425cc6814e259b7d','f0f9e1d0836977dcb258ef3d2f8e49e2e59de695b92c06e1a34c105e32383e88')
     AND i.customer_amount>0 AND i.customer_amount<=0.20 AND i.customer_amount*10000000=trunc(i.customer_amount*10000000)
     AND s.merchant_id=i.merchant_id AND s.merchant_uid=i.merchant_uid AND s.customer_amount=i.customer_amount
     AND s.merchant_amount=i.customer_amount AND s.app_commission=0 AND s.u2a_completed_at IS NOT NULL
     AND s.u2a_identifier=q.binding->>'piPaymentId' AND s.u2a_txid=q.binding->>'u2aTxid'
     AND (i.customer_amount*10000000)::bigint::text=q.binding->>'amountStroops'
     AND p.worker_profile->'recoveryPilot'->>'schema'='FLASHPAY_TESTNET_NEW_RIGHTS_V1'
     AND jsonb_typeof(p.worker_profile->'recoveryPilot'->'wallets')='array'
     AND (p.worker_profile->'recoveryPilot'->'wallets') @> jsonb_build_array(a.source_wallet,q.binding->>'destinationWallet')
     AND jsonb_typeof(p.worker_profile->'recoveryPilot'->'payerUids')='array'
     AND (p.worker_profile->'recoveryPilot'->'payerUids') @> jsonb_build_array(s.payer_uid)
     AND ((a.operation_kind='settlement' AND r.payment_id IS NULL AND s.stage IN ('prepared','horizon_confirmed','pi_completed')
       AND s.a2u_from_address=a.source_wallet AND s.a2u_to_address=q.binding->>'destinationWallet' AND s.a2u_payment_id=a.owner_operation_id
       AND s.prepared_tx_hash=a.prepared_tx_hash AND s.prepared_sequence::text=a.prepared_sequence
       AND encode(sha256(convert_to(s.prepared_envelope_xdr,'UTF8')),'hex')=q.binding->>'envelopeXdrTextSha256')
      OR (a.operation_kind='refund' AND s.stage='payment_identity' AND (r.status='pending' OR (r.status='completed' AND r.stage='audit_recorded'
       AND NOT EXISTS(SELECT 1 FROM public.refund_audit_events f WHERE f.refund_id=r.refund_id AND f.event_type='refund_projection_finalized')))
       AND (r.next_retry_at IS NULL OR r.next_retry_at AT TIME ZONE 'UTC' <= clock_timestamp()) AND r.amount=i.customer_amount
       AND r.payer_uid=s.payer_uid AND r.refund_id=a.owner_operation_id AND r.refund_payment_id=e.details->>'refundPaymentId'
       AND r.stage IN ('wallet_submission_started','wallet_submission_confirmed','payment_checkpoint_updated','accounting_recorded','audit_recorded')
       AND e.details->>'phase'='horizon_prepared' AND e.details->>'preparedHash'=a.prepared_tx_hash AND e.details->>'preparedSequence'=a.prepared_sequence
       AND encode(sha256(convert_to(e.details->>'envelopeXdr','UTF8')),'hex')=q.binding->>'envelopeXdrTextSha256'))
     AND (s.stage IN ('horizon_confirmed','pi_completed') AND s.a2u_txid=a.prepared_tx_hash
       OR r.refund_txid=a.prepared_tx_hash AND r.stage IN ('wallet_submission_confirmed','payment_checkpoint_updated','accounting_recorded','audit_recorded')
       OR (s.stage='prepared' OR r.stage='wallet_submission_started') AND NOT EXISTS
        (SELECT 1 FROM public.financial_wallet_submission_attempts t WHERE t.network=a.network
           AND (t.owner_payment_id=i.payment_id OR t.source_wallet=a.source_wallet AND (t.prepared_tx_hash=a.prepared_tx_hash OR t.prepared_sequence=a.prepared_sequence))
           AND (t.owner_payment_id,t.operation_kind,t.owner_operation_id,t.source_wallet,t.prepared_tx_hash,t.prepared_sequence) IS DISTINCT FROM
               (i.payment_id,a.operation_kind,a.owner_operation_id,a.source_wallet,a.prepared_tx_hash,a.prepared_sequence)))
     AND NOT EXISTS (SELECT 1 FROM public.settlement_checkpoints x WHERE x.a2u_from_address=a.source_wallet AND x.payment_id<>i.payment_id AND x.stage IN ('a2u_created','prepared','horizon_confirmed','pi_completed'))
     AND NOT EXISTS (SELECT 1 FROM public.refund_checkpoints x WHERE x.payment_id<>i.payment_id AND x.status IN ('pending','manual_review_required')
      AND public.r36_held_refund_outside_scope(a.source_wallet,x.payment_id,x.refund_id,p_policy) IS DISTINCT FROM true
       AND NOT EXISTS(SELECT 1 FROM public.financial_wallet_authorities z WHERE z.network=a.network AND z.operation_kind='refund'
         AND z.owner_payment_id=x.payment_id AND z.owner_operation_id=x.refund_id AND z.source_wallet<>a.source_wallet AND z.state='prepared'))
     AND p.enabled AND NOT p.revoked AND extract(epoch FROM clock_timestamp()) >= p.valid_from
     AND extract(epoch FROM clock_timestamp()) < least(p.valid_until,p.revocation_valid_until)
     AND NOT EXISTS(SELECT 1 FROM public.r36_certificate_revocations x WHERE x.payload_digest=c.payload_digest)

 -- A consumed INITIAL_PREPARED_ADMISSION certificate remains identity evidence,
 -- not permission to submit again. Only an already-confirmed refund is eligible.
 AND a.operation_kind='refund' AND s.stage='payment_identity'
 AND s.a2u_payment_id IS NULL AND s.a2u_txid IS NULL AND s.prepared_tx_hash IS NULL
 AND r.refund_txid=a.prepared_tx_hash AND r.payer_uid_verified_at IS NOT NULL AND r.currency='π'
 AND r.stage IN ('wallet_submission_confirmed','payment_checkpoint_updated','accounting_recorded','audit_recorded')
 AND NOT EXISTS(SELECT 1 FROM public.transactions x WHERE x.payment_id=s.u2a_identifier)
 AND NOT EXISTS(SELECT 1 FROM public.receipts x WHERE x.u2a_identifier=s.u2a_identifier)
 AND prior.payment_id=i.payment_id AND prior.nonce=q.nonce AND prior.payload_digest=c.payload_digest
 AND prior.amount_stroops=ingress.amount_stroops AND ingress.retired_by_payment_id IS NULL
 AND extract(epoch FROM attempt.attempted_at)>=c.issued_at
 AND extract(epoch FROM attempt.attempted_at)<c.expires_at
 AND c.verified_at<=attempt.attempted_at AND prior.reserved_at<=attempt.attempted_at
 AND p.revocation_checked_at>=c.issued_at AND p.revocation_checked_at<=extract(epoch FROM clock_timestamp())
 AND c.verified_by='r36_issuer'
 AND c.manifest=q.binding||jsonb_build_object('schema','R36_ADMISSION_CERTIFICATE_V1','purpose','INITIAL_PREPARED_ADMISSION',
  'issuerId',p.issuer_id,'keyId',p.key_id,'policyDigest',p.policy_digest,'issuedAt',c.issued_at::text,'expiresAt',c.expires_at::text)
 AND EXISTS(SELECT 1 FROM public.financial_wallet_activation g WHERE g.network=a.network
  AND g.source_wallet=a.source_wallet AND g.state='enabled' AND g.clearance_digest=q.binding->>'clearanceDigest')
 AND EXISTS(SELECT 1 FROM public.r36_independent_u2a_attestations t WHERE t.network=a.network
  AND t.source_wallet=a.source_wallet AND t.payment_id=i.payment_id AND t.operation_kind=a.operation_kind
  AND t.operation_id=a.owner_operation_id AND t.prepared_tx_hash=a.prepared_tx_hash
  AND t.prepared_sequence=a.prepared_sequence AND t.pi_payment_id=q.binding->>'piPaymentId'
  AND t.u2a_txid=q.binding->>'u2aTxid' AND t.proof_digest=c.payload_digest AND t.status='verified')
 ORDER BY prior.last_selected_at,i.created_at,i.payment_id LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('id',v.id,'kind',v.kind,'op',v.op,'wallet',v.wallet,'hash',v.hash,'seq',v.seq,'stage',v.stage,'spent',true);
END $function$;
ALTER FUNCTION public.r36_select_confirmed_refund_reconciliation(text,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_select_confirmed_refund_reconciliation(text,text) FROM PUBLIC,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
GRANT EXECUTE ON FUNCTION public.r36_select_confirmed_refund_reconciliation(text,text) TO r36_runtime;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM r36_owner;
REVOKE r36_owner FROM neondb_owner GRANTED BY neondb_owner;
COMMIT;
