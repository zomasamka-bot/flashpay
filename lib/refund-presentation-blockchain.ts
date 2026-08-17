import "server-only"

import { redis, isRedisConfigured } from "./redis"
import { serverConfig } from "./server-config"
import { extractRefundHorizonTransactionAt } from "./refund-presentation"
import type { RefundCheckpoint, RefundPresentationBlockchainReadResult } from "./types"

interface PiPaymentRecord {
  identifier?: unknown
  user_uid?: unknown
  amount?: unknown
  memo?: unknown
  metadata?: unknown
  to_address?: unknown
  status?: {
    transaction_verified?: unknown
    cancelled?: unknown
    user_cancelled?: unknown
    developer_completed?: unknown
  }
  transaction?: {
    id?: unknown
    verified?: unknown
  } | null
}

function isPendingStage(checkpoint: RefundCheckpoint): boolean {
  return checkpoint.stage === "eligibility_verified" || checkpoint.stage === "intent_created" || checkpoint.stage === "wallet_submission_started"
}

function hasConfirmedStage(checkpoint: RefundCheckpoint): boolean {
  return checkpoint.stage === "wallet_submission_confirmed" || checkpoint.stage === "payment_checkpoint_updated" || checkpoint.stage === "accounting_recorded" || checkpoint.stage === "audit_recorded"
}

export async function readRefundPresentationBlockchain(checkpoint: RefundCheckpoint): Promise<RefundPresentationBlockchainReadResult> {
  const paymentId = checkpoint.refundPaymentId
  const txid = checkpoint.refundTxid

  if (isPendingStage(checkpoint)) {
    if (checkpoint.stage === "wallet_submission_started" && paymentId && txid) return { outcome: "INDETERMINATE" }
    if (checkpoint.stage !== "wallet_submission_started" && (paymentId || txid)) return { outcome: "INDETERMINATE" }
    return { outcome: "PENDING" }
  }
  if (!hasConfirmedStage(checkpoint) || typeof paymentId !== "string" || paymentId.trim().length === 0 || typeof txid !== "string" || txid.trim().length === 0) return { outcome: "INDETERMINATE" }
  if (!isRedisConfigured) return { outcome: "INDETERMINATE" }

  let payment: PiPaymentRecord
  try {
    const cached = await redis.get<unknown>(`refund:pi-payment:${paymentId}`)
    if (cached && typeof cached === "object" && !Array.isArray(cached)) payment = cached as PiPaymentRecord
    else {
      const response = await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}`, {
        headers: { Authorization: `Key ${serverConfig.piApiKey}` },
        cache: "no-store",
      })
      if (!response.ok) return { outcome: "INDETERMINATE" }
      const body: unknown = await response.json()
      if (typeof body !== "object" || body === null || Array.isArray(body)) return { outcome: "INDETERMINATE" }
      payment = body as PiPaymentRecord
    }

    const status = payment.status
    const metadata = payment.metadata
    const metadataRecord = typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) ? metadata as Record<string, unknown> : null
    if (
      payment.identifier !== paymentId ||
      payment.user_uid !== checkpoint.payerUid ||
      payment.amount !== checkpoint.amount ||
      metadataRecord?.paymentId !== checkpoint.paymentId ||
      status?.cancelled !== false ||
      status?.user_cancelled !== false ||
      status?.transaction_verified !== true ||
      payment.transaction?.verified !== true ||
      payment.transaction.id !== txid
    ) return { outcome: "INDETERMINATE" }

    const horizonResponse = await fetch(`https://api.testnet.minepi.com/transactions/${encodeURIComponent(txid)}`, { cache: "no-store" })
    if (!horizonResponse.ok) return { outcome: "INDETERMINATE" }
    const horizonBody: unknown = await horizonResponse.json()
    const transactionAt = extractRefundHorizonTransactionAt(horizonBody, txid)
    if (!transactionAt) return { outcome: "INDETERMINATE" }

    return { outcome: "CONFIRMED", transactionAt, network: "Pi Testnet", piTransactionVerified: true, piDeveloperCompleted: status?.developer_completed === true, horizonSuccessful: true }
  } catch {
    return { outcome: "INDETERMINATE" }
  }
}
