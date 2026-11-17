-- Closed evidence custody only; no payment, balance, certificate or wallet grants.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='r36_archiver') THEN CREATE ROLE r36_archiver NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$;
CREATE SCHEMA IF NOT EXISTS r36_archive_storage AUTHORIZATION r36_owner;
REVOKE ALL ON SCHEMA r36_archive_storage FROM PUBLIC;
CREATE TABLE IF NOT EXISTS r36_archive_storage.capacity (
 singleton boolean PRIMARY KEY CHECK(singleton),store_id text NOT NULL,store_origin text NOT NULL,
 max_bytes bigint NOT NULL CHECK(max_bytes BETWEEN 1 AND 800000000),allocated_bytes bigint NOT NULL CHECK(allocated_bytes BETWEEN 1 AND max_bytes),
 reserved_bytes bigint NOT NULL DEFAULT 0 CHECK(reserved_bytes>=0 AND reserved_bytes<=max_bytes),
 max_30day_uploads int NOT NULL CHECK(max_30day_uploads BETWEEN 1 AND 1000),
 max_30day_reads int NOT NULL CHECK(max_30day_reads BETWEEN 1 AND 4000),
 max_30day_read_bytes bigint NOT NULL CHECK(max_30day_read_bytes BETWEEN 1 AND 4000000000),
 staging_bytes bigint NOT NULL DEFAULT 0 CHECK(staging_bytes>=0),max_staging_bytes bigint NOT NULL DEFAULT 128000000 CHECK(max_staging_bytes BETWEEN 29000000 AND 256000000),
 enabled boolean NOT NULL DEFAULT false,
 CHECK(store_id ~ '^store_[A-Za-z0-9]+$'),CHECK(store_origin ~ '^https://[a-z0-9]+\.private\.blob\.vercel-storage\.com$')
);
CREATE TABLE IF NOT EXISTS r36_archive_storage.packs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),policy_digest text NOT NULL CHECK(policy_digest ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN('prepared','reserved','committed')),
 manifest jsonb NOT NULL,raw_bytes bigint NOT NULL,packed_bytes bigint,pack_digest text,
 object_path text UNIQUE,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),committed_at timestamptz,
 lease_until timestamptz NOT NULL DEFAULT '-infinity',lease_token uuid,
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),failures int NOT NULL DEFAULT 0,
 CHECK(pack_digest IS NULL OR pack_digest ~ '^[a-f0-9]{64}$'),CHECK(packed_bytes IS NULL OR packed_bytes BETWEEN 1 AND 45000000)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_unfinished_pack_per_policy ON r36_archive_storage.packs(policy_digest) WHERE state<>'committed';
CREATE TABLE IF NOT EXISTS r36_archive_storage.queue (
 policy_digest text NOT NULL,job_key text NOT NULL,pack_id uuid REFERENCES r36_archive_storage.packs(id),queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(policy_digest,job_key),FOREIGN KEY(policy_digest,job_key) REFERENCES public.r36_closed_evidence_archives(policy_digest,job_key)
);
CREATE INDEX IF NOT EXISTS archive_queue_unpacked ON r36_archive_storage.queue(policy_digest,queued_at,job_key) WHERE pack_id IS NULL;
CREATE TABLE IF NOT EXISTS r36_archive_storage.usage (
 day date PRIMARY KEY,uploads int NOT NULL DEFAULT 0,reads int NOT NULL DEFAULT 0,read_bytes bigint NOT NULL DEFAULT 0
);
ALTER TABLE public.r36_closed_evidence_archives ADD COLUMN IF NOT EXISTS raw_bytes bigint;
ALTER TABLE public.r36_closed_evidence_archives ADD COLUMN IF NOT EXISTS object_pack uuid REFERENCES r36_archive_storage.packs(id);
ALTER TABLE public.r36_closed_evidence_archives ALTER COLUMN raw_text DROP NOT NULL;
CREATE OR REPLACE FUNCTION r36_archive_storage.guard_payload() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.raw_bytes IS NULL AND NEW.raw_bytes=octet_length(OLD.raw_text) AND (to_jsonb(OLD)-'raw_bytes')=(to_jsonb(NEW)-'raw_bytes') THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.raw_text IS NULL OR NEW.object_pack IS NOT NULL OR NEW.raw_digest<>encode(sha256(convert_to(NEW.raw_text,'UTF8')),'hex') THEN RAISE EXCEPTION 'ARCHIVE_ORIGINAL_REQUIRED'; END IF;
  NEW.raw_bytes=octet_length(NEW.raw_text);
  UPDATE r36_archive_storage.capacity SET staging_bytes=staging_bytes+NEW.raw_bytes WHERE singleton AND staging_bytes+NEW.raw_bytes<=max_staging_bytes;
  IF NOT FOUND AND EXISTS(SELECT 1 FROM r36_archive_storage.capacity) THEN RAISE EXCEPTION 'ARCHIVE_STAGING_CAPACITY_HELD'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR session_user<>'r36_archiver' OR OLD.raw_text IS NULL OR NEW.raw_text IS NOT NULL OR OLD.object_pack IS NOT NULL OR NEW.object_pack IS NULL OR
  (to_jsonb(OLD)-'raw_text'-'object_pack') IS DISTINCT FROM (to_jsonb(NEW)-'raw_text'-'object_pack') OR
  NOT EXISTS(SELECT 1 FROM r36_archive_storage.packs p WHERE p.id=NEW.object_pack AND p.state='committed' AND p.manifest @> jsonb_build_array(jsonb_build_object('policyDigest',OLD.policy_digest,'jobKey',OLD.job_key,'rawDigest',OLD.raw_digest,'rawBytes',OLD.raw_bytes)))
 THEN RAISE EXCEPTION 'ARCHIVE_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
-- Replace only the archive representation guard; all money/authority guards remain unchanged.
DROP TRIGGER IF EXISTS r36_preserve_closed_archive ON public.r36_closed_evidence_archives;
CREATE TRIGGER r36_preserve_closed_archive BEFORE UPDATE OR DELETE ON public.r36_closed_evidence_archives FOR EACH ROW EXECUTE FUNCTION r36_archive_storage.guard_payload();
UPDATE public.r36_closed_evidence_archives SET raw_bytes=octet_length(raw_text) WHERE raw_bytes IS NULL;
ALTER TABLE public.r36_closed_evidence_archives ALTER COLUMN raw_bytes SET NOT NULL;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.r36_closed_evidence_archives'::regclass AND conname='r36_archive_payload_location') THEN ALTER TABLE public.r36_closed_evidence_archives ADD CONSTRAINT r36_archive_payload_location CHECK((raw_text IS NOT NULL AND object_pack IS NULL) OR (raw_text IS NULL AND object_pack IS NOT NULL)); END IF; END $$;
DROP TRIGGER IF EXISTS r36_closed_payload_insert ON public.r36_closed_evidence_archives;
CREATE TRIGGER r36_closed_payload_insert BEFORE INSERT ON public.r36_closed_evidence_archives FOR EACH ROW EXECUTE FUNCTION r36_archive_storage.guard_payload();
CREATE OR REPLACE FUNCTION r36_archive_storage.enqueue() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN INSERT INTO r36_archive_storage.queue(policy_digest,job_key) VALUES(NEW.policy_digest,NEW.job_key) ON CONFLICT DO NOTHING; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS r36_object_archive_queue ON public.r36_closed_evidence_archives;
CREATE TRIGGER r36_object_archive_queue AFTER INSERT ON public.r36_closed_evidence_archives FOR EACH ROW EXECUTE FUNCTION r36_archive_storage.enqueue();
INSERT INTO r36_archive_storage.queue(policy_digest,job_key) SELECT policy_digest,job_key FROM public.r36_closed_evidence_archives WHERE raw_text IS NOT NULL ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION public.r36_object_archive(p_action text,p_policy text,p_id uuid DEFAULT NULL,p_token uuid DEFAULT NULL,p_digest text DEFAULT NULL,p_bytes bigint DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c r36_archive_storage.capacity;p r36_archive_storage.packs;m jsonb;sz bigint;counted int;used record;next_capacity bigint;
BEGIN
 IF session_user<>'r36_archiver' OR p_policy !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'ARCHIVER_REQUIRED'; END IF;
 SELECT * INTO c FROM r36_archive_storage.capacity WHERE singleton FOR UPDATE;
 IF NOT FOUND OR NOT c.enabled THEN RETURN jsonb_build_object('status','disabled'); END IF;
 IF p_action='claim' THEN
  SELECT * INTO p FROM r36_archive_storage.packs WHERE policy_digest=p_policy AND state<>'committed' FOR UPDATE;
  IF FOUND AND (p.available_at>clock_timestamp() OR p.lease_until>clock_timestamp()) THEN RETURN jsonb_build_object('status','busy'); END IF;
  IF NOT FOUND THEN
   -- Bounded selection: immutable completed records, already released from the service volume.
   WITH candidates AS (SELECT a.policy_digest,a.job_key,a.raw_digest,a.raw_bytes,q.queued_at,
    sum(a.raw_bytes) OVER(ORDER BY q.queued_at,q.job_key) cumulative
    FROM (SELECT * FROM r36_archive_storage.queue WHERE policy_digest=p_policy AND pack_id IS NULL ORDER BY queued_at,job_key LIMIT 64) q
    JOIN public.r36_closed_evidence_archives a USING(policy_digest,job_key)
    JOIN public.r36_closed_evidence_released r USING(policy_digest,job_key)
    WHERE a.raw_text IS NOT NULL), selected AS(SELECT * FROM candidates WHERE cumulative<=32000000)
   SELECT jsonb_agg(jsonb_build_object('policyDigest',policy_digest,'jobKey',job_key,'rawDigest',raw_digest,'rawBytes',raw_bytes) ORDER BY queued_at,job_key),sum(raw_bytes),count(*)::int
    INTO m,sz,counted FROM selected;
   IF counted=0 OR (sz<2000000 AND NOT EXISTS(SELECT 1 FROM r36_archive_storage.queue WHERE policy_digest=p_policy AND pack_id IS NULL AND queued_at<=clock_timestamp()-interval '6 hours')) THEN RETURN jsonb_build_object('status','idle'); END IF;
   INSERT INTO r36_archive_storage.packs(policy_digest,manifest,raw_bytes) VALUES(p_policy,m,sz) RETURNING * INTO p;
   UPDATE r36_archive_storage.queue q SET pack_id=p.id WHERE q.policy_digest=p_policy AND EXISTS(SELECT 1 FROM jsonb_array_elements(m) j WHERE j->>'jobKey'=q.job_key);
  END IF;
  UPDATE r36_archive_storage.packs SET lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes' WHERE id=p.id RETURNING * INTO p;
  RETURN jsonb_build_object('status','claimed','id',p.id,'token',p.lease_token,'manifest',p.manifest,'storeId',c.store_id,'storeOrigin',c.store_origin,'digest',p.pack_digest,'bytes',p.packed_bytes,'objectPath',p.object_path,
   'rows',(SELECT jsonb_agg(jsonb_build_object('jobKey',a.job_key,'rawText',a.raw_text) ORDER BY j.n) FROM jsonb_array_elements(p.manifest) WITH ORDINALITY j(v,n) JOIN public.r36_closed_evidence_archives a ON a.policy_digest=p_policy AND a.job_key=j.v->>'jobKey'));
 END IF;
 SELECT * INTO p FROM r36_archive_storage.packs WHERE id=p_id AND policy_digest=p_policy FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ARCHIVE_PACK_REQUIRED'; END IF;
 IF p_action='committed' THEN RETURN jsonb_build_object('status',p.state,'digest',p.pack_digest,'bytes',p.packed_bytes); END IF;
 IF p.state='committed' THEN
  IF p_action='commit' AND p.pack_digest=p_digest AND p.packed_bytes=p_bytes THEN RETURN jsonb_build_object('status','committed'); END IF;
  RAISE EXCEPTION 'ARCHIVE_PACK_CLOSED';
 END IF;
 IF p.lease_token IS DISTINCT FROM p_token OR p.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'ARCHIVE_LEASE_LOST'; END IF;
 IF p_action='reserve' THEN
  IF p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' OR p_bytes IS NULL OR p_bytes NOT BETWEEN 1 AND 45000000 THEN RAISE EXCEPTION 'ARCHIVE_PACK_FORMAT'; END IF;
  IF p.pack_digest IS NOT NULL THEN
   IF p.pack_digest<>p_digest OR p.packed_bytes<>p_bytes THEN RAISE EXCEPTION 'ARCHIVE_PACK_CONFLICT'; END IF;
  ELSE
   IF c.reserved_bytes+p_bytes>c.max_bytes THEN RETURN jsonb_build_object('status','capacity_held'); END IF;
   next_capacity=c.allocated_bytes;
   WHILE next_capacity<c.reserved_bytes+p_bytes LOOP next_capacity=least(c.max_bytes,next_capacity*2); END LOOP;
   UPDATE r36_archive_storage.capacity SET reserved_bytes=reserved_bytes+p_bytes,allocated_bytes=next_capacity WHERE singleton;
   UPDATE r36_archive_storage.packs SET state='reserved',packed_bytes=p_bytes,pack_digest=p_digest,object_path='r36-closed/v1/'||p_policy||'/'||p_id::text||'-'||p_digest||'.json.gz' WHERE id=p_id RETURNING * INTO p;
  END IF;
  RETURN jsonb_build_object('status','reserved','path',p.object_path);
 END IF;
 IF p_action IN('upload','read') THEN
  IF p.state<>'reserved' THEN RAISE EXCEPTION 'ARCHIVE_RESERVATION_REQUIRED'; END IF;
  SELECT coalesce(sum(uploads),0) uploads,coalesce(sum(reads),0) reads,coalesce(sum(read_bytes),0) bytes INTO used FROM r36_archive_storage.usage WHERE day >= (clock_timestamp() AT TIME ZONE 'UTC')::date-30;
  IF (p_action='upload' AND used.uploads>=c.max_30day_uploads) OR (p_action='read' AND (used.reads>=c.max_30day_reads OR used.bytes+p.packed_bytes>c.max_30day_read_bytes)) THEN RETURN jsonb_build_object('status','budget_held'); END IF;
  INSERT INTO r36_archive_storage.usage(day,uploads,reads,read_bytes) VALUES((clock_timestamp() AT TIME ZONE 'UTC')::date,CASE WHEN p_action='upload' THEN 1 ELSE 0 END,CASE WHEN p_action='read' THEN 1 ELSE 0 END,CASE WHEN p_action='read' THEN p.packed_bytes ELSE 0 END)
   ON CONFLICT(day) DO UPDATE SET uploads=r36_archive_storage.usage.uploads+EXCLUDED.uploads,reads=r36_archive_storage.usage.reads+EXCLUDED.reads,read_bytes=r36_archive_storage.usage.read_bytes+EXCLUDED.read_bytes;
  RETURN jsonb_build_object('status','allowed');
 END IF;
 IF p_action='commit' THEN
  IF p.state<>'reserved' OR p.pack_digest IS DISTINCT FROM p_digest OR p.packed_bytes IS DISTINCT FROM p_bytes THEN RAISE EXCEPTION 'ARCHIVE_PACK_CONFLICT'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p.manifest) j JOIN public.r36_closed_evidence_archives a ON a.policy_digest=p_policy AND a.job_key=j->>'jobKey' WHERE a.raw_text IS NOT NULL AND a.raw_digest=j->>'rawDigest' AND a.raw_bytes=(j->>'rawBytes')::bigint AND a.raw_digest=encode(sha256(convert_to(a.raw_text,'UTF8')),'hex'))<>jsonb_array_length(p.manifest) THEN RAISE EXCEPTION 'ARCHIVE_ORIGINAL_CHANGED'; END IF;
  UPDATE r36_archive_storage.packs SET state='committed',committed_at=clock_timestamp(),lease_until='-infinity' WHERE id=p_id;
  UPDATE public.r36_closed_evidence_archives a SET raw_text=NULL,object_pack=p_id WHERE policy_digest=p_policy AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.manifest) j WHERE j->>'jobKey'=a.job_key);
  UPDATE r36_archive_storage.capacity SET staging_bytes=staging_bytes-p.raw_bytes WHERE singleton;
  DELETE FROM r36_archive_storage.queue WHERE pack_id=p_id;
  RETURN jsonb_build_object('status','committed','releasedBytes',p.raw_bytes,'items',jsonb_array_length(p.manifest));
 END IF;
 IF p_action='defer' THEN UPDATE r36_archive_storage.packs SET available_at=clock_timestamp()+make_interval(secs=>least(900,5*(2^least(failures,7))::int)),failures=least(failures+1,100),lease_until='-infinity' WHERE id=p_id;RETURN jsonb_build_object('status','deferred'); END IF;
 RAISE EXCEPTION 'ARCHIVE_ACTION';
END $$;
ALTER FUNCTION public.r36_object_archive(text,text,uuid,uuid,text,bigint) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_object_archive(text,text,uuid,uuid,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.r36_object_archive(text,text,uuid,uuid,text,bigint) TO r36_archiver;
ALTER FUNCTION r36_archive_storage.guard_payload() OWNER TO r36_owner;
ALTER FUNCTION r36_archive_storage.enqueue() OWNER TO r36_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA r36_archive_storage FROM PUBLIC;
ALTER TABLE r36_archive_storage.capacity OWNER TO r36_owner;
ALTER TABLE r36_archive_storage.packs OWNER TO r36_owner;
ALTER TABLE r36_archive_storage.queue OWNER TO r36_owner;
ALTER TABLE r36_archive_storage.usage OWNER TO r36_owner;
REVOKE ALL ON ALL TABLES IN SCHEMA r36_archive_storage FROM PUBLIC,r36_archiver,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;

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
  RETURN jsonb_build_object('schema','R36_CLOSED_ARCHIVE_ACK_V1','policyDigest',p_policy,'jobKey',p_job,'rawDigest',existing.raw_digest,'bytes',existing.raw_bytes,'scope','HISTORICAL_RECORD_ONLY');
 END IF;
 IF p_action<>'retain' OR p_job !~ '^([a-f0-9]{64}(\.renewal-[1-9][0-9]*)?|lifecycle-bound-[a-f0-9]{64})\.json$' OR p_raw IS NULL OR octet_length(p_raw)>29000000 THEN RAISE EXCEPTION 'ARCHIVE_REQUEST'; END IF;
 d=encode(sha256(convert_to(p_raw,'UTF8')),'hex');
 SELECT * INTO existing FROM public.r36_closed_evidence_archives WHERE policy_digest=p_policy AND job_key=p_job;
 IF FOUND THEN
  IF (existing.raw_text IS NOT NULL AND existing.raw_text IS DISTINCT FROM p_raw) OR existing.raw_digest IS DISTINCT FROM d OR existing.raw_bytes IS DISTINCT FROM octet_length(p_raw) THEN RAISE EXCEPTION 'ARCHIVE_IMMUTABLE_CONFLICT'; END IF;
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
