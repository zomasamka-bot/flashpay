-- Read-only source custody prerequisite; never enables financial execution.
-- Install transactionally as neondb_owner on the exact authorized production branch.
-- No password is provisioned and the role remains NOLOGIN. New credentials require
-- a separately protected service deployment; this script issues no certificate.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF current_database()<>'neondb' OR session_user<>'neondb_owner' OR current_user<>session_user
 OR current_setting('neon.branch_id',true) IS DISTINCT FROM 'br-tiny-mode-aliatv40'
 OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r36_evidence_reader')
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('r36_runtime','r36_issuer','r36_signer') AND rolcanlogin)
 OR EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename IN ('r36_runtime','r36_issuer','r36_signer'))
 OR (SELECT count(*) FROM pg_roles WHERE rolname IN ('r36_runtime','r36_issuer','r36_signer'))<>3
 OR NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='r36_owner'::regrole AND member=current_user::regrole AND admin_option)
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='r36_owner'::regrole AND member=current_user::regrole AND grantor=member)
 THEN RAISE EXCEPTION 'READER_TARGET_BASELINE_OR_ROLE_NOT_PROVEN'; END IF;
END $$;
CREATE ROLE r36_evidence_reader NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
ALTER ROLE r36_evidence_reader SET default_transaction_read_only=on;
ALTER ROLE r36_evidence_reader SET statement_timeout='30s';
ALTER ROLE r36_evidence_reader SET lock_timeout='3s';
ALTER ROLE r36_evidence_reader SET idle_in_transaction_session_timeout='30s';
ALTER ROLE r36_evidence_reader SET search_path=pg_catalog;
GRANT CONNECT ON DATABASE neondb TO r36_evidence_reader;
GRANT USAGE ON SCHEMA public TO r36_evidence_reader;
GRANT SELECT (payment_id,merchant_uid,merchant_id,customer_amount,note,created_at) ON TABLE public.payment_create_intents TO r36_evidence_reader;
GRANT SELECT (payment_id,stage,merchant_id,merchant_uid,payer_uid,customer_amount,merchant_amount,app_commission,u2a_identifier,u2a_txid,u2a_verified_at,u2a_completed_at,a2u_payment_id,a2u_from_address,a2u_to_address,prepared_envelope_xdr,prepared_tx_hash,prepared_sequence,a2u_txid,horizon_fee_stroops,horizon_confirmed_at,pi_completed_at,db_finalized_at) ON TABLE public.settlement_checkpoints TO r36_evidence_reader;
GRANT SELECT (refund_id,payment_id,idempotency_key,status,stage,payer_uid,payer_uid_verified_at,amount,currency,source_payment_status,source_settlement_state,refund_payment_id,refund_txid) ON TABLE public.refund_checkpoints TO r36_evidence_reader;
GRANT SELECT (id,payment_id,merchant_id,merchant_uid,amount,currency,status,reference) ON TABLE public.transactions TO r36_evidence_reader;
GRANT SELECT (id,transaction_id,merchant_id,merchant_uid,amount,currency,txid,u2a_identifier,u2a_txid,a2u_identifier,a2u_txid,customer_amount,merchant_amount,app_commission,horizon_fee_charged,app_net_impact,settlement_status) ON TABLE public.receipts TO r36_evidence_reader;
GRANT SELECT (refund_id,payment_id,refund_payment_id,refund_txid,payer_uid,amount,horizon_fee_stroops,currency) ON TABLE public.refund_accounting_records TO r36_evidence_reader;
GRANT SELECT (event_id,refund_id,payment_id,event_type,actor_type,idempotency_key,details) ON TABLE public.refund_audit_events TO r36_evidence_reader;
GRANT SELECT (merchant_id,settled,unsettled) ON TABLE public.merchant_balances TO r36_evidence_reader;
GRANT r36_owner TO neondb_owner WITH INHERIT FALSE,SET TRUE;
SET LOCAL ROLE r36_owner;
GRANT SELECT (network,source_wallet,owner_payment_id,operation_kind,owner_operation_id,prepared_tx_hash,prepared_sequence,state) ON TABLE public.financial_wallet_authorities TO r36_evidence_reader;
GRANT SELECT (network,source_wallet,owner_payment_id,operation_kind,owner_operation_id,prepared_tx_hash,prepared_sequence,finality_evidence_digest) ON TABLE public.financial_wallet_authority_history TO r36_evidence_reader;
RESET ROLE;
REVOKE r36_owner FROM neondb_owner GRANTED BY neondb_owner;

DO $$ DECLARE r oid:='r36_evidence_reader'::regrole; BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE oid=r AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR rolinherit))
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r)
 OR has_database_privilege(r,current_database(),'CREATE')
 OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public','r36_signing','r36_registration') AND has_schema_privilege(r,n.oid,'CREATE'))
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','r36_signing','r36_registration') AND c.relkind IN ('r','p','v','m','f')
   AND (has_table_privilege(r,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
        OR has_any_column_privilege(r,c.oid,'INSERT,UPDATE,REFERENCES')))
 OR EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
   WHERE n.nspname IN ('public','r36_signing','r36_registration') AND has_function_privilege(r,f.oid,'EXECUTE'))
 THEN RAISE EXCEPTION 'READER_LEAST_PRIVILEGE_NOT_PROVEN'; END IF;
END $$;
COMMIT;
