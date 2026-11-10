-- NOT_FOR_DEPLOY until isolated qualification. No policy activation or enrollment.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
SET LOCAL search_path=pg_catalog,pg_temp;
DO $$ BEGIN
 IF current_database()<>'neondb' OR session_user<>'neondb_owner' OR current_user<>session_user OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999 THEN RAISE EXCEPTION 'GENERAL_TARGET_MISMATCH'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.r36_prepare_testnet_ingress(text,text,jsonb)')) IS DISTINCT FROM '5b979f4dc3a4a62241d29882729b46ec7d0ea537ca40ea054bd7130d519ba846' THEN RAISE EXCEPTION 'GENERAL_BASELINE_MISMATCH: r36_prepare_testnet_ingress'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.r36_reserve_new_recovery(text,text)')) IS DISTINCT FROM '0a75893ea5a25e8c24ec5bc2fdf61f77e3bbfd86c4bd732e51507046f8c292ed' THEN RAISE EXCEPTION 'GENERAL_BASELINE_MISMATCH: r36_reserve_new_recovery'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.r36_select_confirmed_settlement_reconciliation(text,text)')) IS DISTINCT FROM '62312005a150ba09eddfa3bce461b1fbb7d1e47ba9def3e1959342df10e883a8' THEN RAISE EXCEPTION 'GENERAL_BASELINE_MISMATCH: r36_select_confirmed_settlement_reconciliation'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.r36_select_confirmed_refund_reconciliation(text,text)')) IS DISTINCT FROM '6613c1b34c21573d21c40c8638e53874c90f67c29a59f999b5f48c176ea10623' THEN RAISE EXCEPTION 'GENERAL_BASELINE_MISMATCH: r36_select_confirmed_refund_reconciliation'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.r36_next_testnet_preparation(text,text)')) IS DISTINCT FROM '3053698a65131feb1a19e646a0600eb066edf3a2e8e481e1c260fee8753dbbcc' THEN RAISE EXCEPTION 'GENERAL_BASELINE_MISMATCH: r36_next_testnet_preparation'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.r36_prepared_evidence_candidate(text,jsonb)')) IS DISTINCT FROM '3f2633f6895c68120c70e4e18b4c4efc141f3cbc3921ab4236c09e873959ff66' THEN RAISE EXCEPTION 'GENERAL_BASELINE_MISMATCH: r36_prepared_evidence_candidate'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.r36_terminal_review_context(text,text,text)')) IS DISTINCT FROM 'a9e4599bd1eabbecb94ba866f2b7f76346fcd7c6807a12c4ce65783aa6f9789e' THEN RAISE EXCEPTION 'GENERAL_BASELINE_MISMATCH: r36_terminal_review_context'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.r36_terminal_ingress_clearance(text,text,text)')) IS DISTINCT FROM 'e41f5d38472fb0230ddd544b73076513fafddb50ab53ef1b77b5605bad3b1376' THEN RAISE EXCEPTION 'GENERAL_BASELINE_MISMATCH: r36_terminal_ingress_clearance'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.r36_held_refund_outside_scope(text,text,text,text)')) IS DISTINCT FROM 'b5de000cb92972511ca257b586cc4b7e305a75e41d9144efa33503c2bbf01dd8' THEN RAISE EXCEPTION 'GENERAL_BASELINE_MISMATCH: r36_held_refund_outside_scope'; END IF;
END $$;
GRANT r36_owner TO neondb_owner WITH INHERIT FALSE,SET TRUE;
GRANT CREATE ON SCHEMA public TO r36_owner;
SET LOCAL ROLE r36_owner;

CREATE TABLE public.r36_payment_intake (
 payment_id text PRIMARY KEY CHECK(payment_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 policy_digest text NOT NULL REFERENCES public.r36_certificate_policies(policy_digest),
 source_wallet text NOT NULL CHECK(source_wallet ~ '^G[A-Z2-7]{55}$'),
 merchant_uid text NOT NULL CHECK(length(merchant_uid) BETWEEN 1 AND 128),
 merchant_id text NOT NULL CHECK(length(merchant_id) BETWEEN 1 AND 128),
 merchant_wallet text NOT NULL CHECK(merchant_wallet ~ '^G[A-Z2-7]{55}$'),
 create_intent_id uuid NOT NULL, note_digest text NOT NULL CHECK(note_digest ~ '^[0-9a-f]{64}$'),
 amount_stroops bigint NOT NULL CHECK(amount_stroops BETWEEN 1 AND 10000000000000),
 identity_source text NOT NULL CHECK(identity_source='PI_V2_ME'),
 identity_verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 payer_uid text, payer_wallet text, payer_verified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(merchant_uid,create_intent_id),
 CHECK((payer_uid IS NULL AND payer_wallet IS NULL AND payer_verified_at IS NULL) OR
       (length(payer_uid) BETWEEN 1 AND 128 AND payer_wallet ~ '^G[A-Z2-7]{55}$' AND payer_verified_at IS NOT NULL))
);
ALTER TABLE public.r36_payment_intake OWNER TO r36_owner;
REVOKE ALL ON public.r36_payment_intake FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar;
GRANT SELECT ON public.r36_payment_intake TO r36_evidence_reader;
-- A policy is immutable and enrolled by the original protected mechanism.
-- An environment flag cannot enroll users, modify a policy or grant financial authority.
CREATE FUNCTION public.r36_general_policy(p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce(p->'generalOperation'->>'schema'='R36_GENERAL_TESTNET_V1'
 AND p->'generalOperation'->>'network'='Pi Testnet'
 AND p->'generalOperation'->>'identitySource'='PI_V2_ME'
 AND p->'generalOperation'->>'sourceWallet' ~ '^G[A-Z2-7]{55}$'
 AND p->'generalOperation'->>'maxAmountStroops' ~ '^[1-9][0-9]{0,13}$'
 AND CASE WHEN p->'generalOperation'->>'maxAmountStroops' ~ '^[1-9][0-9]{0,13}$'
   THEN (p->'generalOperation'->>'maxAmountStroops')::numeric BETWEEN 1 AND 10000000000000 ELSE false END
 AND p->'generalOperation'->'allowTerminalReservationTurnover'='true'::jsonb
 AND NOT(p ? 'recoveryPilot'),false)
$$;
CREATE FUNCTION public.r36_policy_wallet(p jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN public.r36_general_policy(p) THEN p->'generalOperation'->>'sourceWallet' ELSE p->'recoveryPilot'->'ingress'->>'sourceWallet' END
$$;
CREATE FUNCTION public.r36_policy_max_amount(p jsonb) RETURNS bigint LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN public.r36_general_policy(p) THEN (p->'generalOperation'->>'maxAmountStroops')::bigint
 WHEN p->'recoveryPilot'->>'schema'='FLASHPAY_TESTNET_NEW_RIGHTS_V1' AND NOT(p ? 'generalOperation') THEN 2000000 ELSE 0 END
$$;
CREATE FUNCTION public.r36_policy_subject(p jsonb,b public.r36_testnet_ingress_reservations) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce(b.source_wallet=public.r36_policy_wallet(p) AND b.amount_stroops BETWEEN 1 AND public.r36_policy_max_amount(p)
 AND CASE WHEN public.r36_general_policy(p) THEN EXISTS(SELECT 1 FROM public.r36_payment_intake i
 WHERE (i.payment_id,i.policy_digest,i.source_wallet,i.merchant_uid,i.merchant_id,i.merchant_wallet,i.create_intent_id,i.note_digest,i.amount_stroops,i.payer_uid,i.payer_wallet)
 = (b.payment_id,b.policy_digest,b.source_wallet,b.merchant_uid,b.merchant_id,b.merchant_wallet,b.create_intent_id,b.note_digest,b.amount_stroops,b.payer_uid,b.payer_wallet)
 AND i.identity_source='PI_V2_ME' AND i.identity_verified_at<=statement_timestamp() AND i.payer_verified_at<=statement_timestamp())
 ELSE p->'recoveryPilot'->>'schema'='FLASHPAY_TESTNET_NEW_RIGHTS_V1' AND NOT(p ? 'generalOperation')
 AND p->'recoveryPilot'->'wallets' @> jsonb_build_array(b.source_wallet,b.merchant_wallet,b.payer_wallet)
 AND p->'recoveryPilot'->'payerUids' @> jsonb_build_array(b.payer_uid)
 AND p->'recoveryPilot'->'ingress'->'merchants' @> jsonb_build_array(jsonb_build_object('uid',b.merchant_uid,'username',b.merchant_id,'wallet',b.merchant_wallet))
 AND p->'recoveryPilot'->'ingress'->'payers' @> jsonb_build_array(jsonb_build_object('uid',b.payer_uid,'wallet',b.payer_wallet)) END,false)
$$;
CREATE FUNCTION public.r36_operation_settings(p_policy text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE p public.r36_certificate_policies; BEGIN
 IF session_user<>'r36_runtime' THEN RETURN NULL; END IF;
 SELECT * INTO p FROM public.r36_certificate_policies WHERE policy_digest=p_policy;
 IF NOT FOUND OR NOT p.enabled OR p.revoked OR extract(epoch FROM clock_timestamp()) NOT BETWEEN p.valid_from AND least(p.valid_until,p.revocation_valid_until)-1
 OR public.r36_policy_max_amount(p.worker_profile)=0
 OR NOT EXISTS(SELECT 1 FROM public.financial_wallet_activation WHERE network='Pi Testnet' AND source_wallet=public.r36_policy_wallet(p.worker_profile) AND state='enabled') THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('mode',CASE WHEN public.r36_general_policy(p.worker_profile) THEN 'general' ELSE 'pilot' END,'maxAmountStroops',public.r36_policy_max_amount(p.worker_profile)::text);
END $$;

ALTER TABLE public.r36_testnet_ingress_reservations DROP CONSTRAINT r36_testnet_ingress_reservations_amount_stroops_check;
ALTER TABLE public.r36_testnet_ingress_reservations ADD CONSTRAINT r36_testnet_ingress_reservations_amount_stroops_check CHECK(amount_stroops BETWEEN 1 AND 10000000000000);
ALTER TABLE public.r36_recovery_trial_reservations DROP CONSTRAINT r36_recovery_trial_reservations_amount_stroops_check;
ALTER TABLE public.r36_recovery_trial_reservations ADD CONSTRAINT r36_recovery_trial_reservations_amount_stroops_check CHECK(amount_stroops BETWEEN 1 AND 10000000000000);
CREATE OR REPLACE FUNCTION public.r36_prepare_testnet_ingress(p_action text, p_policy text, p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE policy public.r36_certificate_policies; pilot jsonb; config jsonb; person jsonb;
 stored public.r36_testnet_ingress_reservations; total numeric; wallet text; value bigint; prior_id text; general boolean; intake public.r36_payment_intake; admit jsonb;
BEGIN
 IF session_user<>'r36_runtime' OR current_setting('transaction_isolation')<>'read committed'
 OR p_action IS NULL OR p_action NOT IN ('reserve','bind','verify','prepared','approval') OR p_policy IS NULL OR p_policy !~ '^[0-9a-f]{64}$'
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
     WHERE network='Pi Testnet' AND source_wallet=wallet AND state='enabled'
     AND clearance_digest ~ '^[0-9a-f]{64}$' FOR SHARE) THEN RETURN NULL; END IF;

 -- Intake does not acquire wallet authority or authorize any Pi payment.
 IF general AND p_action='reserve' THEN
  IF coalesce(p_input->>'paymentId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR coalesce(p_input->>'createIntentId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  OR coalesce(p_input->>'merchantUid','') !~ '^[A-Za-z0-9_.:-]{1,128}$'
  OR coalesce(p_input->>'merchantId','') !~ '^[A-Za-z0-9_.:-]{1,128}$'
  OR coalesce(p_input->>'merchantWallet','') !~ '^G[A-Z2-7]{55}$'
  OR coalesce(p_input->>'amountStroops','') !~ '^[1-9][0-9]{0,13}$'
  OR coalesce(p_input->>'noteDigest','') !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
  value:=(p_input->>'amountStroops')::bigint;
  IF value>public.r36_policy_max_amount(policy.worker_profile) THEN RETURN NULL; END IF;
  SELECT * INTO intake FROM public.r36_payment_intake WHERE merchant_uid=p_input->>'merchantUid' AND create_intent_id=(p_input->>'createIntentId')::uuid;
  IF FOUND THEN
   IF (intake.policy_digest,intake.merchant_id,intake.merchant_wallet,intake.note_digest,intake.amount_stroops)
   IS DISTINCT FROM(p_policy,p_input->>'merchantId',p_input->>'merchantWallet',p_input->>'noteDigest',value) THEN RETURN NULL; END IF;
   RETURN jsonb_build_object('paymentId',intake.payment_id,'phase','request_only');
  END IF;
  INSERT INTO public.r36_payment_intake(payment_id,policy_digest,source_wallet,merchant_uid,merchant_id,merchant_wallet,create_intent_id,note_digest,amount_stroops,identity_source)
  VALUES(p_input->>'paymentId',p_policy,wallet,p_input->>'merchantUid',p_input->>'merchantId',p_input->>'merchantWallet',(p_input->>'createIntentId')::uuid,p_input->>'noteDigest',value,'PI_V2_ME');
  RETURN jsonb_build_object('paymentId',p_input->>'paymentId','phase','request_only');
 END IF;
 IF general AND p_action='bind' THEN
  IF coalesce(p_input->>'payerUid','') !~ '^[A-Za-z0-9_.:-]{1,128}$' OR coalesce(p_input->>'payerWallet','') !~ '^G[A-Z2-7]{55}$' THEN RETURN NULL; END IF;
  SELECT * INTO intake FROM public.r36_payment_intake WHERE payment_id=p_input->>'paymentId' AND policy_digest=p_policy FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.payment_create_intents i WHERE i.payment_id=intake.payment_id AND i.merchant_uid=intake.merchant_uid AND i.merchant_id=intake.merchant_id AND i.customer_amount*10000000=intake.amount_stroops) THEN RETURN NULL; END IF;
  IF intake.payer_uid IS NOT NULL AND (intake.payer_uid,intake.payer_wallet) IS DISTINCT FROM(p_input->>'payerUid',p_input->>'payerWallet') THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.r36_testnet_ingress_reservations WHERE payment_id=intake.payment_id) THEN
   SELECT payment_id INTO prior_id FROM public.r36_testnet_ingress_reservations WHERE source_wallet=wallet AND retired_by_payment_id IS NULL FOR UPDATE;
   IF (prior_id IS NOT NULL OR EXISTS(SELECT 1 FROM public.financial_wallet_authorities WHERE network='Pi Testnet' AND source_wallet=wallet))
    AND (prior_id IS NULL OR public.r36_terminal_ingress_clearance(p_policy,wallet,prior_id) IS DISTINCT FROM true) THEN RETURN NULL; END IF;
   IF EXISTS(SELECT 1 FROM public.settlement_checkpoints WHERE a2u_from_address=wallet AND stage IN ('a2u_created','prepared','horizon_confirmed','pi_completed'))
    OR EXISTS(SELECT 1 FROM public.refund_checkpoints r WHERE r.status IN ('pending','manual_review_required')
      AND public.r36_held_refund_outside_scope(wallet,r.payment_id,r.refund_id,p_policy) IS DISTINCT FROM true
      AND NOT EXISTS(SELECT 1 FROM public.financial_wallet_authorities a WHERE a.network='Pi Testnet' AND a.operation_kind='refund' AND a.owner_payment_id=r.payment_id AND a.owner_operation_id=r.refund_id AND a.source_wallet<>wallet AND a.state='prepared')) THEN RETURN NULL; END IF;
   IF prior_id IS NOT NULL THEN
    IF public.r36_terminal_ingress_clearance(p_policy,wallet,prior_id) IS DISTINCT FROM true THEN RETURN NULL; END IF;
    UPDATE public.r36_testnet_ingress_reservations SET retired_by_payment_id=intake.payment_id WHERE payment_id=prior_id AND retired_by_payment_id IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'INGRESS_SLOT_CHANGED'; END IF;
   END IF;
   INSERT INTO public.r36_testnet_ingress_reservations(payment_id,policy_digest,merchant_uid,merchant_id,create_intent_id,note_digest,source_wallet,merchant_wallet,amount_stroops)
   VALUES(intake.payment_id,p_policy,intake.merchant_uid,intake.merchant_id,intake.create_intent_id,intake.note_digest,wallet,intake.merchant_wallet,intake.amount_stroops);
  END IF;
  UPDATE public.r36_payment_intake SET payer_uid=p_input->>'payerUid',payer_wallet=p_input->>'payerWallet',payer_verified_at=clock_timestamp()
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
      WHERE network='Pi Testnet' AND source_wallet=wallet))
   AND (prior_id IS NULL OR public.r36_terminal_ingress_clearance(p_policy,wallet,prior_id) IS DISTINCT FROM true)
  THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.financial_wallet_activation
      WHERE network='Pi Testnet' AND source_wallet=wallet AND state='enabled' AND clearance_digest ~ '^[0-9a-f]{64}$')
  OR EXISTS(SELECT 1 FROM public.settlement_checkpoints WHERE a2u_from_address=wallet
       AND stage IN ('a2u_created','prepared','horizon_confirmed','pi_completed'))
  OR EXISTS(SELECT 1 FROM public.refund_checkpoints r WHERE r.status IN ('pending','manual_review_required')
      AND public.r36_held_refund_outside_scope(wallet,r.payment_id,r.refund_id,p_policy) IS DISTINCT FROM true
       AND NOT EXISTS(SELECT 1 FROM public.financial_wallet_authorities a WHERE a.network='Pi Testnet'
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
  IF stored.payer_uid IS NULL OR p_input->>'network' IS DISTINCT FROM 'Pi Testnet'
   OR p_input->>'sourceWallet' IS DISTINCT FROM stored.source_wallet
   OR p_input->>'operationKind' NOT IN ('settlement','refund') THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.r36_certificate_requests q
    JOIN public.r36_certificate_receipts c ON c.nonce=q.nonce
    JOIN public.settlement_checkpoints s ON s.payment_id=stored.payment_id
    WHERE q.policy_digest=p_policy AND q.binding->>'paymentId'=stored.payment_id
    AND q.binding->>'network'='Pi Testnet' AND q.binding->>'sourceWallet'=stored.source_wallet
    AND q.binding->>'operationKind'=p_input->>'operationKind' AND q.binding->>'operationId'=p_input->>'operationId'
    AND q.binding->>'preparedHash'=p_input->>'preparedHash' AND q.binding->>'preparedSequence'=p_input->>'preparedSequence'
    AND q.binding->>'amountStroops'=stored.amount_stroops::text
    AND q.binding->>'destinationWallet'=CASE WHEN p_input->>'operationKind'='settlement' THEN stored.merchant_wallet ELSE stored.payer_wallet END
    AND q.binding->>'piPaymentId'=s.u2a_identifier AND q.binding->>'u2aTxid'=s.u2a_txid
    AND s.u2a_completed_at IS NOT NULL AND s.payer_uid=stored.payer_uid
    AND s.merchant_uid=stored.merchant_uid AND s.merchant_id=stored.merchant_id
    AND s.customer_amount*10000000=stored.amount_stroops)
   OR public.r36_certificate_allows('Pi Testnet',stored.source_wallet,stored.payment_id,
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
   OR (stored.payer_uid,stored.source_wallet,stored.amount_stroops::text)
    IS DISTINCT FROM(p_input->>'payerUid',p_input->>'toAddress',p_input->>'amountStroops')
   OR jsonb_typeof(p_input->'fromAddress') IS DISTINCT FROM 'string'
   OR (p_input->>'fromAddress'<>'' AND p_input->>'fromAddress' IS DISTINCT FROM stored.payer_wallet)
   OR NOT EXISTS(SELECT 1 FROM public.settlement_checkpoints s WHERE s.payment_id=stored.payment_id
     AND s.stage='payment_identity' AND s.u2a_identifier IS NULL AND s.u2a_txid IS NULL
     AND s.u2a_completed_at IS NULL AND s.a2u_payment_id IS NULL AND s.prepared_tx_hash IS NULL
     AND s.a2u_txid IS NULL AND s.customer_amount*10000000=stored.amount_stroops
     AND s.merchant_uid=stored.merchant_uid AND s.merchant_id=stored.merchant_id
     AND s.merchant_amount=s.customer_amount AND s.app_commission=0)
   OR EXISTS(SELECT 1 FROM public.refund_checkpoints r WHERE r.payment_id=stored.payment_id)
   OR EXISTS(SELECT 1 FROM public.r36_legacy_right_holds h WHERE h.payment_id=stored.payment_id)
   THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('paymentId',stored.payment_id,'phase','pretransaction_approval');
 END IF;
 IF (stored.payer_uid,stored.payer_wallet,stored.source_wallet,stored.amount_stroops::text)
   IS DISTINCT FROM (p_input->>'payerUid',p_input->>'fromAddress',p_input->>'toAddress',p_input->>'amountStroops')
 THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('paymentId',stored.payment_id);
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
     AND extract(epoch FROM clock_timestamp()) < least(p.valid_until,p.revocation_valid_until,c.expires_at)
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
CREATE OR REPLACE FUNCTION public.r36_select_confirmed_settlement_reconciliation(p_subject text, p_policy text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
 JOIN public.financial_wallet_authorities a ON a.owner_payment_id=i.payment_id AND a.network='Pi Testnet' AND a.state='prepared'
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
END $function$

;
CREATE OR REPLACE FUNCTION public.r36_select_confirmed_refund_reconciliation(p_subject text, p_policy text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
 JOIN public.financial_wallet_authorities a ON a.owner_payment_id=i.payment_id AND a.network='Pi Testnet' AND a.state='prepared'
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
END $function$

;
CREATE OR REPLACE FUNCTION public.r36_next_testnet_preparation(p_subject text, p_policy text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
   AND (s.merchant_id,s.merchant_uid,s.customer_amount,s.merchant_amount,s.app_commission)
       =(i.merchant_id,i.merchant_uid,i.customer_amount,i.customer_amount,0)
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
       AND (s.stage='payment_identity' OR (s.a2u_from_address=b.source_wallet AND s.a2u_to_address=b.merchant_wallet)))
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
     'toAddress',v.wallet,'amountStroops',v.amount_stroops::text)) IS NULL THEN CONTINUE; END IF;
   RETURN jsonb_build_object('phase',CASE WHEN v.completion_missing THEN 'u2a_completion' WHEN v.certification_recovery THEN 'certification_recovery' ELSE 'preparation_only' END,'id',v.id,'kind',v.kind,'op',v.op,
     'stage',v.stage,'piCreated',v.pi_created);
 END LOOP;
 RETURN NULL;
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN RETURN NULL;
END $function$

;
CREATE OR REPLACE FUNCTION public.r36_prepared_evidence_candidate(p_action text, p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE i jsonb; saved jsonb; body jsonb; res public.r36_testnet_ingress_reservations;
 cp public.settlement_checkpoints; rf public.refund_checkpoints; policy public.r36_certificate_policies;
BEGIN
 IF session_user<>'r36_runtime' OR current_setting('transaction_isolation')<>'read committed'
 OR p_action IS NULL OR p_action NOT IN ('read','stage') OR jsonb_typeof(p_input) IS DISTINCT FROM 'object'
 THEN RETURN NULL; END IF;
 i:=CASE WHEN p_action='read' THEN p_input ELSE p_input->'identity' END;
 IF jsonb_typeof(i) IS DISTINCT FROM 'object' OR
 (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(i) k) IS DISTINCT FROM
 ARRAY['amountStroops','destinationWallet','network','operationId','operationKind','paymentId','piPaymentId','sourceWallet']::text[]
 OR EXISTS(SELECT 1 FROM jsonb_each(i) kv WHERE jsonb_typeof(kv.value)<>'string')
 OR i->>'network' IS DISTINCT FROM 'Pi Testnet'
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
 SELECT * INTO res FROM public.r36_testnet_ingress_reservations WHERE payment_id=i->>'paymentId' FOR SHARE;
 IF NOT FOUND OR res.payer_uid IS NULL OR res.payer_wallet IS NULL
 OR (res.source_wallet,res.amount_stroops::text) IS DISTINCT FROM(i->>'sourceWallet',i->>'amountStroops')
 OR i->>'destinationWallet' IS DISTINCT FROM (CASE WHEN i->>'operationKind'='settlement' THEN res.merchant_wallet ELSE res.payer_wallet END)
 THEN RETURN NULL; END IF;
 SELECT * INTO policy FROM public.r36_certificate_policies WHERE policy_digest=res.policy_digest FOR SHARE;
 IF NOT FOUND OR NOT policy.enabled OR policy.revoked
 OR extract(epoch FROM clock_timestamp()) NOT BETWEEN policy.valid_from AND least(policy.valid_until,policy.revocation_valid_until)-1
 OR public.r36_policy_subject(policy.worker_profile,res) IS DISTINCT FROM true
 THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.financial_wallet_activation WHERE network='Pi Testnet' AND source_wallet=res.source_wallet
 AND state='enabled' AND clearance_digest ~ '^[0-9a-f]{64}$' FOR SHARE)
 OR NOT EXISTS(SELECT 1 FROM public.payment_create_intents WHERE payment_id=res.payment_id AND merchant_uid=res.merchant_uid
 AND merchant_id=res.merchant_id AND create_intent_id=res.create_intent_id AND customer_amount*10000000=res.amount_stroops)
 THEN RETURN NULL; END IF;
 SELECT * INTO cp FROM public.settlement_checkpoints WHERE payment_id=res.payment_id;
 IF NOT FOUND OR (cp.merchant_uid,cp.merchant_id,cp.payer_uid) IS DISTINCT FROM(res.merchant_uid,res.merchant_id,res.payer_uid)
 OR cp.customer_amount*10000000 IS DISTINCT FROM res.amount_stroops::numeric OR cp.app_commission IS DISTINCT FROM 0::numeric
 OR cp.u2a_verified_at IS NULL OR cp.u2a_completed_at IS NULL OR coalesce(cp.u2a_identifier,'')='' OR coalesce(cp.u2a_txid,'') !~ '^[0-9a-f]{64}$'
 OR cp.prepared_envelope_xdr IS NOT NULL OR cp.prepared_tx_hash IS NOT NULL OR cp.prepared_sequence IS NOT NULL OR cp.a2u_txid IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.transactions WHERE payment_id=res.payment_id)
 OR EXISTS(SELECT 1 FROM public.refund_accounting_records WHERE payment_id=res.payment_id)
 OR EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts WHERE owner_payment_id=res.payment_id)
 THEN RETURN NULL; END IF;
 IF i->>'operationKind'='settlement' THEN
  IF cp.stage IS DISTINCT FROM 'a2u_created' OR cp.merchant_amount IS DISTINCT FROM cp.customer_amount
  OR (cp.a2u_payment_id,cp.a2u_from_address,cp.a2u_to_address) IS DISTINCT FROM(i->>'piPaymentId',res.source_wallet,res.merchant_wallet)
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
  INSERT INTO public.r36_prepared_evidence_candidates(payment_id,network,source_wallet,prepared_sequence,candidate)
  VALUES(res.payment_id,'Pi Testnet',res.source_wallet,p_input->>'preparedSequence',body);
 END IF;
 RETURN jsonb_build_object('state','present','candidate',body);
END $function$

;
CREATE OR REPLACE FUNCTION public.r36_terminal_review_context(p_policy text, p_wallet text, p_prior text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE old public.financial_wallet_authorities; seal public.financial_wallet_finality_seals;
 terminal jsonb; policy public.r36_certificate_policies; p_network text := 'Pi Testnet';
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
    AND s.merchant_amount=s.customer_amount AND s.app_commission=0
    AND t.merchant_id=s.merchant_id AND t.merchant_uid=s.merchant_uid AND t.status='completed' AND t.currency='π'
    AND t.amount=s.customer_amount AND r.merchant_id=s.merchant_id AND r.merchant_uid=s.merchant_uid
    AND r.currency='π' AND r.amount=s.customer_amount AND r.customer_amount=s.customer_amount
    AND r.merchant_amount=s.customer_amount AND r.app_commission=0 AND r.txid=s.a2u_txid
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
 SELECT jsonb_build_object('piPaymentId',s.a2u_payment_id,'recipientUid',s.merchant_uid,'amountStroops',trunc(s.customer_amount*10000000)::text,
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
END $function$

;
CREATE OR REPLACE FUNCTION public.r36_terminal_ingress_clearance(p_policy text, p_wallet text, p_prior text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE old public.financial_wallet_authorities; seal public.financial_wallet_finality_seals;
 proof record; policy public.r36_certificate_policies; p_network text := 'Pi Testnet';
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
    AND s.merchant_amount=s.customer_amount AND s.app_commission=0
    AND t.merchant_id=s.merchant_id AND t.merchant_uid=s.merchant_uid AND t.status='completed' AND t.currency='π'
    AND t.amount=s.customer_amount AND r.merchant_id=s.merchant_id AND r.merchant_uid=s.merchant_uid
    AND r.currency='π' AND r.amount=s.customer_amount AND r.customer_amount=s.customer_amount
    AND r.merchant_amount=s.customer_amount AND r.app_commission=0 AND r.txid=s.a2u_txid
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
END $function$

;
CREATE OR REPLACE FUNCTION public.r36_held_refund_outside_scope(p_wallet text, p_payment text, p_refund text, p_policy text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
 OR doc->>'network' IS DISTINCT FROM 'Pi Testnet' OR doc->>'sourceWallet' IS DISTINCT FROM p_wallet
 OR doc->>'oldRightsDisposition' IS DISTINCT FROM 'DEFERRED_PRESERVED_NO_RESEND'
 OR doc->'oldRightsFinanciallyCleared' IS DISTINCT FROM 'false'::jsonb
 OR jsonb_typeof(doc->'legacyHolds') IS DISTINCT FROM 'array'
 OR jsonb_typeof(doc->'baseline'->'refunds') IS DISTINCT FROM 'array'
 OR jsonb_typeof(doc->'baseline'->'settlements') IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 birth:=(doc->>'genesisClosedAt')::timestamptz;
 SELECT * INTO h FROM public.r36_legacy_right_holds WHERE payment_id=p_payment FOR SHARE;
 IF NOT FOUND OR h.kind<>'refund' OR h.network<>'Pi Testnet' OR h.state<>'HELD_UNRESOLVED_NO_RESEND'
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
END $function$

;

ALTER FUNCTION public.r36_general_policy(jsonb) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_general_policy(jsonb) FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
ALTER FUNCTION public.r36_policy_wallet(jsonb) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_policy_wallet(jsonb) FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
ALTER FUNCTION public.r36_policy_max_amount(jsonb) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_policy_max_amount(jsonb) FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
ALTER FUNCTION public.r36_policy_subject(jsonb,public.r36_testnet_ingress_reservations) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_policy_subject(jsonb,public.r36_testnet_ingress_reservations) FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
ALTER FUNCTION public.r36_operation_settings(text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_operation_settings(text) FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
GRANT EXECUTE ON FUNCTION public.r36_operation_settings(text) TO r36_runtime;
GRANT EXECUTE ON FUNCTION public.r36_general_policy(jsonb),public.r36_policy_wallet(jsonb),public.r36_policy_max_amount(jsonb),public.r36_policy_subject(jsonb,public.r36_testnet_ingress_reservations) TO neondb_owner;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM r36_owner;
REVOKE r36_owner FROM neondb_owner;
COMMIT;
