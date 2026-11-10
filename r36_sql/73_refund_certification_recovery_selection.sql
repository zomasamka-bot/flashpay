-- Preserve the original production exact 0.10 Pi refund certification across
-- interruption. No authority or budget is granted by this read-only selector.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
SET LOCAL search_path=pg_catalog,pg_temp;
DO $$ BEGIN
 IF current_database()<>'neondb' OR session_user<>'neondb_owner' OR current_user<>session_user
 OR (current_setting('neon.branch_id',true) IS DISTINCT FROM 'br-tiny-mode-aliatv40'
 AND current_setting('flashpay.isolated_certificate_test',true) IS DISTINCT FROM 'yes')
 OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
 OR to_regprocedure('public.r36_prepare_testnet_ingress(text,text,jsonb)') IS NULL
 OR to_regclass('public.r36_wallet_execution_scopes') IS NULL
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=to_regprocedure('public.r36_next_testnet_preparation(text,text)')) IS DISTINCT FROM '17a080c872566b5937d33c2046d61e15120746e2cd0aee290260f89efad999bf'
 THEN RAISE EXCEPTION 'PREPARATION_SELECTION_TARGET_NOT_PROVEN'; END IF;
END $$;
GRANT r36_owner TO neondb_owner WITH INHERIT FALSE,SET TRUE;
GRANT CREATE ON SCHEMA public TO r36_owner;
SET LOCAL ROLE r36_owner;
CREATE OR REPLACE FUNCTION public.r36_next_testnet_preparation(p_subject text,p_policy text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
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
   (r.payment_id IS NULL AND s.customer_amount=0.1 AND s.stage='payment_identity') AS certification_recovery
 FROM public.r36_testnet_ingress_reservations b
 JOIN public.r36_certificate_policies p ON p.policy_digest=b.policy_digest
 JOIN public.r36_wallet_execution_scopes scope ON scope.policy_digest=p.policy_digest
   AND scope.scope_digest=p.worker_profile->>'executionScopeDigest' AND scope.source_wallet=b.source_wallet
 JOIN public.payment_create_intents i ON i.payment_id=b.payment_id
 JOIN public.settlement_checkpoints s ON s.payment_id=i.payment_id
 LEFT JOIN public.refund_checkpoints r ON r.payment_id=i.payment_id
 WHERE b.policy_digest=p_policy AND b.retired_by_payment_id IS NULL
   AND b.source_wallet=p.worker_profile->'recoveryPilot'->'ingress'->>'sourceWallet'
   AND p.worker_profile->'recoveryPilot'->'ingress'->'payers' @> jsonb_build_array(jsonb_build_object('uid',b.payer_uid,'wallet',b.payer_wallet))
   AND p.worker_profile->'recoveryPilot'->'ingress'->'merchants' @> jsonb_build_array(jsonb_build_object('uid',b.merchant_uid,'username',b.merchant_id,'wallet',b.merchant_wallet))
   AND (p_subject IS NULL OR i.payment_id=p_subject)
   AND i.created_at>(scope.scope_text::jsonb->>'genesisClosedAt')::timestamptz
   AND i.created_at<=statement_timestamp() AND b.reserved_at<=statement_timestamp()
   AND b.amount_stroops BETWEEN 1 AND 2000000 AND i.customer_amount*10000000=b.amount_stroops
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
END $$;
REVOKE ALL ON FUNCTION public.r36_next_testnet_preparation(text,text)
 FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
GRANT EXECUTE ON FUNCTION public.r36_next_testnet_preparation(text,text) TO r36_runtime;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM r36_owner;
REVOKE r36_owner FROM neondb_owner;
COMMIT;
