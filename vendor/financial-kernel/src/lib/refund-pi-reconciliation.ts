import "server-only"

import { serverConfig } from "./server-config"
import { evaluateFinancialRecoveryPiCandidates } from "./financial-recovery-pi-candidate-rules"

export type RefundPiReconciliationOutcome = "FOUND" | "CONFIRMED_NONE" | "INDETERMINATE"

export type RefundPiReconciliationInput = {
  paymentId: string
  refundId: string
  idempotencyKey: string
  payerUid: string
  amount: number
  refundPaymentId?: string | null
}

export type RefundPiPayment = {
  identifier: string
  user_uid: string
  amount: number
  memo: string
  metadata: {
    type: "refund"
    paymentId: string
    refundId: string
    idempotencyKey: string
  }
  from_address: string
  to_address: string
  direction: "app_to_user"
  created_at: string
  network: "Pi Testnet"
  status: {
    developer_approved: boolean
    transaction_verified: boolean
    developer_completed: boolean
    cancelled: boolean
    user_cancelled: boolean
  }
  transaction: { txid: string; verified: boolean; _link: string } | null
}

export type RefundPiReconciliationReference = {
  paymentId: string
  refundId: string
  idempotencyKey: string
  payerUid: string
  amount: number
}

export type RefundPiReconciliationResult =
  | { outcome: "FOUND"; payment: RefundPiPayment; reference: RefundPiReconciliationReference }
  | { outcome: "CONFIRMED_NONE"; payment?: undefined; reference: RefundPiReconciliationReference }
  | { outcome: "INDETERMINATE"; payment?: undefined; reference: null }

const PI_API_BASE = "https://api.minepi.com/v2/payments"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactMetadata(value: unknown, input: RefundPiReconciliationInput): RefundPiPayment["metadata"] | null {
  if (!isRecord(value) || value.type !== "refund" || value.paymentId !== input.paymentId ||
    value.refundId !== input.refundId || value.idempotencyKey !== input.idempotencyKey) return null
  return { type: "refund", paymentId: input.paymentId, refundId: input.refundId, idempotencyKey: input.idempotencyKey }
}

function validatePayment(value: unknown, input: RefundPiReconciliationInput): RefundPiPayment | null {
  if (!isRecord(value) || typeof value.identifier !== "string" || value.identifier.length === 0 ||
    typeof value.user_uid !== "string" || typeof value.amount !== "number" || !Number.isFinite(value.amount) || value.amount !== input.amount ||
    typeof value.memo !== "string" || typeof value.from_address !== "string" || typeof value.to_address !== "string" ||
    typeof value.created_at !== "string" || value.direction !== "app_to_user" || value.network !== "Pi Testnet" || value.user_uid !== input.payerUid ||
    !isRecord(value.status) || typeof value.status.developer_approved !== "boolean" || typeof value.status.transaction_verified !== "boolean" || typeof value.status.developer_completed !== "boolean" ||
    typeof value.status.cancelled !== "boolean" || typeof value.status.user_cancelled !== "boolean") return null
  const metadata = exactMetadata(value.metadata, input)
  if (!metadata) return null
  let transaction: RefundPiPayment["transaction"] = null
  if (value.transaction !== null) {
    if (!isRecord(value.transaction) || typeof value.transaction.txid !== "string" || typeof value.transaction.verified !== "boolean" || typeof value.transaction._link !== "string") return null
    transaction = { txid: value.transaction.txid, verified: value.transaction.verified, _link: value.transaction._link }
  }
  return {
    identifier: value.identifier, user_uid: input.payerUid, amount: value.amount, memo: value.memo,
    metadata, from_address: value.from_address, to_address: value.to_address, direction: "app_to_user",
    created_at: value.created_at, network: "Pi Testnet", status: {
      developer_approved: value.status.developer_approved,
      transaction_verified: value.status.transaction_verified,
      developer_completed: value.status.developer_completed,
      cancelled: value.status.cancelled,
      user_cancelled: value.status.user_cancelled,
    }, transaction,
  }
}

async function readJson(response: Response): Promise<unknown | null> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

async function getPi(path: string): Promise<{ kind: "ok" | "not_found" | "uncertain"; body?: unknown }> {
  if (!serverConfig.piApiKey) return { kind: "uncertain" }
  try {
    const response = await fetch(`${PI_API_BASE}${path}`, {
      method: "GET",
      headers: { Authorization: `Key ${serverConfig.piApiKey}`, "Content-Type": "application/json" },
      cache: "no-store",
    })
    if (response.status === 404) return { kind: "not_found" }
    if (!response.ok) return { kind: "uncertain" }
    const body = await readJson(response)
    return body === null ? { kind: "uncertain" } : { kind: "ok", body }
  } catch {
    return { kind: "uncertain" }
  }
}

export type ReconcileRefundAbsenceInput = {
  paymentId: string
  payerUid: string
  a2uPaymentId: string
  amount: number
}

export type ReconcileRefundAbsenceReference = {
  paymentId: string
  payerUid: string
  a2uPaymentId: string
  amount: number
}

export type ReconcileRefundAbsenceResult =
  | { outcome: "FOUND"; payment: unknown; reference: ReconcileRefundAbsenceReference; authorizesFinancialAction: false }
  | { outcome: "CONFIRMED_NONE"; reference: ReconcileRefundAbsenceReference; authorizesFinancialAction: false }
  | { outcome: "INDETERMINATE"; reference: null; authorizesFinancialAction: false }

export async function reconcileRefundAbsenceForPayment(input: ReconcileRefundAbsenceInput): Promise<ReconcileRefundAbsenceResult> {
  if (typeof input.paymentId !== "string" || !input.paymentId || input.paymentId !== input.paymentId.trim() ||
    typeof input.payerUid !== "string" || !input.payerUid || input.payerUid !== input.payerUid.trim() ||
    typeof input.a2uPaymentId !== "string" || !input.a2uPaymentId || input.a2uPaymentId !== input.a2uPaymentId.trim() ||
    !Number.isFinite(input.amount) || input.amount <= 0) {
    return { outcome: "INDETERMINATE", reference: null, authorizesFinancialAction: false }
  }
  const paymentId = input.paymentId
  const payerUid = input.payerUid
  const a2uPaymentId = input.a2uPaymentId
  if (!paymentId || !payerUid || !a2uPaymentId || !Number.isFinite(input.amount) || input.amount <= 0) {
    return { outcome: "INDETERMINATE", reference: null, authorizesFinancialAction: false }
  }
  const reference: ReconcileRefundAbsenceReference = { paymentId, payerUid, a2uPaymentId, amount: input.amount }

  const response = await getPi("/incomplete_server_payments")
  if (response.kind !== "ok" || !isRecord(response.body)) return { outcome: "INDETERMINATE", reference: null, authorizesFinancialAction: false }
  const raw = response.body.incomplete_server_payments
  if (!Array.isArray(raw)) return { outcome: "INDETERMINATE", reference: null, authorizesFinancialAction: false }

  for (const candidate of raw) {
    if (!isRecord(candidate)) return { outcome: "INDETERMINATE", reference: null, authorizesFinancialAction: false }
    const candidateMetadata = candidate.metadata
    if (!isRecord(candidateMetadata) || typeof candidateMetadata.paymentId !== "string") return { outcome: "INDETERMINATE", reference: null, authorizesFinancialAction: false }
    const candidatePaymentId = candidateMetadata.paymentId.trim()
    if (!candidatePaymentId || candidatePaymentId !== candidateMetadata.paymentId) return { outcome: "INDETERMINATE", reference: null, authorizesFinancialAction: false }
    if (candidatePaymentId !== paymentId) continue
    if (candidateMetadata.type === "a2u_settlement" && candidate.identifier === a2uPaymentId) continue
    if (candidateMetadata.type === "refund") {
      if (candidate.user_uid === payerUid && typeof candidate.amount === "number" && Number.isFinite(candidate.amount) && candidate.amount === input.amount &&
        candidate.direction === "app_to_user" && typeof candidate.identifier === "string" && candidate.identifier.length > 0 && candidate.identifier === candidate.identifier.trim()) {
        return { outcome: "FOUND", payment: candidate, reference, authorizesFinancialAction: false }
      }
      return { outcome: "INDETERMINATE", reference: null, authorizesFinancialAction: false }
    }
    return { outcome: "INDETERMINATE", reference: null, authorizesFinancialAction: false }
  }
  return { outcome: "CONFIRMED_NONE", reference, authorizesFinancialAction: false }
}

export async function reconcileRefundWithPi(input: RefundPiReconciliationInput): Promise<RefundPiReconciliationResult> {
  if (!input.paymentId || !input.refundId || !input.idempotencyKey || !input.payerUid || !Number.isFinite(input.amount) || input.amount <= 0) {
    return { outcome: "INDETERMINATE", reference: null }
  }
  const reference: RefundPiReconciliationReference = {
    paymentId: input.paymentId,
    refundId: input.refundId,
    idempotencyKey: input.idempotencyKey,
    payerUid: input.payerUid,
    amount: input.amount,
  }

  if (input.refundPaymentId) {
    const response = await getPi(`/${encodeURIComponent(input.refundPaymentId)}`)
    if (response.kind !== "ok" || !isRecord(response.body) || response.body.identifier !== input.refundPaymentId) return { outcome: "INDETERMINATE", reference: null }
    const payment = validatePayment(response.body, input)
    return payment ? { outcome: "FOUND", payment, reference } : { outcome: "INDETERMINATE", reference: null }
  }

  const response = await getPi("/incomplete_server_payments")
  if (response.kind !== "ok" || !isRecord(response.body)) return { outcome: "INDETERMINATE", reference: null }
  const raw = response.body.incomplete_server_payments
  if (!Array.isArray(raw)) return { outcome: "INDETERMINATE", reference: null }
  const evaluation = evaluateFinancialRecoveryPiCandidates({
    source: "PI_INCOMPLETE_SERVER_PAYMENTS",
    candidates: raw,
    expected: {
      branch: "REFUND",
      paymentId: input.paymentId,
      refundId: input.refundId,
      idempotencyKey: input.idempotencyKey,
      amount: input.amount,
      payerUid: input.payerUid,
    },
  })
  if (evaluation.outcome === "INDETERMINATE") return { outcome: "INDETERMINATE", reference: null }
  if (evaluation.outcome === "CONFIRMED_NONE") return { outcome: "CONFIRMED_NONE", reference }
  const payment = validatePayment(evaluation.candidate, input)
  return payment ? { outcome: "FOUND", payment, reference } : { outcome: "INDETERMINATE", reference: null }
}
