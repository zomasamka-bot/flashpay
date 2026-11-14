-- Recover certificate expiry before successor ownership, without creating a
-- wallet approval or permitting a submission. The original nonce, XDR, payment,
-- attestation and unspent checks remain mandatory. Fresh evidence is still
-- reviewed and signed by the original registrar/issuer renewal path; Runtime
-- still needs an independently verified, current prior closure and bound grant.
CREATE OR REPLACE FUNCTION public.r36_unspent_successor(p_nonce text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE b jsonb; original text; policy_id text; a public.financial_wallet_authorities;
 s public.settlement_checkpoints; r public.refund_checkpoints;
 l public.r36_lifecycle_approval_links; candidate jsonb; g public.financial_wallet_activation;
BEGIN
 IF session_user NOT IN ('r36_registrar','r36_issuer') THEN RETURN false; END IF;
 SELECT q.binding,c.payload_digest,q.policy_digest INTO b,original,policy_id
 FROM public.r36_certificate_requests q JOIN public.r36_certificate_receipts c USING(nonce)
 WHERE q.nonce=p_nonce FOR UPDATE OF q;
 IF NOT FOUND OR b->>'network' IS DISTINCT FROM public.r36_network()
 OR b->>'operationKind' NOT IN ('settlement','refund')
 OR EXISTS(SELECT 1 FROM public.r36_certificate_revocations WHERE payload_digest=original)
 OR EXISTS(SELECT 1 FROM public.r36_legacy_right_holds h WHERE
  b->>'paymentId'=ANY(h.identity_values) OR b->>'operationId'=ANY(h.identity_values)
  OR b->>'preparedHash'=ANY(h.identity_values)) THEN RETURN false; END IF;
 SELECT * INTO g FROM public.financial_wallet_activation
 WHERE network=b->>'network' AND source_wallet=b->>'sourceWallet' FOR UPDATE;
 IF NOT FOUND OR g.state<>'enabled' THEN RETURN false; END IF;
 SELECT * INTO a FROM public.financial_wallet_authorities
 WHERE network=g.network AND source_wallet=g.source_wallet FOR UPDATE;
 IF NOT FOUND OR a.state<>'prepared' OR a.owner_payment_id=b->>'paymentId'
 OR a.prepared_sequence::numeric+1<>(b->>'preparedSequence')::numeric
 OR NOT EXISTS(SELECT 1 FROM public.financial_wallet_finality_seals f WHERE
  (f.network,f.source_wallet,f.owner_payment_id,f.operation_kind,f.owner_operation_id,f.prepared_tx_hash,f.prepared_sequence)
  =(a.network,a.source_wallet,a.owner_payment_id,a.operation_kind,a.owner_operation_id,a.prepared_tx_hash,a.prepared_sequence))
 THEN RETURN false; END IF;
 SELECT * INTO l FROM public.r36_lifecycle_approval_links WHERE successor_nonce=p_nonce FOR SHARE;
 IF FOUND THEN
  -- Already bound: retain the exact original unconsumed approval and clearance.
  IF l.next_clearance_digest IS DISTINCT FROM b->>'clearanceDigest'
  OR g.clearance_digest IS DISTINCT FROM b->>'clearanceDigest'
  OR NOT EXISTS(SELECT 1 FROM public.r36_wallet_successor_requests x
   JOIN public.r36_signed_approval_consumptions v USING(approval_id)
   JOIN public.financial_wallet_rotation_approvals o USING(approval_id)
   JOIN public.r36_prior_closure_receipts c ON c.payload_digest=l.closure_digest
   WHERE x.approval_id=l.approval_id AND x.successor_nonce=p_nonce
   AND x.consumed_at IS NULL AND v.consumed_at IS NULL AND o.consumed_at IS NULL
   AND NOT c.revoked AND c.prior_payment=a.owner_payment_id AND c.prior_hash=a.prepared_tx_hash
   AND (v.network,v.wallet,v.prior_payment,v.kind,v.prior_operation,v.prior_hash,v.prior_sequence)
    =(a.network,a.source_wallet,a.owner_payment_id,a.operation_kind,a.owner_operation_id,a.prepared_tx_hash,a.prepared_sequence::numeric))
  THEN RETURN false; END IF;
 ELSE
  -- Not bound: only renew evidence for the same unspent next identity. The
  -- current clearance must still belong to the sealed prior owner; no transfer.
  IF EXISTS(SELECT 1 FROM public.r36_wallet_successor_requests WHERE successor_nonce=p_nonce)
  OR NOT EXISTS(SELECT 1 FROM public.r36_certificate_requests q
   JOIN public.r36_certificate_receipts c USING(nonce)
   WHERE q.policy_digest=policy_id AND q.binding->>'clearanceDigest'=g.clearance_digest
   AND (q.binding->>'network',q.binding->>'sourceWallet',q.binding->>'paymentId',q.binding->>'operationKind',
        q.binding->>'operationId',q.binding->>'preparedHash',q.binding->>'preparedSequence')
    =(a.network,a.source_wallet,a.owner_payment_id,a.operation_kind,a.owner_operation_id,a.prepared_tx_hash,a.prepared_sequence)
   AND NOT EXISTS(SELECT 1 FROM public.r36_certificate_revocations v WHERE v.payload_digest=c.payload_digest))
  THEN RETURN false; END IF;
 END IF;
 SELECT * INTO s FROM public.settlement_checkpoints WHERE payment_id=b->>'paymentId' FOR SHARE;
 IF NOT FOUND OR s.u2a_identifier IS DISTINCT FROM b->>'piPaymentId' OR s.u2a_txid IS DISTINCT FROM b->>'u2aTxid'
 OR s.u2a_verified_at IS NULL OR s.u2a_completed_at IS NULL OR NOT public.r36_contract_valid(to_jsonb(s))
 OR public.r36_contract_outgoing_stroops(s.payment_id,b->>'operationKind') IS DISTINCT FROM b->>'amountStroops'
 OR s.a2u_txid IS NOT NULL OR s.horizon_confirmed_at IS NOT NULL OR s.pi_completed_at IS NOT NULL
 OR s.db_finalized_at IS NOT NULL THEN RETURN false; END IF;
 SELECT c.candidate INTO candidate FROM public.r36_prepared_evidence_candidates c
 WHERE c.payment_id=s.payment_id AND c.network=a.network AND c.source_wallet=a.source_wallet
 AND c.prepared_sequence=b->>'preparedSequence';
 IF NOT FOUND OR candidate->>'preparedHash' IS DISTINCT FROM b->>'preparedHash'
 OR candidate->>'signedEnvelopeSha256' IS DISTINCT FROM b->>'envelopeXdrTextSha256'
 OR candidate->'identity'->>'paymentId' IS DISTINCT FROM b->>'paymentId'
 OR candidate->'identity'->>'operationKind' IS DISTINCT FROM b->>'operationKind'
 OR candidate->'identity'->>'operationId' IS DISTINCT FROM b->>'operationId'
 OR candidate->'identity'->>'destinationWallet' IS DISTINCT FROM b->>'destinationWallet'
 OR candidate->'identity'->>'amountStroops' IS DISTINCT FROM b->>'amountStroops' THEN RETURN false; END IF;
 IF b->>'operationKind'='settlement' THEN
  IF s.stage<>'a2u_created' OR s.a2u_payment_id IS DISTINCT FROM b->>'operationId'
  OR s.a2u_from_address IS DISTINCT FROM b->>'sourceWallet' OR s.a2u_to_address IS DISTINCT FROM b->>'destinationWallet'
  OR s.prepared_tx_hash IS NOT NULL OR s.prepared_sequence IS NOT NULL OR s.prepared_envelope_xdr IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.refund_checkpoints WHERE payment_id=s.payment_id) THEN RETURN false; END IF;
 ELSE
  SELECT * INTO r FROM public.refund_checkpoints WHERE payment_id=s.payment_id AND refund_id=b->>'operationId';
  IF NOT FOUND OR s.stage<>'payment_identity' OR r.status<>'pending' OR r.stage<>'wallet_submission_started'
  OR r.refund_txid IS NOT NULL OR r.amount<>s.customer_amount OR r.payer_uid IS DISTINCT FROM s.payer_uid
  OR candidate->'identity'->>'piPaymentId' IS DISTINCT FROM r.refund_payment_id
  OR NOT EXISTS(SELECT 1 FROM public.refund_audit_events e WHERE e.payment_id=s.payment_id AND e.refund_id=r.refund_id
   AND e.event_id='refund:'||r.refund_id||':blockchain_submission_started'
   AND e.event_type='refund_blockchain_submission_started' AND e.actor_type='system' AND e.idempotency_key=r.idempotency_key
   AND e.details=jsonb_build_object('refundPaymentId',r.refund_payment_id,'phase','blockchain_submission'))
  -- The prepared audit is committed only with the successor wallet claim. A
  -- different current owner plus such an audit is a conflict, not renewable.
  OR EXISTS(SELECT 1 FROM public.refund_audit_events e WHERE e.payment_id=s.payment_id
   AND e.event_type='refund_blockchain_submit_prepared')
  THEN RETURN false; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts WHERE network=a.network AND
  (owner_payment_id=s.payment_id OR source_wallet=a.source_wallet AND (prepared_tx_hash=b->>'preparedHash' OR prepared_sequence=b->>'preparedSequence')))
 OR EXISTS(SELECT 1 FROM public.financial_wallet_authority_history WHERE network=a.network AND source_wallet=a.source_wallet
  AND (owner_payment_id=s.payment_id OR prepared_tx_hash=b->>'preparedHash' OR prepared_sequence=b->>'preparedSequence'))
 OR EXISTS(SELECT 1 FROM public.financial_wallet_finality_seals WHERE network=a.network AND owner_payment_id=s.payment_id)
 OR EXISTS(SELECT 1 FROM public.refund_accounting_records WHERE payment_id=s.payment_id)
 OR EXISTS(SELECT 1 FROM public.transactions WHERE payment_id=s.u2a_identifier)
 OR EXISTS(SELECT 1 FROM public.receipts WHERE u2a_identifier=s.u2a_identifier) THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM public.r36_independent_u2a_attestations t WHERE t.network=a.network AND t.source_wallet=a.source_wallet
  AND t.payment_id=s.payment_id AND t.operation_kind=b->>'operationKind' AND t.operation_id=b->>'operationId'
  AND t.prepared_tx_hash=b->>'preparedHash' AND t.prepared_sequence=b->>'preparedSequence'
  AND t.pi_payment_id=s.u2a_identifier AND t.u2a_txid=s.u2a_txid AND t.proof_digest=original AND t.status='verified');
END $$;
ALTER FUNCTION public.r36_unspent_successor(text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_unspent_successor(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.r36_renewal_unspent(p_nonce text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE b jsonb; original text; a public.financial_wallet_authorities; g public.financial_wallet_activation; s public.settlement_checkpoints; r public.refund_checkpoints;
BEGIN
 IF session_user NOT IN ('r36_registrar','r36_issuer') THEN RETURN false; END IF;
 SELECT q.binding,c.payload_digest INTO b,original FROM public.r36_certificate_requests q JOIN public.r36_certificate_receipts c USING(nonce)
 WHERE q.nonce=p_nonce FOR UPDATE OF q;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.r36_certificate_revocations WHERE payload_digest=original) THEN RETURN false; END IF;
 SELECT * INTO g FROM public.financial_wallet_activation WHERE network=b->>'network' AND source_wallet=b->>'sourceWallet' FOR UPDATE;
 IF NOT FOUND OR g.state<>'enabled' THEN RETURN false; END IF;
 SELECT * INTO a FROM public.financial_wallet_authorities WHERE network=g.network AND source_wallet=g.source_wallet FOR UPDATE;
 IF FOUND AND a.owner_payment_id IS DISTINCT FROM b->>'paymentId' THEN RETURN public.r36_unspent_successor(p_nonce); END IF;
 IF g.clearance_digest IS DISTINCT FROM b->>'clearanceDigest' THEN RETURN false; END IF;
 IF NOT FOUND OR a.state<>'prepared' OR (a.owner_payment_id,a.operation_kind,a.owner_operation_id,a.prepared_tx_hash,a.prepared_sequence)
 IS DISTINCT FROM (b->>'paymentId',b->>'operationKind',b->>'operationId',b->>'preparedHash',b->>'preparedSequence') THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts t WHERE t.network=a.network AND
  (t.owner_payment_id=a.owner_payment_id OR t.source_wallet=a.source_wallet AND (t.prepared_tx_hash=a.prepared_tx_hash OR t.prepared_sequence=a.prepared_sequence)))
 OR EXISTS(SELECT 1 FROM public.financial_wallet_finality_seals t WHERE t.network=a.network AND t.owner_payment_id=a.owner_payment_id)
 THEN RETURN false; END IF;
 SELECT * INTO s FROM public.settlement_checkpoints WHERE payment_id=a.owner_payment_id;
 IF NOT FOUND OR s.u2a_identifier IS DISTINCT FROM b->>'piPaymentId' OR s.u2a_txid IS DISTINCT FROM b->>'u2aTxid'
 OR s.u2a_verified_at IS NULL OR s.u2a_completed_at IS NULL OR public.r36_contract_outgoing_stroops(s.payment_id,b->>'operationKind') IS DISTINCT FROM b->>'amountStroops'
 OR NOT public.r36_contract_valid(to_jsonb(s)) OR s.a2u_txid IS NOT NULL OR s.horizon_confirmed_at IS NOT NULL
 OR s.pi_completed_at IS NOT NULL OR s.db_finalized_at IS NOT NULL THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.transactions WHERE payment_id=s.u2a_identifier)
 OR EXISTS(SELECT 1 FROM public.receipts WHERE u2a_identifier=s.u2a_identifier)
 OR EXISTS(SELECT 1 FROM public.refund_accounting_records WHERE payment_id=a.owner_payment_id) THEN RETURN false; END IF;
 IF a.operation_kind='settlement' THEN
  IF s.stage<>'prepared' OR s.a2u_payment_id IS DISTINCT FROM a.owner_operation_id OR s.a2u_from_address IS DISTINCT FROM a.source_wallet
  OR s.a2u_to_address IS DISTINCT FROM b->>'destinationWallet' OR s.prepared_tx_hash IS DISTINCT FROM a.prepared_tx_hash
  OR s.prepared_sequence::text IS DISTINCT FROM a.prepared_sequence
  OR encode(sha256(convert_to(s.prepared_envelope_xdr,'UTF8')),'hex') IS DISTINCT FROM b->>'envelopeXdrTextSha256'
  OR EXISTS(SELECT 1 FROM public.refund_checkpoints WHERE payment_id=s.payment_id) THEN RETURN false; END IF;
 ELSIF a.operation_kind='refund' THEN
  SELECT * INTO r FROM public.refund_checkpoints WHERE payment_id=s.payment_id AND refund_id=a.owner_operation_id;
  IF NOT FOUND OR s.stage<>'payment_identity' OR r.status<>'pending' OR r.stage<>'wallet_submission_started'
  OR r.refund_txid IS NOT NULL OR r.amount<>s.customer_amount OR r.payer_uid IS DISTINCT FROM s.payer_uid
  OR NOT EXISTS(SELECT 1 FROM public.refund_audit_events e WHERE e.payment_id=s.payment_id AND e.refund_id=r.refund_id
   AND e.event_type='refund_blockchain_submit_prepared' AND e.actor_type='system' AND e.idempotency_key=r.idempotency_key
   AND e.details->>'preparedHash'=a.prepared_tx_hash AND e.details->>'preparedSequence'=a.prepared_sequence
   AND e.details->>'refundPaymentId'=r.refund_payment_id
   AND encode(sha256(convert_to(e.details->>'envelopeXdr','UTF8')),'hex')=b->>'envelopeXdrTextSha256') THEN RETURN false; END IF;
 ELSE RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM public.r36_independent_u2a_attestations t WHERE t.network=a.network AND t.source_wallet=a.source_wallet
  AND t.payment_id=s.payment_id AND t.operation_kind=a.operation_kind AND t.operation_id=a.owner_operation_id
  AND t.prepared_tx_hash=a.prepared_tx_hash AND t.prepared_sequence=a.prepared_sequence AND t.proof_digest=original AND t.status='verified');
END $$;
ALTER FUNCTION public.r36_renewal_unspent(text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_renewal_unspent(text) FROM PUBLIC;
