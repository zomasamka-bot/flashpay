-- New-wallet scope support. Inert: no policy, scope row or wallet is enrolled here.
BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='60s';
DO $$ BEGIN
 IF current_database()<>'neondb' OR session_user<>'neondb_owner' OR current_user<>session_user
 OR current_setting('neon.branch_id',true) IS DISTINCT FROM 'br-tiny-mode-aliatv40'
 OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
 OR EXISTS(SELECT 1 FROM public.r36_certificate_policies) OR EXISTS(SELECT 1 FROM public.financial_wallet_activation)
 OR EXISTS(SELECT 1 FROM public.financial_wallet_authorities)
 OR (SELECT rolcanlogin FROM pg_roles WHERE rolname='r36_runtime') IS DISTINCT FROM false
 OR EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='r36_runtime')
 OR pg_has_role('neondb_owner','r36_owner','SET') OR to_regclass('public.r36_wallet_execution_scopes') IS NOT NULL
 THEN RAISE EXCEPTION 'NEW_SCOPE_INERT_TARGET_NOT_PROVEN'; END IF;
IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.r36_claim_prepared_authority(text,text,text,text,text,text,text)'::regprocedure) IS DISTINCT FROM '930909c01b15f620f3a03f555be842a7763640bee3250b0502c6054517a2bf4a' THEN RAISE EXCEPTION 'SCOPE_BASE_FUNCTION_DRIFT'; END IF;
IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.r36_claim_first_submission(text,text,text,text,text,text,text)'::regprocedure) IS DISTINCT FROM '17b55a4665420d7aebd9a17f270ca14df36fcec8b5d5a7e25a3cb95b6ab864b9' THEN RAISE EXCEPTION 'SCOPE_BASE_FUNCTION_DRIFT'; END IF;
IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.r36_claim_bound_successor(text,text,text,text,text,text,text)'::regprocedure) IS DISTINCT FROM '6ed7da570094f58a1347d2801f630b24ca8f00bc018d2e3bae9d3166c326e00e' THEN RAISE EXCEPTION 'SCOPE_BASE_FUNCTION_DRIFT'; END IF;
IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.r36_prepare_testnet_ingress(text,text,jsonb)'::regprocedure) IS DISTINCT FROM '0615002e77f27fb61fe69fb5756c3ab0fed3dac6b0a3e558fb0cbad0d3f42c2c' THEN RAISE EXCEPTION 'SCOPE_BASE_FUNCTION_DRIFT'; END IF;
IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.r36_reserve_new_recovery(text,text)'::regprocedure) IS DISTINCT FROM '838492a531c8299f7b389d694bd7a3f2e751b98fe9bef5dde5ecc15f95b7f5e2' THEN RAISE EXCEPTION 'SCOPE_BASE_FUNCTION_DRIFT'; END IF;
END $$;
GRANT r36_owner TO neondb_owner WITH INHERIT FALSE,SET TRUE;
GRANT CREATE ON SCHEMA public TO r36_owner;
SET LOCAL ROLE r36_owner;
CREATE TABLE public.r36_wallet_execution_scopes (
 scope_digest text NOT NULL CHECK(scope_digest ~ '^[0-9a-f]{64}$'),
 policy_digest text NOT NULL REFERENCES public.r36_certificate_policies(policy_digest),
 source_wallet text NOT NULL CHECK(source_wallet ~ '^G[A-Z2-7]{55}$'),
 scope_text text NOT NULL CHECK(octet_length(scope_text)<=2000000),
 enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(scope_digest,policy_digest),
 CHECK(scope_digest=encode(sha256(convert_to(scope_text,'UTF8')),'hex')),
 CHECK((scope_text::jsonb->>'schema') IS NOT DISTINCT FROM 'R36_NEW_WALLET_EXECUTION_SCOPE_V1'),
 CHECK((scope_text::jsonb->>'network') IS NOT DISTINCT FROM 'Pi Testnet'),
 CHECK(scope_text::jsonb->>'sourceWallet'=source_wallet),
 CHECK((scope_text::jsonb->>'oldRightsDisposition') IS NOT DISTINCT FROM 'DEFERRED_PRESERVED_NO_RESEND'),
 CHECK((scope_text::jsonb->'oldRightsFinanciallyCleared') IS NOT DISTINCT FROM 'false'::jsonb)
);
REVOKE ALL ON public.r36_wallet_execution_scopes FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar;
GRANT SELECT ON public.r36_wallet_execution_scopes TO r36_evidence_reader;
GRANT SELECT(payment_id,network,kind,state,authorizes_new_rights,original_snapshot_sha256,held_at)
 ON public.r36_legacy_right_holds TO r36_evidence_reader;
CREATE FUNCTION public.r36_execution_scope_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'EXECUTION_SCOPE_IMMUTABLE_CREATE_NEW_POLICY_VERSION'; END $$;
REVOKE ALL ON FUNCTION public.r36_execution_scope_immutable() FROM PUBLIC;
CREATE TRIGGER r36_scope_immutable BEFORE UPDATE OR DELETE ON public.r36_wallet_execution_scopes FOR EACH ROW EXECUTE FUNCTION public.r36_execution_scope_immutable();
CREATE TRIGGER r36_scope_no_truncate BEFORE TRUNCATE ON public.r36_wallet_execution_scopes FOR EACH STATEMENT EXECUTE FUNCTION public.r36_execution_scope_immutable();

-- This does not mark a legacy claim resolved or create prepared authority for it.
-- Only an exact immutable hold may be outside an independently funded new scope,
-- under the SAME protected policy as the new right. Missing evidence still blocks.
CREATE FUNCTION public.r36_held_refund_outside_scope(p_wallet text,p_payment text,p_refund text,p_policy text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE h public.r36_legacy_right_holds; s public.r36_wallet_execution_scopes; p public.r36_certificate_policies;
 doc jsonb; bound jsonb; observed jsonb; birth timestamptz;
BEGIN
 IF session_user<>'r36_runtime' OR p_policy IS NULL OR p_wallet IS NULL THEN RETURN false; END IF;
 SELECT * INTO p FROM public.r36_certificate_policies WHERE policy_digest=p_policy FOR SHARE;
 IF NOT FOUND OR NOT p.enabled OR p.revoked
 OR extract(epoch FROM clock_timestamp()) NOT BETWEEN p.valid_from AND least(p.valid_until,p.revocation_valid_until)-1
 OR p.worker_profile->'recoveryPilot'->'ingress'->>'sourceWallet' IS DISTINCT FROM p_wallet
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
END $$;
REVOKE ALL ON FUNCTION public.r36_held_refund_outside_scope(text,text,text,text) FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;

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
$function$
;
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
$function$
;
CREATE OR REPLACE FUNCTION public.r36_claim_bound_successor(p_network text, p_wallet text, p_payment text, p_kind text, p_operation text, p_hash text, p_seq text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE old public.financial_wallet_authorities; seal public.financial_wallet_finality_seals;
 grant_row record; next_binding jsonb; now_at timestamptz; expected text;
BEGIN
 IF session_user<>'r36_runtime' OR current_setting('transaction_isolation')<>'read committed'
 OR p_network IS DISTINCT FROM 'Pi Testnet' OR p_seq IS NULL OR p_seq !~ '^[1-9][0-9]{0,29}$'
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
 SELECT b.approval_id,b.consumed_at,b.prior_payload_digest,s.payload_digest,s.expires_at,
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
END $function$
;
CREATE OR REPLACE FUNCTION public.r36_prepare_testnet_ingress(p_action text, p_policy text, p_input jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE policy public.r36_certificate_policies; pilot jsonb; config jsonb; person jsonb;
 stored public.r36_testnet_ingress_reservations; total numeric; wallet text; value bigint; prior_id text;
BEGIN
 IF session_user<>'r36_runtime' OR current_setting('transaction_isolation')<>'read committed'
 OR p_action IS NULL OR p_action NOT IN ('reserve','bind','verify','prepared') OR p_policy IS NULL OR p_policy !~ '^[0-9a-f]{64}$'
 OR jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('FLASHpay:R36:TESTNET_TRIAL_BUDGET:1',0));
 SELECT * INTO policy FROM public.r36_certificate_policies WHERE policy_digest=p_policy FOR SHARE;
 IF NOT FOUND OR NOT policy.enabled OR policy.revoked
 OR extract(epoch FROM clock_timestamp()) NOT BETWEEN policy.valid_from AND least(policy.valid_until,policy.revocation_valid_until)-1
 THEN RETURN NULL; END IF;
 pilot:=policy.worker_profile->'recoveryPilot'; config:=pilot->'ingress';
 IF pilot->>'schema' IS DISTINCT FROM 'FLASHPAY_TESTNET_NEW_RIGHTS_V1'
 OR config->>'schema' IS DISTINCT FROM 'FLASHPAY_TESTNET_INGRESS_V1'
 OR jsonb_typeof(config->'merchants') IS DISTINCT FROM 'array'
 OR jsonb_typeof(config->'payers') IS DISTINCT FROM 'array'
 OR coalesce(config->>'sourceWallet','') !~ '^G[A-Z2-7]{55}$' THEN RETURN NULL; END IF;
 wallet:=config->>'sourceWallet';
 IF jsonb_typeof(pilot->'wallets') IS DISTINCT FROM 'array' OR jsonb_typeof(pilot->'payerUids') IS DISTINCT FROM 'array' OR NOT (pilot->'wallets' @> jsonb_build_array(wallet)) THEN RETURN NULL; END IF;
 -- Recheck activation at every admission, including after an earlier reservation.
 -- A budget row must not outlive the operator's current wallet hold.
 IF NOT EXISTS(SELECT 1 FROM public.financial_wallet_activation
     WHERE network='Pi Testnet' AND source_wallet=wallet AND state='enabled'
     AND clearance_digest ~ '^[0-9a-f]{64}$' FOR SHARE) THEN RETURN NULL; END IF;
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
  SELECT 2*(coalesce((SELECT sum(amount_stroops) FROM public.r36_testnet_ingress_reservations),0)
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
 IF (SELECT count(*) FROM jsonb_array_elements(config->'payers') x WHERE x->>'uid'=p_input->>'payerUid')<>1 THEN RETURN NULL; END IF;
 SELECT x INTO person FROM jsonb_array_elements(config->'payers') x WHERE x->>'uid'=p_input->>'payerUid';
 IF person IS NULL OR coalesce(person->>'wallet','') !~ '^G[A-Z2-7]{55}$'
 OR NOT (pilot->'wallets' @> jsonb_build_array(person->>'wallet'))
 OR NOT (pilot->'payerUids' @> jsonb_build_array(p_input->>'payerUid')) THEN RETURN NULL; END IF;
 IF p_action='bind' THEN
  IF stored.payer_uid IS NOT NULL AND (stored.payer_uid,stored.payer_wallet)
     IS DISTINCT FROM(p_input->>'payerUid',person->>'wallet') THEN RETURN NULL; END IF;
  UPDATE public.r36_testnet_ingress_reservations SET payer_uid=p_input->>'payerUid',payer_wallet=person->>'wallet'
    WHERE payment_id=stored.payment_id AND payer_uid IS NULL;
  RETURN jsonb_build_object('paymentId',stored.payment_id);
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
     AND i.customer_amount>0 AND i.customer_amount<=0.20 AND i.customer_amount*10000000=trunc(i.customer_amount*10000000)
     AND s.merchant_id=i.merchant_id AND s.merchant_uid=i.merchant_uid AND s.customer_amount=i.customer_amount
     AND s.merchant_amount=i.customer_amount AND s.app_commission=0 AND s.u2a_completed_at IS NOT NULL
     AND s.u2a_identifier=q.binding->>'piPaymentId' AND s.u2a_txid=q.binding->>'u2aTxid'
     AND (i.customer_amount*10000000)::bigint::text=q.binding->>'amountStroops'
     AND p.worker_profile->'recoveryPilot'->>'schema'='FLASHPAY_TESTNET_NEW_RIGHTS_V1'
     AND jsonb_typeof(p.worker_profile->'recoveryPilot'->'wallets')='array'
     AND (p.worker_profile->'recoveryPilot'->'wallets') @> jsonb_build_array(a.source_wallet,q.binding->>'destinationWallet')
     AND jsonb_typeof(p.worker_profile->'recoveryPilot'->'payerUids')='array'
     AND (p.worker_profile->'recoveryPilot'->'payerUids') @> jsonb_build_array(s.payer_uid)
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
   SELECT 2*(coalesce((SELECT sum(amount_stroops) FROM public.r36_testnet_ingress_reservations),0)
     +coalesce((SELECT sum(r.amount_stroops) FROM public.r36_recovery_trial_reservations r WHERE NOT EXISTS
      (SELECT 1 FROM public.r36_testnet_ingress_reservations i WHERE i.payment_id=r.payment_id)),0)) INTO used;
   IF used>10000000 THEN CONTINUE; END IF;
   INSERT INTO public.r36_recovery_trial_reservations(payment_id,nonce,payload_digest,amount_stroops) VALUES(v.id,v.nonce,v.digest,v.amount);
 END IF;
 RETURN jsonb_build_object('id',v.id,'kind',v.kind,'op',v.op,'wallet',v.wallet,'hash',v.hash,'seq',v.seq,'stage',v.stage,
   'spent',EXISTS(SELECT 1 FROM public.financial_wallet_submission_attempts t WHERE t.network='Pi Testnet' AND t.owner_payment_id=v.id
     AND t.source_wallet=v.wallet AND t.operation_kind=v.kind AND t.owner_operation_id=v.op AND t.prepared_tx_hash=v.hash AND t.prepared_sequence=v.seq));
 END LOOP;
 RETURN NULL;
END $function$
;
RESET ROLE; REVOKE CREATE ON SCHEMA public FROM r36_owner; REVOKE r36_owner FROM neondb_owner GRANTED BY neondb_owner; COMMIT;
