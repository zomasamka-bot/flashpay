import "server-only"

import { reconcileRefundWithPi } from "./refund-pi-reconciliation"
import { extractRefundHorizonTransactionAt } from "./refund-presentation"
import type { RefundCheckpoint, RefundPresentationBlockchainReadResult } from "./types"

function isPendingStage(checkpoint: RefundCheckpoint): boolean {
  return checkpoint.stage === "eligibility_verified" || checkpoint.stage === "intent_created" || checkpoint.stage === "wallet_submission_started"
}

function hasConfirmedStage(checkpoint: RefundCheckpoint): boolean {
  return checkpoint.stage === "wallet_submission_confirmed" || checkpoint.stage === "payment_checkpoint_updated" || checkpoint.stage === "accounting_recorded" || checkpoint.stage === "audit_recorded"
}

export async function readRefundPresentationBlockchain(checkpoint: RefundCheckpoint): Promise<RefundPresentationBlockchainReadResult> {
  const paymentId = checkpoint.refundPaymentId
  const txid = checkpoint.refundTxid

  if (checkpoint.stage === "eligibility_verified" || checkpoint.stage === "intent_created") {
    if (paymentId === undefined && txid === undefined) return { outcome: "PENDING" }
    return { outcome: "INDETERMINATE" }
  }
  if (checkpoint.stage === "wallet_submission_started") {
    if (txid === undefined && (paymentId === undefined || (typeof paymentId === "string" && paymentId.trim().length > 0))) return { outcome: "PENDING" }
    return { outcome: "INDETERMINATE" }
  }
  if (!hasConfirmedStage(checkpoint) || typeof paymentId !== "string" || paymentId.trim().length === 0 || typeof txid !== "string" || txid.trim().length === 0) return { outcome: "INDETERMINATE" }

  try {
    const reconciliation = await reconcileRefundWithPi({
      paymentId: checkpoint.paymentId,
      refundId: checkpoint.refundId,
      idempotencyKey: checkpoint.idempotencyKey,
      payerUid: checkpoint.payerUid,
      amount: checkpoint.amount,
      refundPaymentId: paymentId,
    })
    if (reconciliation.outcome !== "FOUND" || !reconciliation.payment) return { outcome: "INDETERMINATE" }
    const payment = reconciliation.payment
    const status = payment.status
    if (
      payment.identifier !== paymentId ||
      status.cancelled !== false ||
      status.user_cancelled !== false ||
      status.transaction_verified !== true ||
      payment.transaction?.verified !== true ||
      payment.transaction?.txid !== txid
    ) return { outcome: "INDETERMINATE" }

    const horizonResponse = await fetch(`https://api.testnet.minepi.com/transactions/${encodeURIComponent(txid)}`, { cache: "no-store" })
    if (!horizonResponse.ok) return { outcome: "INDETERMINATE" }
    const horizonBody: unknown = await horizonResponse.json()
    const transactionAt = extractRefundHorizonTransactionAt(horizonBody, txid)
    if (!transactionAt) return { outcome: "INDETERMINATE" }

    return { outcome: "CONFIRMED", transactionAt, network: "Pi Testnet", piTransactionVerified: true, piDeveloperCompleted: status.developer_completed, horizonSuccessful: true }
  } catch {
    return { outcome: "INDETERMINATE" }
  }
}
