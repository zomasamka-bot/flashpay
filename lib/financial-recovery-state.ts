export type EvidenceState = "confirmed" | "absent" | "unknown"

export type FinancialRecoveryState =
  | "u2a_unverified"
  | "u2a_verified"
  | "app_funds_confirmed"
  | "settlement_created"
  | "settlement_blockchain_confirmed"
  | "settlement_pi_completed"
  | "settlement_finalized"
  | "refund_eligible"
  | "refund_created"
  | "refund_blockchain_confirmed"
  | "refund_pi_completed"
  | "refund_finalized"
  | "indeterminate"

export type FinancialRecoverySnapshot = {
  paymentId: string
  u2a: EvidenceState
  appFunds: EvidenceState
  settlementCreated: EvidenceState
  settlementBlockchainConfirmed: EvidenceState
  settlementPiCompleted: EvidenceState
  settlementFinalized: EvidenceState
  refundEligible: EvidenceState
  refundCreated: EvidenceState
  refundBlockchainConfirmed: EvidenceState
  refundPiCompleted: EvidenceState
  refundFinalized: EvidenceState
  piPaymentId?: string
  u2aTxid?: string
  a2uPaymentId?: string
  a2uTxid?: string
  refundId?: string
  refundPaymentId?: string
  refundTxid?: string
}

const stages: readonly [keyof FinancialRecoverySnapshot, FinancialRecoveryState][] = [
  ["u2a", "u2a_verified"],
  ["appFunds", "app_funds_confirmed"],
  ["settlementCreated", "settlement_created"],
  ["settlementBlockchainConfirmed", "settlement_blockchain_confirmed"],
  ["settlementPiCompleted", "settlement_pi_completed"],
  ["settlementFinalized", "settlement_finalized"],
]

const refundStages: readonly [keyof FinancialRecoverySnapshot, FinancialRecoveryState][] = [
  ["refundEligible", "refund_eligible"],
  ["refundCreated", "refund_created"],
  ["refundBlockchainConfirmed", "refund_blockchain_confirmed"],
  ["refundPiCompleted", "refund_pi_completed"],
  ["refundFinalized", "refund_finalized"],
]

const evidenceKeys = [
  "u2a",
  "appFunds",
  "settlementCreated",
  "settlementBlockchainConfirmed",
  "settlementPiCompleted",
  "settlementFinalized",
  "refundEligible",
  "refundCreated",
  "refundBlockchainConfirmed",
  "refundPiCompleted",
  "refundFinalized",
] as const

const idKeys = ["piPaymentId", "u2aTxid", "a2uPaymentId", "a2uTxid", "refundId", "refundPaymentId", "refundTxid"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isEvidenceState(value: unknown): value is EvidenceState {
  return value === "confirmed" || value === "absent" || value === "unknown"
}

function invalid(reason: string) {
  return { state: "indeterminate" as const, reason }
}

export function deriveFinancialRecoveryState(input: unknown): {
  state: FinancialRecoveryState
  reason: string
} {
  if (!isRecord(input) || !nonemptyString(input.paymentId)) {
    return invalid("paymentId is missing or empty")
  }

  for (const key of evidenceKeys) {
    if (!isEvidenceState(input[key])) return invalid(`evidence ${key} is missing or invalid`)
  }

  for (const key of idKeys) {
    if (input[key] !== undefined && !nonemptyString(input[key])) return invalid(`identifier ${key} is invalid`)
  }

  for (const key of idKeys) {
    if (nonemptyString(input[key])) {
      const relatedEvidence = key === "refundTxid"
        ? input.refundBlockchainConfirmed
        : key.startsWith("refund")
          ? input.refundCreated
          : key === "a2uPaymentId" || key === "a2uTxid"
            ? input.settlementCreated
            : input.u2a
      if (relatedEvidence === "absent") return invalid(`${key} conflicts with absent evidence`)
    }
  }

  const settlementConfirmed = input.settlementCreated === "confirmed" ||
    input.settlementBlockchainConfirmed === "confirmed" ||
    input.settlementPiCompleted === "confirmed" ||
    input.settlementFinalized === "confirmed"
  const refundConfirmed = input.refundEligible === "confirmed" ||
    input.refundCreated === "confirmed" ||
    input.refundBlockchainConfirmed === "confirmed" ||
    input.refundPiCompleted === "confirmed" ||
    input.refundFinalized === "confirmed"

  if (settlementConfirmed && refundConfirmed) return invalid("settlement and refund evidence overlap")

  if (input.u2a === "absent") return { state: "u2a_unverified", reason: "U2A evidence is absent" }
  if (input.u2a !== "confirmed") return invalid("U2A evidence is unknown")

  const branch = settlementConfirmed ? stages : refundConfirmed ? refundStages : stages
  let deepest: FinancialRecoveryState = "u2a_verified"
  let prerequisiteConfirmed = true

  for (const [key, state] of branch) {
    const evidence = input[key]
    if (evidence === "confirmed" && prerequisiteConfirmed) {
      deepest = state
      continue
    }
    if (evidence === "absent") break
    if (evidence === "unknown") return invalid(`evidence ${String(key)} is unknown`)
    if (evidence === "confirmed" && !prerequisiteConfirmed) return invalid(`skipped prerequisite before ${String(key)}`)
    prerequisiteConfirmed = false
  }

  for (const [key] of branch) {
    if (input[key] === "confirmed") {
      const index = branch.findIndex(([candidate]) => candidate === key)
      if (branch.slice(0, index).some(([candidate]) => input[candidate] !== "confirmed")) {
        return invalid(`skipped prerequisite before ${String(key)}`)
      }
    }
  }

  return { state: deepest, reason: `deepest consecutive confirmed ${deepest}` }
}
