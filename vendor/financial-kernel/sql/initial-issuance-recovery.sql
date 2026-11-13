-- Append-only recovery of an interrupted INITIAL certificate issuance.
-- Never renews an issued certificate, changes a payment/XDR/nonce, clears an
-- attempt, moves wallet authority or authorizes a financial submission.
CREATE TABLE IF NOT EXISTS public.r36_initial_issuance_windows (
 nonce text NOT NULL REFERENCES public.r36_certificate_requests(nonce),
 generation integer NOT NULL CHECK(generation>0),
 issued_at bigint NOT NULL, expires_at bigint NOT NULL CHECK(expires_at>issued_at),
 payload_digest text NOT NULL UNIQUE CHECK(payload_digest ~ '^[0-9a-f]{64}$'),
 review_digest text NOT NULL CHECK(review_digest ~ '^[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(nonce,generation)
);
ALTER TABLE public.r36_initial_issuance_windows OWNER TO r36_owner;
REVOKE ALL ON public.r36_initial_issuance_windows FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
GRANT SELECT,INSERT ON public.r36_initial_issuance_windows TO r36_registrar_owner;

CREATE OR REPLACE FUNCTION public.r36_initial_issuance_state(p_nonce text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE q public.r36_certificate_requests; p public.r36_certificate_policies;
 w public.r36_initial_issuance_windows; cert public.r36_certificate_receipts;
 s public.settlement_checkpoints; r public.refund_checkpoints;
 a public.financial_wallet_authorities; g public.financial_wallet_activation; c jsonb; b jsonb; n bigint; live boolean;
BEGIN
 IF session_user NOT IN ('r36_registrar','r36_issuer') THEN RETURN '{}'::jsonb; END IF;
 -- Callers have locked policy before request; preserve that order.
 SELECT * INTO q FROM public.r36_certificate_requests WHERE nonce=p_nonce FOR UPDATE;
 IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;
 SELECT * INTO p FROM public.r36_certificate_policies WHERE policy_digest=q.policy_digest;
 SELECT * INTO cert FROM public.r36_certificate_receipts WHERE nonce=p_nonce;
 -- An already-issued certificate keeps its exact time. Ordinary certificate
 -- renewal is a separate existing contract and overrides this context later.
 IF FOUND THEN
  SELECT * INTO w FROM public.r36_initial_issuance_windows WHERE nonce=p_nonce AND payload_digest=cert.payload_digest;
  RETURN jsonb_build_object('requestCreatedAt',cert.issued_at)||CASE WHEN FOUND THEN
   jsonb_build_object('initialIssuanceGeneration',w.generation,'requestExists',true) ELSE '{}'::jsonb END;
 END IF;
 n=floor(extract(epoch FROM clock_timestamp()))::bigint;
 IF n<floor(extract(epoch FROM q.created_at))::bigint+p.max_age_seconds THEN RETURN '{}'::jsonb; END IF;
 SELECT * INTO w FROM public.r36_initial_issuance_windows WHERE nonce=p_nonce ORDER BY generation DESC LIMIT 1;
 live=FOUND AND w.expires_at>n;
 IF session_user='r36_issuer' THEN
  IF NOT live THEN RETURN '{}'::jsonb; END IF;
  RETURN jsonb_build_object('requestCreatedAt',w.issued_at);
 END IF;
 b=q.binding;
 IF NOT p.enabled OR p.revoked OR n<p.valid_from OR n>=p.valid_until OR p.revocation_checked_at>n OR n>=p.revocation_valid_until
 OR b->>'network' IS DISTINCT FROM public.r36_network()
 OR EXISTS(SELECT 1 FROM public.r36_independent_u2a_attestations WHERE payment_id=b->>'paymentId')

 THEN RETURN jsonb_build_object('initialIssuanceUnavailable',true); END IF;
 SELECT * INTO g FROM public.financial_wallet_activation WHERE network=b->>'network' AND source_wallet=b->>'sourceWallet' FOR UPDATE;
 IF NOT FOUND OR g.state<>'enabled' OR EXISTS(SELECT 1 FROM public.r36_legacy_right_holds h
  WHERE b->>'paymentId'=ANY(h.identity_values) OR b->>'operationId'=ANY(h.identity_values) OR b->>'preparedHash'=ANY(h.identity_values))
 THEN RETURN jsonb_build_object('initialIssuanceUnavailable',true); END IF;
 SELECT * INTO a FROM public.financial_wallet_authorities WHERE network=b->>'network' AND source_wallet=b->>'sourceWallet' FOR UPDATE;
 IF FOUND AND (a.owner_payment_id=b->>'paymentId' OR a.prepared_sequence::numeric+1<>(b->>'preparedSequence')::numeric
  OR NOT EXISTS(SELECT 1 FROM public.financial_wallet_finality_seals f WHERE f.network=a.network AND f.source_wallet=a.source_wallet
    AND (f.owner_payment_id,f.operation_kind,f.owner_operation_id,f.prepared_tx_hash,f.prepared_sequence)
     =(a.owner_payment_id,a.operation_kind,a.owner_operation_id,a.prepared_tx_hash,a.prepared_sequence)))
 THEN RETURN jsonb_build_object('initialIssuanceUnavailable',true); END IF;
 IF EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts WHERE network=b->>'network'
  AND (owner_payment_id=b->>'paymentId' OR source_wallet=b->>'sourceWallet' AND (prepared_tx_hash=b->>'preparedHash' OR prepared_sequence=b->>'preparedSequence')))
 OR EXISTS(SELECT 1 FROM public.financial_wallet_authority_history WHERE network=b->>'network'
  AND (owner_payment_id=b->>'paymentId' OR source_wallet=b->>'sourceWallet' AND (prepared_tx_hash=b->>'preparedHash' OR prepared_sequence=b->>'preparedSequence')))
 OR EXISTS(SELECT 1 FROM public.financial_wallet_finality_seals WHERE network=b->>'network' AND owner_payment_id=b->>'paymentId')
 THEN RETURN jsonb_build_object('initialIssuanceUnavailable',true); END IF;
 SELECT * INTO s FROM public.settlement_checkpoints WHERE payment_id=b->>'paymentId' FOR SHARE;
 IF NOT FOUND OR s.u2a_identifier IS DISTINCT FROM b->>'piPaymentId' OR s.u2a_txid IS DISTINCT FROM b->>'u2aTxid'
 OR s.u2a_verified_at IS NULL OR s.u2a_completed_at IS NULL OR NOT public.r36_contract_valid(to_jsonb(s))
 OR public.r36_contract_outgoing_stroops(s.payment_id,b->>'operationKind') IS DISTINCT FROM b->>'amountStroops'
 OR s.a2u_txid IS NOT NULL OR s.horizon_confirmed_at IS NOT NULL OR s.pi_completed_at IS NOT NULL OR s.db_finalized_at IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.transactions WHERE payment_id=s.u2a_identifier)
 OR EXISTS(SELECT 1 FROM public.receipts WHERE u2a_identifier=s.u2a_identifier)
 OR EXISTS(SELECT 1 FROM public.refund_accounting_records WHERE payment_id=s.payment_id)
 THEN RETURN jsonb_build_object('initialIssuanceUnavailable',true); END IF;
 SELECT candidate INTO c FROM public.r36_prepared_evidence_candidates WHERE payment_id=s.payment_id
  AND network=b->>'network' AND source_wallet=b->>'sourceWallet' AND prepared_sequence=b->>'preparedSequence';
 IF NOT FOUND OR c->>'preparedHash' IS DISTINCT FROM b->>'preparedHash'
 OR c->>'signedEnvelopeSha256' IS DISTINCT FROM b->>'envelopeXdrTextSha256'
 OR c->'identity'->>'paymentId' IS DISTINCT FROM b->>'paymentId'
 OR c->'identity'->>'operationKind' IS DISTINCT FROM b->>'operationKind'
 OR c->'identity'->>'operationId' IS DISTINCT FROM b->>'operationId'
 OR c->'identity'->>'destinationWallet' IS DISTINCT FROM b->>'destinationWallet'
 OR c->'identity'->>'amountStroops' IS DISTINCT FROM b->>'amountStroops'
 THEN RETURN jsonb_build_object('initialIssuanceUnavailable',true); END IF;
 IF b->>'operationKind'='settlement' THEN
  IF s.stage<>'a2u_created' OR s.a2u_payment_id IS DISTINCT FROM b->>'operationId'
  OR s.a2u_from_address IS DISTINCT FROM b->>'sourceWallet' OR s.a2u_to_address IS DISTINCT FROM b->>'destinationWallet'
  OR s.prepared_tx_hash IS NOT NULL OR s.prepared_sequence IS NOT NULL OR s.prepared_envelope_xdr IS NOT NULL
  OR EXISTS(SELECT 1 FROM public.refund_checkpoints WHERE payment_id=s.payment_id)
  THEN RETURN jsonb_build_object('initialIssuanceUnavailable',true); END IF;
 ELSIF b->>'operationKind'='refund' THEN
  SELECT * INTO r FROM public.refund_checkpoints WHERE refund_id=b->>'operationId' AND payment_id=s.payment_id;
  IF NOT FOUND OR s.stage<>'payment_identity' OR r.status<>'pending' OR r.stage<>'wallet_submission_started'
  OR r.refund_txid IS NOT NULL OR r.payer_uid IS DISTINCT FROM s.payer_uid OR r.amount<>s.customer_amount
  OR NOT EXISTS(SELECT 1 FROM public.refund_audit_events e WHERE e.payment_id=s.payment_id AND e.refund_id=r.refund_id
   AND e.event_type='refund_blockchain_submit_prepared' AND e.actor_type='system' AND e.idempotency_key=r.idempotency_key
   AND e.details->>'preparedHash'=b->>'preparedHash' AND e.details->>'preparedSequence'=b->>'preparedSequence'
   AND e.details->>'refundPaymentId'=r.refund_payment_id
   AND encode(sha256(convert_to(e.details->>'envelopeXdr','UTF8')),'hex')=b->>'envelopeXdrTextSha256')
  THEN RETURN jsonb_build_object('initialIssuanceUnavailable',true); END IF;
 ELSE RETURN jsonb_build_object('initialIssuanceUnavailable',true); END IF;
 RETURN jsonb_build_object('initialIssuanceGeneration',CASE WHEN live THEN w.generation ELSE coalesce(w.generation,0)+1 END,
  'requestExists',live,'requestCreatedAt',CASE WHEN live THEN w.issued_at ELSE n END);
END $$;
ALTER FUNCTION public.r36_initial_issuance_state(text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_initial_issuance_state(text) FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
GRANT EXECUTE ON FUNCTION public.r36_initial_issuance_state(text) TO r36_registrar_owner;

CREATE OR REPLACE FUNCTION public.r36_certificate_context(p_nonce text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE p public.r36_certificate_policies; r public.r36_certificate_requests; now_s bigint;
BEGIN
 IF session_user<>'r36_issuer' THEN RETURN NULL; END IF;
 -- Lock policy before request everywhere to avoid reversed-lock deadlocks.
 SELECT x.* INTO p FROM public.r36_certificate_policies x JOIN public.r36_certificate_requests q ON q.policy_digest=x.policy_digest
 WHERE q.nonce=p_nonce FOR SHARE OF x;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO r FROM public.r36_certificate_requests WHERE nonce=p_nonce FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 now_s=floor(extract(epoch from clock_timestamp()))::bigint;
 IF NOT p.enabled OR p.revoked OR now_s<p.valid_from OR now_s>=p.valid_until OR p.revocation_checked_at>now_s OR now_s>=p.revocation_valid_until THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('binding',r.binding,'nowSeconds',now_s,
  'requestCreatedAt',floor(extract(epoch from r.created_at))::bigint,
  'receipt',(SELECT jsonb_build_object('manifest',c.manifest,'signature',c.signature_base64)
    FROM public.r36_certificate_receipts c WHERE c.nonce=p_nonce),
  'policy',jsonb_build_object(
  'policyDigest',p.policy_digest,'issuerId',p.issuer_id,'keyId',p.key_id,'publicKeyPem',p.public_key_pem,
  'publicKeySpkiSha256',p.public_key_spki_sha256,'enabled',p.enabled,'revoked',p.revoked,
  'validFrom',p.valid_from,'validUntil',p.valid_until,'maxAgeSeconds',p.max_age_seconds,
  'revocationCheckedAt',p.revocation_checked_at,'revocationValidUntil',p.revocation_valid_until,
  'approvalRecordDigest',p.approval_record_digest,'workerProfile',p.worker_profile)) || public.r36_initial_issuance_state(p_nonce) || public.r36_renewal_issuer_state(p_nonce);
END $$;

CREATE OR REPLACE FUNCTION r36_registration.context(p_policy text, p_nonce text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
DECLARE p public.r36_certificate_policies; r public.r36_certificate_requests; n bigint;
BEGIN
 IF session_user<>'r36_registrar' OR p_policy IS NULL OR p_policy !~ '^[0-9a-f]{64}$'
 OR p_nonce IS NULL OR p_nonce !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
 SELECT * INTO p FROM public.r36_certificate_policies WHERE policy_digest=p_policy FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('FLASHpay:R36:REGISTRATION:'||p_nonce,0));
 SELECT * INTO r FROM public.r36_certificate_requests WHERE nonce=p_nonce;
 IF FOUND AND r.policy_digest<>p_policy THEN RETURN NULL; END IF;
 n=floor(extract(epoch from clock_timestamp()))::bigint;
 IF NOT p.enabled OR p.revoked OR n<p.valid_from OR n>=p.valid_until OR p.revocation_checked_at>n OR n>=p.revocation_valid_until
 THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM r36_signing.requests x WHERE x.policy_digest=p_policy AND x.revoked
  AND position(('"'||p_nonce||'"') in convert_from(decode(x.bytes_base64,'base64'),'UTF8'))>0) THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('nowSeconds',n,'requestExists',r.nonce IS NOT NULL,'requestCreatedAt',coalesce(floor(extract(epoch from r.created_at))::bigint,n),
 'policy',jsonb_build_object('policyDigest',p.policy_digest,'issuerId',p.issuer_id,'keyId',p.key_id,
 'publicKeyPem',p.public_key_pem,'publicKeySpkiSha256',p.public_key_spki_sha256,'enabled',p.enabled,'revoked',p.revoked,
 'validFrom',p.valid_from,'validUntil',p.valid_until,'maxAgeSeconds',p.max_age_seconds,
 'revocationCheckedAt',p.revocation_checked_at,'revocationValidUntil',p.revocation_valid_until,
 'approvalRecordDigest',p.approval_record_digest,'workerProfile',p.worker_profile)) || public.r36_initial_issuance_state(p_nonce) || public.r36_renewal_registration_state(p_policy,p_nonce);
END $_$;

CREATE OR REPLACE FUNCTION r36_registration.enroll(p_policy text, b jsonb, p_bytes text, p_digest text, p_issued bigint, p_expires bigint, p_review text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
DECLARE ctx jsonb; p jsonb; n bigint; nonce_value text; existing public.r36_certificate_requests;
 signed_request r36_signing.requests; inserted boolean; vals text[]; canonical text; encoded text;
 names text[]:=ARRAY['network','sourceWallet','paymentId','operationKind','operationId','preparedHash','preparedSequence',
 'piPaymentId','u2aTxid','destinationWallet','amountStroops','envelopeXdrTextSha256','immutableIntentDigest','inboundFinalityDigest',
 'walletHistoryDigest','accountingDigest','clearanceDigest','exceptionsDigest','exceptionIsolationDigest','cutoffLedger','nonce'];
 k text; w public.r36_initial_issuance_windows; gen integer;
BEGIN
 IF session_user<>'r36_registrar' THEN RAISE EXCEPTION 'PROTECTED_REGISTRAR_REQUIRED'; END IF;
 IF b IS NULL OR jsonb_typeof(b)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(b))<>cardinality(names)
 OR NOT (b ?& names) OR p_review IS NULL OR p_review !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_BINDING'; END IF;
 FOREACH k IN ARRAY names LOOP
  IF jsonb_typeof(b->k)<>'string' OR length(b->>k) NOT BETWEEN 1 AND 256 OR b->>k ~ '[^ -~]'
  THEN RAISE EXCEPTION 'INVALID_BINDING_FIELD'; END IF;
 END LOOP;
 nonce_value=b->>'nonce';
 IF b->>'network'<>public.r36_network() OR b->>'operationKind' NOT IN ('settlement','refund')
 OR b->>'sourceWallet' !~ '^G[A-Z2-7]{55}$' OR b->>'destinationWallet' !~ '^G[A-Z2-7]{55}$'
 THEN RAISE EXCEPTION 'INVALID_SCOPE'; END IF;
 FOREACH k IN ARRAY ARRAY['paymentId','operationId','piPaymentId'] LOOP
  IF b->>k !~ '^[A-Za-z0-9_.:-]{1,128}$' THEN RAISE EXCEPTION 'INVALID_IDENTITY'; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['preparedSequence','amountStroops','cutoffLedger'] LOOP
  IF b->>k !~ '^[1-9][0-9]{0,29}$' THEN RAISE EXCEPTION 'INVALID_NUMERIC_BINDING'; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['preparedHash','u2aTxid','envelopeXdrTextSha256','immutableIntentDigest','inboundFinalityDigest',
 'walletHistoryDigest','accountingDigest','clearanceDigest','exceptionsDigest','exceptionIsolationDigest','nonce'] LOOP
  IF b->>k !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_DIGEST'; END IF;
 END LOOP;
 ctx=r36_registration.context(p_policy,nonce_value);
 IF ctx IS NULL THEN RAISE EXCEPTION 'REGISTRATION_CONTEXT_UNAVAILABLE'; END IF;
 p=ctx->'policy'; n=(ctx->>'nowSeconds')::bigint;
 IF p_issued IS NULL OR p_expires IS NULL OR ((ctx->>'requestExists')::boolean AND p_issued<>(ctx->>'requestCreatedAt')::bigint) OR p_issued>n
 OR p_issued<(p->>'validFrom')::bigint OR p_expires<>least((p->>'validUntil')::bigint,p_issued+(p->>'maxAgeSeconds')::bigint)
 OR p_expires<=n OR p_expires<=p_issued OR (p->>'revocationCheckedAt')::bigint<p_issued
 OR p->>'issuerId' !~ '^[A-Za-z0-9_.:-]{1,128}$' OR p->>'keyId' !~ '^[A-Za-z0-9_.:-]{1,128}$'
 THEN RAISE EXCEPTION 'STALE_OR_INVALID_APPROVAL'; END IF;
 vals=ARRAY['R36_ADMISSION_CERTIFICATE_V1','INITIAL_PREPARED_ADMISSION',p->>'issuerId',p->>'keyId',p_policy];
 FOREACH k IN ARRAY names LOOP vals=array_append(vals,b->>k); END LOOP;
 vals=array_append(array_append(vals,p_issued::text),p_expires::text);
 SELECT E'FLASHpay:R36:INITIAL_ADMISSION:V1\n['||string_agg(to_json(v)::text,',' ORDER BY ord)||']'
 INTO canonical FROM unnest(vals) WITH ORDINALITY AS t(v,ord);
 encoded=replace(encode(convert_to(canonical,'UTF8'),'base64'),E'\n','');
 IF p_bytes IS NULL OR p_bytes<>encoded OR p_digest IS NULL OR p_digest<>encode(sha256(convert_to(canonical,'UTF8')),'hex')
 THEN RAISE EXCEPTION 'EXACT_SIGNING_PAYLOAD_REQUIRED'; END IF;
 IF ctx->>'initialIssuanceUnavailable'='true' THEN RAISE EXCEPTION 'INITIAL_ISSUANCE_UNAVAILABLE'; END IF;
 IF ctx->>'renewalUnavailable'='true' THEN RAISE EXCEPTION 'RENEWAL_UNAVAILABLE'; END IF;
 IF ctx ? 'renewalGeneration' THEN
  inserted=public.r36_store_renewal_request(p_policy,b,p_digest,p_issued,p_expires,p_review);
 ELSIF ctx ? 'initialIssuanceGeneration' THEN
  gen=(ctx->>'initialIssuanceGeneration')::integer;
  SELECT * INTO existing FROM public.r36_certificate_requests WHERE nonce=nonce_value;
  IF NOT FOUND OR existing.policy_digest<>p_policy OR existing.binding<>b
  OR p_issued<floor(extract(epoch FROM existing.created_at))::bigint+(p->>'maxAgeSeconds')::bigint
  OR p_review<>encode(sha256(convert_to(E'FLASHpay:R36:INITIAL_ISSUANCE_REVIEW:V1\n'||p_policy||E'\n'||nonce_value||E'\n'||p_digest||E'\n'||gen::text,'UTF8')),'hex')
  THEN RAISE EXCEPTION 'INITIAL_ISSUANCE_BINDING_CONFLICT'; END IF;
  INSERT INTO public.r36_initial_issuance_windows(nonce,generation,issued_at,expires_at,payload_digest,review_digest)
   VALUES(nonce_value,gen,p_issued,p_expires,p_digest,p_review) ON CONFLICT DO NOTHING;
  inserted=FOUND;
  SELECT * INTO w FROM public.r36_initial_issuance_windows WHERE nonce=nonce_value AND generation=gen;
  IF NOT FOUND OR (w.issued_at,w.expires_at,w.payload_digest,w.review_digest) IS DISTINCT FROM (p_issued,p_expires,p_digest,p_review)
  THEN RAISE EXCEPTION 'INITIAL_ISSUANCE_REPLAY_CONFLICT'; END IF;
 ELSE
 SELECT * INTO existing FROM public.r36_certificate_requests WHERE nonce=nonce_value;
 inserted=NOT FOUND;
 IF NOT inserted AND (existing.policy_digest<>p_policy OR existing.binding<>b OR floor(extract(epoch from existing.created_at))::bigint<>p_issued)
 THEN RAISE EXCEPTION 'REGISTRATION_REPLAY_CONFLICT'; END IF;
 IF inserted THEN
  INSERT INTO public.r36_certificate_requests(nonce,policy_digest,binding,created_at) VALUES(nonce_value,p_policy,b,to_timestamp(p_issued));
 END IF;
 END IF;
 INSERT INTO r36_signing.requests(idempotency_key,issuer_id,key_id,policy_digest,bytes_base64,public_key_pin,
 approved_by,approval_digest,valid_from,valid_until,revoked)
 VALUES(p_digest,p->>'issuerId',p->>'keyId',p_policy,p_bytes,p->>'publicKeySpkiSha256',session_user,p_review,p_issued,p_expires,false)
 ON CONFLICT DO NOTHING;
 SELECT * INTO signed_request FROM r36_signing.requests WHERE idempotency_key=p_digest;
 IF NOT FOUND OR signed_request.revoked OR signed_request.issuer_id<>p->>'issuerId' OR signed_request.key_id<>p->>'keyId'
 OR signed_request.policy_digest<>p_policy OR signed_request.bytes_base64<>p_bytes OR signed_request.public_key_pin<>p->>'publicKeySpkiSha256'
 OR signed_request.approved_by<>session_user OR signed_request.approval_digest<>p_review OR signed_request.valid_from<>p_issued
 OR signed_request.valid_until<>p_expires THEN RAISE EXCEPTION 'SIGNING_APPROVAL_CONFLICT'; END IF;
 RETURN CASE WHEN inserted THEN 'ENROLLED' ELSE 'REPLAYED' END;
END $_$;
