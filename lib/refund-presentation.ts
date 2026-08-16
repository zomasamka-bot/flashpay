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
  if (input.refundStatus === "failed" || input.refundStatus === "manual_review_required") return "attention_required"
  return "pending"
}

export function deriveRefundAudienceStatuses(
  state: RefundPresentation["state"],
): Pick<RefundPresentation, "customerStatus" | "merchantStatus"> {
  if (state === "pending") return { customerStatus: "refund_pending", merchantStatus: "refund_pending" }
  if (state === "blockchain_confirmed") return { customerStatus: "refund_confirmed", merchantStatus: "refund_confirmed" }
  if (state === "completed") return { customerStatus: "refund_completed", merchantStatus: "refund_completed" }
  return { customerStatus: "refund_delayed", merchantStatus: "refund_attention_required" }
}
