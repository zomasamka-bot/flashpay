import type { RefundPiReconciliationOutcome } from "./refund-pi-reconciliation"
import type { RefundBlockchainEvidenceResult } from "./refund-blockchain-evidence"
import type { ExactlyOncePresenceState } from "./financial-recovery-exactly-once-gate"

export type SettlementOppositeEvidenceInput = Readonly<{
  refundPiOutcome: RefundPiReconciliationOutcome
  refundBlockchainOutcome: RefundBlockchainEvidenceResult["outcome"] | null
}>

export type SettlementOppositeEvidenceResult = Readonly<{
  oppositePaymentId: ExactlyOncePresenceState
  oppositeTxid: ExactlyOncePresenceState
  oppositeMoneyMovement: ExactlyOncePresenceState
}>

export function deriveSettlementOppositeEvidence(
  input: SettlementOppositeEvidenceInput,
): SettlementOppositeEvidenceResult {
  const oppositePaymentId =
    input.refundPiOutcome === "FOUND"
      ? "PRESENT"
      : input.refundPiOutcome === "CONFIRMED_NONE"
        ? "ABSENT"
        : "UNKNOWN"

  const blockchainPresent = input.refundBlockchainOutcome === "VERIFIED_TX"
  const blockchainUnknown = input.refundBlockchainOutcome !== "VERIFIED_TX"

  return {
    oppositePaymentId,
    oppositeTxid: blockchainPresent ? "PRESENT" : blockchainUnknown ? "UNKNOWN" : "ABSENT",
    oppositeMoneyMovement: blockchainPresent ? "PRESENT" : blockchainUnknown ? "UNKNOWN" : "ABSENT",
  }
}
