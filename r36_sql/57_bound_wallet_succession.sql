-- Controlled inert rollout: exact production branch, restricted roles held NOLOGIN, no enrolled authority.
-- Adds a protected, exact successor binding to the existing prepared-authority path.
-- No enrollment, signing, activation, reservation release, resend or financial POST.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
SET LOCAL search_path=pg_catalog,pg_temp;
DO $$ BEGIN
 IF current_setting('flashpay.isolated_certificate_test',true) IS DISTINCT FROM 'yes' THEN
  IF current_database()<>'neondb' OR current_setting('neon.branch_id',true) IS DISTINCT FROM 'br-tiny-mode-aliatv40'
  OR session_user<>'neondb_owner' OR current_user<>session_user
  OR (SELECT count(*) FROM pg_roles WHERE rolname IN ('r36_runtime','r36_issuer','r36_signer') AND NOT rolcanlogin)<>3
  OR EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename IN ('r36_runtime','r36_issuer','r36_signer'))
  OR EXISTS(SELECT 1 FROM public.financial_wallet_activation)
  OR EXISTS(SELECT 1 FROM public.financial_wallet_authorities)
  OR EXISTS(SELECT 1 FROM public.r36_testnet_ingress_reservations)
  OR EXISTS(SELECT 1 FROM public.r36_certificate_policies)
  OR EXISTS(SELECT 1 FROM public.r36_certificate_receipts)
  OR EXISTS(SELECT 1 FROM r36_signing.requests)
  THEN RAISE EXCEPTION 'PRODUCTION_TARGET_OR_INERT_HOLD_NOT_PROVEN'; END IF;
 END IF;
 IF to_regprocedure('public.r36_certificate_allows(text,text,text,text,text,text,text)') IS NULL
 THEN RAISE EXCEPTION 'CERTIFICATE_ADMISSION_REQUIRED'; END IF;
END $$;

-- Enrollment is a distinct protected trust action. Runtime and issuer cannot invent it.
-- It names BOTH the independently certified prior closure and the exact successor
-- certificate. A prior-only signature must never authorize arbitrary next rights.
CREATE TABLE public.r36_wallet_successor_requests (
 approval_id text PRIMARY KEY REFERENCES public.r36_signed_approval_consumptions(approval_id),
 successor_nonce text NOT NULL UNIQUE REFERENCES public.r36_certificate_requests(nonce),
 prior_payload_digest text NOT NULL CHECK(prior_payload_digest ~ '^[0-9a-f]{64}$'),
 binding_digest text NOT NULL CHECK(binding_digest ~ '^[0-9a-f]{64}$'),
 consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.r36_wallet_successor_requests OWNER TO r36_owner;
REVOKE ALL ON public.r36_wallet_successor_requests FROM PUBLIC,r36_runtime,r36_issuer,r36_signer;

CREATE FUNCTION public.r36_claim_bound_successor(
 p_network text,p_wallet text,p_payment text,p_kind text,p_operation text,p_hash text,p_seq text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE old public.financial_wallet_authorities; seal public.financial_wallet_finality_seals;
 grant_row record; next_binding jsonb; now_at timestamptz; expected text;
BEGIN
 IF session_user<>'r36_runtime' OR current_setting('transaction_isolation')<>'read committed'
 OR p_network IS DISTINCT FROM 'Pi Testnet' OR p_seq IS NULL OR p_seq !~ '^[1-9][0-9]{0,29}$'
 OR public.r36_certificate_allows(p_network,p_wallet,p_payment,p_kind,p_operation,p_hash,p_seq) IS DISTINCT FROM true
 THEN RETURN false; END IF;
 SELECT * INTO old FROM public.financial_wallet_authorities
 WHERE network=p_network AND source_wallet=p_wallet FOR UPDATE;
 IF NOT FOUND OR old.state<>'prepared' THEN RETURN false; END IF;
 -- Another contender may have committed the exact same approved successor while
 -- this transaction waited. Treat that as identity replay, never rotate again.
 IF (old.owner_payment_id,old.operation_kind,old.owner_operation_id,old.prepared_tx_hash,old.prepared_sequence)
  =(p_payment,p_kind,p_operation,p_hash,p_seq) THEN RETURN true; END IF;
 IF old.owner_payment_id=p_payment
 OR old.prepared_tx_hash=p_hash OR p_seq::numeric<>old.prepared_sequence::numeric+1
 THEN RETURN false; END IF;
 -- Same payment lock as the accounting/XOR writers. Never resolve from Redis.
 PERFORM pg_advisory_xact_lock(hashtextextended(old.owner_payment_id,0));
 SELECT * INTO seal FROM public.financial_wallet_finality_seals
 WHERE network=p_network AND source_wallet=p_wallet AND prepared_tx_hash=old.prepared_tx_hash FOR SHARE;
 IF NOT FOUND OR (seal.owner_payment_id,seal.operation_kind,seal.owner_operation_id,seal.prepared_sequence)
 IS DISTINCT FROM (old.owner_payment_id,old.operation_kind,old.owner_operation_id,old.prepared_sequence)
 OR NOT EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts t
  WHERE (t.network,t.source_wallet,t.owner_payment_id,t.operation_kind,t.owner_operation_id,t.prepared_tx_hash,t.prepared_sequence)
   =(old.network,old.source_wallet,old.owner_payment_id,old.operation_kind,old.owner_operation_id,old.prepared_tx_hash,old.prepared_sequence))
 THEN RETURN false; END IF;
 -- Require the original terminal checkpoint AND its durable accounting evidence.
 IF old.operation_kind='settlement' THEN
  IF NOT EXISTS(SELECT 1 FROM public.settlement_checkpoints s
    JOIN public.transactions t ON t.payment_id=s.u2a_identifier
    JOIN public.receipts r ON r.transaction_id=t.id
    WHERE s.payment_id=old.owner_payment_id AND s.stage='db_finalized'
    AND s.pi_completed_at IS NOT NULL AND s.db_finalized_at IS NOT NULL AND s.horizon_confirmed_at IS NOT NULL
    AND s.a2u_from_address=p_wallet AND s.a2u_payment_id=old.owner_operation_id
    AND s.a2u_txid=old.prepared_tx_hash AND s.prepared_tx_hash=old.prepared_tx_hash
    AND s.prepared_sequence=old.prepared_sequence::numeric AND s.horizon_fee_stroops=seal.horizon_fee_stroops::bigint
    AND s.merchant_amount=s.customer_amount AND s.app_commission=0
    AND t.merchant_id=s.merchant_id AND t.merchant_uid=s.merchant_uid AND t.status='completed' AND t.currency='π'
    AND t.amount=s.customer_amount AND r.merchant_id=s.merchant_id AND r.merchant_uid=s.merchant_uid
    AND r.currency='π' AND r.amount=s.customer_amount AND r.customer_amount=s.customer_amount
    AND r.merchant_amount=s.customer_amount AND r.app_commission=0 AND r.txid=s.a2u_txid
    AND r.u2a_identifier=s.u2a_identifier AND r.u2a_txid=s.u2a_txid
    AND r.a2u_identifier=s.a2u_payment_id AND r.a2u_txid=s.a2u_txid
    AND r.horizon_fee_charged*10000000=s.horizon_fee_stroops AND r.app_net_impact=-r.horizon_fee_charged
    AND r.settlement_status='settled_to_merchant')
   OR EXISTS(SELECT 1 FROM public.refund_checkpoints WHERE payment_id=old.owner_payment_id)
  THEN RETURN false; END IF;
 ELSE
  -- Terminal refund's original audit/accounting identity must agree. No cancelled
  -- or manual-review state is promoted to terminal by this transition.
  IF NOT EXISTS(SELECT 1 FROM public.refund_checkpoints r
    JOIN public.refund_accounting_records a ON a.refund_id=r.refund_id AND a.payment_id=r.payment_id
    JOIN public.refund_audit_events e ON e.refund_id=r.refund_id AND e.payment_id=r.payment_id
    WHERE r.payment_id=old.owner_payment_id AND r.refund_id=old.owner_operation_id
    AND r.status='completed' AND r.stage='audit_recorded' AND r.refund_txid=old.prepared_tx_hash
    AND a.refund_txid=r.refund_txid AND a.refund_payment_id=r.refund_payment_id AND a.amount=r.amount
    AND a.payer_uid=r.payer_uid AND a.currency='π' AND a.horizon_fee_stroops=seal.horizon_fee_stroops::bigint
    AND e.event_type='refund_projection_finalized' AND e.actor_type='system'
    AND e.event_id='refund:'||r.refund_id||':projection_finalized' AND e.idempotency_key=r.idempotency_key
    AND (SELECT count(*) FROM public.refund_audit_events z WHERE z.refund_id=r.refund_id AND z.event_type='refund_projection_finalized')=1
    AND (e.details=jsonb_build_object('refundPaymentId',r.refund_payment_id,'refundTxid',r.refund_txid)
      OR (jsonb_typeof(e.details)='string' AND (e.details #>> '{}')=concat('{"refundPaymentId":',to_json(r.refund_payment_id)::text,',"refundTxid":',to_json(r.refund_txid)::text,'}'))))
   OR EXISTS(SELECT 1 FROM public.settlement_checkpoints s WHERE s.payment_id=old.owner_payment_id AND s.stage<>'payment_identity')
   OR EXISTS(SELECT 1 FROM public.transactions t JOIN public.settlement_checkpoints s ON t.payment_id=s.u2a_identifier WHERE s.payment_id=old.owner_payment_id)
  THEN RETURN false; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts t WHERE t.network=p_network AND t.source_wallet=p_wallet
    AND (t.prepared_tx_hash=p_hash OR t.prepared_sequence=p_seq OR t.owner_payment_id=p_payment))
 OR EXISTS(SELECT 1 FROM public.financial_wallet_authority_history h WHERE h.network=p_network AND h.source_wallet=p_wallet
    AND (h.prepared_tx_hash=p_hash OR h.prepared_sequence=p_seq OR h.owner_payment_id=p_payment)) THEN RETURN false; END IF;
 SELECT q.binding INTO next_binding FROM public.r36_certificate_requests q
 JOIN public.r36_certificate_receipts c ON c.nonce=q.nonce
 WHERE (q.binding->>'network',q.binding->>'sourceWallet',q.binding->>'paymentId',q.binding->>'operationKind',
  q.binding->>'operationId',q.binding->>'preparedHash',q.binding->>'preparedSequence')
 =(p_network,p_wallet,p_payment,p_kind,p_operation,p_hash,p_seq);
 IF next_binding IS NULL THEN RETURN false; END IF;
 -- Ordered tuple has no ambiguous concatenation. This digest must be independently
 -- enrolled and included in the prior signed approval's bindingDigest.
 expected:=encode(sha256(convert_to(jsonb_build_array('R36_BOUND_SUCCESSOR_V1',p_network,p_wallet,
  old.owner_payment_id,old.operation_kind,old.owner_operation_id,old.prepared_tx_hash,old.prepared_sequence,
  p_payment,p_kind,p_operation,p_hash,p_seq,next_binding->>'nonce')::text,'UTF8')),'hex');
 SELECT b.approval_id,b.consumed_at,b.prior_payload_digest,s.payload_digest,s.expires_at,
  s.independently_certified_at,s.consumed_at AS signed_consumed,o.consumed_at AS operator_consumed
 INTO grant_row FROM public.r36_wallet_successor_requests b
 JOIN public.r36_signed_approval_consumptions s ON s.approval_id=b.approval_id
 JOIN public.financial_wallet_rotation_approvals o ON o.approval_id=s.approval_id
 JOIN public.r36_rotation_approval_evidence e ON e.network=o.network AND e.source_wallet=o.source_wallet AND e.prior_prepared_hash=o.prior_prepared_hash
 WHERE b.successor_nonce=next_binding->>'nonce' AND b.binding_digest=expected AND s.binding_digest=expected
 AND (s.network,s.wallet,s.prior_payment,s.kind,s.prior_operation,s.prior_hash,s.prior_sequence)
 =(old.network,old.source_wallet,old.owner_payment_id,old.operation_kind,old.owner_operation_id,old.prepared_tx_hash,old.prepared_sequence::numeric)
 AND (o.network,o.source_wallet,o.prior_prepared_hash,o.evidence_digest)=(p_network,p_wallet,old.prepared_tx_hash,seal.evidence_digest)
 AND s.evidence_digest=seal.evidence_digest AND e.seal_evidence_digest=seal.evidence_digest
 AND e.horizon_result_verified AND e.historical_wallet_reconciled AND e.accounting_finality_verified
 FOR UPDATE OF b,s,o FOR SHARE OF e;
 now_at:=clock_timestamp();
 IF NOT FOUND OR grant_row.prior_payload_digest<>grant_row.payload_digest OR grant_row.consumed_at IS NOT NULL
 OR grant_row.signed_consumed IS NOT NULL OR grant_row.operator_consumed IS NOT NULL
 OR grant_row.expires_at<=now_at OR grant_row.independently_certified_at>now_at
 OR grant_row.independently_certified_at<seal.sealed_at THEN RETURN false; END IF;
 -- Recheck original wallet-wide liability guards; no old-right whitelist.
 IF EXISTS(SELECT 1 FROM public.settlement_checkpoints s WHERE s.a2u_from_address=p_wallet AND s.payment_id<>p_payment
     AND s.stage IN ('a2u_created','prepared','horizon_confirmed','pi_completed'))
 OR EXISTS(SELECT 1 FROM public.refund_checkpoints r WHERE r.payment_id<>p_payment AND r.status IN ('pending','manual_review_required')
   AND NOT EXISTS(SELECT 1 FROM public.financial_wallet_authorities a WHERE a.network=p_network AND a.operation_kind='refund'
     AND a.owner_payment_id=r.payment_id AND a.owner_operation_id=r.refund_id AND a.source_wallet<>p_wallet AND a.state='prepared'))
 THEN RETURN false; END IF;
 -- The old wallet lock can wait beyond the successor certificate deadline.
 -- Recheck the independently enrolled policy/receipt AFTER all waiting, using
 -- the database clock, before changing either authority or approval consumption.
 IF public.r36_certificate_allows(p_network,p_wallet,p_payment,p_kind,p_operation,p_hash,p_seq) IS DISTINCT FROM true
 OR grant_row.expires_at<=clock_timestamp() THEN RETURN false; END IF;
 INSERT INTO public.financial_wallet_authority_history(network,source_wallet,owner_payment_id,operation_kind,owner_operation_id,prepared_tx_hash,prepared_sequence,finality_evidence_digest)
 VALUES(old.network,old.source_wallet,old.owner_payment_id,old.operation_kind,old.owner_operation_id,old.prepared_tx_hash,old.prepared_sequence,seal.evidence_digest);
 UPDATE public.r36_signed_approval_consumptions SET consumed_at=now_at WHERE approval_id=grant_row.approval_id;
 UPDATE public.financial_wallet_rotation_approvals SET consumed_at=now_at WHERE approval_id=grant_row.approval_id;
 UPDATE public.r36_wallet_successor_requests SET consumed_at=now_at WHERE approval_id=grant_row.approval_id;
 UPDATE public.financial_wallet_authorities SET owner_payment_id=p_payment,operation_kind=p_kind,owner_operation_id=p_operation,
  prepared_tx_hash=p_hash,prepared_sequence=p_seq,updated_at=now_at WHERE network=p_network AND source_wallet=p_wallet;
 RETURN true;
END $$;
ALTER FUNCTION public.r36_claim_bound_successor(text,text,text,text,text,text,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_claim_bound_successor(text,text,text,text,text,text,text) FROM PUBLIC,r36_runtime,r36_issuer,r36_signer;
GRANT SELECT ON public.transactions,public.receipts,public.refund_accounting_records,public.refund_audit_events TO r36_owner;

-- Install at the original claim boundary, AFTER its certificate, activation and
-- unresolved-liability checks. No public fallback or privileged runtime alias.
DO $$ DECLARE body text; marker text := ' INSERT INTO public.financial_wallet_authorities'; BEGIN
 SELECT prosrc INTO body FROM pg_proc WHERE oid='public.r36_claim_prepared_authority(text,text,text,text,text,text,text)'::regprocedure;
 IF encode(sha256(convert_to(body,'UTF8')),'hex') IS DISTINCT FROM '093f6829336865503ce8c9efd8fd74a2481aa484db038a0fdd83697d0febfac0'
 OR position(marker IN body)=0 OR position('r36_claim_bound_successor' IN body)>0 THEN RAISE EXCEPTION 'UNEXPECTED_CLAIM_BODY'; END IF;
 body:=replace(body,marker,E' IF EXISTS(SELECT 1 FROM public.financial_wallet_authorities WHERE network=p_network AND source_wallet=p_wallet\n    AND (owner_payment_id,operation_kind,owner_operation_id,prepared_tx_hash,prepared_sequence)\n      IS DISTINCT FROM (p_payment,p_kind,p_operation,p_hash,p_seq)) THEN\n  IF public.r36_claim_bound_successor(p_network,p_wallet,p_payment,p_kind,p_operation,p_hash,p_seq) IS DISTINCT FROM true THEN RETURN false; END IF;\n END IF;\n'||marker);
 EXECUTE 'CREATE OR REPLACE FUNCTION public.r36_claim_prepared_authority(p_network text,p_wallet text,p_payment text,p_kind text,p_operation text,p_hash text,p_seq text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS '||quote_literal(body);
END $$;
COMMIT;
