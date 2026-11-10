-- NOT_FOR_DEPLOY package: install only after verified backup/restore and exact-source qualification.
-- No policy, key, expiry extension, attempt reset, accounting write or financial POST.
BEGIN;
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='60s';
DO $$ BEGIN
 IF current_setting('flashpay.isolated_certificate_test',true) IS DISTINCT FROM 'yes'
 AND (session_user<>'neondb_owner' OR current_setting('neon.branch_id',true) IS DISTINCT FROM 'br-tiny-mode-aliatv40')
 THEN RAISE EXCEPTION 'RENEWAL_TARGET_NOT_APPROVED'; END IF;
 IF current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999 THEN RAISE EXCEPTION 'RENEWAL_ENGINE_VERSION'; END IF;
 IF session_user='neondb_owner' AND (pg_has_role(session_user,'r36_owner','SET') OR pg_has_role(session_user,'r36_registrar_owner','SET') OR pg_has_role(session_user,'r36_owner','USAGE') OR pg_has_role(session_user,'r36_registrar_owner','USAGE'))
 THEN RAISE EXCEPTION 'RENEWAL_UNEXPECTED_MEMBERSHIP'; END IF;
 IF current_database()<>'neondb' OR current_user<>session_user OR to_regclass('public.r36_admission_renewal_requests') IS NOT NULL
 THEN RAISE EXCEPTION 'RENEWAL_INSTALL_TARGET_OR_ALREADY_INSTALLED'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.r36_certificate_allows(text, text, text, text, text, text, text)'::regprocedure) IS DISTINCT FROM 'b9008c8a843aa5f66fcece38fbb7d08c28fd2508db72b974dc306efc5f9acb25' THEN RAISE EXCEPTION 'RENEWAL_BASELINE_CHANGED'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.r36_certificate_context(text)'::regprocedure) IS DISTINCT FROM '1bcbaab027eeb0c7de8d2fb6cc46a0e4c64c04e975b4dd88a2c47498052cc2b2' THEN RAISE EXCEPTION 'RENEWAL_BASELINE_CHANGED'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.r36_claim_first_submission(text, text, text, text, text, text, text)'::regprocedure) IS DISTINCT FROM '8990cd500853346470a05e5b132d552b35f8ddfbd43e841ae3b72163819f95d3' THEN RAISE EXCEPTION 'RENEWAL_BASELINE_CHANGED'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.r36_record_certificate(text, text, jsonb, text)'::regprocedure) IS DISTINCT FROM '72929c8f704671db87d376f4aaa04e8b20d3b396f31590b75339c17b774a039f' THEN RAISE EXCEPTION 'RENEWAL_BASELINE_CHANGED'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.r36_reserve_new_recovery(text, text)'::regprocedure) IS DISTINCT FROM 'a7bb3247e8eca09d0c4f1a22e18f956ea43c85f927ff1bcc8cf9dbd6fdd325e3' THEN RAISE EXCEPTION 'RENEWAL_BASELINE_CHANGED'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.r36_revoke_certificate(text, text)'::regprocedure) IS DISTINCT FROM 'bd3523461546ca0bd3b13e0b6a70b027422e87d271f2d3db139fdd0b9f9773c3' THEN RAISE EXCEPTION 'RENEWAL_BASELINE_CHANGED'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='r36_registration.context(text, text)'::regprocedure) IS DISTINCT FROM 'd00836aadd3b18ac09433c3a46159b265904a1290df56d197f0837a216f8a47e' THEN RAISE EXCEPTION 'RENEWAL_BASELINE_CHANGED'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='r36_registration.enroll(text, jsonb, text, text, bigint, bigint, text)'::regprocedure) IS DISTINCT FROM '01e06105e3a614b86716fff06f9db31243dded018d4e46589cb70b82f7762805' THEN RAISE EXCEPTION 'RENEWAL_BASELINE_CHANGED'; END IF;
END $$;
DO $$ BEGIN IF session_user='neondb_owner' THEN
 GRANT r36_owner TO neondb_owner WITH INHERIT FALSE,SET TRUE;
 GRANT r36_registrar_owner TO neondb_owner WITH INHERIT FALSE,SET TRUE;
END IF; END $$;
GRANT CREATE ON SCHEMA public TO r36_owner;
SET LOCAL ROLE r36_owner;
-- Development candidate only. Append-only revalidation of an existing unspent right.
CREATE TABLE public.r36_admission_renewal_requests (
 nonce text NOT NULL REFERENCES public.r36_certificate_requests(nonce),
 generation integer NOT NULL CHECK(generation>0),
 original_payload_digest text NOT NULL REFERENCES public.r36_certificate_receipts(payload_digest),
 binding jsonb NOT NULL CHECK(jsonb_typeof(binding)='object' AND binding->>'nonce'=nonce),
 issued_at bigint NOT NULL, expires_at bigint NOT NULL CHECK(expires_at>issued_at),
 evidence_not_before bigint NOT NULL CHECK(issued_at>=evidence_not_before),
 payload_digest text NOT NULL UNIQUE CHECK(payload_digest ~ '^[0-9a-f]{64}$'),
 review_digest text NOT NULL CHECK(review_digest ~ '^[0-9a-f]{64}$'),
 recorded_by text NOT NULL CHECK(recorded_by='r36_registrar'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(nonce,generation)
);
CREATE TABLE public.r36_admission_renewal_receipts (
 nonce text NOT NULL, generation integer NOT NULL,
 payload_digest text NOT NULL UNIQUE REFERENCES public.r36_admission_renewal_requests(payload_digest),
 manifest jsonb NOT NULL, signature_base64 text NOT NULL,
 issued_at bigint NOT NULL, expires_at bigint NOT NULL CHECK(expires_at>issued_at),
 verified_by text NOT NULL CHECK(verified_by='r36_issuer'),
 verified_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(nonce,generation),
 FOREIGN KEY(nonce,generation) REFERENCES public.r36_admission_renewal_requests(nonce,generation)
);
CREATE TABLE public.r36_admission_renewal_revocations (
 payload_digest text PRIMARY KEY REFERENCES public.r36_admission_renewal_receipts(payload_digest),
 reason_digest text NOT NULL CHECK(reason_digest ~ '^[0-9a-f]{64}$'),
 revoked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['r36_admission_renewal_requests','r36_admission_renewal_receipts','r36_admission_renewal_revocations'] LOOP
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader',t);
  EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.r36_execution_scope_immutable()',t);
  EXECUTE format('CREATE TRIGGER no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.r36_execution_scope_immutable()',t);
 END LOOP;
END $$;
-- Internal only: called under the protected registration/issuer functions.
-- Lock the original request BEFORE the wallet authority, as the Runtime does.
CREATE FUNCTION public.r36_renewal_unspent(p_nonce text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE b jsonb; original text; a public.financial_wallet_authorities; g public.financial_wallet_activation; s public.settlement_checkpoints; r public.refund_checkpoints;
BEGIN
 IF session_user NOT IN ('r36_registrar','r36_issuer') THEN RETURN false; END IF;
 SELECT q.binding,c.payload_digest INTO b,original FROM public.r36_certificate_requests q JOIN public.r36_certificate_receipts c USING(nonce)
 WHERE q.nonce=p_nonce FOR UPDATE OF q;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.r36_certificate_revocations WHERE payload_digest=original) THEN RETURN false; END IF;
 SELECT * INTO g FROM public.financial_wallet_activation WHERE network=b->>'network' AND source_wallet=b->>'sourceWallet' FOR UPDATE;
 IF NOT FOUND OR g.state<>'enabled' OR g.clearance_digest IS DISTINCT FROM b->>'clearanceDigest' THEN RETURN false; END IF;
 SELECT * INTO a FROM public.financial_wallet_authorities WHERE network=g.network AND source_wallet=g.source_wallet FOR UPDATE;
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
END $$;
-- Returns authoritative deadlines, never extends an existing certificate.
CREATE FUNCTION public.r36_admission_expiry(p_nonce text,p_original text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE base public.r36_certificate_receipts; fresh public.r36_admission_renewal_receipts; req public.r36_admission_renewal_requests; p public.r36_certificate_policies; n bigint;
BEGIN
 SELECT c.* INTO base FROM public.r36_certificate_receipts c WHERE c.nonce=p_nonce AND c.payload_digest=p_original;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.r36_certificate_revocations WHERE payload_digest=p_original) THEN RETURN 0; END IF;
 SELECT c.* INTO fresh FROM public.r36_admission_renewal_receipts c WHERE c.nonce=p_nonce ORDER BY generation DESC LIMIT 1;
 IF NOT FOUND THEN RETURN base.expires_at; END IF;
 SELECT * INTO req FROM public.r36_admission_renewal_requests WHERE nonce=p_nonce AND generation=fresh.generation;
 SELECT x.* INTO p FROM public.r36_certificate_policies x JOIN public.r36_certificate_requests q ON q.policy_digest=x.policy_digest WHERE q.nonce=p_nonce;
 n=floor(extract(epoch FROM clock_timestamp()))::bigint;
 IF req.original_payload_digest<>p_original OR fresh.payload_digest<>req.payload_digest OR fresh.issued_at<>req.issued_at OR fresh.expires_at<>req.expires_at
 OR fresh.verified_by<>'r36_issuer' OR NOT p.enabled OR p.revoked OR p.revocation_checked_at<fresh.issued_at OR p.revocation_checked_at>n
 OR n>=p.revocation_valid_until OR fresh.issued_at>n OR fresh.expires_at>p.valid_until OR fresh.expires_at-fresh.issued_at>p.max_age_seconds
 OR EXISTS(SELECT 1 FROM public.r36_admission_renewal_revocations WHERE payload_digest=fresh.payload_digest)
 OR fresh.manifest IS DISTINCT FROM req.binding||jsonb_build_object('schema','R36_ADMISSION_CERTIFICATE_V1','purpose','INITIAL_PREPARED_ADMISSION',
 'issuerId',p.issuer_id,'keyId',p.key_id,'policyDigest',p.policy_digest,'issuedAt',fresh.issued_at::text,'expiresAt',fresh.expires_at::text)
 THEN RETURN 0; END IF;
 RETURN fresh.expires_at;
END $$;
REVOKE ALL ON FUNCTION public.r36_renewal_unspent(text),public.r36_admission_expiry(text,text) FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
CREATE FUNCTION public.r36_renewal_registration_state(p_policy text,p_nonce text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE base public.r36_certificate_receipts; req public.r36_admission_renewal_requests; p public.r36_certificate_policies; n bigint; floor_time bigint; gen integer; live boolean;
BEGIN
 IF session_user<>'r36_registrar' THEN RETURN '{}'::jsonb; END IF;
 SELECT c.* INTO base FROM public.r36_certificate_receipts c JOIN public.r36_certificate_requests q USING(nonce) WHERE q.nonce=p_nonce AND q.policy_digest=p_policy;
 IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;
 n=floor(extract(epoch FROM clock_timestamp()))::bigint;
 IF base.expires_at>n THEN RETURN '{}'::jsonb; END IF;
 IF EXISTS(SELECT 1 FROM public.r36_admission_renewal_revocations v JOIN public.r36_admission_renewal_receipts c USING(payload_digest) WHERE c.nonce=p_nonce)
 OR NOT public.r36_renewal_unspent(p_nonce) THEN RETURN jsonb_build_object('renewalUnavailable',true); END IF;
 SELECT * INTO p FROM public.r36_certificate_policies WHERE policy_digest=p_policy;
 SELECT * INTO req FROM public.r36_admission_renewal_requests WHERE nonce=p_nonce ORDER BY generation DESC LIMIT 1;
 live=FOUND AND req.expires_at>n;
 floor_time=CASE WHEN live THEN req.evidence_not_before ELSE greatest(base.expires_at,coalesce(req.expires_at,base.expires_at)) END;
 gen=CASE WHEN live THEN req.generation ELSE coalesce(req.generation,0)+1 END;
 RETURN jsonb_build_object('renewalGeneration',gen,'requestExists',live,'requestCreatedAt',CASE WHEN live THEN req.issued_at ELSE n END,
  'evidenceNotBefore',floor_time,'originalPayloadDigest',base.payload_digest);
END $$;
CREATE FUNCTION public.r36_store_renewal_request(p_policy text,b jsonb,p_digest text,p_issued bigint,p_expires bigint,p_review text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE ctx jsonb; original jsonb; prior public.r36_admission_renewal_requests; k text; gen integer; inserted boolean;
BEGIN
 IF session_user<>'r36_registrar' THEN RAISE EXCEPTION 'PROTECTED_REGISTRAR_REQUIRED'; END IF;
 ctx=public.r36_renewal_registration_state(p_policy,b->>'nonce');
 IF ctx->>'renewalGeneration' IS NULL OR ctx->>'renewalUnavailable'='true' THEN RAISE EXCEPTION 'RENEWAL_NOT_UNSPENT'; END IF;
 gen=(ctx->>'renewalGeneration')::integer;
 IF p_review IS DISTINCT FROM encode(sha256(convert_to(E'FLASHpay:R36:RENEWAL_REVIEW:V1\n'||p_policy||E'\n'||(b->>'nonce')||E'\n'||p_digest||E'\n'||gen::text||E'\n'||(ctx->>'evidenceNotBefore'),'UTF8')),'hex')
 THEN RAISE EXCEPTION 'RENEWAL_VERIFIER_VERSION_REQUIRED'; END IF;
 SELECT binding INTO original FROM public.r36_certificate_requests WHERE nonce=b->>'nonce' AND policy_digest=p_policy;
 IF NOT FOUND OR jsonb_typeof(b)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(b))<>21 THEN RAISE EXCEPTION 'RENEWAL_BINDING'; END IF;
 FOREACH k IN ARRAY ARRAY['network','sourceWallet','paymentId','operationKind','operationId','preparedHash','preparedSequence','piPaymentId','u2aTxid','destinationWallet','amountStroops','envelopeXdrTextSha256','immutableIntentDigest','nonce'] LOOP
  IF b->>k IS DISTINCT FROM original->>k THEN RAISE EXCEPTION 'RENEWAL_FINANCIAL_IDENTITY_CHANGED'; END IF;
 END LOOP;
 IF (b->>'cutoffLedger')::numeric<(original->>'cutoffLedger')::numeric OR p_issued<(ctx->>'evidenceNotBefore')::bigint
 OR p_digest !~ '^[0-9a-f]{64}$' OR p_review !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'RENEWAL_EVIDENCE_BINDING'; END IF;
 SELECT * INTO prior FROM public.r36_admission_renewal_requests WHERE nonce=b->>'nonce' AND generation=gen;
 inserted=NOT FOUND;
 IF NOT inserted AND (prior.binding,prior.payload_digest,prior.issued_at,prior.expires_at,prior.review_digest)
 IS DISTINCT FROM (b,p_digest,p_issued,p_expires,p_review) THEN RAISE EXCEPTION 'RENEWAL_REGISTRATION_REPLAY_CONFLICT'; END IF;
 IF inserted THEN
  INSERT INTO public.r36_admission_renewal_requests(nonce,generation,original_payload_digest,binding,issued_at,expires_at,evidence_not_before,payload_digest,review_digest,recorded_by)
  VALUES(b->>'nonce',gen,ctx->>'originalPayloadDigest',b,p_issued,p_expires,(ctx->>'evidenceNotBefore')::bigint,p_digest,p_review,session_user);
 END IF;
 RETURN inserted;
END $$;
CREATE FUNCTION public.r36_renewal_issuer_state(p_nonce text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE req public.r36_admission_renewal_requests;
BEGIN
 IF session_user<>'r36_issuer' THEN RETURN '{}'::jsonb; END IF;
 SELECT * INTO req FROM public.r36_admission_renewal_requests WHERE nonce=p_nonce ORDER BY generation DESC LIMIT 1;
 IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;
 RETURN jsonb_build_object('binding',req.binding,'requestCreatedAt',req.issued_at,'renewalGeneration',req.generation,'evidenceNotBefore',req.evidence_not_before,
 'receipt',(SELECT jsonb_build_object('manifest',c.manifest,'signature',c.signature_base64) FROM public.r36_admission_renewal_receipts c WHERE c.nonce=p_nonce AND c.generation=req.generation));
END $$;
CREATE FUNCTION public.r36_record_renewal_receipt(p_nonce text,p_digest text,m jsonb,p_signature text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE req public.r36_admission_renewal_requests; old public.r36_admission_renewal_receipts; p public.r36_certificate_policies; n bigint;
BEGIN
 IF session_user<>'r36_issuer' THEN RAISE EXCEPTION 'TRUSTED_CONSUMER_REQUIRED'; END IF;
 SELECT * INTO req FROM public.r36_admission_renewal_requests WHERE nonce=p_nonce ORDER BY generation DESC LIMIT 1;
 IF NOT FOUND OR req.payload_digest<>p_digest OR m->>'issuedAt' IS DISTINCT FROM req.issued_at::text OR m->>'expiresAt' IS DISTINCT FROM req.expires_at::text
 THEN RAISE EXCEPTION 'RENEWAL_APPROVAL_REQUIRED'; END IF;
 SELECT * INTO old FROM public.r36_admission_renewal_receipts WHERE nonce=p_nonce AND generation=req.generation;
 IF FOUND THEN
  IF old.payload_digest=p_digest AND old.manifest=m AND old.signature_base64=p_signature
  AND NOT EXISTS(SELECT 1 FROM public.r36_admission_renewal_revocations WHERE payload_digest=p_digest) THEN RETURN 'REPLAYED'; END IF;
  RAISE EXCEPTION 'RENEWAL_CERTIFICATE_REPLAY_CONFLICT';
 END IF;
 IF NOT public.r36_renewal_unspent(p_nonce) THEN RAISE EXCEPTION 'RENEWAL_ATTEMPT_OR_OWNER_CHANGED'; END IF;
 SELECT x.* INTO p FROM public.r36_certificate_policies x JOIN public.r36_certificate_requests q ON q.policy_digest=x.policy_digest WHERE q.nonce=p_nonce;
 n=floor(extract(epoch FROM clock_timestamp()))::bigint;
 IF NOT p.enabled OR p.revoked OR n>=least(p.valid_until,p.revocation_valid_until,req.expires_at) OR n<req.issued_at OR p.revocation_checked_at<req.issued_at
 OR EXISTS(SELECT 1 FROM public.r36_admission_renewal_revocations v JOIN public.r36_admission_renewal_receipts c USING(payload_digest) WHERE c.nonce=p_nonce)
 OR m IS DISTINCT FROM req.binding||jsonb_build_object('schema','R36_ADMISSION_CERTIFICATE_V1','purpose','INITIAL_PREPARED_ADMISSION',
 'issuerId',p.issuer_id,'keyId',p.key_id,'policyDigest',p.policy_digest,'issuedAt',req.issued_at::text,'expiresAt',req.expires_at::text)
 THEN RAISE EXCEPTION 'RENEWAL_EXPIRED_OR_REVOKED'; END IF;
 INSERT INTO public.r36_admission_renewal_receipts(nonce,generation,payload_digest,manifest,signature_base64,issued_at,expires_at,verified_by)
 VALUES(p_nonce,req.generation,p_digest,m,p_signature,req.issued_at,req.expires_at,session_user);
 RETURN 'RECORDED';
END $$;
REVOKE ALL ON FUNCTION public.r36_renewal_registration_state(text,text),public.r36_store_renewal_request(text,jsonb,text,bigint,bigint,text),public.r36_renewal_issuer_state(text),public.r36_record_renewal_receipt(text,text,jsonb,text)
 FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
GRANT EXECUTE ON FUNCTION public.r36_renewal_registration_state(text,text),public.r36_store_renewal_request(text,jsonb,text,bigint,bigint,text) TO r36_registrar_owner;
GRANT SELECT ON public.r36_admission_renewal_requests,public.r36_admission_renewal_receipts,public.r36_admission_renewal_revocations,public.r36_certificate_requests,public.r36_certificate_receipts,public.r36_certificate_revocations TO r36_evidence_reader;

GRANT SELECT ON public.financial_wallet_submission_attempts TO r36_evidence_reader;

CREATE OR REPLACE FUNCTION public.r36_certificate_allows(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE r record; now_s bigint;
BEGIN
 IF session_user<>'r36_runtime' OR p_network IS DISTINCT FROM 'Pi Testnet' THEN RETURN false; END IF;
 SELECT p.*,q.nonce AS admission_nonce,q.binding,c.payload_digest,c.issued_at,c.expires_at,c.manifest INTO r
 FROM public.r36_certificate_policies p JOIN public.r36_certificate_requests q ON q.policy_digest=p.policy_digest
 JOIN public.r36_certificate_receipts c ON c.nonce=q.nonce
 WHERE q.binding->>'network'=p_network AND q.binding->>'sourceWallet'=p_wallet AND q.binding->>'paymentId'=p_payment
 AND q.binding->>'operationKind'=p_kind AND q.binding->>'operationId'=p_operation AND q.binding->>'preparedHash'=p_hash AND q.binding->>'preparedSequence'=p_seq
 FOR SHARE OF p,q,c;
 IF NOT FOUND THEN RETURN false; END IF;
 IF r.manifest IS DISTINCT FROM r.binding||jsonb_build_object('schema','R36_ADMISSION_CERTIFICATE_V1','purpose','INITIAL_PREPARED_ADMISSION',
  'issuerId',r.issuer_id,'keyId',r.key_id,'policyDigest',r.policy_digest,'issuedAt',r.issued_at::text,'expiresAt',r.expires_at::text)
 THEN RETURN false; END IF;
 now_s=floor(extract(epoch from clock_timestamp()))::bigint;
 IF NOT r.enabled OR r.revoked OR now_s<r.valid_from OR now_s>=r.valid_until OR now_s>=public.r36_admission_expiry(r.admission_nonce,r.payload_digest) OR r.issued_at>now_s
 OR r.revocation_checked_at>now_s OR now_s>=r.revocation_valid_until OR r.revocation_checked_at<r.issued_at
 OR EXISTS(SELECT 1 FROM public.r36_certificate_revocations WHERE payload_digest=r.payload_digest) THEN RETURN false; END IF;
 -- Bind independently approved wallet clearance and original exact attestation; neither
 -- registration nor this guard writes or enables activation or rotates an owner.
 RETURN EXISTS(SELECT 1 FROM public.financial_wallet_activation g WHERE g.network=p_network AND g.source_wallet=p_wallet
  AND g.state='enabled' AND g.clearance_digest=r.binding->>'clearanceDigest')
 AND EXISTS(SELECT 1 FROM public.r36_independent_u2a_attestations t WHERE t.network=p_network AND t.source_wallet=p_wallet
  AND t.payment_id=p_payment AND t.operation_kind=p_kind AND t.operation_id=p_operation AND t.prepared_tx_hash=p_hash
  AND t.prepared_sequence=p_seq AND t.pi_payment_id=r.binding->>'piPaymentId' AND t.u2a_txid=r.binding->>'u2aTxid'
  AND t.proof_digest=r.payload_digest AND t.status='verified');
END $function$
;
CREATE OR REPLACE FUNCTION public.r36_certificate_context(p_nonce text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
  'approvalRecordDigest',p.approval_record_digest,'workerProfile',p.worker_profile)) || public.r36_renewal_issuer_state(p_nonce);
END $function$
;
CREATE OR REPLACE FUNCTION public.r36_record_certificate(p_nonce text, p_digest text, p_manifest jsonb, p_signature text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE ctx jsonb; b jsonb; p jsonb; existing public.r36_certificate_receipts; issued bigint; expires bigint; now_s bigint;
BEGIN
 IF session_user<>'r36_issuer' THEN RAISE EXCEPTION 'TRUSTED_CONSUMER_REQUIRED'; END IF;
 ctx=public.r36_certificate_context(p_nonce);
 IF ctx IS NULL THEN RAISE EXCEPTION 'TRUST_CONTEXT_UNAVAILABLE'; END IF;
 b=ctx->'binding'; p=ctx->'policy'; now_s=(ctx->>'nowSeconds')::bigint;
 IF p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_signature IS NULL OR p_signature !~ '^[A-Za-z0-9+/]{86}==$'
 OR jsonb_typeof(p_manifest)<>'object' OR coalesce(p_manifest->>'issuedAt','') !~ '^(0|[1-9][0-9]*)$'
 OR coalesce(p_manifest->>'expiresAt','') !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION 'INVALID_CERTIFICATE'; END IF;
 issued=(p_manifest->>'issuedAt')::bigint; expires=(p_manifest->>'expiresAt')::bigint;
 IF issued<(p->>'validFrom')::bigint OR issued>now_s OR expires<=now_s OR expires<=issued OR expires>(p->>'validUntil')::bigint
 OR expires-issued>(p->>'maxAgeSeconds')::bigint OR (p->>'revocationCheckedAt')::bigint<issued THEN RAISE EXCEPTION 'STALE_CERTIFICATE'; END IF;
 IF p_manifest IS DISTINCT FROM b||jsonb_build_object('schema','R36_ADMISSION_CERTIFICATE_V1','purpose','INITIAL_PREPARED_ADMISSION',
  'issuerId',p->>'issuerId','keyId',p->>'keyId','policyDigest',p->>'policyDigest','issuedAt',issued::text,'expiresAt',expires::text)
 THEN RAISE EXCEPTION 'IMMUTABLE_BINDING_MISMATCH'; END IF;
 IF ctx ? 'renewalGeneration' THEN
  RETURN public.r36_record_renewal_receipt(p_nonce,p_digest,p_manifest,p_signature);
 END IF;
 SELECT * INTO existing FROM public.r36_certificate_receipts WHERE nonce=p_nonce;
 IF FOUND THEN
  IF existing.payload_digest=p_digest AND existing.manifest=p_manifest AND existing.signature_base64=p_signature AND
   NOT EXISTS(SELECT 1 FROM public.r36_certificate_revocations WHERE payload_digest=p_digest)
  THEN RETURN 'REPLAYED'; END IF;
  RAISE EXCEPTION 'CERTIFICATE_REPLAY_CONFLICT';
 END IF;
 -- The trusted consumer has verified Ed25519 before entering this writer. Its credential
 -- must never be given to runtime. Privileged owner/issuer compromise is outside this ACL.
 INSERT INTO public.r36_certificate_receipts(nonce,payload_digest,manifest,signature_base64,issued_at,expires_at,verified_by)
 VALUES(p_nonce,p_digest,p_manifest,p_signature,issued,expires,session_user);
 INSERT INTO public.r36_independent_u2a_attestations(network,source_wallet,payment_id,operation_kind,operation_id,prepared_tx_hash,prepared_sequence,pi_payment_id,u2a_txid,proof_digest,status)
 VALUES(b->>'network',b->>'sourceWallet',b->>'paymentId',b->>'operationKind',b->>'operationId',b->>'preparedHash',b->>'preparedSequence',b->>'piPaymentId',b->>'u2aTxid',p_digest,'verified');
 RETURN 'RECORDED';
END $function$
;
CREATE OR REPLACE FUNCTION public.r36_reserve_new_recovery(p_subject text, p_policy text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE v record; old public.r36_recovery_trial_reservations; used numeric;
BEGIN
 IF session_user<>'r36_runtime' OR current_setting('transaction_isolation')<>'read committed'
 OR p_policy IS NULL OR p_policy !~ '^[0-9a-f]{64}$'
 OR (p_subject IS NOT NULL AND p_subject !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
 THEN RETURN NULL; END IF;
 -- Serialize selection/debit across ALL policies, both kinds and all wallets.
 PERFORM pg_advisory_xact_lock(hashtextextended('FLASHpay:R36:TESTNET_TRIAL_BUDGET:1',0));
 FOR v IN SELECT i.payment_id AS id,a.source_wallet AS wallet,a.operation_kind AS kind,a.owner_operation_id AS op,
        a.prepared_tx_hash AS hash,a.prepared_sequence AS seq,q.nonce,c.payload_digest AS digest,
        (i.customer_amount*10000000)::bigint AS amount,
        CASE WHEN a.operation_kind='settlement' THEN s.stage WHEN r.status='completed' THEN 'completed_projection' ELSE r.stage END AS stage
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
     AND i.customer_amount>0 AND i.customer_amount*10000000<=public.r36_policy_max_amount(p.worker_profile) AND i.customer_amount*10000000=trunc(i.customer_amount*10000000)
     AND s.merchant_id=i.merchant_id AND s.merchant_uid=i.merchant_uid AND s.customer_amount=i.customer_amount
     AND s.merchant_amount=i.customer_amount AND s.app_commission=0 AND s.u2a_completed_at IS NOT NULL
     AND s.u2a_identifier=q.binding->>'piPaymentId' AND s.u2a_txid=q.binding->>'u2aTxid'
     AND (i.customer_amount*10000000)::bigint::text=q.binding->>'amountStroops'
     AND public.r36_policy_subject(p.worker_profile,ingress)
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
     AND extract(epoch FROM clock_timestamp()) < least(p.valid_until,p.revocation_valid_until,public.r36_admission_expiry(q.nonce,c.payload_digest))
     AND NOT EXISTS(SELECT 1 FROM public.r36_certificate_revocations x WHERE x.payload_digest=c.payload_digest)
 ORDER BY prior.last_selected_at NULLS FIRST,i.created_at,i.payment_id LOOP
 IF public.r36_certificate_allows('Pi Testnet',v.wallet,v.id,v.kind,v.op,v.hash,v.seq) IS DISTINCT FROM true THEN CONTINUE; END IF;
 SELECT * INTO old FROM public.r36_recovery_trial_reservations WHERE payment_id=v.id;
 IF FOUND THEN
   IF (old.nonce,old.payload_digest,old.amount_stroops) IS DISTINCT FROM (v.nonce,v.digest,v.amount) THEN CONTINUE; END IF;
   UPDATE public.r36_recovery_trial_reservations SET last_selected_at=clock_timestamp() WHERE payment_id=v.id;
 ELSE
   SELECT 2*(coalesce((SELECT sum(amount_stroops) FROM public.r36_testnet_ingress_reservations b JOIN public.r36_certificate_policies p ON p.policy_digest=b.policy_digest WHERE NOT public.r36_general_policy(p.worker_profile)),0)
     +coalesce((SELECT sum(r.amount_stroops) FROM public.r36_recovery_trial_reservations r WHERE NOT EXISTS
      (SELECT 1 FROM public.r36_testnet_ingress_reservations i WHERE i.payment_id=r.payment_id)),0)) INTO used;
   IF NOT EXISTS(SELECT 1 FROM public.r36_certificate_policies p WHERE p.policy_digest=p_policy AND public.r36_general_policy(p.worker_profile)) AND used>10000000 THEN CONTINUE; END IF;
   INSERT INTO public.r36_recovery_trial_reservations(payment_id,nonce,payload_digest,amount_stroops) VALUES(v.id,v.nonce,v.digest,v.amount);
 END IF;
 RETURN jsonb_build_object('id',v.id,'kind',v.kind,'op',v.op,'wallet',v.wallet,'hash',v.hash,'seq',v.seq,'stage',v.stage,
   'spent',EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts t WHERE t.network='Pi Testnet' AND t.owner_payment_id=v.id
     AND t.source_wallet=v.wallet AND t.operation_kind=v.kind AND t.owner_operation_id=v.op AND t.prepared_tx_hash=v.hash AND t.prepared_sequence=v.seq));
 END LOOP;
 RETURN NULL;
END $function$
;
CREATE OR REPLACE FUNCTION public.r36_revoke_certificate(p_digest text, p_reason text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE n text;
BEGIN
 IF session_user<>'r36_issuer' OR p_reason IS NULL OR p_reason !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.r36_admission_renewal_receipts WHERE payload_digest=p_digest) THEN
  PERFORM p.policy_digest FROM public.r36_certificate_policies p JOIN public.r36_certificate_requests q ON q.policy_digest=p.policy_digest
   JOIN public.r36_admission_renewal_receipts c ON c.nonce=q.nonce WHERE c.payload_digest=p_digest FOR UPDATE OF p;
  SELECT q.nonce INTO n FROM public.r36_certificate_requests q JOIN public.r36_admission_renewal_receipts c ON c.nonce=q.nonce
   WHERE c.payload_digest=p_digest FOR UPDATE OF q;
  INSERT INTO public.r36_admission_renewal_revocations(payload_digest,reason_digest) VALUES(p_digest,p_reason) ON CONFLICT DO NOTHING;
  RETURN true;
 END IF;
 PERFORM p.policy_digest FROM public.r36_certificate_policies p JOIN public.r36_certificate_requests q ON q.policy_digest=p.policy_digest
 JOIN public.r36_certificate_receipts c ON c.nonce=q.nonce WHERE c.payload_digest=p_digest FOR UPDATE OF p;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT q.nonce INTO n FROM public.r36_certificate_requests q JOIN public.r36_certificate_receipts c ON c.nonce=q.nonce
 WHERE c.payload_digest=p_digest FOR UPDATE OF q;
 INSERT INTO public.r36_certificate_revocations(payload_digest,reason_digest) VALUES(p_digest,p_reason) ON CONFLICT DO NOTHING;
 RETURN true;
END $function$
;
RESET ROLE;
SET LOCAL ROLE r36_registrar_owner;
CREATE OR REPLACE FUNCTION r36_registration.context(p_policy text, p_nonce text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
 RETURN jsonb_build_object('nowSeconds',n,'requestExists',r.nonce IS NOT NULL,'requestCreatedAt',coalesce(floor(extract(epoch from r.created_at))::bigint,n),
 'policy',jsonb_build_object('policyDigest',p.policy_digest,'issuerId',p.issuer_id,'keyId',p.key_id,
 'publicKeyPem',p.public_key_pem,'publicKeySpkiSha256',p.public_key_spki_sha256,'enabled',p.enabled,'revoked',p.revoked,
 'validFrom',p.valid_from,'validUntil',p.valid_until,'maxAgeSeconds',p.max_age_seconds,
 'revocationCheckedAt',p.revocation_checked_at,'revocationValidUntil',p.revocation_valid_until,
 'approvalRecordDigest',p.approval_record_digest,'workerProfile',p.worker_profile)) || public.r36_renewal_registration_state(p_policy,p_nonce);
END $function$
;
CREATE OR REPLACE FUNCTION r36_registration.enroll(p_policy text, b jsonb, p_bytes text, p_digest text, p_issued bigint, p_expires bigint, p_review text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE ctx jsonb; p jsonb; n bigint; nonce_value text; existing public.r36_certificate_requests;
 signed_request r36_signing.requests; inserted boolean; vals text[]; canonical text; encoded text;
 names text[]:=ARRAY['network','sourceWallet','paymentId','operationKind','operationId','preparedHash','preparedSequence',
 'piPaymentId','u2aTxid','destinationWallet','amountStroops','envelopeXdrTextSha256','immutableIntentDigest','inboundFinalityDigest',
 'walletHistoryDigest','accountingDigest','clearanceDigest','exceptionsDigest','exceptionIsolationDigest','cutoffLedger','nonce'];
 k text;
BEGIN
 IF session_user<>'r36_registrar' THEN RAISE EXCEPTION 'PROTECTED_REGISTRAR_REQUIRED'; END IF;
 IF b IS NULL OR jsonb_typeof(b)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(b))<>cardinality(names)
 OR NOT (b ?& names) OR p_review IS NULL OR p_review !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVALID_BINDING'; END IF;
 FOREACH k IN ARRAY names LOOP
  IF jsonb_typeof(b->k)<>'string' OR length(b->>k) NOT BETWEEN 1 AND 256 OR b->>k ~ '[^ -~]'
  THEN RAISE EXCEPTION 'INVALID_BINDING_FIELD'; END IF;
 END LOOP;
 nonce_value=b->>'nonce';
 IF b->>'network'<>'Pi Testnet' OR b->>'operationKind' NOT IN ('settlement','refund')
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
 IF ctx->>'renewalUnavailable'='true' THEN RAISE EXCEPTION 'RENEWAL_UNAVAILABLE'; END IF;
 IF ctx ? 'renewalGeneration' THEN
  inserted=public.r36_store_renewal_request(p_policy,b,p_digest,p_issued,p_expires,p_review);
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
END $function$
;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM r36_owner;
DO $$ BEGIN IF session_user='neondb_owner' THEN REVOKE r36_owner,r36_registrar_owner FROM neondb_owner; END IF; END $$;
COMMIT;
