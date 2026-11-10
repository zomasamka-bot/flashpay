-- Inert until separately reviewed rejection evidence is authorized. No reset.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
SET LOCAL search_path=pg_catalog,pg_temp;
DO $$ BEGIN
 IF current_database()<>'neondb' OR session_user<>'neondb_owner' OR current_user<>session_user
 OR (current_setting('neon.branch_id',true) IS DISTINCT FROM 'br-tiny-mode-aliatv40'
 AND current_setting('flashpay.isolated_certificate_test',true) IS DISTINCT FROM 'yes')
 OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
 OR to_regprocedure('public.r36_next_testnet_preparation(text,text)') IS NULL
 OR to_regclass('public.refund_rejected_create_authorizations') IS NOT NULL
 OR to_regclass('public.refund_rejected_create_attempts') IS NOT NULL
 THEN RAISE EXCEPTION 'REJECTED_REFUND_CREATE_TARGET_NOT_PROVEN'; END IF;
END $$;
GRANT r36_owner TO neondb_owner WITH INHERIT FALSE,SET TRUE;
GRANT CREATE ON SCHEMA public TO r36_owner;
GRANT REFERENCES(refund_id) ON public.refund_checkpoints TO r36_owner;
GRANT SELECT(refund_id) ON public.refund_automatic_retirements TO r36_owner;
GRANT SELECT(refund_id,payment_id,idempotency_key,attempted_at) ON public.refund_pi_create_attempts TO r36_owner;
SET LOCAL ROLE r36_owner;
CREATE TABLE public.refund_rejected_create_authorizations (
 refund_id text PRIMARY KEY REFERENCES public.refund_checkpoints(refund_id),
 payment_id text NOT NULL, idempotency_key text NOT NULL, original_attempted_at timestamp NOT NULL,
 policy_digest text NOT NULL CHECK(policy_digest ~ '^[0-9a-f]{64}$'),
 source_wallet text NOT NULL CHECK(source_wallet ~ '^G[A-Z2-7]{55}$'),
 amount_stroops bigint NOT NULL CHECK(amount_stroops>0 AND amount_stroops<=2000000),
 network text NOT NULL CHECK(network='Pi Testnet'),
 rejection_http_status integer NOT NULL CHECK(rejection_http_status=400),
 rejection_code text NOT NULL CHECK(rejection_code='ongoing_payment_found'),
 conflicting_pi_payment_id text NOT NULL CHECK(length(conflicting_pi_payment_id)>0),
 original_response_sha256 text NOT NULL CHECK(original_response_sha256 ~ '^[0-9a-f]{64}$'),
 cancellation_proof_sha256 text NOT NULL CHECK(cancellation_proof_sha256 ~ '^[0-9a-f]{64}$'),
 review_sha256 text NOT NULL CHECK(review_sha256 ~ '^[0-9a-f]{64}$'),
 authorized_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 CHECK(expires_at>authorized_at AND expires_at<=authorized_at+INTERVAL '6 hours')
);
CREATE TABLE public.refund_rejected_create_attempts (
 refund_id text PRIMARY KEY REFERENCES public.refund_rejected_create_authorizations(refund_id),
 payment_id text NOT NULL, idempotency_key text NOT NULL,
 review_sha256 text NOT NULL CHECK(review_sha256 ~ '^[0-9a-f]{64}$'),
 attempted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.refund_rejected_create_authorizations OWNER TO r36_owner;
ALTER TABLE public.refund_rejected_create_attempts OWNER TO r36_owner;
REVOKE ALL ON public.refund_rejected_create_authorizations,public.refund_rejected_create_attempts FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
CREATE FUNCTION public.r36_claim_rejected_refund_create(p_refund text,p_payment text,p_key text,p_policy text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $function$
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
 OR auth.network<>'Pi Testnet' OR auth.rejection_http_status<>400 OR auth.rejection_code<>'ongoing_payment_found'
 OR clock_timestamp() NOT BETWEEN auth.authorized_at AND auth.expires_at THEN RETURN 'HELD'; END IF;
 SELECT * INTO policy FROM public.r36_certificate_policies WHERE policy_digest=p_policy FOR SHARE;
 IF NOT FOUND OR NOT policy.enabled OR policy.revoked
 OR extract(epoch FROM clock_timestamp()) NOT BETWEEN policy.valid_from AND least(policy.valid_until,policy.revocation_valid_until)-1
 OR policy.worker_profile->'recoveryPilot'->>'schema' IS DISTINCT FROM 'FLASHPAY_TESTNET_NEW_RIGHTS_V1' THEN RETURN 'HELD'; END IF;
 SELECT * INTO reservation FROM public.r36_testnet_ingress_reservations WHERE payment_id=p_payment FOR UPDATE;
 IF NOT FOUND OR reservation.retired_by_payment_id IS NOT NULL
 OR (reservation.policy_digest,reservation.source_wallet,reservation.amount_stroops) IS DISTINCT FROM (p_policy,auth.source_wallet,auth.amount_stroops)
 OR reservation.payer_uid IS NULL OR reservation.payer_wallet IS NULL
 OR NOT EXISTS(SELECT 1 FROM public.financial_wallet_activation WHERE network='Pi Testnet' AND source_wallet=auth.source_wallet AND state='enabled' FOR SHARE) THEN RETURN 'HELD'; END IF;
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
 OR (settlement.payer_uid,settlement.customer_amount*10000000,settlement.merchant_amount*10000000,settlement.app_commission)
 IS DISTINCT FROM (reservation.payer_uid,auth.amount_stroops::numeric,auth.amount_stroops::numeric,0::numeric)
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
END $function$;
ALTER FUNCTION public.r36_claim_rejected_refund_create(text,text,text,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_claim_rejected_refund_create(text,text,text,text) FROM PUBLIC,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
GRANT EXECUTE ON FUNCTION public.r36_claim_rejected_refund_create(text,text,text,text) TO r36_runtime;
RESET ROLE;
REVOKE REFERENCES(refund_id) ON public.refund_checkpoints FROM r36_owner;
REVOKE CREATE ON SCHEMA public FROM r36_owner;
REVOKE r36_owner FROM neondb_owner;
COMMIT;
