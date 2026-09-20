import "server-only"

import type { RefundCheckpoint } from "./types"
import type { RefundPiPayment } from "./refund-pi-reconciliation"
import type { SettlementSubmitHorizonReadResult } from "./financial-recovery-settlement-submit-horizon-reader"
import { exactStroopAmountMatch, numberToExactPositiveStroops, stellarAmountToExactPositiveStroops } from "./financial-amount-stroops"

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

type RefundPreparedHorizonExpected = {
  preparedHash: string
  preparedSequence: string
  refundPaymentId: string
  fromAddress: string
  toAddress: string
  amount: number
}

type RefundPreparedHorizonEvaluation =
  | { outcome: "VERIFIED"; reference: RefundPreparedHorizonExpected; moneyMovementProven: true; horizonFeeCharged: number; authorizesFinancialAction: false }
  | { outcome: "UNRESOLVED"; reference: RefundPreparedHorizonExpected; observedSourceSequence: string; moneyMovementProven: false; authorizesFinancialAction: false }
  | { outcome: "BLOCKED"; reference: null; moneyMovementProven: false; horizonFeeCharged?: never; authorizesFinancialAction: false }

export function evaluateRefundPreparedHorizonBinding(read: SettlementSubmitHorizonReadResult, expected: RefundPreparedHorizonExpected): RefundPreparedHorizonEvaluation {
  const blocked: RefundPreparedHorizonEvaluation = { outcome: "BLOCKED", reference: null, moneyMovementProven: false, authorizesFinancialAction: false }
  if (numberToExactPositiveStroops(expected.amount) === null || !expected.preparedHash || expected.preparedHash !== expected.preparedHash.trim() || !/^[0-9a-f]{64}$/.test(expected.preparedHash) || !expected.preparedSequence || expected.preparedSequence !== expected.preparedSequence.trim() || !/^[1-9][0-9]*$/.test(expected.preparedSequence) || !expected.refundPaymentId || expected.refundPaymentId !== expected.refundPaymentId.trim() || !expected.fromAddress || expected.fromAddress !== expected.fromAddress.trim() || !expected.toAddress || expected.toAddress !== expected.toAddress.trim()) return blocked
  if (read.outcome === "INDETERMINATE") return blocked
  if (read.preparedHash !== expected.preparedHash || read.preparedSequence !== expected.preparedSequence || read.fromAddress !== expected.fromAddress) return blocked
  if (read.outcome === "HASH_NOT_FOUND") return /^(0|[1-9][0-9]*)$/.test(read.observedSourceSequence) ? { outcome: "UNRESOLVED", reference: expected, observedSourceSequence: read.observedSourceSequence, moneyMovementProven: false, authorizesFinancialAction: false } : blocked
  if (read.source !== "HORIZON_TX_OPS" || !isRecord(read.transaction) || read.transaction.hash !== expected.preparedHash || read.transaction.id !== expected.preparedHash || read.transaction.successful !== true || read.transaction.source_account !== expected.fromAddress || read.transaction.source_account_sequence !== expected.preparedSequence || read.transaction.memo_type !== "text" || read.transaction.memo !== expected.refundPaymentId || read.transaction.operation_count !== 1 || read.operations.length !== 1 || !isRecord(read.operations[0])) return blocked
  const transaction = read.transaction
  const operation = read.operations[0]
  if (operation.type !== "payment" || operation.transaction_hash !== expected.preparedHash || operation.transaction_successful !== true || operation.source_account !== expected.fromAddress || operation.from !== expected.fromAddress || operation.to !== expected.toAddress || operation.asset_type !== "native" || !exactStroopAmountMatch(operation.amount, expected.amount)) return blocked
  const feeValue = transaction.fee_charged
  if (!((typeof feeValue === "number" && Number.isSafeInteger(feeValue) && feeValue >= 0) || (typeof feeValue === "string" && /^(0|[1-9][0-9]*)$/.test(feeValue) && Number.isSafeInteger(Number(feeValue))))) return blocked
  const fee = typeof feeValue === "number" ? feeValue : Number(feeValue)
  return { outcome: "VERIFIED", reference: expected, moneyMovementProven: true, horizonFeeCharged: fee / 10_000_000, authorizesFinancialAction: false }
}

function compareDecimalStrings(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

function incrementDecimalString(value: string): string {
  const digits = value.split("")
  let carry = 1
  for (let index = digits.length - 1; index >= 0 && carry === 1; index -= 1) {
    if (digits[index] === "9") digits[index] = "0"
    else {
      digits[index] = String(Number(digits[index]) + 1)
      carry = 0
    }
  }
  return carry === 1 ? `1${digits.join("")}` : digits.join("")
}

type RefundPreparedSequenceClassification = Readonly<
  | { authorizesFinancialAction: false; outcome: "BLOCKED"; reference: null; moneyMovementProven: false }
  | { authorizesFinancialAction: false; outcome: "PREPARED_IS_NEXT"; reference: Extract<ReturnType<typeof evaluateRefundPreparedHorizonBinding>, { outcome: "UNRESOLVED" }>['reference']; observedSourceSequence: string; moneyMovementProven: false }
  | { authorizesFinancialAction: false; outcome: "SOURCE_AT_OR_PAST_PREPARED"; reference: Extract<ReturnType<typeof evaluateRefundPreparedHorizonBinding>, { outcome: "UNRESOLVED" }>['reference']; observedSourceSequence: string; moneyMovementProven: false }
  | { authorizesFinancialAction: false; outcome: "SOURCE_BEHIND_PREPARED_GAP"; reference: Extract<ReturnType<typeof evaluateRefundPreparedHorizonBinding>, { outcome: "UNRESOLVED" }>['reference']; observedSourceSequence: string; moneyMovementProven: false }
>

export function classifyRefundPreparedSequence(input: ReturnType<typeof evaluateRefundPreparedHorizonBinding>): RefundPreparedSequenceClassification {
  if (input.outcome !== "UNRESOLVED") return { authorizesFinancialAction: false, outcome: "BLOCKED", reference: null, moneyMovementProven: false }
  if (!/^[1-9][0-9]*$/.test(input.reference.preparedSequence) || !/^(0|[1-9][0-9]*)$/.test(input.observedSourceSequence)) return { authorizesFinancialAction: false, outcome: "BLOCKED", reference: null, moneyMovementProven: false }
  const nextObserved = incrementDecimalString(input.observedSourceSequence)
  const comparison = compareDecimalStrings(input.observedSourceSequence, input.reference.preparedSequence)
  const outcome = nextObserved === input.reference.preparedSequence
    ? "PREPARED_IS_NEXT"
    : comparison >= 0
      ? "SOURCE_AT_OR_PAST_PREPARED"
      : "SOURCE_BEHIND_PREPARED_GAP"
  return { authorizesFinancialAction: false, outcome, reference: input.reference, observedSourceSequence: input.observedSourceSequence, moneyMovementProven: false }
}

export async function verifyRefundBlockchainEvidence(input: Input): Promise<RefundBlockchainEvidenceResult> {
  const { checkpoint, payment } = input
  if ((checkpoint.stage !== "wallet_submission_started" && checkpoint.stage !== "wallet_submission_confirmed") || checkpoint.status !== "pending" ||
    !checkpoint.refundPaymentId || checkpoint.refundPaymentId !== payment.identifier || checkpoint.paymentId !== payment.metadata.paymentId ||
    checkpoint.payerUid !== payment.user_uid || checkpoint.amount !== payment.amount || numberToExactPositiveStroops(checkpoint.amount) === null || numberToExactPositiveStroops(payment.amount) === null ||
    payment.network !== "Pi Testnet" || payment.direction !== "app_to_user" ||
    payment.status.cancelled || payment.status.user_cancelled) return { outcome: "INDETERMINATE" }

  const transaction = payment.transaction
  let txid: string
  if (checkpoint.stage === "wallet_submission_started") {
    if (transaction === null) {
      if (payment.status.transaction_verified !== false || payment.status.developer_completed !== false) return { outcome: "INDETERMINATE" }
      return { outcome: "NO_TX" }
    }
    if (typeof transaction.txid !== "string" || transaction.txid.length === 0) return { outcome: "INDETERMINATE" }
    txid = transaction.txid
  } else {
    const confirmedTxid = checkpoint.refundTxid
    if (!confirmedTxid || (transaction !== null && (typeof transaction.txid !== "string" || transaction.txid.length === 0 || transaction.txid !== confirmedTxid))) return { outcome: "INDETERMINATE" }
    txid = confirmedTxid
  }

  const txResult = await getJson(`/transactions/${encodeURIComponent(txid)}`)
  const operationsResult = await getJson(`/transactions/${encodeURIComponent(txid)}/operations`)
  if (!txResult.ok || !operationsResult.ok || !isRecord(txResult.body) || !isRecord(operationsResult.body)) return { outcome: "INDETERMINATE" }

  const tx = txResult.body
  if (tx.successful !== true || typeof tx.hash !== "string" || tx.hash !== txid ||
    typeof tx.id !== "string" || tx.id !== txid || tx.source_account !== payment.from_address ||
    tx.memo_type !== "text" || tx.memo !== payment.identifier || tx.operation_count !== 1) return { outcome: "INDETERMINATE" }

  const records = operationsResult.body._embedded
  if (!isRecord(records) || !Array.isArray(records.records) || records.records.length !== 1) return { outcome: "INDETERMINATE" }
  const operation = records.records[0]
  if (!isRecord(operation) || operation.type !== "payment" || operation.transaction_hash !== txid ||
    operation.transaction_successful !== true || operation.asset_type !== "native" ||
    operation.source_account !== payment.from_address || operation.from !== payment.from_address ||
    operation.to !== payment.to_address) return { outcome: "INDETERMINATE" }
  const checkpointStroops = numberToExactPositiveStroops(checkpoint.amount)
  const paymentStroops = numberToExactPositiveStroops(payment.amount)
  const operationStroops = stellarAmountToExactPositiveStroops(operation.amount)
  if (checkpointStroops === null || paymentStroops === null || operationStroops === null ||
    checkpointStroops !== paymentStroops || paymentStroops !== operationStroops) return { outcome: "INDETERMINATE" }

  return { outcome: "VERIFIED_TX", txid }
}
