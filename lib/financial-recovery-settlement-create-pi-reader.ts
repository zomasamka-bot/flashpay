import "server-only"
import { serverConfig } from "./server-config"

type SettlementCreatePiReadResult =
  | Readonly<{
      outcome: "READ"
      u2a: Readonly<{ source: "PI_PAYMENT_GET"; candidate: unknown }>
      pi: Readonly<{ source: "PI_INCOMPLETE_SERVER_PAYMENTS"; candidates: unknown[] }>
    }>
  | Readonly<{
      outcome: "INDETERMINATE"
      reason: "INVALID_INPUT" | "PI_API_UNAVAILABLE" | "U2A_READ_FAILED" | "INCOMPLETE_READ_FAILED"
    }>

export async function readSettlementCreatePiEvidence(
  piPaymentId: string,
): Promise<SettlementCreatePiReadResult> {
  if (piPaymentId.trim() === "" || piPaymentId !== piPaymentId.trim()) {
    return { outcome: "INDETERMINATE", reason: "INVALID_INPUT" }
  }
  if (!serverConfig.isPiApiKeyConfigured) {
    return { outcome: "INDETERMINATE", reason: "PI_API_UNAVAILABLE" }
  }

  const headers = { Authorization: `Key ${serverConfig.piApiKey}` }
  let u2aResponse: Response
  try {
    u2aResponse = await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(piPaymentId)}`, {
      headers,
      cache: "no-store",
    })
  } catch {
    return { outcome: "INDETERMINATE", reason: "U2A_READ_FAILED" }
  }
  if (!u2aResponse.ok) return { outcome: "INDETERMINATE", reason: "U2A_READ_FAILED" }

  let candidate: unknown
  try {
    candidate = await u2aResponse.json()
  } catch {
    return { outcome: "INDETERMINATE", reason: "U2A_READ_FAILED" }
  }

  let incompleteResponse: Response
  try {
    incompleteResponse = await fetch("https://api.minepi.com/v2/payments/incomplete_server_payments", {
      headers,
      cache: "no-store",
    })
  } catch {
    return { outcome: "INDETERMINATE", reason: "INCOMPLETE_READ_FAILED" }
  }
  if (!incompleteResponse.ok) return { outcome: "INDETERMINATE", reason: "INCOMPLETE_READ_FAILED" }

  let incompleteBody: unknown
  try {
    incompleteBody = await incompleteResponse.json()
  } catch {
    return { outcome: "INDETERMINATE", reason: "INCOMPLETE_READ_FAILED" }
  }

  let candidates: unknown[] | null = null
  if (Array.isArray(incompleteBody)) {
    candidates = incompleteBody
  } else if (typeof incompleteBody === "object" && incompleteBody !== null && "incomplete_server_payments" in incompleteBody) {
    const listed = incompleteBody.incomplete_server_payments
    if (Array.isArray(listed)) candidates = listed
  }
  if (candidates === null) return { outcome: "INDETERMINATE", reason: "INCOMPLETE_READ_FAILED" }

  return {
    outcome: "READ",
    u2a: { source: "PI_PAYMENT_GET", candidate },
    pi: { source: "PI_INCOMPLETE_SERVER_PAYMENTS", candidates },
  }
}

export type { SettlementCreatePiReadResult }
