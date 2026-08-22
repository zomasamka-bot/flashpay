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

const stages: readonly (readonly [keyof FinancialRecoverySnapshot, FinancialRecoveryState])[] = [
  ["u2a", "u2a_verified"],
  ["appFunds", "app_funds_confirmed"],
  ["settlementCreated", "settlement_created"],
  ["settlementBlockchainConfirmed", "settlement_blockchain_confirmed"],
  ["settlementPiCompleted", "settlement_pi_completed"],
  ["settlementFinalized", "settlement_finalized"],
]

const refundStages: readonly (readonly [keyof FinancialRecoverySnapshot, FinancialRecoveryState])[] = [
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

  if (evidenceKeys.some((key) => input[key] === "unknown")) return invalid("evidence is unknown")

  const idConflicts: Partial<Record<(typeof idKeys)[number], readonly (keyof FinancialRecoverySnapshot)[]>> = {
    u2aTxid: ["u2a"],
    a2uPaymentId: ["settlementCreated"],
    a2uTxid: ["settlementCreated", "settlementBlockchainConfirmed"],
    refundPaymentId: ["refundCreated"],
    refundTxid: ["refundCreated", "refundBlockchainConfirmed"],
  }

  for (const key of idKeys) {
    if (nonemptyString(input[key])) {
      for (const evidenceKey of idConflicts[key] ?? []) {
        if (input[evidenceKey] === "absent") return invalid(`${key} conflicts with absent evidence`)
      }
    }
  }

  if (input.u2a === "absent") {
    if (evidenceKeys.slice(1).some((key) => input[key] !== "absent")) return invalid("U2A absent conflicts with later evidence")
    return { state: "u2a_unverified", reason: "U2A evidence is absent" }
  }

  const settlementConfirmed = stages.slice(2).some(([key]) => input[key] === "confirmed")
  const refundConfirmed = refundStages.some(([key]) => input[key] === "confirmed")
  if (settlementConfirmed && refundConfirmed) return invalid("settlement and refund evidence overlap")

  const refundChain: readonly (readonly [keyof FinancialRecoverySnapshot, FinancialRecoveryState])[] = [
    ["u2a", "u2a_verified"],
    ["appFunds", "app_funds_confirmed"],
    ...refundStages,
  ]
  const branch: readonly (readonly [keyof FinancialRecoverySnapshot, FinancialRecoveryState])[] =
    settlementConfirmed ? stages : refundConfirmed ? refundChain : stages
  let deepest: FinancialRecoveryState = "u2a_verified"
  for (let index = 0; index < branch.length; index += 1) {
    const [key, state] = branch[index]
    if (input[key] === "confirmed") {
      if (branch.slice(0, index).some(([candidate]) => input[candidate] !== "confirmed")) return invalid(`skipped prerequisite before ${String(key)}`)
      deepest = state
    } else if (input[key] !== "absent") {
      return invalid(`evidence ${String(key)} is not confirmed or absent`)
    }
  }

  return { state: deepest, reason: `deepest consecutive confirmed ${deepest}` }
}
