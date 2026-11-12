import "server-only"

import { serverConfig } from "./server-config"

export type SettlementSubmitPiReadResult =
  | {
      outcome: "READ"
      source: "PI_PAYMENT_GET"
      a2uPaymentId: string
      candidate: unknown
      authorizesFinancialAction: false
    }
  | {
      outcome: "INDETERMINATE"
      reason: "INVALID_INPUT" | "PI_API_UNAVAILABLE" | "READ_FAILED"
      authorizesFinancialAction: false
    }

export async function readSettlementSubmitPiEvidence(
  a2uPaymentId: string,
): Promise<SettlementSubmitPiReadResult> {
  if (!a2uPaymentId || a2uPaymentId.trim() !== a2uPaymentId) {
    return { outcome: "INDETERMINATE", reason: "INVALID_INPUT", authorizesFinancialAction: false }
  }

  if (!serverConfig.piApiKey) {
    return { outcome: "INDETERMINATE", reason: "PI_API_UNAVAILABLE", authorizesFinancialAction: false }
  }

  try {
    const response = await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(a2uPaymentId)}`, {
      headers: { Authorization: `Key ${serverConfig.piApiKey}` },
      cache: "no-store",
    })

    if (response.status !== 200) {
      return { outcome: "INDETERMINATE", reason: "READ_FAILED", authorizesFinancialAction: false }
    }

    const candidate: unknown = await response.json()
    return {
      outcome: "READ",
      source: "PI_PAYMENT_GET",
      a2uPaymentId,
      candidate,
      authorizesFinancialAction: false,
    }
  } catch {
    return { outcome: "INDETERMINATE", reason: "READ_FAILED", authorizesFinancialAction: false }
  }
}
