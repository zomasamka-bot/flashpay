-- Non-authorizing immutable evidence handoff. No policy, activation, certificate,
-- wallet claim, financial checkpoint, submission or accounting is created here.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
SET LOCAL search_path=pg_catalog,pg_temp;
DO $$ BEGIN
 IF current_setting('neon.branch_id',true) IS DISTINCT FROM 'br-tiny-mode-aliatv40'
 AND current_setting('flashpay.isolated_certificate_test',true) IS DISTINCT FROM 'yes'
 THEN RAISE EXCEPTION 'UNRECOGNIZED_TARGET'; END IF;
 IF to_regclass('public.r36_legacy_right_holds') IS NULL
 OR to_regclass('public.r36_testnet_ingress_reservations') IS NULL
 OR to_regrole('r36_evidence_reader') IS NULL
 THEN RAISE EXCEPTION 'PREREQUISITE_MISSING'; END IF;
END $$;
CREATE TABLE public.r36_prepared_evidence_candidates (
 payment_id text PRIMARY KEY REFERENCES public.r36_testnet_ingress_reservations(payment_id),
 network text NOT NULL CHECK(network='Pi Testnet'),
 source_wallet text NOT NULL CHECK(source_wallet ~ '^G[A-Z2-7]{55}$'),
 prepared_sequence text NOT NULL CHECK(prepared_sequence ~ '^[1-9][0-9]{0,18}$'),
 candidate jsonb NOT NULL CHECK(jsonb_typeof(candidate)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(network,source_wallet,prepared_sequence)
);
ALTER TABLE public.r36_prepared_evidence_candidates OWNER TO r36_owner;
REVOKE ALL ON public.r36_prepared_evidence_candidates FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar;
GRANT SELECT ON public.r36_prepared_evidence_candidates TO r36_evidence_reader;
GRANT SELECT (create_intent_id) ON public.payment_create_intents TO r36_owner;
CREATE FUNCTION public.r36_prepared_evidence_candidate(p_action text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE i jsonb; saved jsonb; body jsonb; res public.r36_testnet_ingress_reservations;
 cp public.settlement_checkpoints; rf public.refund_checkpoints; policy public.r36_certificate_policies;
BEGIN
 IF session_user<>'r36_runtime' OR current_setting('transaction_isolation')<>'read committed'
 OR p_action IS NULL OR p_action NOT IN ('read','stage') OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
 THEN RETURN NULL; END IF;
 i:=CASE WHEN p_action='read' THEN p_input ELSE p_input->'identity' END;
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR
 (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(i) k) IS DISTINCT FROM
 ARRAY['amountStroops','destinationWallet','network','operationId','operationKind','paymentId','piPaymentId','sourceWallet']::text[]
 OR EXISTS(SELECT 1 FROM jsonb_each(i) kv WHERE jsonb_typeof(kv.value)<>'string')
 OR i->>'network' IS DISTINCT FROM 'Pi Testnet'
 OR coalesce(i->>'paymentId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR coalesce(i->>'operationKind','') NOT IN ('settlement','refund')
 OR coalesce(i->>'operationId','') !~ '^[A-Za-z0-9_.:-]{1,128}$'
 OR coalesce(i->>'piPaymentId','') !~ '^[A-Za-z0-9_.:-]{1,128}$'
 OR coalesce(i->>'sourceWallet','') !~ '^G[A-Z2-7]{55}$'
 OR coalesce(i->>'destinationWallet','') !~ '^G[A-Z2-7]{55}$'
 OR coalesce(i->>'amountStroops','') !~ '^[1-9][0-9]{0,6}$'
 OR (i->>'amountStroops')::bigint>2000000 THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(i->>'paymentId',0));
 -- Denial metadata does not clear an old obligation or permit a new right.
 IF EXISTS(SELECT 1 FROM public.r36_legacy_right_holds WHERE identity_values && ARRAY[i->>'paymentId',i->>'operationId',i->>'piPaymentId',p_input->>'preparedHash']) THEN RETURN NULL; END IF;
 SELECT * INTO res FROM public.r36_testnet_ingress_reservations WHERE payment_id=i->>'paymentId' FOR SHARE;
 IF NOT FOUND OR res.payer_uid IS NULL OR res.payer_wallet IS NULL
 OR (res.source_wallet,res.amount_stroops::text) IS DISTINCT FROM(i->>'sourceWallet',i->>'amountStroops')
 OR i->>'destinationWallet' IS DISTINCT FROM (CASE WHEN i->>'operationKind'='settlement' THEN res.merchant_wallet ELSE res.payer_wallet END)
 THEN RETURN NULL; END IF;
 SELECT * INTO policy FROM public.r36_certificate_policies WHERE policy_digest=res.policy_digest FOR SHARE;
 IF NOT FOUND OR NOT policy.enabled OR policy.revoked
 OR extract(epoch FROM clock_timestamp()) NOT BETWEEN policy.valid_from AND least(policy.valid_until,policy.revocation_valid_until)-1
 OR policy.worker_profile->'recoveryPilot'->'ingress'->>'sourceWallet' IS DISTINCT FROM res.source_wallet
 THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.financial_wallet_activation WHERE network='Pi Testnet' AND source_wallet=res.source_wallet
 AND state='enabled' AND clearance_digest ~ '^[0-9a-f]{64}$' FOR SHARE)
 OR NOT EXISTS(SELECT 1 FROM public.payment_create_intents WHERE payment_id=res.payment_id AND merchant_uid=res.merchant_uid
 AND merchant_id=res.merchant_id AND create_intent_id=res.create_intent_id AND customer_amount*10000000=res.amount_stroops)
 THEN RETURN NULL; END IF;
 SELECT * INTO cp FROM public.settlement_checkpoints WHERE payment_id=res.payment_id;
 IF NOT FOUND OR (cp.merchant_uid,cp.merchant_id,cp.payer_uid) IS DISTINCT FROM(res.merchant_uid,res.merchant_id,res.payer_uid)
 OR cp.customer_amount*10000000 IS DISTINCT FROM res.amount_stroops::numeric OR cp.app_commission IS DISTINCT FROM 0::numeric
 OR cp.u2a_verified_at IS NULL OR cp.u2a_completed_at IS NULL OR coalesce(cp.u2a_identifier,'')='' OR coalesce(cp.u2a_txid,'') !~ '^[0-9a-f]{64}$'
 OR cp.prepared_envelope_xdr IS NOT NULL OR cp.prepared_tx_hash IS NOT NULL OR cp.prepared_sequence IS NOT NULL OR cp.a2u_txid IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.transactions WHERE payment_id=res.payment_id)
 OR EXISTS(SELECT 1 FROM public.refund_accounting_records WHERE payment_id=res.payment_id)
 OR EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts WHERE owner_payment_id=res.payment_id)
 THEN RETURN NULL; END IF;
 IF i->>'operationKind'='settlement' THEN
  IF cp.stage IS DISTINCT FROM 'a2u_created' OR cp.merchant_amount IS DISTINCT FROM cp.customer_amount
  OR (cp.a2u_payment_id,cp.a2u_from_address,cp.a2u_to_address) IS DISTINCT FROM(i->>'piPaymentId',res.source_wallet,res.merchant_wallet)
  OR i->>'operationId' IS DISTINCT FROM cp.a2u_payment_id
  OR EXISTS(SELECT 1 FROM public.refund_checkpoints WHERE payment_id=res.payment_id) THEN RETURN NULL; END IF;
 ELSE
  SELECT * INTO rf FROM public.refund_checkpoints WHERE payment_id=res.payment_id;
  IF NOT FOUND OR cp.stage IS DISTINCT FROM 'payment_identity'
  OR (rf.status,rf.stage,rf.refund_id,rf.refund_payment_id,rf.payer_uid) IS DISTINCT FROM
     ('pending','wallet_submission_started',i->>'operationId',i->>'piPaymentId',res.payer_uid)
  OR rf.amount IS DISTINCT FROM cp.customer_amount OR rf.refund_txid IS NOT NULL
  OR rf.source_payment_status IS DISTINCT FROM 'settlement_failed'
  OR rf.source_settlement_state IS DISTINCT FROM 'refund_pending'
  OR EXISTS(SELECT 1 FROM public.refund_audit_events WHERE payment_id=res.payment_id AND event_type IN ('refund_blockchain_submit_prepared','refund_blockchain_submit_authorized'))
  THEN RETURN NULL; END IF;
 END IF;
 SELECT candidate INTO saved FROM public.r36_prepared_evidence_candidates WHERE payment_id=res.payment_id;
 IF saved IS NOT NULL AND saved->'identity' IS DISTINCT FROM i THEN RETURN NULL; END IF;
 IF p_action='read' THEN
  RETURN CASE WHEN saved IS NULL THEN jsonb_build_object('state','absent') ELSE jsonb_build_object('state','present','candidate',saved) END;
 END IF;
 IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_input) k) IS DISTINCT FROM ARRAY['encryptedEnvelope','envelopeXdr','identity','preparedHash','preparedSequence','signedEnvelopeSha256']::text[]
 OR jsonb_typeof(p_input->'envelopeXdr') IS DISTINCT FROM 'string'
 OR coalesce(p_input->>'envelopeXdr','') !~ '^[A-Za-z0-9+/]+={0,2}$' OR length(p_input->>'envelopeXdr')>32768
 OR jsonb_typeof(p_input->'preparedHash') IS DISTINCT FROM 'string' OR coalesce(p_input->>'preparedHash','') !~ '^[0-9a-f]{64}$'
 OR jsonb_typeof(p_input->'preparedSequence') IS DISTINCT FROM 'string' OR coalesce(p_input->>'preparedSequence','') !~ '^[1-9][0-9]{0,18}$'
 THEN RETURN NULL; END IF;
 IF coalesce(p_input->>'signedEnvelopeSha256','') !~ '^[0-9a-f]{64}$'
 OR jsonb_typeof(p_input->'encryptedEnvelope') IS DISTINCT FROM 'object'
 OR p_input->'encryptedEnvelope'->>'schema' IS DISTINCT FROM 'R36_ENVELOPE_SEALED_V1'
 OR coalesce(p_input->'encryptedEnvelope'->>'recipientSpkiSha256','') !~ '^[0-9a-f]{64}$'
 OR p_input->'encryptedEnvelope'->>'recipientSpkiSha256' IS DISTINCT FROM policy.worker_profile->'preparedEvidenceEncryption'->>'recipientSpkiSha256'
 OR length((p_input->'encryptedEnvelope')::text)>50000 THEN RETURN NULL; END IF;
 body:=p_input||jsonb_build_object('candidateDigest',encode(sha256(convert_to(p_input::text,'UTF8')),'hex'));
 IF saved IS NOT NULL THEN
  IF (saved-ARRAY['candidateDigest','encryptedEnvelope']) IS DISTINCT FROM (body-ARRAY['candidateDigest','encryptedEnvelope'])
   OR saved->'encryptedEnvelope'->>'recipientSpkiSha256' IS DISTINCT FROM body->'encryptedEnvelope'->>'recipientSpkiSha256' THEN RETURN NULL; END IF;
  body:=saved;
 ELSE
  INSERT INTO public.r36_prepared_evidence_candidates(payment_id,network,source_wallet,prepared_sequence,candidate)
  VALUES(res.payment_id,'Pi Testnet',res.source_wallet,p_input->>'preparedSequence',body);
 END IF;
 RETURN jsonb_build_object('state','present','candidate',body);
END $$;
ALTER FUNCTION public.r36_prepared_evidence_candidate(text,jsonb) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_prepared_evidence_candidate(text,jsonb) FROM PUBLIC,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
GRANT EXECUTE ON FUNCTION public.r36_prepared_evidence_candidate(text,jsonb) TO r36_runtime;
COMMIT;
