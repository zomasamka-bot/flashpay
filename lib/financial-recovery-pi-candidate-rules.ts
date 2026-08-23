export type FinancialRecoveryPiCandidateBranch = "SETTLEMENT" | "REFUND"

export type FinancialRecoveryPiExpectation = Readonly<
  | { branch: "SETTLEMENT"; paymentId: string; amount: number; merchantUid: string }
  | { branch: "REFUND"; paymentId: string; refundId: string; idempotencyKey: string; amount: number; payerUid: string }
>

export type FinancialRecoveryPiCandidateInput = Readonly<{
  source: "PI_INCOMPLETE_SERVER_PAYMENTS" | null
  candidates: unknown
  expected: FinancialRecoveryPiExpectation
}>

export type FinancialRecoveryPiCandidateReason =
  | "INVALID_INPUT"
  | "NON_AUTHORITATIVE_LIST"
  | "MALFORMED_OR_MISMATCH"
  | "BRANCH_CONFLICT"
  | "MULTIPLE_SCOPED"

export type FinancialRecoveryPiCandidateResult = Readonly<
  { authorizesFinancialAction: false } & (
    | { outcome: "FOUND"; candidate: Readonly<Record<string, unknown>>; moneyMovementProven: false }
    | { outcome: "CONFIRMED_NONE" }
    | { outcome: "INDETERMINATE"; reason: FinancialRecoveryPiCandidateReason }
  )
>

export type FinancialRecoveryPiCandidateRule = Readonly<{
  metadataType: "a2u_settlement" | "refund"
  identity: readonly ("paymentId" | "refundId" | "idempotencyKey")[]
  uidRole: "merchantUid" | "payerUid"
  direction: "app_to_user"
  amount: "EXACT"
  zero: "CONFIRMED_NONE"
  exactOne: "FOUND"
  malformedMismatchOrMultiple: "INDETERMINATE"
  authoritativeNone: true
  otherPaymentIds: "IGNORE"
  oppositeBranchSamePaymentId: "INDETERMINATE"
  conflictsDominateZero: true
}>

export const FINANCIAL_RECOVERY_PI_CANDIDATE_RULES = {
  SETTLEMENT: {
    metadataType: "a2u_settlement",
    identity: ["paymentId"],
    uidRole: "merchantUid",
    direction: "app_to_user",
    amount: "EXACT",
    zero: "CONFIRMED_NONE",
    exactOne: "FOUND",
    malformedMismatchOrMultiple: "INDETERMINATE",
    authoritativeNone: true,
    otherPaymentIds: "IGNORE",
    oppositeBranchSamePaymentId: "INDETERMINATE",
    conflictsDominateZero: true,
  },
  REFUND: {
    metadataType: "refund",
    identity: ["paymentId", "refundId", "idempotencyKey"],
    uidRole: "payerUid",
    direction: "app_to_user",
    amount: "EXACT",
    zero: "CONFIRMED_NONE",
    exactOne: "FOUND",
    malformedMismatchOrMultiple: "INDETERMINATE",
    authoritativeNone: true,
    otherPaymentIds: "IGNORE",
    oppositeBranchSamePaymentId: "INDETERMINATE",
    conflictsDominateZero: true,
  },
} as const satisfies Readonly<Record<FinancialRecoveryPiCandidateBranch, FinancialRecoveryPiCandidateRule>>

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function evaluateFinancialRecoveryPiCandidates(input: FinancialRecoveryPiCandidateInput): FinancialRecoveryPiCandidateResult {
  const indeterminate = (reason: FinancialRecoveryPiCandidateReason): FinancialRecoveryPiCandidateResult => ({
    authorizesFinancialAction: false,
    outcome: "INDETERMINATE",
    reason,
  })
  const expected = input.expected
  if (input.source !== "PI_INCOMPLETE_SERVER_PAYMENTS") return indeterminate("NON_AUTHORITATIVE_LIST")
  if (!Array.isArray(input.candidates)) return indeterminate("INVALID_INPUT")
  if (!expected.paymentId.trim() || !Number.isFinite(expected.amount) || expected.amount <= 0) return indeterminate("INVALID_INPUT")
  if (expected.branch === "SETTLEMENT" ? !expected.merchantUid.trim() : !expected.refundId.trim() || !expected.idempotencyKey.trim() || !expected.payerUid.trim()) {
    return indeterminate("INVALID_INPUT")
  }

  const rule = FINANCIAL_RECOVERY_PI_CANDIDATE_RULES[expected.branch]
  const exact: Readonly<Record<string, unknown>>[] = []
  let malformed = false
  let branchConflict = false

  for (const candidate of input.candidates) {
    if (!isRecord(candidate)) {
      malformed = true
      continue
    }
    const record = candidate
    const metadata = record.metadata
    if (!isRecord(metadata)) {
      malformed = true
      continue
    }
    const meta = metadata
    if (typeof meta.paymentId !== "string" || !meta.paymentId.trim()) {
      malformed = true
      continue
    }
    if (meta.paymentId !== expected.paymentId) continue

    if (meta.type === (expected.branch === "SETTLEMENT" ? "refund" : "a2u_settlement")) {
      branchConflict = true
      continue
    }
    if (meta.type !== rule.metadataType) {
      malformed = true
      continue
    }
    const identityMatches = expected.branch === "SETTLEMENT"
      ? meta.paymentId === expected.paymentId
      : meta.paymentId === expected.paymentId && meta.refundId === expected.refundId && meta.idempotencyKey === expected.idempotencyKey
    const uid = record[rule.uidRole]
    const identifier = record.identifier
    if (
      !identityMatches ||
      record.amount !== expected.amount ||
      record.direction !== rule.direction ||
      uid !== (expected.branch === "SETTLEMENT" ? expected.merchantUid : expected.payerUid) ||
      typeof identifier !== "string" ||
      !identifier.trim() ||
      typeof record.from_address !== "string" ||
      !record.from_address.trim() ||
      typeof record.to_address !== "string" ||
      !record.to_address.trim()
    ) {
      malformed = true
      continue
    }
    exact.push(record)
  }

  if (branchConflict) return indeterminate("BRANCH_CONFLICT")
  if (malformed) return indeterminate("MALFORMED_OR_MISMATCH")
  if (exact.length > 1) return indeterminate("MULTIPLE_SCOPED")
  if (exact.length === 1) return { authorizesFinancialAction: false, outcome: "FOUND", candidate: exact[0], moneyMovementProven: false }
  return { authorizesFinancialAction: false, outcome: "CONFIRMED_NONE" }
}
