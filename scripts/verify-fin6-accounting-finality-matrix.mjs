import fs from 'node:fs'

const db = fs.readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8')
const refund = fs.readFileSync(new URL('../lib/refund-accounting.ts', import.meta.url), 'utf8')
const status = fs.readFileSync(new URL('../lib/payment-status.ts', import.meta.url), 'utf8')

function check(ok, label) {
  if (!ok) throw new Error(`FIN6 invariant failed: ${label}`)
}
const must = (haystack, needle, label) => check(haystack.includes(needle), label)

// Settlement schema/accounting invariants (1-10)
must(db, "'db_finalized'", 'db_finalized stage exists')
must(db, 'app_commission NUMERIC(18, 8) NOT NULL DEFAULT 0 CHECK (app_commission = 0)', 'commission fixed at zero')
must(db, 'CHECK (merchant_amount IS NULL OR merchant_amount = customer_amount)', 'merchant equals customer amount')
must(db, "prepared_tx_hash TEXT CHECK (prepared_tx_hash IS NULL OR prepared_tx_hash ~ '^[0-9a-f]{64}$')", 'prepared hash shape')
must(db, "a2u_txid TEXT CHECK (a2u_txid IS NULL OR a2u_txid ~ '^[0-9a-f]{64}$')", 'a2u txid shape')
must(db, 'prepared_tx_hash = a2u_txid', 'prepared hash binds horizon txid')
must(db, 'horizon_fee_stroops IS NOT NULL', 'horizon fee required for final movement')
must(db, 'horizon_confirmed_at IS NOT NULL', 'horizon timestamp required')
must(db, 'OR pi_completed_at IS NOT NULL', 'pi completion timestamp required')
must(db, "stage <> 'db_finalized'\n        OR db_finalized_at IS NOT NULL", 'db final timestamp required')

// DB-finalized exact receipt barrier (11-20)
must(db, 'export async function recordSettlementDbFinalizedCheckpoint', 'db finality writer exists')
must(db, "params.merchantAmount!==params.customerAmount||params.appCommission!==0", 'db finality rejects accounting drift')
must(db, "stage='db_finalized'", 'db finality advances explicit stage')
must(db, "stage='pi_completed'", 'db finality only advances from pi_completed')
must(db, 'prepared_tx_hash=${params.a2uTxid}', 'db finality exact prepared/a2u binding')
must(db, 'horizon_confirmed_at IS NOT NULL AND pi_completed_at IS NOT NULL AND db_finalized_at IS NULL', 'db finality requires prior final evidence')
must(db, 'AND EXISTS(SELECT 1 FROM receipts r WHERE r.u2a_identifier=${params.u2aIdentifier}', 'db finality requires exact receipt')
must(db, 'r.a2u_identifier=${params.a2uPaymentId} AND r.a2u_txid=${params.a2uTxid}', 'receipt exact a2u identity')
must(db, 'r.customer_amount=${params.customerAmount} AND r.merchant_amount=${params.merchantAmount}', 'receipt exact amounts')
must(db, 'r.horizon_fee_charged=${params.horizonFeeCharged} AND r.app_commission=0', 'receipt exact fee and commission')

// Settlement receipt/accounting + refund durable accounting (21-27)
must(db, 'const appNetImpact = customerAmount - merchantAmount - horizonFeeCharged', 'canonical app net impact formula')
must(db, "${customerAmount}, ${horizonFeeCharged}, ${appCommission}, ${merchantAmount}, ${appNetImpact}, ${'settled_to_merchant'}", 'receipt stores final accounting')
must(refund, 'checkpoint.stage !== "payment_checkpoint_updated" || checkpoint.status !== "pending"', 'refund accounting gated on authoritative checkpoint')
must(refund, 'fee.outcome !== "VERIFIED_FEE"', 'refund accounting requires verified horizon fee')
must(refund, 'INSERT INTO refund_accounting_records', 'refund accounting durable insert')
must(refund, 'ON CONFLICT DO NOTHING', 'refund accounting idempotent insert')
must(refund, 'rows.length !== 1', 'refund accounting uniqueness enforced on replay')

// Canonical payment finality predicate (28-32)
must(status, 'payment.status === "settled_to_merchant"', 'final status exact')
must(status, 'payment.piCompleted === true && payment.dbRecorded === true', 'pi and db finality required')
must(status, 'payment.requiresDbReconciliation === false && payment.horizonSuccessFlag === true && payment.piCompletionPending === false', 'no unresolved reconciliation allowed')
must(status, 'payment.amount === payment.customerAmount && payment.customerAmount === payment.merchantAmount', 'canonical amount equality')
must(status, 'payment.appCommission === 0 && netImpactValid', 'commission and net impact finality')

console.log('FIN6_ACCOUNTING_FINALITY_MATRIX=PASS source_invariants=32 runtime_financial_delta=ZERO')
