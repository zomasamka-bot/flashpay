export type FinancialRecoveryPiCandidateBranch = "SETTLEMENT" | "REFUND"

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
