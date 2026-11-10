-- Private queue/policy reads only. No role LOGIN, membership, DML, certificate,
-- wallet activation, resubmission, policy enablement or authority is granted.
BEGIN;
SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF session_user<>'neondb_owner' OR current_database()<>'neondb'
 OR (current_setting('neon.branch_id',true) IS DISTINCT FROM 'br-tiny-mode-aliatv40'
 AND current_setting('flashpay.isolated_certificate_test',true) IS DISTINCT FROM 'yes')
 OR to_regclass('public.r36_prepared_evidence_candidates') IS NULL
 OR has_schema_privilege('r36_owner','public','CREATE')
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='r36_owner'::regrole AND member=session_user::regrole AND grantor=member)
 THEN RAISE EXCEPTION 'DISPATCH_READER_TARGET_OR_BASELINE'; END IF;
END $$;
GRANT r36_owner TO neondb_owner WITH INHERIT FALSE, SET TRUE;
SET LOCAL ROLE r36_owner;
GRANT SELECT (policy_digest,enabled,revoked,valid_from,valid_until,max_age_seconds,revocation_checked_at,revocation_valid_until,approval_record_digest,worker_profile)
 ON public.r36_certificate_policies TO r36_evidence_reader;
GRANT SELECT (payment_id,policy_digest,payer_wallet,retired_by_payment_id)
 ON public.r36_testnet_ingress_reservations TO r36_evidence_reader;
RESET ROLE;
REVOKE r36_owner FROM neondb_owner GRANTED BY neondb_owner;
COMMIT;
