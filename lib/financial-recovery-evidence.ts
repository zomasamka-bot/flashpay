import type { FinancialRecoveryState } from "./financial-recovery-state"

export type EvidencedState = Exclude<FinancialRecoveryState, "u2a_unverified" | "indeterminate">

export type EvidenceFact =
  | "pi_dto_identity_exact"
  | "pi_dto_direction_exact"
  | "pi_dto_amount_exact"
  | "pi_dto_payer_verified"
  | "pi_dto_verified_txid"
  | "pi_developer_completed"
  | "a2u_dto_scoped"
  | "horizon_tx_exact"
  | "pi_completion_matching"
  | "db_finalization"
  | "redis_finalization"
  | "merchant_a2u_confirmed_none"
  | "no_transfer_evidence"
  | "verified_payer"
  | "verified_amount"
  | "refund_dto_scoped"
  | "refund_horizon_tx_exact"
  | "refund_pi_completion_matching"
  | "refund_accounting"
  | "refund_audit"
  | "refund_completed_checkpoint"
  | "refund_projection"
  | "pi_payment_id_present"
  | "u2a_txid_present"
  | "a2u_payment_id_present"
  | "a2u_txid_present"
  | "refund_id_present"
  | "refund_payment_id_present"
  | "refund_txid_present"
  | "local_status_flag"
  | "local_completion_flag"

export type EvidenceRule = {
  requiresAll: readonly EvidenceFact[]
  insufficientAlone: readonly EvidenceFact[]
  onUncertainty: "unknown"
}

const U2A_FACTS = [
  "pi_dto_identity_exact",
  "pi_dto_direction_exact",
  "pi_dto_amount_exact",
  "pi_dto_payer_verified",
  "pi_dto_verified_txid",
] as const

const SETTLEMENT_FACTS = [
  "a2u_dto_scoped",
  "horizon_tx_exact",
  "pi_completion_matching",
  "db_finalization",
  "redis_finalization",
] as const

const REFUND_FACTS = [
  "refund_dto_scoped",
  "refund_horizon_tx_exact",
  "refund_pi_completion_matching",
  "refund_accounting",
  "refund_audit",
  "refund_completed_checkpoint",
  "refund_projection",
] as const

const IDENTIFIER_AND_FLAGS: readonly EvidenceFact[] = [
  "pi_payment_id_present",
  "u2a_txid_present",
  "a2u_payment_id_present",
  "a2u_txid_present",
  "refund_id_present",
  "refund_payment_id_present",
  "refund_txid_present",
  "local_status_flag",
  "local_completion_flag",
]

export const FINANCIAL_EVIDENCE_MATRIX: Readonly<Record<EvidencedState, EvidenceRule>> = {
  u2a_verified: {
    requiresAll: U2A_FACTS,
    insufficientAlone: IDENTIFIER_AND_FLAGS,
    onUncertainty: "unknown",
  },
  app_funds_confirmed: {
    requiresAll: [...U2A_FACTS, "pi_developer_completed"],
    insufficientAlone: IDENTIFIER_AND_FLAGS,
    onUncertainty: "unknown",
  },
  settlement_created: {
    requiresAll: [...U2A_FACTS, "a2u_dto_scoped"],
    insufficientAlone: IDENTIFIER_AND_FLAGS,
    onUncertainty: "unknown",
  },
  settlement_blockchain_confirmed: {
    requiresAll: [...U2A_FACTS, ...SETTLEMENT_FACTS.slice(0, 2)],
    insufficientAlone: IDENTIFIER_AND_FLAGS,
    onUncertainty: "unknown",
  },
  settlement_pi_completed: {
    requiresAll: [...U2A_FACTS, ...SETTLEMENT_FACTS.slice(0, 3)],
    insufficientAlone: IDENTIFIER_AND_FLAGS,
    onUncertainty: "unknown",
  },
  settlement_finalized: {
    requiresAll: [...U2A_FACTS, ...SETTLEMENT_FACTS],
    insufficientAlone: IDENTIFIER_AND_FLAGS,
    onUncertainty: "unknown",
  },
  refund_eligible: {
    requiresAll: [
      "verified_payer",
      "verified_amount",
      "merchant_a2u_confirmed_none",
      "no_transfer_evidence",
    ],
    insufficientAlone: IDENTIFIER_AND_FLAGS,
    onUncertainty: "unknown",
  },
  refund_created: {
    requiresAll: [
      "verified_payer",
      "verified_amount",
      "merchant_a2u_confirmed_none",
      "no_transfer_evidence",
      "refund_dto_scoped",
    ],
    insufficientAlone: IDENTIFIER_AND_FLAGS,
    onUncertainty: "unknown",
  },
  refund_blockchain_confirmed: {
    requiresAll: [
      "verified_payer",
      "verified_amount",
      "merchant_a2u_confirmed_none",
      "no_transfer_evidence",
      ...REFUND_FACTS.slice(0, 2),
    ],
    insufficientAlone: IDENTIFIER_AND_FLAGS,
    onUncertainty: "unknown",
  },
  refund_pi_completed: {
    requiresAll: [
      "verified_payer",
      "verified_amount",
      "merchant_a2u_confirmed_none",
      "no_transfer_evidence",
      ...REFUND_FACTS.slice(0, 3),
    ],
    insufficientAlone: IDENTIFIER_AND_FLAGS,
    onUncertainty: "unknown",
  },
  refund_finalized: {
    requiresAll: [
      "verified_payer",
      "verified_amount",
      "merchant_a2u_confirmed_none",
      "no_transfer_evidence",
      ...REFUND_FACTS,
    ],
    insufficientAlone: IDENTIFIER_AND_FLAGS,
    onUncertainty: "unknown",
  },
}

void SETTLEMENT_FACTS

export {}
