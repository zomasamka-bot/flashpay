-- Candidate: fresh evidence for an exact, previously approved but unconsumed successor.
-- No deletion, attempt reset, financial row rewrite, new Runtime privilege or expiry edit.
BEGIN;
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='60s';
DO $$ BEGIN
 IF current_setting('flashpay.isolated_certificate_test',true) IS DISTINCT FROM 'yes' AND
 (session_user<>'neondb_owner' OR current_database()<>'neondb' OR current_setting('neon.branch_id',true) IS DISTINCT FROM 'br-tiny-mode-aliatv40') THEN RAISE EXCEPTION 'SUCCESSOR_RENEWAL_TARGET'; END IF;
 IF to_regclass('public.r36_bound_renewal_receipts') IS NOT NULL THEN RAISE EXCEPTION 'SUCCESSOR_RENEWAL_ALREADY_INSTALLED'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.r36_bound_lifecycle_context(text,text)'::regprocedure) IS DISTINCT FROM 'b421d11cb8abf933c6be9aacaba9f3d18183da2eaf266d383199f33ae60596e2' THEN RAISE EXCEPTION 'SUCCESSOR_BASELINE_CHANGED'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.r36_claim_bound_successor(text,text,text,text,text,text,text)'::regprocedure) IS DISTINCT FROM 'f2cb2d2516fe3b5be63749eeef24f399e6a6d488caf410fc02852361e23ae615' THEN RAISE EXCEPTION 'SUCCESSOR_BASELINE_CHANGED'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.r36_record_bound_lifecycle(text,text,text,text,bigint,bigint)'::regprocedure) IS DISTINCT FROM '197d5aa01823fdbf29b89d60ca5bd00a3d265b15c09203b1579f656fec0bf62f' THEN RAISE EXCEPTION 'SUCCESSOR_BASELINE_CHANGED'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.r36_register_successor_binding(text)'::regprocedure) IS DISTINCT FROM '837aa79350230173628f7fa517f9196000761ab745470e9e82398d7cabcc4b93' THEN RAISE EXCEPTION 'SUCCESSOR_BASELINE_CHANGED'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.r36_renewal_issuer_state(text)'::regprocedure) IS DISTINCT FROM '70d471b44a1bc3480f05595cdacb9ff318f197dd72e3c2e642a61da497fd1e79' THEN RAISE EXCEPTION 'SUCCESSOR_BASELINE_CHANGED'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.r36_renewal_unspent(text)'::regprocedure) IS DISTINCT FROM '3cf887be48738f143dbd082a5f010dd4ee36680f89782efc6d1fd4f720942547' THEN RAISE EXCEPTION 'SUCCESSOR_BASELINE_CHANGED'; END IF;
END $$;
DO $$ BEGIN IF session_user='neondb_owner' THEN GRANT r36_owner TO neondb_owner WITH INHERIT FALSE,SET TRUE; END IF; END $$;
GRANT CREATE ON SCHEMA public TO r36_owner;
SET LOCAL ROLE r36_owner;
CREATE TABLE public.r36_bound_renewal_receipts(
 payload_digest text PRIMARY KEY CHECK(payload_digest ~ '^[0-9a-f]{64}$'),
 approval_id text NOT NULL REFERENCES public.r36_lifecycle_approval_links(approval_id),
 closure_digest text NOT NULL REFERENCES public.r36_prior_closure_receipts(payload_digest),
 successor_nonce text NOT NULL REFERENCES public.r36_certificate_requests(nonce),
 evidence_text text NOT NULL,issued_at bigint NOT NULL,expires_at bigint NOT NULL CHECK(expires_at>issued_at),
 verified_by text NOT NULL CHECK(verified_by='r36_issuer'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON public.r36_bound_renewal_receipts FOR EACH ROW EXECUTE FUNCTION public.r36_execution_scope_immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON public.r36_bound_renewal_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.r36_execution_scope_immutable();
REVOKE ALL ON public.r36_bound_renewal_receipts FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;

CREATE FUNCTION public.r36_unspent_successor(p_nonce text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE b jsonb; original text; a public.financial_wallet_authorities; s public.settlement_checkpoints; l public.r36_lifecycle_approval_links; candidate jsonb;
BEGIN
 IF session_user NOT IN ('r36_registrar','r36_issuer') THEN RETURN false; END IF;
 SELECT q.binding,c.payload_digest INTO b,original FROM public.r36_certificate_requests q JOIN public.r36_certificate_receipts c USING(nonce) WHERE q.nonce=p_nonce FOR UPDATE OF q;
 IF NOT FOUND OR b->>'network'<>'Pi Testnet' OR b->>'operationKind'<>'settlement'
 OR EXISTS(SELECT 1 FROM public.r36_certificate_revocations WHERE payload_digest=original) THEN RETURN false; END IF;
 SELECT * INTO a FROM public.financial_wallet_authorities WHERE network=b->>'network' AND source_wallet=b->>'sourceWallet' FOR UPDATE;
 IF NOT FOUND OR a.state<>'prepared' OR a.owner_payment_id=b->>'paymentId' OR a.prepared_sequence::numeric+1<>(b->>'preparedSequence')::numeric THEN RETURN false; END IF;
 SELECT * INTO l FROM public.r36_lifecycle_approval_links WHERE successor_nonce=p_nonce FOR SHARE;
 IF NOT FOUND OR l.next_clearance_digest IS DISTINCT FROM b->>'clearanceDigest' OR NOT EXISTS(
 SELECT 1 FROM public.r36_wallet_successor_requests x JOIN public.r36_signed_approval_consumptions v USING(approval_id)
 JOIN public.financial_wallet_rotation_approvals o USING(approval_id)
 JOIN public.r36_prior_closure_receipts c ON c.payload_digest=l.closure_digest
 WHERE x.approval_id=l.approval_id AND x.successor_nonce=p_nonce AND x.consumed_at IS NULL AND v.consumed_at IS NULL AND o.consumed_at IS NULL
 AND NOT c.revoked AND c.prior_payment=a.owner_payment_id AND c.prior_hash=a.prepared_tx_hash
 AND (v.network,v.wallet,v.prior_payment,v.kind,v.prior_operation,v.prior_hash,v.prior_sequence)
 =(a.network,a.source_wallet,a.owner_payment_id,a.operation_kind,a.owner_operation_id,a.prepared_tx_hash,a.prepared_sequence::numeric)) THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.financial_wallet_activation WHERE network=a.network AND source_wallet=a.source_wallet AND state='enabled' AND clearance_digest=b->>'clearanceDigest') THEN RETURN false; END IF;
 SELECT * INTO s FROM public.settlement_checkpoints WHERE payment_id=b->>'paymentId' FOR SHARE;
 IF NOT FOUND OR s.stage<>'a2u_created' OR s.u2a_identifier IS DISTINCT FROM b->>'piPaymentId' OR s.u2a_txid IS DISTINCT FROM b->>'u2aTxid'
 OR s.u2a_verified_at IS NULL OR s.u2a_completed_at IS NULL OR s.customer_amount*10000000<>(b->>'amountStroops')::numeric
 OR s.merchant_amount<>s.customer_amount OR s.app_commission<>0 OR s.a2u_payment_id IS DISTINCT FROM b->>'operationId'
 OR s.a2u_to_address IS DISTINCT FROM b->>'destinationWallet' OR s.prepared_tx_hash IS NOT NULL OR s.prepared_sequence IS NOT NULL OR s.prepared_envelope_xdr IS NOT NULL
 OR s.a2u_txid IS NOT NULL OR s.horizon_confirmed_at IS NOT NULL OR s.pi_completed_at IS NOT NULL OR s.db_finalized_at IS NOT NULL THEN RETURN false; END IF;
 SELECT c.candidate INTO candidate FROM public.r36_prepared_evidence_candidates c WHERE c.payment_id=s.payment_id AND c.network=a.network AND c.source_wallet=a.source_wallet AND c.prepared_sequence=b->>'preparedSequence';
 IF NOT FOUND OR candidate->>'preparedHash' IS DISTINCT FROM b->>'preparedHash' OR candidate->>'signedEnvelopeSha256' IS DISTINCT FROM b->>'envelopeXdrTextSha256'
 OR candidate->'identity'->>'paymentId' IS DISTINCT FROM b->>'paymentId' OR candidate->'identity'->>'operationId' IS DISTINCT FROM b->>'operationId'
 OR candidate->'identity'->>'destinationWallet' IS DISTINCT FROM b->>'destinationWallet' OR candidate->'identity'->>'amountStroops' IS DISTINCT FROM b->>'amountStroops' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts WHERE network=a.network AND (owner_payment_id=s.payment_id OR source_wallet=a.source_wallet AND (prepared_tx_hash=b->>'preparedHash' OR prepared_sequence=b->>'preparedSequence')))
 OR EXISTS(SELECT 1 FROM public.financial_wallet_authority_history WHERE network=a.network AND source_wallet=a.source_wallet AND (owner_payment_id=s.payment_id OR prepared_tx_hash=b->>'preparedHash' OR prepared_sequence=b->>'preparedSequence'))
 OR EXISTS(SELECT 1 FROM public.financial_wallet_finality_seals WHERE network=a.network AND owner_payment_id=s.payment_id)
 OR EXISTS(SELECT 1 FROM public.refund_checkpoints WHERE payment_id=s.payment_id)
 OR EXISTS(SELECT 1 FROM public.refund_accounting_records WHERE payment_id=s.payment_id)
 OR EXISTS(SELECT 1 FROM public.transactions WHERE payment_id=s.u2a_identifier)
 OR EXISTS(SELECT 1 FROM public.receipts WHERE u2a_identifier=s.u2a_identifier) THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM public.r36_independent_u2a_attestations t WHERE t.network=a.network AND t.source_wallet=a.source_wallet AND t.payment_id=s.payment_id AND t.operation_kind=b->>'operationKind' AND t.operation_id=b->>'operationId' AND t.prepared_tx_hash=b->>'preparedHash' AND t.prepared_sequence=b->>'preparedSequence' AND t.pi_payment_id=s.u2a_identifier AND t.u2a_txid=s.u2a_txid AND t.proof_digest=original AND t.status='verified');
END $$;
REVOKE ALL ON FUNCTION public.r36_unspent_successor(text) FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;

CREATE FUNCTION public.r36_bound_effective_expiry(p_approval text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE x public.r36_bound_renewal_receipts; l public.r36_lifecycle_approval_links; c public.r36_prior_closure_receipts; q public.r36_certificate_requests; original text; n bigint;
BEGIN
 SELECT * INTO l FROM public.r36_lifecycle_approval_links WHERE approval_id=p_approval;
 IF NOT FOUND THEN RETURN (SELECT expires_at FROM public.r36_signed_approval_consumptions WHERE approval_id=p_approval); END IF;
 SELECT * INTO x FROM public.r36_bound_renewal_receipts WHERE approval_id=p_approval ORDER BY issued_at DESC,recorded_at DESC LIMIT 1;
 IF NOT FOUND THEN RETURN to_timestamp(l.expires_at); END IF;
 SELECT * INTO c FROM public.r36_prior_closure_receipts WHERE payload_digest=x.closure_digest;
 SELECT * INTO q FROM public.r36_certificate_requests WHERE nonce=l.successor_nonce;
 SELECT payload_digest INTO original FROM public.r36_certificate_receipts WHERE nonce=q.nonce;
 n=floor(extract(epoch FROM clock_timestamp()))::bigint;
 IF c.payload_digest IS NULL OR q.nonce IS NULL OR original IS NULL OR public.r36_admission_expiry(q.nonce,original) IS NULL OR c.revoked OR x.successor_nonce<>l.successor_nonce OR x.issued_at>n OR x.expires_at>c.expires_at OR x.expires_at>public.r36_admission_expiry(q.nonce,original)
 OR x.verified_by<>'r36_issuer' OR c.policy_digest<>q.policy_digest
 OR EXISTS(SELECT 1 FROM public.r36_prior_closure_receipts WHERE payload_digest=l.closure_digest AND revoked)
 THEN RETURN to_timestamp(0); END IF;
 RETURN to_timestamp(x.expires_at);
END $$;
REVOKE ALL ON FUNCTION public.r36_bound_effective_expiry(text) FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
CREATE OR REPLACE FUNCTION public.r36_bound_lifecycle_context(p_nonce text, p_closure text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c jsonb; t jsonb; b jsonb; prior jsonb; a public.r36_prior_closure_receipts; receipt public.r36_certificate_receipts;
 expected text;n bigint; BEGIN
 IF session_user<>'r36_issuer' THEN RETURN NULL; END IF;
 c=public.r36_certificate_context(p_nonce); IF c IS NULL THEN RETURN NULL; END IF;
 SELECT binding INTO b FROM public.r36_certificate_requests WHERE nonce=p_nonce;
 SELECT * INTO a FROM public.r36_prior_closure_receipts WHERE payload_digest=p_closure;
 IF NOT FOUND OR a.revoked OR a.policy_digest<>c->'policy'->>'policyDigest' OR a.source_wallet<>b->>'sourceWallet'
 THEN RETURN NULL; END IF;
 t=public.r36_terminal_review_context(a.policy_digest,a.source_wallet,a.prior_payment);
 IF t IS NULL OR a.context_digest<>t->>'contextDigest' THEN RETURN NULL; END IF;
 SELECT * INTO receipt FROM public.r36_certificate_receipts WHERE nonce=p_nonce FOR SHARE;
 n=floor(extract(epoch FROM clock_timestamp()))::bigint;
 IF NOT FOUND OR public.r36_admission_expiry(p_nonce,receipt.payload_digest)<=n OR a.expires_at<=n OR receipt.issued_at>n
 OR EXISTS(SELECT 1 FROM public.r36_certificate_revocations WHERE payload_digest=receipt.payload_digest)
 OR receipt.manifest IS DISTINCT FROM b||jsonb_build_object('schema','R36_ADMISSION_CERTIFICATE_V1','purpose','INITIAL_PREPARED_ADMISSION',
 'issuerId',c->'policy'->>'issuerId','keyId',c->'policy'->>'keyId','policyDigest',c->'policy'->>'policyDigest',
 'issuedAt',receipt.issued_at::text,'expiresAt',receipt.expires_at::text)
 THEN RETURN NULL; END IF;
 prior=t->'prior';
 IF prior->>'owner_payment_id'=b->>'paymentId' OR prior->>'prepared_tx_hash'=b->>'preparedHash'
 OR (b->>'preparedSequence')::numeric<>(prior->>'prepared_sequence')::numeric+1 THEN RETURN NULL; END IF;
 expected=encode(sha256(convert_to(jsonb_build_array('R36_BOUND_SUCCESSOR_V1','Pi Testnet',a.source_wallet,
 prior->>'owner_payment_id',prior->>'operation_kind',prior->>'owner_operation_id',prior->>'prepared_tx_hash',prior->>'prepared_sequence',
 b->>'paymentId',b->>'operationKind',b->>'operationId',b->>'preparedHash',b->>'preparedSequence',p_nonce)::text,'UTF8')),'hex');
 RETURN t||jsonb_build_object('boundRenewal',EXISTS(SELECT 1 FROM public.r36_lifecycle_approval_links WHERE successor_nonce=p_nonce),'bindingDigest',expected,'successorNonce',p_nonce,'successorCertificateDigest',receipt.payload_digest,
 'closureDigest',p_closure,'closureExpiresAt',a.expires_at,'certificateExpiresAt',public.r36_admission_expiry(p_nonce,receipt.payload_digest),'inventoryDigest',a.inventory_digest,
 'successorClearanceDigest',b->>'clearanceDigest');
END $function$
;
CREATE OR REPLACE FUNCTION public.r36_claim_bound_successor(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
 SELECT b.approval_id,b.consumed_at,b.prior_payload_digest,s.payload_digest,public.r36_bound_effective_expiry(s.approval_id) AS expires_at,
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
      AND public.r36_held_refund_outside_scope(p_wallet,r.payment_id,r.refund_id,(SELECT i.policy_digest FROM public.r36_testnet_ingress_reservations i WHERE i.payment_id=p_payment AND i.source_wallet=p_wallet)) IS DISTINCT FROM true
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
END $function$
;
CREATE OR REPLACE FUNCTION public.r36_record_bound_lifecycle(p_nonce text, p_closure text, p_text text, p_digest text, p_issued bigint, p_expires bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE c jsonb;b jsonb;e jsonb;v jsonb;old public.r36_lifecycle_approval_links; approved public.financial_wallet_rotation_approvals;
 n bigint;result text;gate public.financial_wallet_activation;next_clearance text;BEGIN
 IF session_user<>'r36_issuer' OR p_text IS NULL OR length(p_text)>2000000 OR p_digest IS NULL
 OR p_digest<>encode(sha256(convert_to(p_text,'UTF8')),'hex') THEN RAISE EXCEPTION 'VERIFIED_BINDING_REQUIRED'; END IF;
 c=public.r36_bound_lifecycle_context(p_nonce,p_closure);IF c IS NULL THEN RAISE EXCEPTION 'LIFECYCLE_CONTEXT_UNAVAILABLE'; END IF;
 v=p_text::jsonb;e=(v->>'text')::jsonb;b=c->'prior';n=floor(extract(epoch FROM clock_timestamp()))::bigint;
 IF e IS DISTINCT FROM jsonb_build_object('schema','R36_BOUND_SUCCESSOR_CLEARANCE_V1','bindingDigest',c->>'bindingDigest',
 'closureDigest',p_closure,'successorNonce',p_nonce,'successorCertificateDigest',c->>'successorCertificateDigest')
 OR v->'manifest'->>'subjectDigest' IS DISTINCT FROM c->>'bindingDigest'
 OR p_issued IS NULL OR p_expires IS NULL OR p_issued>n OR p_issued<(c->'policy'->>'valid_from')::bigint
 OR p_expires<=n OR p_expires<=p_issued OR p_expires-p_issued>(c->'policy'->>'max_age_seconds')::bigint
 OR p_expires>least((c->>'closureExpiresAt')::bigint,(c->>'certificateExpiresAt')::bigint,
 (c->'policy'->>'valid_until')::bigint,(c->'policy'->>'revocation_valid_until')::bigint)
 THEN RAISE EXCEPTION 'BOUND_CLEARANCE_SCOPE_OR_VALIDITY'; END IF;
 SELECT * INTO old FROM public.r36_lifecycle_approval_links WHERE approval_id=p_digest OR successor_nonce=p_nonce FOR UPDATE;
 IF FOUND THEN
  IF old.approval_id=p_digest AND old.closure_digest=p_closure AND old.successor_nonce=p_nonce AND old.evidence_text=p_text
  AND old.issued_at=p_issued AND old.expires_at=p_expires THEN RETURN 'REPLAYED'; END IF;
  -- Append a newly verified binding observation; preserve the old approval and
  -- its consumption markers. Runtime still claims that exact original right once.
  IF old.successor_nonce<>p_nonce OR NOT public.r36_unspent_successor(p_nonce)
  OR old.next_clearance_digest IS DISTINCT FROM c->>'successorClearanceDigest'
  OR NOT EXISTS(SELECT 1 FROM public.r36_wallet_successor_requests z WHERE z.approval_id=old.approval_id AND z.successor_nonce=p_nonce AND z.binding_digest=c->>'bindingDigest' AND z.consumed_at IS NULL)
  THEN RAISE EXCEPTION 'LIFECYCLE_REPLAY_CONFLICT'; END IF;
  IF EXISTS(SELECT 1 FROM public.r36_bound_renewal_receipts WHERE payload_digest=p_digest AND approval_id=old.approval_id AND closure_digest=p_closure AND evidence_text=p_text AND issued_at=p_issued AND expires_at=p_expires) THEN RETURN 'REPLAYED'; END IF;
  IF p_issued<old.expires_at OR EXISTS(SELECT 1 FROM public.r36_bound_renewal_receipts WHERE approval_id=old.approval_id AND expires_at>p_issued)
  THEN RAISE EXCEPTION 'BOUND_RENEWAL_FRESH_EVIDENCE_REQUIRED'; END IF;
  IF p_expires<=extract(epoch FROM clock_timestamp()) THEN RAISE EXCEPTION 'BOUND_CLEARANCE_EXPIRED_AFTER_LOCK'; END IF;
  INSERT INTO public.r36_bound_renewal_receipts(payload_digest,approval_id,closure_digest,successor_nonce,evidence_text,issued_at,expires_at,verified_by)
  VALUES(p_digest,old.approval_id,p_closure,p_nonce,p_text,p_issued,p_expires,session_user);
  RETURN 'RECORDED';
 END IF;
 -- Advance only the clearance of an ALREADY enabled wallet. The original
 -- certificate guard still demands equality with this exact successor digest.
 -- This function cannot create a gate, enable a blocked wallet, claim authority,
 -- submit a transaction or create accounting. Keep the prior value as audit evidence.
 SELECT * INTO gate FROM public.financial_wallet_activation
 WHERE network='Pi Testnet' AND source_wallet=b->>'source_wallet' FOR UPDATE;
 next_clearance=c->>'successorClearanceDigest';
 IF NOT FOUND OR gate.state<>'enabled' OR gate.clearance_digest IS NULL
 OR next_clearance IS NULL OR next_clearance !~ '^[0-9a-f]{64}$'
 THEN RAISE EXCEPTION 'EXISTING_ENABLED_WALLET_REQUIRED'; END IF;
 -- The gate lock may have waited. Never use pre-wait validity as fresh authority.
 IF p_expires<=extract(epoch FROM clock_timestamp()) THEN RAISE EXCEPTION 'BOUND_CLEARANCE_EXPIRED_AFTER_LOCK'; END IF;
 -- No replacement of a prior approval, even expired or consumed. A conflict stays held.
 INSERT INTO public.financial_wallet_rotation_approvals(network,source_wallet,prior_prepared_hash,evidence_digest,approval_id,approved_by)
 VALUES('Pi Testnet',b->>'source_wallet',b->>'prepared_tx_hash',c->'seal'->>'evidence_digest',p_digest,session_user);
 INSERT INTO public.r36_rotation_approval_evidence(network,source_wallet,prior_prepared_hash,comparison_digest,seal_evidence_digest,
 horizon_result_verified,historical_wallet_reconciled,accounting_finality_verified,certified_by)
 VALUES('Pi Testnet',b->>'source_wallet',b->>'prepared_tx_hash',p_closure,c->'seal'->>'evidence_digest',true,true,true,session_user);
 INSERT INTO public.r36_signed_approval_consumptions(approval_id,network,wallet,prior_hash,prior_sequence,prior_payment,prior_operation,
 kind,evidence_digest,inventory_digest,binding_digest,payload_digest,expires_at,independently_certified_at)
 VALUES(p_digest,'Pi Testnet',b->>'source_wallet',b->>'prepared_tx_hash',(b->>'prepared_sequence')::numeric,b->>'owner_payment_id',
 b->>'owner_operation_id',b->>'operation_kind',c->'seal'->>'evidence_digest',c->>'inventoryDigest',c->>'bindingDigest',p_digest,to_timestamp(p_expires),clock_timestamp());
 INSERT INTO public.r36_lifecycle_approval_links(approval_id,closure_digest,successor_nonce,evidence_text,issued_at,expires_at,prior_clearance_digest,next_clearance_digest)
 VALUES(p_digest,p_closure,p_nonce,p_text,p_issued,p_expires,gate.clearance_digest,next_clearance);
 result=public.r36_register_successor_binding(p_nonce);
 IF result NOT IN ('RECORDED','REPLAYED') OR result IS NULL THEN RAISE EXCEPTION 'ORIGINAL_SUCCESSOR_REGISTRATION_DENIED'; END IF;
 IF p_expires<=extract(epoch FROM clock_timestamp()) THEN RAISE EXCEPTION 'BOUND_CLEARANCE_EXPIRED_BEFORE_COMMIT'; END IF;
 UPDATE public.financial_wallet_activation SET clearance_digest=next_clearance,
 cleared_by='r36_issuer:bound-successor',cleared_at=clock_timestamp()
 WHERE network=gate.network AND source_wallet=gate.source_wallet AND state='enabled' AND clearance_digest=gate.clearance_digest;
 IF NOT FOUND THEN RAISE EXCEPTION 'WALLET_CLEARANCE_CHANGED'; END IF;
 RETURN 'RECORDED';
END $function$
;
CREATE OR REPLACE FUNCTION public.r36_register_successor_binding(p_nonce text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE ctx jsonb; b jsonb; p jsonb; receipt jsonb; old public.financial_wallet_authorities;
 seal public.financial_wallet_finality_seals; grant_row record;
 stored public.r36_wallet_successor_requests; expected text; now_at timestamptz; now_s bigint;
BEGIN
 IF session_user<>'r36_issuer' OR current_setting('transaction_isolation')<>'read committed'
 OR p_nonce IS NULL OR p_nonce !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
 -- Same policy -> request -> wallet lock order as certificate admission.
 ctx:=public.r36_certificate_context(p_nonce);
 IF ctx IS NULL THEN RETURN NULL; END IF;
 b:=ctx->'binding'; p:=ctx->'policy'; receipt:=ctx->'receipt';
 IF b->>'nonce' IS DISTINCT FROM p_nonce OR b->>'network' IS DISTINCT FROM 'Pi Testnet'
 OR coalesce(b->>'sourceWallet','') !~ '^G[A-Z2-7]{55}$'
 OR coalesce(b->>'preparedHash','') !~ '^[0-9a-f]{64}$'
 OR coalesce(b->>'preparedSequence','') !~ '^[1-9][0-9]{0,29}$'
 OR b->>'operationKind' NOT IN ('settlement','refund') OR receipt IS NULL OR receipt='null'::jsonb
 OR receipt->'manifest' IS DISTINCT FROM b||jsonb_build_object(
  'schema','R36_ADMISSION_CERTIFICATE_V1','purpose','INITIAL_PREPARED_ADMISSION',
  'issuerId',p->>'issuerId','keyId',p->>'keyId','policyDigest',p->>'policyDigest',
  'issuedAt',receipt->'manifest'->>'issuedAt','expiresAt',receipt->'manifest'->>'expiresAt')
 OR EXISTS(SELECT 1 FROM public.r36_certificate_revocations v JOIN public.r36_certificate_receipts c ON c.payload_digest=v.payload_digest WHERE c.nonce=p_nonce)
 THEN RETURN NULL; END IF;
 now_s:=floor(extract(epoch FROM clock_timestamp()))::bigint;
 IF now_s>=least((p->>'validUntil')::bigint,(p->>'revocationValidUntil')::bigint,
    (receipt->'manifest'->>'expiresAt')::bigint)
 OR (receipt->'manifest'->>'issuedAt')::bigint>now_s
 OR (p->>'revocationCheckedAt')::bigint<(receipt->'manifest'->>'issuedAt')::bigint
 THEN RETURN NULL; END IF;
 SELECT * INTO old FROM public.financial_wallet_authorities
 WHERE network=b->>'network' AND source_wallet=b->>'sourceWallet' FOR UPDATE;
 IF NOT FOUND THEN RETURN 'NOT_REQUIRED'; END IF;
 IF old.state<>'prepared' THEN RETURN NULL; END IF;
 IF (old.owner_payment_id,old.operation_kind,old.owner_operation_id,old.prepared_tx_hash,old.prepared_sequence)
  =(b->>'paymentId',b->>'operationKind',b->>'operationId',b->>'preparedHash',b->>'preparedSequence')
 THEN RETURN 'NOT_REQUIRED'; END IF;
 IF old.owner_payment_id=b->>'paymentId' OR old.prepared_tx_hash=b->>'preparedHash'
 OR (b->>'preparedSequence')::numeric<>old.prepared_sequence::numeric+1 THEN RETURN NULL; END IF;
 SELECT * INTO seal FROM public.financial_wallet_finality_seals
 WHERE network=old.network AND source_wallet=old.source_wallet AND prepared_tx_hash=old.prepared_tx_hash FOR SHARE;
 IF NOT FOUND OR (seal.owner_payment_id,seal.operation_kind,seal.owner_operation_id,seal.prepared_sequence)
 IS DISTINCT FROM (old.owner_payment_id,old.operation_kind,old.owner_operation_id,old.prepared_sequence)
 OR NOT EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts a WHERE
   (a.network,a.source_wallet,a.owner_payment_id,a.operation_kind,a.owner_operation_id,a.prepared_tx_hash,a.prepared_sequence)
   =(old.network,old.source_wallet,old.owner_payment_id,old.operation_kind,old.owner_operation_id,old.prepared_tx_hash,old.prepared_sequence))
 THEN RETURN NULL; END IF;
 -- EXACT SQL57 tuple: the pre-existing independently certified binding already
 -- names the prior right, successor right and protected successor nonce.
 expected:=encode(sha256(convert_to(jsonb_build_array('R36_BOUND_SUCCESSOR_V1',old.network,old.source_wallet,
  old.owner_payment_id,old.operation_kind,old.owner_operation_id,old.prepared_tx_hash,old.prepared_sequence,
  b->>'paymentId',b->>'operationKind',b->>'operationId',b->>'preparedHash',b->>'preparedSequence',p_nonce)::text,'UTF8')),'hex');
 SELECT s.approval_id,s.payload_digest,public.r36_bound_effective_expiry(s.approval_id) AS expires_at,s.independently_certified_at,s.consumed_at,
   o.consumed_at AS operator_consumed,e.certified_at
 INTO grant_row FROM public.r36_signed_approval_consumptions s
 JOIN public.financial_wallet_rotation_approvals o ON o.approval_id=s.approval_id
 JOIN public.r36_rotation_approval_evidence e ON (e.network,e.source_wallet,e.prior_prepared_hash)
   =(o.network,o.source_wallet,o.prior_prepared_hash)
 WHERE (s.network,s.wallet,s.prior_payment,s.kind,s.prior_operation,s.prior_hash,s.prior_sequence)
   =(old.network,old.source_wallet,old.owner_payment_id,old.operation_kind,old.owner_operation_id,old.prepared_tx_hash,old.prepared_sequence::numeric)
 AND (o.network,o.source_wallet,o.prior_prepared_hash,o.evidence_digest)
   =(old.network,old.source_wallet,old.prepared_tx_hash,seal.evidence_digest)
 AND s.binding_digest=expected AND s.evidence_digest=seal.evidence_digest
 AND e.seal_evidence_digest=seal.evidence_digest
 AND e.horizon_result_verified AND e.historical_wallet_reconciled AND e.accounting_finality_verified
 FOR UPDATE OF s,o FOR SHARE OF e;
 IF NOT FOUND THEN RETURN NULL; END IF;
 -- Recheck wall clock AFTER every potentially blocking row lock. No stale approval
 -- or successor certificate may become registered while waiting for another caller.
 now_at:=clock_timestamp(); now_s:=floor(extract(epoch FROM now_at))::bigint;
 IF grant_row.consumed_at IS NOT NULL OR grant_row.operator_consumed IS NOT NULL
 OR grant_row.expires_at<=now_at OR grant_row.independently_certified_at>now_at
 OR grant_row.independently_certified_at<seal.sealed_at OR grant_row.certified_at>now_at
 OR now_s<(p->>'validFrom')::bigint OR now_s>=least((p->>'validUntil')::bigint,(p->>'revocationValidUntil')::bigint,
   (receipt->'manifest'->>'expiresAt')::bigint)
 OR (p->>'revocationCheckedAt')::bigint>now_s
 OR (receipt->'manifest'->>'issuedAt')::bigint>now_s
 THEN RETURN NULL; END IF;
 SELECT * INTO stored FROM public.r36_wallet_successor_requests
 WHERE approval_id=grant_row.approval_id OR successor_nonce=p_nonce FOR UPDATE;
 IF FOUND THEN
  IF (stored.approval_id,stored.successor_nonce,stored.prior_payload_digest,stored.binding_digest)
    =(grant_row.approval_id,p_nonce,grant_row.payload_digest,expected) AND stored.consumed_at IS NULL
  THEN RETURN 'REPLAYED'; END IF;
  RETURN NULL;
 END IF;
 INSERT INTO public.r36_wallet_successor_requests(approval_id,successor_nonce,prior_payload_digest,binding_digest)
 VALUES(grant_row.approval_id,p_nonce,grant_row.payload_digest,expected);
 -- Consumption and all original terminal accounting/XOR/global liability checks
 -- remain exclusively in unchanged SQL57 and SQL59 at the runtime boundary.
 RETURN 'RECORDED';
END $function$
;
CREATE OR REPLACE FUNCTION public.r36_renewal_issuer_state(p_nonce text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE req public.r36_admission_renewal_requests;
BEGIN
 IF session_user<>'r36_issuer' THEN RETURN '{}'::jsonb; END IF;
 SELECT * INTO req FROM public.r36_admission_renewal_requests WHERE nonce=p_nonce ORDER BY generation DESC LIMIT 1;
 IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;
 RETURN jsonb_build_object('renewalRequiresSuccessor',public.r36_unspent_successor(p_nonce),'binding',req.binding,'requestCreatedAt',req.issued_at,'renewalGeneration',req.generation,'evidenceNotBefore',req.evidence_not_before,
 'receipt',(SELECT jsonb_build_object('manifest',c.manifest,'signature',c.signature_base64) FROM public.r36_admission_renewal_receipts c WHERE c.nonce=p_nonce AND c.generation=req.generation));
END $function$
;
CREATE OR REPLACE FUNCTION public.r36_renewal_unspent(p_nonce text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE b jsonb; original text; a public.financial_wallet_authorities; g public.financial_wallet_activation; s public.settlement_checkpoints; r public.refund_checkpoints;
BEGIN
 IF session_user NOT IN ('r36_registrar','r36_issuer') THEN RETURN false; END IF;
 SELECT q.binding,c.payload_digest INTO b,original FROM public.r36_certificate_requests q JOIN public.r36_certificate_receipts c USING(nonce)
 WHERE q.nonce=p_nonce FOR UPDATE OF q;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.r36_certificate_revocations WHERE payload_digest=original) THEN RETURN false; END IF;
 SELECT * INTO g FROM public.financial_wallet_activation WHERE network=b->>'network' AND source_wallet=b->>'sourceWallet' FOR UPDATE;
 IF NOT FOUND OR g.state<>'enabled' OR g.clearance_digest IS DISTINCT FROM b->>'clearanceDigest' THEN RETURN false; END IF;
 SELECT * INTO a FROM public.financial_wallet_authorities WHERE network=g.network AND source_wallet=g.source_wallet FOR UPDATE;
 IF FOUND AND a.owner_payment_id IS DISTINCT FROM b->>'paymentId' THEN RETURN public.r36_unspent_successor(p_nonce); END IF;
 IF NOT FOUND OR a.state<>'prepared' OR (a.owner_payment_id,a.operation_kind,a.owner_operation_id,a.prepared_tx_hash,a.prepared_sequence)
 IS DISTINCT FROM (b->>'paymentId',b->>'operationKind',b->>'operationId',b->>'preparedHash',b->>'preparedSequence') THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts t WHERE t.network=a.network AND
  (t.owner_payment_id=a.owner_payment_id OR t.source_wallet=a.source_wallet AND (t.prepared_tx_hash=a.prepared_tx_hash OR t.prepared_sequence=a.prepared_sequence)))
 OR EXISTS(SELECT 1 FROM public.financial_wallet_finality_seals t WHERE t.network=a.network AND t.owner_payment_id=a.owner_payment_id)
 THEN RETURN false; END IF;
 SELECT * INTO s FROM public.settlement_checkpoints WHERE payment_id=a.owner_payment_id;
 IF NOT FOUND OR s.u2a_identifier IS DISTINCT FROM b->>'piPaymentId' OR s.u2a_txid IS DISTINCT FROM b->>'u2aTxid'
 OR s.u2a_verified_at IS NULL OR s.u2a_completed_at IS NULL OR s.customer_amount*10000000<>(b->>'amountStroops')::numeric
 OR s.merchant_amount<>s.customer_amount OR s.app_commission<>0 OR s.a2u_txid IS NOT NULL OR s.horizon_confirmed_at IS NOT NULL
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
END $function$
;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM r36_owner;
DO $$ BEGIN IF session_user='neondb_owner' THEN REVOKE r36_owner FROM neondb_owner; END IF; END $$;
COMMIT;
