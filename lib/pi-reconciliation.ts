import "server-only"

import { serverConfig } from "@/lib/server-config"

export type PiReconciliationOutcome = "FOUND" | "CONFIRMED_NONE" | "INDETERMINATE"

export interface PiReconciliationResult {
  outcome: PiReconciliationOutcome
  paymentId: string
  reason: string
  dto?: Record<string, unknown>
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isPiA2UPayment(value: unknown): value is Record<string, unknown> {
  return isPaymentDto(value)
}

function isPaymentDto(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  const dto = value
  if (typeof dto.identifier !== "string" || dto.identifier.length === 0) return false
  if (typeof dto.from_address !== "string" || dto.from_address.length === 0) return false
  if (typeof dto.to_address !== "string" || dto.to_address.length === 0) return false
  if (typeof dto.amount !== "number" || !Number.isFinite(dto.amount) || dto.amount <= 0) return false
  for (const key of ["completed", "cancelled", "approved", "rejected"] as const) {
    if (key in dto && typeof dto[key] !== "boolean") return false
  }
  if ("status" in dto && dto.status !== null) {
    if (!isRecord(dto.status)) return false
    for (const key of ["developer_approved", "transaction_verified", "developer_completed", "cancelled", "user_cancelled"] as const) {
      if (key in dto.status && typeof dto.status[key] !== "boolean") return false
    }
  }
  if ("transaction" in dto && dto.transaction !== null) {
    if (!isRecord(dto.transaction)) return false
    if ("txid" in dto.transaction && typeof dto.transaction.txid !== "string") return false
    if ("verified" in dto.transaction && typeof dto.transaction.verified !== "boolean") return false
    if ("_link" in dto.transaction && typeof dto.transaction._link !== "string") return false
  }
  if ("txid" in dto && typeof dto.txid !== "string") return false
  if ("transaction_id" in dto && typeof dto.transaction_id !== "string") return false
  return true
}

/**
 * Server-side reconciliation against Pi. Any API, transport, parse, or shape
 * uncertainty is deliberately INDETERMINATE and must remain manual review.
 */
export async function reconcilePiPayment(paymentId: string): Promise<PiReconciliationResult> {
  if (!serverConfig.isPiApiKeyConfigured) {
    return { outcome: "INDETERMINATE", paymentId, reason: "Pi API key is not configured" }
  }

  try {
    const response = await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Key ${serverConfig.piApiKey}`, Accept: "application/json" },
      cache: "no-store",
    })

    if (response.status === 404) {
      return { outcome: "CONFIRMED_NONE", paymentId, reason: "Pi reports payment not found" }
    }
    if (!response.ok) {
      return { outcome: "INDETERMINATE", paymentId, reason: `Pi reconciliation HTTP ${response.status}` }
    }

    const payload: unknown = await response.json()
    if (!isPaymentDto(payload)) {
      return { outcome: "INDETERMINATE", paymentId, reason: "Pi returned an invalid PaymentDTO" }
    }

    const dto = payload as Record<string, unknown>
    const transaction = dto.transaction
    const hasTransferEvidence = Boolean(
      (isRecord(transaction) && (typeof transaction.txid === "string" || transaction.verified === true)) ||
      typeof dto.transaction_id === "string" || typeof dto.txid === "string" || dto.completed === true ||
      dto.status === "completed" || dto.status === "approved"
    )
    return hasTransferEvidence
      ? { outcome: "FOUND", paymentId, reason: "Pi returned payment or transfer evidence", dto }
      : { outcome: "INDETERMINATE", paymentId, reason: "Pi returned a DTO without conclusive transfer state", dto }
  } catch (error) {
    return {
      outcome: "INDETERMINATE",
      paymentId,
      reason: error instanceof Error ? error.message : "Pi reconciliation failed",
    }
  }
}

export async function reconcileIncompleteA2UPayment(paymentId: string, amount: number, merchantUid: string): Promise<PiReconciliationResult> {
  if (!serverConfig.isPiApiKeyConfigured) return { outcome: "INDETERMINATE", paymentId, reason: "Pi API key is not configured" }
  try {
    const response = await fetch("https://api.minepi.com/v2/payments/incomplete_server_payments", {
      headers: { Authorization: `Key ${serverConfig.piApiKey}`, Accept: "application/json" }, cache: "no-store",
    })
    if (!response.ok) return { outcome: "INDETERMINATE", paymentId, reason: `Pi incomplete payments HTTP ${response.status}` }
    const payload: unknown = await response.json()
    const candidates = Array.isArray(payload)
      ? payload
      : isRecord(payload) && Array.isArray(payload.incomplete_server_payments)
        ? payload.incomplete_server_payments
        : null
    if (!candidates) return { outcome: "INDETERMINATE", paymentId, reason: "Pi returned invalid incomplete-payments payload" }
    let matchingCandidate = false
    for (const candidate of candidates) {
      if (!isRecord(candidate)) continue
      const metadata = isRecord(candidate.metadata) ? candidate.metadata : null
      if (metadata?.paymentId !== paymentId || metadata.type !== "a2u_settlement") continue
      matchingCandidate = true
      if (!isPaymentDto(candidate)) return { outcome: "INDETERMINATE", paymentId, reason: "Matching A2U metadata has an invalid DTO" }
      if (candidate.amount !== amount) return { outcome: "INDETERMINATE", paymentId, reason: "Matching A2U metadata has an amount mismatch" }
      if (candidate.direction !== "app_to_user" || candidate.user_uid !== merchantUid ||
        typeof candidate.from_address !== "string" || typeof candidate.to_address !== "string") {
        return { outcome: "INDETERMINATE", paymentId, reason: "Matching A2U DTO has invalid direction or user scope" }
      }
      return { outcome: "FOUND", paymentId, reason: "Pi found an incomplete A2U payment", dto: candidate }
    }
    return matchingCandidate
      ? { outcome: "INDETERMINATE", paymentId, reason: "Matching A2U payment could not be validated" }
      : { outcome: "CONFIRMED_NONE", paymentId, reason: "Pi confirmed no matching A2U settlement" }
  } catch (error) {
    return { outcome: "INDETERMINATE", paymentId, reason: error instanceof Error ? error.message : "Pi reconciliation failed" }
  }
}

export function isUnexpectedPaymentDto(value: unknown): boolean {
  return !isPaymentDto(value)
}
