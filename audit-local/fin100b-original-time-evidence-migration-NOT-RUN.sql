-- FIN-100B DESIGN ONLY. NOT EXECUTED. NOT SAFE TO AUTO-BACKFILL.
-- Every row requires independently verified original PAYMENT CREATION evidence,
-- not Redis createdAt, checkpoint creation timestamp, payment verification time,
-- receipt time, account transaction time, or date of database insertion.
-- A signature/hash alone does NOT establish provenance or authority.
-- Migration may be applied only in a separately approved release after evidence
-- provenance and backfill methodology are reviewed per-payment.
BEGIN;
CREATE TABLE IF NOT EXISTS payment_creation_time_evidence (
  payment_id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL CHECK(length(btrim(merchant_id))>0),
  merchant_uid TEXT NOT NULL CHECK(length(btrim(merchant_uid))>0),
  customer_amount NUMERIC(18,8) NOT NULL CHECK(customer_amount>0),
  original_created_at TIMESTAMPTZ NOT NULL,
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('verified_original_payment_create_event', 'authenticated_legacy_creation_archive')),
  evidence_reference TEXT NOT NULL CHECK(length(btrim(evidence_reference))>0),
  evidence_sha256 TEXT NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
  certified_by TEXT NOT NULL CHECK(length(btrim(certified_by))>0),
  certified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_creation_time_evidence_orig_after_epoch CHECK(original_created_at > '1970-01-01'::timestamptz),
  CONSTRAINT payment_creation_time_evidence_checkpoint_fk FOREIGN KEY(payment_id)
      REFERENCES settlement_checkpoints(payment_id)
);
-- No historical rows are inserted. A separate evidence-certification procedure
-- MUST establish original creation time and matching payment/merchant/amount.
COMMIT;
