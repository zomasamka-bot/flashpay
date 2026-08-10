import "server-only"

import { serverConfig } from "./server-config"

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
  amount: number
  direction: "app_to_user"
  network: "Pi Testnet"
  user_uid: string
  metadata: {
    type: "refund"
    paymentId: string
    refundId: string
    idempotencyKey: string
  }
  transaction: unknown | null
}

export type RefundPiReconciliationResult = {
  outcome: RefundPiReconciliationOutcome
  payment?: RefundPiPayment
}

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
    typeof value.amount !== "number" || !Number.isFinite(value.amount) || value.amount !== input.amount ||
    value.direction !== "app_to_user" || value.network !== "Pi Testnet" || value.user_uid !== input.payerUid ||
    !(value.transaction === null || isRecord(value.transaction))) return null
  const metadata = exactMetadata(value.metadata, input)
  if (!metadata) return null
  return {
    identifier: value.identifier,
    amount: value.amount,
    direction: "app_to_user",
    network: "Pi Testnet",
    user_uid: input.payerUid,
    metadata,
    transaction: value.transaction,
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

export async function reconcileRefundWithPi(input: RefundPiReconciliationInput): Promise<RefundPiReconciliationResult> {
  if (!input.paymentId || !input.refundId || !input.idempotencyKey || !input.payerUid || !Number.isFinite(input.amount) || input.amount <= 0) {
    return { outcome: "INDETERMINATE" }
  }

  if (input.refundPaymentId) {
    const response = await getPi(`/${encodeURIComponent(input.refundPaymentId)}`)
    if (response.kind !== "ok") return { outcome: "INDETERMINATE" }
    const payment = validatePayment(response.body, input)
    return payment ? { outcome: "FOUND", payment } : { outcome: "INDETERMINATE" }
  }

  const response = await getPi("/incomplete_server_payments")
  if (response.kind !== "ok" || !isRecord(response.body)) return { outcome: "INDETERMINATE" }
  const raw = response.body.incomplete_server_payments
  if (!Array.isArray(raw)) return { outcome: "INDETERMINATE" }

  let found: RefundPiPayment | undefined
  for (const candidate of raw) {
    if (!isRecord(candidate)) return { outcome: "INDETERMINATE" }
    const metadata = isRecord(candidate.metadata) ? candidate.metadata : null
    const isRelated = metadata?.type === "refund" &&
      (metadata.paymentId === input.paymentId || metadata.refundId === input.refundId || metadata.idempotencyKey === input.idempotencyKey)
    if (isRelated) {
      const payment = validatePayment(candidate, input)
      if (!payment || found) return { outcome: "INDETERMINATE" }
      found = payment
    } else if (metadata?.paymentId === input.paymentId || metadata?.refundId === input.refundId || metadata?.idempotencyKey === input.idempotencyKey) {
      return { outcome: "INDETERMINATE" }
    }
  }
  return found ? { outcome: "FOUND", payment: found } : { outcome: "CONFIRMED_NONE" }
}
