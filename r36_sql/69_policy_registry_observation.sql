-- Observation of the OWNER-controlled revocation registry only. This is not
-- independent network finality, key approval, policy enrollment or activation.
BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='60s';
DO $$ BEGIN
 IF current_database()<>'neondb' OR session_user<>'neondb_owner' OR current_user<>session_user
 OR current_setting('neon.branch_id',true) IS DISTINCT FROM 'br-tiny-mode-aliatv40'
 OR current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
 OR (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.r36_certificate_policy_immutable()'::regprocedure)
    IS DISTINCT FROM '18a73a597df0040c3614884c62f4e8d9a924d337e6eadb55aed69c879270c1ea'
 OR EXISTS(SELECT 1 FROM public.r36_certificate_policies WHERE enabled AND NOT revoked)
 OR to_regprocedure('public.r36_observe_owner_policy(text)') IS NOT NULL
 THEN RAISE EXCEPTION 'OWNER_REGISTRY_OBSERVATION_INSTALL_NOT_QUALIFIED'; END IF;
END $$;
GRANT r36_owner TO neondb_owner WITH INHERIT FALSE,SET TRUE;
GRANT CREATE ON SCHEMA public TO r36_owner; SET LOCAL ROLE r36_owner;
CREATE FUNCTION public.r36_observe_owner_policy(p_policy text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE p public.r36_certificate_policies; root jsonb; roots jsonb:='[]'::jsonb;
 n bigint; deadline bigint; checked bigint; root_end bigint;
BEGIN
 IF session_user<>'r36_issuer' OR current_setting('transaction_isolation')<>'read committed'
 OR p_policy IS NULL OR p_policy !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
 SELECT * INTO p FROM public.r36_certificate_policies WHERE policy_digest=p_policy FOR UPDATE;
 -- The caller cannot supply revocation state, clock, root, deadline or an update.
 -- The protected owner registry is the expressly enrolled revocation authority.
 n:=floor(extract(epoch FROM clock_timestamp()))::bigint;
 IF NOT FOUND OR NOT p.enabled OR p.revoked OR n<p.valid_from OR n>=p.valid_until
 OR p.worker_profile->'revocationRegistry' IS DISTINCT FROM jsonb_build_object(
   'schema','R36_OWNER_CONTROLLED_REVOCATION_REGISTRY_V1','observerRole','r36_issuer','maxObservationSeconds',120)
 OR jsonb_typeof(p.worker_profile->'authorities') IS DISTINCT FROM 'array'
 OR jsonb_array_length(p.worker_profile->'authorities') NOT BETWEEN 1 AND 32
 OR p.revocation_checked_at>n THEN RETURN NULL; END IF;
 FOR root IN SELECT value FROM jsonb_array_elements(p.worker_profile->'authorities') LOOP
  IF jsonb_typeof(root) IS DISTINCT FROM 'object' OR root->'revoked' IS DISTINCT FROM 'false'::jsonb
  OR coalesce(root->>'validFrom','') !~ '^[0-9]{1,16}$'
  OR coalesce(root->>'validUntil','') !~ '^[0-9]{1,16}$'
  OR coalesce(root->>'revocationCheckedAt','') !~ '^[0-9]{1,16}$'
  OR coalesce(root->>'revocationValidUntil','') !~ '^[0-9]{1,16}$'
  THEN RETURN NULL; END IF;
  checked:=(root->>'revocationCheckedAt')::bigint; root_end:=(root->>'validUntil')::bigint;
  IF checked>n OR n<(root->>'validFrom')::bigint OR n>=root_end THEN RETURN NULL; END IF;
  IF checked<n THEN
   root:=root||jsonb_build_object('revocationCheckedAt',n,'revocationValidUntil',least(n+120,p.valid_until,root_end));
  ELSIF (root->>'revocationValidUntil')::bigint<=n THEN RETURN NULL;
  END IF;
  roots:=roots||jsonb_build_array(root);
 END LOOP;
 deadline:=least(n+120,p.valid_until);
 IF p.revocation_checked_at<n OR roots IS DISTINCT FROM p.worker_profile->'authorities' THEN
  UPDATE public.r36_certificate_policies SET revocation_checked_at=n,revocation_valid_until=deadline,
   worker_profile=jsonb_set(worker_profile,'{authorities}',roots,false) WHERE policy_digest=p_policy;
 ELSE deadline:=p.revocation_valid_until;
 END IF;
 IF deadline<=n THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('schema','R36_OWNER_REGISTRY_OBSERVATION_V1','policyDigest',p_policy,
  'observedAt',n,'validUntil',deadline,'financialAuthority',false,'networkFinality',false);
END $$;
REVOKE ALL ON FUNCTION public.r36_observe_owner_policy(text) FROM PUBLIC,r36_runtime,r36_signer,r36_registrar,r36_evidence_reader;
GRANT EXECUTE ON FUNCTION public.r36_observe_owner_policy(text) TO r36_issuer;
RESET ROLE; REVOKE CREATE ON SCHEMA public FROM r36_owner;
REVOKE r36_owner FROM neondb_owner GRANTED BY neondb_owner; COMMIT;
