import type { FinancialRecoveryState } from "./financial-recovery-state"

export type EvidencedState = Exclude<FinancialRecoveryState, "u2a_unverified" | "indeterminate">

export type EvidenceFact =
  | "u2a_pi_dto_identity_exact"
  | "u2a_pi_dto_direction_exact"
  | "u2a_pi_dto_amount_exact"
  | "u2a_pi_dto_payer_verified"
  | "u2a_pi_dto_verified_txid"
  | "u2a_pi_developer_completed"
  | "a2u_dto_scoped"
  | "horizon_tx_exact"
  | "pi_completion_matching"
  | "db_finalization"
  | "redis_finalization"
  | "merchant_a2u_confirmed_none"
  | "merchant_transfer_evidence_absent"
  | "refund_transfer_evidence_absent"
  | "verified_payer"
  | "verified_amount"
  | "refund_dto_scoped"
  | "refund_horizon_tx_exact"
  | "refund_pi_completion_matching"
  | "refund_accounting"
  | "refund_audit"
  | "refund_completed_checkpoint"
  | "refund_projection"
  | "refund_eligibility_proof_exact"
  | "pi_payment_id_present"
  | "u2a_txid_present"
  | "a2u_payment_id_present"
  | "a2u_txid_present"
  | "refund_id_present"
  | "refund_payment_id_present"
  | "refund_txid_present"
  | "settlement_local_status_flag"
  | "settlement_local_completion_flag"
  | "refund_local_status_flag"
  | "refund_local_completion_flag"

export type EvidenceRule = {
  requiresAll: readonly EvidenceFact[]
  insufficientAlone: readonly EvidenceFact[]
  conflictsWith: readonly EvidenceFact[]
  onUncertainty: "unknown"
}

const U2A_FACTS = [
  "u2a_pi_dto_identity_exact",
  "u2a_pi_dto_direction_exact",
  "u2a_pi_dto_amount_exact",
  "u2a_pi_dto_payer_verified",
  "u2a_pi_dto_verified_txid",
] as const

const APP_FUNDS_FACTS = [...U2A_FACTS, "u2a_pi_developer_completed"] as const

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

const IDS_AND_SETTLEMENT_FLAGS: readonly EvidenceFact[] = [
  "pi_payment_id_present", "u2a_txid_present", "a2u_payment_id_present", "a2u_txid_present",
  "settlement_local_status_flag", "settlement_local_completion_flag",
]

const IDS_AND_REFUND_FLAGS: readonly EvidenceFact[] = [
  "pi_payment_id_present", "u2a_txid_present", "refund_id_present", "refund_payment_id_present", "refund_txid_present",
  "refund_local_status_flag", "refund_local_completion_flag",
]

const SETTLEMENT_CONFLICTS: readonly EvidenceFact[] = [
  "refund_payment_id_present", "refund_txid_present", "refund_dto_scoped", "refund_horizon_tx_exact", "refund_pi_completion_matching",
]

const REFUND_CONFLICTS: readonly EvidenceFact[] = [
  "a2u_payment_id_present", "a2u_txid_present", "a2u_dto_scoped", "horizon_tx_exact", "pi_completion_matching", "db_finalization", "redis_finalization",
]

const SETTLEMENT_ABSENCE = ["merchant_transfer_evidence_absent"] as const
const REFUND_ABSENCE = ["refund_transfer_evidence_absent"] as const

export const FINANCIAL_EVIDENCE_MATRIX: Readonly<Record<EvidencedState, EvidenceRule>> = {
  u2a_verified: { requiresAll: U2A_FACTS, insufficientAlone: IDS_AND_SETTLEMENT_FLAGS, conflictsWith: [], onUncertainty: "unknown" },
  app_funds_confirmed: { requiresAll: APP_FUNDS_FACTS, insufficientAlone: IDS_AND_SETTLEMENT_FLAGS, conflictsWith: [], onUncertainty: "unknown" },
  settlement_created: { requiresAll: [...APP_FUNDS_FACTS, ...SETTLEMENT_FACTS.slice(0, 1)], insufficientAlone: IDS_AND_SETTLEMENT_FLAGS, conflictsWith: SETTLEMENT_CONFLICTS, onUncertainty: "unknown" },
  settlement_blockchain_confirmed: { requiresAll: [...APP_FUNDS_FACTS, ...SETTLEMENT_FACTS.slice(0, 2)], insufficientAlone: IDS_AND_SETTLEMENT_FLAGS, conflictsWith: SETTLEMENT_CONFLICTS, onUncertainty: "unknown" },
  settlement_pi_completed: { requiresAll: [...APP_FUNDS_FACTS, ...SETTLEMENT_FACTS.slice(0, 3)], insufficientAlone: IDS_AND_SETTLEMENT_FLAGS, conflictsWith: SETTLEMENT_CONFLICTS, onUncertainty: "unknown" },
  settlement_finalized: { requiresAll: [...APP_FUNDS_FACTS, ...SETTLEMENT_FACTS], insufficientAlone: IDS_AND_SETTLEMENT_FLAGS, conflictsWith: SETTLEMENT_CONFLICTS, onUncertainty: "unknown" },
  refund_eligible: { requiresAll: [...APP_FUNDS_FACTS, "verified_payer", "verified_amount", "merchant_a2u_confirmed_none", ...REFUND_ABSENCE, "refund_eligibility_proof_exact"], insufficientAlone: IDS_AND_REFUND_FLAGS, conflictsWith: REFUND_CONFLICTS, onUncertainty: "unknown" },
  refund_created: { requiresAll: [...APP_FUNDS_FACTS, "verified_payer", "verified_amount", "merchant_a2u_confirmed_none", ...REFUND_ABSENCE, "refund_eligibility_proof_exact", "refund_dto_scoped"], insufficientAlone: IDS_AND_REFUND_FLAGS, conflictsWith: REFUND_CONFLICTS, onUncertainty: "unknown" },
  refund_blockchain_confirmed: { requiresAll: [...APP_FUNDS_FACTS, "verified_payer", "verified_amount", "merchant_a2u_confirmed_none", ...REFUND_ABSENCE, "refund_eligibility_proof_exact", ...REFUND_FACTS.slice(0, 2)], insufficientAlone: IDS_AND_REFUND_FLAGS, conflictsWith: REFUND_CONFLICTS, onUncertainty: "unknown" },
  refund_pi_completed: { requiresAll: [...APP_FUNDS_FACTS, "verified_payer", "verified_amount", "merchant_a2u_confirmed_none", ...REFUND_ABSENCE, "refund_eligibility_proof_exact", ...REFUND_FACTS.slice(0, 3)], insufficientAlone: IDS_AND_REFUND_FLAGS, conflictsWith: REFUND_CONFLICTS, onUncertainty: "unknown" },
  refund_finalized: { requiresAll: [...APP_FUNDS_FACTS, "verified_payer", "verified_amount", "merchant_a2u_confirmed_none", ...REFUND_ABSENCE, "refund_eligibility_proof_exact", ...REFUND_FACTS], insufficientAlone: IDS_AND_REFUND_FLAGS, conflictsWith: REFUND_CONFLICTS, onUncertainty: "unknown" },
}
