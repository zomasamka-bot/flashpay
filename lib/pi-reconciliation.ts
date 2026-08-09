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
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const dto = value as Record<string, unknown>
  return typeof dto.identifier === "string" &&
    typeof dto.amount === "number" && Number.isFinite(dto.amount) &&
    (typeof dto.status === "object" || typeof dto.status === "string" || dto.transaction === undefined || typeof dto.transaction === "object")
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
      (isRecord(transaction) && (transaction.txid || transaction.verified === true)) ||
      dto.transaction_id || dto.txid || dto.completed === true ||
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

export async function reconcileIncompleteA2UPayment(paymentId: string, amount: number): Promise<PiReconciliationResult> {
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
    const match = candidates.find((candidate) => {
      if (!isPaymentDto(candidate)) return false
      const dto = candidate as Record<string, unknown>
      const metadata = isRecord(dto.metadata) ? dto.metadata : {}
      return metadata.paymentId === paymentId && Number(dto.amount) === amount
    })
    if (match && isPaymentDto(match)) return { outcome: "FOUND", paymentId, reason: "Pi found an incomplete A2U payment", dto: match }
    return { outcome: "CONFIRMED_NONE", paymentId, reason: "Pi confirmed no incomplete A2U payment" }
  } catch (error) {
    return { outcome: "INDETERMINATE", paymentId, reason: error instanceof Error ? error.message : "Pi reconciliation failed" }
  }
}

export function isUnexpectedPaymentDto(value: unknown): boolean {
  return !isPaymentDto(value)
}
