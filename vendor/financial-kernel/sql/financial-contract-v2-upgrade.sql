BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
GRANT r36_owner,r36_registrar_owner TO neondb_owner WITH INHERIT TRUE, SET TRUE; GRANT CREATE ON SCHEMA public TO r36_owner;
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

ALTER TABLE public.settlement_checkpoints ADD COLUMN IF NOT EXISTS financial_contract jsonb;
ALTER TABLE public.settlement_checkpoints DROP CONSTRAINT IF EXISTS settlement_checkpoints_app_commission_check;
ALTER TABLE public.settlement_checkpoints DROP CONSTRAINT IF EXISTS settlement_checkpoints_check;
ALTER TABLE public.settlement_checkpoints DROP CONSTRAINT IF EXISTS settlement_financial_contract_check;
ALTER TABLE public.settlement_checkpoints ADD CONSTRAINT settlement_financial_contract_check CHECK (public.r36_contract_valid(jsonb_build_object(
 'payment_id',payment_id,'merchant_uid',merchant_uid,'customer_amount',customer_amount,'merchant_amount',merchant_amount,'app_commission',app_commission,'financial_contract',financial_contract)));
DROP TRIGGER IF EXISTS financial_contract_snapshot ON public.settlement_checkpoints;
CREATE TRIGGER financial_contract_snapshot BEFORE INSERT OR UPDATE ON public.settlement_checkpoints FOR EACH ROW EXECUTE FUNCTION public.r36_contract_snapshot_guard();
GRANT SELECT(financial_contract) ON public.settlement_checkpoints TO r36_evidence_reader;

CREATE OR REPLACE FUNCTION public.r36_advance_settlement_prepared(p_payment text, p_merchant text, p_uid text, p_customer numeric, p_merchant_amount numeric, p_a2u text, p_from text, p_to text, p_xdr text, p_hash text, p_seq text) RETURNS TABLE(version bigint, stage text, advanced boolean)
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

CREATE OR REPLACE FUNCTION public.r36_bind_initial_clearance(p_nonce text) RETURNS text
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

CREATE OR REPLACE FUNCTION public.r36_bound_lifecycle_context(p_nonce text, p_closure text) RETURNS jsonb
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

CREATE OR REPLACE FUNCTION public.r36_certificate_allows(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text) RETURNS boolean
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

CREATE OR REPLACE FUNCTION public.r36_certificate_gate_version() RETURNS integer
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog'
    AS $$SELECT 1$$;


ALTER FUNCTION public.r36_certificate_gate_version() OWNER TO r36_owner;

CREATE OR REPLACE FUNCTION public.r36_claim_bound_successor(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text) RETURNS boolean
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

CREATE OR REPLACE FUNCTION public.r36_claim_first_submission(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text) RETURNS boolean
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

CREATE OR REPLACE FUNCTION public.r36_claim_prepared_authority(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text) RETURNS boolean
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

CREATE OR REPLACE FUNCTION public.r36_claim_rejected_refund_create(p_refund text, p_payment text, p_key text, p_policy text) RETURNS text
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

CREATE OR REPLACE FUNCTION public.r36_general_policy(p jsonb) RETURNS boolean
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

CREATE OR REPLACE FUNCTION public.r36_held_refund_outside_scope(p_wallet text, p_payment text, p_refund text, p_policy text) RETURNS boolean
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
 SELECT jsonb_build_object('settlements',coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY payment_id)
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

CREATE OR REPLACE FUNCTION public.r36_next_inbound_observation(p_subject text, p_policy text) RETURNS jsonb
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

CREATE OR REPLACE FUNCTION public.r36_next_testnet_preparation(p_subject text, p_policy text) RETURNS jsonb
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

CREATE OR REPLACE FUNCTION public.r36_operation_settings(p_policy text) RETURNS jsonb
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

CREATE OR REPLACE FUNCTION public.r36_policy_max_amount(p jsonb) RETURNS bigint
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
 SELECT CASE WHEN public.r36_general_policy(p) THEN (p->'generalOperation'->>'maxAmountStroops')::bigint
 WHEN public.r36_network()='Pi Testnet' AND p->'recoveryPilot'->>'schema'='FLASHPAY_TESTNET_NEW_RIGHTS_V1' AND NOT(p ? 'generalOperation') THEN 2000000 ELSE 0 END
$$;


ALTER FUNCTION public.r36_policy_max_amount(p jsonb) OWNER TO r36_owner;

CREATE OR REPLACE FUNCTION public.r36_policy_subject(p jsonb, b public.r36_testnet_ingress_reservations) RETURNS boolean
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

CREATE OR REPLACE FUNCTION public.r36_policy_wallet(p jsonb) RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
 SELECT CASE WHEN public.r36_general_policy(p) THEN p->'generalOperation'->>'sourceWallet' ELSE p->'recoveryPilot'->'ingress'->>'sourceWallet' END
$$;


ALTER FUNCTION public.r36_policy_wallet(p jsonb) OWNER TO r36_owner;

CREATE OR REPLACE FUNCTION public.r36_prepare_testnet_ingress(p_action text, p_policy text, p_input jsonb) RETURNS jsonb
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

CREATE OR REPLACE FUNCTION public.r36_prepared_evidence_candidate(p_action text, p_input jsonb) RETURNS jsonb
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

CREATE OR REPLACE FUNCTION public.r36_record_bound_lifecycle(p_nonce text, p_closure text, p_text text, p_digest text, p_issued bigint, p_expires bigint) RETURNS text
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

CREATE OR REPLACE FUNCTION public.r36_record_prior_closure(p_policy text, p_wallet text, p_prior text, p_text text, p_digest text, p_issued bigint, p_expires bigint) RETURNS text
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

CREATE OR REPLACE FUNCTION public.r36_register_successor_binding(p_nonce text) RETURNS text
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

CREATE OR REPLACE FUNCTION public.r36_renewal_unspent(p_nonce text) RETURNS boolean
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

CREATE OR REPLACE FUNCTION public.r36_reserve_new_recovery(p_subject text, p_policy text) RETURNS jsonb
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

CREATE OR REPLACE FUNCTION public.r36_select_confirmed_refund_reconciliation(p_subject text, p_policy text) RETURNS jsonb
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

CREATE OR REPLACE FUNCTION public.r36_select_confirmed_settlement_reconciliation(p_subject text, p_policy text) RETURNS jsonb
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

CREATE OR REPLACE FUNCTION public.r36_terminal_ingress_clearance(p_policy text, p_wallet text, p_prior text) RETURNS boolean
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

CREATE OR REPLACE FUNCTION public.r36_terminal_review_context(p_policy text, p_wallet text, p_prior text) RETURNS jsonb
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

CREATE OR REPLACE FUNCTION public.r36_unspent_successor(p_nonce text) RETURNS boolean
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

CREATE OR REPLACE FUNCTION r36_registration.enroll(p_policy text, b jsonb, p_bytes text, p_digest text, p_issued bigint, p_expires bigint, p_review text) RETURNS text
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

ALTER TABLE public.financial_wallet_activation DROP CONSTRAINT IF EXISTS financial_wallet_activation_network_check;
ALTER TABLE public.financial_wallet_activation ADD CONSTRAINT financial_wallet_activation_network_check CHECK ((network = public.r36_network()::text));
ALTER TABLE public.financial_wallet_authorities DROP CONSTRAINT IF EXISTS financial_wallet_authorities_network_check;
ALTER TABLE public.financial_wallet_authorities ADD CONSTRAINT financial_wallet_authorities_network_check CHECK ((network = public.r36_network()::text));
ALTER TABLE public.financial_wallet_finality_seals DROP CONSTRAINT IF EXISTS financial_wallet_finality_seals_network_check;
ALTER TABLE public.financial_wallet_finality_seals ADD CONSTRAINT financial_wallet_finality_seals_network_check CHECK ((network = public.r36_network()::text));
ALTER TABLE public.financial_wallet_submission_attempts DROP CONSTRAINT IF EXISTS financial_wallet_submission_attempts_network_check;
ALTER TABLE public.financial_wallet_submission_attempts ADD CONSTRAINT financial_wallet_submission_attempts_network_check CHECK ((network = public.r36_network()::text));
ALTER TABLE public.r36_certificate_requests DROP CONSTRAINT IF EXISTS r36_certificate_requests_check;
ALTER TABLE public.r36_certificate_requests ADD CONSTRAINT r36_certificate_requests_check CHECK (((jsonb_typeof(binding) = 'object'::text) AND ((binding ->> 'nonce'::text) = nonce) AND ((binding ->> 'network'::text) = public.r36_network()::text)));
ALTER TABLE public.r36_independent_u2a_attestations DROP CONSTRAINT IF EXISTS r36_independent_u2a_attestations_network_check;
ALTER TABLE public.r36_independent_u2a_attestations ADD CONSTRAINT r36_independent_u2a_attestations_network_check CHECK ((network = public.r36_network()::text));
ALTER TABLE public.r36_initial_clearance_links DROP CONSTRAINT IF EXISTS r36_initial_clearance_links_network_check;
ALTER TABLE public.r36_initial_clearance_links ADD CONSTRAINT r36_initial_clearance_links_network_check CHECK ((network = public.r36_network()::text));
ALTER TABLE public.r36_legacy_right_holds DROP CONSTRAINT IF EXISTS r36_legacy_right_holds_network_check;
ALTER TABLE public.r36_legacy_right_holds ADD CONSTRAINT r36_legacy_right_holds_network_check CHECK ((network = public.r36_network()::text));
ALTER TABLE public.r36_prepared_evidence_candidates DROP CONSTRAINT IF EXISTS r36_prepared_evidence_candidates_network_check;
ALTER TABLE public.r36_prepared_evidence_candidates ADD CONSTRAINT r36_prepared_evidence_candidates_network_check CHECK ((network = public.r36_network()::text));
ALTER TABLE public.r36_prior_closure_receipts DROP CONSTRAINT IF EXISTS r36_prior_closure_receipts_network_check;
ALTER TABLE public.r36_prior_closure_receipts ADD CONSTRAINT r36_prior_closure_receipts_network_check CHECK ((network = public.r36_network()::text));
ALTER TABLE public.r36_rotation_approval_evidence DROP CONSTRAINT IF EXISTS r36_rotation_approval_evidence_network_check;
ALTER TABLE public.r36_rotation_approval_evidence ADD CONSTRAINT r36_rotation_approval_evidence_network_check CHECK ((network = public.r36_network()::text));
ALTER TABLE public.r36_signed_approval_consumptions DROP CONSTRAINT IF EXISTS r36_signed_approval_consumptions_network_check;
ALTER TABLE public.r36_signed_approval_consumptions ADD CONSTRAINT r36_signed_approval_consumptions_network_check CHECK ((network = public.r36_network()::text));
ALTER TABLE public.r36_wallet_execution_scopes DROP CONSTRAINT IF EXISTS r36_wallet_execution_scopes_scope_text_check1;
ALTER TABLE public.r36_wallet_execution_scopes ADD CONSTRAINT r36_wallet_execution_scopes_scope_text_check1 CHECK ((((scope_text)::jsonb ->> 'schema'::text) IN ('R36_NEW_WALLET_EXECUTION_SCOPE_V1','R36_CLEAN_NETWORK_EXECUTION_SCOPE_V2')));
ALTER TABLE public.r36_wallet_execution_scopes DROP CONSTRAINT IF EXISTS r36_wallet_execution_scopes_scope_text_check2;
ALTER TABLE public.r36_wallet_execution_scopes ADD CONSTRAINT r36_wallet_execution_scopes_scope_text_check2 CHECK ((NOT (((scope_text)::jsonb ->> 'network'::text) IS DISTINCT FROM public.r36_network()::text)));
ALTER TABLE public.refund_rejected_create_authorizations DROP CONSTRAINT IF EXISTS refund_rejected_create_authorizations_network_check;
ALTER TABLE public.refund_rejected_create_authorizations ADD CONSTRAINT refund_rejected_create_authorizations_network_check CHECK ((network = public.r36_network()::text));
REVOKE CREATE ON SCHEMA public FROM r36_owner; REVOKE r36_owner,r36_registrar_owner FROM neondb_owner;
COMMIT;
