import "server-only"

import type { RefundCheckpoint } from "./types"
import type { RefundPiPayment } from "./refund-pi-reconciliation"

export type RefundBlockchainEvidenceResult =
  | { outcome: "VERIFIED_TX"; txid: string }
  | { outcome: "NO_TX" }
  | { outcome: "INDETERMINATE" }

type Input = {
  checkpoint: RefundCheckpoint
  payment: RefundPiPayment
}

const HORIZON_BASE = "https://api.testnet.minepi.com"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function getJson(path: string): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    const response = await fetch(`${HORIZON_BASE}${path}`, { method: "GET", cache: "no-store" })
    if (!response.ok) return { ok: false }
    return { ok: true, body: await response.json() }
  } catch {
    return { ok: false }
  }
}

function exactAmount(value: unknown, amount: number): boolean {
  return typeof value === "string" && value === String(amount)
}

export async function verifyRefundBlockchainEvidence(input: Input): Promise<RefundBlockchainEvidenceResult> {
  const { checkpoint, payment } = input
  if (checkpoint.stage !== "wallet_submission_started" || checkpoint.status !== "pending" ||
    !checkpoint.refundPaymentId || checkpoint.paymentId !== payment.metadata.paymentId ||
    checkpoint.payerUid !== payment.user_uid || checkpoint.amount !== payment.amount ||
    payment.network !== "Pi Testnet" || payment.direction !== "app_to_user" ||
    payment.status.cancelled || payment.status.user_cancelled) return { outcome: "INDETERMINATE" }

  const transaction = payment.transaction
  if (transaction === null || typeof transaction.txid !== "string" || transaction.txid.length === 0) return { outcome: "NO_TX" }

  const txResult = await getJson(`/transactions/${encodeURIComponent(transaction.txid)}`)
  const operationsResult = await getJson(`/transactions/${encodeURIComponent(transaction.txid)}/operations`)
  if (!txResult.ok || !operationsResult.ok || !isRecord(txResult.body) || !isRecord(operationsResult.body)) return { outcome: "INDETERMINATE" }

  const tx = txResult.body
  if (tx.successful !== true || typeof tx.hash !== "string" || tx.hash !== transaction.txid ||
    typeof tx.id !== "string" || tx.id !== transaction.txid || tx.source_account !== payment.from_address ||
    tx.memo !== payment.identifier) return { outcome: "INDETERMINATE" }

  const records = operationsResult.body._embedded
  if (!isRecord(records) || !Array.isArray(records.records) || records.records.length !== 1) return { outcome: "INDETERMINATE" }
  const operation = records.records[0]
  if (!isRecord(operation) || operation.type !== "payment" || operation.asset_type !== "native" ||
    operation.source_account !== payment.from_address || operation.from !== payment.from_address ||
    operation.to !== payment.to_address || !exactAmount(operation.amount, checkpoint.amount)) return { outcome: "INDETERMINATE" }

  return { outcome: "VERIFIED_TX", txid: transaction.txid }
}
