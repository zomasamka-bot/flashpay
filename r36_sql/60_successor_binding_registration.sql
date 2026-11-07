-- Inert registration bridge. This function never creates an independent approval,
-- signs, consumes a grant, changes wallet authority, clears a right or sends money.
-- It registers only the exact successor already named by protected approval bytes.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
SET LOCAL search_path=pg_catalog,pg_temp;
DO $$ BEGIN
 IF current_setting('flashpay.isolated_certificate_test',true) IS DISTINCT FROM 'yes' THEN
  IF current_database()<>'neondb' OR current_setting('neon.branch_id',true) IS DISTINCT FROM 'br-tiny-mode-aliatv40'
  OR session_user<>'neondb_owner' OR current_user<>session_user
  OR (SELECT count(*) FROM pg_roles WHERE rolname IN ('r36_runtime','r36_issuer','r36_signer') AND NOT rolcanlogin)<>3
  OR EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename IN ('r36_runtime','r36_issuer','r36_signer'))
  OR EXISTS(SELECT 1 FROM public.financial_wallet_activation)
  OR EXISTS(SELECT 1 FROM public.financial_wallet_authorities)
  OR EXISTS(SELECT 1 FROM public.r36_certificate_policies)
  THEN RAISE EXCEPTION 'PRODUCTION_TARGET_OR_INERT_HOLD_NOT_PROVEN'; END IF;
 END IF;
 IF to_regprocedure('public.r36_claim_bound_successor(text,text,text,text,text,text,text)') IS NULL
 OR to_regprocedure('public.r36_terminal_ingress_clearance(text,text,text)') IS NULL
 OR to_regprocedure('public.r36_register_successor_binding(text)') IS NOT NULL
 THEN RAISE EXCEPTION 'SQL57_SQL59_REQUIRED_OR_ALREADY_INSTALLED'; END IF;
END $$;

CREATE FUNCTION public.r36_register_successor_binding(p_nonce text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
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
 IF b->>'nonce' IS DISTINCT FROM p_nonce OR b->>'network' IS DISTINCT FROM 'Pi Testnet'
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
 SELECT s.approval_id,s.payload_digest,s.expires_at,s.independently_certified_at,s.consumed_at,
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
END $$;
ALTER FUNCTION public.r36_register_successor_binding(text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_register_successor_binding(text) FROM PUBLIC,r36_runtime,r36_signer;
GRANT EXECUTE ON FUNCTION public.r36_register_successor_binding(text) TO r36_issuer;
COMMIT;
