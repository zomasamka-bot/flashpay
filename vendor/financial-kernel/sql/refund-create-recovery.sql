-- Operational identity preparation only; no financial rows or authorities change.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
CREATE TABLE IF NOT EXISTS public.refund_pi_identity_recovery (
 refund_id text PRIMARY KEY REFERENCES public.refund_checkpoints(refund_id),
 payment_id text NOT NULL UNIQUE REFERENCES public.settlement_checkpoints(payment_id),
 generation bigint NOT NULL CHECK(generation>0),
 attempted_at timestamptz NOT NULL,
 response_status integer CHECK(response_status BETWEEN 100 AND 599),
 response_code text CHECK(length(response_code)<=100),
 response_request_id text CHECK(length(response_request_id)<=128),
 response_sha256 text CHECK(response_sha256 ~ '^[0-9a-f]{64}$'),
 observed_at timestamptz
);
REVOKE ALL ON public.refund_pi_identity_recovery FROM PUBLIC;
COMMIT;
