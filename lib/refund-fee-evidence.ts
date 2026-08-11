import "server-only"

import { getRefundCheckpointAuthoritative } from "./refund-checkpoint-store"
import { reconcileRefundWithPi } from "./refund-pi-reconciliation"
import { serverConfig } from "./server-config"

export type RefundFeeEvidenceResult =
  | { outcome: "VERIFIED_FEE"; horizonFeeStroops: number }
  | { outcome: "INDETERMINATE" }

const HORIZON_BASE = "https://api.testnet.minepi.com"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function safeFee(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export async function readRefundHorizonFee(refundId: string): Promise<RefundFeeEvidenceResult> {
  if (!refundId || !serverConfig.piApiKey) return { outcome: "INDETERMINATE" }
  const checkpoint = await getRefundCheckpointAuthoritative(refundId)
  if (!checkpoint || checkpoint.stage !== "payment_checkpoint_updated" || checkpoint.status !== "pending" ||
    typeof checkpoint.refundPaymentId !== "string" || checkpoint.refundPaymentId.length === 0 ||
    typeof checkpoint.refundTxid !== "string" || checkpoint.refundTxid.length === 0) return { outcome: "INDETERMINATE" }
  const refundPaymentId = checkpoint.refundPaymentId
  const refundTxid = checkpoint.refundTxid
  const reconciliation = await reconcileRefundWithPi({
    paymentId: checkpoint.paymentId, refundId, idempotencyKey: checkpoint.idempotencyKey,
    payerUid: checkpoint.payerUid, amount: checkpoint.amount, refundPaymentId,
  })
  if (reconciliation.outcome !== "FOUND" || !reconciliation.payment || reconciliation.payment.identifier !== refundPaymentId ||
    reconciliation.payment.user_uid !== checkpoint.payerUid || reconciliation.payment.amount !== checkpoint.amount ||
    reconciliation.payment.status.developer_completed !== true || reconciliation.payment.status.cancelled ||
    reconciliation.payment.status.user_cancelled || reconciliation.payment.transaction === null ||
    reconciliation.payment.transaction.txid !== refundTxid || reconciliation.payment.transaction.verified !== true ||
    reconciliation.payment.status.transaction_verified !== true) return { outcome: "INDETERMINATE" }
  try {
    const response = await fetch(`${HORIZON_BASE}/transactions/${encodeURIComponent(refundTxid)}`, { method: "GET", cache: "no-store" })
    if (!response.ok) return { outcome: "INDETERMINATE" }
    const body: unknown = await response.json()
    if (!isRecord(body) || body.successful !== true || body.id !== refundTxid || body.hash !== refundTxid ||
      body.source_account !== reconciliation.payment.from_address || body.memo_type !== "text" || body.memo !== refundPaymentId ||
      body.operation_count !== 1) return { outcome: "INDETERMINATE" }
    const fee = safeFee(body.fee_charged)
    return fee === null ? { outcome: "INDETERMINATE" } : { outcome: "VERIFIED_FEE", horizonFeeStroops: fee }
  } catch {
    return { outcome: "INDETERMINATE" }
  }
}
