-- NOT_FOR_DEPLOY until separately qualified for the target.
-- Permit only genuine observation timestamps to advance on an approved root.
-- No policy enrollment, enabled flag, key, identity, ACL, authority or money write.
-- The existing policy-owner boundary remains the only writer; this SQL never
-- manufactures observations or grants the publisher permission to refresh them.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF current_setting('flashpay.isolated_certificate_test',true) IS DISTINCT FROM 'yes'
 OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
 OR to_regprocedure('public.r36_certificate_policy_immutable()') IS NULL
 THEN RAISE EXCEPTION 'QUALIFIED_PG17_POLICY_SCHEMA_REQUIRED'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.r36_certificate_policy_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE before_doc jsonb; after_doc jsonb; before_roots jsonb; after_roots jsonb;
 old_root jsonb; new_root jsonb; old_clean jsonb:='[]'; new_clean jsonb:='[]';
 i integer; checked bigint; deadline bigint; n bigint:=floor(extract(epoch FROM clock_timestamp()))::bigint;
BEGIN
 before_doc:=to_jsonb(OLD)-ARRAY['enabled','revoked','revocation_checked_at','revocation_valid_until'];
 after_doc:=to_jsonb(NEW)-ARRAY['enabled','revoked','revocation_checked_at','revocation_valid_until'];
 IF before_doc=after_doc THEN RETURN NEW; END IF;
 before_roots:=OLD.worker_profile->'authorities'; after_roots:=NEW.worker_profile->'authorities';
 IF jsonb_typeof(before_roots) IS DISTINCT FROM 'array' OR jsonb_typeof(after_roots) IS DISTINCT FROM 'array'
 OR jsonb_array_length(before_roots)<>jsonb_array_length(after_roots)
 OR jsonb_array_length(before_roots) NOT BETWEEN 1 AND 32
 THEN RAISE EXCEPTION 'POLICY_CONTENT_IMMUTABLE_USE_NEW_DIGEST'; END IF;
 FOR i IN 0..jsonb_array_length(before_roots)-1 LOOP
  old_root:=before_roots->i; new_root:=after_roots->i;
  IF jsonb_typeof(old_root) IS DISTINCT FROM 'object' OR jsonb_typeof(new_root) IS DISTINCT FROM 'object'
  OR (old_root-ARRAY['revocationCheckedAt','revocationValidUntil']) IS DISTINCT FROM
     (new_root-ARRAY['revocationCheckedAt','revocationValidUntil'])
  THEN RAISE EXCEPTION 'POLICY_CONTENT_IMMUTABLE_USE_NEW_DIGEST'; END IF;
  IF old_root IS DISTINCT FROM new_root THEN
   IF jsonb_typeof(new_root->'revocationCheckedAt') IS DISTINCT FROM 'number'
   OR jsonb_typeof(new_root->'revocationValidUntil') IS DISTINCT FROM 'number'
   OR jsonb_typeof(old_root->'revocationCheckedAt') IS DISTINCT FROM 'number'
   OR jsonb_typeof(new_root->'validUntil') IS DISTINCT FROM 'number'
   OR (new_root->>'revocationCheckedAt') !~ '^[0-9]{1,16}$'
   OR (new_root->>'revocationValidUntil') !~ '^[0-9]{1,16}$'
   OR (old_root->>'revocationCheckedAt') !~ '^[0-9]{1,16}$'
   OR (new_root->>'validUntil') !~ '^[0-9]{1,16}$'
   THEN RAISE EXCEPTION 'INVALID_AUTHORITY_OBSERVATION'; END IF;
   checked:=(new_root->>'revocationCheckedAt')::bigint; deadline:=(new_root->>'revocationValidUntil')::bigint;
   IF checked<=(old_root->>'revocationCheckedAt')::bigint OR checked>n OR checked<NEW.valid_from
   OR deadline<=checked OR deadline>checked+120 OR deadline>NEW.valid_until
   OR deadline>(new_root->>'validUntil')::bigint OR deadline>9007199254740991
   THEN RAISE EXCEPTION 'INVALID_AUTHORITY_OBSERVATION'; END IF;
  END IF;
  old_clean:=old_clean||jsonb_build_array(old_root-ARRAY['revocationCheckedAt','revocationValidUntil']);
  new_clean:=new_clean||jsonb_build_array(new_root-ARRAY['revocationCheckedAt','revocationValidUntil']);
 END LOOP;
 before_doc:=jsonb_set(before_doc,'{worker_profile,authorities}',old_clean,false);
 after_doc:=jsonb_set(after_doc,'{worker_profile,authorities}',new_clean,false);
 IF before_doc IS DISTINCT FROM after_doc THEN RAISE EXCEPTION 'POLICY_CONTENT_IMMUTABLE_USE_NEW_DIGEST'; END IF;
 RETURN NEW;
END $$;
-- CREATE OR REPLACE preserves the existing function owner and grants.
COMMIT;
