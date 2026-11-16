-- Separate, protected proof-format enrollment. Never mutate the original policy.
CREATE TABLE IF NOT EXISTS public.r36_history_enrollments (
 policy_digest text NOT NULL REFERENCES public.r36_certificate_policies(policy_digest),source_wallet text NOT NULL,
 version text NOT NULL CHECK(version='R36_CERTIFIED_HISTORY_CHECKPOINT_V1'),approval_digest text NOT NULL CHECK(approval_digest ~ '^[0-9a-f]{64}$'),
 revoked boolean NOT NULL DEFAULT false,PRIMARY KEY(policy_digest,source_wallet)
);
ALTER TABLE public.r36_history_enrollments OWNER TO r36_owner;
REVOKE ALL ON public.r36_history_enrollments FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
GRANT SELECT ON public.r36_history_enrollments TO r36_issuer,r36_evidence_reader;
-- Historical fact index only. Activation is separate and cannot occur merely
-- because a digest or a syntactically valid checkpoint has been supplied.
CREATE TABLE IF NOT EXISTS public.r36_history_checkpoints (
 digest text PRIMARY KEY CHECK(digest ~ '^[0-9a-f]{64}$'),
 policy_digest text NOT NULL REFERENCES public.r36_certificate_policies(policy_digest),
 source_wallet text NOT NULL CHECK(source_wallet ~ '^G[A-Z2-7]{55}$'),
 parent_digest text REFERENCES public.r36_history_checkpoints(digest),
 closure_digest text NOT NULL REFERENCES public.r36_prior_closure_receipts(payload_digest),
 cutoff_ledger numeric(30,0) NOT NULL, closing_sequence numeric(30,0) NOT NULL,
 checkpoint_text text NOT NULL CHECK(octet_length(checkpoint_text)<=100000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revoked boolean NOT NULL DEFAULT false,
 CHECK(digest=encode(sha256(convert_to(checkpoint_text,'UTF8')),'hex'))
);
ALTER TABLE public.r36_history_checkpoints OWNER TO r36_owner;
CREATE INDEX IF NOT EXISTS r36_history_checkpoints_parent ON public.r36_history_checkpoints(parent_digest);
CREATE INDEX IF NOT EXISTS r36_history_checkpoints_closure ON public.r36_history_checkpoints(closure_digest);
CREATE TABLE IF NOT EXISTS public.r36_history_activated (
 digest text PRIMARY KEY REFERENCES public.r36_history_checkpoints(digest),
 policy_digest text NOT NULL,source_wallet text NOT NULL,epoch bigint NOT NULL CHECK(epoch>0),
 source_protection_digest text NOT NULL CHECK(source_protection_digest ~ '^[0-9a-f]{64}$'),
 activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(policy_digest,source_wallet,epoch)
);
ALTER TABLE public.r36_history_activated OWNER TO r36_owner;
CREATE TABLE IF NOT EXISTS public.r36_history_checkpoint_heads (
 policy_digest text NOT NULL,source_wallet text NOT NULL,
 digest text NOT NULL REFERENCES public.r36_history_activated(digest),
 PRIMARY KEY(policy_digest,source_wallet)
);
ALTER TABLE public.r36_history_checkpoint_heads OWNER TO r36_owner;
-- Capture the approved opening balances once. Later checkpoints never reload
-- the complete immutable execution-scope baseline to look up one merchant.
CREATE TABLE IF NOT EXISTS public.r36_history_opening_scopes (
 policy_digest text NOT NULL,source_wallet text NOT NULL,scope_digest text NOT NULL,
 checkpoint_digest text NOT NULL REFERENCES public.r36_history_activated(digest),
 PRIMARY KEY(policy_digest,source_wallet)
);
ALTER TABLE public.r36_history_opening_scopes OWNER TO r36_owner;
REVOKE ALL ON public.r36_history_opening_scopes FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
CREATE TABLE IF NOT EXISTS public.r36_history_opening_balances (
 policy_digest text NOT NULL,source_wallet text NOT NULL,merchant_id text NOT NULL,
 opening_stroops numeric(30,0) NOT NULL CHECK(opening_stroops>=0),
 opening_unsettled_stroops numeric(30,0) NOT NULL CHECK(opening_unsettled_stroops>=0),
 checkpoint_digest text NOT NULL REFERENCES public.r36_history_activated(digest),
 PRIMARY KEY(policy_digest,source_wallet,merchant_id)
);
ALTER TABLE public.r36_history_opening_balances OWNER TO r36_owner;
ALTER TABLE public.r36_history_opening_balances ADD COLUMN IF NOT EXISTS opening_unsettled_stroops numeric(30,0) NOT NULL DEFAULT 0 CHECK(opening_unsettled_stroops>=0);
REVOKE ALL ON public.r36_history_opening_balances FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
GRANT SELECT ON public.r36_history_opening_balances TO r36_evidence_reader;
CREATE TABLE IF NOT EXISTS public.r36_history_credit_totals (
 policy_digest text NOT NULL,source_wallet text NOT NULL,merchant_uid text NOT NULL,merchant_id text NOT NULL,opening_stroops numeric(30,0) NOT NULL CHECK(opening_stroops>=0),
 epoch bigint NOT NULL CHECK(epoch>0),credit_stroops numeric(30,0) NOT NULL CHECK(credit_stroops>=0),
 checkpoint_digest text NOT NULL REFERENCES public.r36_history_activated(digest),
 PRIMARY KEY(policy_digest,source_wallet,merchant_uid,epoch)
);
ALTER TABLE public.r36_history_credit_totals OWNER TO r36_owner;
ALTER TABLE public.r36_history_credit_totals ADD COLUMN IF NOT EXISTS merchant_id text NOT NULL;
ALTER TABLE public.r36_history_credit_totals ADD COLUMN IF NOT EXISTS opening_stroops numeric(30,0) NOT NULL CHECK(opening_stroops>=0);
REVOKE ALL ON public.r36_history_checkpoints,public.r36_history_activated,public.r36_history_checkpoint_heads,public.r36_history_credit_totals FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
GRANT SELECT ON public.r36_history_checkpoints,public.r36_history_activated,public.r36_history_checkpoint_heads,public.r36_history_credit_totals TO r36_evidence_reader;
CREATE OR REPLACE FUNCTION public.r36_store_history_checkpoint(p_policy text,p_wallet text,p_closure text,p_text text,p_digest text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c jsonb;p public.r36_certificate_policies;r public.r36_prior_closure_receipts;parent public.r36_history_checkpoints;old public.r36_history_checkpoints;n bigint;
BEGIN
 IF session_user<>'r36_issuer' OR p_text IS NULL OR octet_length(p_text)>100000 OR p_digest IS DISTINCT FROM encode(sha256(convert_to(p_text,'UTF8')),'hex') THEN RAISE EXCEPTION 'CHECKPOINT_ISSUER_REQUIRED'; END IF;
 c=p_text::jsonb;n=floor(extract(epoch FROM clock_timestamp()))::bigint;
 SELECT * INTO p FROM public.r36_certificate_policies WHERE policy_digest=p_policy FOR SHARE;
 IF NOT FOUND OR NOT p.enabled OR p.revoked OR p.valid_from>n OR p.valid_until<=n OR p.revocation_checked_at>n OR p.revocation_valid_until<=n
 OR NOT EXISTS(SELECT 1 FROM public.r36_history_enrollments WHERE policy_digest=p_policy AND source_wallet=p_wallet AND NOT revoked) THEN RAISE EXCEPTION 'CHECKPOINT_POLICY'; END IF;
 SELECT * INTO r FROM public.r36_prior_closure_receipts WHERE payload_digest=p_closure FOR SHARE;
 IF NOT FOUND OR r.revoked OR r.policy_digest<>p_policy OR r.source_wallet<>p_wallet THEN RAISE EXCEPTION 'CHECKPOINT_ORIGINAL_CLOSURE'; END IF;
 IF c->>'applicationId' IS DISTINCT FROM (SELECT application_id FROM public.kernel_deployment_identity WHERE singleton) OR c->>'schema' IS DISTINCT FROM 'R36_CERTIFIED_HISTORY_CHECKPOINT_V1' OR c->>'network' IS DISTINCT FROM public.r36_network()
 OR c->>'policyDigest' IS DISTINCT FROM p_policy OR c->>'sourceWallet' IS DISTINCT FROM p_wallet OR c->>'closureDigest' IS DISTINCT FROM p_closure
 OR c->>'executionScopeDigest' IS DISTINCT FROM p.worker_profile->>'executionScopeDigest'
 OR c->'terminalTransaction'->'input'->>'preparedHash' IS DISTINCT FROM r.prior_hash
 OR c->'terminalEntry'->>'paymentId' IS DISTINCT FROM r.prior_payment
 OR c->>'closingSequence' IS DISTINCT FROM c->'terminalTransaction'->'input'->>'preparedSequence'
 OR coalesce(c->>'cutoffLedger','') !~ '^[1-9][0-9]{0,29}$' OR coalesce(c->>'closingSequence','') !~ '^[1-9][0-9]{0,29}$'
 THEN RAISE EXCEPTION 'CHECKPOINT_CLOSURE_BINDING'; END IF;
 SELECT * INTO old FROM public.r36_history_checkpoints WHERE digest=p_digest;
 IF FOUND THEN
  IF NOT old.revoked AND old.checkpoint_text=p_text AND old.closure_digest=p_closure AND old.policy_digest=p_policy AND old.source_wallet=p_wallet THEN RETURN 'REPLAYED'; END IF;
  RAISE EXCEPTION 'CHECKPOINT_REPLAY_CONFLICT';
 END IF;
 -- A newly certified fact must originate from a current original review.
 -- Replaying its identical committed fact above does not extend any authority.
 IF r.issued_at>n OR r.expires_at<=n THEN RAISE EXCEPTION 'CHECKPOINT_CLOSURE_EXPIRED'; END IF;
 IF c->>'parentDigest' IS NOT NULL THEN
  SELECT * INTO parent FROM public.r36_history_checkpoints WHERE digest=c->>'parentDigest' FOR SHARE;
  IF NOT FOUND OR parent.revoked OR parent.policy_digest<>p_policy OR parent.source_wallet<>p_wallet
  OR parent.cutoff_ledger>=(c->>'cutoffLedger')::numeric OR parent.closing_sequence>=(c->>'closingSequence')::numeric
  OR NOT EXISTS(SELECT 1 FROM public.r36_history_checkpoint_heads h WHERE h.policy_digest=p_policy AND h.source_wallet=p_wallet AND h.digest=parent.digest)
  THEN RAISE EXCEPTION 'CHECKPOINT_PARENT'; END IF;
 ELSIF EXISTS(SELECT 1 FROM public.r36_history_checkpoint_heads WHERE policy_digest=p_policy AND source_wallet=p_wallet) THEN RAISE EXCEPTION 'CHECKPOINT_PARENT_REQUIRED'; END IF;
 INSERT INTO public.r36_history_checkpoints(digest,policy_digest,source_wallet,parent_digest,closure_digest,cutoff_ledger,closing_sequence,checkpoint_text)
 VALUES(p_digest,p_policy,p_wallet,c->>'parentDigest',p_closure,(c->>'cutoffLedger')::numeric,(c->>'closingSequence')::numeric,p_text);
 RETURN 'RECORDED';
END $$;
ALTER FUNCTION public.r36_store_history_checkpoint(text,text,text,text,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_store_history_checkpoint(text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r36_store_history_checkpoint(text,text,text,text,text) TO r36_issuer;
CREATE TABLE IF NOT EXISTS public.r36_history_network_records (
 source_wallet text NOT NULL,tx_hash text NOT NULL,operation_id text NOT NULL,ledger numeric(30,0) NOT NULL,
 direction text NOT NULL CHECK(direction IN ('incoming','outgoing')),record_text text NOT NULL CHECK(octet_length(record_text)<=100000),
 checkpoint_digest text NOT NULL REFERENCES public.r36_history_checkpoints(digest),
 PRIMARY KEY(source_wallet,tx_hash),UNIQUE(source_wallet,operation_id)
);
ALTER TABLE public.r36_history_network_records OWNER TO r36_owner;
REVOKE ALL ON public.r36_history_network_records FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
GRANT SELECT ON public.r36_history_network_records TO r36_evidence_reader;
DROP FUNCTION IF EXISTS public.r36_history_checkpoint_context(text,text,text,jsonb);
CREATE OR REPLACE FUNCTION public.r36_history_checkpoint_context(p_policy text,p_wallet text,p_digest text,p_merchants jsonb,p_inbound text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.r36_history_checkpoints;a public.r36_history_activated;credits jsonb;inbound jsonb;
BEGIN
 IF session_user NOT IN ('r36_issuer','r36_registrar') OR p_merchants IS NULL OR jsonb_typeof(p_merchants)<>'array' OR jsonb_array_length(p_merchants)>20000 THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_merchants) v WHERE jsonb_typeof(v)<>'string' OR (v#>>'{}') !~ '^[A-Za-z0-9_.:-]{1,128}$')
 OR (SELECT count(*)<>count(DISTINCT v) FROM jsonb_array_elements(p_merchants) v) THEN RETURN NULL; END IF;
 SELECT * INTO c FROM public.r36_history_checkpoints WHERE digest=p_digest AND policy_digest=p_policy AND source_wallet=p_wallet AND NOT revoked;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO a FROM public.r36_history_activated WHERE digest=c.digest AND policy_digest=p_policy AND source_wallet=p_wallet;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.r36_certificate_policies WHERE policy_digest=p_policy AND enabled AND NOT revoked AND EXISTS(SELECT 1 FROM public.r36_history_enrollments WHERE policy_digest=p_policy AND source_wallet=p_wallet AND NOT revoked))
 OR NOT EXISTS(SELECT 1 FROM public.r36_prior_closure_receipts WHERE payload_digest=c.closure_digest AND NOT revoked) THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('merchantUid',m.uid,'creditStroops',coalesce(b.credit_stroops,0)::text,'merchantId',b.merchant_id,'openingStroops',b.opening_stroops::text) ORDER BY m.uid),'[]'::jsonb) INTO credits
 FROM (SELECT value AS uid FROM jsonb_array_elements_text(p_merchants)) m
 LEFT JOIN LATERAL (SELECT credit_stroops,merchant_id,opening_stroops FROM public.r36_history_credit_totals t WHERE t.policy_digest=p_policy AND t.source_wallet=p_wallet AND t.merchant_uid=m.uid AND t.epoch<=a.epoch ORDER BY t.epoch DESC LIMIT 1) b ON true;
 IF p_inbound IS NOT NULL THEN SELECT n.record_text::jsonb INTO inbound FROM public.r36_history_network_records n JOIN public.r36_history_checkpoints cp ON cp.digest=n.checkpoint_digest JOIN public.r36_history_activated ca ON ca.digest=cp.digest WHERE n.source_wallet=p_wallet AND n.tx_hash=p_inbound AND cp.policy_digest=p_policy AND NOT cp.revoked AND ca.epoch<=a.epoch AND n.direction='incoming'; END IF;
 RETURN jsonb_build_object('digest',c.digest,'checkpointText',c.checkpoint_text,'credits',credits,'inbound',inbound);
END $$;
ALTER FUNCTION public.r36_history_checkpoint_context(text,text,text,jsonb,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_history_checkpoint_context(text,text,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r36_history_checkpoint_context(text,text,text,jsonb,text) TO r36_issuer;
CREATE OR REPLACE FUNCTION public.r36_preserve_history_checkpoint() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('r36_history_checkpoints','r36_history_enrollments') THEN
  IF to_jsonb(NEW)-'revoked'=to_jsonb(OLD)-'revoked' AND NOT (OLD.revoked AND NOT NEW.revoked) THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'IMMUTABLE_HISTORY_CHECKPOINT';
END $$;
ALTER FUNCTION public.r36_preserve_history_checkpoint() OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_preserve_history_checkpoint() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['r36_history_enrollments','r36_history_checkpoints','r36_history_activated','r36_history_credit_totals','r36_history_network_records','r36_history_opening_balances','r36_history_opening_scopes'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='r36_preserve_history_checkpoint' AND tgrelid=('public.'||t)::regclass) THEN
   EXECUTE format('CREATE TRIGGER r36_preserve_history_checkpoint BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.r36_preserve_history_checkpoint()',t);
   EXECUTE format('CREATE TRIGGER r36_preserve_history_checkpoint_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.r36_preserve_history_checkpoint()',t);
  END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.r36_revoke_dependent_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NEW.revoked AND NOT OLD.revoked THEN
  WITH RECURSIVE affected(digest) AS (
   SELECT digest FROM public.r36_history_checkpoints WHERE closure_digest=NEW.payload_digest
   UNION SELECT c.digest FROM public.r36_history_checkpoints c JOIN affected a ON c.parent_digest=a.digest
  ) UPDATE public.r36_history_checkpoints SET revoked=true WHERE digest IN (SELECT digest FROM affected) AND NOT revoked;
 END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION public.r36_revoke_dependent_history() OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_revoke_dependent_history() FROM PUBLIC;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='r36_revoke_dependent_history' AND tgrelid='public.r36_prior_closure_receipts'::regclass) THEN
  CREATE TRIGGER r36_revoke_dependent_history AFTER UPDATE OF revoked ON public.r36_prior_closure_receipts FOR EACH ROW EXECUTE FUNCTION public.r36_revoke_dependent_history();
 END IF;
END $$;


CREATE INDEX IF NOT EXISTS r36_history_credit_merchant_id ON public.r36_history_credit_totals(policy_digest,source_wallet,merchant_id,epoch DESC);

-- Revoke descendants in one set operation, not one recursive trigger call per
-- historical payment. A direct administrative revocation cannot leave a child usable.
CREATE OR REPLACE FUNCTION public.r36_revoke_checkpoint_descendants() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM new_history n JOIN old_history o USING(digest) WHERE n.revoked AND NOT o.revoked) THEN RETURN NULL; END IF;
 WITH RECURSIVE affected(digest) AS (
  SELECT n.digest FROM new_history n JOIN old_history o USING(digest) WHERE n.revoked AND NOT o.revoked
  UNION SELECT c.digest FROM public.r36_history_checkpoints c JOIN affected a ON c.parent_digest=a.digest
 ) UPDATE public.r36_history_checkpoints SET revoked=true WHERE digest IN (SELECT digest FROM affected) AND NOT revoked;
 RETURN NULL;
END $$;
ALTER FUNCTION public.r36_revoke_checkpoint_descendants() OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_revoke_checkpoint_descendants() FROM PUBLIC;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='r36_revoke_checkpoint_descendants' AND tgrelid='public.r36_history_checkpoints'::regclass) THEN
  CREATE TRIGGER r36_revoke_checkpoint_descendants AFTER UPDATE ON public.r36_history_checkpoints
  REFERENCING OLD TABLE AS old_history NEW TABLE AS new_history FOR EACH STATEMENT EXECUTE FUNCTION public.r36_revoke_checkpoint_descendants();
 END IF;
END $$;

CREATE OR REPLACE FUNCTION r36_registration.history_context(p_policy text,p_nonce text,p_wallet text,p_digest text,p_merchants jsonb,p_inbound text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF session_user<>'r36_registrar' OR p_nonce !~ '^[0-9a-f]{64}$' OR p_digest !~ '^[0-9a-f]{64}$' OR p_inbound !~ '^[0-9a-f]{64}$'
 OR NOT EXISTS(SELECT 1 FROM public.r36_certificate_policies p WHERE p.policy_digest=p_policy AND p.enabled AND NOT p.revoked AND coalesce(p.worker_profile->'generalOperation'->>'sourceWallet',p.worker_profile->'recoveryPilot'->'ingress'->>'sourceWallet')=p_wallet)
 THEN RETURN NULL; END IF;
 RETURN public.r36_history_checkpoint_context(p_policy,p_wallet,p_digest,p_merchants,p_inbound);
END $$;
ALTER FUNCTION r36_registration.history_context(text,text,text,text,jsonb,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION r36_registration.history_context(text,text,text,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION r36_registration.history_context(text,text,text,text,jsonb,text) TO r36_registrar;
REVOKE EXECUTE ON FUNCTION public.r36_store_history_checkpoint(text,text,text,text,text) FROM r36_issuer;

-- One-time compatibility for an already activated, independently certified root.
-- Never repeated per operation, including an empty opening-balance set.
DO $$ DECLARE r record;s jsonb;BEGIN
 FOR r IN SELECT c.* FROM public.r36_history_checkpoints c JOIN public.r36_history_activated a USING(digest)
 WHERE c.parent_digest IS NULL AND NOT c.revoked AND NOT EXISTS(SELECT 1 FROM public.r36_history_opening_scopes o WHERE o.policy_digest=c.policy_digest AND o.source_wallet=c.source_wallet) LOOP
  SELECT x.scope_text::jsonb INTO s FROM public.r36_wallet_execution_scopes x
  WHERE x.policy_digest=r.policy_digest AND x.source_wallet=r.source_wallet AND x.scope_digest=r.checkpoint_text::jsonb->>'executionScopeDigest'
  AND x.scope_digest=encode(sha256(convert_to(x.scope_text,'UTF8')),'hex');
  IF s IS NULL OR jsonb_typeof(s->'baseline'->'merchantBalances') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'CHECKPOINT_OPENING_SCOPE_REQUIRED'; END IF;
  INSERT INTO public.r36_history_opening_balances(policy_digest,source_wallet,merchant_id,opening_stroops,opening_unsettled_stroops,checkpoint_digest)
  SELECT r.policy_digest,r.source_wallet,b->>'merchant_id',(b->>'settled')::numeric*10000000,(b->>'unsettled')::numeric*10000000,r.digest FROM jsonb_array_elements(s->'baseline'->'merchantBalances') b;
  INSERT INTO public.r36_history_opening_scopes VALUES(r.policy_digest,r.source_wallet,r.checkpoint_text::jsonb->>'executionScopeDigest',r.digest);
 END LOOP;
END $$;
