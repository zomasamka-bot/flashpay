-- NOT_FOR_DEPLOY. Separate signer custody; no financial table grants or Runtime access.
BEGIN;
DO $$ BEGIN
 IF current_user<>session_user THEN RAISE EXCEPTION 'DIRECT_MIGRATION_SESSION_REQUIRED'; END IF;
 IF current_setting('flashpay.isolated_certificate_test',true) IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'ISOLATED_ONLY'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r36_signer_owner') THEN CREATE ROLE r36_signer_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r36_signer') THEN CREATE ROLE r36_signer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('r36_signer','r36_signer_owner') AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication OR rolinherit OR (rolname='r36_signer_owner' AND rolcanlogin))) THEN RAISE EXCEPTION 'UNSAFE_SIGNER_ROLE'; END IF;
 IF has_schema_privilege('r36_signer','public','CREATE') OR has_schema_privilege('r36_signer_owner','public','CREATE') THEN RAISE EXCEPTION 'SIGNER_PUBLIC_CREATE_FORBIDDEN'; END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN (VALUES('r36_signer'),('r36_signer_owner')) r(name) WHERE n.nspname='public' AND c.relkind IN ('r','p') AND (c.relname LIKE 'financial_%' OR c.relname LIKE 'r36_%' OR c.relname IN ('transactions','receipts','merchant_balances','refund_accounting_records','settlement_checkpoints','refund_checkpoints')) AND has_table_privilege(r.name,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) THEN RAISE EXCEPTION 'SIGNER_FINANCIAL_ACL_FORBIDDEN'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE u.rolname IN ('r36_signer','r36_signer_owner') OR (r.rolname IN ('r36_signer','r36_signer_owner') AND NOT (u.rolname=current_user AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option))) THEN RAISE EXCEPTION 'SIGNER_ROLE_MEMBERSHIP_FORBIDDEN'; END IF;
 -- PostgreSQL 17 grants a non-superuser creator ADMIN without SET/INHERIT.
 -- Temporarily allow ownership transfer to the dedicated NOLOGIN schema owner.
 IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
  EXECUTE format('GRANT r36_signer_owner TO %I WITH SET TRUE, INHERIT FALSE',current_user);
  PERFORM set_config('flashpay.signer_temporary_owner_grant','yes',true);
 END IF;
END $$;
CREATE SCHEMA r36_signing AUTHORIZATION r36_signer_owner;
SET LOCAL ROLE r36_signer_owner;
REVOKE ALL ON SCHEMA r36_signing FROM PUBLIC,r36_runtime,r36_issuer;
GRANT USAGE ON SCHEMA r36_signing TO r36_signer;
CREATE TABLE r36_signing.requests(
 idempotency_key text PRIMARY KEY CHECK(idempotency_key ~ '^[0-9a-f]{64}$'),
 issuer_id text NOT NULL,key_id text NOT NULL,policy_digest text NOT NULL CHECK(policy_digest ~ '^[0-9a-f]{64}$'),
 bytes_base64 text NOT NULL CHECK(length(bytes_base64) BETWEEN 4 AND 32768),
 public_key_pin text NOT NULL CHECK(public_key_pin ~ '^[0-9a-f]{64}$'),
 approved_by text NOT NULL CHECK(length(approved_by)>0),approval_digest text NOT NULL CHECK(approval_digest ~ '^[0-9a-f]{64}$'),
 valid_from bigint NOT NULL,valid_until bigint NOT NULL CHECK(valid_until>valid_from),revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE r36_signing.receipts(
 idempotency_key text PRIMARY KEY REFERENCES r36_signing.requests(idempotency_key),
 signature_base64 text NOT NULL CHECK(signature_base64 ~ '^[A-Za-z0-9+/]{86}==$'),
 signed_at timestamptz NOT NULL DEFAULT clock_timestamp(),signed_by text NOT NULL CHECK(signed_by='r36_signer')
);
ALTER TABLE r36_signing.requests OWNER TO r36_signer_owner;
ALTER TABLE r36_signing.receipts OWNER TO r36_signer_owner;
REVOKE ALL ON ALL TABLES IN SCHEMA r36_signing FROM PUBLIC,r36_runtime,r36_issuer,r36_signer;
CREATE FUNCTION r36_signing.immutable_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.revoked AND NOT NEW.revoked THEN RAISE EXCEPTION 'SIGNING_REVOCATION_PERMANENT'; END IF;
 IF to_jsonb(OLD)-'revoked' IS DISTINCT FROM to_jsonb(NEW)-'revoked' THEN RAISE EXCEPTION 'SIGNING_APPROVAL_IMMUTABLE'; END IF; RETURN NEW;
END $$;
ALTER FUNCTION r36_signing.immutable_request() OWNER TO r36_signer_owner;
REVOKE ALL ON FUNCTION r36_signing.immutable_request() FROM PUBLIC;
CREATE TRIGGER signing_request_immutable BEFORE UPDATE ON r36_signing.requests FOR EACH ROW EXECUTE FUNCTION r36_signing.immutable_request();
CREATE FUNCTION r36_signing.context(k text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r r36_signing.requests; n bigint; BEGIN
 IF session_user<>'r36_signer' THEN RETURN NULL; END IF;
 SELECT * INTO r FROM r36_signing.requests WHERE idempotency_key=k FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 n=floor(extract(epoch FROM clock_timestamp()));
 IF r.revoked OR n<r.valid_from OR n>=r.valid_until THEN RETURN NULL; END IF;
 RETURN to_jsonb(r)||jsonb_build_object('signature',(SELECT signature_base64 FROM r36_signing.receipts WHERE idempotency_key=k));
END $$;
CREATE FUNCTION r36_signing.record(k text,s text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c jsonb; old text; BEGIN
 c=r36_signing.context(k); IF c IS NULL THEN RAISE EXCEPTION 'SIGNING_NOT_APPROVED'; END IF;
 SELECT signature_base64 INTO old FROM r36_signing.receipts WHERE idempotency_key=k;
 IF FOUND THEN IF old=s THEN RETURN old; END IF; RAISE EXCEPTION 'SIGNING_REPLAY_CONFLICT'; END IF;
 INSERT INTO r36_signing.receipts(idempotency_key,signature_base64,signed_by) VALUES(k,s,session_user); RETURN s;
END $$;
ALTER FUNCTION r36_signing.context(text) OWNER TO r36_signer_owner;
ALTER FUNCTION r36_signing.record(text,text) OWNER TO r36_signer_owner;
REVOKE ALL ON FUNCTION r36_signing.context(text),r36_signing.record(text,text) FROM PUBLIC,r36_runtime,r36_issuer;
GRANT EXECUTE ON FUNCTION r36_signing.context(text),r36_signing.record(text,text) TO r36_signer;
RESET ROLE;
DO $$ BEGIN
 IF current_setting('flashpay.signer_temporary_owner_grant',true)='yes' THEN
  EXECUTE format('REVOKE r36_signer_owner FROM %I GRANTED BY %I',current_user,current_user);
 END IF;
END $$;
COMMIT;
