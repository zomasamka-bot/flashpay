-- Preserve exact historical artifacts. Indexing changes no acceptance rule.
CREATE INDEX IF NOT EXISTS r36_prior_archive_bundle_idx ON public.r36_prior_closure_receipts
 (policy_digest,source_wallet,prior_payment,(md5((evidence_text::jsonb->'artifacts')::text)))
 WHERE NOT revoked;
CREATE INDEX IF NOT EXISTS r36_prior_current_scope_idx ON public.r36_prior_closure_receipts
 (policy_digest,source_wallet,prior_payment,context_digest,expires_at DESC) WHERE NOT revoked;
CREATE OR REPLACE FUNCTION public.r36_lifecycle_job_receipt(p_kind text, p_policy text, p_wallet text, p_subject text, p_aux text, p_text text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
DECLARE v jsonb;r record;BEGIN
 IF session_user<>'r36_issuer' OR p_text IS NULL OR length(p_text)>12000000 THEN RETURN NULL; END IF;
 v=p_text::jsonb;
 IF p_kind='prior_closure' THEN
  SELECT c.payload_digest,c.policy_digest INTO r FROM public.r36_prior_closure_receipts c
  JOIN public.r36_certificate_policies p ON p.policy_digest=c.policy_digest
  WHERE c.policy_digest=p_policy AND c.source_wallet=p_wallet AND c.prior_payment=p_subject
  AND NOT c.revoked AND p.enabled AND NOT p.revoked
  AND md5((c.evidence_text::jsonb->'artifacts')::text)=md5(v::text)
  AND c.evidence_text::jsonb->'artifacts'=v
  ORDER BY c.verified_at DESC LIMIT 1;
 ELSIF p_kind='bound_successor' THEN
  SELECT l.approval_id AS payload_digest,c.policy_digest INTO r FROM public.r36_lifecycle_approval_links l
  JOIN public.r36_prior_closure_receipts c ON c.payload_digest=l.closure_digest
  JOIN public.r36_certificate_policies p ON p.policy_digest=c.policy_digest
  JOIN public.r36_certificate_receipts receipt ON receipt.nonce=l.successor_nonce
  WHERE l.successor_nonce=p_subject AND l.closure_digest=p_aux AND l.evidence_text::jsonb=v
  AND NOT c.revoked AND p.enabled AND NOT p.revoked
  AND NOT EXISTS(SELECT 1 FROM public.r36_certificate_revocations WHERE payload_digest=receipt.payload_digest);
 ELSE RETURN NULL; END IF;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('proofDigest',r.payload_digest,'policyDigest',r.policy_digest,'scope','HISTORICAL_RECORD_ONLY');
END $$;
CREATE OR REPLACE FUNCTION public.r36_preserve_prior_archive() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $body$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'IMMUTABLE_PRIOR_ARCHIVE'; END IF;
 IF (to_jsonb(NEW)-'revoked') IS DISTINCT FROM (to_jsonb(OLD)-'revoked') OR (OLD.revoked AND NOT NEW.revoked)
 THEN RAISE EXCEPTION 'IMMUTABLE_PRIOR_ARCHIVE'; END IF;
 RETURN NEW;
END $body$;
ALTER FUNCTION public.r36_preserve_prior_archive() OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_preserve_prior_archive() FROM PUBLIC;
DO $install$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.r36_prior_closure_receipts'::regclass AND tgname='r36_preserve_prior_archive') THEN
  CREATE TRIGGER r36_preserve_prior_archive BEFORE UPDATE OR DELETE ON public.r36_prior_closure_receipts FOR EACH ROW EXECUTE FUNCTION public.r36_preserve_prior_archive();
  CREATE TRIGGER r36_preserve_prior_archive_no_truncate BEFORE TRUNCATE ON public.r36_prior_closure_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.r36_preserve_prior_archive();
 END IF;
END $install$;
