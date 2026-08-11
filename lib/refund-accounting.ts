import "server-only"

import { redis, isRedisConfigured } from "./redis"
import { query } from "./db"
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
  if (!checkpoint || checkpoint.stage !== "payment_checkpoint_updated" || checkpoint.status !== "pending" ||
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
    const inserted = await query(`
      INSERT INTO refund_accounting_records
        (refund_id, payment_id, refund_payment_id, refund_txid, payer_uid, amount, horizon_fee_stroops, currency)
      SELECT refund_id, payment_id, refund_payment_id, refund_txid, payer_uid, amount, $1, 'π'
      FROM refund_checkpoints
      WHERE refund_id=$2 AND payment_id=$3 AND refund_payment_id=$4 AND refund_txid=$5
        AND stage='payment_checkpoint_updated' AND status='pending'
      ON CONFLICT DO NOTHING
      RETURNING refund_id`, [fee.horizonFeeStroops, refundId, checkpoint.paymentId, checkpoint.refundPaymentId, checkpoint.refundTxid])
    if (Array.isArray(inserted) && inserted.length === 1) return { outcome: "RECORDED" }
    const rows = await query(`
      SELECT * FROM refund_accounting_records
      WHERE refund_id=$1 OR payment_id=$2 OR refund_payment_id=$3 OR refund_txid=$4`,
      [refundId, checkpoint.paymentId, checkpoint.refundPaymentId, checkpoint.refundTxid])
    if (!Array.isArray(rows) || rows.length !== 1) return { outcome: "CONFLICT" }
    const row = record(rows[0])
    if (!row || row.refund_id !== refundId || row.payment_id !== checkpoint.paymentId ||
      row.refund_payment_id !== checkpoint.refundPaymentId || row.refund_txid !== checkpoint.refundTxid ||
      row.payer_uid !== checkpoint.payerUid || row.amount !== checkpoint.amount ||
      row.horizon_fee_stroops !== fee.horizonFeeStroops || row.currency !== "π") return { outcome: "CONFLICT" }
    return { outcome: "REPLAYED" }
  } catch {
    return { outcome: "INDETERMINATE" }
  }
}

export type { AccountingResult }
