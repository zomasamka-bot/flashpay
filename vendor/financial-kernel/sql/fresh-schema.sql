-- Additive preparation. Empty enrollment keeps the existing Testnet/zero contract.
CREATE TABLE IF NOT EXISTS public.kernel_financial_network (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), application_id text NOT NULL,
 network text NOT NULL CHECK(network IN ('Pi Testnet','Pi Network')),
 incoming_wallet text NOT NULL CHECK(incoming_wallet ~ '^G[A-Z2-7]{55}$'),
 outgoing_wallet text NOT NULL CHECK(outgoing_wallet ~ '^G[A-Z2-7]{55}$'),
 CHECK(network<>'Pi Network' OR incoming_wallet<>outgoing_wallet)
);
ALTER TABLE public.kernel_financial_network OWNER TO r36_owner;
REVOKE ALL ON public.kernel_financial_network FROM PUBLIC,r36_runtime,r36_issuer,r36_signer;
GRANT SELECT ON public.kernel_financial_network TO r36_runtime,r36_issuer,r36_evidence_reader,neondb_owner;
CREATE OR REPLACE FUNCTION public.r36_network() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT coalesce((SELECT network FROM public.kernel_financial_network WHERE singleton),'Pi Testnet')
$$;
ALTER FUNCTION public.r36_network() OWNER TO r36_owner;
CREATE OR REPLACE FUNCTION public.r36_incoming_wallet(p_outgoing text) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM public.kernel_financial_network) THEN
 (SELECT incoming_wallet FROM public.kernel_financial_network WHERE singleton AND outgoing_wallet=p_outgoing) ELSE p_outgoing END
$$;
ALTER FUNCTION public.r36_incoming_wallet(text) OWNER TO r36_owner;
CREATE TABLE IF NOT EXISTS public.r36_financial_policy_versions (
 policy_id text PRIMARY KEY, policy jsonb NOT NULL,
 CHECK(jsonb_typeof(policy)='object' AND policy->>'schema'='MERCHANT_FEE_POLICY_V1'),
 CHECK(policy ?& ARRAY['schema','id','applicationId','network','payer','basisPoints','rounding','networkFeePayer','refund']),
 CHECK(policy - ARRAY['schema','id','applicationId','network','payer','basisPoints','rounding','networkFeePayer','refund']='{}'),
 CHECK(NOT jsonb_path_exists(policy,'$.* ? (@ == null)')),
 CHECK(policy->>'id'=policy_id AND policy->>'network' IN ('Pi Testnet','Pi Network')),
 CHECK(policy->>'payer'='merchant' AND policy->>'rounding'='floor' AND policy->>'networkFeePayer'='application'),
 CHECK(policy->>'refund'='full_customer_amount_no_earned_commission'),
 CHECK(jsonb_typeof(policy->'basisPoints')='number' AND (policy->>'basisPoints') ~ '^(0|[1-9][0-9]{0,3})$')
);
CREATE TABLE IF NOT EXISTS public.r36_active_financial_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), policy_id text NOT NULL REFERENCES public.r36_financial_policy_versions(policy_id)
);
ALTER TABLE public.r36_financial_policy_versions OWNER TO r36_owner;
ALTER TABLE public.r36_active_financial_policy OWNER TO r36_owner;
REVOKE ALL ON public.r36_financial_policy_versions,public.r36_active_financial_policy FROM PUBLIC,r36_runtime,r36_issuer,r36_signer;
GRANT SELECT ON public.r36_financial_policy_versions,public.r36_active_financial_policy TO r36_evidence_reader,neondb_owner;
CREATE OR REPLACE FUNCTION public.r36_contract_valid(r jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q jsonb:=r->'financial_contract'; p jsonb; gross numeric; net numeric; fee numeric;
BEGIN
 gross:=(r->>'customer_amount')::numeric;net:=(r->>'merchant_amount')::numeric;fee:=(r->>'app_commission')::numeric;
 IF q IS NULL OR q='null'::jsonb THEN RETURN coalesce(gross>0 AND fee=0 AND (net IS NULL OR net=gross),false); END IF;
 IF jsonb_typeof(q) IS DISTINCT FROM 'object' OR NOT(q ?& ARRAY['schema','paymentId','merchantUid','policy','grossStroops','merchantNetStroops','commissionStroops']) OR q-ARRAY['schema','paymentId','merchantUid','policy','grossStroops','merchantNetStroops','commissionStroops']<>'{}' OR jsonb_path_exists(q,'$.* ? (@ == null)') OR q->>'schema' IS DISTINCT FROM 'MERCHANT_FEE_QUOTE_V1' OR q->>'paymentId' IS DISTINCT FROM r->>'payment_id'
 OR q->>'merchantUid' IS DISTINCT FROM r->>'merchant_uid' OR q->'policy'->>'network' IS DISTINCT FROM public.r36_network()
 OR NOT EXISTS(SELECT 1 FROM public.kernel_financial_network WHERE application_id=q->'policy'->>'applicationId') THEN RETURN false; END IF;
 SELECT policy INTO p FROM public.r36_financial_policy_versions WHERE policy_id=q->'policy'->>'id';
 IF p IS NULL OR p IS DISTINCT FROM q->'policy' THEN RETURN false; END IF;
 RETURN coalesce(gross>0 AND net>0 AND fee>=0 AND gross=net+fee AND gross*10000000=trunc(gross*10000000)
 AND gross*10000000 BETWEEN 1 AND 10000000000000 AND net*10000000=trunc(net*10000000)
 AND fee*10000000=trunc(gross*10000000*(p->>'basisPoints')::numeric/10000)
 AND q->>'grossStroops'=(gross*10000000)::bigint::text AND q->>'merchantNetStroops'=(net*10000000)::bigint::text
 AND q->>'commissionStroops'=(fee*10000000)::bigint::text,false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
ALTER FUNCTION public.r36_contract_valid(jsonb) OWNER TO r36_owner;
CREATE OR REPLACE FUNCTION public.r36_contract_snapshot_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p jsonb; g bigint; f bigint; q jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.financial_contract,NEW.customer_amount,NEW.merchant_amount,NEW.app_commission,NEW.merchant_uid,NEW.merchant_id,NEW.payment_id)
    IS DISTINCT FROM (OLD.financial_contract,OLD.customer_amount,OLD.merchant_amount,OLD.app_commission,OLD.merchant_uid,OLD.merchant_id,OLD.payment_id)
  THEN RAISE EXCEPTION 'FINANCIAL_CONTRACT_IMMUTABLE'; END IF;
  RETURN NEW;
 END IF;
 SELECT v.policy INTO p FROM public.r36_active_financial_policy a JOIN public.r36_financial_policy_versions v USING(policy_id) WHERE a.singleton;
 IF p IS NULL OR NEW.stage<>'payment_identity' OR NEW.version<>1 OR NEW.u2a_identifier IS NOT NULL OR NEW.u2a_txid IS NOT NULL THEN
  IF NEW.financial_contract IS NOT NULL OR NEW.app_commission<>0 OR NEW.merchant_amount IS DISTINCT FROM NEW.customer_amount THEN RAISE EXCEPTION 'LEGACY_ZERO_CONTRACT_REQUIRED'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.customer_amount*10000000<>trunc(NEW.customer_amount*10000000) OR NEW.customer_amount<=0 OR NEW.customer_amount>1000000 THEN RAISE EXCEPTION 'FINANCIAL_CONTRACT_PRECISION'; END IF;
 g:=(NEW.customer_amount*10000000)::bigint;f:=g*(p->>'basisPoints')::bigint/10000;
 q:=jsonb_build_object('schema','MERCHANT_FEE_QUOTE_V1','paymentId',NEW.payment_id,'merchantUid',NEW.merchant_uid,'policy',p,
 'grossStroops',g::text,'merchantNetStroops',(g-f)::text,'commissionStroops',f::text);
 IF NEW.financial_contract IS NOT NULL AND NEW.financial_contract IS DISTINCT FROM q THEN RAISE EXCEPTION 'CALLER_QUOTE_MISMATCH'; END IF;
 NEW.financial_contract:=q;NEW.merchant_amount:=(g-f)::numeric/10000000;NEW.app_commission:=f::numeric/10000000;
 IF NOT public.r36_contract_valid(to_jsonb(NEW)) THEN RAISE EXCEPTION 'FINANCIAL_CONTRACT_NOT_ENROLLED'; END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION public.r36_contract_snapshot_guard() OWNER TO r36_owner;
CREATE OR REPLACE FUNCTION public.r36_contract_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'FINANCIAL_POLICY_IMMUTABLE'; END $$;
ALTER FUNCTION public.r36_contract_immutable() OWNER TO r36_owner;
DROP TRIGGER IF EXISTS financial_policy_immutable ON public.r36_financial_policy_versions;
CREATE TRIGGER financial_policy_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.r36_financial_policy_versions FOR EACH STATEMENT EXECUTE FUNCTION public.r36_contract_immutable();
DROP TRIGGER IF EXISTS financial_network_immutable ON public.kernel_financial_network;
CREATE TRIGGER financial_network_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.kernel_financial_network FOR EACH STATEMENT EXECUTE FUNCTION public.r36_contract_immutable();
REVOKE ALL ON FUNCTION public.r36_contract_snapshot_guard(),public.r36_contract_immutable() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.r36_contract_outgoing_stroops(p_payment text,p_kind text) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s jsonb;
BEGIN
 IF p_kind NOT IN ('settlement','refund') THEN RETURN NULL; END IF;
 SELECT to_jsonb(c) INTO s FROM public.settlement_checkpoints c WHERE payment_id=p_payment;
 IF s IS NULL OR NOT public.r36_contract_valid(s) THEN RETURN NULL; END IF;
 RETURN ((CASE WHEN p_kind='settlement' THEN (s->>'merchant_amount')::numeric ELSE (s->>'customer_amount')::numeric END)*10000000)::bigint::text;
END $$;
ALTER FUNCTION public.r36_contract_outgoing_stroops(text,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_contract_outgoing_stroops(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r36_contract_outgoing_stroops(text,text) TO r36_runtime,neondb_owner;

REVOKE ALL ON FUNCTION public.r36_network(),public.r36_incoming_wallet(text),public.r36_contract_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r36_network(),public.r36_incoming_wallet(text),public.r36_contract_valid(jsonb) TO neondb_owner,r36_runtime,r36_registrar_owner,r36_signer_owner;

-- Login services keep their original exact-call ACL. Definer owners invoke these helpers.
REVOKE ALL ON FUNCTION public.r36_network(),public.r36_incoming_wallet(text),public.r36_contract_valid(jsonb),public.r36_contract_outgoing_stroops(text,text) FROM r36_issuer,r36_signer,r36_registrar;

CREATE TABLE public.kernel_deployment_identity (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 application_id text NOT NULL CHECK (application_id ~ '^[a-z][a-z0-9-]{2,79}$'),
 profile_sha256 text NOT NULL CHECK (profile_sha256 ~ '^[a-f0-9]{64}$'),
 database_branch text NOT NULL, recovery_cutover timestamptz NOT NULL,
 historical_holds text[] NOT NULL, kernel_version text NOT NULL CHECK (kernel_version='0.1.0-kernel.1')
);
ALTER TABLE public.kernel_deployment_identity OWNER TO neondb_owner;
REVOKE ALL ON public.kernel_deployment_identity FROM PUBLIC;
GRANT SELECT ON public.kernel_deployment_identity TO r36_owner,r36_runtime,r36_evidence_reader;
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11 (Debian 17.11-1.pgdg13+2)
-- Dumped by pg_dump version 17.11 (Debian 17.11-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: r36_registration; Type: SCHEMA; Schema: -; Owner: r36_registrar_owner
--

CREATE SCHEMA r36_registration;


ALTER SCHEMA r36_registration OWNER TO r36_registrar_owner;

--
-- Name: r36_signing; Type: SCHEMA; Schema: -; Owner: r36_signer_owner
--

CREATE SCHEMA r36_signing;


ALTER SCHEMA r36_signing OWNER TO r36_signer_owner;

--
-- Name: r36_admission_expiry(text, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_admission_expiry(p_nonce text, p_original text) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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


ALTER FUNCTION public.r36_admission_expiry(p_nonce text, p_original text) OWNER TO r36_owner;

--
-- Name: r36_advance_settlement_prepared(text, text, text, numeric, numeric, text, text, text, text, text, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_advance_settlement_prepared(p_payment text, p_merchant text, p_uid text, p_customer numeric, p_merchant_amount numeric, p_a2u text, p_from text, p_to text, p_xdr text, p_hash text, p_seq text) RETURNS TABLE(version bigint, stage text, advanced boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
BEGIN
 IF session_user <> 'r36_runtime' OR p_payment IS NULL OR btrim(p_payment)='' OR
    p_hash !~ '^[0-9a-f]{64}$' OR p_seq !~ '^[1-9][0-9]{0,29}$' OR
    p_xdr IS NULL OR btrim(p_xdr)<>p_xdr OR p_xdr='' OR
    p_customer IS NULL OR p_customer<=0 OR p_merchant_amount IS NULL OR p_merchant_amount<=0 OR p_merchant_amount>p_customer
 THEN RAISE EXCEPTION 'R36_SETTLEMENT_INPUT_OR_ROLE_REJECTED'; END IF;
 RETURN QUERY UPDATE public.settlement_checkpoints s SET
  version=s.version+1,stage='prepared',prepared_envelope_xdr=p_xdr,
  prepared_tx_hash=p_hash,prepared_sequence=p_seq::numeric(30,0),updated_at=now()
 WHERE s.payment_id=p_payment AND s.stage='a2u_created' AND
 s.merchant_id=p_merchant AND s.merchant_uid=p_uid AND
 s.customer_amount=p_customer AND s.merchant_amount=p_merchant_amount AND
 public.r36_contract_valid(to_jsonb(s)) AND s.a2u_payment_id=p_a2u AND
 s.a2u_from_address=p_from AND s.a2u_to_address=p_to AND
 s.prepared_envelope_xdr IS NULL AND s.prepared_tx_hash IS NULL AND
 s.prepared_sequence IS NULL AND s.a2u_txid IS NULL AND
 s.horizon_confirmed_at IS NULL
 RETURNING s.version::bigint,s.stage::text,true;
END $_$;


ALTER FUNCTION public.r36_advance_settlement_prepared(p_payment text, p_merchant text, p_uid text, p_customer numeric, p_merchant_amount numeric, p_a2u text, p_from text, p_to text, p_xdr text, p_hash text, p_seq text) OWNER TO r36_owner;

--
-- Name: r36_bind_initial_clearance(text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_bind_initial_clearance(p_nonce text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
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
 IF b->>'network' IS DISTINCT FROM public.r36_network() OR b->>'nonce' IS DISTINCT FROM p_nonce
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
 OR public.r36_contract_outgoing_stroops(ingress.payment_id,b->>'operationKind') IS DISTINCT FROM b->>'amountStroops'
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
END $_$;


ALTER FUNCTION public.r36_bind_initial_clearance(p_nonce text) OWNER TO r36_owner;

--
-- Name: r36_bound_effective_expiry(text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_bound_effective_expiry(p_approval text) RETURNS timestamp with time zone
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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


ALTER FUNCTION public.r36_bound_effective_expiry(p_approval text) OWNER TO r36_owner;

--
-- Name: r36_bound_lifecycle_context(text, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_bound_lifecycle_context(p_nonce text, p_closure text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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
 expected=encode(sha256(convert_to(jsonb_build_array('R36_BOUND_SUCCESSOR_V1',public.r36_network(),a.source_wallet,
 prior->>'owner_payment_id',prior->>'operation_kind',prior->>'owner_operation_id',prior->>'prepared_tx_hash',prior->>'prepared_sequence',
 b->>'paymentId',b->>'operationKind',b->>'operationId',b->>'preparedHash',b->>'preparedSequence',p_nonce)::text,'UTF8')),'hex');
 RETURN t||jsonb_build_object('boundRenewal',EXISTS(SELECT 1 FROM public.r36_lifecycle_approval_links WHERE successor_nonce=p_nonce),'bindingDigest',expected,'successorNonce',p_nonce,'successorCertificateDigest',receipt.payload_digest,
 'closureDigest',p_closure,'closureExpiresAt',a.expires_at,'certificateExpiresAt',public.r36_admission_expiry(p_nonce,receipt.payload_digest),'inventoryDigest',a.inventory_digest,
 'successorClearanceDigest',b->>'clearanceDigest');
END $$;


ALTER FUNCTION public.r36_bound_lifecycle_context(p_nonce text, p_closure text) OWNER TO r36_owner;

--
-- Name: r36_certificate_allows(text, text, text, text, text, text, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_certificate_allows(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE r record; now_s bigint;
BEGIN
 IF session_user<>'r36_runtime' OR p_network IS DISTINCT FROM public.r36_network() THEN RETURN false; END IF;
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
END $$;


ALTER FUNCTION public.r36_certificate_allows(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text) OWNER TO r36_owner;

--
-- Name: r36_certificate_context(text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_certificate_context(p_nonce text) RETURNS jsonb
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
  'approvalRecordDigest',p.approval_record_digest,'workerProfile',p.worker_profile)) || public.r36_renewal_issuer_state(p_nonce);
END $$;


ALTER FUNCTION public.r36_certificate_context(p_nonce text) OWNER TO r36_owner;

--
-- Name: r36_certificate_gate_version(); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_certificate_gate_version() RETURNS integer
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog'
    AS $$SELECT 1$$;


ALTER FUNCTION public.r36_certificate_gate_version() OWNER TO r36_owner;

--
-- Name: r36_certificate_policy_immutable(); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_certificate_policy_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
DECLARE before_doc jsonb; after_doc jsonb; before_roots jsonb; after_roots jsonb;
 old_root jsonb; new_root jsonb; old_clean jsonb:='[]'; new_clean jsonb:='[]';
 i integer; checked bigint; deadline bigint; n bigint:=floor(extract(epoch FROM clock_timestamp()))::bigint;
BEGIN
 before_doc:=to_jsonb(OLD)-ARRAY['enabled','revoked','revocation_checked_at','revocation_valid_until'];
 after_doc:=to_jsonb(NEW)-ARRAY['enabled','revoked','revocation_checked_at','revocation_valid_until'];
 IF before_doc=after_doc THEN RETURN NEW; END IF;
 before_roots:=OLD.worker_profile->'authorities'; after_roots:=NEW.worker_profile->'authorities';
 IF jsonb_typeof(before_roots) IS DISTINCT FROM 'array' OR jsonb_typeof(after_roots) IS DISTINCT FROM 'array'
 OR jsonb_array_length(before_roots)<>jsonb_array_length(after_roots)
 OR jsonb_array_length(before_roots) NOT BETWEEN 1 AND 32
 THEN RAISE EXCEPTION 'POLICY_CONTENT_IMMUTABLE_USE_NEW_DIGEST'; END IF;
 FOR i IN 0..jsonb_array_length(before_roots)-1 LOOP
  old_root:=before_roots->i; new_root:=after_roots->i;
  IF jsonb_typeof(old_root) IS DISTINCT FROM 'object' OR jsonb_typeof(new_root) IS DISTINCT FROM 'object'
  OR (old_root-ARRAY['revocationCheckedAt','revocationValidUntil']) IS DISTINCT FROM
     (new_root-ARRAY['revocationCheckedAt','revocationValidUntil'])
  THEN RAISE EXCEPTION 'POLICY_CONTENT_IMMUTABLE_USE_NEW_DIGEST'; END IF;
  IF old_root IS DISTINCT FROM new_root THEN
   IF jsonb_typeof(new_root->'revocationCheckedAt') IS DISTINCT FROM 'number'
   OR jsonb_typeof(new_root->'revocationValidUntil') IS DISTINCT FROM 'number'
   OR jsonb_typeof(old_root->'revocationCheckedAt') IS DISTINCT FROM 'number'
   OR jsonb_typeof(new_root->'validUntil') IS DISTINCT FROM 'number'
   OR (new_root->>'revocationCheckedAt') !~ '^[0-9]{1,16}$'
   OR (new_root->>'revocationValidUntil') !~ '^[0-9]{1,16}$'
   OR (old_root->>'revocationCheckedAt') !~ '^[0-9]{1,16}$'
   OR (new_root->>'validUntil') !~ '^[0-9]{1,16}$'
   THEN RAISE EXCEPTION 'INVALID_AUTHORITY_OBSERVATION'; END IF;
   checked:=(new_root->>'revocationCheckedAt')::bigint; deadline:=(new_root->>'revocationValidUntil')::bigint;
   IF checked<=(old_root->>'revocationCheckedAt')::bigint OR checked>n OR checked<NEW.valid_from
   OR deadline<=checked OR deadline>checked+120 OR deadline>NEW.valid_until
   OR deadline>(new_root->>'validUntil')::bigint OR deadline>9007199254740991
   THEN RAISE EXCEPTION 'INVALID_AUTHORITY_OBSERVATION'; END IF;
  END IF;
  old_clean:=old_clean||jsonb_build_array(old_root-ARRAY['revocationCheckedAt','revocationValidUntil']);
  new_clean:=new_clean||jsonb_build_array(new_root-ARRAY['revocationCheckedAt','revocationValidUntil']);
 END LOOP;
 before_doc:=jsonb_set(before_doc,'{worker_profile,authorities}',old_clean,false);
 after_doc:=jsonb_set(after_doc,'{worker_profile,authorities}',new_clean,false);
 IF before_doc IS DISTINCT FROM after_doc THEN RAISE EXCEPTION 'POLICY_CONTENT_IMMUTABLE_USE_NEW_DIGEST'; END IF;
 RETURN NEW;
END $_$;


ALTER FUNCTION public.r36_certificate_policy_immutable() OWNER TO r36_owner;

--
-- Name: r36_claim_bound_successor(text, text, text, text, text, text, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_claim_bound_successor(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
DECLARE old public.financial_wallet_authorities; seal public.financial_wallet_finality_seals;
 grant_row record; next_binding jsonb; now_at timestamptz; expected text;
BEGIN
 IF session_user<>'r36_runtime' OR current_setting('transaction_isolation')<>'read committed'
 OR p_network IS DISTINCT FROM public.r36_network() OR p_seq IS NULL OR p_seq !~ '^[1-9][0-9]{0,29}$'
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
    AND public.r36_contract_valid(to_jsonb(s))
    AND t.merchant_id=s.merchant_id AND t.merchant_uid=s.merchant_uid AND t.status='completed' AND t.currency='π'
    AND t.amount=s.merchant_amount AND r.merchant_id=s.merchant_id AND r.merchant_uid=s.merchant_uid
    AND r.currency='π' AND r.amount=s.merchant_amount AND r.customer_amount=s.customer_amount
    AND r.merchant_amount=s.merchant_amount AND r.app_commission=s.app_commission AND r.txid=s.a2u_txid
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
END $_$;


ALTER FUNCTION public.r36_claim_bound_successor(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text) OWNER TO r36_owner;

--
-- Name: r36_claim_first_submission(text, text, text, text, text, text, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_claim_first_submission(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
DECLARE admitted text;
BEGIN
 IF NOT public.r36_certificate_allows(p_network,p_wallet,p_payment,p_kind,p_operation,p_hash,p_seq) THEN RETURN false; END IF;
 IF p_network <> public.r36_network() OR p_wallet !~ '^G[A-Z2-7]{55}$'
    OR p_payment IS NULL OR btrim(p_payment) <> p_payment OR p_payment = ''
    OR p_operation IS NULL OR btrim(p_operation) <> p_operation OR p_operation = ''
    OR p_kind NOT IN ('settlement','refund')
    OR p_hash !~ '^[0-9a-f]{64}$' OR p_seq !~ '^[1-9][0-9]*$' THEN RETURN false; END IF;
 PERFORM 1 FROM public.financial_wallet_authorities a
  WHERE a.network=p_network AND a.source_wallet=p_wallet AND a.owner_payment_id=p_payment
   AND a.operation_kind=p_kind AND a.owner_operation_id=p_operation
   AND a.prepared_tx_hash=p_hash AND a.prepared_sequence=p_seq AND a.state='prepared'
  FOR UPDATE;
 IF NOT FOUND OR public.r36_certificate_allows(p_network,p_wallet,p_payment,p_kind,p_operation,p_hash,p_seq) IS DISTINCT FROM true
 THEN RETURN false; END IF;
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
      AND public.r36_held_refund_outside_scope(p_wallet,r.payment_id,r.refund_id,(SELECT i.policy_digest FROM public.r36_testnet_ingress_reservations i WHERE i.payment_id=p_payment AND i.source_wallet=p_wallet)) IS DISTINCT FROM true
        AND NOT EXISTS (SELECT 1 FROM public.financial_wallet_authorities ra
           WHERE ra.network=p_network AND ra.operation_kind='refund'
             AND ra.owner_payment_id=r.payment_id AND ra.owner_operation_id=r.refund_id
             AND ra.source_wallet<>p_wallet AND ra.state='prepared'))
 FOR UPDATE OF a
 ON CONFLICT DO NOTHING RETURNING prepared_tx_hash INTO admitted;
 RETURN COALESCE(admitted = p_hash, false);
END;
$_$;


ALTER FUNCTION public.r36_claim_first_submission(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text) OWNER TO r36_owner;

--
-- Name: r36_claim_prepared_authority(text, text, text, text, text, text, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_claim_prepared_authority(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
DECLARE admitted text;
BEGIN
 IF NOT public.r36_certificate_allows(p_network,p_wallet,p_payment,p_kind,p_operation,p_hash,p_seq) THEN RETURN false; END IF;
 IF p_network IS DISTINCT FROM public.r36_network() OR p_wallet IS NULL OR p_wallet !~ '^G[A-Z2-7]{55}$'
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
      AND public.r36_held_refund_outside_scope(p_wallet,r.payment_id,r.refund_id,(SELECT i.policy_digest FROM public.r36_testnet_ingress_reservations i WHERE i.payment_id=p_payment AND i.source_wallet=p_wallet)) IS DISTINCT FROM true
      AND NOT EXISTS (SELECT 1 FROM public.financial_wallet_authorities ra
         WHERE ra.network=p_network AND ra.operation_kind='refund'
           AND ra.owner_payment_id=r.payment_id AND ra.owner_operation_id=r.refund_id
           AND ra.source_wallet<>p_wallet AND ra.state='prepared')) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.financial_wallet_authorities WHERE network=p_network AND source_wallet=p_wallet
    AND (owner_payment_id,operation_kind,owner_operation_id,prepared_tx_hash,prepared_sequence)
      IS DISTINCT FROM (p_payment,p_kind,p_operation,p_hash,p_seq)) THEN
  IF public.r36_claim_bound_successor(p_network,p_wallet,p_payment,p_kind,p_operation,p_hash,p_seq) IS DISTINCT FROM true THEN RETURN false; END IF;
 END IF;
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
$_$;


ALTER FUNCTION public.r36_claim_prepared_authority(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text) OWNER TO r36_owner;

--
-- Name: r36_claim_rejected_refund_create(text, text, text, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_claim_rejected_refund_create(p_refund text, p_payment text, p_key text, p_policy text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
DECLARE auth public.refund_rejected_create_authorizations; policy public.r36_certificate_policies;
 reservation public.r36_testnet_ingress_reservations; refund public.refund_checkpoints;
 settlement public.settlement_checkpoints; selected jsonb; consumed integer;
BEGIN
 IF session_user<>'r36_runtime' OR current_setting('transaction_isolation')<>'read committed'
 OR p_refund IS NULL OR p_refund='' OR p_refund<>btrim(p_refund)
 OR p_payment IS NULL OR p_payment='' OR p_payment<>btrim(p_payment)
 OR p_key IS NULL OR p_key='' OR p_key<>btrim(p_key)
 OR p_policy IS NULL OR p_policy!~'^[0-9a-f]{64}$' THEN RETURN 'HELD'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('FLASHpay:R36:TESTNET_TRIAL_BUDGET:1',0));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_payment,0));
 IF pg_has_role(session_user,'r36_owner','MEMBER')
 OR has_table_privilege(session_user,'public.refund_rejected_create_authorizations','INSERT,UPDATE,DELETE,TRUNCATE')
 OR has_any_column_privilege(session_user,'public.refund_rejected_create_authorizations','INSERT,UPDATE')
 OR has_table_privilege(session_user,'public.refund_rejected_create_attempts','INSERT,UPDATE,DELETE,TRUNCATE')
 OR has_any_column_privilege(session_user,'public.refund_rejected_create_attempts','INSERT,UPDATE') THEN RETURN 'HELD'; END IF;
 SELECT * INTO auth FROM public.refund_rejected_create_authorizations WHERE refund_id=p_refund FOR SHARE;
 IF NOT FOUND OR (auth.payment_id,auth.idempotency_key,auth.policy_digest) IS DISTINCT FROM (p_payment,p_key,p_policy)
 OR auth.network<>public.r36_network() OR auth.rejection_http_status<>400 OR auth.rejection_code<>'ongoing_payment_found'
 OR clock_timestamp() NOT BETWEEN auth.authorized_at AND auth.expires_at THEN RETURN 'HELD'; END IF;
 SELECT * INTO policy FROM public.r36_certificate_policies WHERE policy_digest=p_policy FOR SHARE;
 IF NOT FOUND OR NOT policy.enabled OR policy.revoked
 OR extract(epoch FROM clock_timestamp()) NOT BETWEEN policy.valid_from AND least(policy.valid_until,policy.revocation_valid_until)-1
 OR policy.worker_profile->'recoveryPilot'->>'schema' IS DISTINCT FROM 'FLASHPAY_TESTNET_NEW_RIGHTS_V1' THEN RETURN 'HELD'; END IF;
 SELECT * INTO reservation FROM public.r36_testnet_ingress_reservations WHERE payment_id=p_payment FOR UPDATE;
 IF NOT FOUND OR reservation.retired_by_payment_id IS NOT NULL
 OR (reservation.policy_digest,reservation.source_wallet,reservation.amount_stroops) IS DISTINCT FROM (p_policy,auth.source_wallet,auth.amount_stroops)
 OR reservation.payer_uid IS NULL OR reservation.payer_wallet IS NULL
 OR NOT EXISTS(SELECT 1 FROM public.financial_wallet_activation WHERE network=public.r36_network() AND source_wallet=auth.source_wallet AND state='enabled' FOR SHARE) THEN RETURN 'HELD'; END IF;
 -- Existing writers serialize on the payment advisory lock already held.
 -- Read-only access deliberately avoids granting UPDATE on accounting tables.
 SELECT * INTO refund FROM public.refund_checkpoints WHERE refund_id=p_refund;
 IF NOT FOUND OR (refund.payment_id,refund.idempotency_key,refund.payer_uid,refund.amount*10000000) IS DISTINCT FROM (p_payment,p_key,reservation.payer_uid,auth.amount_stroops::numeric)
 OR refund.status<>'pending' OR refund.stage<>'wallet_submission_started' OR refund.pi_mutation_guard_version<>'fin7_v2'
 OR refund.refund_payment_id IS NOT NULL OR refund.refund_txid IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.refund_automatic_retirements WHERE refund_id=p_refund) THEN RETURN 'HELD'; END IF;
 SELECT * INTO settlement FROM public.settlement_checkpoints WHERE payment_id=p_payment;
 IF NOT FOUND OR settlement.stage<>'payment_identity' OR settlement.u2a_identifier IS NULL OR settlement.u2a_txid IS NULL
 OR settlement.u2a_verified_at IS NULL OR settlement.u2a_completed_at IS NULL
 OR (settlement.payer_uid,settlement.customer_amount*10000000)
 IS DISTINCT FROM (reservation.payer_uid,auth.amount_stroops::numeric) OR NOT public.r36_contract_valid(to_jsonb(settlement))
 OR settlement.a2u_payment_id IS NOT NULL OR settlement.a2u_txid IS NOT NULL OR settlement.prepared_tx_hash IS NOT NULL
 OR settlement.db_finalized_at IS NOT NULL OR settlement.horizon_confirmed_at IS NOT NULL THEN RETURN 'HELD'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.refund_pi_create_attempts WHERE refund_id=p_refund AND payment_id=p_payment AND idempotency_key=p_key AND attempted_at=auth.original_attempted_at)
 OR EXISTS(SELECT 1 FROM public.financial_wallet_authorities WHERE owner_payment_id=p_payment)
 OR EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts WHERE owner_payment_id=p_payment)
 OR EXISTS(SELECT 1 FROM public.refund_accounting_records WHERE refund_id=p_refund OR payment_id=p_payment)
 OR EXISTS(SELECT 1 FROM public.transactions WHERE payment_id=settlement.u2a_identifier) THEN RETURN 'HELD'; END IF;
 -- Reuse the existing scoped selector: current policy, wallet, customer,
 -- budget, execution scope, historical holds and original XOR eligibility.
 selected:=public.r36_next_testnet_preparation(p_payment,p_policy);
 IF selected IS NULL OR (selected->>'id',selected->>'kind',selected->>'op',selected->>'phase')
 IS DISTINCT FROM (p_payment,'refund',p_refund,'preparation_only') THEN RETURN 'HELD'; END IF;
 -- Recheck after all possible waits, immediately before durable consumption.
 IF clock_timestamp()>=auth.expires_at OR extract(epoch FROM clock_timestamp())>=least(policy.valid_until,policy.revocation_valid_until)-1 THEN RETURN 'HELD'; END IF;
 INSERT INTO public.refund_rejected_create_attempts(refund_id,payment_id,idempotency_key,review_sha256)
 VALUES(p_refund,p_payment,p_key,auth.review_sha256) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS consumed=ROW_COUNT;
 RETURN CASE WHEN consumed=1 THEN 'RECORDED' ELSE 'REPLAYED' END;
END $_$;


ALTER FUNCTION public.r36_claim_rejected_refund_create(p_refund text, p_payment text, p_key text, p_policy text) OWNER TO r36_owner;

--
-- Name: r36_deny_held_right_write(); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_deny_held_right_write() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $_$
DECLARE payload jsonb; item jsonb; token text; hit boolean; decoded text;
BEGIN
 IF TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='r36_legacy_right_holds' THEN
  RAISE EXCEPTION USING ERRCODE='P6401',MESSAGE='LEGACY_HOLD_IMMUTABLE';
 END IF;
 IF TG_OP='TRUNCATE' THEN
  IF EXISTS(SELECT 1 FROM public.r36_legacy_right_holds) THEN
   RAISE EXCEPTION USING ERRCODE='P6401',MESSAGE='LEGACY_RIGHT_HELD_NO_RESEND';
  END IF; RETURN NULL;
 END IF;
 payload:=jsonb_build_array(CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END,
                           CASE WHEN TG_OP IN ('UPDATE','INSERT') THEN to_jsonb(NEW) ELSE NULL END);
 IF TG_TABLE_SCHEMA='r36_signing' AND TG_TABLE_NAME='requests' THEN
  -- Protected signing input is encoded JSON. Malformed input fails closed.
  IF TG_OP IN ('UPDATE','DELETE') THEN decoded:=convert_from(decode(OLD.bytes_base64,'base64'),'UTF8'); payload:=payload||jsonb_build_array(substring(decoded FROM position(chr(10) IN decoded)+1)::jsonb); END IF;
  IF TG_OP IN ('UPDATE','INSERT') THEN decoded:=convert_from(decode(NEW.bytes_base64,'base64'),'UTF8'); payload:=payload||jsonb_build_array(substring(decoded FROM position(chr(10) IN decoded)+1)::jsonb); END IF;
 END IF;
 FOR item IN SELECT jsonb_path_query(payload,'strict $.**') LOOP
  IF jsonb_typeof(item)<>'string' THEN CONTINUE; END IF;
  token:=item #>> '{}';
  SELECT EXISTS(SELECT 1 FROM public.r36_legacy_right_holds h WHERE token=ANY(h.identity_values)
    OR token ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND lower(token)=ANY(h.identity_values)) INTO hit;
  IF hit THEN RAISE EXCEPTION USING ERRCODE='P6401',MESSAGE='LEGACY_RIGHT_HELD_NO_RESEND'; END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $_$;


ALTER FUNCTION public.r36_deny_held_right_write() OWNER TO r36_owner;

--
-- Name: r36_execution_scope_immutable(); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_execution_scope_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog'
    AS $$
BEGIN RAISE EXCEPTION 'EXECUTION_SCOPE_IMMUTABLE_CREATE_NEW_POLICY_VERSION'; END $$;


ALTER FUNCTION public.r36_execution_scope_immutable() OWNER TO r36_owner;

--
-- Name: r36_general_policy(jsonb); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_general_policy(p jsonb) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
 SELECT coalesce(p->'generalOperation'->>'schema'=ANY(ARRAY['R36_GENERAL_TESTNET_V1','R36_GENERAL_NETWORK_V2']) AND (public.r36_network()='Pi Testnet' OR p->'generalOperation'->>'schema'='R36_GENERAL_NETWORK_V2')
 AND p->'generalOperation'->>'network'=public.r36_network()
 AND p->'generalOperation'->>'identitySource'='PI_V2_ME'
 AND p->'generalOperation'->>'sourceWallet' ~ '^G[A-Z2-7]{55}$'
 AND p->'generalOperation'->>'maxAmountStroops' ~ '^[1-9][0-9]{0,13}$'
 AND CASE WHEN p->'generalOperation'->>'maxAmountStroops' ~ '^[1-9][0-9]{0,13}$'
   THEN (p->'generalOperation'->>'maxAmountStroops')::numeric BETWEEN 1 AND 10000000000000 ELSE false END
 AND p->'generalOperation'->'allowTerminalReservationTurnover'='true'::jsonb
 AND NOT(p ? 'recoveryPilot'),false)
$_$;


ALTER FUNCTION public.r36_general_policy(p jsonb) OWNER TO r36_owner;

--
-- Name: r36_held_refund_outside_scope(text, text, text, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_held_refund_outside_scope(p_wallet text, p_payment text, p_refund text, p_policy text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE h public.r36_legacy_right_holds; s public.r36_wallet_execution_scopes; p public.r36_certificate_policies;
 doc jsonb; bound jsonb; observed jsonb; birth timestamptz;
BEGIN
 IF session_user<>'r36_runtime' OR p_policy IS NULL OR p_wallet IS NULL THEN RETURN false; END IF;
 SELECT * INTO p FROM public.r36_certificate_policies WHERE policy_digest=p_policy FOR SHARE;
 IF NOT FOUND OR NOT p.enabled OR p.revoked
 OR extract(epoch FROM clock_timestamp()) NOT BETWEEN p.valid_from AND least(p.valid_until,p.revocation_valid_until)-1
 OR public.r36_policy_wallet(p.worker_profile) IS DISTINCT FROM p_wallet
 THEN RETURN false; END IF;
 SELECT * INTO s FROM public.r36_wallet_execution_scopes WHERE policy_digest=p_policy AND source_wallet=p_wallet
 AND scope_digest=p.worker_profile->>'executionScopeDigest' FOR SHARE;
 IF NOT FOUND THEN RETURN false; END IF;
 doc:=s.scope_text::jsonb;
 IF doc->>'schema' IS DISTINCT FROM 'R36_NEW_WALLET_EXECUTION_SCOPE_V1'
 OR doc->>'network' IS DISTINCT FROM public.r36_network() OR doc->>'sourceWallet' IS DISTINCT FROM p_wallet
 OR doc->>'oldRightsDisposition' IS DISTINCT FROM 'DEFERRED_PRESERVED_NO_RESEND'
 OR doc->'oldRightsFinanciallyCleared' IS DISTINCT FROM 'false'::jsonb
 OR jsonb_typeof(doc->'legacyHolds') IS DISTINCT FROM 'array'
 OR jsonb_typeof(doc->'baseline'->'refunds') IS DISTINCT FROM 'array'
 OR jsonb_typeof(doc->'baseline'->'settlements') IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 birth:=(doc->>'genesisClosedAt')::timestamptz;
 SELECT * INTO h FROM public.r36_legacy_right_holds WHERE payment_id=p_payment FOR SHARE;
 IF NOT FOUND OR h.kind<>'refund' OR h.network<>public.r36_network() OR h.state<>'HELD_UNRESOLVED_NO_RESEND'
 OR h.authorizes_new_rights OR h.held_at>=birth OR birth>s.enrolled_at OR birth IS NULL
 THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(doc->'legacyHolds') x WHERE x->>'payment_id'=p_payment
 AND x->>'original_snapshot_sha256'=h.original_snapshot_sha256 AND x->>'state'=h.state
 AND x->'authorizes_new_rights'='false'::jsonb AND (x->>'held_at')::timestamptz=h.held_at)<>1
 OR (SELECT count(*) FROM jsonb_array_elements(doc->'baseline'->'refunds') x WHERE x->>'payment_id'=p_payment AND x->>'refund_id'=p_refund)<>1
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'baseline'->'settlements') x WHERE x->>'a2u_from_address'=p_wallet)
 THEN RETURN false; END IF;
 -- Re-read the original full protected snapshot, not Redis or caller assertions.
 SELECT jsonb_build_object('settlements',coalesce((SELECT jsonb_agg(CASE
  -- A pre-fee hold has no financial_contract key. Preserve its original
  -- shape only when the added column is NULL; never hide a real contract.
  WHEN t.financial_contract IS NULL AND EXISTS (
   SELECT 1 FROM jsonb_array_elements(h.original_snapshot->'settlements') prior
   WHERE prior->>'payment_id'=t.payment_id AND NOT (prior ? 'financial_contract'))
  THEN to_jsonb(t)-'financial_contract' ELSE to_jsonb(t) END ORDER BY payment_id)
 FROM public.settlement_checkpoints t WHERE payment_id=p_payment),'[]'::jsonb),
 'refunds',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY refund_id) FROM public.refund_checkpoints t WHERE payment_id=p_payment),'[]'::jsonb)) INTO observed;
 IF observed IS DISTINCT FROM h.original_snapshot
 OR NOT EXISTS(SELECT 1 FROM public.refund_checkpoints WHERE payment_id=p_payment AND refund_id=p_refund AND status IN ('pending','manual_review_required'))
 THEN RETURN false; END IF;
 -- Both original hold triggers must still be enabled; no mutable waiver is used.
 IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.refund_checkpoints'::regclass AND tgname IN ('r36_held_write','r36_held_truncate') AND tgenabled='O')<>2
 THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN RETURN false;
END $$;


ALTER FUNCTION public.r36_held_refund_outside_scope(p_wallet text, p_payment text, p_refund text, p_policy text) OWNER TO r36_owner;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: refund_checkpoints; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.refund_checkpoints (
    refund_id text NOT NULL,
    payment_id text NOT NULL,
    idempotency_key text NOT NULL,
    status text NOT NULL,
    stage text NOT NULL,
    payer_uid text NOT NULL,
    payer_uid_verified_at timestamp without time zone NOT NULL,
    amount numeric(18,8) NOT NULL,
    currency text DEFAULT 'π'::text NOT NULL,
    source_payment_status text NOT NULL,
    source_settlement_state text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    refund_payment_id text,
    refund_txid text,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_error_code text,
    last_error_message text,
    next_retry_at timestamp without time zone,
    pi_mutation_guard_version text,
    CONSTRAINT refund_checkpoints_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT refund_checkpoints_attempt_count_check CHECK ((attempt_count >= 0))
);


ALTER TABLE public.refund_checkpoints OWNER TO neondb_owner;

--
-- Name: r36_insert_refund_prepared_audit(text, text, text, text, text, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_insert_refund_prepared_audit(p_refund text, p_payment text, p_key text, p_refund_payment text, p_auth_event text, p_prepared_event text, p_started_event text, p_details jsonb) RETURNS SETOF public.refund_checkpoints
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $_$
BEGIN
 IF session_user <> 'r36_runtime' OR p_refund IS NULL OR p_payment IS NULL OR
    p_key IS NULL OR p_refund_payment IS NULL OR
    p_prepared_event <> 'refund:'||p_refund||':blockchain_submit_prepared' OR
    p_auth_event <> 'refund:'||p_refund||':blockchain_submit_authorized' OR
    p_started_event <> 'refund:'||p_refund||':blockchain_submission_started' OR
    p_details IS NULL OR jsonb_typeof(p_details)<>'object' OR
    (SELECT count(*) FROM jsonb_object_keys(p_details))<>5 OR
    p_details->>'phase'<>'horizon_prepared' OR
    p_details->>'refundPaymentId' IS DISTINCT FROM p_refund_payment OR
    (p_details->>'preparedHash') !~ '^[0-9a-f]{64}$' OR
    (p_details->>'preparedSequence') !~ '^[1-9][0-9]*$' OR
    coalesce(p_details->>'envelopeXdr','')=''
 THEN RAISE EXCEPTION 'R36_REFUND_INPUT_OR_ROLE_REJECTED'; END IF;
 RETURN QUERY WITH source AS (
  SELECT c.* FROM public.refund_checkpoints c JOIN public.refund_audit_events a
    ON a.event_id=p_started_event AND a.refund_id=c.refund_id AND a.payment_id=c.payment_id
   AND a.idempotency_key=c.idempotency_key AND a.actor_type='system'
   AND a.event_type='refund_blockchain_submission_started'
   AND a.details=jsonb_build_object('refundPaymentId',p_refund_payment,'phase','blockchain_submission')
  WHERE c.refund_id=p_refund AND c.payment_id=p_payment AND c.idempotency_key=p_key
    AND c.refund_payment_id=p_refund_payment AND c.stage='wallet_submission_started' AND c.status='pending'
    AND NOT EXISTS (SELECT 1 FROM public.refund_audit_events z WHERE z.event_id=p_auth_event
       AND z.refund_id=c.refund_id AND z.payment_id=c.payment_id AND z.idempotency_key=c.idempotency_key
       AND z.event_type='refund_blockchain_submit_authorized')
 ), inserted AS (
  INSERT INTO public.refund_audit_events(event_id,refund_id,payment_id,event_type,actor_type,idempotency_key,created_at,details)
  SELECT p_prepared_event,refund_id,payment_id,'refund_blockchain_submit_prepared','system',idempotency_key,now(),p_details FROM source
  ON CONFLICT (event_id) DO NOTHING RETURNING refund_id
 ) SELECT source.* FROM source JOIN inserted USING(refund_id);
END $_$;


ALTER FUNCTION public.r36_insert_refund_prepared_audit(p_refund text, p_payment text, p_key text, p_refund_payment text, p_auth_event text, p_prepared_event text, p_started_event text, p_details jsonb) OWNER TO r36_owner;

--
-- Name: r36_lifecycle_job_receipt(text, text, text, text, text, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_lifecycle_job_receipt(p_kind text, p_policy text, p_wallet text, p_subject text, p_aux text, p_text text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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


ALTER FUNCTION public.r36_lifecycle_job_receipt(p_kind text, p_policy text, p_wallet text, p_subject text, p_aux text, p_text text) OWNER TO r36_owner;

--
-- Name: r36_next_inbound_observation(text, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_next_inbound_observation(p_subject text, p_policy text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
DECLARE v record;
BEGIN
 IF session_user<>'r36_runtime' OR p_policy IS NULL OR p_policy !~ '^[0-9a-f]{64}$'
 OR (p_subject IS NOT NULL AND p_subject !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN RETURN NULL; END IF;
 SELECT b.payment_id,b.payer_uid,b.source_wallet,b.amount_stroops::text,c.u2a_approval_identifier AS pi_payment_id,
  b.merchant_uid,b.merchant_id INTO v
 FROM public.r36_payment_intake i JOIN public.r36_testnet_ingress_reservations b USING(payment_id)
 JOIN public.r36_certificate_policies p ON p.policy_digest=b.policy_digest
 JOIN public.payment_create_intents o ON o.payment_id=b.payment_id
 JOIN public.settlement_checkpoints c ON c.payment_id=b.payment_id
 WHERE b.policy_digest=p_policy AND i.policy_digest=p_policy AND b.retired_by_payment_id IS NULL
 AND i.wallet_contract='PI_PAYMENT_DTO_V1' AND (p_subject IS NULL OR b.payment_id=p_subject)
 AND (i.merchant_uid,i.merchant_id,i.source_wallet,i.amount_stroops,i.payer_uid,i.create_intent_id,i.note_digest)
   =(b.merchant_uid,b.merchant_id,b.source_wallet,b.amount_stroops,b.payer_uid,b.create_intent_id,b.note_digest)
 AND (o.merchant_uid,o.merchant_id,o.create_intent_id,o.customer_amount*10000000)
   =(b.merchant_uid,b.merchant_id,b.create_intent_id,b.amount_stroops)
 AND (c.merchant_uid,c.merchant_id,c.customer_amount)
   =(o.merchant_uid,o.merchant_id,o.customer_amount) AND public.r36_contract_valid(to_jsonb(c))
 AND b.payer_uid IS NOT NULL AND c.stage='payment_identity' AND c.u2a_verified_at IS NULL
 AND c.u2a_approval_identifier IS NOT NULL AND c.u2a_approval_claimed_at IS NOT NULL AND c.u2a_approval_attempted_at IS NOT NULL
 AND c.u2a_identifier IS NULL AND c.u2a_txid IS NULL AND c.u2a_completed_at IS NULL
 AND c.a2u_payment_id IS NULL AND c.prepared_tx_hash IS NULL
 AND NOT EXISTS(SELECT 1 FROM public.refund_checkpoints r WHERE r.payment_id=b.payment_id)
 AND NOT EXISTS(SELECT 1 FROM public.r36_legacy_right_holds h WHERE h.payment_id=b.payment_id)
 AND NOT EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts a WHERE a.owner_payment_id=b.payment_id)
 AND public.r36_general_policy(p.worker_profile) AND p.enabled AND NOT p.revoked
 AND extract(epoch FROM clock_timestamp()) BETWEEN p.valid_from AND least(p.valid_until,p.revocation_valid_until)-1
 AND EXISTS(SELECT 1 FROM public.financial_wallet_activation a WHERE a.network=public.r36_network() AND a.source_wallet=b.source_wallet AND a.state='enabled')
 ORDER BY o.created_at,b.payment_id LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN to_jsonb(v);
END $_$;


ALTER FUNCTION public.r36_next_inbound_observation(p_subject text, p_policy text) OWNER TO r36_owner;

--
-- Name: r36_next_testnet_preparation(text, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_next_testnet_preparation(p_subject text, p_policy text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
DECLARE v record;
BEGIN
 IF session_user<>'r36_runtime' OR current_setting('transaction_isolation')<>'read committed'
 OR p_policy IS NULL OR p_policy !~ '^[0-9a-f]{64}$'
 OR (p_subject IS NOT NULL AND p_subject !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
 THEN RETURN NULL; END IF;
 FOR v IN SELECT i.payment_id AS id,b.source_wallet AS wallet,b.payer_wallet,b.payer_uid,b.amount_stroops,
   CASE WHEN r.payment_id IS NULL THEN 'settlement' ELSE 'refund' END AS kind,
   CASE WHEN r.payment_id IS NULL THEN i.payment_id ELSE r.refund_id END AS op,
   CASE WHEN r.payment_id IS NULL THEN s.stage ELSE r.stage END AS stage,
   r.refund_payment_id IS NOT NULL AS pi_created, s.u2a_completed_at IS NULL AS completion_missing,
   (r.payment_id IS NULL AND s.customer_amount=0.1 AND s.stage='payment_identity' AND s.certification_hold='dr11_refund') AS certification_recovery
 FROM public.r36_testnet_ingress_reservations b
 JOIN public.r36_certificate_policies p ON p.policy_digest=b.policy_digest
 JOIN public.r36_wallet_execution_scopes scope ON scope.policy_digest=p.policy_digest
   AND scope.scope_digest=p.worker_profile->>'executionScopeDigest' AND scope.source_wallet=b.source_wallet
 JOIN public.payment_create_intents i ON i.payment_id=b.payment_id
 JOIN public.settlement_checkpoints s ON s.payment_id=i.payment_id
 LEFT JOIN public.refund_checkpoints r ON r.payment_id=i.payment_id
 WHERE b.policy_digest=p_policy AND b.retired_by_payment_id IS NULL
   AND public.r36_policy_subject(p.worker_profile,b)
   AND (p_subject IS NULL OR i.payment_id=p_subject)
   AND i.created_at>(scope.scope_text::jsonb->>'genesisClosedAt')::timestamptz
   AND i.created_at<=statement_timestamp() AND b.reserved_at<=statement_timestamp()
   AND b.amount_stroops BETWEEN 1 AND public.r36_policy_max_amount(p.worker_profile) AND i.customer_amount*10000000=b.amount_stroops
   AND (i.merchant_id,i.merchant_uid)=(b.merchant_id,b.merchant_uid)
   AND (s.merchant_id,s.merchant_uid,s.customer_amount)
       =(i.merchant_id,i.merchant_uid,i.customer_amount) AND public.r36_contract_valid(to_jsonb(s))
   AND s.version>=2 AND s.payer_uid=b.payer_uid AND s.u2a_identifier IS NOT NULL AND btrim(s.u2a_identifier)<>''
   AND s.u2a_txid ~ '^[0-9a-f]{64}$' AND s.u2a_verified_at IS NOT NULL
   AND ((s.u2a_completed_at IS NOT NULL AND s.version>=3 AND s.u2a_completed_at<=statement_timestamp())
     OR (s.u2a_completed_at IS NULL AND s.stage='payment_identity' AND r.payment_id IS NULL
       AND s.a2u_payment_id IS NULL AND s.pi_mutation_guard_version='fin7_v2'))
   AND NOT EXISTS(SELECT 1 FROM public.r36_legacy_right_holds h WHERE h.payment_id=i.payment_id)
   AND NOT EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts a WHERE a.owner_payment_id=i.payment_id)
   AND NOT EXISTS(SELECT 1 FROM public.financial_wallet_authorities a WHERE a.owner_payment_id=i.payment_id)
   AND ((r.payment_id IS NULL AND (s.certification_hold IS NULL OR (s.customer_amount=0.1 AND s.stage='payment_identity'
       AND s.certification_hold='dr11_refund' AND s.certification_hold_at IS NOT NULL
       AND s.certification_hold_expires_at>clock_timestamp())) AND s.stage IN ('payment_identity','a2u_created')
       AND s.a2u_txid IS NULL AND s.prepared_tx_hash IS NULL
       AND (s.stage='payment_identity' OR (s.a2u_from_address=b.source_wallet AND (s.a2u_to_address=b.merchant_wallet OR (b.merchant_wallet IS NULL AND s.a2u_to_address ~ '^G[A-Z2-7]{55}$' AND EXISTS(SELECT 1 FROM public.r36_payment_intake x WHERE x.payment_id=b.payment_id AND x.wallet_contract='PI_PAYMENT_DTO_V1'))))))
     OR (s.stage='payment_identity' AND s.a2u_payment_id IS NULL AND r.status='pending'
       AND r.amount=i.customer_amount AND r.currency='π' AND r.payer_uid=s.payer_uid AND r.payer_uid_verified_at IS NOT NULL
       AND r.source_payment_status='settlement_failed' AND r.source_settlement_state='refund_pending'
       AND r.refund_txid IS NULL AND (r.next_retry_at IS NULL OR r.next_retry_at AT TIME ZONE 'UTC'<=clock_timestamp())
       AND r.stage IN ('eligibility_verified','intent_created','wallet_submission_started')
       AND (r.stage='wallet_submission_started' OR r.refund_payment_id IS NULL)))
 ORDER BY i.created_at,i.payment_id LOOP
   -- Reuse the original current policy, activation, payer, wallet and reserved
   -- amount verifier. 'verify' does not write or reserve any additional budget.
   IF public.r36_prepare_testnet_ingress('verify',p_policy,jsonb_build_object(
     'paymentId',v.id,'payerUid',v.payer_uid,'fromAddress',v.payer_wallet,
     'toAddress',public.r36_incoming_wallet(v.wallet),'amountStroops',v.amount_stroops::text)) IS NULL THEN CONTINUE; END IF;
   RETURN jsonb_build_object('phase',CASE WHEN v.completion_missing THEN 'u2a_completion' WHEN v.certification_recovery THEN 'certification_recovery' ELSE 'preparation_only' END,'id',v.id,'kind',v.kind,'op',v.op,
     'stage',v.stage,'piCreated',v.pi_created);
 END LOOP;
 RETURN NULL;
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN RETURN NULL;
END $_$;


ALTER FUNCTION public.r36_next_testnet_preparation(p_subject text, p_policy text) OWNER TO r36_owner;

--
-- Name: r36_observe_owner_policy(text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_observe_owner_policy(p_policy text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
DECLARE p public.r36_certificate_policies; root jsonb; roots jsonb:='[]'::jsonb;
 n bigint; deadline bigint; checked bigint; root_end bigint;
BEGIN
 IF session_user<>'r36_issuer' OR current_setting('transaction_isolation')<>'read committed'
 OR p_policy IS NULL OR p_policy !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
 SELECT * INTO p FROM public.r36_certificate_policies WHERE policy_digest=p_policy FOR UPDATE;
 -- The caller cannot supply revocation state, clock, root, deadline or an update.
 -- The protected owner registry is the expressly enrolled revocation authority.
 n:=floor(extract(epoch FROM clock_timestamp()))::bigint;
 IF NOT FOUND OR NOT p.enabled OR p.revoked OR n<p.valid_from OR n>=p.valid_until
 OR p.worker_profile->'revocationRegistry' IS DISTINCT FROM jsonb_build_object(
   'schema','R36_OWNER_CONTROLLED_REVOCATION_REGISTRY_V1','observerRole','r36_issuer','maxObservationSeconds',120)
 OR jsonb_typeof(p.worker_profile->'authorities') IS DISTINCT FROM 'array'
 OR jsonb_array_length(p.worker_profile->'authorities') NOT BETWEEN 1 AND 32
 OR p.revocation_checked_at>n THEN RETURN NULL; END IF;
 FOR root IN SELECT value FROM jsonb_array_elements(p.worker_profile->'authorities') LOOP
  IF jsonb_typeof(root) IS DISTINCT FROM 'object' OR root->'revoked' IS DISTINCT FROM 'false'::jsonb
  OR coalesce(root->>'validFrom','') !~ '^[0-9]{1,16}$'
  OR coalesce(root->>'validUntil','') !~ '^[0-9]{1,16}$'
  OR coalesce(root->>'revocationCheckedAt','') !~ '^[0-9]{1,16}$'
  OR coalesce(root->>'revocationValidUntil','') !~ '^[0-9]{1,16}$'
  THEN RETURN NULL; END IF;
  checked:=(root->>'revocationCheckedAt')::bigint; root_end:=(root->>'validUntil')::bigint;
  IF checked>n OR n<(root->>'validFrom')::bigint OR n>=root_end THEN RETURN NULL; END IF;
  IF checked<n THEN
   root:=root||jsonb_build_object('revocationCheckedAt',n,'revocationValidUntil',least(n+120,p.valid_until,root_end));
  ELSIF (root->>'revocationValidUntil')::bigint<=n THEN RETURN NULL;
  END IF;
  roots:=roots||jsonb_build_array(root);
 END LOOP;
 deadline:=least(n+120,p.valid_until);
 IF p.revocation_checked_at<n OR roots IS DISTINCT FROM p.worker_profile->'authorities' THEN
  UPDATE public.r36_certificate_policies SET revocation_checked_at=n,revocation_valid_until=deadline,
   worker_profile=jsonb_set(worker_profile,'{authorities}',roots,false) WHERE policy_digest=p_policy;
 ELSE deadline:=p.revocation_valid_until;
 END IF;
 IF deadline<=n THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('schema','R36_OWNER_REGISTRY_OBSERVATION_V1','policyDigest',p_policy,
  'observedAt',n,'validUntil',deadline,'financialAuthority',false,'networkFinality',false);
END $_$;


ALTER FUNCTION public.r36_observe_owner_policy(p_policy text) OWNER TO r36_owner;

--
-- Name: r36_operation_settings(text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_operation_settings(p_policy text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE p public.r36_certificate_policies; BEGIN
 IF session_user<>'r36_runtime' THEN RETURN NULL; END IF;
 SELECT * INTO p FROM public.r36_certificate_policies WHERE policy_digest=p_policy;
 IF NOT FOUND OR NOT p.enabled OR p.revoked OR extract(epoch FROM clock_timestamp()) NOT BETWEEN p.valid_from AND least(p.valid_until,p.revocation_valid_until)-1
 OR public.r36_policy_max_amount(p.worker_profile)=0
 OR NOT EXISTS(SELECT 1 FROM public.financial_wallet_activation WHERE network=public.r36_network() AND source_wallet=public.r36_policy_wallet(p.worker_profile) AND state='enabled') THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('mode',CASE WHEN public.r36_general_policy(p.worker_profile) THEN 'general' ELSE 'pilot' END,'maxAmountStroops',public.r36_policy_max_amount(p.worker_profile)::text);
END $$;


ALTER FUNCTION public.r36_operation_settings(p_policy text) OWNER TO r36_owner;

--
-- Name: r36_policy_max_amount(jsonb); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_policy_max_amount(p jsonb) RETURNS bigint
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
 SELECT CASE WHEN public.r36_general_policy(p) THEN (p->'generalOperation'->>'maxAmountStroops')::bigint
 WHEN public.r36_network()='Pi Testnet' AND p->'recoveryPilot'->>'schema'='FLASHPAY_TESTNET_NEW_RIGHTS_V1' AND NOT(p ? 'generalOperation') THEN 2000000 ELSE 0 END
$$;


ALTER FUNCTION public.r36_policy_max_amount(p jsonb) OWNER TO r36_owner;

--
-- Name: r36_testnet_ingress_reservations; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_testnet_ingress_reservations (
    payment_id text NOT NULL,
    policy_digest text NOT NULL,
    merchant_uid text NOT NULL,
    merchant_id text NOT NULL,
    create_intent_id uuid NOT NULL,
    note_digest text NOT NULL,
    source_wallet text NOT NULL,
    merchant_wallet text,
    amount_stroops bigint NOT NULL,
    payer_uid text,
    payer_wallet text,
    reserved_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    retired_by_payment_id text,
    CONSTRAINT ingress_not_own_successor CHECK ((retired_by_payment_id IS DISTINCT FROM payment_id)),
    CONSTRAINT r36_testnet_ingress_reservations_amount_stroops_check CHECK (((amount_stroops >= 1) AND (amount_stroops <= '10000000000000'::bigint))),
    CONSTRAINT r36_testnet_ingress_reservations_check CHECK ((((payer_uid IS NULL) AND (payer_wallet IS NULL)) OR ((payer_uid IS NOT NULL) AND (payer_wallet ~ '^G[A-Z2-7]{55}$'::text)))),
    CONSTRAINT r36_testnet_ingress_reservations_merchant_wallet_check CHECK ((merchant_wallet ~ '^G[A-Z2-7]{55}$'::text)),
    CONSTRAINT r36_testnet_ingress_reservations_note_digest_check CHECK ((note_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_testnet_ingress_reservations_payment_id_check CHECK ((payment_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT r36_testnet_ingress_reservations_source_wallet_check CHECK ((source_wallet ~ '^G[A-Z2-7]{55}$'::text))
);


ALTER TABLE public.r36_testnet_ingress_reservations OWNER TO r36_owner;

--
-- Name: r36_policy_subject(jsonb, public.r36_testnet_ingress_reservations); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_policy_subject(p jsonb, b public.r36_testnet_ingress_reservations) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
 SELECT coalesce(b.source_wallet=public.r36_policy_wallet(p) AND b.amount_stroops BETWEEN 1 AND public.r36_policy_max_amount(p)
 AND CASE WHEN public.r36_general_policy(p) THEN EXISTS(SELECT 1 FROM public.r36_payment_intake i
 WHERE (i.payment_id,i.policy_digest,i.source_wallet,i.merchant_uid,i.merchant_id,i.merchant_wallet,i.create_intent_id,i.note_digest,i.amount_stroops,i.payer_uid,i.payer_wallet)
 IS NOT DISTINCT FROM (b.payment_id,b.policy_digest,b.source_wallet,b.merchant_uid,b.merchant_id,b.merchant_wallet,b.create_intent_id,b.note_digest,b.amount_stroops,b.payer_uid,b.payer_wallet)
 AND i.payer_wallet IS NOT NULL AND (i.wallet_contract='PI_V2_ME' OR
 (i.wallet_contract='PI_PAYMENT_DTO_V1' AND i.payer_pi_payment_id IS NOT NULL AND i.payer_txid IS NOT NULL AND i.payer_wallet_proven_at<=statement_timestamp()
 AND (i.merchant_wallet IS NULL OR i.merchant_pi_payment_id IS NOT NULL)))
 AND i.identity_source='PI_V2_ME' AND i.identity_verified_at<=statement_timestamp() AND i.payer_verified_at<=statement_timestamp())
 ELSE public.r36_network()='Pi Testnet' AND p->'recoveryPilot'->>'schema'='FLASHPAY_TESTNET_NEW_RIGHTS_V1' AND NOT(p ? 'generalOperation')
 AND p->'recoveryPilot'->'wallets' @> jsonb_build_array(b.source_wallet,b.merchant_wallet,b.payer_wallet)
 AND p->'recoveryPilot'->'payerUids' @> jsonb_build_array(b.payer_uid)
 AND p->'recoveryPilot'->'ingress'->'merchants' @> jsonb_build_array(jsonb_build_object('uid',b.merchant_uid,'username',b.merchant_id,'wallet',b.merchant_wallet))
 AND p->'recoveryPilot'->'ingress'->'payers' @> jsonb_build_array(jsonb_build_object('uid',b.payer_uid,'wallet',b.payer_wallet)) END,false)
$$;


ALTER FUNCTION public.r36_policy_subject(p jsonb, b public.r36_testnet_ingress_reservations) OWNER TO r36_owner;

--
-- Name: r36_policy_wallet(jsonb); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_policy_wallet(p jsonb) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
 SELECT CASE WHEN public.r36_general_policy(p) THEN p->'generalOperation'->>'sourceWallet' ELSE p->'recoveryPilot'->'ingress'->>'sourceWallet' END
$$;


ALTER FUNCTION public.r36_policy_wallet(p jsonb) OWNER TO r36_owner;

--
-- Name: r36_prepare_testnet_ingress(text, text, jsonb); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_prepare_testnet_ingress(p_action text, p_policy text, p_input jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
DECLARE policy public.r36_certificate_policies; pilot jsonb; config jsonb; person jsonb;
 stored public.r36_testnet_ingress_reservations; total numeric; wallet text; value bigint; prior_id text; general boolean; intake public.r36_payment_intake; admit jsonb;
BEGIN
 IF session_user<>'r36_runtime' OR current_setting('transaction_isolation')<>'read committed'
 OR p_action IS NULL OR p_action NOT IN ('reserve','bind','verify','inbound','prepared','approval') OR p_policy IS NULL OR p_policy !~ '^[0-9a-f]{64}$'
 OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('FLASHpay:R36:TESTNET_TRIAL_BUDGET:1',0));
 SELECT * INTO policy FROM public.r36_certificate_policies WHERE policy_digest=p_policy FOR SHARE;
 IF NOT FOUND OR NOT policy.enabled OR policy.revoked
 OR extract(epoch FROM clock_timestamp()) NOT BETWEEN policy.valid_from AND least(policy.valid_until,policy.revocation_valid_until)-1
 THEN RETURN NULL; END IF;
 general:=public.r36_general_policy(policy.worker_profile);
 pilot:=policy.worker_profile->'recoveryPilot'; config:=pilot->'ingress';
 IF policy.worker_profile ? 'generalOperation' AND NOT general THEN RETURN NULL; END IF;
 IF NOT general AND (pilot->>'schema' IS DISTINCT FROM 'FLASHPAY_TESTNET_NEW_RIGHTS_V1'
 OR config->>'schema' IS DISTINCT FROM 'FLASHPAY_TESTNET_INGRESS_V1'
 OR jsonb_typeof(config->'merchants') IS DISTINCT FROM 'array'
 OR jsonb_typeof(config->'payers') IS DISTINCT FROM 'array'
 OR coalesce(config->>'sourceWallet','') !~ '^G[A-Z2-7]{55}$') THEN RETURN NULL; END IF;
 wallet:=public.r36_policy_wallet(policy.worker_profile);
 IF NOT general AND (jsonb_typeof(pilot->'wallets') IS DISTINCT FROM 'array' OR jsonb_typeof(pilot->'payerUids') IS DISTINCT FROM 'array' OR NOT (pilot->'wallets' @> jsonb_build_array(wallet))) THEN RETURN NULL; END IF;
 -- Recheck activation at every admission, including after an earlier reservation.
 -- A budget row must not outlive the operator's current wallet hold.
 IF NOT EXISTS(SELECT 1 FROM public.financial_wallet_activation
     WHERE network=public.r36_network() AND source_wallet=wallet AND state='enabled'
     AND clearance_digest ~ '^[0-9a-f]{64}$' FOR SHARE) THEN RETURN NULL; END IF;

 -- Intake does not acquire wallet authority or authorize any Pi payment.
 IF general AND p_action='reserve' THEN
  IF coalesce(p_input->>'paymentId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR coalesce(p_input->>'createIntentId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR coalesce(p_input->>'merchantUid','') !~ '^[A-Za-z0-9_.:-]{1,128}$'
  OR coalesce(p_input->>'merchantId','') !~ '^[A-Za-z0-9_.:-]{1,128}$'
  OR coalesce(p_input->>'merchantWallet','')<>'' OR p_input->>'walletContract' IS DISTINCT FROM 'PI_PAYMENT_DTO_V1'
  OR coalesce(p_input->>'amountStroops','') !~ '^[1-9][0-9]{0,13}$'
  OR coalesce(p_input->>'noteDigest','') !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
  value:=(p_input->>'amountStroops')::bigint;
  IF value>public.r36_policy_max_amount(policy.worker_profile) THEN RETURN NULL; END IF;
  SELECT * INTO intake FROM public.r36_payment_intake WHERE merchant_uid=p_input->>'merchantUid' AND create_intent_id=(p_input->>'createIntentId')::uuid;
  IF FOUND THEN
   IF (intake.policy_digest,intake.merchant_id,intake.note_digest,intake.amount_stroops,intake.wallet_contract)
   IS DISTINCT FROM(p_policy,p_input->>'merchantId',p_input->>'noteDigest',value,'PI_PAYMENT_DTO_V1') THEN RETURN NULL; END IF;
   RETURN jsonb_build_object('paymentId',intake.payment_id,'phase','request_only');
  END IF;
  INSERT INTO public.r36_payment_intake(payment_id,policy_digest,source_wallet,merchant_uid,merchant_id,merchant_wallet,create_intent_id,note_digest,amount_stroops,identity_source,wallet_contract)
  VALUES(p_input->>'paymentId',p_policy,wallet,p_input->>'merchantUid',p_input->>'merchantId',NULL,(p_input->>'createIntentId')::uuid,p_input->>'noteDigest',value,'PI_V2_ME','PI_PAYMENT_DTO_V1');
  RETURN jsonb_build_object('paymentId',p_input->>'paymentId','phase','request_only');
 END IF;
 IF general AND p_action='bind' THEN
  IF coalesce(p_input->>'payerUid','') !~ '^[A-Za-z0-9_.:-]{1,128}$' OR coalesce(p_input->>'payerWallet','')<>'' THEN RETURN NULL; END IF;
  SELECT * INTO intake FROM public.r36_payment_intake WHERE payment_id=p_input->>'paymentId' AND policy_digest=p_policy FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.payment_create_intents i WHERE i.payment_id=intake.payment_id AND i.merchant_uid=intake.merchant_uid AND i.merchant_id=intake.merchant_id AND i.customer_amount*10000000=intake.amount_stroops) THEN RETURN NULL; END IF;
  IF intake.wallet_contract IS DISTINCT FROM 'PI_PAYMENT_DTO_V1' OR (intake.payer_uid IS NOT NULL AND intake.payer_uid IS DISTINCT FROM p_input->>'payerUid') THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.r36_testnet_ingress_reservations WHERE payment_id=intake.payment_id) THEN
   SELECT payment_id INTO prior_id FROM public.r36_testnet_ingress_reservations WHERE source_wallet=wallet AND retired_by_payment_id IS NULL FOR UPDATE;
   IF (prior_id IS NOT NULL OR EXISTS(SELECT 1 FROM public.financial_wallet_authorities WHERE network=public.r36_network() AND source_wallet=wallet))
    AND (prior_id IS NULL OR public.r36_terminal_ingress_clearance(p_policy,wallet,prior_id) IS DISTINCT FROM true) THEN RETURN NULL; END IF;
   IF EXISTS(SELECT 1 FROM public.settlement_checkpoints WHERE a2u_from_address=wallet AND stage IN ('a2u_created','prepared','horizon_confirmed','pi_completed'))
    OR EXISTS(SELECT 1 FROM public.refund_checkpoints r WHERE r.status IN ('pending','manual_review_required')
      AND public.r36_held_refund_outside_scope(wallet,r.payment_id,r.refund_id,p_policy) IS DISTINCT FROM true
      AND NOT EXISTS(SELECT 1 FROM public.financial_wallet_authorities a WHERE a.network=public.r36_network() AND a.operation_kind='refund' AND a.owner_payment_id=r.payment_id AND a.owner_operation_id=r.refund_id AND a.source_wallet<>wallet AND a.state='prepared')) THEN RETURN NULL; END IF;
   IF prior_id IS NOT NULL THEN
    IF public.r36_terminal_ingress_clearance(p_policy,wallet,prior_id) IS DISTINCT FROM true THEN RETURN NULL; END IF;
    UPDATE public.r36_testnet_ingress_reservations SET retired_by_payment_id=intake.payment_id WHERE payment_id=prior_id AND retired_by_payment_id IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'INGRESS_SLOT_CHANGED'; END IF;
   END IF;
   INSERT INTO public.r36_testnet_ingress_reservations(payment_id,policy_digest,merchant_uid,merchant_id,create_intent_id,note_digest,source_wallet,merchant_wallet,amount_stroops)
   VALUES(intake.payment_id,p_policy,intake.merchant_uid,intake.merchant_id,intake.create_intent_id,intake.note_digest,wallet,intake.merchant_wallet,intake.amount_stroops);
  END IF;
  UPDATE public.r36_payment_intake SET payer_uid=p_input->>'payerUid',payer_verified_at=clock_timestamp()
   WHERE payment_id=intake.payment_id AND payer_uid IS NULL;
 END IF;
 IF p_action='reserve' THEN
  IF coalesce(p_input->>'paymentId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR coalesce(p_input->>'amountStroops','') !~ '^[1-9][0-9]{0,6}$'
  OR coalesce(p_input->>'noteDigest','') !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
  value:=(p_input->>'amountStroops')::bigint;
  IF value>2000000 THEN RETURN NULL; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(config->'merchants') x WHERE x->>'uid'=p_input->>'merchantUid')<>1 THEN RETURN NULL; END IF;
  SELECT x INTO person FROM jsonb_array_elements(config->'merchants') x
   WHERE x->>'uid'=p_input->>'merchantUid' AND x->>'username'=p_input->>'merchantId';
  IF person IS NULL OR coalesce(person->>'wallet','') !~ '^G[A-Z2-7]{55}$'
  OR NOT (pilot->'wallets' @> jsonb_build_array(person->>'wallet')) THEN RETURN NULL; END IF;
  SELECT * INTO stored FROM public.r36_testnet_ingress_reservations
   WHERE merchant_uid=p_input->>'merchantUid' AND create_intent_id=(p_input->>'createIntentId')::uuid;
  IF FOUND THEN
   IF (stored.policy_digest,stored.merchant_id,stored.source_wallet,stored.merchant_wallet,stored.note_digest,stored.amount_stroops)
    IS DISTINCT FROM (p_policy,p_input->>'merchantId',wallet,person->>'wallet',p_input->>'noteDigest',value)
   THEN RETURN NULL; END IF;
   RETURN jsonb_build_object('paymentId',stored.payment_id);
  END IF;
  SELECT payment_id INTO prior_id FROM public.r36_testnet_ingress_reservations
   WHERE source_wallet=wallet AND retired_by_payment_id IS NULL FOR UPDATE;
  -- A legacy owner without its original budget reservation remains held.
  -- Only a completed, independently cleared prior right can free a creation slot.
  IF (prior_id IS NOT NULL OR EXISTS(SELECT 1 FROM public.financial_wallet_authorities
      WHERE network=public.r36_network() AND source_wallet=wallet))
   AND (prior_id IS NULL OR public.r36_terminal_ingress_clearance(p_policy,wallet,prior_id) IS DISTINCT FROM true)
  THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.financial_wallet_activation
      WHERE network=public.r36_network() AND source_wallet=wallet AND state='enabled' AND clearance_digest ~ '^[0-9a-f]{64}$')
  OR EXISTS(SELECT 1 FROM public.settlement_checkpoints WHERE a2u_from_address=wallet
       AND stage IN ('a2u_created','prepared','horizon_confirmed','pi_completed'))
  OR EXISTS(SELECT 1 FROM public.refund_checkpoints r WHERE r.status IN ('pending','manual_review_required')
      AND public.r36_held_refund_outside_scope(wallet,r.payment_id,r.refund_id,p_policy) IS DISTINCT FROM true
       AND NOT EXISTS(SELECT 1 FROM public.financial_wallet_authorities a WHERE a.network=public.r36_network()
         AND a.operation_kind='refund' AND a.owner_payment_id=r.payment_id AND a.owner_operation_id=r.refund_id
         AND a.source_wallet<>wallet AND a.state='prepared')) THEN RETURN NULL; END IF;
  SELECT 2*(coalesce((SELECT sum(amount_stroops) FROM public.r36_testnet_ingress_reservations b JOIN public.r36_certificate_policies p ON p.policy_digest=b.policy_digest WHERE NOT public.r36_general_policy(p.worker_profile)),0)
    +coalesce((SELECT sum(r.amount_stroops) FROM public.r36_recovery_trial_reservations r
      WHERE NOT EXISTS(SELECT 1 FROM public.r36_testnet_ingress_reservations i WHERE i.payment_id=r.payment_id)),0)) INTO total;
  IF total+2*value>10000000 THEN RETURN NULL; END IF;
  -- Check freshness after every potentially waiting read, immediately before
  -- retiring the slot. Both rows commit atomically; all rows still count in budget.
  IF prior_id IS NOT NULL THEN
   IF public.r36_terminal_ingress_clearance(p_policy,wallet,prior_id) IS DISTINCT FROM true THEN RETURN NULL; END IF;
   UPDATE public.r36_testnet_ingress_reservations SET retired_by_payment_id=p_input->>'paymentId'
    WHERE payment_id=prior_id AND retired_by_payment_id IS NULL;
   IF NOT FOUND THEN RAISE EXCEPTION 'INGRESS_SLOT_CHANGED'; END IF;
  END IF;
  INSERT INTO public.r36_testnet_ingress_reservations
   (payment_id,policy_digest,merchant_uid,merchant_id,create_intent_id,note_digest,source_wallet,merchant_wallet,amount_stroops)
  VALUES(p_input->>'paymentId',p_policy,p_input->>'merchantUid',p_input->>'merchantId',
    (p_input->>'createIntentId')::uuid,p_input->>'noteDigest',wallet,person->>'wallet',value);
  RETURN jsonb_build_object('paymentId',p_input->>'paymentId');
 END IF;
 SELECT * INTO stored FROM public.r36_testnet_ingress_reservations
  WHERE payment_id=p_input->>'paymentId' AND policy_digest=p_policy FOR UPDATE;
 IF NOT FOUND OR stored.retired_by_payment_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.payment_create_intents i WHERE i.payment_id=stored.payment_id
    AND i.merchant_uid=stored.merchant_uid AND i.merchant_id=stored.merchant_id
    AND i.customer_amount*10000000=stored.amount_stroops) THEN RETURN NULL; END IF;
 -- Initial preparation is separately gated; this does not grant first submission.
 -- The original R36 claim still checks checkpoint, XOR, historical liabilities,
 -- wallet ownership and attestation in the SAME restricted transaction.
 IF p_action='prepared' THEN
  IF stored.payer_uid IS NULL OR p_input->>'network' IS DISTINCT FROM public.r36_network()
   OR p_input->>'sourceWallet' IS DISTINCT FROM stored.source_wallet
   OR p_input->>'operationKind' NOT IN ('settlement','refund') THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.r36_certificate_requests q
    JOIN public.r36_certificate_receipts c ON c.nonce=q.nonce
    JOIN public.settlement_checkpoints s ON s.payment_id=stored.payment_id
    WHERE q.policy_digest=p_policy AND q.binding->>'paymentId'=stored.payment_id
    AND q.binding->>'network'=public.r36_network() AND q.binding->>'sourceWallet'=stored.source_wallet
    AND q.binding->>'operationKind'=p_input->>'operationKind' AND q.binding->>'operationId'=p_input->>'operationId'
    AND q.binding->>'preparedHash'=p_input->>'preparedHash' AND q.binding->>'preparedSequence'=p_input->>'preparedSequence'
    AND q.binding->>'amountStroops'=public.r36_contract_outgoing_stroops(stored.payment_id,p_input->>'operationKind')
    AND q.binding->>'destinationWallet'=CASE WHEN p_input->>'operationKind'='settlement' THEN stored.merchant_wallet ELSE stored.payer_wallet END
    AND q.binding->>'piPaymentId'=s.u2a_identifier AND q.binding->>'u2aTxid'=s.u2a_txid
    AND s.u2a_completed_at IS NOT NULL AND s.payer_uid=stored.payer_uid
    AND s.merchant_uid=stored.merchant_uid AND s.merchant_id=stored.merchant_id
    AND s.customer_amount*10000000=stored.amount_stroops)
   OR public.r36_certificate_allows(public.r36_network(),stored.source_wallet,stored.payment_id,
      p_input->>'operationKind',p_input->>'operationId',p_input->>'preparedHash',p_input->>'preparedSequence') IS DISTINCT FROM true
   THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('paymentId',stored.payment_id);
 END IF;
 IF general THEN
 SELECT * INTO intake FROM public.r36_payment_intake WHERE payment_id=stored.payment_id AND policy_digest=p_policy;
 IF NOT FOUND OR intake.payer_uid IS NULL OR intake.payer_uid IS DISTINCT FROM p_input->>'payerUid' THEN RETURN NULL; END IF;
 person:=jsonb_build_object('uid',intake.payer_uid,'wallet',intake.payer_wallet);
 ELSE
 IF (SELECT count(*) FROM jsonb_array_elements(config->'payers') x WHERE x->>'uid'=p_input->>'payerUid')<>1 THEN RETURN NULL; END IF;
 SELECT x INTO person FROM jsonb_array_elements(config->'payers') x WHERE x->>'uid'=p_input->>'payerUid';
 IF person IS NULL OR coalesce(person->>'wallet','') !~ '^G[A-Z2-7]{55}$'
 OR NOT (pilot->'wallets' @> jsonb_build_array(person->>'wallet'))
 OR NOT (pilot->'payerUids' @> jsonb_build_array(p_input->>'payerUid')) THEN RETURN NULL; END IF;
 END IF;
 IF p_action='bind' THEN
  IF stored.payer_uid IS NOT NULL AND (stored.payer_uid,stored.payer_wallet)
     IS DISTINCT FROM(p_input->>'payerUid',person->>'wallet') THEN RETURN NULL; END IF;
  UPDATE public.r36_testnet_ingress_reservations SET payer_uid=p_input->>'payerUid',payer_wallet=person->>'wallet'
    WHERE payment_id=stored.payment_id AND payer_uid IS NULL;
  RETURN jsonb_build_object('paymentId',stored.payment_id);
 END IF;
 -- Approval is before wallet signing. It requires the already-bound allowed
 -- identity and reserved budget. An absent source is not a financial proof;
 -- 'verify' below remains mandatory with the actual source after a transfer.
 IF p_action='approval' THEN
  IF stored.payer_uid IS NULL OR stored.payer_wallet IS DISTINCT FROM person->>'wallet'
   OR (stored.payer_uid,public.r36_incoming_wallet(stored.source_wallet),stored.amount_stroops::text)
    IS DISTINCT FROM(p_input->>'payerUid',p_input->>'toAddress',p_input->>'amountStroops')
   OR jsonb_typeof(p_input->'fromAddress') IS DISTINCT FROM 'string'
   OR (p_input->>'fromAddress'<>'' AND (p_input->>'fromAddress' !~ '^G[A-Z2-7]{55}$' OR (stored.payer_wallet IS NOT NULL AND p_input->>'fromAddress' IS DISTINCT FROM stored.payer_wallet)))
   OR NOT EXISTS(SELECT 1 FROM public.settlement_checkpoints s WHERE s.payment_id=stored.payment_id
     AND s.stage='payment_identity' AND s.u2a_identifier IS NULL AND s.u2a_txid IS NULL
     AND s.u2a_completed_at IS NULL AND s.a2u_payment_id IS NULL AND s.prepared_tx_hash IS NULL
     AND s.a2u_txid IS NULL AND s.customer_amount*10000000=stored.amount_stroops
     AND s.merchant_uid=stored.merchant_uid AND s.merchant_id=stored.merchant_id
     AND public.r36_contract_valid(to_jsonb(s)))
   OR EXISTS(SELECT 1 FROM public.refund_checkpoints r WHERE r.payment_id=stored.payment_id)
   OR EXISTS(SELECT 1 FROM public.r36_legacy_right_holds h WHERE h.payment_id=stored.payment_id)
   THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('paymentId',stored.payment_id,'phase','pretransaction_approval');
 END IF;
 -- A wallet address is learned from a canonical, already-verified Pi payment,
 -- never from SDK presentation fields or an invented /me wallet attribute.
 IF p_action='inbound' THEN
  IF coalesce(p_input->>'piPaymentId','') !~ '^[A-Za-z0-9_.:-]{1,128}$'
   OR coalesce(p_input->>'txid','') !~ '^[0-9a-f]{64}$'
   OR coalesce(p_input->>'fromAddress','') !~ '^G[A-Z2-7]{55}$'
   OR (stored.payer_uid,public.r36_incoming_wallet(stored.source_wallet),stored.amount_stroops::text)
     IS DISTINCT FROM(p_input->>'payerUid',p_input->>'toAddress',p_input->>'amountStroops')
   OR stored.payer_uid IS NULL OR p_input->>'fromAddress'=stored.source_wallet
   OR NOT EXISTS(SELECT 1 FROM public.settlement_checkpoints c WHERE c.payment_id=stored.payment_id
     AND c.merchant_uid=stored.merchant_uid AND c.merchant_id=stored.merchant_id
     AND c.customer_amount*10000000=stored.amount_stroops AND public.r36_contract_valid(to_jsonb(c))
     AND c.u2a_approval_identifier=p_input->>'piPaymentId' AND c.u2a_approval_claimed_at IS NOT NULL
     AND c.u2a_approval_attempted_at IS NOT NULL
     AND (c.u2a_identifier IS NULL OR c.u2a_identifier=p_input->>'piPaymentId')
     AND (c.u2a_txid IS NULL OR c.u2a_txid=p_input->>'txid')
     AND (c.payer_uid IS NULL OR c.payer_uid=stored.payer_uid))
   THEN RETURN NULL; END IF;
  IF general AND intake.wallet_contract='PI_PAYMENT_DTO_V1' THEN
   IF (intake.payer_wallet IS NOT NULL AND (intake.payer_wallet,intake.payer_pi_payment_id,intake.payer_txid)
     IS DISTINCT FROM(p_input->>'fromAddress',p_input->>'piPaymentId',p_input->>'txid'))
     OR (stored.payer_wallet IS NOT NULL AND stored.payer_wallet IS DISTINCT FROM p_input->>'fromAddress') THEN RETURN NULL; END IF;
   UPDATE public.r36_payment_intake SET payer_wallet=p_input->>'fromAddress',payer_pi_payment_id=p_input->>'piPaymentId',
     payer_txid=p_input->>'txid',payer_wallet_proven_at=clock_timestamp()
     WHERE payment_id=stored.payment_id AND payer_wallet IS NULL;
   UPDATE public.r36_testnet_ingress_reservations SET payer_wallet=p_input->>'fromAddress'
     WHERE payment_id=stored.payment_id AND payer_wallet IS NULL;
   stored.payer_wallet:=p_input->>'fromAddress';
  END IF;
 END IF;
 IF (stored.payer_uid,stored.payer_wallet,public.r36_incoming_wallet(stored.source_wallet),stored.amount_stroops::text)
   IS DISTINCT FROM (p_input->>'payerUid',p_input->>'fromAddress',p_input->>'toAddress',p_input->>'amountStroops')
 THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('paymentId',stored.payment_id);
END $_$;


ALTER FUNCTION public.r36_prepare_testnet_ingress(p_action text, p_policy text, p_input jsonb) OWNER TO r36_owner;

--
-- Name: r36_prepared_evidence_candidate(text, jsonb); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_prepared_evidence_candidate(p_action text, p_input jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
DECLARE i jsonb; saved jsonb; body jsonb; res public.r36_testnet_ingress_reservations;
 cp public.settlement_checkpoints; rf public.refund_checkpoints; policy public.r36_certificate_policies; deferred_wallet boolean;
BEGIN
 IF session_user<>'r36_runtime' OR current_setting('transaction_isolation')<>'read committed'
 OR p_action IS NULL OR p_action NOT IN ('read','stage') OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
 THEN RETURN NULL; END IF;
 i:=CASE WHEN p_action='read' THEN p_input ELSE p_input->'identity' END;
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR
 (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(i) k) IS DISTINCT FROM
 ARRAY['amountStroops','destinationWallet','network','operationId','operationKind','paymentId','piPaymentId','sourceWallet']::text[]
 OR EXISTS(SELECT 1 FROM jsonb_each(i) kv WHERE jsonb_typeof(kv.value)<>'string')
 OR i->>'network' IS DISTINCT FROM public.r36_network()
 OR coalesce(i->>'paymentId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
 OR coalesce(i->>'operationKind','') NOT IN ('settlement','refund')
 OR coalesce(i->>'operationId','') !~ '^[A-Za-z0-9_.:-]{1,128}$'
 OR coalesce(i->>'piPaymentId','') !~ '^[A-Za-z0-9_.:-]{1,128}$'
 OR coalesce(i->>'sourceWallet','') !~ '^G[A-Z2-7]{55}$'
 OR coalesce(i->>'destinationWallet','') !~ '^G[A-Z2-7]{55}$'
 OR coalesce(i->>'amountStroops','') !~ '^[1-9][0-9]{0,13}$'
 OR (i->>'amountStroops')::bigint>10000000000000 THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(i->>'paymentId',0));
 -- Denial metadata does not clear an old obligation or permit a new right.
 IF EXISTS(SELECT 1 FROM public.r36_legacy_right_holds WHERE identity_values && ARRAY[i->>'paymentId',i->>'operationId',i->>'piPaymentId',p_input->>'preparedHash']) THEN RETURN NULL; END IF;
 SELECT * INTO res FROM public.r36_testnet_ingress_reservations WHERE payment_id=i->>'paymentId' FOR UPDATE;
 deferred_wallet:=res.merchant_wallet IS NULL AND i->>'operationKind'='settlement' AND EXISTS(SELECT 1 FROM public.r36_payment_intake x WHERE x.payment_id=res.payment_id AND x.wallet_contract='PI_PAYMENT_DTO_V1');
 IF NOT FOUND OR res.payer_uid IS NULL OR res.payer_wallet IS NULL
 OR (res.source_wallet,public.r36_contract_outgoing_stroops(res.payment_id,i->>'operationKind')) IS DISTINCT FROM(i->>'sourceWallet',i->>'amountStroops')
 OR (NOT deferred_wallet AND i->>'destinationWallet' IS DISTINCT FROM (CASE WHEN i->>'operationKind'='settlement' THEN res.merchant_wallet ELSE res.payer_wallet END))
 THEN RETURN NULL; END IF;
 SELECT * INTO policy FROM public.r36_certificate_policies WHERE policy_digest=res.policy_digest FOR SHARE;
 IF NOT FOUND OR NOT policy.enabled OR policy.revoked
 OR extract(epoch FROM clock_timestamp()) NOT BETWEEN policy.valid_from AND least(policy.valid_until,policy.revocation_valid_until)-1
 OR public.r36_policy_subject(policy.worker_profile,res) IS DISTINCT FROM true
 THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.financial_wallet_activation WHERE network=public.r36_network() AND source_wallet=res.source_wallet
 AND state='enabled' AND clearance_digest ~ '^[0-9a-f]{64}$' FOR SHARE)
 OR NOT EXISTS(SELECT 1 FROM public.payment_create_intents WHERE payment_id=res.payment_id AND merchant_uid=res.merchant_uid
 AND merchant_id=res.merchant_id AND create_intent_id=res.create_intent_id AND customer_amount*10000000=res.amount_stroops)
 THEN RETURN NULL; END IF;
 SELECT * INTO cp FROM public.settlement_checkpoints WHERE payment_id=res.payment_id;
 IF NOT FOUND OR (cp.merchant_uid,cp.merchant_id,cp.payer_uid) IS DISTINCT FROM(res.merchant_uid,res.merchant_id,res.payer_uid)
 OR cp.customer_amount*10000000 IS DISTINCT FROM res.amount_stroops::numeric OR NOT public.r36_contract_valid(to_jsonb(cp))
 OR cp.u2a_verified_at IS NULL OR cp.u2a_completed_at IS NULL OR coalesce(cp.u2a_identifier,'')='' OR coalesce(cp.u2a_txid,'') !~ '^[0-9a-f]{64}$'
 OR cp.prepared_envelope_xdr IS NOT NULL OR cp.prepared_tx_hash IS NOT NULL OR cp.prepared_sequence IS NOT NULL OR cp.a2u_txid IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.transactions WHERE payment_id=res.payment_id)
 OR EXISTS(SELECT 1 FROM public.refund_accounting_records WHERE payment_id=res.payment_id)
 OR EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts WHERE owner_payment_id=res.payment_id)
 THEN RETURN NULL; END IF;
 IF i->>'operationKind'='settlement' THEN
  IF cp.stage IS DISTINCT FROM 'a2u_created' OR NOT public.r36_contract_valid(to_jsonb(cp))
  OR (cp.a2u_payment_id,cp.a2u_from_address,cp.a2u_to_address) IS DISTINCT FROM(i->>'piPaymentId',res.source_wallet,CASE WHEN deferred_wallet THEN i->>'destinationWallet' ELSE res.merchant_wallet END)
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
  -- The original executor recorded the canonical A2U DTO in this immutable
  -- checkpoint. Bind it before publishing evidence; no certificate/send follows
  -- without the independent Pi/Horizon verifier checking this exact destination.
  IF deferred_wallet THEN
   UPDATE public.r36_payment_intake SET merchant_wallet=cp.a2u_to_address,merchant_pi_payment_id=cp.a2u_payment_id
    WHERE payment_id=res.payment_id AND wallet_contract='PI_PAYMENT_DTO_V1' AND merchant_wallet IS NULL;
   IF NOT FOUND THEN RAISE EXCEPTION 'MERCHANT_BINDING_CHANGED'; END IF;
   UPDATE public.r36_testnet_ingress_reservations SET merchant_wallet=cp.a2u_to_address
    WHERE payment_id=res.payment_id AND merchant_wallet IS NULL;
   IF NOT FOUND THEN RAISE EXCEPTION 'MERCHANT_RESERVATION_CHANGED'; END IF;
  END IF;
  INSERT INTO public.r36_prepared_evidence_candidates(payment_id,network,source_wallet,prepared_sequence,candidate)
  VALUES(res.payment_id,public.r36_network(),res.source_wallet,p_input->>'preparedSequence',body);
 END IF;
 RETURN jsonb_build_object('state','present','candidate',body);
END $_$;


ALTER FUNCTION public.r36_prepared_evidence_candidate(p_action text, p_input jsonb) OWNER TO r36_owner;

--
-- Name: r36_record_bound_lifecycle(text, text, text, text, bigint, bigint); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_record_bound_lifecycle(p_nonce text, p_closure text, p_text text, p_digest text, p_issued bigint, p_expires bigint) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
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
 WHERE network=public.r36_network() AND source_wallet=b->>'source_wallet' FOR UPDATE;
 next_clearance=c->>'successorClearanceDigest';
 IF NOT FOUND OR gate.state<>'enabled' OR gate.clearance_digest IS NULL
 OR next_clearance IS NULL OR next_clearance !~ '^[0-9a-f]{64}$'
 THEN RAISE EXCEPTION 'EXISTING_ENABLED_WALLET_REQUIRED'; END IF;
 -- The gate lock may have waited. Never use pre-wait validity as fresh authority.
 IF p_expires<=extract(epoch FROM clock_timestamp()) THEN RAISE EXCEPTION 'BOUND_CLEARANCE_EXPIRED_AFTER_LOCK'; END IF;
 -- No replacement of a prior approval, even expired or consumed. A conflict stays held.
 INSERT INTO public.financial_wallet_rotation_approvals(network,source_wallet,prior_prepared_hash,evidence_digest,approval_id,approved_by)
 VALUES(public.r36_network(),b->>'source_wallet',b->>'prepared_tx_hash',c->'seal'->>'evidence_digest',p_digest,session_user);
 INSERT INTO public.r36_rotation_approval_evidence(network,source_wallet,prior_prepared_hash,comparison_digest,seal_evidence_digest,
 horizon_result_verified,historical_wallet_reconciled,accounting_finality_verified,certified_by)
 VALUES(public.r36_network(),b->>'source_wallet',b->>'prepared_tx_hash',p_closure,c->'seal'->>'evidence_digest',true,true,true,session_user);
 INSERT INTO public.r36_signed_approval_consumptions(approval_id,network,wallet,prior_hash,prior_sequence,prior_payment,prior_operation,
 kind,evidence_digest,inventory_digest,binding_digest,payload_digest,expires_at,independently_certified_at)
 VALUES(p_digest,public.r36_network(),b->>'source_wallet',b->>'prepared_tx_hash',(b->>'prepared_sequence')::numeric,b->>'owner_payment_id',
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
END $_$;


ALTER FUNCTION public.r36_record_bound_lifecycle(p_nonce text, p_closure text, p_text text, p_digest text, p_issued bigint, p_expires bigint) OWNER TO r36_owner;

--
-- Name: r36_record_certificate(text, text, jsonb, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_record_certificate(p_nonce text, p_digest text, p_manifest jsonb, p_signature text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
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
END $_$;


ALTER FUNCTION public.r36_record_certificate(p_nonce text, p_digest text, p_manifest jsonb, p_signature text) OWNER TO r36_owner;

--
-- Name: r36_record_prior_closure(text, text, text, text, text, bigint, bigint); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_record_prior_closure(p_policy text, p_wallet text, p_prior text, p_text text, p_digest text, p_issued bigint, p_expires bigint) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
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
 VALUES(p_digest,p_policy,public.r36_network(),p_wallet,p_prior,c->'prior'->>'prepared_tx_hash',c->>'contextDigest',c->'seal'->>'evidence_digest',
 v->>'inventoryDigest',p_text,p_issued,p_expires,session_user);
 RETURN 'RECORDED';
END $_$;


ALTER FUNCTION public.r36_record_prior_closure(p_policy text, p_wallet text, p_prior text, p_text text, p_digest text, p_issued bigint, p_expires bigint) OWNER TO r36_owner;

--
-- Name: r36_record_renewal_receipt(text, text, jsonb, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_record_renewal_receipt(p_nonce text, p_digest text, m jsonb, p_signature text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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


ALTER FUNCTION public.r36_record_renewal_receipt(p_nonce text, p_digest text, m jsonb, p_signature text) OWNER TO r36_owner;

--
-- Name: r36_register_successor_binding(text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_register_successor_binding(p_nonce text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
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
 IF b->>'nonce' IS DISTINCT FROM p_nonce OR b->>'network' IS DISTINCT FROM public.r36_network()
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
END $_$;


ALTER FUNCTION public.r36_register_successor_binding(p_nonce text) OWNER TO r36_owner;

--
-- Name: r36_renewal_issuer_state(text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_renewal_issuer_state(p_nonce text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE req public.r36_admission_renewal_requests;
BEGIN
 IF session_user<>'r36_issuer' THEN RETURN '{}'::jsonb; END IF;
 SELECT * INTO req FROM public.r36_admission_renewal_requests WHERE nonce=p_nonce ORDER BY generation DESC LIMIT 1;
 IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;
 RETURN jsonb_build_object('renewalRequiresSuccessor',public.r36_unspent_successor(p_nonce),'binding',req.binding,'requestCreatedAt',req.issued_at,'renewalGeneration',req.generation,'evidenceNotBefore',req.evidence_not_before,
 'receipt',(SELECT jsonb_build_object('manifest',c.manifest,'signature',c.signature_base64) FROM public.r36_admission_renewal_receipts c WHERE c.nonce=p_nonce AND c.generation=req.generation));
END $$;


ALTER FUNCTION public.r36_renewal_issuer_state(p_nonce text) OWNER TO r36_owner;

--
-- Name: r36_renewal_registration_state(text, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_renewal_registration_state(p_policy text, p_nonce text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
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


ALTER FUNCTION public.r36_renewal_registration_state(p_policy text, p_nonce text) OWNER TO r36_owner;

--
-- Name: r36_renewal_unspent(text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_renewal_unspent(p_nonce text) RETURNS boolean
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


ALTER FUNCTION public.r36_renewal_unspent(p_nonce text) OWNER TO r36_owner;

--
-- Name: r36_reserve_new_recovery(text, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_reserve_new_recovery(p_subject text, p_policy text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
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
 JOIN public.financial_wallet_authorities a ON a.owner_payment_id=i.payment_id AND a.network=public.r36_network() AND a.state='prepared'
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
     AND i.created_at>(SELECT recovery_cutover FROM public.kernel_deployment_identity WHERE singleton=true) AND i.created_at<=statement_timestamp()
     AND encode(sha256(convert_to(i.payment_id,'UTF8')),'hex') NOT IN
     (SELECT unnest(historical_holds) FROM public.kernel_deployment_identity WHERE singleton=true)
     AND i.customer_amount>0 AND i.customer_amount*10000000<=public.r36_policy_max_amount(p.worker_profile) AND i.customer_amount*10000000=trunc(i.customer_amount*10000000)
     AND s.merchant_id=i.merchant_id AND s.merchant_uid=i.merchant_uid AND s.customer_amount=i.customer_amount
     AND public.r36_contract_valid(to_jsonb(s)) AND s.u2a_completed_at IS NOT NULL
     AND s.u2a_identifier=q.binding->>'piPaymentId' AND s.u2a_txid=q.binding->>'u2aTxid'
     AND public.r36_contract_outgoing_stroops(i.payment_id,a.operation_kind)=q.binding->>'amountStroops'
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
 IF public.r36_certificate_allows(public.r36_network(),v.wallet,v.id,v.kind,v.op,v.hash,v.seq) IS DISTINCT FROM true THEN CONTINUE; END IF;
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
   'spent',EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts t WHERE t.network=public.r36_network() AND t.owner_payment_id=v.id
     AND t.source_wallet=v.wallet AND t.operation_kind=v.kind AND t.owner_operation_id=v.op AND t.prepared_tx_hash=v.hash AND t.prepared_sequence=v.seq));
 END LOOP;
 RETURN NULL;
END $_$;


ALTER FUNCTION public.r36_reserve_new_recovery(p_subject text, p_policy text) OWNER TO r36_owner;

--
-- Name: r36_revoke_certificate(text, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_revoke_certificate(p_digest text, p_reason text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
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
END $_$;


ALTER FUNCTION public.r36_revoke_certificate(p_digest text, p_reason text) OWNER TO r36_owner;

--
-- Name: r36_revoke_prior_closure(text, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_revoke_prior_closure(p_digest text, p_reason text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
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
END $_$;


ALTER FUNCTION public.r36_revoke_prior_closure(p_digest text, p_reason text) OWNER TO r36_owner;

--
-- Name: r36_select_confirmed_refund_reconciliation(text, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_select_confirmed_refund_reconciliation(p_subject text, p_policy text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
DECLARE v record;
BEGIN
 IF session_user<>'r36_runtime' OR current_setting('transaction_isolation')<>'read committed'
 OR p_policy IS NULL OR p_policy!~'^[0-9a-f]{64}$'
 OR (p_subject IS NOT NULL AND p_subject!~'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN RETURN NULL; END IF;
 SELECT i.payment_id AS id,a.source_wallet AS wallet,a.operation_kind AS kind,a.owner_operation_id AS op,
        a.prepared_tx_hash AS hash,a.prepared_sequence AS seq,q.nonce,c.payload_digest AS digest,
        (i.customer_amount*10000000)::bigint AS amount,
        CASE WHEN a.operation_kind='settlement' THEN s.stage WHEN r.status='completed' THEN 'completed_projection' ELSE r.stage END AS stage
 INTO v
 FROM public.payment_create_intents i
 JOIN public.r36_testnet_ingress_reservations ingress ON ingress.payment_id=i.payment_id AND ingress.policy_digest=p_policy
 LEFT JOIN public.r36_recovery_trial_reservations prior ON prior.payment_id=i.payment_id
 JOIN public.settlement_checkpoints s ON s.payment_id=i.payment_id
 JOIN public.financial_wallet_authorities a ON a.owner_payment_id=i.payment_id AND a.network=public.r36_network() AND a.state='prepared'
 JOIN public.r36_certificate_requests q ON q.policy_digest=p_policy AND q.binding->>'paymentId'=i.payment_id
     AND q.binding->>'network'=a.network AND q.binding->>'sourceWallet'=a.source_wallet
     AND q.binding->>'operationKind'=a.operation_kind AND q.binding->>'operationId'=a.owner_operation_id
     AND q.binding->>'preparedHash'=a.prepared_tx_hash AND q.binding->>'preparedSequence'=a.prepared_sequence
 JOIN public.r36_certificate_receipts c ON c.nonce=q.nonce
 JOIN public.r36_certificate_policies p ON p.policy_digest=q.policy_digest
 JOIN public.financial_wallet_submission_attempts attempt ON attempt.network=a.network
  AND attempt.source_wallet=a.source_wallet AND attempt.owner_payment_id=a.owner_payment_id
  AND attempt.operation_kind=a.operation_kind AND attempt.owner_operation_id=a.owner_operation_id
  AND attempt.prepared_tx_hash=a.prepared_tx_hash AND attempt.prepared_sequence=a.prepared_sequence
 LEFT JOIN public.refund_checkpoints r ON r.payment_id=i.payment_id
 LEFT JOIN public.refund_audit_events e ON a.operation_kind='refund' AND e.payment_id=i.payment_id AND e.refund_id=r.refund_id
     AND e.event_id='refund:'||r.refund_id||':blockchain_submit_prepared' AND e.idempotency_key=r.idempotency_key
     AND e.actor_type='system' AND e.event_type='refund_blockchain_submit_prepared'
 WHERE ingress.amount_stroops=i.customer_amount*10000000 AND ingress.merchant_uid=i.merchant_uid
   AND ingress.merchant_id=i.merchant_id AND ingress.payer_uid=s.payer_uid AND ingress.source_wallet=a.source_wallet
   AND q.binding->>'destinationWallet'=CASE WHEN a.operation_kind='settlement' THEN ingress.merchant_wallet ELSE ingress.payer_wallet END
   AND (p_subject IS NULL OR i.payment_id=p_subject) AND i.payment_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     AND i.created_at>(SELECT recovery_cutover FROM public.kernel_deployment_identity WHERE singleton=true) AND i.created_at<=statement_timestamp()
     AND encode(sha256(convert_to(i.payment_id,'UTF8')),'hex') NOT IN
     (SELECT unnest(historical_holds) FROM public.kernel_deployment_identity WHERE singleton=true)
     AND i.customer_amount>0 AND i.customer_amount*10000000<=public.r36_policy_max_amount(p.worker_profile) AND i.customer_amount*10000000=trunc(i.customer_amount*10000000)
     AND s.merchant_id=i.merchant_id AND s.merchant_uid=i.merchant_uid AND s.customer_amount=i.customer_amount
     AND public.r36_contract_valid(to_jsonb(s)) AND s.u2a_completed_at IS NOT NULL
     AND s.u2a_identifier=q.binding->>'piPaymentId' AND s.u2a_txid=q.binding->>'u2aTxid'
     AND public.r36_contract_outgoing_stroops(i.payment_id,a.operation_kind)=q.binding->>'amountStroops'
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
     AND extract(epoch FROM clock_timestamp()) < least(p.valid_until,p.revocation_valid_until)
     AND NOT EXISTS(SELECT 1 FROM public.r36_certificate_revocations x WHERE x.payload_digest=c.payload_digest)

 -- A consumed INITIAL_PREPARED_ADMISSION certificate remains identity evidence,
 -- not permission to submit again. Only an already-confirmed refund is eligible.
 AND a.operation_kind='refund' AND s.stage='payment_identity'
 AND s.a2u_payment_id IS NULL AND s.a2u_txid IS NULL AND s.prepared_tx_hash IS NULL
 AND r.refund_txid=a.prepared_tx_hash AND r.payer_uid_verified_at IS NOT NULL AND r.currency='π'
 AND r.stage IN ('wallet_submission_confirmed','payment_checkpoint_updated','accounting_recorded','audit_recorded')
 AND NOT EXISTS(SELECT 1 FROM public.transactions x WHERE x.payment_id=s.u2a_identifier)
 AND NOT EXISTS(SELECT 1 FROM public.receipts x WHERE x.u2a_identifier=s.u2a_identifier)
 AND prior.payment_id=i.payment_id AND prior.nonce=q.nonce AND prior.payload_digest=c.payload_digest
 AND prior.amount_stroops=ingress.amount_stroops AND ingress.retired_by_payment_id IS NULL
 AND extract(epoch FROM attempt.attempted_at)>=c.issued_at
 AND extract(epoch FROM attempt.attempted_at)<c.expires_at
 AND c.verified_at<=attempt.attempted_at AND prior.reserved_at<=attempt.attempted_at
 AND p.revocation_checked_at>=c.issued_at AND p.revocation_checked_at<=extract(epoch FROM clock_timestamp())
 AND c.verified_by='r36_issuer'
 AND c.manifest=q.binding||jsonb_build_object('schema','R36_ADMISSION_CERTIFICATE_V1','purpose','INITIAL_PREPARED_ADMISSION',
  'issuerId',p.issuer_id,'keyId',p.key_id,'policyDigest',p.policy_digest,'issuedAt',c.issued_at::text,'expiresAt',c.expires_at::text)
 AND EXISTS(SELECT 1 FROM public.financial_wallet_activation g WHERE g.network=a.network
  AND g.source_wallet=a.source_wallet AND g.state='enabled' AND g.clearance_digest=q.binding->>'clearanceDigest')
 AND EXISTS(SELECT 1 FROM public.r36_independent_u2a_attestations t WHERE t.network=a.network
  AND t.source_wallet=a.source_wallet AND t.payment_id=i.payment_id AND t.operation_kind=a.operation_kind
  AND t.operation_id=a.owner_operation_id AND t.prepared_tx_hash=a.prepared_tx_hash
  AND t.prepared_sequence=a.prepared_sequence AND t.pi_payment_id=q.binding->>'piPaymentId'
  AND t.u2a_txid=q.binding->>'u2aTxid' AND t.proof_digest=c.payload_digest AND t.status='verified')
 ORDER BY prior.last_selected_at,i.created_at,i.payment_id LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('id',v.id,'kind',v.kind,'op',v.op,'wallet',v.wallet,'hash',v.hash,'seq',v.seq,'stage',v.stage,'spent',true);
END $_$;


ALTER FUNCTION public.r36_select_confirmed_refund_reconciliation(p_subject text, p_policy text) OWNER TO r36_owner;

--
-- Name: r36_select_confirmed_settlement_reconciliation(text, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_select_confirmed_settlement_reconciliation(p_subject text, p_policy text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
DECLARE v record;
BEGIN
 IF session_user<>'r36_runtime' OR current_setting('transaction_isolation')<>'read committed'
 OR p_policy IS NULL OR p_policy!~'^[0-9a-f]{64}$'
 OR (p_subject IS NOT NULL AND p_subject!~'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN RETURN NULL; END IF;
 SELECT i.payment_id AS id,a.source_wallet AS wallet,a.operation_kind AS kind,a.owner_operation_id AS op,
        a.prepared_tx_hash AS hash,a.prepared_sequence AS seq,q.nonce,c.payload_digest AS digest,
        (i.customer_amount*10000000)::bigint AS amount,
        CASE WHEN a.operation_kind='settlement' THEN s.stage WHEN r.status='completed' THEN 'completed_projection' ELSE r.stage END AS stage
 INTO v
 FROM public.payment_create_intents i
 JOIN public.r36_testnet_ingress_reservations ingress ON ingress.payment_id=i.payment_id AND ingress.policy_digest=p_policy
 LEFT JOIN public.r36_recovery_trial_reservations prior ON prior.payment_id=i.payment_id
 JOIN public.settlement_checkpoints s ON s.payment_id=i.payment_id
 JOIN public.financial_wallet_authorities a ON a.owner_payment_id=i.payment_id AND a.network=public.r36_network() AND a.state='prepared'
 JOIN public.r36_certificate_requests q ON q.policy_digest=p_policy AND q.binding->>'paymentId'=i.payment_id
     AND q.binding->>'network'=a.network AND q.binding->>'sourceWallet'=a.source_wallet
     AND q.binding->>'operationKind'=a.operation_kind AND q.binding->>'operationId'=a.owner_operation_id
     AND q.binding->>'preparedHash'=a.prepared_tx_hash AND q.binding->>'preparedSequence'=a.prepared_sequence
 JOIN public.r36_certificate_receipts c ON c.nonce=q.nonce
 JOIN public.r36_certificate_policies p ON p.policy_digest=q.policy_digest
 JOIN public.financial_wallet_submission_attempts attempt ON attempt.network=a.network
  AND attempt.source_wallet=a.source_wallet AND attempt.owner_payment_id=a.owner_payment_id
  AND attempt.operation_kind=a.operation_kind AND attempt.owner_operation_id=a.owner_operation_id
  AND attempt.prepared_tx_hash=a.prepared_tx_hash AND attempt.prepared_sequence=a.prepared_sequence
 LEFT JOIN public.refund_checkpoints r ON r.payment_id=i.payment_id
 LEFT JOIN public.refund_audit_events e ON a.operation_kind='refund' AND e.payment_id=i.payment_id AND e.refund_id=r.refund_id
     AND e.event_id='refund:'||r.refund_id||':blockchain_submit_prepared' AND e.idempotency_key=r.idempotency_key
     AND e.actor_type='system' AND e.event_type='refund_blockchain_submit_prepared'
 WHERE ingress.amount_stroops=i.customer_amount*10000000 AND ingress.merchant_uid=i.merchant_uid
   AND ingress.merchant_id=i.merchant_id AND ingress.payer_uid=s.payer_uid AND ingress.source_wallet=a.source_wallet
   AND q.binding->>'destinationWallet'=CASE WHEN a.operation_kind='settlement' THEN ingress.merchant_wallet ELSE ingress.payer_wallet END
   AND (p_subject IS NULL OR i.payment_id=p_subject) AND i.payment_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     AND i.created_at>(SELECT recovery_cutover FROM public.kernel_deployment_identity WHERE singleton=true) AND i.created_at<=statement_timestamp()
     AND encode(sha256(convert_to(i.payment_id,'UTF8')),'hex') NOT IN
     (SELECT unnest(historical_holds) FROM public.kernel_deployment_identity WHERE singleton=true)
     AND i.customer_amount>0 AND i.customer_amount*10000000<=public.r36_policy_max_amount(p.worker_profile) AND i.customer_amount*10000000=trunc(i.customer_amount*10000000)
     AND s.merchant_id=i.merchant_id AND s.merchant_uid=i.merchant_uid AND s.customer_amount=i.customer_amount
     AND public.r36_contract_valid(to_jsonb(s)) AND s.u2a_completed_at IS NOT NULL
     AND s.u2a_identifier=q.binding->>'piPaymentId' AND s.u2a_txid=q.binding->>'u2aTxid'
     AND public.r36_contract_outgoing_stroops(i.payment_id,a.operation_kind)=q.binding->>'amountStroops'
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
     AND extract(epoch FROM clock_timestamp()) < least(p.valid_until,p.revocation_valid_until)
     AND NOT EXISTS(SELECT 1 FROM public.r36_certificate_revocations x WHERE x.payload_digest=c.payload_digest)

 -- A consumed INITIAL_PREPARED_ADMISSION certificate remains identity evidence,
 -- not permission to submit again. Only already-confirmed settlement is eligible.
 AND a.operation_kind='settlement' AND s.stage IN ('horizon_confirmed','pi_completed')
 AND s.a2u_txid=a.prepared_tx_hash AND s.horizon_confirmed_at IS NOT NULL
 AND s.horizon_fee_stroops IS NOT NULL AND r.payment_id IS NULL
 AND prior.payment_id=i.payment_id AND prior.nonce=q.nonce AND prior.payload_digest=c.payload_digest
 AND prior.amount_stroops=ingress.amount_stroops AND ingress.retired_by_payment_id IS NULL
 AND extract(epoch FROM attempt.attempted_at)>=c.issued_at
 AND extract(epoch FROM attempt.attempted_at)<c.expires_at
 AND c.verified_at<=attempt.attempted_at AND prior.reserved_at<=attempt.attempted_at
 AND p.revocation_checked_at>=c.issued_at AND p.revocation_checked_at<=extract(epoch FROM clock_timestamp())
 AND c.verified_by='r36_issuer'
 AND c.manifest=q.binding||jsonb_build_object('schema','R36_ADMISSION_CERTIFICATE_V1','purpose','INITIAL_PREPARED_ADMISSION',
  'issuerId',p.issuer_id,'keyId',p.key_id,'policyDigest',p.policy_digest,'issuedAt',c.issued_at::text,'expiresAt',c.expires_at::text)
 AND EXISTS(SELECT 1 FROM public.financial_wallet_activation g WHERE g.network=a.network
  AND g.source_wallet=a.source_wallet AND g.state='enabled' AND g.clearance_digest=q.binding->>'clearanceDigest')
 AND EXISTS(SELECT 1 FROM public.r36_independent_u2a_attestations t WHERE t.network=a.network
  AND t.source_wallet=a.source_wallet AND t.payment_id=i.payment_id AND t.operation_kind=a.operation_kind
  AND t.operation_id=a.owner_operation_id AND t.prepared_tx_hash=a.prepared_tx_hash
  AND t.prepared_sequence=a.prepared_sequence AND t.pi_payment_id=q.binding->>'piPaymentId'
  AND t.u2a_txid=q.binding->>'u2aTxid' AND t.proof_digest=c.payload_digest AND t.status='verified')
 ORDER BY prior.last_selected_at,i.created_at,i.payment_id LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('id',v.id,'kind',v.kind,'op',v.op,'wallet',v.wallet,'hash',v.hash,'seq',v.seq,'stage',v.stage,'spent',true);
END $_$;


ALTER FUNCTION public.r36_select_confirmed_settlement_reconciliation(p_subject text, p_policy text) OWNER TO r36_owner;

--
-- Name: r36_store_renewal_request(text, jsonb, text, bigint, bigint, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_store_renewal_request(p_policy text, b jsonb, p_digest text, p_issued bigint, p_expires bigint, p_review text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
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
END $_$;


ALTER FUNCTION public.r36_store_renewal_request(p_policy text, b jsonb, p_digest text, p_issued bigint, p_expires bigint, p_review text) OWNER TO r36_owner;

--
-- Name: r36_terminal_ingress_clearance(text, text, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_terminal_ingress_clearance(p_policy text, p_wallet text, p_prior text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE old public.financial_wallet_authorities; seal public.financial_wallet_finality_seals;
 proof record; policy public.r36_certificate_policies; p_network text := public.r36_network();
BEGIN
 IF session_user<>'r36_runtime' OR current_setting('transaction_isolation')<>'read committed' THEN RETURN false; END IF;
 SELECT * INTO policy FROM public.r36_certificate_policies WHERE policy_digest=p_policy FOR SHARE;
 IF NOT FOUND OR NOT policy.enabled OR policy.revoked
 OR (NOT public.r36_general_policy(policy.worker_profile) AND policy.worker_profile->'recoveryPilot'->'ingress'->'allowTerminalReservationTurnover' IS DISTINCT FROM 'true'::jsonb)
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
    AND public.r36_contract_valid(to_jsonb(s))
    AND t.merchant_id=s.merchant_id AND t.merchant_uid=s.merchant_uid AND t.status='completed' AND t.currency='π'
    AND t.amount=s.merchant_amount AND r.merchant_id=s.merchant_id AND r.merchant_uid=s.merchant_uid
    AND r.currency='π' AND r.amount=s.merchant_amount AND r.customer_amount=s.customer_amount
    AND r.merchant_amount=s.merchant_amount AND r.app_commission=s.app_commission AND r.txid=s.a2u_txid
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


ALTER FUNCTION public.r36_terminal_ingress_clearance(p_policy text, p_wallet text, p_prior text) OWNER TO r36_owner;

--
-- Name: r36_terminal_review_context(text, text, text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_terminal_review_context(p_policy text, p_wallet text, p_prior text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE old public.financial_wallet_authorities; seal public.financial_wallet_finality_seals;
 terminal jsonb; policy public.r36_certificate_policies; p_network text := public.r36_network();
BEGIN
 IF session_user NOT IN ('r36_runtime','r36_issuer') OR current_setting('transaction_isolation')<>'read committed' THEN RETURN NULL; END IF;
 SELECT * INTO policy FROM public.r36_certificate_policies WHERE policy_digest=p_policy FOR SHARE;
 IF NOT FOUND OR NOT policy.enabled OR policy.revoked
 OR (NOT public.r36_general_policy(policy.worker_profile) AND policy.worker_profile->'recoveryPilot'->'ingress'->'allowTerminalReservationTurnover' IS DISTINCT FROM 'true'::jsonb)
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
    AND public.r36_contract_valid(to_jsonb(s))
    AND t.merchant_id=s.merchant_id AND t.merchant_uid=s.merchant_uid AND t.status='completed' AND t.currency='π'
    AND t.amount=s.merchant_amount AND r.merchant_id=s.merchant_id AND r.merchant_uid=s.merchant_uid
    AND r.currency='π' AND r.amount=s.merchant_amount AND r.customer_amount=s.customer_amount
    AND r.merchant_amount=s.merchant_amount AND r.app_commission=s.app_commission AND r.txid=s.a2u_txid
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
 SELECT jsonb_build_object('piPaymentId',s.a2u_payment_id,'recipientUid',s.merchant_uid,'amountStroops',trunc(s.merchant_amount*10000000)::text,
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


ALTER FUNCTION public.r36_terminal_review_context(p_policy text, p_wallet text, p_prior text) OWNER TO r36_owner;

--
-- Name: r36_unspent_successor(text); Type: FUNCTION; Schema: public; Owner: r36_owner
--

CREATE FUNCTION public.r36_unspent_successor(p_nonce text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE b jsonb; original text; a public.financial_wallet_authorities; s public.settlement_checkpoints; l public.r36_lifecycle_approval_links; candidate jsonb;
BEGIN
 IF session_user NOT IN ('r36_registrar','r36_issuer') THEN RETURN false; END IF;
 SELECT q.binding,c.payload_digest INTO b,original FROM public.r36_certificate_requests q JOIN public.r36_certificate_receipts c USING(nonce) WHERE q.nonce=p_nonce FOR UPDATE OF q;
 IF NOT FOUND OR b->>'network'<>public.r36_network() OR b->>'operationKind'<>'settlement'
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
 OR s.u2a_verified_at IS NULL OR s.u2a_completed_at IS NULL OR public.r36_contract_outgoing_stroops(s.payment_id,b->>'operationKind') IS DISTINCT FROM b->>'amountStroops'
 OR NOT public.r36_contract_valid(to_jsonb(s)) OR s.a2u_payment_id IS DISTINCT FROM b->>'operationId'
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


ALTER FUNCTION public.r36_unspent_successor(p_nonce text) OWNER TO r36_owner;

--
-- Name: context(text, text); Type: FUNCTION; Schema: r36_registration; Owner: r36_registrar_owner
--

CREATE FUNCTION r36_registration.context(p_policy text, p_nonce text) RETURNS jsonb
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
 RETURN jsonb_build_object('nowSeconds',n,'requestExists',r.nonce IS NOT NULL,'requestCreatedAt',coalesce(floor(extract(epoch from r.created_at))::bigint,n),
 'policy',jsonb_build_object('policyDigest',p.policy_digest,'issuerId',p.issuer_id,'keyId',p.key_id,
 'publicKeyPem',p.public_key_pem,'publicKeySpkiSha256',p.public_key_spki_sha256,'enabled',p.enabled,'revoked',p.revoked,
 'validFrom',p.valid_from,'validUntil',p.valid_until,'maxAgeSeconds',p.max_age_seconds,
 'revocationCheckedAt',p.revocation_checked_at,'revocationValidUntil',p.revocation_valid_until,
 'approvalRecordDigest',p.approval_record_digest,'workerProfile',p.worker_profile)) || public.r36_renewal_registration_state(p_policy,p_nonce);
END $_$;


ALTER FUNCTION r36_registration.context(p_policy text, p_nonce text) OWNER TO r36_registrar_owner;

--
-- Name: enroll(text, jsonb, text, text, bigint, bigint, text); Type: FUNCTION; Schema: r36_registration; Owner: r36_registrar_owner
--

CREATE FUNCTION r36_registration.enroll(p_policy text, b jsonb, p_bytes text, p_digest text, p_issued bigint, p_expires bigint, p_review text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $_$
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
END $_$;


ALTER FUNCTION r36_registration.enroll(p_policy text, b jsonb, p_bytes text, p_digest text, p_issued bigint, p_expires bigint, p_review text) OWNER TO r36_registrar_owner;

--
-- Name: context(text); Type: FUNCTION; Schema: r36_signing; Owner: r36_signer_owner
--

CREATE FUNCTION r36_signing.context(k text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE r r36_signing.requests; n bigint; BEGIN
 IF session_user<>'r36_signer' THEN RETURN NULL; END IF;
 SELECT * INTO r FROM r36_signing.requests WHERE idempotency_key=k FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 n=floor(extract(epoch FROM clock_timestamp()));
 IF r.revoked OR n<r.valid_from OR n>=r.valid_until THEN RETURN NULL; END IF;
 RETURN to_jsonb(r)||jsonb_build_object('signature',(SELECT signature_base64 FROM r36_signing.receipts WHERE idempotency_key=k));
END $$;


ALTER FUNCTION r36_signing.context(k text) OWNER TO r36_signer_owner;

--
-- Name: immutable_request(); Type: FUNCTION; Schema: r36_signing; Owner: r36_signer_owner
--

CREATE FUNCTION r36_signing.immutable_request() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN
 IF OLD.revoked AND NOT NEW.revoked THEN RAISE EXCEPTION 'SIGNING_REVOCATION_PERMANENT'; END IF;
 IF to_jsonb(OLD)-'revoked' IS DISTINCT FROM to_jsonb(NEW)-'revoked' THEN RAISE EXCEPTION 'SIGNING_APPROVAL_IMMUTABLE'; END IF; RETURN NEW;
END $$;


ALTER FUNCTION r36_signing.immutable_request() OWNER TO r36_signer_owner;

--
-- Name: record(text, text); Type: FUNCTION; Schema: r36_signing; Owner: r36_signer_owner
--

CREATE FUNCTION r36_signing.record(k text, s text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE c jsonb; old text; BEGIN
 c=r36_signing.context(k); IF c IS NULL THEN RAISE EXCEPTION 'SIGNING_NOT_APPROVED'; END IF;
 SELECT signature_base64 INTO old FROM r36_signing.receipts WHERE idempotency_key=k;
 IF FOUND THEN IF old=s THEN RETURN old; END IF; RAISE EXCEPTION 'SIGNING_REPLAY_CONFLICT'; END IF;
 INSERT INTO r36_signing.receipts(idempotency_key,signature_base64,signed_by) VALUES(k,s,session_user); RETURN s;
END $$;


ALTER FUNCTION r36_signing.record(k text, s text) OWNER TO r36_signer_owner;

--
-- Name: certification_fault_arms; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.certification_fault_arms (
    payment_id text NOT NULL,
    lane text NOT NULL,
    boundary text NOT NULL,
    armed_at timestamp without time zone DEFAULT now() NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    consumed_at timestamp without time zone,
    CONSTRAINT certification_fault_arms_check CHECK ((expires_at > armed_at)),
    CONSTRAINT certification_fault_arms_lane_check CHECK ((lane = ANY (ARRAY['settlement'::text, 'refund'::text])))
);


ALTER TABLE public.certification_fault_arms OWNER TO neondb_owner;

--
-- Name: dr17_cert_execution; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.dr17_cert_execution (
    execution_key text NOT NULL,
    release text NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    report jsonb,
    error_code text,
    CONSTRAINT dr17_cert_execution_status_check CHECK ((status = ANY (ARRAY['running'::text, 'passed'::text, 'failed'::text])))
);


ALTER TABLE public.dr17_cert_execution OWNER TO neondb_owner;

--
-- Name: dr17_cert_items; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.dr17_cert_items (
    run_id text NOT NULL,
    payment_id text NOT NULL,
    lane text NOT NULL,
    authority text NOT NULL,
    stage integer DEFAULT 0 NOT NULL,
    movement_count integer DEFAULT 0 NOT NULL,
    recovered boolean DEFAULT false NOT NULL,
    CONSTRAINT dr17_cert_items_authority_check CHECK ((authority = ANY (ARRAY['settlement'::text, 'refund'::text]))),
    CONSTRAINT dr17_cert_items_lane_check CHECK ((lane = ANY (ARRAY['settlement'::text, 'refund'::text])))
);


ALTER TABLE public.dr17_cert_items OWNER TO neondb_owner;

--
-- Name: dr17_cert_runs; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.dr17_cert_runs (
    run_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expected integer NOT NULL,
    finished_at timestamp with time zone,
    verdict text,
    report jsonb,
    phase text,
    forensic jsonb,
    capacity_observation jsonb
);


ALTER TABLE public.dr17_cert_runs OWNER TO neondb_owner;

--
-- Name: financial_pi_mutation_attempts; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.financial_pi_mutation_attempts (
    mutation_kind text NOT NULL,
    payment_id text NOT NULL,
    external_payment_id text NOT NULL,
    txid text,
    refund_id text,
    attempted_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT financial_pi_mutation_attempts_mutation_kind_check CHECK ((mutation_kind = ANY (ARRAY['u2a_cancel'::text, 'u2a_complete'::text, 'a2u_complete'::text, 'dr11_a2u_cancel'::text, 'refund_complete'::text])))
);


ALTER TABLE public.financial_pi_mutation_attempts OWNER TO neondb_owner;

--
-- Name: financial_wallet_activation; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.financial_wallet_activation (
    network text NOT NULL,
    source_wallet text NOT NULL,
    state text DEFAULT 'blocked'::text NOT NULL,
    clearance_digest text,
    cleared_by text,
    cleared_at timestamp with time zone,
    CONSTRAINT financial_wallet_activation_check CHECK (((state <> 'enabled'::text) OR ((clearance_digest IS NOT NULL) AND (cleared_by IS NOT NULL) AND (cleared_at IS NOT NULL)))),
    CONSTRAINT financial_wallet_activation_clearance_digest_check CHECK ((clearance_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT financial_wallet_activation_network_check CHECK ((network = public.r36_network()::text)),
    CONSTRAINT financial_wallet_activation_source_wallet_check CHECK ((source_wallet ~ '^G[A-Z2-7]{55}$'::text)),
    CONSTRAINT financial_wallet_activation_state_check CHECK ((state = ANY (ARRAY['blocked'::text, 'enabled'::text])))
);


ALTER TABLE public.financial_wallet_activation OWNER TO r36_owner;

--
-- Name: financial_wallet_authorities; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.financial_wallet_authorities (
    network text NOT NULL,
    source_wallet text NOT NULL,
    owner_payment_id text NOT NULL,
    operation_kind text NOT NULL,
    owner_operation_id text NOT NULL,
    prepared_tx_hash text NOT NULL,
    prepared_sequence text NOT NULL,
    state text DEFAULT 'prepared'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT financial_wallet_authorities_network_check CHECK ((network = public.r36_network()::text)),
    CONSTRAINT financial_wallet_authorities_operation_kind_check CHECK ((operation_kind = ANY (ARRAY['settlement'::text, 'refund'::text]))),
    CONSTRAINT financial_wallet_authorities_prepared_sequence_check CHECK ((prepared_sequence ~ '^[1-9][0-9]*$'::text)),
    CONSTRAINT financial_wallet_authorities_prepared_tx_hash_check CHECK ((prepared_tx_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT financial_wallet_authorities_source_wallet_check CHECK ((source_wallet ~ '^G[A-Z2-7]{55}$'::text)),
    CONSTRAINT financial_wallet_authorities_state_check CHECK ((state = 'prepared'::text))
);


ALTER TABLE public.financial_wallet_authorities OWNER TO r36_owner;

--
-- Name: financial_wallet_authority_history; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.financial_wallet_authority_history (
    network text NOT NULL,
    source_wallet text NOT NULL,
    owner_payment_id text NOT NULL,
    operation_kind text NOT NULL,
    owner_operation_id text NOT NULL,
    prepared_tx_hash text NOT NULL,
    prepared_sequence text NOT NULL,
    finality_evidence_digest text NOT NULL,
    rotated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT financial_wallet_authority_histo_finality_evidence_digest_check CHECK ((finality_evidence_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT financial_wallet_authority_history_operation_kind_check CHECK ((operation_kind = ANY (ARRAY['settlement'::text, 'refund'::text]))),
    CONSTRAINT financial_wallet_authority_history_prepared_sequence_check CHECK ((prepared_sequence ~ '^[1-9][0-9]*$'::text)),
    CONSTRAINT financial_wallet_authority_history_prepared_tx_hash_check CHECK ((prepared_tx_hash ~ '^[0-9a-f]{64}$'::text))
);


ALTER TABLE public.financial_wallet_authority_history OWNER TO r36_owner;

--
-- Name: financial_wallet_finality_seals; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.financial_wallet_finality_seals (
    network text NOT NULL,
    source_wallet text NOT NULL,
    owner_payment_id text NOT NULL,
    operation_kind text NOT NULL,
    owner_operation_id text NOT NULL,
    prepared_tx_hash text NOT NULL,
    prepared_sequence text NOT NULL,
    horizon_ledger text NOT NULL,
    horizon_fee_stroops text NOT NULL,
    evidence_digest text NOT NULL,
    verified_by text NOT NULL,
    sealed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT financial_wallet_finality_seals_evidence_digest_check CHECK ((evidence_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT financial_wallet_finality_seals_horizon_fee_stroops_check CHECK ((horizon_fee_stroops ~ '^(0|[1-9][0-9]*)$'::text)),
    CONSTRAINT financial_wallet_finality_seals_horizon_ledger_check CHECK ((horizon_ledger ~ '^[1-9][0-9]*$'::text)),
    CONSTRAINT financial_wallet_finality_seals_network_check CHECK ((network = public.r36_network()::text)),
    CONSTRAINT financial_wallet_finality_seals_operation_kind_check CHECK ((operation_kind = ANY (ARRAY['settlement'::text, 'refund'::text]))),
    CONSTRAINT financial_wallet_finality_seals_prepared_sequence_check CHECK ((prepared_sequence ~ '^[1-9][0-9]*$'::text)),
    CONSTRAINT financial_wallet_finality_seals_prepared_tx_hash_check CHECK ((prepared_tx_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT financial_wallet_finality_seals_verified_by_check CHECK ((length(btrim(verified_by)) > 0))
);


ALTER TABLE public.financial_wallet_finality_seals OWNER TO r36_owner;

--
-- Name: financial_wallet_rotation_approvals; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.financial_wallet_rotation_approvals (
    network text NOT NULL,
    source_wallet text NOT NULL,
    prior_prepared_hash text NOT NULL,
    evidence_digest text NOT NULL,
    approval_id text NOT NULL,
    approved_by text NOT NULL,
    approved_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_at timestamp with time zone,
    CONSTRAINT financial_wallet_rotation_approvals_approved_by_check CHECK ((length(btrim(approved_by)) > 0)),
    CONSTRAINT financial_wallet_rotation_approvals_evidence_digest_check CHECK ((evidence_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT financial_wallet_rotation_approvals_prior_prepared_hash_check CHECK ((prior_prepared_hash ~ '^[0-9a-f]{64}$'::text))
);


ALTER TABLE public.financial_wallet_rotation_approvals OWNER TO r36_owner;

--
-- Name: financial_wallet_submission_attempts; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.financial_wallet_submission_attempts (
    network text NOT NULL,
    source_wallet text NOT NULL,
    owner_payment_id text NOT NULL,
    operation_kind text NOT NULL,
    owner_operation_id text NOT NULL,
    prepared_tx_hash text NOT NULL,
    prepared_sequence text NOT NULL,
    attempted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT financial_wallet_submission_attempts_network_check CHECK ((network = public.r36_network()::text)),
    CONSTRAINT financial_wallet_submission_attempts_operation_kind_check CHECK ((operation_kind = ANY (ARRAY['settlement'::text, 'refund'::text]))),
    CONSTRAINT financial_wallet_submission_attempts_prepared_sequence_check CHECK ((prepared_sequence ~ '^[1-9][0-9]*$'::text)),
    CONSTRAINT financial_wallet_submission_attempts_prepared_tx_hash_check CHECK ((prepared_tx_hash ~ '^[0-9a-f]{64}$'::text))
);


ALTER TABLE public.financial_wallet_submission_attempts OWNER TO r36_owner;

--
-- Name: merchant_balances; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.merchant_balances (
    merchant_id text NOT NULL,
    settled numeric(18,8) DEFAULT 0,
    unsettled numeric(18,8) DEFAULT 0,
    last_updated timestamp without time zone DEFAULT now()
);


ALTER TABLE public.merchant_balances OWNER TO neondb_owner;

--
-- Name: payment_create_intents; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.payment_create_intents (
    merchant_uid text NOT NULL,
    create_intent_id uuid NOT NULL,
    payment_id text NOT NULL,
    merchant_id text NOT NULL,
    customer_amount numeric NOT NULL,
    note text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT payment_create_intents_customer_amount_check CHECK ((customer_amount > (0)::numeric))
);


ALTER TABLE public.payment_create_intents OWNER TO neondb_owner;

--
-- Name: r36_admission_renewal_receipts; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_admission_renewal_receipts (
    nonce text NOT NULL,
    generation integer NOT NULL,
    payload_digest text NOT NULL,
    manifest jsonb NOT NULL,
    signature_base64 text NOT NULL,
    issued_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    verified_by text NOT NULL,
    verified_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT r36_admission_renewal_receipts_check CHECK ((expires_at > issued_at)),
    CONSTRAINT r36_admission_renewal_receipts_verified_by_check CHECK ((verified_by = 'r36_issuer'::text))
);


ALTER TABLE public.r36_admission_renewal_receipts OWNER TO r36_owner;

--
-- Name: r36_admission_renewal_requests; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_admission_renewal_requests (
    nonce text NOT NULL,
    generation integer NOT NULL,
    original_payload_digest text NOT NULL,
    binding jsonb NOT NULL,
    issued_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    evidence_not_before bigint NOT NULL,
    payload_digest text NOT NULL,
    review_digest text NOT NULL,
    recorded_by text NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT r36_admission_renewal_requests_check CHECK (((jsonb_typeof(binding) = 'object'::text) AND ((binding ->> 'nonce'::text) = nonce))),
    CONSTRAINT r36_admission_renewal_requests_check1 CHECK ((expires_at > issued_at)),
    CONSTRAINT r36_admission_renewal_requests_check2 CHECK ((issued_at >= evidence_not_before)),
    CONSTRAINT r36_admission_renewal_requests_generation_check CHECK ((generation > 0)),
    CONSTRAINT r36_admission_renewal_requests_payload_digest_check CHECK ((payload_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_admission_renewal_requests_recorded_by_check CHECK ((recorded_by = 'r36_registrar'::text)),
    CONSTRAINT r36_admission_renewal_requests_review_digest_check CHECK ((review_digest ~ '^[0-9a-f]{64}$'::text))
);


ALTER TABLE public.r36_admission_renewal_requests OWNER TO r36_owner;

--
-- Name: r36_admission_renewal_revocations; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_admission_renewal_revocations (
    payload_digest text NOT NULL,
    reason_digest text NOT NULL,
    revoked_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT r36_admission_renewal_revocations_reason_digest_check CHECK ((reason_digest ~ '^[0-9a-f]{64}$'::text))
);


ALTER TABLE public.r36_admission_renewal_revocations OWNER TO r36_owner;

--
-- Name: r36_bound_renewal_receipts; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_bound_renewal_receipts (
    payload_digest text NOT NULL,
    approval_id text NOT NULL,
    closure_digest text NOT NULL,
    successor_nonce text NOT NULL,
    evidence_text text NOT NULL,
    issued_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    verified_by text NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT r36_bound_renewal_receipts_check CHECK ((expires_at > issued_at)),
    CONSTRAINT r36_bound_renewal_receipts_payload_digest_check CHECK ((payload_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_bound_renewal_receipts_verified_by_check CHECK ((verified_by = 'r36_issuer'::text))
);


ALTER TABLE public.r36_bound_renewal_receipts OWNER TO r36_owner;

--
-- Name: r36_certificate_policies; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_certificate_policies (
    policy_digest text NOT NULL,
    issuer_id text NOT NULL,
    key_id text NOT NULL,
    public_key_pem text NOT NULL,
    public_key_spki_sha256 text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    revoked boolean DEFAULT false NOT NULL,
    valid_from bigint NOT NULL,
    valid_until bigint NOT NULL,
    max_age_seconds bigint NOT NULL,
    revocation_checked_at bigint NOT NULL,
    revocation_valid_until bigint NOT NULL,
    approval_record_digest text NOT NULL,
    worker_profile jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT r36_certificate_policies_approval_record_digest_check CHECK ((approval_record_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_certificate_policies_check CHECK (((valid_from >= 0) AND (valid_until > valid_from) AND (revocation_checked_at >= 0) AND (revocation_valid_until > revocation_checked_at) AND (revocation_valid_until <= valid_until))),
    CONSTRAINT r36_certificate_policies_max_age_seconds_check CHECK ((max_age_seconds > 0)),
    CONSTRAINT r36_certificate_policies_policy_digest_check CHECK ((policy_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_certificate_policies_public_key_spki_sha256_check CHECK ((public_key_spki_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_certificate_policies_worker_profile_check CHECK ((jsonb_typeof(worker_profile) = 'object'::text))
);


ALTER TABLE public.r36_certificate_policies OWNER TO r36_owner;

--
-- Name: r36_certificate_receipts; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_certificate_receipts (
    nonce text NOT NULL,
    payload_digest text NOT NULL,
    manifest jsonb NOT NULL,
    signature_base64 text NOT NULL,
    issued_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    verified_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    verified_by text NOT NULL,
    CONSTRAINT r36_certificate_receipts_check CHECK ((expires_at > issued_at)),
    CONSTRAINT r36_certificate_receipts_payload_digest_check CHECK ((payload_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_certificate_receipts_verified_by_check CHECK ((verified_by = 'r36_issuer'::text))
);


ALTER TABLE public.r36_certificate_receipts OWNER TO r36_owner;

--
-- Name: r36_certificate_requests; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_certificate_requests (
    nonce text NOT NULL,
    policy_digest text NOT NULL,
    binding jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT r36_certificate_requests_check CHECK (((jsonb_typeof(binding) = 'object'::text) AND ((binding ->> 'nonce'::text) = nonce) AND ((binding ->> 'network'::text) = public.r36_network()::text))),
    CONSTRAINT r36_certificate_requests_nonce_check CHECK ((nonce ~ '^[0-9a-f]{64}$'::text))
);


ALTER TABLE public.r36_certificate_requests OWNER TO r36_owner;

--
-- Name: r36_certificate_revocations; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_certificate_revocations (
    payload_digest text NOT NULL,
    revoked_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    reason_digest text NOT NULL,
    CONSTRAINT r36_certificate_revocations_reason_digest_check CHECK ((reason_digest ~ '^[0-9a-f]{64}$'::text))
);


ALTER TABLE public.r36_certificate_revocations OWNER TO r36_owner;

--
-- Name: r36_independent_u2a_attestations; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_independent_u2a_attestations (
    network text NOT NULL,
    source_wallet text NOT NULL,
    payment_id text NOT NULL,
    operation_kind text NOT NULL,
    operation_id text NOT NULL,
    prepared_tx_hash text NOT NULL,
    prepared_sequence text NOT NULL,
    status text NOT NULL,
    pi_payment_id text NOT NULL,
    u2a_txid text NOT NULL,
    proof_digest text NOT NULL,
    verified_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT r36_independent_u2a_attestations_network_check CHECK ((network = public.r36_network()::text)),
    CONSTRAINT r36_independent_u2a_attestations_operation_kind_check CHECK ((operation_kind = ANY (ARRAY['settlement'::text, 'refund'::text]))),
    CONSTRAINT r36_independent_u2a_attestations_prepared_sequence_check CHECK ((prepared_sequence ~ '^[1-9][0-9]*$'::text)),
    CONSTRAINT r36_independent_u2a_attestations_prepared_tx_hash_check CHECK ((prepared_tx_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_independent_u2a_attestations_proof_digest_check CHECK ((proof_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_independent_u2a_attestations_source_wallet_check CHECK ((source_wallet ~ '^G[A-Z2-7]{55}$'::text)),
    CONSTRAINT r36_independent_u2a_attestations_status_check CHECK ((status = 'verified'::text)),
    CONSTRAINT r36_independent_u2a_attestations_u2a_txid_check CHECK ((u2a_txid ~ '^[0-9a-f]{64}$'::text))
);


ALTER TABLE public.r36_independent_u2a_attestations OWNER TO r36_owner;

--
-- Name: r36_initial_clearance_links; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_initial_clearance_links (
    network text NOT NULL,
    source_wallet text NOT NULL,
    policy_digest text NOT NULL,
    nonce text NOT NULL,
    scope_digest text NOT NULL,
    prior_clearance_digest text NOT NULL,
    next_clearance_digest text NOT NULL,
    certificate_digest text NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    recorded_by text NOT NULL,
    CONSTRAINT r36_initial_clearance_links_network_check CHECK ((network = public.r36_network()::text)),
    CONSTRAINT r36_initial_clearance_links_next_clearance_digest_check CHECK ((next_clearance_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_initial_clearance_links_prior_clearance_digest_check CHECK ((prior_clearance_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_initial_clearance_links_recorded_by_check CHECK ((recorded_by = 'r36_issuer'::text)),
    CONSTRAINT r36_initial_clearance_links_source_wallet_check CHECK ((source_wallet ~ '^G[A-Z2-7]{55}$'::text))
);


ALTER TABLE public.r36_initial_clearance_links OWNER TO r36_owner;

--
-- Name: r36_legacy_right_holds; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_legacy_right_holds (
    payment_id text NOT NULL,
    network text NOT NULL,
    kind text NOT NULL,
    possible_obligation_stroops bigint NOT NULL,
    identity_values text[] NOT NULL,
    original_snapshot jsonb NOT NULL,
    original_snapshot_sha256 text NOT NULL,
    approval_digest text NOT NULL,
    state text NOT NULL,
    authorizes_new_rights boolean NOT NULL,
    held_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT r36_legacy_right_holds_approval_digest_check CHECK ((approval_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_legacy_right_holds_authorizes_new_rights_check CHECK ((authorizes_new_rights = false)),
    CONSTRAINT r36_legacy_right_holds_check CHECK ((payment_id = ANY (identity_values))),
    CONSTRAINT r36_legacy_right_holds_check1 CHECK ((original_snapshot_sha256 = encode(sha256(convert_to((original_snapshot)::text, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT r36_legacy_right_holds_kind_check CHECK ((kind = ANY (ARRAY['settlement'::text, 'refund'::text]))),
    CONSTRAINT r36_legacy_right_holds_network_check CHECK ((network = public.r36_network()::text)),
    CONSTRAINT r36_legacy_right_holds_original_snapshot_check CHECK ((jsonb_typeof(original_snapshot) = 'object'::text)),
    CONSTRAINT r36_legacy_right_holds_payment_id_check CHECK ((payment_id ~ '^[0-9a-f-]{36}$'::text)),
    CONSTRAINT r36_legacy_right_holds_possible_obligation_stroops_check CHECK ((possible_obligation_stroops > 0)),
    CONSTRAINT r36_legacy_right_holds_state_check CHECK ((state = 'HELD_UNRESOLVED_NO_RESEND'::text))
);


ALTER TABLE public.r36_legacy_right_holds OWNER TO r36_owner;

--
-- Name: r36_lifecycle_approval_links; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_lifecycle_approval_links (
    approval_id text NOT NULL,
    closure_digest text NOT NULL,
    successor_nonce text NOT NULL,
    evidence_text text NOT NULL,
    issued_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    prior_clearance_digest text NOT NULL,
    next_clearance_digest text NOT NULL,
    CONSTRAINT r36_lifecycle_approval_links_next_clearance_digest_check CHECK ((next_clearance_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_lifecycle_approval_links_prior_clearance_digest_check CHECK ((prior_clearance_digest ~ '^[0-9a-f]{64}$'::text))
);


ALTER TABLE public.r36_lifecycle_approval_links OWNER TO r36_owner;

--
-- Name: r36_payment_intake; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_payment_intake (
    payment_id text NOT NULL,
    policy_digest text NOT NULL,
    source_wallet text NOT NULL,
    merchant_uid text NOT NULL,
    merchant_id text NOT NULL,
    merchant_wallet text,
    create_intent_id uuid NOT NULL,
    note_digest text NOT NULL,
    amount_stroops bigint NOT NULL,
    identity_source text NOT NULL,
    identity_verified_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    payer_uid text,
    payer_wallet text,
    payer_verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    wallet_contract text DEFAULT 'PI_V2_ME'::text NOT NULL,
    payer_pi_payment_id text,
    payer_txid text,
    payer_wallet_proven_at timestamp with time zone,
    merchant_pi_payment_id text,
    CONSTRAINT r36_intake_wallet_evidence_shape CHECK (((wallet_contract <> 'PI_PAYMENT_DTO_V1'::text) OR ((((payer_wallet IS NULL) AND (payer_pi_payment_id IS NULL) AND (payer_txid IS NULL) AND (payer_wallet_proven_at IS NULL)) OR ((payer_wallet IS NOT NULL) AND (payer_uid IS NOT NULL) AND (payer_pi_payment_id IS NOT NULL) AND (payer_txid IS NOT NULL) AND (payer_wallet_proven_at IS NOT NULL))) AND (((merchant_wallet IS NULL) AND (merchant_pi_payment_id IS NULL)) OR ((merchant_wallet IS NOT NULL) AND (merchant_pi_payment_id IS NOT NULL)))))),
    CONSTRAINT r36_payment_intake_amount_stroops_check CHECK (((amount_stroops >= 1) AND (amount_stroops <= '10000000000000'::bigint))),
    CONSTRAINT r36_payment_intake_check CHECK ((((payer_uid IS NULL) AND (payer_wallet IS NULL) AND (payer_verified_at IS NULL)) OR (((length(payer_uid) >= 1) AND (length(payer_uid) <= 128)) AND (payer_wallet ~ '^G[A-Z2-7]{55}$'::text) AND (payer_verified_at IS NOT NULL)))),
    CONSTRAINT r36_payment_intake_identity_source_check CHECK ((identity_source = 'PI_V2_ME'::text)),
    CONSTRAINT r36_payment_intake_merchant_id_check CHECK (((length(merchant_id) >= 1) AND (length(merchant_id) <= 128))),
    CONSTRAINT r36_payment_intake_merchant_pi_payment_id_check CHECK ((merchant_pi_payment_id ~ '^[A-Za-z0-9_.:-]{1,128}$'::text)),
    CONSTRAINT r36_payment_intake_merchant_uid_check CHECK (((length(merchant_uid) >= 1) AND (length(merchant_uid) <= 128))),
    CONSTRAINT r36_payment_intake_merchant_wallet_check CHECK ((merchant_wallet ~ '^G[A-Z2-7]{55}$'::text)),
    CONSTRAINT r36_payment_intake_note_digest_check CHECK ((note_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_payment_intake_payer_pi_payment_id_check CHECK ((payer_pi_payment_id ~ '^[A-Za-z0-9_.:-]{1,128}$'::text)),
    CONSTRAINT r36_payment_intake_payer_txid_check CHECK ((payer_txid ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_payment_intake_payment_id_check CHECK ((payment_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT r36_payment_intake_source_wallet_check CHECK ((source_wallet ~ '^G[A-Z2-7]{55}$'::text)),
    CONSTRAINT r36_payment_intake_wallet_contract_check CHECK ((wallet_contract = ANY (ARRAY['PI_V2_ME'::text, 'PI_PAYMENT_DTO_V1'::text])))
);


ALTER TABLE public.r36_payment_intake OWNER TO r36_owner;

--
-- Name: r36_prepared_evidence_candidates; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_prepared_evidence_candidates (
    payment_id text NOT NULL,
    network text NOT NULL,
    source_wallet text NOT NULL,
    prepared_sequence text NOT NULL,
    candidate jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT r36_prepared_evidence_candidates_candidate_check CHECK ((jsonb_typeof(candidate) = 'object'::text)),
    CONSTRAINT r36_prepared_evidence_candidates_network_check CHECK ((network = public.r36_network()::text)),
    CONSTRAINT r36_prepared_evidence_candidates_prepared_sequence_check CHECK ((prepared_sequence ~ '^[1-9][0-9]{0,18}$'::text)),
    CONSTRAINT r36_prepared_evidence_candidates_source_wallet_check CHECK ((source_wallet ~ '^G[A-Z2-7]{55}$'::text))
);


ALTER TABLE public.r36_prepared_evidence_candidates OWNER TO r36_owner;

--
-- Name: r36_prior_closure_receipts; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_prior_closure_receipts (
    payload_digest text NOT NULL,
    policy_digest text NOT NULL,
    network text NOT NULL,
    source_wallet text NOT NULL,
    prior_payment text NOT NULL,
    prior_hash text NOT NULL,
    context_digest text NOT NULL,
    evidence_digest text NOT NULL,
    inventory_digest text NOT NULL,
    evidence_text text NOT NULL,
    issued_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    verified_by text NOT NULL,
    revoked boolean DEFAULT false NOT NULL,
    verified_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT r36_prior_closure_receipts_check CHECK ((expires_at > issued_at)),
    CONSTRAINT r36_prior_closure_receipts_evidence_text_check CHECK (((length(evidence_text) >= 1) AND (length(evidence_text) <= 12000000))),
    CONSTRAINT r36_prior_closure_receipts_network_check CHECK ((network = public.r36_network()::text)),
    CONSTRAINT r36_prior_closure_receipts_payload_digest_check CHECK ((payload_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_prior_closure_receipts_verified_by_check CHECK ((verified_by = 'r36_issuer'::text))
);


ALTER TABLE public.r36_prior_closure_receipts OWNER TO r36_owner;

--
-- Name: r36_recovery_trial_reservations; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_recovery_trial_reservations (
    payment_id text NOT NULL,
    nonce text NOT NULL,
    payload_digest text NOT NULL,
    amount_stroops bigint NOT NULL,
    reserved_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    last_selected_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT r36_recovery_trial_reservations_amount_stroops_check CHECK (((amount_stroops >= 1) AND (amount_stroops <= '10000000000000'::bigint)))
);


ALTER TABLE public.r36_recovery_trial_reservations OWNER TO r36_owner;

--
-- Name: r36_rotation_approval_evidence; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_rotation_approval_evidence (
    network text NOT NULL,
    source_wallet text NOT NULL,
    prior_prepared_hash text NOT NULL,
    comparison_digest text NOT NULL,
    seal_evidence_digest text NOT NULL,
    horizon_result_verified boolean DEFAULT false NOT NULL,
    historical_wallet_reconciled boolean DEFAULT false NOT NULL,
    accounting_finality_verified boolean DEFAULT false NOT NULL,
    certified_by text NOT NULL,
    certified_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT r36_rotation_approval_evidence_certified_by_check CHECK ((length(btrim(certified_by)) > 0)),
    CONSTRAINT r36_rotation_approval_evidence_comparison_digest_check CHECK ((comparison_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_rotation_approval_evidence_network_check CHECK ((network = public.r36_network()::text)),
    CONSTRAINT r36_rotation_approval_evidence_prior_prepared_hash_check CHECK ((prior_prepared_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_rotation_approval_evidence_seal_evidence_digest_check CHECK ((seal_evidence_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_rotation_approval_evidence_source_wallet_check CHECK ((source_wallet ~ '^G[A-Z2-7]{55}$'::text))
);


ALTER TABLE public.r36_rotation_approval_evidence OWNER TO r36_owner;

--
-- Name: r36_signed_approval_consumptions; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_signed_approval_consumptions (
    approval_id text NOT NULL,
    network text NOT NULL,
    wallet text NOT NULL,
    prior_hash text NOT NULL,
    prior_sequence numeric(30,0) NOT NULL,
    prior_payment text NOT NULL,
    prior_operation text NOT NULL,
    kind text NOT NULL,
    evidence_digest text NOT NULL,
    inventory_digest text NOT NULL,
    binding_digest text NOT NULL,
    payload_digest text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    independently_certified_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    CONSTRAINT r36_signed_approval_consumptions_approval_id_check CHECK (((length(approval_id) >= 1) AND (length(approval_id) <= 255))),
    CONSTRAINT r36_signed_approval_consumptions_binding_digest_check CHECK ((binding_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_signed_approval_consumptions_check CHECK (((consumed_at IS NULL) OR (consumed_at >= independently_certified_at))),
    CONSTRAINT r36_signed_approval_consumptions_evidence_digest_check CHECK ((evidence_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_signed_approval_consumptions_inventory_digest_check CHECK ((inventory_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_signed_approval_consumptions_kind_check CHECK ((kind = ANY (ARRAY['settlement'::text, 'refund'::text]))),
    CONSTRAINT r36_signed_approval_consumptions_network_check CHECK ((network = public.r36_network()::text)),
    CONSTRAINT r36_signed_approval_consumptions_payload_digest_check CHECK ((payload_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_signed_approval_consumptions_prior_hash_check CHECK ((prior_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_signed_approval_consumptions_prior_sequence_check CHECK ((prior_sequence > (0)::numeric)),
    CONSTRAINT r36_signed_approval_consumptions_wallet_check CHECK ((wallet ~ '^G[A-Z2-7]{55}$'::text))
);


ALTER TABLE public.r36_signed_approval_consumptions OWNER TO r36_owner;

--
-- Name: r36_wallet_execution_scopes; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_wallet_execution_scopes (
    scope_digest text NOT NULL,
    policy_digest text NOT NULL,
    source_wallet text NOT NULL,
    scope_text text NOT NULL,
    enrolled_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT r36_wallet_execution_scopes_check CHECK ((scope_digest = encode(sha256(convert_to(scope_text, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT r36_wallet_execution_scopes_check1 CHECK ((((scope_text)::jsonb ->> 'sourceWallet'::text) = source_wallet)),
    CONSTRAINT r36_wallet_execution_scopes_scope_digest_check CHECK ((scope_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_wallet_execution_scopes_scope_text_check CHECK ((octet_length(scope_text) <= 2000000)),
    CONSTRAINT r36_wallet_execution_scopes_scope_text_check1 CHECK ((((scope_text)::jsonb ->> 'schema'::text) IN ('R36_NEW_WALLET_EXECUTION_SCOPE_V1','R36_CLEAN_NETWORK_EXECUTION_SCOPE_V2'))),
    CONSTRAINT r36_wallet_execution_scopes_scope_text_check2 CHECK ((NOT (((scope_text)::jsonb ->> 'network'::text) IS DISTINCT FROM public.r36_network()::text))),
    CONSTRAINT r36_wallet_execution_scopes_scope_text_check3 CHECK ((NOT (((scope_text)::jsonb ->> 'oldRightsDisposition'::text) IS DISTINCT FROM 'DEFERRED_PRESERVED_NO_RESEND'::text))),
    CONSTRAINT r36_wallet_execution_scopes_scope_text_check4 CHECK ((NOT (((scope_text)::jsonb -> 'oldRightsFinanciallyCleared'::text) IS DISTINCT FROM 'false'::jsonb))),
    CONSTRAINT r36_wallet_execution_scopes_source_wallet_check CHECK ((source_wallet ~ '^G[A-Z2-7]{55}$'::text))
);


ALTER TABLE public.r36_wallet_execution_scopes OWNER TO r36_owner;

--
-- Name: r36_wallet_successor_requests; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.r36_wallet_successor_requests (
    approval_id text NOT NULL,
    successor_nonce text NOT NULL,
    prior_payload_digest text NOT NULL,
    binding_digest text NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT r36_wallet_successor_requests_binding_digest_check CHECK ((binding_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT r36_wallet_successor_requests_prior_payload_digest_check CHECK ((prior_payload_digest ~ '^[0-9a-f]{64}$'::text))
);


ALTER TABLE public.r36_wallet_successor_requests OWNER TO r36_owner;

--
-- Name: receipts; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transaction_id uuid NOT NULL,
    merchant_id text NOT NULL,
    amount numeric(18,8) NOT NULL,
    currency text DEFAULT 'π'::text,
    "timestamp" timestamp without time zone NOT NULL,
    txid text,
    payer_username text,
    metadata jsonb,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    merchant_uid text DEFAULT ''::text NOT NULL,
    u2a_identifier text,
    u2a_txid text,
    a2u_identifier text,
    a2u_txid text,
    customer_amount numeric(18,8),
    horizon_fee_charged numeric(18,8) DEFAULT 0,
    app_commission numeric(18,8) DEFAULT 0,
    merchant_amount numeric(18,8),
    app_net_impact numeric(18,8) DEFAULT 0,
    settlement_status text DEFAULT 'pending'::text
);


ALTER TABLE public.receipts OWNER TO neondb_owner;

--
-- Name: refund_accounting_records; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.refund_accounting_records (
    refund_id text NOT NULL,
    payment_id text NOT NULL,
    refund_payment_id text NOT NULL,
    refund_txid text NOT NULL,
    payer_uid text NOT NULL,
    amount numeric(18,8) NOT NULL,
    horizon_fee_stroops bigint NOT NULL,
    currency text DEFAULT 'π'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT refund_accounting_records_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT refund_accounting_records_horizon_fee_stroops_check CHECK ((horizon_fee_stroops >= 0))
);


ALTER TABLE public.refund_accounting_records OWNER TO neondb_owner;

--
-- Name: refund_audit_events; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.refund_audit_events (
    event_id text NOT NULL,
    refund_id text NOT NULL,
    payment_id text NOT NULL,
    event_type text NOT NULL,
    actor_type text NOT NULL,
    idempotency_key text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL
);


ALTER TABLE public.refund_audit_events OWNER TO neondb_owner;

--
-- Name: refund_automatic_retirements; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.refund_automatic_retirements (
    refund_id text NOT NULL,
    payment_id text NOT NULL,
    reason text NOT NULL,
    evidence_code text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.refund_automatic_retirements OWNER TO neondb_owner;

--
-- Name: refund_pi_create_attempts; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.refund_pi_create_attempts (
    refund_id text NOT NULL,
    payment_id text NOT NULL,
    idempotency_key text NOT NULL,
    attempted_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.refund_pi_create_attempts OWNER TO neondb_owner;

--
-- Name: refund_rejected_create_attempts; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.refund_rejected_create_attempts (
    refund_id text NOT NULL,
    payment_id text NOT NULL,
    idempotency_key text NOT NULL,
    review_sha256 text NOT NULL,
    attempted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT refund_rejected_create_attempts_review_sha256_check CHECK ((review_sha256 ~ '^[0-9a-f]{64}$'::text))
);


ALTER TABLE public.refund_rejected_create_attempts OWNER TO r36_owner;

--
-- Name: refund_rejected_create_authorizations; Type: TABLE; Schema: public; Owner: r36_owner
--

CREATE TABLE public.refund_rejected_create_authorizations (
    refund_id text NOT NULL,
    payment_id text NOT NULL,
    idempotency_key text NOT NULL,
    original_attempted_at timestamp without time zone NOT NULL,
    policy_digest text NOT NULL,
    source_wallet text NOT NULL,
    amount_stroops bigint NOT NULL,
    network text NOT NULL,
    rejection_http_status integer NOT NULL,
    rejection_code text NOT NULL,
    conflicting_pi_payment_id text NOT NULL,
    original_response_sha256 text NOT NULL,
    cancellation_proof_sha256 text NOT NULL,
    review_sha256 text NOT NULL,
    authorized_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT refund_rejected_create_authoriz_cancellation_proof_sha256_check CHECK ((cancellation_proof_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT refund_rejected_create_authoriz_conflicting_pi_payment_id_check CHECK ((length(conflicting_pi_payment_id) > 0)),
    CONSTRAINT refund_rejected_create_authoriza_original_response_sha256_check CHECK ((original_response_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT refund_rejected_create_authorizatio_rejection_http_status_check CHECK ((rejection_http_status = 400)),
    CONSTRAINT refund_rejected_create_authorizations_amount_stroops_check CHECK (((amount_stroops > 0) AND (amount_stroops <= 2000000))),
    CONSTRAINT refund_rejected_create_authorizations_check CHECK (((expires_at > authorized_at) AND (expires_at <= (authorized_at + '06:00:00'::interval)))),
    CONSTRAINT refund_rejected_create_authorizations_network_check CHECK ((network = public.r36_network()::text)),
    CONSTRAINT refund_rejected_create_authorizations_policy_digest_check CHECK ((policy_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT refund_rejected_create_authorizations_rejection_code_check CHECK ((rejection_code = 'ongoing_payment_found'::text)),
    CONSTRAINT refund_rejected_create_authorizations_review_sha256_check CHECK ((review_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT refund_rejected_create_authorizations_source_wallet_check CHECK ((source_wallet ~ '^G[A-Z2-7]{55}$'::text))
);


ALTER TABLE public.refund_rejected_create_authorizations OWNER TO r36_owner;

--
-- Name: settlement_a2u_ongoing_observations; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.settlement_a2u_ongoing_observations (
    payment_id text NOT NULL,
    a2u_payment_id text NOT NULL,
    observed_at timestamp without time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.settlement_a2u_ongoing_observations OWNER TO neondb_owner;

--
-- Name: settlement_a2u_stage1_retirements; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.settlement_a2u_stage1_retirements (
    payment_id text NOT NULL,
    a2u_payment_id text NOT NULL,
    reason text NOT NULL,
    pi_cancelled_at timestamp without time zone NOT NULL,
    horizon_absence_proven_at timestamp without time zone NOT NULL,
    retired_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT settlement_a2u_stage1_retirements_reason_check CHECK ((reason = 'pi_cancelled_before_transaction'::text))
);


ALTER TABLE public.settlement_a2u_stage1_retirements OWNER TO neondb_owner;

--
-- Name: settlement_checkpoints; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.settlement_checkpoints (
    payment_id text NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    stage text NOT NULL,
    merchant_id text NOT NULL,
    merchant_uid text NOT NULL,
    customer_amount numeric(18,8) NOT NULL,
    merchant_amount numeric(18,8),
    app_commission numeric(18,8) DEFAULT 0 NOT NULL,
    u2a_identifier text,
    u2a_txid text,
    a2u_payment_id text,
    a2u_from_address text,
    a2u_to_address text,
    prepared_envelope_xdr text,
    prepared_tx_hash text,
    prepared_sequence numeric(30,0),
    a2u_txid text,
    horizon_fee_stroops bigint,
    horizon_confirmed_at timestamp without time zone,
    pi_completed_at timestamp without time zone,
    db_finalized_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    payer_uid text,
    u2a_verified_at timestamp without time zone,
    u2a_completed_at timestamp without time zone,
    u2a_approval_identifier text,
    u2a_approval_claimed_at timestamp without time zone,
    certification_hold text,
    certification_hold_at timestamp without time zone,
    certification_hold_expires_at timestamp without time zone,
    u2a_start_lease_token text,
    u2a_start_lease_expires_at timestamp without time zone,
    a2u_create_guard_version text,
    a2u_create_attempted_at timestamp without time zone,
    u2a_approval_guard_version text,
    u2a_approval_attempted_at timestamp without time zone,
    pi_mutation_guard_version text,
    CONSTRAINT settlement_checkpoints_a2u_txid_check CHECK (((a2u_txid IS NULL) OR (a2u_txid ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT settlement_checkpoints_app_commission_check CHECK ((app_commission = (0)::numeric)),
    CONSTRAINT settlement_checkpoints_check CHECK (((merchant_amount IS NULL) OR (merchant_amount = customer_amount))),
    CONSTRAINT settlement_checkpoints_check1 CHECK (((stage <> ALL (ARRAY['a2u_created'::text, 'prepared'::text, 'horizon_confirmed'::text, 'pi_completed'::text, 'db_finalized'::text])) OR (a2u_payment_id IS NOT NULL))),
    CONSTRAINT settlement_checkpoints_check2 CHECK (((stage <> ALL (ARRAY['prepared'::text, 'horizon_confirmed'::text, 'pi_completed'::text, 'db_finalized'::text])) OR ((a2u_from_address IS NOT NULL) AND (a2u_to_address IS NOT NULL) AND (prepared_envelope_xdr IS NOT NULL) AND (prepared_tx_hash IS NOT NULL) AND (prepared_sequence IS NOT NULL)))),
    CONSTRAINT settlement_checkpoints_check3 CHECK (((stage <> ALL (ARRAY['horizon_confirmed'::text, 'pi_completed'::text, 'db_finalized'::text])) OR ((a2u_txid IS NOT NULL) AND (prepared_tx_hash = a2u_txid) AND (horizon_fee_stroops IS NOT NULL) AND (horizon_confirmed_at IS NOT NULL)))),
    CONSTRAINT settlement_checkpoints_check4 CHECK (((stage <> ALL (ARRAY['pi_completed'::text, 'db_finalized'::text])) OR (pi_completed_at IS NOT NULL))),
    CONSTRAINT settlement_checkpoints_check5 CHECK (((stage <> 'db_finalized'::text) OR (db_finalized_at IS NOT NULL))),
    CONSTRAINT settlement_checkpoints_customer_amount_check CHECK ((customer_amount > (0)::numeric)),
    CONSTRAINT settlement_checkpoints_horizon_fee_stroops_check CHECK (((horizon_fee_stroops IS NULL) OR (horizon_fee_stroops >= 0))),
    CONSTRAINT settlement_checkpoints_merchant_amount_check CHECK ((merchant_amount > (0)::numeric)),
    CONSTRAINT settlement_checkpoints_merchant_id_check CHECK ((length(btrim(merchant_id)) > 0)),
    CONSTRAINT settlement_checkpoints_merchant_uid_check CHECK ((length(btrim(merchant_uid)) > 0)),
    CONSTRAINT settlement_checkpoints_prepared_sequence_check CHECK (((prepared_sequence IS NULL) OR (prepared_sequence > (0)::numeric))),
    CONSTRAINT settlement_checkpoints_prepared_tx_hash_check CHECK (((prepared_tx_hash IS NULL) OR (prepared_tx_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT settlement_checkpoints_stage_check CHECK ((stage = ANY (ARRAY['payment_identity'::text, 'a2u_created'::text, 'prepared'::text, 'horizon_confirmed'::text, 'pi_completed'::text, 'db_finalized'::text]))),
    CONSTRAINT settlement_checkpoints_version_check CHECK ((version >= 0))
);


ALTER TABLE public.settlement_checkpoints OWNER TO neondb_owner;

--
-- Name: settlement_recovery_scan_cursor; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.settlement_recovery_scan_cursor (
    singleton boolean DEFAULT true NOT NULL,
    last_updated_at timestamp without time zone,
    last_payment_id text,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT settlement_recovery_scan_cursor_singleton_check CHECK ((singleton = true))
);


ALTER TABLE public.settlement_recovery_scan_cursor OWNER TO neondb_owner;

--
-- Name: settlement_requests; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.settlement_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    merchant_id text NOT NULL,
    transaction_id uuid NOT NULL,
    amount numeric(18,8) NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    completed_at timestamp without time zone,
    txid text,
    error_message text,
    retry_count integer DEFAULT 0
);


ALTER TABLE public.settlement_requests OWNER TO neondb_owner;

--
-- Name: settlement_u2a_approval_retirements; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.settlement_u2a_approval_retirements (
    payment_id text NOT NULL,
    pi_payment_id text NOT NULL,
    reason text NOT NULL,
    pi_cancelled_at timestamp without time zone NOT NULL,
    retired_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT settlement_u2a_approval_retirements_reason_check CHECK ((reason = 'pi_pretransaction_cancelled'::text))
);


ALTER TABLE public.settlement_u2a_approval_retirements OWNER TO neondb_owner;

--
-- Name: transactions; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    payment_id text NOT NULL,
    merchant_id text NOT NULL,
    amount numeric(18,8) NOT NULL,
    currency text DEFAULT 'π'::text,
    reference text NOT NULL,
    description text,
    status text DEFAULT 'completed'::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    completed_at timestamp without time zone,
    merchant_uid text DEFAULT ''::text NOT NULL
);


ALTER TABLE public.transactions OWNER TO neondb_owner;

--
-- Name: transfers; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.transfers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    transaction_id uuid NOT NULL,
    merchant_id text NOT NULL,
    merchant_address text NOT NULL,
    amount numeric(18,8) NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    pi_transfer_id text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    completed_at timestamp without time zone,
    error_message text,
    retry_count integer DEFAULT 0,
    last_retry_at timestamp without time zone
);


ALTER TABLE public.transfers OWNER TO neondb_owner;

--
-- Name: u2a_ingress_recovery_scan_cursor; Type: TABLE; Schema: public; Owner: neondb_owner
--

CREATE TABLE public.u2a_ingress_recovery_scan_cursor (
    singleton boolean DEFAULT true NOT NULL,
    last_updated_at timestamp without time zone,
    last_payment_id text,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT u2a_ingress_recovery_scan_cursor_singleton_check CHECK ((singleton = true))
);


ALTER TABLE public.u2a_ingress_recovery_scan_cursor OWNER TO neondb_owner;

--
-- Name: receipts; Type: TABLE; Schema: r36_signing; Owner: r36_signer_owner
--

CREATE TABLE r36_signing.receipts (
    idempotency_key text NOT NULL,
    signature_base64 text NOT NULL,
    signed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    signed_by text NOT NULL,
    CONSTRAINT receipts_signature_base64_check CHECK ((signature_base64 ~ '^[A-Za-z0-9+/]{86}==$'::text)),
    CONSTRAINT receipts_signed_by_check CHECK ((signed_by = 'r36_signer'::text))
);


ALTER TABLE r36_signing.receipts OWNER TO r36_signer_owner;

--
-- Name: requests; Type: TABLE; Schema: r36_signing; Owner: r36_signer_owner
--

CREATE TABLE r36_signing.requests (
    idempotency_key text NOT NULL,
    issuer_id text NOT NULL,
    key_id text NOT NULL,
    policy_digest text NOT NULL,
    bytes_base64 text NOT NULL,
    public_key_pin text NOT NULL,
    approved_by text NOT NULL,
    approval_digest text NOT NULL,
    valid_from bigint NOT NULL,
    valid_until bigint NOT NULL,
    revoked boolean DEFAULT false NOT NULL,
    CONSTRAINT requests_approval_digest_check CHECK ((approval_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT requests_approved_by_check CHECK ((length(approved_by) > 0)),
    CONSTRAINT requests_bytes_base64_check CHECK (((length(bytes_base64) >= 4) AND (length(bytes_base64) <= 32768))),
    CONSTRAINT requests_check CHECK ((valid_until > valid_from)),
    CONSTRAINT requests_idempotency_key_check CHECK ((idempotency_key ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT requests_policy_digest_check CHECK ((policy_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT requests_public_key_pin_check CHECK ((public_key_pin ~ '^[0-9a-f]{64}$'::text))
);


ALTER TABLE r36_signing.requests OWNER TO r36_signer_owner;

--
-- Name: certification_fault_arms certification_fault_arms_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.certification_fault_arms
    ADD CONSTRAINT certification_fault_arms_pkey PRIMARY KEY (payment_id);


--
-- Name: dr17_cert_execution dr17_cert_execution_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.dr17_cert_execution
    ADD CONSTRAINT dr17_cert_execution_pkey PRIMARY KEY (execution_key);


--
-- Name: dr17_cert_items dr17_cert_items_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.dr17_cert_items
    ADD CONSTRAINT dr17_cert_items_pkey PRIMARY KEY (run_id, payment_id);


--
-- Name: dr17_cert_runs dr17_cert_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.dr17_cert_runs
    ADD CONSTRAINT dr17_cert_runs_pkey PRIMARY KEY (run_id);


--
-- Name: financial_pi_mutation_attempts financial_pi_mutation_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.financial_pi_mutation_attempts
    ADD CONSTRAINT financial_pi_mutation_attempts_pkey PRIMARY KEY (mutation_kind, payment_id, external_payment_id);


--
-- Name: financial_wallet_activation financial_wallet_activation_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.financial_wallet_activation
    ADD CONSTRAINT financial_wallet_activation_pkey PRIMARY KEY (network, source_wallet);


--
-- Name: financial_wallet_authorities financial_wallet_authorities_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.financial_wallet_authorities
    ADD CONSTRAINT financial_wallet_authorities_pkey PRIMARY KEY (network, source_wallet);


--
-- Name: financial_wallet_authority_history financial_wallet_authority_hi_network_source_wallet_prepare_key; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.financial_wallet_authority_history
    ADD CONSTRAINT financial_wallet_authority_hi_network_source_wallet_prepare_key UNIQUE (network, source_wallet, prepared_sequence);


--
-- Name: financial_wallet_authority_history financial_wallet_authority_history_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.financial_wallet_authority_history
    ADD CONSTRAINT financial_wallet_authority_history_pkey PRIMARY KEY (network, source_wallet, prepared_tx_hash);


--
-- Name: financial_wallet_finality_seals financial_wallet_finality_seals_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.financial_wallet_finality_seals
    ADD CONSTRAINT financial_wallet_finality_seals_pkey PRIMARY KEY (network, source_wallet, prepared_tx_hash);


--
-- Name: financial_wallet_rotation_approvals financial_wallet_rotation_approvals_approval_id_key; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.financial_wallet_rotation_approvals
    ADD CONSTRAINT financial_wallet_rotation_approvals_approval_id_key UNIQUE (approval_id);


--
-- Name: financial_wallet_rotation_approvals financial_wallet_rotation_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.financial_wallet_rotation_approvals
    ADD CONSTRAINT financial_wallet_rotation_approvals_pkey PRIMARY KEY (network, source_wallet, prior_prepared_hash);


--
-- Name: financial_wallet_submission_attempts financial_wallet_submission_a_network_source_wallet_prepare_key; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.financial_wallet_submission_attempts
    ADD CONSTRAINT financial_wallet_submission_a_network_source_wallet_prepare_key UNIQUE (network, source_wallet, prepared_sequence);


--
-- Name: financial_wallet_submission_attempts financial_wallet_submission_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.financial_wallet_submission_attempts
    ADD CONSTRAINT financial_wallet_submission_attempts_pkey PRIMARY KEY (network, source_wallet, prepared_tx_hash);


--
-- Name: merchant_balances merchant_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.merchant_balances
    ADD CONSTRAINT merchant_balances_pkey PRIMARY KEY (merchant_id);


--
-- Name: payment_create_intents payment_create_intents_payment_id_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.payment_create_intents
    ADD CONSTRAINT payment_create_intents_payment_id_key UNIQUE (payment_id);


--
-- Name: payment_create_intents payment_create_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.payment_create_intents
    ADD CONSTRAINT payment_create_intents_pkey PRIMARY KEY (merchant_uid, create_intent_id);


--
-- Name: r36_admission_renewal_receipts r36_admission_renewal_receipts_payload_digest_key; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_admission_renewal_receipts
    ADD CONSTRAINT r36_admission_renewal_receipts_payload_digest_key UNIQUE (payload_digest);


--
-- Name: r36_admission_renewal_receipts r36_admission_renewal_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_admission_renewal_receipts
    ADD CONSTRAINT r36_admission_renewal_receipts_pkey PRIMARY KEY (nonce, generation);


--
-- Name: r36_admission_renewal_requests r36_admission_renewal_requests_payload_digest_key; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_admission_renewal_requests
    ADD CONSTRAINT r36_admission_renewal_requests_payload_digest_key UNIQUE (payload_digest);


--
-- Name: r36_admission_renewal_requests r36_admission_renewal_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_admission_renewal_requests
    ADD CONSTRAINT r36_admission_renewal_requests_pkey PRIMARY KEY (nonce, generation);


--
-- Name: r36_admission_renewal_revocations r36_admission_renewal_revocations_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_admission_renewal_revocations
    ADD CONSTRAINT r36_admission_renewal_revocations_pkey PRIMARY KEY (payload_digest);


--
-- Name: r36_bound_renewal_receipts r36_bound_renewal_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_bound_renewal_receipts
    ADD CONSTRAINT r36_bound_renewal_receipts_pkey PRIMARY KEY (payload_digest);


--
-- Name: r36_certificate_policies r36_certificate_policies_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_certificate_policies
    ADD CONSTRAINT r36_certificate_policies_pkey PRIMARY KEY (policy_digest);


--
-- Name: r36_certificate_receipts r36_certificate_receipts_payload_digest_key; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_certificate_receipts
    ADD CONSTRAINT r36_certificate_receipts_payload_digest_key UNIQUE (payload_digest);


--
-- Name: r36_certificate_receipts r36_certificate_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_certificate_receipts
    ADD CONSTRAINT r36_certificate_receipts_pkey PRIMARY KEY (nonce);


--
-- Name: r36_certificate_requests r36_certificate_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_certificate_requests
    ADD CONSTRAINT r36_certificate_requests_pkey PRIMARY KEY (nonce);


--
-- Name: r36_certificate_revocations r36_certificate_revocations_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_certificate_revocations
    ADD CONSTRAINT r36_certificate_revocations_pkey PRIMARY KEY (payload_digest);


--
-- Name: r36_independent_u2a_attestations r36_independent_u2a_attestations_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_independent_u2a_attestations
    ADD CONSTRAINT r36_independent_u2a_attestations_pkey PRIMARY KEY (network, source_wallet, payment_id, operation_kind, operation_id, prepared_tx_hash, prepared_sequence);


--
-- Name: r36_initial_clearance_links r36_initial_clearance_links_nonce_key; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_initial_clearance_links
    ADD CONSTRAINT r36_initial_clearance_links_nonce_key UNIQUE (nonce);


--
-- Name: r36_initial_clearance_links r36_initial_clearance_links_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_initial_clearance_links
    ADD CONSTRAINT r36_initial_clearance_links_pkey PRIMARY KEY (network, source_wallet);


--
-- Name: r36_legacy_right_holds r36_legacy_right_holds_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_legacy_right_holds
    ADD CONSTRAINT r36_legacy_right_holds_pkey PRIMARY KEY (payment_id);


--
-- Name: r36_lifecycle_approval_links r36_lifecycle_approval_links_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_lifecycle_approval_links
    ADD CONSTRAINT r36_lifecycle_approval_links_pkey PRIMARY KEY (approval_id);


--
-- Name: r36_lifecycle_approval_links r36_lifecycle_approval_links_successor_nonce_key; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_lifecycle_approval_links
    ADD CONSTRAINT r36_lifecycle_approval_links_successor_nonce_key UNIQUE (successor_nonce);


--
-- Name: r36_payment_intake r36_payment_intake_merchant_uid_create_intent_id_key; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_payment_intake
    ADD CONSTRAINT r36_payment_intake_merchant_uid_create_intent_id_key UNIQUE (merchant_uid, create_intent_id);


--
-- Name: r36_payment_intake r36_payment_intake_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_payment_intake
    ADD CONSTRAINT r36_payment_intake_pkey PRIMARY KEY (payment_id);


--
-- Name: r36_prepared_evidence_candidates r36_prepared_evidence_candida_network_source_wallet_prepare_key; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_prepared_evidence_candidates
    ADD CONSTRAINT r36_prepared_evidence_candida_network_source_wallet_prepare_key UNIQUE (network, source_wallet, prepared_sequence);


--
-- Name: r36_prepared_evidence_candidates r36_prepared_evidence_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_prepared_evidence_candidates
    ADD CONSTRAINT r36_prepared_evidence_candidates_pkey PRIMARY KEY (payment_id);


--
-- Name: r36_prior_closure_receipts r36_prior_closure_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_prior_closure_receipts
    ADD CONSTRAINT r36_prior_closure_receipts_pkey PRIMARY KEY (payload_digest);


--
-- Name: r36_recovery_trial_reservations r36_recovery_trial_reservations_nonce_key; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_recovery_trial_reservations
    ADD CONSTRAINT r36_recovery_trial_reservations_nonce_key UNIQUE (nonce);


--
-- Name: r36_recovery_trial_reservations r36_recovery_trial_reservations_payload_digest_key; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_recovery_trial_reservations
    ADD CONSTRAINT r36_recovery_trial_reservations_payload_digest_key UNIQUE (payload_digest);


--
-- Name: r36_recovery_trial_reservations r36_recovery_trial_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_recovery_trial_reservations
    ADD CONSTRAINT r36_recovery_trial_reservations_pkey PRIMARY KEY (payment_id);


--
-- Name: r36_rotation_approval_evidence r36_rotation_approval_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_rotation_approval_evidence
    ADD CONSTRAINT r36_rotation_approval_evidence_pkey PRIMARY KEY (network, source_wallet, prior_prepared_hash);


--
-- Name: r36_signed_approval_consumptions r36_signed_approval_consumptions_payload_digest_key; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_signed_approval_consumptions
    ADD CONSTRAINT r36_signed_approval_consumptions_payload_digest_key UNIQUE (payload_digest);


--
-- Name: r36_signed_approval_consumptions r36_signed_approval_consumptions_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_signed_approval_consumptions
    ADD CONSTRAINT r36_signed_approval_consumptions_pkey PRIMARY KEY (approval_id);


--
-- Name: r36_testnet_ingress_reservations r36_testnet_ingress_reservati_merchant_uid_create_intent_id_key; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_testnet_ingress_reservations
    ADD CONSTRAINT r36_testnet_ingress_reservati_merchant_uid_create_intent_id_key UNIQUE (merchant_uid, create_intent_id);


--
-- Name: r36_testnet_ingress_reservations r36_testnet_ingress_reservations_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_testnet_ingress_reservations
    ADD CONSTRAINT r36_testnet_ingress_reservations_pkey PRIMARY KEY (payment_id);


--
-- Name: r36_testnet_ingress_reservations r36_testnet_ingress_reservations_retired_by_payment_id_key; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_testnet_ingress_reservations
    ADD CONSTRAINT r36_testnet_ingress_reservations_retired_by_payment_id_key UNIQUE (retired_by_payment_id);


--
-- Name: r36_wallet_execution_scopes r36_wallet_execution_scopes_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_wallet_execution_scopes
    ADD CONSTRAINT r36_wallet_execution_scopes_pkey PRIMARY KEY (scope_digest, policy_digest);


--
-- Name: r36_wallet_successor_requests r36_wallet_successor_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_wallet_successor_requests
    ADD CONSTRAINT r36_wallet_successor_requests_pkey PRIMARY KEY (approval_id);


--
-- Name: r36_wallet_successor_requests r36_wallet_successor_requests_successor_nonce_key; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_wallet_successor_requests
    ADD CONSTRAINT r36_wallet_successor_requests_successor_nonce_key UNIQUE (successor_nonce);


--
-- Name: receipts receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_pkey PRIMARY KEY (id);


--
-- Name: receipts receipts_transaction_id_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_transaction_id_key UNIQUE (transaction_id);


--
-- Name: refund_accounting_records refund_accounting_records_payment_id_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.refund_accounting_records
    ADD CONSTRAINT refund_accounting_records_payment_id_key UNIQUE (payment_id);


--
-- Name: refund_accounting_records refund_accounting_records_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.refund_accounting_records
    ADD CONSTRAINT refund_accounting_records_pkey PRIMARY KEY (refund_id);


--
-- Name: refund_accounting_records refund_accounting_records_refund_payment_id_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.refund_accounting_records
    ADD CONSTRAINT refund_accounting_records_refund_payment_id_key UNIQUE (refund_payment_id);


--
-- Name: refund_accounting_records refund_accounting_records_refund_txid_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.refund_accounting_records
    ADD CONSTRAINT refund_accounting_records_refund_txid_key UNIQUE (refund_txid);


--
-- Name: refund_audit_events refund_audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.refund_audit_events
    ADD CONSTRAINT refund_audit_events_pkey PRIMARY KEY (event_id);


--
-- Name: refund_automatic_retirements refund_automatic_retirements_payment_id_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.refund_automatic_retirements
    ADD CONSTRAINT refund_automatic_retirements_payment_id_key UNIQUE (payment_id);


--
-- Name: refund_automatic_retirements refund_automatic_retirements_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.refund_automatic_retirements
    ADD CONSTRAINT refund_automatic_retirements_pkey PRIMARY KEY (refund_id);


--
-- Name: refund_checkpoints refund_checkpoints_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.refund_checkpoints
    ADD CONSTRAINT refund_checkpoints_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: refund_checkpoints refund_checkpoints_payment_id_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.refund_checkpoints
    ADD CONSTRAINT refund_checkpoints_payment_id_key UNIQUE (payment_id);


--
-- Name: refund_checkpoints refund_checkpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.refund_checkpoints
    ADD CONSTRAINT refund_checkpoints_pkey PRIMARY KEY (refund_id);


--
-- Name: refund_pi_create_attempts refund_pi_create_attempts_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.refund_pi_create_attempts
    ADD CONSTRAINT refund_pi_create_attempts_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: refund_pi_create_attempts refund_pi_create_attempts_payment_id_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.refund_pi_create_attempts
    ADD CONSTRAINT refund_pi_create_attempts_payment_id_key UNIQUE (payment_id);


--
-- Name: refund_pi_create_attempts refund_pi_create_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.refund_pi_create_attempts
    ADD CONSTRAINT refund_pi_create_attempts_pkey PRIMARY KEY (refund_id);


--
-- Name: refund_rejected_create_attempts refund_rejected_create_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.refund_rejected_create_attempts
    ADD CONSTRAINT refund_rejected_create_attempts_pkey PRIMARY KEY (refund_id);


--
-- Name: refund_rejected_create_authorizations refund_rejected_create_authorizations_pkey; Type: CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.refund_rejected_create_authorizations
    ADD CONSTRAINT refund_rejected_create_authorizations_pkey PRIMARY KEY (refund_id);


--
-- Name: settlement_a2u_ongoing_observations settlement_a2u_ongoing_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.settlement_a2u_ongoing_observations
    ADD CONSTRAINT settlement_a2u_ongoing_observations_pkey PRIMARY KEY (payment_id, a2u_payment_id);


--
-- Name: settlement_a2u_stage1_retirements settlement_a2u_stage1_retirements_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.settlement_a2u_stage1_retirements
    ADD CONSTRAINT settlement_a2u_stage1_retirements_pkey PRIMARY KEY (payment_id, a2u_payment_id);


--
-- Name: settlement_checkpoints settlement_checkpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.settlement_checkpoints
    ADD CONSTRAINT settlement_checkpoints_pkey PRIMARY KEY (payment_id);


--
-- Name: settlement_recovery_scan_cursor settlement_recovery_scan_cursor_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.settlement_recovery_scan_cursor
    ADD CONSTRAINT settlement_recovery_scan_cursor_pkey PRIMARY KEY (singleton);


--
-- Name: settlement_requests settlement_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.settlement_requests
    ADD CONSTRAINT settlement_requests_pkey PRIMARY KEY (id);


--
-- Name: settlement_u2a_approval_retirements settlement_u2a_approval_retirements_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.settlement_u2a_approval_retirements
    ADD CONSTRAINT settlement_u2a_approval_retirements_pkey PRIMARY KEY (payment_id, pi_payment_id);


--
-- Name: transactions transactions_payment_id_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_payment_id_key UNIQUE (payment_id);


--
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);


--
-- Name: transactions transactions_reference_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_reference_key UNIQUE (reference);


--
-- Name: transfers transfers_pi_transfer_id_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_pi_transfer_id_key UNIQUE (pi_transfer_id);


--
-- Name: transfers transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_pkey PRIMARY KEY (id);


--
-- Name: transfers transfers_transaction_id_key; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_transaction_id_key UNIQUE (transaction_id);


--
-- Name: u2a_ingress_recovery_scan_cursor u2a_ingress_recovery_scan_cursor_pkey; Type: CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.u2a_ingress_recovery_scan_cursor
    ADD CONSTRAINT u2a_ingress_recovery_scan_cursor_pkey PRIMARY KEY (singleton);


--
-- Name: receipts receipts_pkey; Type: CONSTRAINT; Schema: r36_signing; Owner: r36_signer_owner
--

ALTER TABLE ONLY r36_signing.receipts
    ADD CONSTRAINT receipts_pkey PRIMARY KEY (idempotency_key);


--
-- Name: requests requests_pkey; Type: CONSTRAINT; Schema: r36_signing; Owner: r36_signer_owner
--

ALTER TABLE ONLY r36_signing.requests
    ADD CONSTRAINT requests_pkey PRIMARY KEY (idempotency_key);


--
-- Name: idx_merchant_balances_merchant; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_merchant_balances_merchant ON public.merchant_balances USING btree (merchant_id);


--
-- Name: idx_receipts_created; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_receipts_created ON public.receipts USING btree (created_at DESC);


--
-- Name: idx_receipts_merchant; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_receipts_merchant ON public.receipts USING btree (merchant_id, created_at DESC);


--
-- Name: idx_refund_audit_payment_created; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_refund_audit_payment_created ON public.refund_audit_events USING btree (payment_id, created_at);


--
-- Name: idx_refund_audit_refund_created; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_refund_audit_refund_created ON public.refund_audit_events USING btree (refund_id, created_at);


--
-- Name: idx_refund_checkpoints_payment; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_refund_checkpoints_payment ON public.refund_checkpoints USING btree (payment_id);


--
-- Name: idx_refund_checkpoints_status_retry; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_refund_checkpoints_status_retry ON public.refund_checkpoints USING btree (status, next_retry_at);


--
-- Name: idx_settlement_checkpoints_stage_updated; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_settlement_checkpoints_stage_updated ON public.settlement_checkpoints USING btree (stage, updated_at);


--
-- Name: idx_settlement_requests_created; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_settlement_requests_created ON public.settlement_requests USING btree (created_at DESC);


--
-- Name: idx_settlement_requests_merchant_status; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_settlement_requests_merchant_status ON public.settlement_requests USING btree (merchant_id, status);


--
-- Name: idx_settlement_requests_status; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_settlement_requests_status ON public.settlement_requests USING btree (status);


--
-- Name: idx_transactions_created; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_transactions_created ON public.transactions USING btree (created_at DESC);


--
-- Name: idx_transactions_merchant_created; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_transactions_merchant_created ON public.transactions USING btree (merchant_id, created_at DESC);


--
-- Name: idx_transactions_payment_id; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_transactions_payment_id ON public.transactions USING btree (payment_id);


--
-- Name: idx_transfers_created; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_transfers_created ON public.transfers USING btree (created_at DESC);


--
-- Name: idx_transfers_merchant_status; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_transfers_merchant_status ON public.transfers USING btree (merchant_id, status);


--
-- Name: idx_transfers_status; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE INDEX idx_transfers_status ON public.transfers USING btree (status);


--
-- Name: r36_certificate_request_identity; Type: INDEX; Schema: public; Owner: r36_owner
--

CREATE UNIQUE INDEX r36_certificate_request_identity ON public.r36_certificate_requests USING btree (((binding ->> 'network'::text)), ((binding ->> 'sourceWallet'::text)), ((binding ->> 'paymentId'::text)), ((binding ->> 'operationKind'::text)), ((binding ->> 'operationId'::text)), ((binding ->> 'preparedHash'::text)), ((binding ->> 'preparedSequence'::text)));


--
-- Name: r36_one_active_ingress_per_wallet; Type: INDEX; Schema: public; Owner: r36_owner
--

CREATE UNIQUE INDEX r36_one_active_ingress_per_wallet ON public.r36_testnet_ingress_reservations USING btree (source_wallet) WHERE (retired_by_payment_id IS NULL);


--
-- Name: uq_settlement_checkpoints_a2u_payment_id; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_settlement_checkpoints_a2u_payment_id ON public.settlement_checkpoints USING btree (a2u_payment_id) WHERE (a2u_payment_id IS NOT NULL);


--
-- Name: uq_settlement_checkpoints_a2u_txid; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_settlement_checkpoints_a2u_txid ON public.settlement_checkpoints USING btree (a2u_txid) WHERE (a2u_txid IS NOT NULL);


--
-- Name: uq_settlement_checkpoints_prepared_tx_hash; Type: INDEX; Schema: public; Owner: neondb_owner
--

CREATE UNIQUE INDEX uq_settlement_checkpoints_prepared_tx_hash ON public.settlement_checkpoints USING btree (prepared_tx_hash) WHERE (prepared_tx_hash IS NOT NULL);


--
-- Name: r36_admission_renewal_receipts immutable; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER immutable BEFORE DELETE OR UPDATE ON public.r36_admission_renewal_receipts FOR EACH ROW EXECUTE FUNCTION public.r36_execution_scope_immutable();


--
-- Name: r36_admission_renewal_requests immutable; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER immutable BEFORE DELETE OR UPDATE ON public.r36_admission_renewal_requests FOR EACH ROW EXECUTE FUNCTION public.r36_execution_scope_immutable();


--
-- Name: r36_admission_renewal_revocations immutable; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER immutable BEFORE DELETE OR UPDATE ON public.r36_admission_renewal_revocations FOR EACH ROW EXECUTE FUNCTION public.r36_execution_scope_immutable();


--
-- Name: r36_bound_renewal_receipts immutable; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER immutable BEFORE DELETE OR UPDATE ON public.r36_bound_renewal_receipts FOR EACH ROW EXECUTE FUNCTION public.r36_execution_scope_immutable();


--
-- Name: r36_admission_renewal_receipts no_truncate; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER no_truncate BEFORE TRUNCATE ON public.r36_admission_renewal_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.r36_execution_scope_immutable();


--
-- Name: r36_admission_renewal_requests no_truncate; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER no_truncate BEFORE TRUNCATE ON public.r36_admission_renewal_requests FOR EACH STATEMENT EXECUTE FUNCTION public.r36_execution_scope_immutable();


--
-- Name: r36_admission_renewal_revocations no_truncate; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER no_truncate BEFORE TRUNCATE ON public.r36_admission_renewal_revocations FOR EACH STATEMENT EXECUTE FUNCTION public.r36_execution_scope_immutable();


--
-- Name: r36_bound_renewal_receipts no_truncate; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER no_truncate BEFORE TRUNCATE ON public.r36_bound_renewal_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.r36_execution_scope_immutable();


--
-- Name: r36_legacy_right_holds r36_held_immutable; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.r36_legacy_right_holds FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: r36_legacy_right_holds r36_held_no_truncate; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_no_truncate BEFORE TRUNCATE ON public.r36_legacy_right_holds FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: financial_pi_mutation_attempts r36_held_truncate; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.financial_pi_mutation_attempts FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: financial_wallet_authorities r36_held_truncate; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.financial_wallet_authorities FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: financial_wallet_authority_history r36_held_truncate; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.financial_wallet_authority_history FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: financial_wallet_finality_seals r36_held_truncate; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.financial_wallet_finality_seals FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: financial_wallet_submission_attempts r36_held_truncate; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.financial_wallet_submission_attempts FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: payment_create_intents r36_held_truncate; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.payment_create_intents FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: r36_certificate_receipts r36_held_truncate; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.r36_certificate_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: r36_certificate_requests r36_held_truncate; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.r36_certificate_requests FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: r36_independent_u2a_attestations r36_held_truncate; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.r36_independent_u2a_attestations FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: r36_prior_closure_receipts r36_held_truncate; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.r36_prior_closure_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: r36_recovery_trial_reservations r36_held_truncate; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.r36_recovery_trial_reservations FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: r36_signed_approval_consumptions r36_held_truncate; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.r36_signed_approval_consumptions FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: r36_testnet_ingress_reservations r36_held_truncate; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.r36_testnet_ingress_reservations FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: receipts r36_held_truncate; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.receipts FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: refund_accounting_records r36_held_truncate; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.refund_accounting_records FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: refund_audit_events r36_held_truncate; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.refund_audit_events FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: refund_automatic_retirements r36_held_truncate; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.refund_automatic_retirements FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: refund_checkpoints r36_held_truncate; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.refund_checkpoints FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: refund_pi_create_attempts r36_held_truncate; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.refund_pi_create_attempts FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: settlement_a2u_ongoing_observations r36_held_truncate; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.settlement_a2u_ongoing_observations FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: settlement_a2u_stage1_retirements r36_held_truncate; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.settlement_a2u_stage1_retirements FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: settlement_checkpoints r36_held_truncate; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.settlement_checkpoints FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: settlement_requests r36_held_truncate; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.settlement_requests FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: settlement_u2a_approval_retirements r36_held_truncate; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.settlement_u2a_approval_retirements FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: transactions r36_held_truncate; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.transactions FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: transfers r36_held_truncate; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON public.transfers FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: financial_pi_mutation_attempts r36_held_write; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.financial_pi_mutation_attempts FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: financial_wallet_authorities r36_held_write; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.financial_wallet_authorities FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: financial_wallet_authority_history r36_held_write; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.financial_wallet_authority_history FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: financial_wallet_finality_seals r36_held_write; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.financial_wallet_finality_seals FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: financial_wallet_submission_attempts r36_held_write; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.financial_wallet_submission_attempts FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: payment_create_intents r36_held_write; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.payment_create_intents FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: r36_certificate_receipts r36_held_write; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.r36_certificate_receipts FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: r36_certificate_requests r36_held_write; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.r36_certificate_requests FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: r36_independent_u2a_attestations r36_held_write; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.r36_independent_u2a_attestations FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: r36_prior_closure_receipts r36_held_write; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.r36_prior_closure_receipts FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: r36_recovery_trial_reservations r36_held_write; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.r36_recovery_trial_reservations FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: r36_signed_approval_consumptions r36_held_write; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.r36_signed_approval_consumptions FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: r36_testnet_ingress_reservations r36_held_write; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.r36_testnet_ingress_reservations FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: receipts r36_held_write; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.receipts FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: refund_accounting_records r36_held_write; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.refund_accounting_records FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: refund_audit_events r36_held_write; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.refund_audit_events FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: refund_automatic_retirements r36_held_write; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.refund_automatic_retirements FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: refund_checkpoints r36_held_write; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.refund_checkpoints FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: refund_pi_create_attempts r36_held_write; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.refund_pi_create_attempts FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: settlement_a2u_ongoing_observations r36_held_write; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.settlement_a2u_ongoing_observations FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: settlement_a2u_stage1_retirements r36_held_write; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.settlement_a2u_stage1_retirements FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: settlement_checkpoints r36_held_write; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.settlement_checkpoints FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: settlement_requests r36_held_write; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.settlement_requests FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: settlement_u2a_approval_retirements r36_held_write; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.settlement_u2a_approval_retirements FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: transactions r36_held_write; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: transfers r36_held_write; Type: TRIGGER; Schema: public; Owner: neondb_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON public.transfers FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: r36_initial_clearance_links r36_initial_clearance_immutable; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_initial_clearance_immutable BEFORE DELETE OR UPDATE ON public.r36_initial_clearance_links FOR EACH ROW EXECUTE FUNCTION public.r36_execution_scope_immutable();


--
-- Name: r36_initial_clearance_links r36_initial_clearance_no_truncate; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_initial_clearance_no_truncate BEFORE TRUNCATE ON public.r36_initial_clearance_links FOR EACH STATEMENT EXECUTE FUNCTION public.r36_execution_scope_immutable();


--
-- Name: r36_certificate_policies r36_policy_immutable; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_policy_immutable BEFORE UPDATE ON public.r36_certificate_policies FOR EACH ROW EXECUTE FUNCTION public.r36_certificate_policy_immutable();


--
-- Name: r36_wallet_execution_scopes r36_scope_immutable; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_scope_immutable BEFORE DELETE OR UPDATE ON public.r36_wallet_execution_scopes FOR EACH ROW EXECUTE FUNCTION public.r36_execution_scope_immutable();


--
-- Name: r36_wallet_execution_scopes r36_scope_no_truncate; Type: TRIGGER; Schema: public; Owner: r36_owner
--

CREATE TRIGGER r36_scope_no_truncate BEFORE TRUNCATE ON public.r36_wallet_execution_scopes FOR EACH STATEMENT EXECUTE FUNCTION public.r36_execution_scope_immutable();


--
-- Name: requests r36_held_truncate; Type: TRIGGER; Schema: r36_signing; Owner: r36_signer_owner
--

CREATE TRIGGER r36_held_truncate BEFORE TRUNCATE ON r36_signing.requests FOR EACH STATEMENT EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: requests r36_held_write; Type: TRIGGER; Schema: r36_signing; Owner: r36_signer_owner
--

CREATE TRIGGER r36_held_write BEFORE INSERT OR DELETE OR UPDATE ON r36_signing.requests FOR EACH ROW EXECUTE FUNCTION public.r36_deny_held_right_write();


--
-- Name: requests signing_request_immutable; Type: TRIGGER; Schema: r36_signing; Owner: r36_signer_owner
--

CREATE TRIGGER signing_request_immutable BEFORE UPDATE ON r36_signing.requests FOR EACH ROW EXECUTE FUNCTION r36_signing.immutable_request();


--
-- Name: dr17_cert_items dr17_cert_items_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.dr17_cert_items
    ADD CONSTRAINT dr17_cert_items_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.dr17_cert_runs(run_id) ON DELETE CASCADE;


--
-- Name: financial_wallet_finality_seals financial_wallet_finality_sea_network_source_wallet_prepar_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.financial_wallet_finality_seals
    ADD CONSTRAINT financial_wallet_finality_sea_network_source_wallet_prepar_fkey FOREIGN KEY (network, source_wallet, prepared_tx_hash) REFERENCES public.financial_wallet_submission_attempts(network, source_wallet, prepared_tx_hash) ON DELETE RESTRICT;


--
-- Name: financial_wallet_rotation_approvals financial_wallet_rotation_app_network_source_wallet_prior__fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.financial_wallet_rotation_approvals
    ADD CONSTRAINT financial_wallet_rotation_app_network_source_wallet_prior__fkey FOREIGN KEY (network, source_wallet, prior_prepared_hash) REFERENCES public.financial_wallet_finality_seals(network, source_wallet, prepared_tx_hash);


--
-- Name: financial_wallet_submission_attempts financial_wallet_submission_attempts_network_source_wallet_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.financial_wallet_submission_attempts
    ADD CONSTRAINT financial_wallet_submission_attempts_network_source_wallet_fkey FOREIGN KEY (network, source_wallet) REFERENCES public.financial_wallet_authorities(network, source_wallet) ON DELETE RESTRICT;


--
-- Name: r36_testnet_ingress_reservations ingress_successor_exists; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_testnet_ingress_reservations
    ADD CONSTRAINT ingress_successor_exists FOREIGN KEY (retired_by_payment_id) REFERENCES public.r36_testnet_ingress_reservations(payment_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: r36_admission_renewal_receipts r36_admission_renewal_receipts_nonce_generation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_admission_renewal_receipts
    ADD CONSTRAINT r36_admission_renewal_receipts_nonce_generation_fkey FOREIGN KEY (nonce, generation) REFERENCES public.r36_admission_renewal_requests(nonce, generation);


--
-- Name: r36_admission_renewal_receipts r36_admission_renewal_receipts_payload_digest_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_admission_renewal_receipts
    ADD CONSTRAINT r36_admission_renewal_receipts_payload_digest_fkey FOREIGN KEY (payload_digest) REFERENCES public.r36_admission_renewal_requests(payload_digest);


--
-- Name: r36_admission_renewal_requests r36_admission_renewal_requests_nonce_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_admission_renewal_requests
    ADD CONSTRAINT r36_admission_renewal_requests_nonce_fkey FOREIGN KEY (nonce) REFERENCES public.r36_certificate_requests(nonce);


--
-- Name: r36_admission_renewal_requests r36_admission_renewal_requests_original_payload_digest_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_admission_renewal_requests
    ADD CONSTRAINT r36_admission_renewal_requests_original_payload_digest_fkey FOREIGN KEY (original_payload_digest) REFERENCES public.r36_certificate_receipts(payload_digest);


--
-- Name: r36_admission_renewal_revocations r36_admission_renewal_revocations_payload_digest_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_admission_renewal_revocations
    ADD CONSTRAINT r36_admission_renewal_revocations_payload_digest_fkey FOREIGN KEY (payload_digest) REFERENCES public.r36_admission_renewal_receipts(payload_digest);


--
-- Name: r36_bound_renewal_receipts r36_bound_renewal_receipts_approval_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_bound_renewal_receipts
    ADD CONSTRAINT r36_bound_renewal_receipts_approval_id_fkey FOREIGN KEY (approval_id) REFERENCES public.r36_lifecycle_approval_links(approval_id);


--
-- Name: r36_bound_renewal_receipts r36_bound_renewal_receipts_closure_digest_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_bound_renewal_receipts
    ADD CONSTRAINT r36_bound_renewal_receipts_closure_digest_fkey FOREIGN KEY (closure_digest) REFERENCES public.r36_prior_closure_receipts(payload_digest);


--
-- Name: r36_bound_renewal_receipts r36_bound_renewal_receipts_successor_nonce_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_bound_renewal_receipts
    ADD CONSTRAINT r36_bound_renewal_receipts_successor_nonce_fkey FOREIGN KEY (successor_nonce) REFERENCES public.r36_certificate_requests(nonce);


--
-- Name: r36_certificate_receipts r36_certificate_receipts_nonce_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_certificate_receipts
    ADD CONSTRAINT r36_certificate_receipts_nonce_fkey FOREIGN KEY (nonce) REFERENCES public.r36_certificate_requests(nonce);


--
-- Name: r36_certificate_requests r36_certificate_requests_policy_digest_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_certificate_requests
    ADD CONSTRAINT r36_certificate_requests_policy_digest_fkey FOREIGN KEY (policy_digest) REFERENCES public.r36_certificate_policies(policy_digest);


--
-- Name: r36_certificate_revocations r36_certificate_revocations_payload_digest_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_certificate_revocations
    ADD CONSTRAINT r36_certificate_revocations_payload_digest_fkey FOREIGN KEY (payload_digest) REFERENCES public.r36_certificate_receipts(payload_digest);


--
-- Name: r36_initial_clearance_links r36_initial_clearance_links_certificate_digest_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_initial_clearance_links
    ADD CONSTRAINT r36_initial_clearance_links_certificate_digest_fkey FOREIGN KEY (certificate_digest) REFERENCES public.r36_certificate_receipts(payload_digest);


--
-- Name: r36_initial_clearance_links r36_initial_clearance_links_nonce_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_initial_clearance_links
    ADD CONSTRAINT r36_initial_clearance_links_nonce_fkey FOREIGN KEY (nonce) REFERENCES public.r36_certificate_receipts(nonce);


--
-- Name: r36_initial_clearance_links r36_initial_clearance_links_policy_digest_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_initial_clearance_links
    ADD CONSTRAINT r36_initial_clearance_links_policy_digest_fkey FOREIGN KEY (policy_digest) REFERENCES public.r36_certificate_policies(policy_digest);


--
-- Name: r36_initial_clearance_links r36_initial_clearance_links_scope_digest_policy_digest_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_initial_clearance_links
    ADD CONSTRAINT r36_initial_clearance_links_scope_digest_policy_digest_fkey FOREIGN KEY (scope_digest, policy_digest) REFERENCES public.r36_wallet_execution_scopes(scope_digest, policy_digest);


--
-- Name: r36_lifecycle_approval_links r36_lifecycle_approval_links_approval_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_lifecycle_approval_links
    ADD CONSTRAINT r36_lifecycle_approval_links_approval_id_fkey FOREIGN KEY (approval_id) REFERENCES public.r36_signed_approval_consumptions(approval_id);


--
-- Name: r36_lifecycle_approval_links r36_lifecycle_approval_links_closure_digest_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_lifecycle_approval_links
    ADD CONSTRAINT r36_lifecycle_approval_links_closure_digest_fkey FOREIGN KEY (closure_digest) REFERENCES public.r36_prior_closure_receipts(payload_digest);


--
-- Name: r36_lifecycle_approval_links r36_lifecycle_approval_links_successor_nonce_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_lifecycle_approval_links
    ADD CONSTRAINT r36_lifecycle_approval_links_successor_nonce_fkey FOREIGN KEY (successor_nonce) REFERENCES public.r36_certificate_requests(nonce);


--
-- Name: r36_payment_intake r36_payment_intake_policy_digest_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_payment_intake
    ADD CONSTRAINT r36_payment_intake_policy_digest_fkey FOREIGN KEY (policy_digest) REFERENCES public.r36_certificate_policies(policy_digest);


--
-- Name: r36_prepared_evidence_candidates r36_prepared_evidence_candidates_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_prepared_evidence_candidates
    ADD CONSTRAINT r36_prepared_evidence_candidates_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.r36_testnet_ingress_reservations(payment_id);


--
-- Name: r36_prior_closure_receipts r36_prior_closure_receipts_policy_digest_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_prior_closure_receipts
    ADD CONSTRAINT r36_prior_closure_receipts_policy_digest_fkey FOREIGN KEY (policy_digest) REFERENCES public.r36_certificate_policies(policy_digest);


--
-- Name: r36_recovery_trial_reservations r36_recovery_trial_reservations_nonce_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_recovery_trial_reservations
    ADD CONSTRAINT r36_recovery_trial_reservations_nonce_fkey FOREIGN KEY (nonce) REFERENCES public.r36_certificate_requests(nonce);


--
-- Name: r36_recovery_trial_reservations r36_recovery_trial_reservations_payload_digest_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_recovery_trial_reservations
    ADD CONSTRAINT r36_recovery_trial_reservations_payload_digest_fkey FOREIGN KEY (payload_digest) REFERENCES public.r36_certificate_receipts(payload_digest);


--
-- Name: r36_rotation_approval_evidence r36_rotation_approval_evidenc_network_source_wallet_prior__fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_rotation_approval_evidence
    ADD CONSTRAINT r36_rotation_approval_evidenc_network_source_wallet_prior__fkey FOREIGN KEY (network, source_wallet, prior_prepared_hash) REFERENCES public.financial_wallet_finality_seals(network, source_wallet, prepared_tx_hash);


--
-- Name: r36_testnet_ingress_reservations r36_testnet_ingress_reservations_policy_digest_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_testnet_ingress_reservations
    ADD CONSTRAINT r36_testnet_ingress_reservations_policy_digest_fkey FOREIGN KEY (policy_digest) REFERENCES public.r36_certificate_policies(policy_digest);


--
-- Name: r36_wallet_execution_scopes r36_wallet_execution_scopes_policy_digest_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_wallet_execution_scopes
    ADD CONSTRAINT r36_wallet_execution_scopes_policy_digest_fkey FOREIGN KEY (policy_digest) REFERENCES public.r36_certificate_policies(policy_digest);


--
-- Name: r36_wallet_successor_requests r36_wallet_successor_requests_approval_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_wallet_successor_requests
    ADD CONSTRAINT r36_wallet_successor_requests_approval_id_fkey FOREIGN KEY (approval_id) REFERENCES public.r36_signed_approval_consumptions(approval_id);


--
-- Name: r36_wallet_successor_requests r36_wallet_successor_requests_successor_nonce_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.r36_wallet_successor_requests
    ADD CONSTRAINT r36_wallet_successor_requests_successor_nonce_fkey FOREIGN KEY (successor_nonce) REFERENCES public.r36_certificate_requests(nonce);


--
-- Name: receipts receipts_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;


--
-- Name: refund_accounting_records refund_accounting_records_refund_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.refund_accounting_records
    ADD CONSTRAINT refund_accounting_records_refund_id_fkey FOREIGN KEY (refund_id) REFERENCES public.refund_checkpoints(refund_id) ON DELETE RESTRICT;


--
-- Name: refund_audit_events refund_audit_events_refund_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.refund_audit_events
    ADD CONSTRAINT refund_audit_events_refund_id_fkey FOREIGN KEY (refund_id) REFERENCES public.refund_checkpoints(refund_id) ON DELETE RESTRICT;


--
-- Name: refund_automatic_retirements refund_automatic_retirements_refund_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.refund_automatic_retirements
    ADD CONSTRAINT refund_automatic_retirements_refund_id_fkey FOREIGN KEY (refund_id) REFERENCES public.refund_checkpoints(refund_id) ON DELETE RESTRICT;


--
-- Name: refund_pi_create_attempts refund_pi_create_attempts_refund_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.refund_pi_create_attempts
    ADD CONSTRAINT refund_pi_create_attempts_refund_id_fkey FOREIGN KEY (refund_id) REFERENCES public.refund_checkpoints(refund_id) ON DELETE RESTRICT;


--
-- Name: refund_rejected_create_attempts refund_rejected_create_attempts_refund_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.refund_rejected_create_attempts
    ADD CONSTRAINT refund_rejected_create_attempts_refund_id_fkey FOREIGN KEY (refund_id) REFERENCES public.refund_rejected_create_authorizations(refund_id);


--
-- Name: refund_rejected_create_authorizations refund_rejected_create_authorizations_refund_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: r36_owner
--

ALTER TABLE ONLY public.refund_rejected_create_authorizations
    ADD CONSTRAINT refund_rejected_create_authorizations_refund_id_fkey FOREIGN KEY (refund_id) REFERENCES public.refund_checkpoints(refund_id);


--
-- Name: settlement_requests settlement_requests_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.settlement_requests
    ADD CONSTRAINT settlement_requests_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;


--
-- Name: transfers transfers_transaction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: neondb_owner
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE CASCADE;


--
-- Name: receipts receipts_idempotency_key_fkey; Type: FK CONSTRAINT; Schema: r36_signing; Owner: r36_signer_owner
--

ALTER TABLE ONLY r36_signing.receipts
    ADD CONSTRAINT receipts_idempotency_key_fkey FOREIGN KEY (idempotency_key) REFERENCES r36_signing.requests(idempotency_key);


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO r36_owner;
GRANT USAGE ON SCHEMA public TO r36_runtime;
GRANT USAGE ON SCHEMA public TO r36_issuer;
GRANT USAGE ON SCHEMA public TO r36_registrar_owner;
GRANT USAGE ON SCHEMA public TO r36_evidence_reader;


--
-- Name: SCHEMA r36_registration; Type: ACL; Schema: -; Owner: r36_registrar_owner
--

GRANT USAGE ON SCHEMA r36_registration TO r36_registrar;


--
-- Name: SCHEMA r36_signing; Type: ACL; Schema: -; Owner: r36_signer_owner
--

GRANT USAGE ON SCHEMA r36_signing TO r36_signer;
GRANT USAGE ON SCHEMA r36_signing TO r36_registrar_owner;


--
-- Name: FUNCTION r36_admission_expiry(p_nonce text, p_original text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_admission_expiry(p_nonce text, p_original text) FROM PUBLIC;


--
-- Name: FUNCTION r36_advance_settlement_prepared(p_payment text, p_merchant text, p_uid text, p_customer numeric, p_merchant_amount numeric, p_a2u text, p_from text, p_to text, p_xdr text, p_hash text, p_seq text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_advance_settlement_prepared(p_payment text, p_merchant text, p_uid text, p_customer numeric, p_merchant_amount numeric, p_a2u text, p_from text, p_to text, p_xdr text, p_hash text, p_seq text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_advance_settlement_prepared(p_payment text, p_merchant text, p_uid text, p_customer numeric, p_merchant_amount numeric, p_a2u text, p_from text, p_to text, p_xdr text, p_hash text, p_seq text) TO r36_runtime;


--
-- Name: FUNCTION r36_bind_initial_clearance(p_nonce text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_bind_initial_clearance(p_nonce text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_bind_initial_clearance(p_nonce text) TO r36_issuer;


--
-- Name: FUNCTION r36_bound_effective_expiry(p_approval text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_bound_effective_expiry(p_approval text) FROM PUBLIC;


--
-- Name: FUNCTION r36_bound_lifecycle_context(p_nonce text, p_closure text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_bound_lifecycle_context(p_nonce text, p_closure text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_bound_lifecycle_context(p_nonce text, p_closure text) TO r36_issuer;


--
-- Name: FUNCTION r36_certificate_allows(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_certificate_allows(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text) FROM PUBLIC;


--
-- Name: FUNCTION r36_certificate_context(p_nonce text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_certificate_context(p_nonce text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_certificate_context(p_nonce text) TO r36_issuer;


--
-- Name: FUNCTION r36_certificate_gate_version(); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_certificate_gate_version() FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_certificate_gate_version() TO r36_runtime;


--
-- Name: FUNCTION r36_certificate_policy_immutable(); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_certificate_policy_immutable() FROM PUBLIC;


--
-- Name: FUNCTION r36_claim_bound_successor(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_claim_bound_successor(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text) FROM PUBLIC;


--
-- Name: FUNCTION r36_claim_first_submission(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_claim_first_submission(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_claim_first_submission(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text) TO r36_runtime;


--
-- Name: FUNCTION r36_claim_prepared_authority(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_claim_prepared_authority(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_claim_prepared_authority(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text) TO r36_runtime;


--
-- Name: FUNCTION r36_claim_rejected_refund_create(p_refund text, p_payment text, p_key text, p_policy text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_claim_rejected_refund_create(p_refund text, p_payment text, p_key text, p_policy text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_claim_rejected_refund_create(p_refund text, p_payment text, p_key text, p_policy text) TO r36_runtime;


--
-- Name: FUNCTION r36_deny_held_right_write(); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_deny_held_right_write() FROM PUBLIC;


--
-- Name: FUNCTION r36_execution_scope_immutable(); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_execution_scope_immutable() FROM PUBLIC;


--
-- Name: FUNCTION r36_general_policy(p jsonb); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_general_policy(p jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_general_policy(p jsonb) TO neondb_owner;


--
-- Name: FUNCTION r36_held_refund_outside_scope(p_wallet text, p_payment text, p_refund text, p_policy text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_held_refund_outside_scope(p_wallet text, p_payment text, p_refund text, p_policy text) FROM PUBLIC;


--
-- Name: TABLE refund_checkpoints; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT ON TABLE public.refund_checkpoints TO r36_owner;
GRANT SELECT ON TABLE public.refund_checkpoints TO r36_runtime;


--
-- Name: COLUMN refund_checkpoints.refund_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(refund_id) ON TABLE public.refund_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN refund_checkpoints.payment_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(payment_id) ON TABLE public.refund_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN refund_checkpoints.idempotency_key; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(idempotency_key) ON TABLE public.refund_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN refund_checkpoints.status; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(status) ON TABLE public.refund_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN refund_checkpoints.stage; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(stage) ON TABLE public.refund_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN refund_checkpoints.payer_uid; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(payer_uid) ON TABLE public.refund_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN refund_checkpoints.payer_uid_verified_at; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(payer_uid_verified_at) ON TABLE public.refund_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN refund_checkpoints.amount; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(amount) ON TABLE public.refund_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN refund_checkpoints.currency; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(currency) ON TABLE public.refund_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN refund_checkpoints.source_payment_status; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(source_payment_status) ON TABLE public.refund_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN refund_checkpoints.source_settlement_state; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(source_settlement_state) ON TABLE public.refund_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN refund_checkpoints.refund_payment_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(refund_payment_id) ON TABLE public.refund_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN refund_checkpoints.refund_txid; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(refund_txid) ON TABLE public.refund_checkpoints TO r36_evidence_reader;


--
-- Name: FUNCTION r36_insert_refund_prepared_audit(p_refund text, p_payment text, p_key text, p_refund_payment text, p_auth_event text, p_prepared_event text, p_started_event text, p_details jsonb); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_insert_refund_prepared_audit(p_refund text, p_payment text, p_key text, p_refund_payment text, p_auth_event text, p_prepared_event text, p_started_event text, p_details jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_insert_refund_prepared_audit(p_refund text, p_payment text, p_key text, p_refund_payment text, p_auth_event text, p_prepared_event text, p_started_event text, p_details jsonb) TO r36_runtime;


--
-- Name: FUNCTION r36_lifecycle_job_receipt(p_kind text, p_policy text, p_wallet text, p_subject text, p_aux text, p_text text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_lifecycle_job_receipt(p_kind text, p_policy text, p_wallet text, p_subject text, p_aux text, p_text text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_lifecycle_job_receipt(p_kind text, p_policy text, p_wallet text, p_subject text, p_aux text, p_text text) TO r36_issuer;


--
-- Name: FUNCTION r36_next_inbound_observation(p_subject text, p_policy text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_next_inbound_observation(p_subject text, p_policy text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_next_inbound_observation(p_subject text, p_policy text) TO r36_runtime;


--
-- Name: FUNCTION r36_next_testnet_preparation(p_subject text, p_policy text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_next_testnet_preparation(p_subject text, p_policy text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_next_testnet_preparation(p_subject text, p_policy text) TO r36_runtime;


--
-- Name: FUNCTION r36_observe_owner_policy(p_policy text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_observe_owner_policy(p_policy text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_observe_owner_policy(p_policy text) TO r36_issuer;


--
-- Name: FUNCTION r36_operation_settings(p_policy text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_operation_settings(p_policy text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_operation_settings(p_policy text) TO r36_runtime;


--
-- Name: FUNCTION r36_policy_max_amount(p jsonb); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_policy_max_amount(p jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_policy_max_amount(p jsonb) TO neondb_owner;


--
-- Name: COLUMN r36_testnet_ingress_reservations.payment_id; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(payment_id) ON TABLE public.r36_testnet_ingress_reservations TO r36_evidence_reader;


--
-- Name: COLUMN r36_testnet_ingress_reservations.policy_digest; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(policy_digest) ON TABLE public.r36_testnet_ingress_reservations TO r36_evidence_reader;


--
-- Name: COLUMN r36_testnet_ingress_reservations.payer_wallet; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(payer_wallet) ON TABLE public.r36_testnet_ingress_reservations TO r36_evidence_reader;


--
-- Name: COLUMN r36_testnet_ingress_reservations.retired_by_payment_id; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(retired_by_payment_id) ON TABLE public.r36_testnet_ingress_reservations TO r36_evidence_reader;


--
-- Name: FUNCTION r36_policy_subject(p jsonb, b public.r36_testnet_ingress_reservations); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_policy_subject(p jsonb, b public.r36_testnet_ingress_reservations) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_policy_subject(p jsonb, b public.r36_testnet_ingress_reservations) TO neondb_owner;


--
-- Name: FUNCTION r36_policy_wallet(p jsonb); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_policy_wallet(p jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_policy_wallet(p jsonb) TO neondb_owner;


--
-- Name: FUNCTION r36_prepare_testnet_ingress(p_action text, p_policy text, p_input jsonb); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_prepare_testnet_ingress(p_action text, p_policy text, p_input jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_prepare_testnet_ingress(p_action text, p_policy text, p_input jsonb) TO r36_runtime;


--
-- Name: FUNCTION r36_prepared_evidence_candidate(p_action text, p_input jsonb); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_prepared_evidence_candidate(p_action text, p_input jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_prepared_evidence_candidate(p_action text, p_input jsonb) TO r36_runtime;


--
-- Name: FUNCTION r36_record_bound_lifecycle(p_nonce text, p_closure text, p_text text, p_digest text, p_issued bigint, p_expires bigint); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_record_bound_lifecycle(p_nonce text, p_closure text, p_text text, p_digest text, p_issued bigint, p_expires bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_record_bound_lifecycle(p_nonce text, p_closure text, p_text text, p_digest text, p_issued bigint, p_expires bigint) TO r36_issuer;


--
-- Name: FUNCTION r36_record_certificate(p_nonce text, p_digest text, p_manifest jsonb, p_signature text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_record_certificate(p_nonce text, p_digest text, p_manifest jsonb, p_signature text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_record_certificate(p_nonce text, p_digest text, p_manifest jsonb, p_signature text) TO r36_issuer;


--
-- Name: FUNCTION r36_record_prior_closure(p_policy text, p_wallet text, p_prior text, p_text text, p_digest text, p_issued bigint, p_expires bigint); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_record_prior_closure(p_policy text, p_wallet text, p_prior text, p_text text, p_digest text, p_issued bigint, p_expires bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_record_prior_closure(p_policy text, p_wallet text, p_prior text, p_text text, p_digest text, p_issued bigint, p_expires bigint) TO r36_issuer;


--
-- Name: FUNCTION r36_record_renewal_receipt(p_nonce text, p_digest text, m jsonb, p_signature text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_record_renewal_receipt(p_nonce text, p_digest text, m jsonb, p_signature text) FROM PUBLIC;


--
-- Name: FUNCTION r36_register_successor_binding(p_nonce text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_register_successor_binding(p_nonce text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_register_successor_binding(p_nonce text) TO r36_issuer;


--
-- Name: FUNCTION r36_renewal_issuer_state(p_nonce text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_renewal_issuer_state(p_nonce text) FROM PUBLIC;


--
-- Name: FUNCTION r36_renewal_registration_state(p_policy text, p_nonce text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_renewal_registration_state(p_policy text, p_nonce text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_renewal_registration_state(p_policy text, p_nonce text) TO r36_registrar_owner;


--
-- Name: FUNCTION r36_renewal_unspent(p_nonce text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_renewal_unspent(p_nonce text) FROM PUBLIC;


--
-- Name: FUNCTION r36_reserve_new_recovery(p_subject text, p_policy text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_reserve_new_recovery(p_subject text, p_policy text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_reserve_new_recovery(p_subject text, p_policy text) TO r36_runtime;


--
-- Name: FUNCTION r36_revoke_certificate(p_digest text, p_reason text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_revoke_certificate(p_digest text, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_revoke_certificate(p_digest text, p_reason text) TO r36_issuer;


--
-- Name: FUNCTION r36_revoke_prior_closure(p_digest text, p_reason text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_revoke_prior_closure(p_digest text, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_revoke_prior_closure(p_digest text, p_reason text) TO r36_issuer;


--
-- Name: FUNCTION r36_select_confirmed_refund_reconciliation(p_subject text, p_policy text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_select_confirmed_refund_reconciliation(p_subject text, p_policy text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_select_confirmed_refund_reconciliation(p_subject text, p_policy text) TO r36_runtime;


--
-- Name: FUNCTION r36_select_confirmed_settlement_reconciliation(p_subject text, p_policy text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_select_confirmed_settlement_reconciliation(p_subject text, p_policy text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_select_confirmed_settlement_reconciliation(p_subject text, p_policy text) TO r36_runtime;


--
-- Name: FUNCTION r36_store_renewal_request(p_policy text, b jsonb, p_digest text, p_issued bigint, p_expires bigint, p_review text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_store_renewal_request(p_policy text, b jsonb, p_digest text, p_issued bigint, p_expires bigint, p_review text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_store_renewal_request(p_policy text, b jsonb, p_digest text, p_issued bigint, p_expires bigint, p_review text) TO r36_registrar_owner;


--
-- Name: FUNCTION r36_terminal_ingress_clearance(p_policy text, p_wallet text, p_prior text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_terminal_ingress_clearance(p_policy text, p_wallet text, p_prior text) FROM PUBLIC;


--
-- Name: FUNCTION r36_terminal_review_context(p_policy text, p_wallet text, p_prior text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_terminal_review_context(p_policy text, p_wallet text, p_prior text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.r36_terminal_review_context(p_policy text, p_wallet text, p_prior text) TO r36_issuer;


--
-- Name: FUNCTION r36_unspent_successor(p_nonce text); Type: ACL; Schema: public; Owner: r36_owner
--

REVOKE ALL ON FUNCTION public.r36_unspent_successor(p_nonce text) FROM PUBLIC;


--
-- Name: FUNCTION context(p_policy text, p_nonce text); Type: ACL; Schema: r36_registration; Owner: r36_registrar_owner
--

REVOKE ALL ON FUNCTION r36_registration.context(p_policy text, p_nonce text) FROM PUBLIC;
GRANT ALL ON FUNCTION r36_registration.context(p_policy text, p_nonce text) TO r36_registrar;


--
-- Name: FUNCTION enroll(p_policy text, b jsonb, p_bytes text, p_digest text, p_issued bigint, p_expires bigint, p_review text); Type: ACL; Schema: r36_registration; Owner: r36_registrar_owner
--

REVOKE ALL ON FUNCTION r36_registration.enroll(p_policy text, b jsonb, p_bytes text, p_digest text, p_issued bigint, p_expires bigint, p_review text) FROM PUBLIC;
GRANT ALL ON FUNCTION r36_registration.enroll(p_policy text, b jsonb, p_bytes text, p_digest text, p_issued bigint, p_expires bigint, p_review text) TO r36_registrar;


--
-- Name: FUNCTION context(k text); Type: ACL; Schema: r36_signing; Owner: r36_signer_owner
--

REVOKE ALL ON FUNCTION r36_signing.context(k text) FROM PUBLIC;
GRANT ALL ON FUNCTION r36_signing.context(k text) TO r36_signer;


--
-- Name: FUNCTION immutable_request(); Type: ACL; Schema: r36_signing; Owner: r36_signer_owner
--

REVOKE ALL ON FUNCTION r36_signing.immutable_request() FROM PUBLIC;


--
-- Name: FUNCTION record(k text, s text); Type: ACL; Schema: r36_signing; Owner: r36_signer_owner
--

REVOKE ALL ON FUNCTION r36_signing.record(k text, s text) FROM PUBLIC;
GRANT ALL ON FUNCTION r36_signing.record(k text, s text) TO r36_signer;


--
-- Name: COLUMN financial_wallet_authorities.network; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(network) ON TABLE public.financial_wallet_authorities TO r36_evidence_reader;


--
-- Name: COLUMN financial_wallet_authorities.source_wallet; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(source_wallet) ON TABLE public.financial_wallet_authorities TO r36_evidence_reader;


--
-- Name: COLUMN financial_wallet_authorities.owner_payment_id; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(owner_payment_id) ON TABLE public.financial_wallet_authorities TO r36_evidence_reader;


--
-- Name: COLUMN financial_wallet_authorities.operation_kind; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(operation_kind) ON TABLE public.financial_wallet_authorities TO r36_evidence_reader;


--
-- Name: COLUMN financial_wallet_authorities.owner_operation_id; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(owner_operation_id) ON TABLE public.financial_wallet_authorities TO r36_evidence_reader;


--
-- Name: COLUMN financial_wallet_authorities.prepared_tx_hash; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(prepared_tx_hash) ON TABLE public.financial_wallet_authorities TO r36_evidence_reader;


--
-- Name: COLUMN financial_wallet_authorities.prepared_sequence; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(prepared_sequence) ON TABLE public.financial_wallet_authorities TO r36_evidence_reader;


--
-- Name: COLUMN financial_wallet_authorities.state; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(state) ON TABLE public.financial_wallet_authorities TO r36_evidence_reader;


--
-- Name: COLUMN financial_wallet_authority_history.network; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(network) ON TABLE public.financial_wallet_authority_history TO r36_evidence_reader;


--
-- Name: COLUMN financial_wallet_authority_history.source_wallet; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(source_wallet) ON TABLE public.financial_wallet_authority_history TO r36_evidence_reader;


--
-- Name: COLUMN financial_wallet_authority_history.owner_payment_id; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(owner_payment_id) ON TABLE public.financial_wallet_authority_history TO r36_evidence_reader;


--
-- Name: COLUMN financial_wallet_authority_history.operation_kind; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(operation_kind) ON TABLE public.financial_wallet_authority_history TO r36_evidence_reader;


--
-- Name: COLUMN financial_wallet_authority_history.owner_operation_id; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(owner_operation_id) ON TABLE public.financial_wallet_authority_history TO r36_evidence_reader;


--
-- Name: COLUMN financial_wallet_authority_history.prepared_tx_hash; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(prepared_tx_hash) ON TABLE public.financial_wallet_authority_history TO r36_evidence_reader;


--
-- Name: COLUMN financial_wallet_authority_history.prepared_sequence; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(prepared_sequence) ON TABLE public.financial_wallet_authority_history TO r36_evidence_reader;


--
-- Name: COLUMN financial_wallet_authority_history.finality_evidence_digest; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(finality_evidence_digest) ON TABLE public.financial_wallet_authority_history TO r36_evidence_reader;


--
-- Name: TABLE financial_wallet_submission_attempts; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT ON TABLE public.financial_wallet_submission_attempts TO r36_evidence_reader;


--
-- Name: COLUMN merchant_balances.merchant_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(merchant_id) ON TABLE public.merchant_balances TO r36_evidence_reader;


--
-- Name: COLUMN merchant_balances.settled; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(settled) ON TABLE public.merchant_balances TO r36_evidence_reader;


--
-- Name: COLUMN merchant_balances.unsettled; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(unsettled) ON TABLE public.merchant_balances TO r36_evidence_reader;


--
-- Name: COLUMN payment_create_intents.merchant_uid; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(merchant_uid) ON TABLE public.payment_create_intents TO r36_owner;
GRANT SELECT(merchant_uid) ON TABLE public.payment_create_intents TO r36_evidence_reader;


--
-- Name: COLUMN payment_create_intents.create_intent_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(create_intent_id) ON TABLE public.payment_create_intents TO r36_owner;


--
-- Name: COLUMN payment_create_intents.payment_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(payment_id) ON TABLE public.payment_create_intents TO r36_owner;
GRANT SELECT(payment_id) ON TABLE public.payment_create_intents TO r36_evidence_reader;


--
-- Name: COLUMN payment_create_intents.merchant_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(merchant_id) ON TABLE public.payment_create_intents TO r36_owner;
GRANT SELECT(merchant_id) ON TABLE public.payment_create_intents TO r36_evidence_reader;


--
-- Name: COLUMN payment_create_intents.customer_amount; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(customer_amount) ON TABLE public.payment_create_intents TO r36_owner;
GRANT SELECT(customer_amount) ON TABLE public.payment_create_intents TO r36_evidence_reader;


--
-- Name: COLUMN payment_create_intents.note; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(note) ON TABLE public.payment_create_intents TO r36_evidence_reader;


--
-- Name: COLUMN payment_create_intents.created_at; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(created_at) ON TABLE public.payment_create_intents TO r36_owner;
GRANT SELECT(created_at) ON TABLE public.payment_create_intents TO r36_evidence_reader;


--
-- Name: TABLE r36_admission_renewal_receipts; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT ON TABLE public.r36_admission_renewal_receipts TO r36_evidence_reader;


--
-- Name: TABLE r36_admission_renewal_requests; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT ON TABLE public.r36_admission_renewal_requests TO r36_evidence_reader;


--
-- Name: TABLE r36_admission_renewal_revocations; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT ON TABLE public.r36_admission_renewal_revocations TO r36_evidence_reader;


--
-- Name: TABLE r36_certificate_policies; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT ON TABLE public.r36_certificate_policies TO r36_registrar_owner;


--
-- Name: COLUMN r36_certificate_policies.policy_digest; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(policy_digest) ON TABLE public.r36_certificate_policies TO r36_evidence_reader;


--
-- Name: COLUMN r36_certificate_policies.enabled; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT UPDATE(enabled) ON TABLE public.r36_certificate_policies TO r36_registrar_owner;
GRANT SELECT(enabled) ON TABLE public.r36_certificate_policies TO r36_evidence_reader;


--
-- Name: COLUMN r36_certificate_policies.revoked; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(revoked) ON TABLE public.r36_certificate_policies TO r36_evidence_reader;


--
-- Name: COLUMN r36_certificate_policies.valid_from; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(valid_from) ON TABLE public.r36_certificate_policies TO r36_evidence_reader;


--
-- Name: COLUMN r36_certificate_policies.valid_until; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(valid_until) ON TABLE public.r36_certificate_policies TO r36_evidence_reader;


--
-- Name: COLUMN r36_certificate_policies.max_age_seconds; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(max_age_seconds) ON TABLE public.r36_certificate_policies TO r36_evidence_reader;


--
-- Name: COLUMN r36_certificate_policies.revocation_checked_at; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(revocation_checked_at) ON TABLE public.r36_certificate_policies TO r36_evidence_reader;


--
-- Name: COLUMN r36_certificate_policies.revocation_valid_until; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(revocation_valid_until) ON TABLE public.r36_certificate_policies TO r36_evidence_reader;


--
-- Name: COLUMN r36_certificate_policies.approval_record_digest; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(approval_record_digest) ON TABLE public.r36_certificate_policies TO r36_evidence_reader;


--
-- Name: COLUMN r36_certificate_policies.worker_profile; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(worker_profile) ON TABLE public.r36_certificate_policies TO r36_evidence_reader;


--
-- Name: TABLE r36_certificate_receipts; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT ON TABLE public.r36_certificate_receipts TO r36_evidence_reader;


--
-- Name: TABLE r36_certificate_requests; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT,INSERT ON TABLE public.r36_certificate_requests TO r36_registrar_owner;
GRANT SELECT ON TABLE public.r36_certificate_requests TO r36_evidence_reader;


--
-- Name: TABLE r36_certificate_revocations; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT ON TABLE public.r36_certificate_revocations TO r36_evidence_reader;


--
-- Name: TABLE r36_independent_u2a_attestations; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT ON TABLE public.r36_independent_u2a_attestations TO r36_runtime;
GRANT SELECT,INSERT ON TABLE public.r36_independent_u2a_attestations TO r36_issuer;


--
-- Name: COLUMN r36_legacy_right_holds.payment_id; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(payment_id) ON TABLE public.r36_legacy_right_holds TO r36_evidence_reader;


--
-- Name: COLUMN r36_legacy_right_holds.network; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(network) ON TABLE public.r36_legacy_right_holds TO r36_evidence_reader;


--
-- Name: COLUMN r36_legacy_right_holds.kind; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(kind) ON TABLE public.r36_legacy_right_holds TO r36_evidence_reader;


--
-- Name: COLUMN r36_legacy_right_holds.original_snapshot_sha256; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(original_snapshot_sha256) ON TABLE public.r36_legacy_right_holds TO r36_evidence_reader;


--
-- Name: COLUMN r36_legacy_right_holds.state; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(state) ON TABLE public.r36_legacy_right_holds TO r36_evidence_reader;


--
-- Name: COLUMN r36_legacy_right_holds.authorizes_new_rights; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(authorizes_new_rights) ON TABLE public.r36_legacy_right_holds TO r36_evidence_reader;


--
-- Name: COLUMN r36_legacy_right_holds.held_at; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT(held_at) ON TABLE public.r36_legacy_right_holds TO r36_evidence_reader;


--
-- Name: TABLE r36_payment_intake; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT ON TABLE public.r36_payment_intake TO r36_evidence_reader;


--
-- Name: TABLE r36_prepared_evidence_candidates; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT ON TABLE public.r36_prepared_evidence_candidates TO r36_evidence_reader;


--
-- Name: TABLE r36_wallet_execution_scopes; Type: ACL; Schema: public; Owner: r36_owner
--

GRANT SELECT ON TABLE public.r36_wallet_execution_scopes TO r36_evidence_reader;


--
-- Name: TABLE receipts; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT ON TABLE public.receipts TO r36_owner;


--
-- Name: COLUMN receipts.id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(id) ON TABLE public.receipts TO r36_evidence_reader;


--
-- Name: COLUMN receipts.transaction_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(transaction_id) ON TABLE public.receipts TO r36_evidence_reader;


--
-- Name: COLUMN receipts.merchant_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(merchant_id) ON TABLE public.receipts TO r36_evidence_reader;


--
-- Name: COLUMN receipts.amount; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(amount) ON TABLE public.receipts TO r36_evidence_reader;


--
-- Name: COLUMN receipts.currency; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(currency) ON TABLE public.receipts TO r36_evidence_reader;


--
-- Name: COLUMN receipts.txid; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(txid) ON TABLE public.receipts TO r36_evidence_reader;


--
-- Name: COLUMN receipts.merchant_uid; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(merchant_uid) ON TABLE public.receipts TO r36_evidence_reader;


--
-- Name: COLUMN receipts.u2a_identifier; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(u2a_identifier) ON TABLE public.receipts TO r36_evidence_reader;


--
-- Name: COLUMN receipts.u2a_txid; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(u2a_txid) ON TABLE public.receipts TO r36_evidence_reader;


--
-- Name: COLUMN receipts.a2u_identifier; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(a2u_identifier) ON TABLE public.receipts TO r36_evidence_reader;


--
-- Name: COLUMN receipts.a2u_txid; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(a2u_txid) ON TABLE public.receipts TO r36_evidence_reader;


--
-- Name: COLUMN receipts.customer_amount; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(customer_amount) ON TABLE public.receipts TO r36_evidence_reader;


--
-- Name: COLUMN receipts.horizon_fee_charged; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(horizon_fee_charged) ON TABLE public.receipts TO r36_evidence_reader;


--
-- Name: COLUMN receipts.app_commission; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(app_commission) ON TABLE public.receipts TO r36_evidence_reader;


--
-- Name: COLUMN receipts.merchant_amount; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(merchant_amount) ON TABLE public.receipts TO r36_evidence_reader;


--
-- Name: COLUMN receipts.app_net_impact; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(app_net_impact) ON TABLE public.receipts TO r36_evidence_reader;


--
-- Name: COLUMN receipts.settlement_status; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(settlement_status) ON TABLE public.receipts TO r36_evidence_reader;


--
-- Name: TABLE refund_accounting_records; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT ON TABLE public.refund_accounting_records TO r36_owner;


--
-- Name: COLUMN refund_accounting_records.refund_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(refund_id) ON TABLE public.refund_accounting_records TO r36_evidence_reader;


--
-- Name: COLUMN refund_accounting_records.payment_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(payment_id) ON TABLE public.refund_accounting_records TO r36_evidence_reader;


--
-- Name: COLUMN refund_accounting_records.refund_payment_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(refund_payment_id) ON TABLE public.refund_accounting_records TO r36_evidence_reader;


--
-- Name: COLUMN refund_accounting_records.refund_txid; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(refund_txid) ON TABLE public.refund_accounting_records TO r36_evidence_reader;


--
-- Name: COLUMN refund_accounting_records.payer_uid; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(payer_uid) ON TABLE public.refund_accounting_records TO r36_evidence_reader;


--
-- Name: COLUMN refund_accounting_records.amount; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(amount) ON TABLE public.refund_accounting_records TO r36_evidence_reader;


--
-- Name: COLUMN refund_accounting_records.horizon_fee_stroops; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(horizon_fee_stroops) ON TABLE public.refund_accounting_records TO r36_evidence_reader;


--
-- Name: COLUMN refund_accounting_records.currency; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(currency) ON TABLE public.refund_accounting_records TO r36_evidence_reader;


--
-- Name: TABLE refund_audit_events; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT,INSERT ON TABLE public.refund_audit_events TO r36_owner;
GRANT SELECT ON TABLE public.refund_audit_events TO r36_runtime;


--
-- Name: COLUMN refund_audit_events.event_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(event_id) ON TABLE public.refund_audit_events TO r36_evidence_reader;


--
-- Name: COLUMN refund_audit_events.refund_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(refund_id) ON TABLE public.refund_audit_events TO r36_evidence_reader;


--
-- Name: COLUMN refund_audit_events.payment_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(payment_id) ON TABLE public.refund_audit_events TO r36_evidence_reader;


--
-- Name: COLUMN refund_audit_events.event_type; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(event_type) ON TABLE public.refund_audit_events TO r36_evidence_reader;


--
-- Name: COLUMN refund_audit_events.actor_type; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(actor_type) ON TABLE public.refund_audit_events TO r36_evidence_reader;


--
-- Name: COLUMN refund_audit_events.idempotency_key; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(idempotency_key) ON TABLE public.refund_audit_events TO r36_evidence_reader;


--
-- Name: COLUMN refund_audit_events.details; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(details) ON TABLE public.refund_audit_events TO r36_evidence_reader;


--
-- Name: COLUMN refund_automatic_retirements.refund_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(refund_id) ON TABLE public.refund_automatic_retirements TO r36_owner;


--
-- Name: COLUMN refund_pi_create_attempts.refund_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(refund_id) ON TABLE public.refund_pi_create_attempts TO r36_owner;


--
-- Name: COLUMN refund_pi_create_attempts.payment_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(payment_id) ON TABLE public.refund_pi_create_attempts TO r36_owner;


--
-- Name: COLUMN refund_pi_create_attempts.idempotency_key; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(idempotency_key) ON TABLE public.refund_pi_create_attempts TO r36_owner;


--
-- Name: COLUMN refund_pi_create_attempts.attempted_at; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(attempted_at) ON TABLE public.refund_pi_create_attempts TO r36_owner;


--
-- Name: TABLE settlement_checkpoints; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT,UPDATE ON TABLE public.settlement_checkpoints TO r36_owner;
GRANT SELECT ON TABLE public.settlement_checkpoints TO r36_runtime;


--
-- Name: COLUMN settlement_checkpoints.payment_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(payment_id) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.stage; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(stage) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.merchant_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(merchant_id) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.merchant_uid; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(merchant_uid) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.customer_amount; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(customer_amount) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.merchant_amount; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(merchant_amount) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.app_commission; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(app_commission) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.u2a_identifier; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(u2a_identifier) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.u2a_txid; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(u2a_txid) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.a2u_payment_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(a2u_payment_id) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.a2u_from_address; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(a2u_from_address) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.a2u_to_address; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(a2u_to_address) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.prepared_envelope_xdr; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(prepared_envelope_xdr) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.prepared_tx_hash; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(prepared_tx_hash) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.prepared_sequence; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(prepared_sequence) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.a2u_txid; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(a2u_txid) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.horizon_fee_stroops; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(horizon_fee_stroops) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.horizon_confirmed_at; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(horizon_confirmed_at) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.pi_completed_at; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(pi_completed_at) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.db_finalized_at; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(db_finalized_at) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.payer_uid; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(payer_uid) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.u2a_verified_at; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(u2a_verified_at) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: COLUMN settlement_checkpoints.u2a_completed_at; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(u2a_completed_at) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;


--
-- Name: TABLE transactions; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT ON TABLE public.transactions TO r36_owner;


--
-- Name: COLUMN transactions.id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(id) ON TABLE public.transactions TO r36_evidence_reader;


--
-- Name: COLUMN transactions.payment_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(payment_id) ON TABLE public.transactions TO r36_evidence_reader;


--
-- Name: COLUMN transactions.merchant_id; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(merchant_id) ON TABLE public.transactions TO r36_evidence_reader;


--
-- Name: COLUMN transactions.amount; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(amount) ON TABLE public.transactions TO r36_evidence_reader;


--
-- Name: COLUMN transactions.currency; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(currency) ON TABLE public.transactions TO r36_evidence_reader;


--
-- Name: COLUMN transactions.reference; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(reference) ON TABLE public.transactions TO r36_evidence_reader;


--
-- Name: COLUMN transactions.status; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(status) ON TABLE public.transactions TO r36_evidence_reader;


--
-- Name: COLUMN transactions.merchant_uid; Type: ACL; Schema: public; Owner: neondb_owner
--

GRANT SELECT(merchant_uid) ON TABLE public.transactions TO r36_evidence_reader;


--
-- Name: TABLE requests; Type: ACL; Schema: r36_signing; Owner: r36_signer_owner
--

GRANT SELECT,INSERT ON TABLE r36_signing.requests TO r36_registrar_owner;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: cloud_admin
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: cloud_admin
--



--
-- PostgreSQL database dump complete
--



ALTER TABLE public.settlement_checkpoints ADD COLUMN IF NOT EXISTS financial_contract jsonb;
ALTER TABLE public.settlement_checkpoints DROP CONSTRAINT IF EXISTS settlement_checkpoints_app_commission_check;
ALTER TABLE public.settlement_checkpoints DROP CONSTRAINT IF EXISTS settlement_checkpoints_check;
ALTER TABLE public.settlement_checkpoints DROP CONSTRAINT IF EXISTS settlement_financial_contract_check;
ALTER TABLE public.settlement_checkpoints ADD CONSTRAINT settlement_financial_contract_check CHECK (public.r36_contract_valid(jsonb_build_object(
 'payment_id',payment_id,'merchant_uid',merchant_uid,'customer_amount',customer_amount,'merchant_amount',merchant_amount,'app_commission',app_commission,'financial_contract',financial_contract)));
DROP TRIGGER IF EXISTS financial_contract_snapshot ON public.settlement_checkpoints;
CREATE TRIGGER financial_contract_snapshot BEFORE INSERT OR UPDATE ON public.settlement_checkpoints FOR EACH ROW EXECUTE FUNCTION public.r36_contract_snapshot_guard();
GRANT SELECT(financial_contract) ON public.settlement_checkpoints TO r36_evidence_reader;
