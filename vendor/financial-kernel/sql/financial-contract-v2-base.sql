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
