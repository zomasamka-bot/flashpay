-- PREPARATION ONLY. Never run automatically at app startup or production build.
-- This isolated draft store grants no R36 certificate, authority or financial right.
-- Existing public financial tables/functions/ACLs remain untouched.
BEGIN;
CREATE SCHEMA IF NOT EXISTS kernel_preparation;
REVOKE ALL ON SCHEMA kernel_preparation FROM PUBLIC;
CREATE TABLE IF NOT EXISTS kernel_preparation.policy_drafts (
  application_id text NOT NULL,
  network text NOT NULL CHECK (network IN ('Pi Testnet','Pi Network')),
  policy_id text NOT NULL,
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy)='object'),
  PRIMARY KEY (application_id, network, policy_id),
  CHECK (policy->>'schema' = 'MERCHANT_FEE_POLICY_V1'),
  CHECK (policy ?& ARRAY['schema','id','applicationId','network','payer','basisPoints','rounding','networkFeePayer','refund']),
  CHECK (policy - ARRAY['schema','id','applicationId','network','payer','basisPoints','rounding','networkFeePayer','refund'] = '{}'::jsonb),
  CHECK (NOT jsonb_path_exists(policy,'$.* ? (@ == null)')),
  CHECK (jsonb_typeof(policy->'id')='string' AND jsonb_typeof(policy->'applicationId')='string'),
  CHECK (application_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND policy_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  CHECK (policy->>'id'=policy_id AND policy->>'applicationId'=application_id AND policy->>'network'=network),
  CHECK (policy->>'payer'='merchant' AND policy->>'rounding'='floor' AND policy->>'networkFeePayer'='application'),
  CHECK (policy->>'refund'='full_customer_amount_no_earned_commission'),
  CHECK (jsonb_typeof(policy->'basisPoints')='number' AND (policy->>'basisPoints') ~ '^(0|[1-9][0-9]{0,3})$')
);
CREATE TABLE IF NOT EXISTS kernel_preparation.quote_drafts (
  application_id text NOT NULL, network text NOT NULL, payment_id text NOT NULL,
  merchant_uid text NOT NULL CHECK (merchant_uid ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'), policy_id text NOT NULL,
  CHECK (payment_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  gross_stroops bigint NOT NULL CHECK (gross_stroops BETWEEN 1 AND 10000000000000),
  net_stroops bigint NOT NULL CHECK (net_stroops > 0),
  commission_stroops bigint NOT NULL CHECK (commission_stroops >= 0),
  PRIMARY KEY(application_id, network, payment_id),
  FOREIGN KEY(application_id, network, policy_id) REFERENCES kernel_preparation.policy_drafts,
  CHECK (gross_stroops = net_stroops + commission_stroops)
);
CREATE OR REPLACE FUNCTION kernel_preparation.reject_draft_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'PREPARATION_SNAPSHOT_IMMUTABLE'; END $$;
DROP TRIGGER IF EXISTS policy_immutable ON kernel_preparation.policy_drafts;
CREATE TRIGGER policy_immutable BEFORE UPDATE OR DELETE ON kernel_preparation.policy_drafts
FOR EACH ROW EXECUTE FUNCTION kernel_preparation.reject_draft_mutation();
DROP TRIGGER IF EXISTS quote_immutable ON kernel_preparation.quote_drafts;
CREATE TRIGGER quote_immutable BEFORE UPDATE OR DELETE ON kernel_preparation.quote_drafts
FOR EACH ROW EXECUTE FUNCTION kernel_preparation.reject_draft_mutation();
CREATE OR REPLACE FUNCTION kernel_preparation.validate_quote_draft() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE p jsonb;
BEGIN
  SELECT policy INTO STRICT p FROM kernel_preparation.policy_drafts
  WHERE application_id=NEW.application_id AND network=NEW.network AND policy_id=NEW.policy_id;
  IF NEW.commission_stroops <> NEW.gross_stroops * (p->>'basisPoints')::bigint / 10000
     OR NEW.merchant_uid='' OR NEW.payment_id='' THEN RAISE EXCEPTION 'PREPARATION_QUOTE_MISMATCH'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS quote_validate ON kernel_preparation.quote_drafts;
CREATE TRIGGER quote_validate BEFORE INSERT ON kernel_preparation.quote_drafts
FOR EACH ROW EXECUTE FUNCTION kernel_preparation.validate_quote_draft();
REVOKE ALL ON ALL TABLES IN SCHEMA kernel_preparation FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA kernel_preparation FROM PUBLIC;
COMMIT;
