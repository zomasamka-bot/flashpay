import "server-only"

import { redis, isRedisConfigured } from "./redis"
import { withPaymentAuthorityTransaction } from "./db"
import { ensurePaymentOperationLock, getRefundCheckpointAuthoritative, verifyRefundAccountingSchema } from "./refund-checkpoint-store"
import { readRefundHorizonFee } from "./refund-fee-evidence"
import type { Payment } from "./types"

type AccountingResult =
  | { outcome: "RECORDED" }
  | { outcome: "REPLAYED" }
  | { outcome: "CONFLICT" }
  | { outcome: "INDETERMINATE" }

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function paymentFromRedis(value: unknown): Payment | null {
  const item = record(value)
  if (!item || typeof item.id !== "string" || typeof item.payerUid !== "string" || typeof item.customerAmount !== "number") return null
  return item as unknown as Payment
}

export async function recordRefundAccounting(refundId: string): Promise<AccountingResult> {
  if (!refundId || !isRedisConfigured || !(await verifyRefundAccountingSchema())) return { outcome: "INDETERMINATE" }
  const initial = await getRefundCheckpointAuthoritative(refundId)
  if (!initial || !await ensurePaymentOperationLock(initial.paymentId, refundId)) return { outcome: "INDETERMINATE" }
  const checkpoint = await getRefundCheckpointAuthoritative(refundId)
  if (!checkpoint || checkpoint.paymentId !== initial.paymentId || checkpoint.stage !== "payment_checkpoint_updated" || checkpoint.status !== "pending" ||
    typeof checkpoint.refundPaymentId !== "string" || checkpoint.refundPaymentId.length === 0 ||
    typeof checkpoint.refundTxid !== "string" || checkpoint.refundTxid.length === 0) return { outcome: "INDETERMINATE" }
  const payment = paymentFromRedis(await redis.get(`payment:${checkpoint.paymentId}`))
  if (!payment || payment.id !== checkpoint.paymentId || payment.payerUid !== checkpoint.payerUid ||
    payment.customerAmount !== checkpoint.amount || payment.refundPaymentId !== checkpoint.refundPaymentId ||
    payment.refundTxid !== checkpoint.refundTxid || payment.status !== "refund_pending" ||
    payment.refundStatus !== "submitted" || payment.settlementFailureState !== "refund_pending") return { outcome: "INDETERMINATE" }
  const fee = await readRefundHorizonFee(refundId)
  if (fee.outcome !== "VERIFIED_FEE") return { outcome: "INDETERMINATE" }
  try {
    // R36: Serialize refund accounting with settlement accounting on the exact
    // canonical paymentId. Redis is only a coordination hint, never XOR truth.
    // All durable checks and the write below use the SAME PostgreSQL tx.
    const outcome = await withPaymentAuthorityTransaction(checkpoint.paymentId, async (tx) => {
      const authority = await tx`
        SELECT c.refund_id, c.payment_id, c.refund_payment_id, c.refund_txid,
               c.payer_uid, c.amount, c.stage, c.status
        FROM refund_checkpoints c
        WHERE c.refund_id=${refundId} AND c.payment_id=${checkpoint.paymentId}
        FOR UPDATE OF c
      `
      if (authority.length !== 1) return { outcome: "INDETERMINATE" } as AccountingResult
      const c = authority[0]
      if (c.refund_payment_id !== checkpoint.refundPaymentId ||
          c.refund_txid !== checkpoint.refundTxid || c.payer_uid !== checkpoint.payerUid ||
          Number(c.amount) !== checkpoint.amount || c.stage !== "payment_checkpoint_updated" ||
          c.status !== "pending") return { outcome: "INDETERMINATE" } as AccountingResult

      // A completed settlement may not be followed by a refund accounting entry.
      // An existing settlement receipt or ledger entry also blocks, including
      // when its checkpoint is stale. Ambiguous DB evidence fails closed.
      const opposite = await tx`
        SELECT
          EXISTS(SELECT 1 FROM receipts r
                 WHERE r.u2a_identifier IN
                   (SELECT s.u2a_identifier FROM settlement_checkpoints s
                    WHERE s.payment_id=${checkpoint.paymentId})) AS has_receipt,
          EXISTS(SELECT 1 FROM transactions t
                 WHERE t.payment_id IN
                   (SELECT s.u2a_identifier FROM settlement_checkpoints s
                    WHERE s.payment_id=${checkpoint.paymentId})) AS has_transaction,
          EXISTS(SELECT 1 FROM settlement_checkpoints s
                 WHERE s.payment_id=${checkpoint.paymentId}
                   AND (s.stage IN ('pi_completed','db_finalized')
                     OR s.horizon_confirmed_at IS NOT NULL
                     OR s.pi_completed_at IS NOT NULL)) AS settlement_finality
      `
      if (opposite.length !== 1 || opposite[0].has_receipt !== false ||
          opposite[0].has_transaction !== false || opposite[0].settlement_finality !== false) {
        return { outcome: "CONFLICT" } as AccountingResult
      }

      const inserted = await tx`
        INSERT INTO refund_accounting_records
          (refund_id, payment_id, refund_payment_id, refund_txid, payer_uid,
           amount, horizon_fee_stroops, currency)
        SELECT refund_id, payment_id, refund_payment_id, refund_txid, payer_uid,
               amount, ${fee.horizonFeeStroops}, 'π'
        FROM refund_checkpoints
        WHERE refund_id=${refundId} AND payment_id=${checkpoint.paymentId}
          AND refund_payment_id=${checkpoint.refundPaymentId}
          AND refund_txid=${checkpoint.refundTxid}
          AND stage='payment_checkpoint_updated' AND status='pending'
        ON CONFLICT DO NOTHING
        RETURNING refund_id
      `
      if (inserted.length === 1) return { outcome: "RECORDED" } as AccountingResult
      const rows = await tx`
        SELECT refund_id, payment_id, refund_payment_id, refund_txid, payer_uid,
               currency, (amount = ${checkpoint.amount}::numeric
               AND horizon_fee_stroops = ${fee.horizonFeeStroops}::bigint) AS exact_numeric_match
        FROM refund_accounting_records
        WHERE refund_id=${refundId} OR payment_id=${checkpoint.paymentId}
          OR refund_payment_id=${checkpoint.refundPaymentId}
          OR refund_txid=${checkpoint.refundTxid}
      `
      if (rows.length !== 1) return { outcome: "CONFLICT" } as AccountingResult
      const row = record(rows[0])
      if (!row || row.refund_id !== refundId || row.payment_id !== checkpoint.paymentId ||
          row.refund_payment_id !== checkpoint.refundPaymentId ||
          row.refund_txid !== checkpoint.refundTxid || row.payer_uid !== checkpoint.payerUid ||
          row.currency !== "π" || row.exact_numeric_match !== true) {
        return { outcome: "CONFLICT" } as AccountingResult
      }
      return { outcome: "REPLAYED" } as AccountingResult
    })
    return outcome ?? { outcome: "INDETERMINATE" }

  } catch {
    return { outcome: "INDETERMINATE" }
  }
}

export type { AccountingResult }
