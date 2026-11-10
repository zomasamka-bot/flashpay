-- PI_PAYMENT_DTO_V1: identity from /me; immutable wallet evidence from canonical payments.
-- No policy activation, fee change, financial attempt reset or historic data rewrite.
BEGIN;
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
SET LOCAL search_path=pg_catalog,pg_temp;
DO $$ BEGIN
 IF current_database()<>'neondb' OR session_user<>'neondb_owner' OR current_user<>session_user
 OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999 THEN RAISE EXCEPTION 'WALLET_BINDING_TARGET'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.r36_prepare_testnet_ingress(text,text,jsonb)')) IS DISTINCT FROM 'ba74faacb98aaa5ab26d770105adf0971c203a35f80b51a648741effc860d014' THEN RAISE EXCEPTION 'WALLET_BINDING_BASELINE:r36_prepare_testnet_ingress'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.r36_policy_subject(jsonb,public.r36_testnet_ingress_reservations)')) IS DISTINCT FROM 'bdf6ef3c23ba5f8a64519776c1fd9804e02f78a0ee763560d13cf9258eb9837a' THEN RAISE EXCEPTION 'WALLET_BINDING_BASELINE:r36_policy_subject'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.r36_next_testnet_preparation(text,text)')) IS DISTINCT FROM 'f03bcf8fc0137d731eb9505c6bbd2dfaae45baa91560e51194f4cc9e13fe4157' THEN RAISE EXCEPTION 'WALLET_BINDING_BASELINE:r36_next_testnet_preparation'; END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.r36_prepared_evidence_candidate(text,jsonb)')) IS DISTINCT FROM 'de7b67eac3e634cbfd1ece860516f949cd045e20903afab390a5a89fffcc0748' THEN RAISE EXCEPTION 'WALLET_BINDING_BASELINE:r36_prepared_evidence_candidate'; END IF;
END $$;
GRANT r36_owner TO neondb_owner WITH INHERIT FALSE,SET TRUE;
GRANT CREATE ON SCHEMA public TO r36_owner;
SET LOCAL ROLE r36_owner;
ALTER TABLE public.r36_payment_intake ALTER COLUMN merchant_wallet DROP NOT NULL;
ALTER TABLE public.r36_testnet_ingress_reservations ALTER COLUMN merchant_wallet DROP NOT NULL;
ALTER TABLE public.r36_payment_intake
 ADD COLUMN wallet_contract text NOT NULL DEFAULT 'PI_V2_ME' CHECK(wallet_contract IN ('PI_V2_ME','PI_PAYMENT_DTO_V1')),
 ADD COLUMN payer_pi_payment_id text CHECK(payer_pi_payment_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
 ADD COLUMN payer_txid text CHECK(payer_txid ~ '^[0-9a-f]{64}$'),
 ADD COLUMN payer_wallet_proven_at timestamptz,
 ADD COLUMN merchant_pi_payment_id text CHECK(merchant_pi_payment_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
 ADD CONSTRAINT r36_intake_wallet_evidence_shape CHECK(wallet_contract<>'PI_PAYMENT_DTO_V1' OR (
  ((payer_wallet IS NULL AND payer_pi_payment_id IS NULL AND payer_txid IS NULL AND payer_wallet_proven_at IS NULL) OR
   (payer_wallet IS NOT NULL AND payer_uid IS NOT NULL AND payer_pi_payment_id IS NOT NULL AND payer_txid IS NOT NULL AND payer_wallet_proven_at IS NOT NULL))
  AND ((merchant_wallet IS NULL AND merchant_pi_payment_id IS NULL) OR (merchant_wallet IS NOT NULL AND merchant_pi_payment_id IS NOT NULL))));
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
     WHERE network='Pi Testnet' AND source_wallet=wallet AND state='enabled'
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
   OR (p_input->>'fromAddress'<>'' AND (p_input->>'fromAddress' !~ '^G[A-Z2-7]{55}$' OR (stored.payer_wallet IS NOT NULL AND p_input->>'fromAddress' IS DISTINCT FROM stored.payer_wallet)))
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
 -- A wallet address is learned from a canonical, already-verified Pi payment,
 -- never from SDK presentation fields or an invented /me wallet attribute.
 IF p_action='inbound' THEN
  IF coalesce(p_input->>'piPaymentId','') !~ '^[A-Za-z0-9_.:-]{1,128}$'
   OR coalesce(p_input->>'txid','') !~ '^[0-9a-f]{64}$'
   OR coalesce(p_input->>'fromAddress','') !~ '^G[A-Z2-7]{55}$'
   OR (stored.payer_uid,stored.source_wallet,stored.amount_stroops::text)
     IS DISTINCT FROM(p_input->>'payerUid',p_input->>'toAddress',p_input->>'amountStroops')
   OR stored.payer_uid IS NULL OR p_input->>'fromAddress'=stored.source_wallet
   OR NOT EXISTS(SELECT 1 FROM public.settlement_checkpoints c WHERE c.payment_id=stored.payment_id
     AND c.merchant_uid=stored.merchant_uid AND c.merchant_id=stored.merchant_id
     AND c.customer_amount*10000000=stored.amount_stroops AND c.merchant_amount=c.customer_amount AND c.app_commission=0
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
 IF (stored.payer_uid,stored.payer_wallet,stored.source_wallet,stored.amount_stroops::text)
   IS DISTINCT FROM (p_input->>'payerUid',p_input->>'fromAddress',p_input->>'toAddress',p_input->>'amountStroops')
 THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('paymentId',stored.payment_id);
END $function$

;

CREATE OR REPLACE FUNCTION public.r36_policy_subject(p jsonb,b public.r36_testnet_ingress_reservations) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT coalesce(b.source_wallet=public.r36_policy_wallet(p) AND b.amount_stroops BETWEEN 1 AND public.r36_policy_max_amount(p)
 AND CASE WHEN public.r36_general_policy(p) THEN EXISTS(SELECT 1 FROM public.r36_payment_intake i
 WHERE (i.payment_id,i.policy_digest,i.source_wallet,i.merchant_uid,i.merchant_id,i.merchant_wallet,i.create_intent_id,i.note_digest,i.amount_stroops,i.payer_uid,i.payer_wallet)
 IS NOT DISTINCT FROM (b.payment_id,b.policy_digest,b.source_wallet,b.merchant_uid,b.merchant_id,b.merchant_wallet,b.create_intent_id,b.note_digest,b.amount_stroops,b.payer_uid,b.payer_wallet)
 AND i.payer_wallet IS NOT NULL AND (i.wallet_contract='PI_V2_ME' OR
 (i.wallet_contract='PI_PAYMENT_DTO_V1' AND i.payer_pi_payment_id IS NOT NULL AND i.payer_txid IS NOT NULL AND i.payer_wallet_proven_at<=statement_timestamp()
 AND (i.merchant_wallet IS NULL OR i.merchant_pi_payment_id IS NOT NULL)))
 AND i.identity_source='PI_V2_ME' AND i.identity_verified_at<=statement_timestamp() AND i.payer_verified_at<=statement_timestamp())
 ELSE p->'recoveryPilot'->>'schema'='FLASHPAY_TESTNET_NEW_RIGHTS_V1' AND NOT(p ? 'generalOperation')
 AND p->'recoveryPilot'->'wallets' @> jsonb_build_array(b.source_wallet,b.merchant_wallet,b.payer_wallet)
 AND p->'recoveryPilot'->'payerUids' @> jsonb_build_array(b.payer_uid)
 AND p->'recoveryPilot'->'ingress'->'merchants' @> jsonb_build_array(jsonb_build_object('uid',b.merchant_uid,'username',b.merchant_id,'wallet',b.merchant_wallet))
 AND p->'recoveryPilot'->'ingress'->'payers' @> jsonb_build_array(jsonb_build_object('uid',b.payer_uid,'wallet',b.payer_wallet)) END,false)
$$;

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
 SELECT * INTO res FROM public.r36_testnet_ingress_reservations WHERE payment_id=i->>'paymentId' FOR UPDATE;
 deferred_wallet:=res.merchant_wallet IS NULL AND i->>'operationKind'='settlement' AND EXISTS(SELECT 1 FROM public.r36_payment_intake x WHERE x.payment_id=res.payment_id AND x.wallet_contract='PI_PAYMENT_DTO_V1');
 IF NOT FOUND OR res.payer_uid IS NULL OR res.payer_wallet IS NULL
 OR (res.source_wallet,res.amount_stroops::text) IS DISTINCT FROM(i->>'sourceWallet',i->>'amountStroops')
 OR (NOT deferred_wallet AND i->>'destinationWallet' IS DISTINCT FROM (CASE WHEN i->>'operationKind'='settlement' THEN res.merchant_wallet ELSE res.payer_wallet END))
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
  VALUES(res.payment_id,'Pi Testnet',res.source_wallet,p_input->>'preparedSequence',body);
 END IF;
 RETURN jsonb_build_object('state','present','candidate',body);
END $function$

;
CREATE FUNCTION public.r36_next_inbound_observation(p_subject text,p_policy text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
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
 AND (c.merchant_uid,c.merchant_id,c.customer_amount,c.merchant_amount,c.app_commission)
   =(o.merchant_uid,o.merchant_id,o.customer_amount,o.customer_amount,0)
 AND b.payer_uid IS NOT NULL AND c.stage='payment_identity' AND c.u2a_verified_at IS NULL
 AND c.u2a_approval_identifier IS NOT NULL AND c.u2a_approval_claimed_at IS NOT NULL AND c.u2a_approval_attempted_at IS NOT NULL
 AND c.u2a_identifier IS NULL AND c.u2a_txid IS NULL AND c.u2a_completed_at IS NULL
 AND c.a2u_payment_id IS NULL AND c.prepared_tx_hash IS NULL
 AND NOT EXISTS(SELECT 1 FROM public.refund_checkpoints r WHERE r.payment_id=b.payment_id)
 AND NOT EXISTS(SELECT 1 FROM public.r36_legacy_right_holds h WHERE h.payment_id=b.payment_id)
 AND NOT EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts a WHERE a.owner_payment_id=b.payment_id)
 AND public.r36_general_policy(p.worker_profile) AND p.enabled AND NOT p.revoked
 AND extract(epoch FROM clock_timestamp()) BETWEEN p.valid_from AND least(p.valid_until,p.revocation_valid_until)-1
 AND EXISTS(SELECT 1 FROM public.financial_wallet_activation a WHERE a.network='Pi Testnet' AND a.source_wallet=b.source_wallet AND a.state='enabled')
 ORDER BY o.created_at,b.payment_id LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN to_jsonb(v);
END $$;
ALTER FUNCTION public.r36_next_inbound_observation(text,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_next_inbound_observation(text,text) FROM PUBLIC,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
GRANT EXECUTE ON FUNCTION public.r36_next_inbound_observation(text,text) TO r36_runtime;

RESET ROLE; REVOKE CREATE ON SCHEMA public FROM r36_owner; REVOKE r36_owner FROM neondb_owner; COMMIT;
