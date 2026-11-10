-- First verified certificate for a newly enrolled wallet only. No activation,
-- authority creation, attempt reset, transfer, legacy disposition or fee change.
BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='60s';
DO $$ BEGIN
 IF current_database()<>'neondb' OR session_user<>'neondb_owner' OR current_user<>session_user
 OR current_setting('neon.branch_id',true) IS DISTINCT FROM 'br-tiny-mode-aliatv40'
 OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
 OR to_regclass('public.r36_wallet_execution_scopes') IS NULL
 OR to_regprocedure('public.r36_observe_owner_policy(text)') IS NULL
 OR to_regclass('public.r36_initial_clearance_links') IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.r36_certificate_policies WHERE enabled AND NOT revoked)
 THEN RAISE EXCEPTION 'FIRST_CLEARANCE_INSTALL_NOT_QUALIFIED'; END IF;
END $$;
GRANT r36_owner TO neondb_owner WITH INHERIT FALSE,SET TRUE;
GRANT CREATE ON SCHEMA public TO r36_owner; SET LOCAL ROLE r36_owner;
CREATE TABLE public.r36_initial_clearance_links(
 network text NOT NULL CHECK(network='Pi Testnet'), source_wallet text NOT NULL CHECK(source_wallet ~ '^G[A-Z2-7]{55}$'),
 policy_digest text NOT NULL REFERENCES public.r36_certificate_policies(policy_digest),
 nonce text NOT NULL UNIQUE REFERENCES public.r36_certificate_receipts(nonce),
 scope_digest text NOT NULL, prior_clearance_digest text NOT NULL CHECK(prior_clearance_digest ~ '^[0-9a-f]{64}$'),
 next_clearance_digest text NOT NULL CHECK(next_clearance_digest ~ '^[0-9a-f]{64}$'),
 certificate_digest text NOT NULL REFERENCES public.r36_certificate_receipts(payload_digest),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), recorded_by text NOT NULL CHECK(recorded_by='r36_issuer'),
 PRIMARY KEY(network,source_wallet), FOREIGN KEY(scope_digest,policy_digest) REFERENCES public.r36_wallet_execution_scopes(scope_digest,policy_digest)
);
REVOKE ALL ON public.r36_initial_clearance_links FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
CREATE TRIGGER r36_initial_clearance_immutable BEFORE UPDATE OR DELETE ON public.r36_initial_clearance_links
 FOR EACH ROW EXECUTE FUNCTION public.r36_execution_scope_immutable();
CREATE TRIGGER r36_initial_clearance_no_truncate BEFORE TRUNCATE ON public.r36_initial_clearance_links
 FOR EACH STATEMENT EXECUTE FUNCTION public.r36_execution_scope_immutable();
CREATE FUNCTION public.r36_bind_initial_clearance(p_nonce text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE ctx jsonb; b jsonb; p jsonb; receipt public.r36_certificate_receipts;
 gate public.financial_wallet_activation; scope public.r36_wallet_execution_scopes;
 prior public.r36_initial_clearance_links; ingress public.r36_testnet_ingress_reservations;
 initial jsonb; n bigint; seq text;
BEGIN
 IF session_user<>'r36_issuer' OR current_setting('transaction_isolation')<>'read committed'
 OR p_nonce IS NULL OR p_nonce !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
 ctx:=public.r36_certificate_context(p_nonce);
 IF ctx IS NULL THEN RETURN NULL; END IF;
 b:=ctx->'binding';p:=ctx->'policy';
 IF b->>'network' IS DISTINCT FROM 'Pi Testnet' OR b->>'nonce' IS DISTINCT FROM p_nonce
 OR coalesce(b->>'clearanceDigest','') !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
 SELECT * INTO receipt FROM public.r36_certificate_receipts WHERE nonce=p_nonce FOR SHARE;
 IF NOT FOUND OR receipt.verified_by<>'r36_issuer'
 OR receipt.manifest IS DISTINCT FROM b||jsonb_build_object('schema','R36_ADMISSION_CERTIFICATE_V1','purpose','INITIAL_PREPARED_ADMISSION',
 'issuerId',p->>'issuerId','keyId',p->>'keyId','policyDigest',p->>'policyDigest','issuedAt',receipt.issued_at::text,'expiresAt',receipt.expires_at::text)
 OR EXISTS(SELECT 1 FROM public.r36_certificate_revocations WHERE payload_digest=receipt.payload_digest)
 THEN RETURN NULL; END IF;
 -- Serialize against original Runtime's activation read before inspecting any
 -- absence. Once an authority exists only the original successor protocol applies.
 SELECT * INTO gate FROM public.financial_wallet_activation WHERE network=b->>'network' AND source_wallet=b->>'sourceWallet' FOR UPDATE;
 IF NOT FOUND OR gate.state<>'enabled' THEN RETURN NULL; END IF;
 n:=floor(extract(epoch FROM clock_timestamp()))::bigint;
 IF n>=least((p->>'validUntil')::bigint,(p->>'revocationValidUntil')::bigint,receipt.expires_at)
 OR receipt.issued_at>n OR receipt.issued_at>(p->>'revocationCheckedAt')::bigint THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM public.financial_wallet_authorities WHERE network=gate.network AND source_wallet=gate.source_wallet) THEN RETURN 'NOT_REQUIRED'; END IF;
 initial:=p->'workerProfile'->'initialClearance';
 IF initial IS DISTINCT FROM jsonb_build_object('schema','R36_FIRST_CERTIFICATE_CLEARANCE_V1','bootstrapClearanceDigest',initial->>'bootstrapClearanceDigest')
 OR coalesce(initial->>'bootstrapClearanceDigest','') !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
 SELECT * INTO scope FROM public.r36_wallet_execution_scopes WHERE policy_digest=p->>'policyDigest'
 AND source_wallet=gate.source_wallet AND scope_digest=p->'workerProfile'->>'executionScopeDigest' FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 seq:=scope.scope_text::jsonb->'bootstrap'->'wallet_history'->'snapshot'->>'closingSequence';
 IF coalesce(seq,'') !~ '^[0-9]{1,29}$' OR coalesce(b->>'preparedSequence','') !~ '^[1-9][0-9]{0,29}$'
 OR (b->>'preparedSequence')::numeric<>seq::numeric+1 THEN RETURN NULL; END IF;
 SELECT * INTO ingress FROM public.r36_testnet_ingress_reservations WHERE payment_id=b->>'paymentId' FOR SHARE;
 IF NOT FOUND OR ingress.policy_digest<>scope.policy_digest OR ingress.source_wallet<>gate.source_wallet
 OR ingress.retired_by_payment_id IS NOT NULL OR ingress.payer_uid IS NULL OR ingress.payer_wallet IS NULL
 OR ingress.amount_stroops::text IS DISTINCT FROM b->>'amountStroops'
 THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts WHERE network=gate.network AND source_wallet=gate.source_wallet)
 OR EXISTS(SELECT 1 FROM public.financial_wallet_finality_seals WHERE network=gate.network AND source_wallet=gate.source_wallet)
 OR EXISTS(SELECT 1 FROM public.financial_wallet_authority_history WHERE network=gate.network AND source_wallet=gate.source_wallet)
 THEN RETURN NULL; END IF;
 SELECT * INTO prior FROM public.r36_initial_clearance_links WHERE network=gate.network AND source_wallet=gate.source_wallet;
 IF FOUND THEN
  IF (prior.policy_digest,prior.nonce,prior.scope_digest,prior.certificate_digest,prior.prior_clearance_digest,prior.next_clearance_digest)
   =(scope.policy_digest,p_nonce,scope.scope_digest,receipt.payload_digest,initial->>'bootstrapClearanceDigest',b->>'clearanceDigest')
   AND gate.clearance_digest=prior.next_clearance_digest THEN RETURN 'REPLAYED'; END IF;
  RETURN NULL;
 END IF;
 IF gate.clearance_digest IS DISTINCT FROM initial->>'bootstrapClearanceDigest' THEN RETURN NULL; END IF;
 -- Clock must still be valid after the reservation/scope locks as well.
 n:=floor(extract(epoch FROM clock_timestamp()))::bigint;
 IF n>=least((p->>'validUntil')::bigint,(p->>'revocationValidUntil')::bigint,receipt.expires_at) THEN RETURN NULL; END IF;
 INSERT INTO public.r36_initial_clearance_links(network,source_wallet,policy_digest,nonce,scope_digest,prior_clearance_digest,next_clearance_digest,certificate_digest,recorded_by)
 VALUES(gate.network,gate.source_wallet,scope.policy_digest,p_nonce,scope.scope_digest,gate.clearance_digest,b->>'clearanceDigest',receipt.payload_digest,session_user);
 UPDATE public.financial_wallet_activation SET clearance_digest=b->>'clearanceDigest',cleared_by='r36_issuer:first_certificate:'||p_nonce,cleared_at=clock_timestamp()
 WHERE network=gate.network AND source_wallet=gate.source_wallet AND state='enabled' AND clearance_digest=gate.clearance_digest;
 IF NOT FOUND THEN RAISE EXCEPTION 'INITIAL_CLEARANCE_ATOMICITY'; END IF;
 RETURN 'RECORDED';
END $$;
REVOKE ALL ON FUNCTION public.r36_bind_initial_clearance(text) FROM PUBLIC,r36_runtime,r36_signer,r36_registrar,r36_evidence_reader;
GRANT EXECUTE ON FUNCTION public.r36_bind_initial_clearance(text) TO r36_issuer;
RESET ROLE; REVOKE CREATE ON SCHEMA public FROM r36_owner;
REVOKE r36_owner FROM neondb_owner GRANTED BY neondb_owner; COMMIT;
