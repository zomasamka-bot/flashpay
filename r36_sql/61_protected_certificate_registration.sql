-- NOT_FOR_DEPLOY. New isolated registrar qualification, not a production activation.
-- No seed policy, key, certificate, wallet authority, financial write or role LOGIN.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ BEGIN
 IF current_user<>session_user OR current_setting('flashpay.isolated_certificate_test',true) IS DISTINCT FROM 'yes'
 THEN RAISE EXCEPTION 'ISOLATED_DIRECT_MIGRATION_REQUIRED'; END IF;
 IF current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999 THEN RAISE EXCEPTION 'POSTGRESQL17_REQUIRED'; END IF;
 IF to_regclass('public.r36_certificate_requests') IS NULL OR to_regclass('r36_signing.requests') IS NULL
 THEN RAISE EXCEPTION 'ORIGINAL_CERTIFICATE_AND_SIGNER_SCHEMA_REQUIRED'; END IF;
 CREATE ROLE r36_registrar NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 CREATE ROLE r36_registrar_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 IF has_schema_privilege('r36_registrar','public','CREATE') OR has_schema_privilege('r36_registrar_owner','public','CREATE')
 THEN RAISE EXCEPTION 'PUBLIC_CREATE_FORBIDDEN'; END IF;
 IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
  EXECUTE format('GRANT r36_registrar_owner TO %I WITH SET TRUE, INHERIT FALSE',current_user);
  PERFORM set_config('flashpay.registration_temporary_owner_grant','yes',true);
 END IF;
END $$;
CREATE SCHEMA r36_registration AUTHORIZATION r36_registrar_owner;
-- A non-superuser migration owner has SET permission, not inherited schema
-- ownership. Apply this schema's ACL as its actual NOLOGIN owner.
SET LOCAL ROLE r36_registrar_owner;
REVOKE ALL ON SCHEMA r36_registration FROM PUBLIC,r36_runtime,r36_issuer,r36_signer;
GRANT USAGE ON SCHEMA r36_registration TO r36_registrar;
RESET ROLE;
GRANT USAGE ON SCHEMA public,r36_signing TO r36_registrar_owner;
-- The NOLOGIN function owner is restricted to policy reads and append-only enrollment.
GRANT SELECT ON public.r36_certificate_policies TO r36_registrar_owner;
-- PostgreSQL row-locking a policy requires UPDATE privilege. Only column enabled is
-- granted to the NOLOGIN owner; neither exposed function performs any policy update.
GRANT UPDATE(enabled) ON public.r36_certificate_policies TO r36_registrar_owner;
GRANT SELECT,INSERT ON public.r36_certificate_requests,r36_signing.requests TO r36_registrar_owner;
SET LOCAL ROLE r36_registrar_owner;

CREATE FUNCTION r36_registration.context(p_policy text,p_nonce text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
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
 'approvalRecordDigest',p.approval_record_digest,'workerProfile',p.worker_profile));
END $$;

CREATE FUNCTION r36_registration.enroll(p_policy text,b jsonb,p_bytes text,p_digest text,p_issued bigint,p_expires bigint,p_review text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
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
 SELECT * INTO existing FROM public.r36_certificate_requests WHERE nonce=nonce_value;
 inserted=NOT FOUND;
 IF NOT inserted AND (existing.policy_digest<>p_policy OR existing.binding<>b OR floor(extract(epoch from existing.created_at))::bigint<>p_issued)
 THEN RAISE EXCEPTION 'REGISTRATION_REPLAY_CONFLICT'; END IF;
 IF inserted THEN
  INSERT INTO public.r36_certificate_requests(nonce,policy_digest,binding,created_at) VALUES(nonce_value,p_policy,b,to_timestamp(p_issued));
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
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA r36_registration FROM PUBLIC,r36_runtime,r36_issuer,r36_signer;
GRANT EXECUTE ON FUNCTION r36_registration.context(text,text),r36_registration.enroll(text,jsonb,text,text,bigint,bigint,text) TO r36_registrar;
RESET ROLE;
DO $$ BEGIN
 IF current_setting('flashpay.registration_temporary_owner_grant',true)='yes' THEN
  EXECUTE format('REVOKE r36_registrar_owner FROM %I GRANTED BY %I',current_user,current_user);
 END IF;
END $$;
COMMIT;
