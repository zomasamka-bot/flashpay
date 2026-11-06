-- Narrow repair: a waiting wallet lock must not outlive certificate authority.
-- No role grants, trust enrollment, wallet activation, attempt reset or data DML.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
SET LOCAL search_path=pg_catalog,pg_temp;
DO $$ DECLARE body text; marker text:=' INSERT INTO public.financial_wallet_submission_attempts';
 migrator text:=session_user; temporary_set boolean:=false; temporary_create boolean:=false;
BEGIN
 IF current_user<>session_user THEN RAISE EXCEPTION 'DIRECT_MIGRATION_SESSION_REQUIRED'; END IF;
 IF current_setting('flashpay.isolated_certificate_test',true) IS DISTINCT FROM 'yes' THEN
  IF current_setting('neon.branch_id',true) IS DISTINCT FROM 'br-tiny-mode-aliatv40'
  OR current_database()<>'neondb'
  OR (SELECT count(*) FROM pg_roles WHERE rolname IN ('r36_runtime','r36_issuer','r36_signer') AND NOT rolcanlogin)<>3
  OR EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename IN ('r36_runtime','r36_issuer','r36_signer'))
  OR EXISTS(SELECT 1 FROM public.financial_wallet_activation WHERE state='enabled')
  THEN RAISE EXCEPTION 'TARGET_OR_FINANCIAL_HOLD_NOT_PROVEN'; END IF;
 END IF;
 SELECT prosrc INTO body FROM pg_proc WHERE oid='public.r36_claim_first_submission(text,text,text,text,text,text,text)'::regprocedure
  AND prosecdef AND proowner=(SELECT oid FROM pg_roles WHERE rolname='r36_owner')
  AND proconfig=ARRAY['search_path=pg_catalog, pg_temp'];
 IF encode(sha256(convert_to(body,'UTF8')),'hex') IS DISTINCT FROM '4c87f1ad7e681ad40ff3e253590e3685f34b5c6e98630d3859f874903edf7ebe'
 OR position(marker IN body)=0 THEN RAISE EXCEPTION 'UNEXPECTED_SUBMISSION_CONTRACT'; END IF;
 -- Preserve the original policy/request -> authority lock order. Check once to
 -- acquire policy locks, then lock the exact authority, then recheck wall time.
 body:=replace(body,marker,E' PERFORM 1 FROM public.financial_wallet_authorities a\n  WHERE a.network=p_network AND a.source_wallet=p_wallet AND a.owner_payment_id=p_payment\n   AND a.operation_kind=p_kind AND a.owner_operation_id=p_operation\n   AND a.prepared_tx_hash=p_hash AND a.prepared_sequence=p_seq AND a.state=\'prepared\'\n  FOR UPDATE;\n IF NOT FOUND OR public.r36_certificate_allows(p_network,p_wallet,p_payment,p_kind,p_operation,p_hash,p_seq) IS DISTINCT FROM true\n THEN RETURN false; END IF;\n'||marker);
 -- Neon creates the owner role with ADMIN but no SET/INHERIT for the migrator.
 -- Use a transaction-local ownership path; remove our own temporary membership
 -- and CREATE grant before commit. Runtime/issuer/signer privileges never change.
 IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
  IF NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.roleid=(SELECT oid FROM pg_roles WHERE rolname='r36_owner')
     AND m.member=(SELECT oid FROM pg_roles WHERE rolname=migrator) AND m.admin_option)
   OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.roleid=(SELECT oid FROM pg_roles WHERE rolname='r36_owner')
     AND m.member=(SELECT oid FROM pg_roles WHERE rolname=migrator) AND m.grantor=m.member)
  THEN RAISE EXCEPTION 'OWNER_ADMIN_PATH_NOT_APPROVED'; END IF;
  EXECUTE format('GRANT r36_owner TO %I WITH SET TRUE, INHERIT FALSE GRANTED BY %I',migrator,migrator);
  temporary_set:=true;
  temporary_create:=NOT has_schema_privilege('r36_owner','public','CREATE');
  IF temporary_create THEN GRANT CREATE ON SCHEMA public TO r36_owner; END IF;
  SET LOCAL ROLE r36_owner;
 END IF;
 EXECUTE 'CREATE OR REPLACE FUNCTION public.r36_claim_first_submission(p_network text,p_wallet text,p_payment text,p_kind text,p_operation text,p_hash text,p_seq text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS '||quote_literal(body);
 IF temporary_set THEN
  RESET ROLE;
  IF temporary_create THEN REVOKE CREATE ON SCHEMA public FROM r36_owner; END IF;
  EXECUTE format('REVOKE r36_owner FROM %I GRANTED BY %I',migrator,migrator);
 END IF;
END $$;
COMMIT;
