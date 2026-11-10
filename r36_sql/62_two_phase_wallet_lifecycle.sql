-- NOT_FOR_DEPLOY. Two-phase wallet closure/next-right enrollment; isolated qualification only.
-- No financial execution, wallet activation, old-right disposal or one-shot reset.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ BEGIN
 IF current_setting('flashpay.isolated_certificate_test',true) IS DISTINCT FROM 'yes'
 OR current_user<>session_user OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
 THEN RAISE EXCEPTION 'ISOLATED_POSTGRESQL17_ONLY'; END IF;
 IF to_regprocedure('public.r36_register_successor_binding(text)') IS NULL THEN RAISE EXCEPTION 'SQL60_REQUIRED'; END IF;
END $$;
CREATE TABLE public.r36_prior_closure_receipts (
 payload_digest text PRIMARY KEY CHECK(payload_digest ~ '^[0-9a-f]{64}$'),
 policy_digest text NOT NULL REFERENCES public.r36_certificate_policies(policy_digest),
 network text NOT NULL CHECK(network='Pi Testnet'),source_wallet text NOT NULL,prior_payment text NOT NULL,
 prior_hash text NOT NULL,context_digest text NOT NULL,evidence_digest text NOT NULL,inventory_digest text NOT NULL,
 evidence_text text NOT NULL CHECK(length(evidence_text) BETWEEN 1 AND 12000000),
 issued_at bigint NOT NULL,expires_at bigint NOT NULL CHECK(expires_at>issued_at),
 verified_by text NOT NULL CHECK(verified_by='r36_issuer'),revoked boolean NOT NULL DEFAULT false,
 verified_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.r36_lifecycle_approval_links (
 approval_id text PRIMARY KEY REFERENCES public.r36_signed_approval_consumptions(approval_id),
 closure_digest text NOT NULL REFERENCES public.r36_prior_closure_receipts(payload_digest),
 successor_nonce text NOT NULL UNIQUE REFERENCES public.r36_certificate_requests(nonce),
 evidence_text text NOT NULL,issued_at bigint NOT NULL,expires_at bigint NOT NULL,
 prior_clearance_digest text NOT NULL CHECK(prior_clearance_digest ~ '^[0-9a-f]{64}$'),
 next_clearance_digest text NOT NULL CHECK(next_clearance_digest ~ '^[0-9a-f]{64}$')
);
ALTER TABLE public.r36_prior_closure_receipts OWNER TO r36_owner;
ALTER TABLE public.r36_lifecycle_approval_links OWNER TO r36_owner;
REVOKE ALL ON public.r36_prior_closure_receipts,public.r36_lifecycle_approval_links FROM PUBLIC,r36_runtime,r36_issuer,r36_signer;
CREATE FUNCTION public.r36_terminal_review_context(p_policy text,p_wallet text,p_prior text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE old public.financial_wallet_authorities; seal public.financial_wallet_finality_seals;
 terminal jsonb; policy public.r36_certificate_policies; p_network text := 'Pi Testnet';
BEGIN
 IF session_user NOT IN ('r36_runtime','r36_issuer') OR current_setting('transaction_isolation')<>'read committed' THEN RETURN NULL; END IF;
 SELECT * INTO policy FROM public.r36_certificate_policies WHERE policy_digest=p_policy FOR SHARE;
 IF NOT FOUND OR NOT policy.enabled OR policy.revoked
 OR policy.worker_profile->'recoveryPilot'->'ingress'->'allowTerminalReservationTurnover' IS DISTINCT FROM 'true'::jsonb
 THEN RETURN NULL; END IF;
 SELECT * INTO old FROM public.financial_wallet_authorities
 WHERE network=p_network AND source_wallet=p_wallet FOR UPDATE;
 IF NOT FOUND OR old.state<>'prepared' OR old.owner_payment_id IS DISTINCT FROM p_prior THEN RETURN NULL; END IF;
 -- Same payment lock as the accounting/XOR writers. Never resolve from Redis.
 PERFORM pg_advisory_xact_lock(hashtextextended(old.owner_payment_id,0));
 SELECT * INTO seal FROM public.financial_wallet_finality_seals
 WHERE network=p_network AND source_wallet=p_wallet AND prepared_tx_hash=old.prepared_tx_hash FOR SHARE;
 IF NOT FOUND OR (seal.owner_payment_id,seal.operation_kind,seal.owner_operation_id,seal.prepared_sequence)
 IS DISTINCT FROM (old.owner_payment_id,old.operation_kind,old.owner_operation_id,old.prepared_sequence)
 OR NOT EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts t
  WHERE (t.network,t.source_wallet,t.owner_payment_id,t.operation_kind,t.owner_operation_id,t.prepared_tx_hash,t.prepared_sequence)
   =(old.network,old.source_wallet,old.owner_payment_id,old.operation_kind,old.owner_operation_id,old.prepared_tx_hash,old.prepared_sequence))
 THEN RETURN NULL; END IF;
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
  THEN RETURN NULL; END IF;
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
  THEN RETURN NULL; END IF;
 END IF;

 IF old.operation_kind='settlement' THEN
 SELECT jsonb_build_object('piPaymentId',s.a2u_payment_id,'recipientUid',s.merchant_uid,'amountStroops',trunc(s.customer_amount*10000000)::text,
 'receiptId',r.id::text,'entryId',t.id::text)
 INTO terminal FROM public.settlement_checkpoints s JOIN public.transactions t ON t.payment_id=s.u2a_identifier
 JOIN public.receipts r ON r.transaction_id=t.id WHERE s.payment_id=old.owner_payment_id;
 ELSE
 SELECT jsonb_build_object('piPaymentId',refund_payment_id,'recipientUid',payer_uid,'amountStroops',trunc(amount*10000000)::text,'receiptId',NULL,'entryId',refund_id)
 INTO terminal FROM public.refund_checkpoints WHERE refund_id=old.owner_operation_id AND payment_id=old.owner_payment_id;
 END IF;
 IF extract(epoch FROM clock_timestamp()) NOT BETWEEN policy.valid_from AND least(policy.valid_until,policy.revocation_valid_until)-1
 OR policy.revocation_checked_at>extract(epoch FROM clock_timestamp()) THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('policy',to_jsonb(policy),'prior',to_jsonb(old),'seal',to_jsonb(seal),'terminal',terminal,
 'nowSeconds',floor(extract(epoch FROM clock_timestamp()))::bigint,
 'contextDigest',encode(sha256(convert_to(jsonb_build_array('R36_PRIOR_CLOSURE_V1',p_policy,old.network,old.source_wallet,
 old.owner_payment_id,old.operation_kind,old.owner_operation_id,old.prepared_tx_hash,old.prepared_sequence,
 seal.evidence_digest,seal.horizon_ledger,seal.horizon_fee_stroops)::text,'UTF8')),'hex'));
END $$;

ALTER FUNCTION public.r36_terminal_review_context(text,text,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_terminal_review_context(text,text,text) FROM PUBLIC,r36_runtime,r36_signer;
GRANT EXECUTE ON FUNCTION public.r36_terminal_review_context(text,text,text) TO r36_issuer;

-- Read-only completed-job acknowledgement. Expiry never becomes fresh authority:
-- the caller reports HISTORICAL_RECORD_ONLY and the original runtime gates remain.
CREATE FUNCTION public.r36_lifecycle_job_receipt(p_kind text,p_policy text,p_wallet text,p_subject text,p_aux text,p_text text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE v jsonb;r record;BEGIN
 IF session_user<>'r36_issuer' OR p_text IS NULL OR length(p_text)>12000000 THEN RETURN NULL; END IF;
 v=p_text::jsonb;
 IF p_kind='prior_closure' THEN
  SELECT c.payload_digest,c.policy_digest INTO r FROM public.r36_prior_closure_receipts c
  JOIN public.r36_certificate_policies p ON p.policy_digest=c.policy_digest
  WHERE c.policy_digest=p_policy AND c.source_wallet=p_wallet AND c.prior_payment=p_subject
  AND NOT c.revoked AND p.enabled AND NOT p.revoked AND c.evidence_text::jsonb->'artifacts'=v
  ORDER BY c.verified_at DESC LIMIT 1;
 ELSIF p_kind='bound_successor' THEN
  SELECT l.approval_id AS payload_digest,c.policy_digest INTO r FROM public.r36_lifecycle_approval_links l
  JOIN public.r36_prior_closure_receipts c ON c.payload_digest=l.closure_digest
  JOIN public.r36_certificate_policies p ON p.policy_digest=c.policy_digest
  JOIN public.r36_certificate_receipts receipt ON receipt.nonce=l.successor_nonce
  WHERE l.successor_nonce=p_subject AND l.closure_digest=p_aux AND l.evidence_text::jsonb=v
  AND NOT c.revoked AND p.enabled AND NOT p.revoked
  AND NOT EXISTS(SELECT 1 FROM public.r36_certificate_revocations WHERE payload_digest=receipt.payload_digest);
 ELSE RETURN NULL; END IF;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('proofDigest',r.payload_digest,'policyDigest',r.policy_digest,'scope','HISTORICAL_RECORD_ONLY');
END $$;
ALTER FUNCTION public.r36_lifecycle_job_receipt(text,text,text,text,text,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_lifecycle_job_receipt(text,text,text,text,text,text) FROM PUBLIC,r36_runtime,r36_signer;
GRANT EXECUTE ON FUNCTION public.r36_lifecycle_job_receipt(text,text,text,text,text,text) TO r36_issuer;

CREATE FUNCTION public.r36_record_prior_closure(p_policy text,p_wallet text,p_prior text,p_text text,p_digest text,p_issued bigint,p_expires bigint)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c jsonb; v jsonb; old public.r36_prior_closure_receipts; n bigint; BEGIN
 IF session_user<>'r36_issuer' OR p_text IS NULL OR length(p_text)>12000000 OR p_digest IS NULL
 OR p_digest<>encode(sha256(convert_to(p_text,'UTF8')),'hex') THEN RAISE EXCEPTION 'VERIFIED_CLOSURE_REQUIRED'; END IF;
 c=public.r36_terminal_review_context(p_policy,p_wallet,p_prior);
 IF c IS NULL THEN RAISE EXCEPTION 'TERMINAL_CONTEXT_UNAVAILABLE'; END IF;
 v=p_text::jsonb;n=floor(extract(epoch from clock_timestamp()))::bigint;
 IF v->>'contextDigest' IS DISTINCT FROM c->>'contextDigest' OR v->>'schema' IS DISTINCT FROM 'R36_VERIFIED_CLOSURE_BUNDLE_V1'
 OR coalesce(v->>'inventoryDigest','') !~ '^[0-9a-f]{64}$'
 OR p_issued IS NULL OR p_expires IS NULL OR p_issued<(c->'policy'->>'valid_from')::bigint OR p_issued>n
 OR to_timestamp(p_issued)<date_trunc('second',(c->'seal'->>'sealed_at')::timestamptz)
 OR p_expires<=n OR p_expires<=p_issued OR p_expires>least((c->'policy'->>'valid_until')::bigint,(c->'policy'->>'revocation_valid_until')::bigint)
 OR p_expires-p_issued>(c->'policy'->>'max_age_seconds')::bigint
 THEN RAISE EXCEPTION 'CLOSURE_SCOPE_OR_VALIDITY'; END IF;
 SELECT * INTO old FROM public.r36_prior_closure_receipts WHERE payload_digest=p_digest FOR UPDATE;
 IF FOUND THEN
  IF old.evidence_text=p_text AND old.policy_digest=p_policy AND old.source_wallet=p_wallet AND old.prior_payment=p_prior
  AND old.issued_at=p_issued AND old.expires_at=p_expires AND NOT old.revoked THEN RETURN 'REPLAYED'; END IF;
  RAISE EXCEPTION 'CLOSURE_REPLAY_CONFLICT';
 END IF;
 INSERT INTO public.r36_prior_closure_receipts(payload_digest,policy_digest,network,source_wallet,prior_payment,prior_hash,
 context_digest,evidence_digest,inventory_digest,evidence_text,issued_at,expires_at,verified_by)
 VALUES(p_digest,p_policy,'Pi Testnet',p_wallet,p_prior,c->'prior'->>'prepared_tx_hash',c->>'contextDigest',c->'seal'->>'evidence_digest',
 v->>'inventoryDigest',p_text,p_issued,p_expires,session_user);
 RETURN 'RECORDED';
END $$;
ALTER FUNCTION public.r36_record_prior_closure(text,text,text,text,text,bigint,bigint) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_record_prior_closure(text,text,text,text,text,bigint,bigint) FROM PUBLIC,r36_runtime,r36_signer;
GRANT EXECUTE ON FUNCTION public.r36_record_prior_closure(text,text,text,text,text,bigint,bigint) TO r36_issuer;

CREATE FUNCTION public.r36_bound_lifecycle_context(p_nonce text,p_closure text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c jsonb; t jsonb; b jsonb; prior jsonb; a public.r36_prior_closure_receipts; receipt public.r36_certificate_receipts;
 expected text;n bigint; BEGIN
 IF session_user<>'r36_issuer' THEN RETURN NULL; END IF;
 c=public.r36_certificate_context(p_nonce); IF c IS NULL THEN RETURN NULL; END IF;
 b=c->'binding';
 SELECT * INTO a FROM public.r36_prior_closure_receipts WHERE payload_digest=p_closure;
 IF NOT FOUND OR a.revoked OR a.policy_digest<>c->'policy'->>'policyDigest' OR a.source_wallet<>b->>'sourceWallet'
 THEN RETURN NULL; END IF;
 t=public.r36_terminal_review_context(a.policy_digest,a.source_wallet,a.prior_payment);
 IF t IS NULL OR a.context_digest<>t->>'contextDigest' THEN RETURN NULL; END IF;
 SELECT * INTO receipt FROM public.r36_certificate_receipts WHERE nonce=p_nonce FOR SHARE;
 n=floor(extract(epoch FROM clock_timestamp()))::bigint;
 IF NOT FOUND OR receipt.expires_at<=n OR a.expires_at<=n OR receipt.issued_at>n
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
 RETURN t||jsonb_build_object('bindingDigest',expected,'successorNonce',p_nonce,'successorCertificateDigest',receipt.payload_digest,
 'closureDigest',p_closure,'closureExpiresAt',a.expires_at,'certificateExpiresAt',receipt.expires_at,'inventoryDigest',a.inventory_digest,
 'successorClearanceDigest',b->>'clearanceDigest');
END $$;
ALTER FUNCTION public.r36_bound_lifecycle_context(text,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_bound_lifecycle_context(text,text) FROM PUBLIC,r36_runtime,r36_signer;
GRANT EXECUTE ON FUNCTION public.r36_bound_lifecycle_context(text,text) TO r36_issuer;

CREATE FUNCTION public.r36_record_bound_lifecycle(p_nonce text,p_closure text,p_text text,p_digest text,p_issued bigint,p_expires bigint)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
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
  RAISE EXCEPTION 'LIFECYCLE_REPLAY_CONFLICT';
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
END $$;
ALTER FUNCTION public.r36_record_bound_lifecycle(text,text,text,text,bigint,bigint) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_record_bound_lifecycle(text,text,text,text,bigint,bigint) FROM PUBLIC,r36_runtime,r36_signer;
GRANT EXECUTE ON FUNCTION public.r36_record_bound_lifecycle(text,text,text,text,bigint,bigint) TO r36_issuer;

CREATE FUNCTION public.r36_revoke_prior_closure(p_digest text,p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.r36_prior_closure_receipts; BEGIN
 IF session_user<>'r36_issuer' OR p_reason IS NULL OR p_reason !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
 SELECT * INTO c FROM public.r36_prior_closure_receipts WHERE payload_digest=p_digest;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM public.r36_certificate_policies WHERE policy_digest=c.policy_digest FOR UPDATE;
 UPDATE public.r36_prior_closure_receipts SET revoked=true WHERE payload_digest=p_digest;
 INSERT INTO public.r36_certificate_revocations(payload_digest,reason_digest)
 SELECT r.payload_digest,p_reason FROM public.r36_lifecycle_approval_links l JOIN public.r36_certificate_receipts r
 ON r.nonce=l.successor_nonce WHERE l.closure_digest=p_digest ON CONFLICT DO NOTHING;
 RETURN true;
END $$;
ALTER FUNCTION public.r36_revoke_prior_closure(text,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_revoke_prior_closure(text,text) FROM PUBLIC,r36_runtime,r36_signer;
GRANT EXECUTE ON FUNCTION public.r36_revoke_prior_closure(text,text) TO r36_issuer;

CREATE OR REPLACE FUNCTION public.r36_terminal_ingress_clearance(p_policy text,p_wallet text,p_prior text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE old public.financial_wallet_authorities; seal public.financial_wallet_finality_seals;
 proof record; policy public.r36_certificate_policies; p_network text := 'Pi Testnet';
BEGIN
 IF session_user<>'r36_runtime' OR current_setting('transaction_isolation')<>'read committed' THEN RETURN false; END IF;
 SELECT * INTO policy FROM public.r36_certificate_policies WHERE policy_digest=p_policy FOR SHARE;
 IF NOT FOUND OR NOT policy.enabled OR policy.revoked
 OR policy.worker_profile->'recoveryPilot'->'ingress'->'allowTerminalReservationTurnover' IS DISTINCT FROM 'true'::jsonb
 THEN RETURN false; END IF;
 SELECT * INTO old FROM public.financial_wallet_authorities
 WHERE network=p_network AND source_wallet=p_wallet FOR UPDATE;
 IF NOT FOUND OR old.state<>'prepared' OR old.owner_payment_id IS DISTINCT FROM p_prior THEN RETURN false; END IF;
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

 -- A verified PRIOR-only closure frees an ingress slot, never financial authority.
 IF EXISTS(SELECT 1 FROM public.r36_prior_closure_receipts c
  WHERE c.policy_digest=p_policy AND c.network=p_network AND c.source_wallet=p_wallet AND c.prior_payment=p_prior
  AND c.prior_hash=old.prepared_tx_hash AND c.evidence_digest=seal.evidence_digest AND NOT c.revoked
  AND c.context_digest=public.r36_terminal_review_context(p_policy,p_wallet,p_prior)->>'contextDigest'
  AND c.issued_at>=floor(extract(epoch FROM seal.sealed_at)) AND c.issued_at<=extract(epoch FROM clock_timestamp())
  AND c.expires_at>extract(epoch FROM clock_timestamp())) THEN RETURN true; END IF;

 -- This consumes NO approval and changes NO financial authority. The independent
 -- prior closure must already exist under protected enrollment. Its signature
 -- does not authorize the next Prepared XDR; SQL57 still requires its exact binding.
 SELECT s.expires_at,s.independently_certified_at INTO proof
 FROM public.r36_signed_approval_consumptions s
 JOIN public.financial_wallet_rotation_approvals a ON a.approval_id=s.approval_id
 JOIN public.r36_rotation_approval_evidence e ON (e.network,e.source_wallet,e.prior_prepared_hash)
  =(a.network,a.source_wallet,a.prior_prepared_hash)
 WHERE (s.network,s.wallet,s.prior_payment,s.kind,s.prior_operation,s.prior_hash,s.prior_sequence)
  =(old.network,old.source_wallet,old.owner_payment_id,old.operation_kind,old.owner_operation_id,old.prepared_tx_hash,old.prepared_sequence::numeric)
 AND (a.network,a.source_wallet,a.prior_prepared_hash)=(p_network,p_wallet,old.prepared_tx_hash)
 AND s.evidence_digest=seal.evidence_digest AND a.evidence_digest=seal.evidence_digest AND e.seal_evidence_digest=seal.evidence_digest
 AND s.consumed_at IS NULL AND a.consumed_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM public.r36_lifecycle_approval_links l JOIN public.r36_prior_closure_receipts c ON c.payload_digest=l.closure_digest
 WHERE l.approval_id=s.approval_id AND (c.revoked OR c.expires_at<=extract(epoch FROM clock_timestamp())))
 AND e.horizon_result_verified AND e.historical_wallet_reconciled AND e.accounting_finality_verified
 AND e.certified_at>=seal.sealed_at AND e.certified_at<=clock_timestamp()
 FOR SHARE OF s,a,e;
 IF NOT FOUND OR proof.expires_at<=clock_timestamp() OR proof.independently_certified_at<seal.sealed_at
 OR proof.independently_certified_at>clock_timestamp()
 OR extract(epoch FROM clock_timestamp()) NOT BETWEEN policy.valid_from AND least(policy.valid_until,policy.revocation_valid_until)-1
 THEN RETURN false; END IF;
 RETURN true;
END $$;
ALTER FUNCTION public.r36_terminal_ingress_clearance(text,text,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_terminal_ingress_clearance(text,text,text) FROM PUBLIC,r36_runtime,r36_issuer,r36_signer;

COMMIT;
