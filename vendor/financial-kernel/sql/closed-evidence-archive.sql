-- Original closed-operation evidence moves to immutable durable storage before
-- removing any redundant working file. These functions grant no send right.
CREATE TABLE IF NOT EXISTS public.r36_closed_evidence_work (
 nonce text PRIMARY KEY,policy_digest text NOT NULL,payment_id text NOT NULL,jobs jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),available_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS public.r36_closed_evidence_archives (
 policy_digest text NOT NULL,job_key text NOT NULL,nonce text NOT NULL,payment_id text NOT NULL,
 raw_text text NOT NULL CHECK(octet_length(raw_text)<=29000000),
 raw_digest text NOT NULL CHECK(raw_digest=encode(sha256(convert_to(raw_text,'UTF8')),'hex')),
 archived_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(policy_digest,job_key)
);
CREATE TABLE IF NOT EXISTS public.r36_closed_archive_installation(singleton boolean PRIMARY KEY CHECK(singleton));
CREATE TABLE IF NOT EXISTS public.r36_closed_evidence_released(policy_digest text NOT NULL,job_key text NOT NULL,PRIMARY KEY(policy_digest,job_key),FOREIGN KEY(policy_digest,job_key) REFERENCES public.r36_closed_evidence_archives(policy_digest,job_key));
ALTER TABLE public.r36_closed_archive_installation OWNER TO r36_owner;
ALTER TABLE public.r36_closed_evidence_released OWNER TO r36_owner;
REVOKE ALL ON public.r36_closed_archive_installation,public.r36_closed_evidence_released FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
CREATE INDEX IF NOT EXISTS r36_closed_evidence_due ON public.r36_closed_evidence_work(policy_digest,available_at,nonce);
ALTER TABLE public.r36_closed_evidence_work OWNER TO r36_owner;
ALTER TABLE public.r36_closed_evidence_archives OWNER TO r36_owner;
REVOKE ALL ON public.r36_closed_evidence_work,public.r36_closed_evidence_archives FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
CREATE INDEX IF NOT EXISTS r36_archive_request_payment ON public.r36_certificate_requests(policy_digest,(binding->>'paymentId'));
CREATE OR REPLACE FUNCTION public.r36_queue_closed_evidence() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE q record;j jsonb;
BEGIN
 FOR q IN SELECT r.* FROM public.r36_certificate_requests r JOIN public.r36_certificate_receipts c USING(nonce) WHERE r.binding->>'paymentId'=NEW.payment_id LOOP
  SELECT jsonb_agg(jsonb_build_object('key',key,'kind',kind) ORDER BY key) INTO j FROM (
   SELECT q.nonce||'.json' key,'admission' kind
   UNION SELECT q.nonce||'.renewal-'||generation::text||'.json','admission' FROM public.r36_admission_renewal_receipts WHERE nonce=q.nonce
   UNION SELECT 'lifecycle-bound-'||q.nonce||'.json','bound' WHERE EXISTS(SELECT 1 FROM public.r36_lifecycle_approval_links WHERE successor_nonce=q.nonce)
   UNION SELECT 'lifecycle-bound-'||encode(sha256(convert_to(q.nonce||E'\n'||closure_digest,'UTF8')),'hex')||'.json','bound' FROM public.r36_bound_renewal_receipts WHERE successor_nonce=q.nonce
  ) x;
  INSERT INTO public.r36_closed_evidence_work(nonce,policy_digest,payment_id,jobs) VALUES(q.nonce,q.policy_digest,NEW.payment_id,j) ON CONFLICT DO NOTHING;
 END LOOP;
 RETURN NEW;
END $$;
ALTER FUNCTION public.r36_queue_closed_evidence() OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_queue_closed_evidence() FROM PUBLIC;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='r36_evidence_source.closed_payments'::regclass AND tgname='r36_queue_closed_evidence') THEN
  CREATE TRIGGER r36_queue_closed_evidence AFTER INSERT ON r36_evidence_source.closed_payments FOR EACH ROW EXECUTE FUNCTION public.r36_queue_closed_evidence();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.r36_closed_evidence_archives'::regclass AND tgname='r36_preserve_closed_archive') THEN
  CREATE TRIGGER r36_preserve_closed_archive BEFORE UPDATE OR DELETE ON public.r36_closed_evidence_archives FOR EACH ROW EXECUTE FUNCTION public.r36_preserve_history_checkpoint();
  CREATE TRIGGER r36_preserve_closed_archive_truncate BEFORE TRUNCATE ON public.r36_closed_evidence_archives FOR EACH STATEMENT EXECUTE FUNCTION public.r36_preserve_history_checkpoint();
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.r36_closed_archive(p_policy text,p_action text,p_job text,p_raw text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE w public.r36_closed_evidence_work;r public.r36_certificate_requests;b jsonb;d text;existing public.r36_closed_evidence_archives;kind text;
BEGIN
 IF session_user<>'r36_issuer' OR p_policy !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'ARCHIVE_ISSUER_REQUIRED'; END IF;
 IF p_action='pending' THEN
  RETURN coalesce((SELECT jsonb_agg(x) FROM (SELECT pending_work.nonce,pending_work.payment_id AS "paymentId",j->>'key' AS "jobKey",j->>'kind' AS kind,(SELECT rr.evidence_not_before::text FROM public.r36_admission_renewal_requests rr WHERE rr.nonce=pending_work.nonce AND j->>'key'=pending_work.nonce||'.renewal-'||rr.generation::text||'.json') AS "evidenceFloor"
   FROM public.r36_closed_evidence_work pending_work CROSS JOIN LATERAL jsonb_array_elements(pending_work.jobs) j
   WHERE pending_work.policy_digest=p_policy AND pending_work.available_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM public.r36_closed_evidence_released a WHERE a.policy_digest=pending_work.policy_digest AND a.job_key=j->>'key')
   ORDER BY pending_work.available_at,pending_work.nonce,j->>'key' LIMIT 4) x),'[]'::jsonb);
 END IF;
 IF p_action='defer' THEN
  UPDATE public.r36_closed_evidence_work SET available_at=clock_timestamp()+interval '15 minutes' WHERE policy_digest=p_policy AND EXISTS(SELECT 1 FROM jsonb_array_elements(jobs) j WHERE j->>'key'=p_job);
  RETURN jsonb_build_object('deferred',true);
 END IF;
 IF p_action='lookup' OR p_action='released' THEN
  SELECT * INTO existing FROM public.r36_closed_evidence_archives WHERE policy_digest=p_policy AND job_key=p_job;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_action='released' THEN
   IF p_raw IS DISTINCT FROM existing.raw_digest THEN RAISE EXCEPTION 'ARCHIVE_RELEASE_BINDING'; END IF;
   INSERT INTO public.r36_closed_evidence_released VALUES(p_policy,p_job) ON CONFLICT DO NOTHING;
   DELETE FROM public.r36_closed_evidence_work q WHERE q.policy_digest=p_policy AND q.nonce=existing.nonce AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.jobs) j WHERE NOT EXISTS(SELECT 1 FROM public.r36_closed_evidence_released a WHERE a.policy_digest=q.policy_digest AND a.job_key=j->>'key'));
  END IF;
  RETURN jsonb_build_object('schema','R36_CLOSED_ARCHIVE_ACK_V1','policyDigest',p_policy,'jobKey',p_job,'rawDigest',existing.raw_digest,'bytes',octet_length(existing.raw_text),'scope','HISTORICAL_RECORD_ONLY');
 END IF;
 IF p_action<>'retain' OR p_job !~ '^([a-f0-9]{64}(\.renewal-[1-9][0-9]*)?|lifecycle-bound-[a-f0-9]{64})\.json$' OR p_raw IS NULL OR octet_length(p_raw)>29000000 THEN RAISE EXCEPTION 'ARCHIVE_REQUEST'; END IF;
 d=encode(sha256(convert_to(p_raw,'UTF8')),'hex');
 SELECT * INTO existing FROM public.r36_closed_evidence_archives WHERE policy_digest=p_policy AND job_key=p_job;
 IF FOUND THEN
  IF existing.raw_text IS DISTINCT FROM p_raw OR existing.raw_digest IS DISTINCT FROM d THEN RAISE EXCEPTION 'ARCHIVE_IMMUTABLE_CONFLICT'; END IF;
 ELSE
  SELECT * INTO w FROM public.r36_closed_evidence_work WHERE policy_digest=p_policy AND EXISTS(SELECT 1 FROM jsonb_array_elements(jobs) j WHERE j->>'key'=p_job) FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM r36_evidence_source.closed_payments WHERE payment_id=w.payment_id) THEN RAISE EXCEPTION 'ARCHIVE_CLOSED_ORIGINAL_REQUIRED'; END IF;
  SELECT * INTO r FROM public.r36_certificate_requests WHERE nonce=w.nonce AND policy_digest=p_policy AND binding->>'paymentId'=w.payment_id;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.r36_certificate_receipts WHERE nonce=w.nonce) THEN RAISE EXCEPTION 'ARCHIVE_CERTIFICATE_REQUIRED'; END IF;
  SELECT j->>'kind' INTO kind FROM jsonb_array_elements(w.jobs) j WHERE j->>'key'=p_job;
  b=p_raw::jsonb;
  IF kind='admission' THEN
   IF b->>'schema' IS DISTINCT FROM 'R36_IMMUTABLE_PUBLICATION_V1' OR b->>'policyDigest' IS DISTINCT FROM p_policy OR b->'binding' IS DISTINCT FROM (CASE WHEN b ? 'renewalGeneration' THEN (SELECT binding FROM public.r36_admission_renewal_requests rr WHERE rr.nonce=w.nonce AND rr.generation=(b->>'renewalGeneration')::int AND p_job=w.nonce||'.renewal-'||rr.generation::text||'.json') ELSE r.binding END) THEN RAISE EXCEPTION 'ARCHIVE_ADMISSION_IDENTITY'; END IF;
  ELSIF kind='bound' THEN
   IF b->>'schema' IS DISTINCT FROM 'R36_LIFECYCLE_PUBLICATION_V1' OR b->'request'->>'action' IS DISTINCT FROM 'record_bound' OR b->'request'->>'nonce' IS DISTINCT FROM w.nonce OR b->'bundle'->'clearance'->'manifest'->>'policyDigest' IS DISTINCT FROM p_policy THEN RAISE EXCEPTION 'ARCHIVE_BOUND_IDENTITY'; END IF;
  ELSE RAISE EXCEPTION 'ARCHIVE_KIND'; END IF;
  INSERT INTO public.r36_closed_evidence_archives(policy_digest,job_key,nonce,payment_id,raw_text,raw_digest) VALUES(p_policy,p_job,w.nonce,w.payment_id,p_raw,d);
 END IF;
 RETURN jsonb_build_object('schema','R36_CLOSED_ARCHIVE_ACK_V1','policyDigest',p_policy,'jobKey',p_job,'rawDigest',d,'bytes',octet_length(p_raw),'scope','HISTORICAL_RECORD_ONLY');
END $$;
ALTER FUNCTION public.r36_closed_archive(text,text,text,text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_closed_archive(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r36_closed_archive(text,text,text,text) TO r36_issuer;
-- Existing closed roots are backfilled once; normal processing is trigger-fed.
DO $$ DECLARE cp record;q record;j jsonb;BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.r36_closed_archive_installation WHERE singleton) THEN
  FOR cp IN SELECT payment_id FROM r36_evidence_source.closed_payments LOOP
   FOR q IN SELECT r.* FROM public.r36_certificate_requests r JOIN public.r36_certificate_receipts c USING(nonce) WHERE r.binding->>'paymentId'=cp.payment_id LOOP
    SELECT jsonb_agg(jsonb_build_object('key',key,'kind',kind) ORDER BY key) INTO j FROM (
     SELECT q.nonce||'.json' key,'admission' kind
     UNION SELECT q.nonce||'.renewal-'||generation::text||'.json','admission' FROM public.r36_admission_renewal_receipts WHERE nonce=q.nonce
     UNION SELECT 'lifecycle-bound-'||q.nonce||'.json','bound' WHERE EXISTS(SELECT 1 FROM public.r36_lifecycle_approval_links WHERE successor_nonce=q.nonce)
     UNION SELECT 'lifecycle-bound-'||encode(sha256(convert_to(q.nonce||E'\n'||closure_digest,'UTF8')),'hex')||'.json','bound' FROM public.r36_bound_renewal_receipts WHERE successor_nonce=q.nonce
    ) x;
    INSERT INTO public.r36_closed_evidence_work(nonce,policy_digest,payment_id,jobs) VALUES(q.nonce,q.policy_digest,cp.payment_id,j) ON CONFLICT DO NOTHING;
   END LOOP;
  END LOOP;
  INSERT INTO public.r36_closed_archive_installation(singleton) VALUES(true);
 END IF;
END $$;
