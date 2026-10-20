-- R36 extracted from original legacy runtime DDL. REVIEW ONLY; not an approved or complete migration.
-- Do not execute against production; compare with live schema and historical migration history first.
BEGIN;
CREATE TABLE IF NOT EXISTS settlement_checkpoints (
      payment_id TEXT PRIMARY KEY,
      version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
      stage TEXT NOT NULL CHECK (stage IN (
        'payment_identity',
        'a2u_created',
        'prepared',
        'horizon_confirmed',
        'pi_completed',
        'db_finalized'
      )),
      merchant_id TEXT NOT NULL CHECK (length(btrim(merchant_id)) > 0),
      merchant_uid TEXT NOT NULL CHECK (length(btrim(merchant_uid)) > 0),
      customer_amount NUMERIC(18, 8) NOT NULL CHECK (customer_amount > 0),
      merchant_amount NUMERIC(18, 8) CHECK (merchant_amount > 0),
      app_commission NUMERIC(18, 8) NOT NULL DEFAULT 0 CHECK (app_commission = 0),
      u2a_approval_identifier TEXT,
      u2a_approval_claimed_at TIMESTAMP,
      u2a_approval_guard_version TEXT,
      u2a_approval_attempted_at TIMESTAMP,
      u2a_start_lease_token TEXT,
      u2a_start_lease_expires_at TIMESTAMP,
      u2a_identifier TEXT,
      u2a_txid TEXT,
      payer_uid TEXT,
      u2a_verified_at TIMESTAMP,
      u2a_completed_at TIMESTAMP,
      a2u_create_guard_version TEXT,
      a2u_create_attempted_at TIMESTAMP,
      pi_mutation_guard_version TEXT,
      a2u_payment_id TEXT,
      a2u_from_address TEXT,
      a2u_to_address TEXT,
      prepared_envelope_xdr TEXT,
      prepared_tx_hash TEXT CHECK (prepared_tx_hash IS NULL OR prepared_tx_hash ~ '^[0-9a-f]{64}$'),
      prepared_sequence NUMERIC(30, 0) CHECK (prepared_sequence IS NULL OR prepared_sequence > 0),
      a2u_txid TEXT CHECK (a2u_txid IS NULL OR a2u_txid ~ '^[0-9a-f]{64}$'),
      horizon_fee_stroops BIGINT CHECK (horizon_fee_stroops IS NULL OR horizon_fee_stroops >= 0),
      horizon_confirmed_at TIMESTAMP,
      pi_completed_at TIMESTAMP,
      db_finalized_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      CHECK (merchant_amount IS NULL OR merchant_amount = customer_amount),
      CHECK (
        stage NOT IN ('a2u_created','prepared','horizon_confirmed','pi_completed','db_finalized')
        OR a2u_payment_id IS NOT NULL
      ),
      CHECK (
        stage NOT IN ('prepared','horizon_confirmed','pi_completed','db_finalized')
        OR (
          a2u_from_address IS NOT NULL AND
          a2u_to_address IS NOT NULL AND
          prepared_envelope_xdr IS NOT NULL AND
          prepared_tx_hash IS NOT NULL AND
          prepared_sequence IS NOT NULL
        )
      ),
      CHECK (
        stage NOT IN ('horizon_confirmed','pi_completed','db_finalized')
        OR (
          a2u_txid IS NOT NULL AND
          prepared_tx_hash = a2u_txid AND
          horizon_fee_stroops IS NOT NULL AND
          horizon_confirmed_at IS NOT NULL
        )
      ),
      CHECK (
        stage NOT IN ('pi_completed','db_finalized')
        OR pi_completed_at IS NOT NULL
      ),
      CHECK (
        stage <> 'db_finalized'
        OR db_finalized_at IS NOT NULL
      )
    );

ALTER TABLE settlement_checkpoints
      ADD COLUMN IF NOT EXISTS u2a_approval_identifier TEXT,
      ADD COLUMN IF NOT EXISTS u2a_approval_claimed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS u2a_approval_guard_version TEXT,
      ADD COLUMN IF NOT EXISTS u2a_approval_attempted_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS u2a_start_lease_token TEXT,
      ADD COLUMN IF NOT EXISTS u2a_start_lease_expires_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS u2a_identifier TEXT,
      ADD COLUMN IF NOT EXISTS u2a_txid TEXT,
      ADD COLUMN IF NOT EXISTS payer_uid TEXT,
      ADD COLUMN IF NOT EXISTS u2a_verified_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS u2a_completed_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS a2u_create_guard_version TEXT,
      ADD COLUMN IF NOT EXISTS a2u_create_attempted_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS pi_mutation_guard_version TEXT;

CREATE TABLE IF NOT EXISTS settlement_u2a_approval_retirements (
      payment_id TEXT NOT NULL,
      pi_payment_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason = 'pi_pretransaction_cancelled'),
      pi_cancelled_at TIMESTAMP NOT NULL,
      retired_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY(payment_id, pi_payment_id)
    );

CREATE TABLE IF NOT EXISTS financial_pi_mutation_attempts (
      mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('u2a_cancel','u2a_complete','a2u_complete','dr11_a2u_cancel','refund_complete')),
      payment_id TEXT NOT NULL,
      external_payment_id TEXT NOT NULL,
      txid TEXT,
      refund_id TEXT,
      attempted_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (mutation_kind, payment_id, external_payment_id)
    );

CREATE TABLE IF NOT EXISTS settlement_a2u_stage1_retirements (
      payment_id TEXT NOT NULL,
      a2u_payment_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason = 'pi_cancelled_before_transaction'),
      pi_cancelled_at TIMESTAMP NOT NULL,
      horizon_absence_proven_at TIMESTAMP NOT NULL,
      retired_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY(payment_id, a2u_payment_id)
    );

CREATE TABLE IF NOT EXISTS settlement_a2u_ongoing_observations (
      payment_id TEXT NOT NULL,
      a2u_payment_id TEXT NOT NULL,
      observed_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY(payment_id, a2u_payment_id)
    );

ALTER TABLE settlement_checkpoints
      ADD COLUMN IF NOT EXISTS certification_hold TEXT,
      ADD COLUMN IF NOT EXISTS certification_hold_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS certification_hold_expires_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_settlement_checkpoints_stage_updated
    ON settlement_checkpoints(stage, updated_at ASC);

CREATE TABLE IF NOT EXISTS settlement_recovery_scan_cursor (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
      last_updated_at TIMESTAMP,
      last_payment_id TEXT,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

CREATE TABLE IF NOT EXISTS u2a_ingress_recovery_scan_cursor (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
      last_updated_at TIMESTAMP,
      last_payment_id TEXT,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

CREATE TABLE IF NOT EXISTS refund_checkpoints (
      refund_id TEXT PRIMARY KEY,
      payment_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      payer_uid TEXT NOT NULL,
      payer_uid_verified_at TIMESTAMP NOT NULL,
      amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0),
      currency TEXT NOT NULL DEFAULT 'π',
      source_payment_status TEXT NOT NULL,
      source_settlement_state TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      refund_payment_id TEXT,
      refund_txid TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error_code TEXT,
      last_error_message TEXT,
      next_retry_at TIMESTAMP,
      pi_mutation_guard_version TEXT
    );

ALTER TABLE refund_checkpoints ADD COLUMN IF NOT EXISTS pi_mutation_guard_version TEXT;

CREATE TABLE IF NOT EXISTS financial_pi_mutation_attempts (
      mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('u2a_cancel','u2a_complete','a2u_complete','dr11_a2u_cancel','refund_complete')),
      payment_id TEXT NOT NULL, external_payment_id TEXT NOT NULL, txid TEXT, refund_id TEXT,
      attempted_at TIMESTAMP NOT NULL DEFAULT NOW(), PRIMARY KEY (mutation_kind,payment_id,external_payment_id)
    );

CREATE TABLE IF NOT EXISTS refund_pi_create_attempts (
      refund_id TEXT PRIMARY KEY REFERENCES refund_checkpoints(refund_id) ON DELETE RESTRICT,
      payment_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      attempted_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

CREATE TABLE IF NOT EXISTS refund_automatic_retirements (
      refund_id TEXT PRIMARY KEY REFERENCES refund_checkpoints(refund_id) ON DELETE RESTRICT,
      payment_id TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL,
      evidence_code TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

CREATE TABLE IF NOT EXISTS refund_audit_events (
      event_id TEXT PRIMARY KEY,
      refund_id TEXT NOT NULL REFERENCES refund_checkpoints(refund_id) ON DELETE RESTRICT,
      payment_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      details JSONB NOT NULL DEFAULT '{}'::jsonb
    );

CREATE TABLE IF NOT EXISTS refund_accounting_records (
        refund_id TEXT PRIMARY KEY REFERENCES refund_checkpoints(refund_id) ON DELETE RESTRICT,
        payment_id TEXT NOT NULL UNIQUE,
        refund_payment_id TEXT NOT NULL UNIQUE,
        refund_txid TEXT NOT NULL UNIQUE,
        payer_uid TEXT NOT NULL,
        amount NUMERIC(18, 8) NOT NULL CHECK (amount > 0),
        horizon_fee_stroops BIGINT NOT NULL CHECK (horizon_fee_stroops >= 0),
        currency TEXT NOT NULL DEFAULT 'π',
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payment_id TEXT NOT NULL UNIQUE,
        merchant_id TEXT NOT NULL,
        merchant_uid TEXT NOT NULL,
        amount NUMERIC(18, 8) NOT NULL,
        currency TEXT DEFAULT 'π',
        reference TEXT NOT NULL UNIQUE,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'completed',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP
      );

CREATE INDEX IF NOT EXISTS idx_transactions_merchant_created
      ON transactions(merchant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_created
      ON transactions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_payment_id
      ON transactions(payment_id);

CREATE TABLE IF NOT EXISTS receipts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id UUID NOT NULL UNIQUE,
        merchant_id TEXT NOT NULL,
        merchant_uid TEXT NOT NULL,
        amount NUMERIC(18, 8) NOT NULL,
        currency TEXT DEFAULT 'π',
        timestamp TIMESTAMP NOT NULL,
        txid TEXT,
        payer_username TEXT,
        u2a_identifier TEXT,
        u2a_txid TEXT,
        a2u_identifier TEXT,
        a2u_txid TEXT,
        metadata JSONB,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
      );

CREATE INDEX IF NOT EXISTS idx_receipts_merchant
      ON receipts(merchant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_receipts_created
      ON receipts(created_at DESC);

ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS merchant_uid TEXT NOT NULL DEFAULT '';

ALTER TABLE receipts
        ADD COLUMN IF NOT EXISTS merchant_uid TEXT NOT NULL DEFAULT '';

ALTER TABLE receipts
        ADD COLUMN IF NOT EXISTS u2a_identifier TEXT;

ALTER TABLE receipts
        ADD COLUMN IF NOT EXISTS u2a_txid TEXT;

ALTER TABLE receipts
        ADD COLUMN IF NOT EXISTS a2u_identifier TEXT;

ALTER TABLE receipts
        ADD COLUMN IF NOT EXISTS a2u_txid TEXT;

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS customer_amount NUMERIC(18, 8);

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS horizon_fee_charged NUMERIC(18, 8) DEFAULT 0;

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS app_commission NUMERIC(18, 8) DEFAULT 0;

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS merchant_amount NUMERIC(18, 8);

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS app_net_impact NUMERIC(18, 8) DEFAULT 0;

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS settlement_status TEXT DEFAULT 'pending';

CREATE TABLE IF NOT EXISTS merchant_balances (
        merchant_id TEXT PRIMARY KEY,
        settled NUMERIC(18, 8) DEFAULT 0,
        unsettled NUMERIC(18, 8) DEFAULT 0,
        last_updated TIMESTAMP DEFAULT NOW()
      );

CREATE INDEX IF NOT EXISTS idx_merchant_balances_merchant
      ON merchant_balances(merchant_id);

CREATE TABLE IF NOT EXISTS settlement_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        merchant_id TEXT NOT NULL,
        transaction_id UUID NOT NULL,
        amount NUMERIC(18, 8) NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMP,
        txid TEXT,
        error_message TEXT,
        retry_count INTEGER DEFAULT 0,
        FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
      );

CREATE INDEX IF NOT EXISTS idx_settlement_requests_merchant_status
      ON settlement_requests(merchant_id, status);

CREATE INDEX IF NOT EXISTS idx_settlement_requests_created
      ON settlement_requests(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_settlement_requests_status
      ON settlement_requests(status);

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS customer_amount NUMERIC(18, 8);

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS horizon_fee_charged NUMERIC(18, 8) DEFAULT 0;

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS app_commission NUMERIC(18, 8) DEFAULT 0;

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS merchant_amount NUMERIC(18, 8);

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS app_net_impact NUMERIC(18, 8) DEFAULT 0;

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS settlement_status TEXT DEFAULT 'pending';
COMMIT;
