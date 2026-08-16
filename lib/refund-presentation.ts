import type { RefundPresentation } from "./types"

export function deriveRefundPresentationState(
  input: Omit<RefundPresentation, "state" | "customerStatus" | "merchantStatus">,
): RefundPresentation["state"] {
  const networkConfirmed =
    typeof input.refundPaymentId === "string" &&
    input.refundPaymentId.trim().length > 0 &&
    typeof input.refundTxid === "string" &&
    input.refundTxid.trim().length > 0 &&
    input.blockchain.confirmed &&
    input.blockchain.piTransactionVerified === true &&
    input.blockchain.horizonSuccessful === true

  const finalComplete =
    networkConfirmed &&
    input.blockchain.piDeveloperCompleted === true &&
    input.finalization.accountingRecorded === true &&
    input.finalization.auditRecorded === true &&
    input.finalization.completionAuditRecorded === true &&
    input.finalization.projectionFinalized === true &&
    input.refundStatus === "completed" &&
    input.refundStage === "audit_recorded"

  if (finalComplete) return "completed"
  if (networkConfirmed) return "blockchain_confirmed"
  if (input.refundStatus === "failed" || input.refundStage === "manual_review_required") return "attention_required"
  return "pending"
}
