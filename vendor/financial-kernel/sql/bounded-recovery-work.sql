-- Operational discovery only. No function in this migration grants a financial
-- right or changes a payment, checkpoint, balance, certificate or attempt.
CREATE TABLE IF NOT EXISTS public.r36_recovery_work (
 payment_id text PRIMARY KEY,
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 next_visit_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 lease_token uuid, lease_until timestamptz,
 CHECK ((lease_token IS NULL)=(lease_until IS NULL))
);
ALTER TABLE public.r36_recovery_work OWNER TO r36_owner;
REVOKE ALL ON public.r36_recovery_work FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;
CREATE INDEX IF NOT EXISTS r36_recovery_work_due ON public.r36_recovery_work(next_visit_at,payment_id);

CREATE OR REPLACE FUNCTION public.r36_recovery_work_needed(p_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $work$

    WITH scoped AS (
      SELECT i.payment_id, i.merchant_id, i.merchant_uid, i.customer_amount
      FROM public.payment_create_intents i CROSS JOIN public.kernel_deployment_identity k
      WHERE i.created_at > k.recovery_cutover AND i.created_at <= statement_timestamp()
        AND i.payment_id = p_id
        AND encode(sha256(convert_to(i.payment_id,'UTF8')),'hex') <> ALL(k.historical_holds)
        AND NOT EXISTS (
          SELECT 1 FROM public.settlement_checkpoints done
          WHERE done.payment_id=i.payment_id AND done.merchant_id=i.merchant_id
            AND done.merchant_uid=i.merchant_uid AND done.customer_amount=i.customer_amount
            AND done.merchant_amount+done.app_commission=i.customer_amount
            AND done.stage='db_finalized' AND done.pi_completed_at IS NOT NULL
            AND done.db_finalized_at IS NOT NULL AND done.horizon_confirmed_at IS NOT NULL
            AND done.a2u_txid=done.prepared_tx_hash
            AND NOT EXISTS(SELECT 1 FROM public.refund_checkpoints conflict WHERE conflict.payment_id=i.payment_id)
            AND EXISTS(SELECT 1 FROM public.financial_wallet_finality_seals seal
              WHERE seal.network=public.r36_network() AND seal.source_wallet=done.a2u_from_address
                AND seal.owner_payment_id=i.payment_id AND seal.operation_kind='settlement'
                AND seal.owner_operation_id=done.a2u_payment_id AND seal.prepared_tx_hash=done.prepared_tx_hash
                AND seal.prepared_sequence=done.prepared_sequence::text)
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.refund_checkpoints done
          JOIN public.settlement_checkpoints identity ON identity.payment_id=done.payment_id
          WHERE done.payment_id=i.payment_id AND done.status='completed' AND done.stage='audit_recorded'
            AND identity.stage='payment_identity' AND identity.merchant_id=i.merchant_id
            AND identity.merchant_uid=i.merchant_uid AND identity.customer_amount=i.customer_amount
            AND identity.merchant_amount+identity.app_commission=i.customer_amount
            AND done.amount=i.customer_amount AND done.payer_uid=identity.payer_uid
            AND EXISTS(SELECT 1 FROM public.financial_wallet_finality_seals seal
              WHERE seal.network=public.r36_network() AND seal.owner_payment_id=i.payment_id
                AND seal.operation_kind='refund' AND seal.owner_operation_id=done.refund_id
                AND seal.prepared_tx_hash=done.refund_txid)
            AND EXISTS(SELECT 1 FROM public.refund_audit_events proof
              WHERE proof.refund_id=done.refund_id AND proof.payment_id=i.payment_id
                AND proof.idempotency_key=done.idempotency_key
                AND proof.event_type='refund_presentation_proof_recorded')
        )
    ), classified AS (
      SELECT CASE
        WHEN c.payment_id IS NULL OR c.merchant_id IS DISTINCT FROM i.merchant_id OR c.merchant_uid IS DISTINCT FROM i.merchant_uid
          OR c.customer_amount IS DISTINCT FROM i.customer_amount OR (c.merchant_amount+c.app_commission) IS DISTINCT FROM i.customer_amount
          OR i.customer_amount <= 0 OR (r.payment_id IS NOT NULL AND r.amount <> i.customer_amount)
          THEN 'held'
        WHEN r.status = 'manual_review_required' OR r.stage = 'wallet_submission_started'
          OR EXISTS (SELECT 1 FROM public.financial_wallet_submission_attempts a WHERE a.owner_payment_id=i.payment_id)
          THEN 'held'
        WHEN r.payment_id IS NOT NULL AND c.stage <> 'payment_identity' THEN 'held'
        WHEN c.stage='db_finalized' OR r.status='completed' THEN 'terminal_checkpoint'
        ELSE 'pending'
      END AS state,
      ((c.u2a_verified_at IS NOT NULL AND c.stage <> 'db_finalized') OR
       (c.u2a_approval_attempted_at IS NOT NULL AND c.u2a_verified_at IS NULL AND c.stage='payment_identity') OR c.stage='db_finalized' OR
       (r.payment_id IS NOT NULL AND r.status <> 'manual_review_required')) AS evidence_work
      FROM scoped i LEFT JOIN public.settlement_checkpoints c USING (payment_id)
      LEFT JOIN public.refund_checkpoints r USING (payment_id)
    )
 SELECT EXISTS(SELECT 1 FROM classified WHERE evidence_work OR state='held')
$work$;
ALTER FUNCTION public.r36_recovery_work_needed(text) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_recovery_work_needed(text) FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;

CREATE OR REPLACE FUNCTION public.r36_schedule_recovery_work() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $work$
BEGIN
 -- Use the same durable scope and finality predicates as the read-only route.
 -- Already queued work is retained until the exact revision is acknowledged.
 IF public.r36_recovery_work_needed(NEW.payment_id) THEN
  INSERT INTO public.r36_recovery_work(payment_id) VALUES(NEW.payment_id)
  ON CONFLICT(payment_id) DO UPDATE SET revision=r36_recovery_work.revision+1;
 ELSE
  -- A request inserted before its identity checkpoint needs no recovery once
  -- that checkpoint proves it is merely unpaid. Never erase a live lease.
  DELETE FROM public.r36_recovery_work WHERE payment_id=NEW.payment_id AND lease_token IS NULL;
 END IF;
 RETURN NEW;
END $work$;
ALTER FUNCTION public.r36_schedule_recovery_work() OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_schedule_recovery_work() FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;

CREATE OR REPLACE FUNCTION public.r36_claim_recovery_work(p_limit integer) RETURNS TABLE(payment_id text,revision bigint,lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $work$
BEGIN
 IF session_user<>'neondb_owner' OR p_limit IS NULL OR p_limit<1 OR p_limit>32 THEN RAISE EXCEPTION 'RECOVERY_PAGE_INVALID'; END IF;
 RETURN QUERY
 WITH picked AS (
  SELECT w.payment_id FROM public.r36_recovery_work w
  WHERE w.next_visit_at<=clock_timestamp()
  ORDER BY w.next_visit_at,w.payment_id FOR UPDATE SKIP LOCKED LIMIT p_limit
 ) UPDATE public.r36_recovery_work w SET lease_token=gen_random_uuid(),
   lease_until=clock_timestamp()+interval '120 seconds',next_visit_at=clock_timestamp()+interval '120 seconds'
 FROM picked p WHERE w.payment_id=p.payment_id RETURNING w.payment_id,w.revision,w.lease_token;
END $work$;
ALTER FUNCTION public.r36_claim_recovery_work(integer) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_claim_recovery_work(integer) FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;

CREATE OR REPLACE FUNCTION public.r36_finish_recovery_work(p_id text,p_revision bigint,p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $work$
DECLARE w public.r36_recovery_work;
BEGIN
 IF session_user<>'neondb_owner' THEN RETURN false; END IF;
 SELECT * INTO w FROM public.r36_recovery_work WHERE payment_id=p_id FOR UPDATE;
 IF NOT FOUND OR w.lease_token IS DISTINCT FROM p_token OR w.lease_until<=clock_timestamp() THEN RETURN false; END IF;
 IF w.revision=p_revision AND NOT public.r36_recovery_work_needed(p_id) THEN
  DELETE FROM public.r36_recovery_work WHERE payment_id=p_id;
 ELSE
  UPDATE public.r36_recovery_work SET lease_token=NULL,lease_until=NULL,next_visit_at=clock_timestamp()+interval '5 seconds' WHERE payment_id=p_id;
 END IF;
 RETURN true;
END $work$;
ALTER FUNCTION public.r36_finish_recovery_work(text,bigint,uuid) OWNER TO r36_owner;
REVOKE ALL ON FUNCTION public.r36_finish_recovery_work(text,bigint,uuid) FROM PUBLIC,r36_runtime,r36_issuer,r36_signer,r36_registrar,r36_evidence_reader;

DO $work$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['settlement_checkpoints','refund_checkpoints','payment_create_intents'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||t)::regclass AND tgname='r36_schedule_recovery_work') THEN
   EXECUTE format('CREATE TRIGGER r36_schedule_recovery_work AFTER INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.r36_schedule_recovery_work()',t);
  END IF;
 END LOOP;
END $work$;
-- One installation backfill. Normal wakes read only the bounded due-work index.
INSERT INTO public.r36_recovery_work(payment_id)
 SELECT i.payment_id FROM public.payment_create_intents i,public.kernel_deployment_identity k
 WHERE i.created_at>k.recovery_cutover AND public.r36_recovery_work_needed(i.payment_id)
 ON CONFLICT DO NOTHING;

GRANT EXECUTE ON FUNCTION public.r36_claim_recovery_work(integer),public.r36_finish_recovery_work(text,bigint,uuid) TO neondb_owner;

DELETE FROM public.r36_recovery_work w WHERE w.lease_token IS NULL AND NOT public.r36_recovery_work_needed(w.payment_id);
