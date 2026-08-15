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

function stroops(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null
  const scaled = value * 10_000_000
  return Number.isSafeInteger(scaled) ? scaled : null
}

function parseStroops(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,7})?$/.test(value) || /^0+(?:\.0{1,7})?$/.test(value)) return null
  const [whole, fraction = ""] = value.split(".")
  const normalized = `${whole}${fraction.padEnd(7, "0")}`
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export async function verifyRefundBlockchainEvidence(input: Input): Promise<RefundBlockchainEvidenceResult> {
  const { checkpoint, payment } = input
  if ((checkpoint.stage !== "wallet_submission_started" && checkpoint.stage !== "wallet_submission_confirmed") || checkpoint.status !== "pending" ||
    !checkpoint.refundPaymentId || !checkpoint.refundTxid || checkpoint.refundPaymentId !== payment.identifier || checkpoint.paymentId !== payment.metadata.paymentId ||
    checkpoint.payerUid !== payment.user_uid || checkpoint.amount !== payment.amount || stroops(checkpoint.amount) === null || stroops(payment.amount) === null ||
    payment.network !== "Pi Testnet" || payment.direction !== "app_to_user" ||
    payment.status.cancelled || payment.status.user_cancelled) return { outcome: "INDETERMINATE" }

  const transaction = payment.transaction
  if (transaction !== null && (typeof transaction.txid !== "string" || transaction.txid.length === 0 || transaction.txid !== checkpoint.refundTxid)) return { outcome: "INDETERMINATE" }
  const txid = checkpoint.refundTxid

  const txResult = await getJson(`/transactions/${encodeURIComponent(txid)}`)
  const operationsResult = await getJson(`/transactions/${encodeURIComponent(txid)}/operations`)
  if (!txResult.ok || !operationsResult.ok || !isRecord(txResult.body) || !isRecord(operationsResult.body)) return { outcome: "INDETERMINATE" }

  const tx = txResult.body
  if (tx.successful !== true || typeof tx.hash !== "string" || tx.hash !== txid ||
    typeof tx.id !== "string" || tx.id !== txid || tx.source_account !== payment.from_address ||
    tx.memo !== payment.identifier) return { outcome: "INDETERMINATE" }

  const records = operationsResult.body._embedded
  if (!isRecord(records) || !Array.isArray(records.records) || records.records.length !== 1) return { outcome: "INDETERMINATE" }
  const operation = records.records[0]
  if (!isRecord(operation) || operation.type !== "payment" || operation.asset_type !== "native" ||
    operation.source_account !== payment.from_address || operation.from !== payment.from_address ||
    operation.to !== payment.to_address) return { outcome: "INDETERMINATE" }
  const checkpointStroops = stroops(checkpoint.amount)
  const paymentStroops = stroops(payment.amount)
  const operationStroops = parseStroops(operation.amount)
  if (checkpointStroops === null || paymentStroops === null || operationStroops === null ||
    checkpointStroops !== paymentStroops || paymentStroops !== operationStroops) return { outcome: "INDETERMINATE" }

  return { outcome: "VERIFIED_TX", txid }
}
