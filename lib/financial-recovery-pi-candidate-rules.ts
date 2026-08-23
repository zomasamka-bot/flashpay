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
