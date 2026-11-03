-- NOT_FOR_DEPLOY. Isolated extension; NOT part of the approved Neon migration.
-- No root, policy, request, certificate or wallet activation is seeded here.
-- r36_issuer is the exclusive trusted verifier principal, not the application.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ BEGIN
 IF current_setting('flashpay.isolated_certificate_test',true) IS DISTINCT FROM 'yes'
 THEN RAISE EXCEPTION 'ISOLATED_CERTIFICATE_EXTENSION_ONLY'; END IF;
 IF current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
 THEN RAISE EXCEPTION 'POSTGRESQL17_REQUIRED'; END IF;
END $$;
CREATE TABLE public.r36_certificate_policies (
 policy_digest text PRIMARY KEY CHECK(policy_digest ~ '^[0-9a-f]{64}$'),
 issuer_id text NOT NULL, key_id text NOT NULL,
 public_key_pem text NOT NULL, public_key_spki_sha256 text NOT NULL CHECK(public_key_spki_sha256 ~ '^[0-9a-f]{64}$'),
 enabled boolean NOT NULL DEFAULT false, revoked boolean NOT NULL DEFAULT false,
 valid_from bigint NOT NULL, valid_until bigint NOT NULL, max_age_seconds bigint NOT NULL CHECK(max_age_seconds>0),
 revocation_checked_at bigint NOT NULL, revocation_valid_until bigint NOT NULL,
 approval_record_digest text NOT NULL CHECK(approval_record_digest ~ '^[0-9a-f]{64}$'),
 worker_profile jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(worker_profile)='object'),
 CHECK(valid_from>=0 AND valid_until>valid_from AND revocation_checked_at>=0 AND revocation_valid_until>revocation_checked_at AND revocation_valid_until<=valid_until)
);
CREATE TABLE public.r36_certificate_requests (
 nonce text PRIMARY KEY CHECK(nonce ~ '^[0-9a-f]{64}$'),
 policy_digest text NOT NULL REFERENCES public.r36_certificate_policies(policy_digest),
 binding jsonb NOT NULL CHECK(jsonb_typeof(binding)='object' AND binding->>'nonce'=nonce AND binding->>'network'='Pi Testnet'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX r36_certificate_request_identity ON public.r36_certificate_requests
 ((binding->>'network'),(binding->>'sourceWallet'),(binding->>'paymentId'),(binding->>'operationKind'),(binding->>'operationId'),(binding->>'preparedHash'),(binding->>'preparedSequence'));
CREATE TABLE public.r36_certificate_receipts (
 nonce text PRIMARY KEY REFERENCES public.r36_certificate_requests(nonce),
 payload_digest text NOT NULL UNIQUE CHECK(payload_digest ~ '^[0-9a-f]{64}$'),
 manifest jsonb NOT NULL, signature_base64 text NOT NULL,
 issued_at bigint NOT NULL, expires_at bigint NOT NULL CHECK(expires_at>issued_at),
 verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 verified_by text NOT NULL CHECK(verified_by='r36_issuer')
);
CREATE TABLE public.r36_certificate_revocations (
 payload_digest text PRIMARY KEY REFERENCES public.r36_certificate_receipts(payload_digest),
 revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 reason_digest text NOT NULL CHECK(reason_digest ~ '^[0-9a-f]{64}$')
);
ALTER TABLE public.r36_certificate_policies OWNER TO r36_owner;
ALTER TABLE public.r36_certificate_requests OWNER TO r36_owner;
ALTER TABLE public.r36_certificate_receipts OWNER TO r36_owner;
ALTER TABLE public.r36_certificate_revocations OWNER TO r36_owner;
REVOKE ALL ON public.r36_certificate_policies,public.r36_certificate_requests,public.r36_certificate_receipts,public.r36_certificate_revocations FROM PUBLIC,r36_runtime,r36_issuer;

-- Approved policy content is immutable. Revocation/freshness may change under the
-- protected policy lock; a key or policy change requires a new policy digest.
CREATE FUNCTION public.r36_certificate_policy_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['enabled','revoked','revocation_checked_at','revocation_valid_until']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['enabled','revoked','revocation_checked_at','revocation_valid_until'])
 THEN RAISE EXCEPTION 'POLICY_CONTENT_IMMUTABLE_USE_NEW_DIGEST'; END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION public.r36_certificate_policy_immutable() OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_certificate_policy_immutable() FROM PUBLIC,r36_runtime,r36_issuer;
CREATE TRIGGER r36_policy_immutable BEFORE UPDATE ON public.r36_certificate_policies
 FOR EACH ROW EXECUTE FUNCTION public.r36_certificate_policy_immutable();

CREATE FUNCTION public.r36_certificate_context(p_nonce text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
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
  'approvalRecordDigest',p.approval_record_digest,'workerProfile',p.worker_profile));
END $$;
ALTER FUNCTION public.r36_certificate_context(text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_certificate_context(text) FROM PUBLIC,r36_runtime;
GRANT EXECUTE ON FUNCTION public.r36_certificate_context(text) TO r36_issuer;

CREATE FUNCTION public.r36_record_certificate(p_nonce text,p_digest text,p_manifest jsonb,p_signature text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
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
END $$;
ALTER FUNCTION public.r36_record_certificate(text,text,jsonb,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_record_certificate(text,text,jsonb,text) FROM PUBLIC,r36_runtime;
GRANT EXECUTE ON FUNCTION public.r36_record_certificate(text,text,jsonb,text) TO r36_issuer;

-- Revocation uses the same policy/request lock order as consumption and admission.
CREATE FUNCTION public.r36_revoke_certificate(p_digest text,p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE n text;
BEGIN
 IF session_user<>'r36_issuer' OR p_reason IS NULL OR p_reason !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
 PERFORM p.policy_digest FROM public.r36_certificate_policies p JOIN public.r36_certificate_requests q ON q.policy_digest=p.policy_digest
 JOIN public.r36_certificate_receipts c ON c.nonce=q.nonce WHERE c.payload_digest=p_digest FOR UPDATE OF p;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT q.nonce INTO n FROM public.r36_certificate_requests q JOIN public.r36_certificate_receipts c ON c.nonce=q.nonce
 WHERE c.payload_digest=p_digest FOR UPDATE OF q;
 INSERT INTO public.r36_certificate_revocations(payload_digest,reason_digest) VALUES(p_digest,p_reason) ON CONFLICT DO NOTHING;
 RETURN true;
END $$;
ALTER FUNCTION public.r36_revoke_certificate(text,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_revoke_certificate(text,text) FROM PUBLIC,r36_runtime;
GRANT EXECUTE ON FUNCTION public.r36_revoke_certificate(text,text) TO r36_issuer;

CREATE FUNCTION public.r36_certificate_allows(p_network text,p_wallet text,p_payment text,p_kind text,p_operation text,p_hash text,p_seq text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r record; now_s bigint;
BEGIN
 IF session_user<>'r36_runtime' OR p_network IS DISTINCT FROM 'Pi Testnet' THEN RETURN false; END IF;
 SELECT p.*,q.binding,c.payload_digest,c.issued_at,c.expires_at,c.manifest INTO r
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
 IF NOT r.enabled OR r.revoked OR now_s<r.valid_from OR now_s>=r.valid_until OR now_s>=r.expires_at OR r.issued_at>now_s
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
END $$;
ALTER FUNCTION public.r36_certificate_allows(text,text,text,text,text,text,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_certificate_allows(text,text,text,text,text,text,text) FROM PUBLIC,r36_runtime,r36_issuer;

-- Original claim bodies retained with one certificate check before their existing guards.
-- No unguarded private aliases are installed.
CREATE OR REPLACE FUNCTION public.r36_claim_prepared_authority(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE admitted text;
BEGIN
 IF NOT public.r36_certificate_allows(p_network,p_wallet,p_payment,p_kind,p_operation,p_hash,p_seq) THEN RETURN false; END IF;
 IF p_network IS DISTINCT FROM 'Pi Testnet' OR p_wallet IS NULL OR p_wallet !~ '^G[A-Z2-7]{55}$'
    OR p_payment IS NULL OR p_payment='' OR btrim(p_payment)<>p_payment
    OR p_operation IS NULL OR p_operation='' OR btrim(p_operation)<>p_operation
    OR p_kind IS NULL OR p_kind NOT IN ('settlement','refund')
    OR p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$'
    OR p_seq IS NULL OR p_seq !~ '^[1-9][0-9]*$' THEN RETURN false; END IF;
 -- This candidate intentionally does not grant clearance for unproven historical movement.
 IF NOT EXISTS (SELECT 1 FROM public.financial_wallet_activation g
     WHERE g.network=p_network AND g.source_wallet=p_wallet AND g.state='enabled'
       AND g.clearance_digest ~ '^[0-9a-f]{64}$') THEN RETURN false; END IF;
 -- Independently issued attestation: this table is NOT writable or issuable by runtime.
 -- This is only a role-boundary proof; a real issuer must independently verify Pi/Horizon.
 IF NOT EXISTS (
   SELECT 1 FROM public.r36_independent_u2a_attestations t
   WHERE t.network=p_network AND t.source_wallet=p_wallet
     AND t.payment_id=p_payment AND t.operation_kind=p_kind
     AND t.operation_id=p_operation AND t.prepared_tx_hash=p_hash
     AND t.prepared_sequence=p_seq AND t.status='verified'
 ) THEN RETURN false; END IF;
 -- Stage17: DO NOT require runtime-authored checkpoint/audit BEFORE claim.
 -- The independent issuer attestation must already exist. Claim and prepared
 -- evidence are committed in ONE caller transaction; rollback removes both.
 -- No Pi/Horizon proof is implemented in this isolated fixture.
 -- Block any distinct unsettled settlement or unresolved refund unless exact different-wallet
 -- refund authority already proves the other refund is outside this wallet.
 IF EXISTS (SELECT 1 FROM public.settlement_checkpoints s
      WHERE s.a2u_from_address=p_wallet AND s.payment_id<>p_payment
      AND s.stage IN ('a2u_created','prepared','horizon_confirmed','pi_completed')) THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM public.refund_checkpoints r
      WHERE r.payment_id<>p_payment AND r.status IN ('pending','manual_review_required')
      AND NOT EXISTS (SELECT 1 FROM public.financial_wallet_authorities ra
         WHERE ra.network=p_network AND ra.operation_kind='refund'
           AND ra.owner_payment_id=r.payment_id AND ra.owner_operation_id=r.refund_id
           AND ra.source_wallet<>p_wallet AND ra.state='prepared')) THEN RETURN false; END IF;
 INSERT INTO public.financial_wallet_authorities
   (network,source_wallet,owner_payment_id,operation_kind,owner_operation_id,
    prepared_tx_hash,prepared_sequence,state)
 VALUES (p_network,p_wallet,p_payment,p_kind,p_operation,p_hash,p_seq,'prepared')
 ON CONFLICT (network,source_wallet) DO UPDATE
   SET updated_at=public.financial_wallet_authorities.updated_at
   WHERE public.financial_wallet_authorities.owner_payment_id=EXCLUDED.owner_payment_id
     AND public.financial_wallet_authorities.operation_kind=EXCLUDED.operation_kind
     AND public.financial_wallet_authorities.owner_operation_id=EXCLUDED.owner_operation_id
     AND public.financial_wallet_authorities.prepared_tx_hash=EXCLUDED.prepared_tx_hash
     AND public.financial_wallet_authorities.prepared_sequence=EXCLUDED.prepared_sequence
     AND public.financial_wallet_authorities.state='prepared'
 RETURNING prepared_tx_hash INTO admitted;
 RETURN COALESCE(admitted=p_hash,false);
END;
$function$;

ALTER FUNCTION public.r36_claim_prepared_authority(text,text,text,text,text,text,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_claim_prepared_authority(text,text,text,text,text,text,text) FROM PUBLIC,r36_issuer;
GRANT EXECUTE ON FUNCTION public.r36_claim_prepared_authority(text,text,text,text,text,text,text) TO r36_runtime;
CREATE OR REPLACE FUNCTION public.r36_claim_first_submission(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE admitted text;
BEGIN
 IF NOT public.r36_certificate_allows(p_network,p_wallet,p_payment,p_kind,p_operation,p_hash,p_seq) THEN RETURN false; END IF;
 IF p_network <> 'Pi Testnet' OR p_wallet !~ '^G[A-Z2-7]{55}$'
    OR p_payment IS NULL OR btrim(p_payment) <> p_payment OR p_payment = ''
    OR p_operation IS NULL OR btrim(p_operation) <> p_operation OR p_operation = ''
    OR p_kind NOT IN ('settlement','refund')
    OR p_hash !~ '^[0-9a-f]{64}$' OR p_seq !~ '^[1-9][0-9]*$' THEN RETURN false; END IF;
 INSERT INTO public.financial_wallet_submission_attempts
   (network,source_wallet,owner_payment_id,operation_kind,owner_operation_id,prepared_tx_hash,prepared_sequence)
 SELECT a.network,a.source_wallet,a.owner_payment_id,a.operation_kind,
        a.owner_operation_id,a.prepared_tx_hash,a.prepared_sequence
 FROM public.financial_wallet_authorities a
 JOIN public.financial_wallet_activation g ON g.network=a.network AND g.source_wallet=a.source_wallet
  AND g.state='enabled' AND g.clearance_digest ~ '^[0-9a-f]{64}$'
 WHERE a.network=p_network AND a.source_wallet=p_wallet AND a.owner_payment_id=p_payment
   AND a.operation_kind=p_kind AND a.owner_operation_id=p_operation
   AND a.prepared_tx_hash=p_hash AND a.prepared_sequence=p_seq AND a.state='prepared'
   AND NOT EXISTS (SELECT 1 FROM public.settlement_checkpoints s
      WHERE s.a2u_from_address=p_wallet AND s.payment_id<>p_payment
      AND s.stage IN ('a2u_created','prepared','horizon_confirmed','pi_completed'))
   AND NOT EXISTS (SELECT 1 FROM public.refund_checkpoints r
      WHERE r.payment_id<>p_payment AND r.status IN ('pending','manual_review_required')
        AND NOT EXISTS (SELECT 1 FROM public.financial_wallet_authorities ra
           WHERE ra.network=p_network AND ra.operation_kind='refund'
             AND ra.owner_payment_id=r.payment_id AND ra.owner_operation_id=r.refund_id
             AND ra.source_wallet<>p_wallet AND ra.state='prepared'))
 FOR UPDATE OF a
 ON CONFLICT DO NOTHING RETURNING prepared_tx_hash INTO admitted;
 RETURN COALESCE(admitted = p_hash, false);
END;
$function$;

ALTER FUNCTION public.r36_claim_first_submission(text,text,text,text,text,text,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_claim_first_submission(text,text,text,text,text,text,text) FROM PUBLIC,r36_issuer;
GRANT EXECUTE ON FUNCTION public.r36_claim_first_submission(text,text,text,text,text,text,text) TO r36_runtime;
CREATE FUNCTION public.r36_certificate_gate_version() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS 'SELECT 1';
ALTER FUNCTION public.r36_certificate_gate_version() OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_certificate_gate_version() FROM PUBLIC,r36_issuer;
GRANT EXECUTE ON FUNCTION public.r36_certificate_gate_version() TO r36_runtime;
COMMIT;
