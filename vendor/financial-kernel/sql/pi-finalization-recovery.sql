-- One bounded scheduling row per original metadata transition. No money authority.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE TABLE IF NOT EXISTS public.financial_pi_finalization_recovery (
 mutation_kind text NOT NULL CHECK(mutation_kind IN ('u2a_approve','u2a_complete','a2u_complete','refund_complete')),
 payment_id text NOT NULL REFERENCES public.settlement_checkpoints(payment_id),
 external_payment_id text NOT NULL,
 txid text CHECK(txid ~ '^[0-9a-f]{64}$'),
 refund_id text,
 generation bigint NOT NULL CHECK(generation>0),
 attempted_at timestamptz NOT NULL,
 PRIMARY KEY(mutation_kind,payment_id),
 CHECK((mutation_kind='u2a_approve' AND txid IS NULL) OR (mutation_kind<>'u2a_approve' AND txid IS NOT NULL)),
 CHECK((mutation_kind='refund_complete')=(refund_id IS NOT NULL))
);
REVOKE ALL ON public.financial_pi_finalization_recovery FROM PUBLIC;
CREATE TABLE IF NOT EXISTS public.payment_create_intent_retirements (
 merchant_uid text NOT NULL,create_intent_id uuid NOT NULL,retired_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(merchant_uid,create_intent_id)
);
REVOKE ALL ON public.payment_create_intent_retirements FROM PUBLIC;
COMMIT;
