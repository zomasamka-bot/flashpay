-- Issuer commits an already independently reviewed fact plus its source seal.
-- No payment, certificate, wallet permission or transfer is created here.
CREATE OR REPLACE FUNCTION public.r36_activate_history_checkpoint(p_digest text,p_rows_text text,p_network_text text,p_entries_text text,p_credits_text text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.r36_history_checkpoints;p public.r36_certificate_policies;point jsonb;rows jsonb;net jsonb;entries jsonb;credits jsonb;
 head text;ep bigint;item jsonb;source_kind text;k jsonb;cp jsonb;balance jsonb;prior_credit public.r36_history_credit_totals;opening numeric;scope jsonb;
BEGIN
 IF session_user<>'r36_issuer' THEN RAISE EXCEPTION 'CHECKPOINT_ISSUER_REQUIRED'; END IF;
 SELECT * INTO c FROM public.r36_history_checkpoints WHERE digest=p_digest AND NOT revoked FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CHECKPOINT_NOT_CERTIFIED'; END IF;
 SELECT * INTO p FROM public.r36_certificate_policies WHERE policy_digest=c.policy_digest FOR SHARE;
 IF NOT FOUND OR NOT p.enabled OR p.revoked OR NOT EXISTS(SELECT 1 FROM public.r36_history_enrollments WHERE policy_digest=c.policy_digest AND source_wallet=c.source_wallet AND NOT revoked)
 OR p.valid_until<=extract(epoch FROM clock_timestamp()) OR p.revocation_valid_until<=extract(epoch FROM clock_timestamp()) THEN RAISE EXCEPTION 'CHECKPOINT_POLICY'; END IF;
 point=c.checkpoint_text::jsonb;
 IF encode(sha256(convert_to(p_rows_text,'UTF8')),'hex') IS DISTINCT FROM point->>'sourceRowsDigest'
 OR encode(sha256(convert_to(p_network_text,'UTF8')),'hex') IS DISTINCT FROM point->>'deltaHistoryDigest'
 OR encode(sha256(convert_to(p_entries_text,'UTF8')),'hex') IS DISTINCT FROM point->>'deltaAccountingDigest'
 OR octet_length(p_rows_text)>96000000 OR octet_length(p_network_text)>96000000 OR octet_length(p_entries_text)>16000000 OR octet_length(p_credits_text)>4000000 THEN RAISE EXCEPTION 'CHECKPOINT_SOURCE_BINDING'; END IF;
 IF EXISTS(SELECT 1 FROM public.r36_history_activated WHERE digest=p_digest) THEN RETURN 'REPLAYED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.r36_prior_closure_receipts WHERE payload_digest=c.closure_digest AND NOT revoked AND expires_at>extract(epoch FROM clock_timestamp())) THEN RAISE EXCEPTION 'CHECKPOINT_CLOSURE_NOT_CURRENT'; END IF;
 -- Writers acquire ROW EXCLUSIVE before reading closed keys. This prevents a
 -- writer that started before publication from slipping past the new seal.
 LOCK TABLE r36_evidence_source.work IN SHARE ROW EXCLUSIVE MODE;
 SELECT digest INTO head FROM public.r36_history_checkpoint_heads WHERE policy_digest=c.policy_digest AND source_wallet=c.source_wallet FOR UPDATE;
 IF head IS DISTINCT FROM c.parent_digest THEN RAISE EXCEPTION 'CHECKPOINT_HEAD_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM public.r36_history_checkpoint_heads WHERE policy_digest<>c.policy_digest OR source_wallet<>c.source_wallet) THEN RAISE EXCEPTION 'CHECKPOINT_MULTI_SCOPE_NOT_ENROLLED'; END IF;
 rows=p_rows_text::jsonb;net=p_network_text::jsonb;entries=p_entries_text::jsonb;credits=p_credits_text::jsonb;
 IF jsonb_typeof(rows)<>'object' OR jsonb_typeof(net)<>'array' OR jsonb_typeof(entries)<>'array' OR jsonb_typeof(credits)<>'array' OR jsonb_array_length(net)>40000 OR jsonb_array_length(entries)>20000 OR jsonb_array_length(credits)>20000 THEN RAISE EXCEPTION 'CHECKPOINT_SOURCE_SHAPE'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(rows))<>12 OR EXISTS(SELECT 1 FROM jsonb_each(rows) e WHERE e.key NOT IN ('intents','settlements','refunds','transactions','receipts','refundAccounting','refundAudit','merchantBalances','authorities','authorityHistory','executionScopes','legacyHolds') OR jsonb_typeof(e.value)<>'array' OR jsonb_array_length(e.value)>20000) THEN RAISE EXCEPTION 'CHECKPOINT_SOURCE_KINDS'; END IF;
 -- Compare sets in BOTH directions, including row identities and exact values.
 IF (SELECT sum(jsonb_array_length(value)) FROM jsonb_each(rows))<>(SELECT count(*) FROM r36_evidence_source.work) THEN RAISE EXCEPTION 'CHECKPOINT_SOURCE_CHANGED'; END IF;
 FOR source_kind,item IN SELECT e.key,v.value FROM jsonb_each(rows) e CROSS JOIN LATERAL jsonb_array_elements(e.value) v LOOP
  k=r36_evidence_source.row_key(source_kind,item);
  IF NOT EXISTS(SELECT 1 FROM r36_evidence_source.work w WHERE w.kind=source_kind AND w.row_key=k AND w.projection=item) THEN RAISE EXCEPTION 'CHECKPOINT_SOURCE_CHANGED'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_each(rows) e CROSS JOIN LATERAL jsonb_array_elements(e.value) v GROUP BY e.key,r36_evidence_source.row_key(e.key,v.value) HAVING count(*)<>1) THEN RAISE EXCEPTION 'CHECKPOINT_SOURCE_DUPLICATE'; END IF;
 ep=coalesce((SELECT epoch FROM public.r36_history_activated WHERE digest=head),0)+1;
 IF head IS NULL THEN
 SELECT scope_text::jsonb INTO scope FROM public.r36_wallet_execution_scopes WHERE scope_digest=p.worker_profile->>'executionScopeDigest' AND policy_digest=c.policy_digest AND source_wallet=c.source_wallet;
 IF scope IS NULL THEN RAISE EXCEPTION 'CHECKPOINT_SCOPE'; END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM public.r36_history_opening_scopes o WHERE o.policy_digest=c.policy_digest AND o.source_wallet=c.source_wallet AND o.scope_digest=point->>'executionScopeDigest') THEN RAISE EXCEPTION 'CHECKPOINT_OPENING_SCOPE_REQUIRED';
 END IF;
 -- Global uniqueness survives dropping the closed prefix from later reviews.
 FOR item IN SELECT value FROM jsonb_array_elements(net) LOOP
  IF item->'input'->>'sourceWallet'<>c.source_wallet AND item->'input'->>'destinationWallet'<>c.source_wallet THEN RAISE EXCEPTION 'CHECKPOINT_NETWORK_SCOPE'; END IF;
  IF (item->'record'->>'ledger')::numeric>c.cutoff_ledger OR (head IS NOT NULL AND (item->'record'->>'ledger')::numeric<=(SELECT cutoff_ledger FROM public.r36_history_checkpoints WHERE digest=head)) THEN RAISE EXCEPTION 'CHECKPOINT_NETWORK_RANGE'; END IF;
  INSERT INTO public.r36_history_network_records(source_wallet,tx_hash,operation_id,ledger,direction,record_text,checkpoint_digest)
  VALUES(c.source_wallet,item->'input'->>'preparedHash',item->>'operationId',(item->'record'->>'ledger')::numeric,CASE WHEN item->'input'->>'sourceWallet'=c.source_wallet THEN 'outgoing' ELSE 'incoming' END,item::text,c.digest);
 END LOOP;
 -- Every newly closed payment remains indexed against later settlement/refund
 -- overlap, receipt duplication and reuse of the original inbound identifier.
 FOR item IN SELECT value FROM jsonb_array_elements(entries) LOOP
  SELECT value INTO cp FROM jsonb_array_elements(rows->'settlements') WHERE value->>'payment_id'=item->>'paymentId';
  IF cp IS NULL OR (item->>'kind'='settlement' AND (cp->>'stage'<>'db_finalized' OR cp->>'a2u_txid' IS DISTINCT FROM item->>'transactionHash'))
  OR (item->>'kind'='refund' AND (cp->>'stage'<>'payment_identity' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(rows->'refunds') r WHERE r->>'refund_id'=item->>'operationId' AND r->>'payment_id'=item->>'paymentId' AND r->>'status'='completed' AND r->>'stage'='audit_recorded' AND r->>'refund_txid'=item->>'transactionHash')))
  OR item->>'kind' NOT IN ('settlement','refund') THEN RAISE EXCEPTION 'CHECKPOINT_TERMINAL_SOURCE'; END IF;
  INSERT INTO r36_evidence_source.closed_payments(payment_id,u2a_identifier,transaction_id,refund_id,checkpoint_digest)
  VALUES(item->>'paymentId',cp->>'u2a_identifier',CASE WHEN item->>'kind'='settlement' THEN item->>'entryId' END,CASE WHEN item->>'kind'='refund' THEN item->>'operationId' END,c.digest);
 END LOOP;
 INSERT INTO public.r36_history_activated(digest,policy_digest,source_wallet,epoch,source_protection_digest) VALUES(c.digest,c.policy_digest,c.source_wallet,ep,point->>'sourceRowsDigest');
 IF head IS NULL THEN
  INSERT INTO public.r36_history_opening_balances(policy_digest,source_wallet,merchant_id,opening_stroops,opening_unsettled_stroops,checkpoint_digest)
  SELECT c.policy_digest,c.source_wallet,b->>'merchant_id',(b->>'settled')::numeric*10000000,(b->>'unsettled')::numeric*10000000,c.digest
  FROM jsonb_array_elements(scope->'baseline'->'merchantBalances') b;
  INSERT INTO public.r36_history_opening_scopes VALUES(c.policy_digest,c.source_wallet,point->>'executionScopeDigest',c.digest);
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(credits) LOOP
  IF jsonb_typeof(item)<>'object' OR item->>'merchantUid' !~ '^[A-Za-z0-9_.:-]{1,128}$' OR item->>'creditStroops' !~ '^(0|[1-9][0-9]{0,29})$' THEN RAISE EXCEPTION 'CHECKPOINT_CREDIT_SHAPE'; END IF;
  SELECT value INTO balance FROM jsonb_array_elements(rows->'merchantBalances') b WHERE b->>'merchant_id'=item->>'merchantId';
  IF balance IS NULL THEN RAISE EXCEPTION 'CHECKPOINT_CREDIT_SOURCE'; END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(rows->'settlements') r WHERE r->>'merchant_id'=item->>'merchantId' AND r->>'merchant_uid'=item->>'merchantUid') AND NOT EXISTS(SELECT 1 FROM public.r36_history_credit_totals t WHERE t.policy_digest=c.policy_digest AND t.source_wallet=c.source_wallet AND t.merchant_id=item->>'merchantId' AND t.merchant_uid=item->>'merchantUid') THEN RAISE EXCEPTION 'CHECKPOINT_CREDIT_IDENTITY'; END IF;
  SELECT * INTO prior_credit FROM public.r36_history_credit_totals t WHERE t.policy_digest=c.policy_digest AND t.source_wallet=c.source_wallet AND t.merchant_uid=item->>'merchantUid' ORDER BY epoch DESC LIMIT 1;
  IF FOUND THEN opening=prior_credit.opening_stroops;IF prior_credit.merchant_id IS DISTINCT FROM item->>'merchantId' THEN RAISE EXCEPTION 'CHECKPOINT_MERCHANT_IDENTITY'; END IF;
  ELSE SELECT b.opening_stroops INTO opening FROM public.r36_history_opening_balances b WHERE b.policy_digest=c.policy_digest AND b.source_wallet=c.source_wallet AND b.merchant_id=item->>'merchantId';opening=coalesce(opening,0); END IF;
  IF (balance->>'settled')::numeric*10000000<>opening+(item->>'creditStroops')::numeric
  OR (item->>'creditStroops')::numeric<>coalesce(prior_credit.credit_stroops,0)+coalesce((SELECT sum((e->>'amountStroops')::numeric) FROM jsonb_array_elements(entries) e WHERE e->>'kind'='settlement' AND e->>'merchantUid'=item->>'merchantUid'),0)
  THEN RAISE EXCEPTION 'CHECKPOINT_CREDIT_RECONCILIATION'; END IF;
  INSERT INTO public.r36_history_credit_totals(policy_digest,source_wallet,merchant_uid,merchant_id,opening_stroops,epoch,credit_stroops,checkpoint_digest)
  VALUES(c.policy_digest,c.source_wallet,item->>'merchantUid',item->>'merchantId',opening,ep,(item->>'creditStroops')::numeric,c.digest);
 END LOOP;
 INSERT INTO r36_evidence_source.closed_rows(kind,row_key,checkpoint_digest)
 SELECT w.kind,w.row_key,c.digest FROM r36_evidence_source.work w WHERE
 (w.kind IN ('intents','settlements','refunds','refundAccounting','refundAudit') AND EXISTS(SELECT 1 FROM r36_evidence_source.closed_payments x WHERE x.checkpoint_digest=c.digest AND x.payment_id=w.projection->>'payment_id'))
 OR (w.kind='transactions' AND EXISTS(SELECT 1 FROM r36_evidence_source.closed_payments x WHERE x.checkpoint_digest=c.digest AND x.u2a_identifier=w.projection->>'payment_id'))
 OR (w.kind='receipts' AND EXISTS(SELECT 1 FROM r36_evidence_source.closed_payments x WHERE x.checkpoint_digest=c.digest AND x.transaction_id=w.projection->>'transaction_id'))
 OR (w.kind='authorityHistory' AND EXISTS(SELECT 1 FROM r36_evidence_source.closed_payments x WHERE x.payment_id=w.projection->>'owner_payment_id'))
 OR (head IS NULL AND (w.kind IN ('executionScopes','legacyHolds') OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(scope->'baseline'->w.kind,'[]'::jsonb)) b WHERE b=w.projection AND w.kind NOT IN ('merchantBalances','authorities'))));
 DELETE FROM r36_evidence_source.work w WHERE EXISTS(SELECT 1 FROM r36_evidence_source.closed_rows x WHERE x.kind=w.kind AND x.row_key=w.row_key)
 OR (w.kind='merchantBalances' AND (EXISTS(SELECT 1 FROM jsonb_array_elements(credits) b WHERE b->>'merchantId'=w.projection->>'merchant_id') OR (head IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(scope->'baseline'->'merchantBalances') b WHERE b=w.projection))));
 INSERT INTO public.r36_history_checkpoint_heads(policy_digest,source_wallet,digest) VALUES(c.policy_digest,c.source_wallet,c.digest)
 ON CONFLICT(policy_digest,source_wallet) DO UPDATE SET digest=EXCLUDED.digest;
 RETURN 'ACTIVATED';
END $$;
ALTER FUNCTION public.r36_activate_history_checkpoint(text,text,text,text,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_activate_history_checkpoint(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r36_activate_history_checkpoint(text,text,text,text,text) TO r36_issuer;

CREATE OR REPLACE FUNCTION public.r36_publish_history_fact(p_policy text,p_wallet text,p_closure text,p_point text,p_digest text,p_rows text,p_network text,p_entries text,p_credits text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE v text;BEGIN
 IF session_user<>'r36_issuer' THEN RAISE EXCEPTION 'CHECKPOINT_ISSUER_REQUIRED'; END IF;
 BEGIN
  v=public.r36_store_history_checkpoint(p_policy,p_wallet,p_closure,p_point,p_digest);
  IF v NOT IN ('RECORDED','REPLAYED') THEN RAISE EXCEPTION 'CHECKPOINT_STORE'; END IF;
  v=public.r36_activate_history_checkpoint(p_digest,p_rows,p_network,p_entries,p_credits);
  IF v NOT IN ('ACTIVATED','REPLAYED') THEN RAISE EXCEPTION 'CHECKPOINT_ACTIVATION'; END IF;
  RETURN jsonb_build_object('status','CHECKPOINT_COMMITTED','digest',p_digest);
 EXCEPTION WHEN OTHERS THEN
  -- PostgreSQL rolls back this subtransaction, including every source seal and
  -- the candidate. The previously verified closure outside it is unchanged.
  RETURN jsonb_build_object('status','DEFERRED_EXISTING_GUARDS_RETAINED','reason',CASE WHEN SQLERRM ~ '^[A-Z0-9_]{1,100}$' THEN SQLERRM ELSE 'CHECKPOINT_PUBLICATION_FAILED' END,'sqlState',SQLSTATE);
 END;
END $$;
ALTER FUNCTION public.r36_publish_history_fact(text,text,text,text,text,text,text,text,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_publish_history_fact(text,text,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r36_publish_history_fact(text,text,text,text,text,text,text,text,text) TO r36_issuer;
REVOKE EXECUTE ON FUNCTION public.r36_activate_history_checkpoint(text,text,text,text,text) FROM r36_issuer;
