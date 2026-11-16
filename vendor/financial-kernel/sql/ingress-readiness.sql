-- Operational demand only. No admission, certificate, wallet or money is changed.
CREATE TABLE IF NOT EXISTS public.r36_ingress_readiness_work (
 policy_digest text NOT NULL REFERENCES public.r36_certificate_policies(policy_digest),
 source_wallet text NOT NULL CHECK (source_wallet ~ '^G[A-Z2-7]{55}$'),
 requested_until timestamptz NOT NULL,
 PRIMARY KEY(policy_digest,source_wallet)
);
ALTER TABLE public.r36_ingress_readiness_work OWNER TO r36_owner;
REVOKE ALL ON public.r36_ingress_readiness_work FROM PUBLIC,r36_runtime,r36_issuer,r36_registrar,r36_signer,r36_evidence_reader;
GRANT SELECT ON public.r36_ingress_readiness_work TO r36_evidence_reader;

CREATE OR REPLACE FUNCTION public.r36_request_ingress_readiness(p_policy text,p_payment text,p_uid text,p_role text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE intake public.r36_payment_intake; policy public.r36_certificate_policies;
BEGIN
 IF session_user<>'r36_runtime' OR current_setting('transaction_isolation')<>'read committed'
 OR p_role IS NULL OR p_uid IS NULL OR p_role NOT IN ('merchant','payer') OR length(p_uid) NOT BETWEEN 1 AND 128 THEN RETURN false; END IF;
 SELECT * INTO policy FROM public.r36_certificate_policies WHERE policy_digest=p_policy;
 IF NOT FOUND OR NOT policy.enabled OR policy.revoked OR NOT public.r36_general_policy(policy.worker_profile)
 -- A wake may be needed to refresh the revocation observation itself. This
 -- operational hint grants no right; issuance and use still require freshness.
 OR extract(epoch FROM clock_timestamp()) NOT BETWEEN policy.valid_from AND policy.valid_until-1 THEN RETURN false; END IF;
 SELECT * INTO intake FROM public.r36_payment_intake WHERE policy_digest=p_policy AND payment_id=p_payment;
 IF NOT FOUND OR intake.source_wallet IS DISTINCT FROM public.r36_policy_wallet(policy.worker_profile)
 OR (p_role='merchant' AND intake.merchant_uid IS DISTINCT FROM p_uid)
 OR (p_role='payer' AND intake.payer_uid IS NOT NULL AND intake.payer_uid IS DISTINCT FROM p_uid)
 OR intake.payer_pi_payment_id IS NOT NULL THEN RETURN false; END IF;
 INSERT INTO public.r36_ingress_readiness_work(policy_digest,source_wallet,requested_until)
 VALUES(p_policy,intake.source_wallet,clock_timestamp()+interval '60 seconds')
 ON CONFLICT(policy_digest,source_wallet) DO UPDATE SET requested_until=EXCLUDED.requested_until;
 RETURN true;
END $body$;
ALTER FUNCTION public.r36_request_ingress_readiness(text,text,text,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_request_ingress_readiness(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r36_request_ingress_readiness(text,text,text,text) TO r36_runtime;

-- A scheduling observation only. The original runtime clearance still checks
-- the seal, accounting, current policy/revocation and exact receipt at use.
CREATE OR REPLACE FUNCTION public.r36_current_prior_observation(p_policy text,p_wallet text,p_payment text,p_context text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE c jsonb;
BEGIN
 IF session_user<>'r36_issuer' OR current_setting('transaction_isolation')<>'read committed' THEN RETURN false; END IF;
 c:=public.r36_terminal_review_context(p_policy,p_wallet,p_payment);
 IF c IS NULL OR c->>'contextDigest' IS DISTINCT FROM p_context THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM public.r36_prior_closure_receipts r
  JOIN public.financial_wallet_finality_seals s ON s.network=r.network AND s.source_wallet=r.source_wallet AND s.prepared_tx_hash=r.prior_hash
  WHERE r.policy_digest=p_policy AND r.network=public.r36_network() AND r.source_wallet=p_wallet AND r.prior_payment=p_payment
  AND r.context_digest=p_context AND r.evidence_digest=s.evidence_digest AND NOT r.revoked
  AND r.issued_at>=floor(extract(epoch FROM s.sealed_at)) AND r.issued_at<=extract(epoch FROM clock_timestamp())
  AND r.expires_at>extract(epoch FROM clock_timestamp())+10);
END $body$;
ALTER FUNCTION public.r36_current_prior_observation(text,text,text,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_current_prior_observation(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r36_current_prior_observation(text,text,text,text) TO r36_issuer;
