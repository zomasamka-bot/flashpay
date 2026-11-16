-- Exact source projections and a bounded work index. Original financial rows
-- remain in their original tables. Closed rows cannot change financially.
-- Install in one transaction before checkpoint enrollment; no authority is granted.
CREATE SCHEMA IF NOT EXISTS r36_evidence_source AUTHORIZATION r36_owner;
CREATE TABLE IF NOT EXISTS r36_evidence_source.installation (singleton boolean PRIMARY KEY CHECK(singleton),version text NOT NULL,source_timezone text NOT NULL DEFAULT 'UTC' CHECK(source_timezone IN ('UTC','Africa/Cairo')));
ALTER TABLE r36_evidence_source.installation ADD COLUMN IF NOT EXISTS source_timezone text NOT NULL DEFAULT 'UTC' CHECK(source_timezone IN ('UTC','Africa/Cairo'));
ALTER TABLE r36_evidence_source.installation OWNER TO r36_owner;
REVOKE ALL ON r36_evidence_source.installation FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
GRANT SELECT ON r36_evidence_source.installation TO r36_evidence_reader;
CREATE TABLE IF NOT EXISTS r36_evidence_source.work (
 kind text NOT NULL,row_key jsonb NOT NULL,projection jsonb NOT NULL,
 PRIMARY KEY(kind,row_key)
);
CREATE TABLE IF NOT EXISTS r36_evidence_source.closed_rows (
 kind text NOT NULL,row_key jsonb NOT NULL,checkpoint_digest text NOT NULL REFERENCES public.r36_history_checkpoints(digest),
 PRIMARY KEY(kind,row_key)
);
CREATE TABLE IF NOT EXISTS r36_evidence_source.closed_payments (
 payment_id text PRIMARY KEY,u2a_identifier text UNIQUE,transaction_id text UNIQUE,refund_id text UNIQUE,
 checkpoint_digest text NOT NULL REFERENCES public.r36_history_checkpoints(digest)
);
ALTER TABLE r36_evidence_source.work OWNER TO r36_owner;
ALTER TABLE r36_evidence_source.closed_rows OWNER TO r36_owner;
ALTER TABLE r36_evidence_source.closed_payments OWNER TO r36_owner;
REVOKE ALL ON r36_evidence_source.work,r36_evidence_source.closed_rows,r36_evidence_source.closed_payments FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
GRANT USAGE ON SCHEMA r36_evidence_source TO r36_evidence_reader,r36_issuer;
GRANT SELECT ON r36_evidence_source.work TO r36_issuer;
GRANT SELECT ON r36_evidence_source.work,r36_evidence_source.closed_rows,r36_evidence_source.closed_payments TO r36_evidence_reader;
CREATE OR REPLACE FUNCTION r36_evidence_source.iso_naive(p_value timestamp,p_zone text) RETURNS text LANGUAGE plpgsql STABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
DECLARE guessed timestamptz;chosen timestamptz;BEGIN
 IF p_zone NOT IN ('UTC','Africa/Cairo') THEN RAISE EXCEPTION 'HISTORY_SOURCE_TIMEZONE_UNQUALIFIED'; END IF;
 guessed=p_value AT TIME ZONE p_zone;
 -- Match the original JavaScript Date parsing: choose the earlier instant
 -- in an overlap; use the pre-transition offset for a skipped local hour.
 SELECT min(v) INTO chosen FROM (VALUES(guessed-interval '1 hour'),(guessed),(guessed+interval '1 hour')) x(v) WHERE v AT TIME ZONE p_zone=p_value;
 RETURN to_char(coalesce(chosen,guessed) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
END $$;
ALTER FUNCTION r36_evidence_source.iso_naive(timestamp,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION r36_evidence_source.iso_naive(timestamp,text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION r36_evidence_source.project(p_kind text,p_row jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE v jsonb;source_zone text;BEGIN SELECT source_timezone INTO source_zone FROM r36_evidence_source.installation WHERE singleton;source_zone=coalesce(source_zone,nullif(current_setting('flashpay.history_source_timezone',true),''),'UTC');IF source_zone NOT IN ('UTC','Africa/Cairo') THEN RAISE EXCEPTION 'HISTORY_SOURCE_TIMEZONE_UNQUALIFIED'; END IF;CASE p_kind
WHEN 'intents' THEN SELECT to_jsonb(p) INTO v FROM (SELECT payment_id,merchant_uid,merchant_id,customer_amount::text AS customer_amount,note,CASE WHEN pg_typeof(created_at)='timestamp without time zone'::regtype THEN r36_evidence_source.iso_naive(created_at::timestamp,source_zone) ELSE to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS created_at FROM jsonb_populate_record(NULL::public.payment_create_intents,p_row) r) p;
WHEN 'settlements' THEN SELECT to_jsonb(p) INTO v FROM (SELECT financial_contract,payment_id,stage,merchant_id,merchant_uid,payer_uid,customer_amount::text AS customer_amount,merchant_amount::text AS merchant_amount,app_commission::text AS app_commission,u2a_identifier,u2a_txid,CASE WHEN pg_typeof(u2a_verified_at)='timestamp without time zone'::regtype THEN r36_evidence_source.iso_naive(u2a_verified_at::timestamp,source_zone) ELSE to_char(u2a_verified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS u2a_verified_at,CASE WHEN pg_typeof(u2a_completed_at)='timestamp without time zone'::regtype THEN r36_evidence_source.iso_naive(u2a_completed_at::timestamp,source_zone) ELSE to_char(u2a_completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS u2a_completed_at,a2u_payment_id,a2u_from_address,a2u_to_address,prepared_envelope_xdr,prepared_tx_hash,prepared_sequence::text AS prepared_sequence,a2u_txid,horizon_fee_stroops::text AS horizon_fee_stroops,CASE WHEN pg_typeof(horizon_confirmed_at)='timestamp without time zone'::regtype THEN r36_evidence_source.iso_naive(horizon_confirmed_at::timestamp,source_zone) ELSE to_char(horizon_confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS horizon_confirmed_at,CASE WHEN pg_typeof(pi_completed_at)='timestamp without time zone'::regtype THEN r36_evidence_source.iso_naive(pi_completed_at::timestamp,source_zone) ELSE to_char(pi_completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS pi_completed_at,CASE WHEN pg_typeof(db_finalized_at)='timestamp without time zone'::regtype THEN r36_evidence_source.iso_naive(db_finalized_at::timestamp,source_zone) ELSE to_char(db_finalized_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS db_finalized_at FROM jsonb_populate_record(NULL::public.settlement_checkpoints,p_row) r) p;
WHEN 'refunds' THEN SELECT to_jsonb(p) INTO v FROM (SELECT refund_id,payment_id,idempotency_key,status,stage,payer_uid,CASE WHEN pg_typeof(payer_uid_verified_at)='timestamp without time zone'::regtype THEN r36_evidence_source.iso_naive(payer_uid_verified_at::timestamp,source_zone) ELSE to_char(payer_uid_verified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS payer_uid_verified_at,amount::text AS amount,currency,source_payment_status,source_settlement_state,refund_payment_id,refund_txid FROM jsonb_populate_record(NULL::public.refund_checkpoints,p_row) r) p;
WHEN 'transactions' THEN SELECT to_jsonb(p) INTO v FROM (SELECT id::text AS id,payment_id,merchant_id,merchant_uid,amount::text AS amount,currency,status,reference FROM jsonb_populate_record(NULL::public.transactions,p_row) r) p;
WHEN 'receipts' THEN SELECT to_jsonb(p) INTO v FROM (SELECT id::text AS id,transaction_id::text AS transaction_id,merchant_id,merchant_uid,amount::text AS amount,currency,txid,u2a_identifier,u2a_txid,a2u_identifier,a2u_txid,customer_amount::text AS customer_amount,merchant_amount::text AS merchant_amount,app_commission::text AS app_commission,horizon_fee_charged::text AS horizon_fee_charged,app_net_impact::text AS app_net_impact,settlement_status FROM jsonb_populate_record(NULL::public.receipts,p_row) r) p;
WHEN 'refundAccounting' THEN SELECT to_jsonb(p) INTO v FROM (SELECT refund_id,payment_id,refund_payment_id,refund_txid,payer_uid,amount::text AS amount,horizon_fee_stroops::text AS horizon_fee_stroops,currency FROM jsonb_populate_record(NULL::public.refund_accounting_records,p_row) r) p;
WHEN 'refundAudit' THEN SELECT to_jsonb(p) INTO v FROM (SELECT event_id,refund_id,payment_id,event_type,actor_type,idempotency_key,details FROM jsonb_populate_record(NULL::public.refund_audit_events,p_row) r WHERE event_type IN ('refund_blockchain_submit_prepared','refund_blockchain_submit_authorized','refund_projection_finalized')) p;
WHEN 'merchantBalances' THEN SELECT to_jsonb(p) INTO v FROM (SELECT merchant_id,settled::text AS settled,unsettled::text AS unsettled FROM jsonb_populate_record(NULL::public.merchant_balances,p_row) r) p;
WHEN 'authorities' THEN SELECT to_jsonb(p) INTO v FROM (SELECT network,source_wallet,owner_payment_id,operation_kind,owner_operation_id,prepared_tx_hash,prepared_sequence,state FROM jsonb_populate_record(NULL::public.financial_wallet_authorities,p_row) r) p;
WHEN 'authorityHistory' THEN SELECT to_jsonb(p) INTO v FROM (SELECT network,source_wallet,owner_payment_id,operation_kind,owner_operation_id,prepared_tx_hash,prepared_sequence,finality_evidence_digest FROM jsonb_populate_record(NULL::public.financial_wallet_authority_history,p_row) r) p;
WHEN 'executionScopes' THEN SELECT to_jsonb(p) INTO v FROM (SELECT scope_digest,policy_digest,source_wallet,scope_text FROM jsonb_populate_record(NULL::public.r36_wallet_execution_scopes,p_row) r) p;
WHEN 'legacyHolds' THEN SELECT to_jsonb(p) INTO v FROM (SELECT payment_id,network,kind,state,authorizes_new_rights,original_snapshot_sha256,to_char(held_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS held_at FROM jsonb_populate_record(NULL::public.r36_legacy_right_holds,p_row) r) p;
ELSE RAISE EXCEPTION 'HISTORY_SOURCE_KIND'; END CASE; IF p_kind='settlements' AND v->'financial_contract'='null'::jsonb THEN v=v-'financial_contract'; END IF; RETURN v; END $$;
CREATE OR REPLACE FUNCTION r36_evidence_source.row_key(p_kind text,p_row jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN CASE p_kind
WHEN 'intents' THEN RETURN jsonb_build_array(p_row->>'payment_id');
WHEN 'settlements' THEN RETURN jsonb_build_array(p_row->>'payment_id');
WHEN 'refunds' THEN RETURN jsonb_build_array(p_row->>'refund_id');
WHEN 'transactions' THEN RETURN jsonb_build_array(p_row->>'id');
WHEN 'receipts' THEN RETURN jsonb_build_array(p_row->>'id');
WHEN 'refundAccounting' THEN RETURN jsonb_build_array(p_row->>'refund_id');
WHEN 'refundAudit' THEN RETURN jsonb_build_array(p_row->>'event_id');
WHEN 'merchantBalances' THEN RETURN jsonb_build_array(p_row->>'merchant_id');
WHEN 'authorities' THEN RETURN jsonb_build_array(p_row->>'network',p_row->>'source_wallet');
WHEN 'authorityHistory' THEN RETURN jsonb_build_array(p_row->>'network',p_row->>'source_wallet',p_row->>'prepared_tx_hash');
WHEN 'executionScopes' THEN RETURN jsonb_build_array(p_row->>'scope_digest');
WHEN 'legacyHolds' THEN RETURN jsonb_build_array(p_row->>'payment_id');
ELSE RAISE EXCEPTION 'HISTORY_SOURCE_KIND'; END CASE; END $$;
CREATE OR REPLACE FUNCTION r36_evidence_source.track() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE k text=TG_ARGV[0];oldp jsonb;newp jsonb;oldkey jsonb;newkey jsonb;closed boolean;
BEGIN
 IF TG_OP='TRUNCATE' THEN RAISE EXCEPTION 'HISTORY_SOURCE_TRUNCATE_DENIED'; END IF;
 -- Original financial writers use READ COMMITTED. A fixed old writer snapshot
 -- must not miss a seal committed while waiting for the publication fence.
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'HISTORY_SOURCE_WRITE_ISOLATION_REQUIRED'; END IF;
 LOCK TABLE r36_evidence_source.work IN ROW EXCLUSIVE MODE;
 IF TG_OP<>'INSERT' THEN oldp=r36_evidence_source.project(k,to_jsonb(OLD));oldkey=r36_evidence_source.row_key(k,to_jsonb(OLD)); END IF;
 IF TG_OP<>'DELETE' THEN newp=r36_evidence_source.project(k,to_jsonb(NEW));newkey=r36_evidence_source.row_key(k,to_jsonb(NEW)); END IF;
 IF oldp IS NOT NULL AND EXISTS(SELECT 1 FROM r36_evidence_source.closed_rows WHERE closed_rows.kind=k AND row_key=oldkey) THEN
  IF TG_OP<>'UPDATE' OR newkey IS DISTINCT FROM oldkey OR newp IS DISTINCT FROM oldp THEN RAISE EXCEPTION 'CLOSED_FINANCIAL_SOURCE_IMMUTABLE'; END IF;
  RETURN NEW;
 END IF;
 IF newp IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM r36_evidence_source.closed_rows WHERE closed_rows.kind=k AND row_key=newkey) THEN RAISE EXCEPTION 'CLOSED_FINANCIAL_SOURCE_REINSERT'; END IF;
  IF (k IN ('intents','settlements','refunds','refundAccounting','refundAudit') AND EXISTS(SELECT 1 FROM r36_evidence_source.closed_payments c WHERE c.payment_id=newp->>'payment_id'))
  OR (k='settlements' AND EXISTS(SELECT 1 FROM r36_evidence_source.closed_payments c WHERE c.u2a_identifier=newp->>'u2a_identifier'))
  OR (k='transactions' AND EXISTS(SELECT 1 FROM r36_evidence_source.closed_payments c WHERE c.u2a_identifier=newp->>'payment_id'))
  OR (k='receipts' AND EXISTS(SELECT 1 FROM r36_evidence_source.closed_payments c WHERE c.transaction_id=newp->>'transaction_id' OR c.u2a_identifier=newp->>'u2a_identifier'))
  THEN RAISE EXCEPTION 'CLOSED_PAYMENT_CANNOT_GAIN_NEW_FINANCIAL_ROWS'; END IF;
 END IF;
 IF oldkey IS NOT NULL AND (newp IS NULL OR oldkey IS DISTINCT FROM newkey) THEN DELETE FROM r36_evidence_source.work w WHERE w.kind=k AND w.row_key=oldkey; END IF;
 IF newp IS NOT NULL THEN
  INSERT INTO r36_evidence_source.work(kind,row_key,projection) VALUES(k,newkey,newp)
  ON CONFLICT ON CONSTRAINT work_pkey DO UPDATE SET projection=EXCLUDED.projection WHERE work.projection IS DISTINCT FROM EXCLUDED.projection;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
ALTER FUNCTION r36_evidence_source.project(text,jsonb) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION r36_evidence_source.project(text,jsonb) FROM PUBLIC;
ALTER FUNCTION r36_evidence_source.row_key(text,jsonb) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION r36_evidence_source.row_key(text,jsonb) FROM PUBLIC;
ALTER FUNCTION r36_evidence_source.track() OWNER TO r36_owner;
REVOKE ALL ON FUNCTION r36_evidence_source.track() FROM PUBLIC;
-- Locks prevent trigger/backfill races. A repeat install never resurrects closed work.
LOCK TABLE public.payment_create_intents IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.settlement_checkpoints IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.refund_checkpoints IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.transactions IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.receipts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.refund_accounting_records IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.refund_audit_events IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.merchant_balances IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.financial_wallet_authorities IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.financial_wallet_authority_history IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.r36_wallet_execution_scopes IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.r36_legacy_right_holds IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='r36_track_history_source' AND tgrelid='public.payment_create_intents'::regclass) THEN
 CREATE TRIGGER r36_track_history_source AFTER INSERT OR UPDATE OR DELETE ON public.payment_create_intents FOR EACH ROW EXECUTE FUNCTION r36_evidence_source.track('intents');
 CREATE TRIGGER r36_track_history_truncate BEFORE TRUNCATE ON public.payment_create_intents FOR EACH STATEMENT EXECUTE FUNCTION r36_evidence_source.track('intents');
 END IF; END $$;
 INSERT INTO r36_evidence_source.work(kind,row_key,projection)
 SELECT 'intents',r36_evidence_source.row_key('intents',to_jsonb(r)),p.v FROM public.payment_create_intents r CROSS JOIN LATERAL (SELECT r36_evidence_source.project('intents',to_jsonb(r)) v) p
 WHERE p.v IS NOT NULL AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.installation WHERE singleton) AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.closed_rows c WHERE c.kind='intents' AND c.row_key=r36_evidence_source.row_key('intents',to_jsonb(r)))
 ON CONFLICT ON CONSTRAINT work_pkey DO UPDATE SET projection=EXCLUDED.projection;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='r36_track_history_source' AND tgrelid='public.settlement_checkpoints'::regclass) THEN
 CREATE TRIGGER r36_track_history_source AFTER INSERT OR UPDATE OR DELETE ON public.settlement_checkpoints FOR EACH ROW EXECUTE FUNCTION r36_evidence_source.track('settlements');
 CREATE TRIGGER r36_track_history_truncate BEFORE TRUNCATE ON public.settlement_checkpoints FOR EACH STATEMENT EXECUTE FUNCTION r36_evidence_source.track('settlements');
 END IF; END $$;
 INSERT INTO r36_evidence_source.work(kind,row_key,projection)
 SELECT 'settlements',r36_evidence_source.row_key('settlements',to_jsonb(r)),p.v FROM public.settlement_checkpoints r CROSS JOIN LATERAL (SELECT r36_evidence_source.project('settlements',to_jsonb(r)) v) p
 WHERE p.v IS NOT NULL AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.installation WHERE singleton) AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.closed_rows c WHERE c.kind='settlements' AND c.row_key=r36_evidence_source.row_key('settlements',to_jsonb(r)))
 ON CONFLICT ON CONSTRAINT work_pkey DO UPDATE SET projection=EXCLUDED.projection;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='r36_track_history_source' AND tgrelid='public.refund_checkpoints'::regclass) THEN
 CREATE TRIGGER r36_track_history_source AFTER INSERT OR UPDATE OR DELETE ON public.refund_checkpoints FOR EACH ROW EXECUTE FUNCTION r36_evidence_source.track('refunds');
 CREATE TRIGGER r36_track_history_truncate BEFORE TRUNCATE ON public.refund_checkpoints FOR EACH STATEMENT EXECUTE FUNCTION r36_evidence_source.track('refunds');
 END IF; END $$;
 INSERT INTO r36_evidence_source.work(kind,row_key,projection)
 SELECT 'refunds',r36_evidence_source.row_key('refunds',to_jsonb(r)),p.v FROM public.refund_checkpoints r CROSS JOIN LATERAL (SELECT r36_evidence_source.project('refunds',to_jsonb(r)) v) p
 WHERE p.v IS NOT NULL AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.installation WHERE singleton) AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.closed_rows c WHERE c.kind='refunds' AND c.row_key=r36_evidence_source.row_key('refunds',to_jsonb(r)))
 ON CONFLICT ON CONSTRAINT work_pkey DO UPDATE SET projection=EXCLUDED.projection;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='r36_track_history_source' AND tgrelid='public.transactions'::regclass) THEN
 CREATE TRIGGER r36_track_history_source AFTER INSERT OR UPDATE OR DELETE ON public.transactions FOR EACH ROW EXECUTE FUNCTION r36_evidence_source.track('transactions');
 CREATE TRIGGER r36_track_history_truncate BEFORE TRUNCATE ON public.transactions FOR EACH STATEMENT EXECUTE FUNCTION r36_evidence_source.track('transactions');
 END IF; END $$;
 INSERT INTO r36_evidence_source.work(kind,row_key,projection)
 SELECT 'transactions',r36_evidence_source.row_key('transactions',to_jsonb(r)),p.v FROM public.transactions r CROSS JOIN LATERAL (SELECT r36_evidence_source.project('transactions',to_jsonb(r)) v) p
 WHERE p.v IS NOT NULL AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.installation WHERE singleton) AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.closed_rows c WHERE c.kind='transactions' AND c.row_key=r36_evidence_source.row_key('transactions',to_jsonb(r)))
 ON CONFLICT ON CONSTRAINT work_pkey DO UPDATE SET projection=EXCLUDED.projection;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='r36_track_history_source' AND tgrelid='public.receipts'::regclass) THEN
 CREATE TRIGGER r36_track_history_source AFTER INSERT OR UPDATE OR DELETE ON public.receipts FOR EACH ROW EXECUTE FUNCTION r36_evidence_source.track('receipts');
 CREATE TRIGGER r36_track_history_truncate BEFORE TRUNCATE ON public.receipts FOR EACH STATEMENT EXECUTE FUNCTION r36_evidence_source.track('receipts');
 END IF; END $$;
 INSERT INTO r36_evidence_source.work(kind,row_key,projection)
 SELECT 'receipts',r36_evidence_source.row_key('receipts',to_jsonb(r)),p.v FROM public.receipts r CROSS JOIN LATERAL (SELECT r36_evidence_source.project('receipts',to_jsonb(r)) v) p
 WHERE p.v IS NOT NULL AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.installation WHERE singleton) AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.closed_rows c WHERE c.kind='receipts' AND c.row_key=r36_evidence_source.row_key('receipts',to_jsonb(r)))
 ON CONFLICT ON CONSTRAINT work_pkey DO UPDATE SET projection=EXCLUDED.projection;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='r36_track_history_source' AND tgrelid='public.refund_accounting_records'::regclass) THEN
 CREATE TRIGGER r36_track_history_source AFTER INSERT OR UPDATE OR DELETE ON public.refund_accounting_records FOR EACH ROW EXECUTE FUNCTION r36_evidence_source.track('refundAccounting');
 CREATE TRIGGER r36_track_history_truncate BEFORE TRUNCATE ON public.refund_accounting_records FOR EACH STATEMENT EXECUTE FUNCTION r36_evidence_source.track('refundAccounting');
 END IF; END $$;
 INSERT INTO r36_evidence_source.work(kind,row_key,projection)
 SELECT 'refundAccounting',r36_evidence_source.row_key('refundAccounting',to_jsonb(r)),p.v FROM public.refund_accounting_records r CROSS JOIN LATERAL (SELECT r36_evidence_source.project('refundAccounting',to_jsonb(r)) v) p
 WHERE p.v IS NOT NULL AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.installation WHERE singleton) AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.closed_rows c WHERE c.kind='refundAccounting' AND c.row_key=r36_evidence_source.row_key('refundAccounting',to_jsonb(r)))
 ON CONFLICT ON CONSTRAINT work_pkey DO UPDATE SET projection=EXCLUDED.projection;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='r36_track_history_source' AND tgrelid='public.refund_audit_events'::regclass) THEN
 CREATE TRIGGER r36_track_history_source AFTER INSERT OR UPDATE OR DELETE ON public.refund_audit_events FOR EACH ROW EXECUTE FUNCTION r36_evidence_source.track('refundAudit');
 CREATE TRIGGER r36_track_history_truncate BEFORE TRUNCATE ON public.refund_audit_events FOR EACH STATEMENT EXECUTE FUNCTION r36_evidence_source.track('refundAudit');
 END IF; END $$;
 INSERT INTO r36_evidence_source.work(kind,row_key,projection)
 SELECT 'refundAudit',r36_evidence_source.row_key('refundAudit',to_jsonb(r)),p.v FROM public.refund_audit_events r CROSS JOIN LATERAL (SELECT r36_evidence_source.project('refundAudit',to_jsonb(r)) v) p
 WHERE p.v IS NOT NULL AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.installation WHERE singleton) AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.closed_rows c WHERE c.kind='refundAudit' AND c.row_key=r36_evidence_source.row_key('refundAudit',to_jsonb(r)))
 ON CONFLICT ON CONSTRAINT work_pkey DO UPDATE SET projection=EXCLUDED.projection;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='r36_track_history_source' AND tgrelid='public.merchant_balances'::regclass) THEN
 CREATE TRIGGER r36_track_history_source AFTER INSERT OR UPDATE OR DELETE ON public.merchant_balances FOR EACH ROW EXECUTE FUNCTION r36_evidence_source.track('merchantBalances');
 CREATE TRIGGER r36_track_history_truncate BEFORE TRUNCATE ON public.merchant_balances FOR EACH STATEMENT EXECUTE FUNCTION r36_evidence_source.track('merchantBalances');
 END IF; END $$;
 INSERT INTO r36_evidence_source.work(kind,row_key,projection)
 SELECT 'merchantBalances',r36_evidence_source.row_key('merchantBalances',to_jsonb(r)),p.v FROM public.merchant_balances r CROSS JOIN LATERAL (SELECT r36_evidence_source.project('merchantBalances',to_jsonb(r)) v) p
 WHERE p.v IS NOT NULL AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.installation WHERE singleton) AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.closed_rows c WHERE c.kind='merchantBalances' AND c.row_key=r36_evidence_source.row_key('merchantBalances',to_jsonb(r)))
 ON CONFLICT ON CONSTRAINT work_pkey DO UPDATE SET projection=EXCLUDED.projection;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='r36_track_history_source' AND tgrelid='public.financial_wallet_authorities'::regclass) THEN
 CREATE TRIGGER r36_track_history_source AFTER INSERT OR UPDATE OR DELETE ON public.financial_wallet_authorities FOR EACH ROW EXECUTE FUNCTION r36_evidence_source.track('authorities');
 CREATE TRIGGER r36_track_history_truncate BEFORE TRUNCATE ON public.financial_wallet_authorities FOR EACH STATEMENT EXECUTE FUNCTION r36_evidence_source.track('authorities');
 END IF; END $$;
 INSERT INTO r36_evidence_source.work(kind,row_key,projection)
 SELECT 'authorities',r36_evidence_source.row_key('authorities',to_jsonb(r)),p.v FROM public.financial_wallet_authorities r CROSS JOIN LATERAL (SELECT r36_evidence_source.project('authorities',to_jsonb(r)) v) p
 WHERE p.v IS NOT NULL AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.installation WHERE singleton) AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.closed_rows c WHERE c.kind='authorities' AND c.row_key=r36_evidence_source.row_key('authorities',to_jsonb(r)))
 ON CONFLICT ON CONSTRAINT work_pkey DO UPDATE SET projection=EXCLUDED.projection;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='r36_track_history_source' AND tgrelid='public.financial_wallet_authority_history'::regclass) THEN
 CREATE TRIGGER r36_track_history_source AFTER INSERT OR UPDATE OR DELETE ON public.financial_wallet_authority_history FOR EACH ROW EXECUTE FUNCTION r36_evidence_source.track('authorityHistory');
 CREATE TRIGGER r36_track_history_truncate BEFORE TRUNCATE ON public.financial_wallet_authority_history FOR EACH STATEMENT EXECUTE FUNCTION r36_evidence_source.track('authorityHistory');
 END IF; END $$;
 INSERT INTO r36_evidence_source.work(kind,row_key,projection)
 SELECT 'authorityHistory',r36_evidence_source.row_key('authorityHistory',to_jsonb(r)),p.v FROM public.financial_wallet_authority_history r CROSS JOIN LATERAL (SELECT r36_evidence_source.project('authorityHistory',to_jsonb(r)) v) p
 WHERE p.v IS NOT NULL AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.installation WHERE singleton) AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.closed_rows c WHERE c.kind='authorityHistory' AND c.row_key=r36_evidence_source.row_key('authorityHistory',to_jsonb(r)))
 ON CONFLICT ON CONSTRAINT work_pkey DO UPDATE SET projection=EXCLUDED.projection;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='r36_track_history_source' AND tgrelid='public.r36_wallet_execution_scopes'::regclass) THEN
 CREATE TRIGGER r36_track_history_source AFTER INSERT OR UPDATE OR DELETE ON public.r36_wallet_execution_scopes FOR EACH ROW EXECUTE FUNCTION r36_evidence_source.track('executionScopes');
 CREATE TRIGGER r36_track_history_truncate BEFORE TRUNCATE ON public.r36_wallet_execution_scopes FOR EACH STATEMENT EXECUTE FUNCTION r36_evidence_source.track('executionScopes');
 END IF; END $$;
 INSERT INTO r36_evidence_source.work(kind,row_key,projection)
 SELECT 'executionScopes',r36_evidence_source.row_key('executionScopes',to_jsonb(r)),p.v FROM public.r36_wallet_execution_scopes r CROSS JOIN LATERAL (SELECT r36_evidence_source.project('executionScopes',to_jsonb(r)) v) p
 WHERE p.v IS NOT NULL AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.installation WHERE singleton) AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.closed_rows c WHERE c.kind='executionScopes' AND c.row_key=r36_evidence_source.row_key('executionScopes',to_jsonb(r)))
 ON CONFLICT ON CONSTRAINT work_pkey DO UPDATE SET projection=EXCLUDED.projection;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='r36_track_history_source' AND tgrelid='public.r36_legacy_right_holds'::regclass) THEN
 CREATE TRIGGER r36_track_history_source AFTER INSERT OR UPDATE OR DELETE ON public.r36_legacy_right_holds FOR EACH ROW EXECUTE FUNCTION r36_evidence_source.track('legacyHolds');
 CREATE TRIGGER r36_track_history_truncate BEFORE TRUNCATE ON public.r36_legacy_right_holds FOR EACH STATEMENT EXECUTE FUNCTION r36_evidence_source.track('legacyHolds');
 END IF; END $$;
 INSERT INTO r36_evidence_source.work(kind,row_key,projection)
 SELECT 'legacyHolds',r36_evidence_source.row_key('legacyHolds',to_jsonb(r)),p.v FROM public.r36_legacy_right_holds r CROSS JOIN LATERAL (SELECT r36_evidence_source.project('legacyHolds',to_jsonb(r)) v) p
 WHERE p.v IS NOT NULL AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.installation WHERE singleton) AND NOT EXISTS(SELECT 1 FROM r36_evidence_source.closed_rows c WHERE c.kind='legacyHolds' AND c.row_key=r36_evidence_source.row_key('legacyHolds',to_jsonb(r)))
 ON CONFLICT ON CONSTRAINT work_pkey DO UPDATE SET projection=EXCLUDED.projection;
GRANT SELECT ON r36_evidence_source.payment_create_intents TO r36_evidence_reader;
GRANT SELECT ON r36_evidence_source.settlement_checkpoints TO r36_evidence_reader;
GRANT SELECT ON r36_evidence_source.refund_checkpoints TO r36_evidence_reader;
GRANT SELECT ON r36_evidence_source.transactions TO r36_evidence_reader;
GRANT SELECT ON r36_evidence_source.receipts TO r36_evidence_reader;
GRANT SELECT ON r36_evidence_source.refund_accounting_records TO r36_evidence_reader;
GRANT SELECT ON r36_evidence_source.refund_audit_events TO r36_evidence_reader;
GRANT SELECT ON r36_evidence_source.merchant_balances TO r36_evidence_reader;
GRANT SELECT ON r36_evidence_source.financial_wallet_authorities TO r36_evidence_reader;
GRANT SELECT ON r36_evidence_source.financial_wallet_authority_history TO r36_evidence_reader;
GRANT SELECT ON r36_evidence_source.r36_wallet_execution_scopes TO r36_evidence_reader;
GRANT SELECT ON r36_evidence_source.r36_legacy_right_holds TO r36_evidence_reader;
INSERT INTO r36_evidence_source.installation(singleton,version,source_timezone) VALUES(true,'R36_SOURCE_INDEX_V1',coalesce(nullif(current_setting('flashpay.history_source_timezone',true),''),'UTC')) ON CONFLICT(singleton) DO NOTHING;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='r36_evidence_source.installation'::regclass AND tgname='r36_preserve_source_format') THEN
 CREATE TRIGGER r36_preserve_source_format BEFORE UPDATE OR DELETE ON r36_evidence_source.installation FOR EACH ROW EXECUTE FUNCTION public.r36_preserve_history_checkpoint();
 CREATE TRIGGER r36_preserve_source_format_truncate BEFORE TRUNCATE ON r36_evidence_source.installation FOR EACH STATEMENT EXECUTE FUNCTION public.r36_preserve_history_checkpoint();
 END IF; END $$;
