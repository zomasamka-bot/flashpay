-- NOT_FOR_DEPLOY. New signer extension only; never removes an issued signature.
BEGIN;
DO $$ BEGIN
 IF current_user<>session_user OR current_setting('flashpay.isolated_certificate_test',true) IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'ISOLATED_DIRECT_MIGRATION_ONLY'; END IF;
 IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
  EXECUTE format('GRANT r36_signer_owner TO %I WITH SET TRUE, INHERIT FALSE',current_user);
  PERFORM set_config('flashpay.signer_rollback_temporary_grant','yes',true);
 END IF;
END $$;
SET LOCAL ROLE r36_signer_owner;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM r36_signing.requests) OR EXISTS(SELECT 1 FROM r36_signing.receipts) THEN RAISE EXCEPTION 'SIGNER_NOT_EMPTY_PRESERVE_HISTORY'; END IF;
END $$;
DROP SCHEMA r36_signing CASCADE;
RESET ROLE;
DO $$ BEGIN
 IF current_setting('flashpay.signer_rollback_temporary_grant',true)='yes' THEN
  EXECUTE format('REVOKE r36_signer_owner FROM %I GRANTED BY %I',current_user,current_user);
 END IF;
END $$;
DROP ROLE r36_signer;
DROP ROLE r36_signer_owner;
COMMIT;
