import type { RefundCheckpoint, RefundPresentation, RefundPresentationPersistenceTimestamps } from "./types"

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

export function buildRefundPresentation(
  input: Omit<RefundPresentation, "state" | "customerStatus" | "merchantStatus">,
): RefundPresentation {
  const state = deriveRefundPresentationState(input)
  const statuses = deriveRefundAudienceStatuses(state)
  return { ...input, state, ...statuses }
}

export function buildRefundPresentationFromEvidence(
  checkpoint: RefundCheckpoint,
  evidence: Pick<RefundPresentation, "requestedAt" | "blockchain" | "finalization">,
): RefundPresentation {
  return buildRefundPresentation({
    paymentId: checkpoint.paymentId,
    refundId: checkpoint.refundId,
    amount: checkpoint.amount,
    currency: checkpoint.currency,
    refundStatus: checkpoint.status,
    refundStage: checkpoint.stage,
    refundPaymentId: checkpoint.refundPaymentId,
    refundTxid: checkpoint.refundTxid,
    createdAt: checkpoint.createdAt,
    ...evidence,
  })
}

export function deriveRefundFinalizationFromPersistence(
  t: RefundPresentationPersistenceTimestamps,
): RefundPresentation["finalization"] {
  return {
    accountingRecorded: t.accountingRecordedAt !== null,
    accountingRecordedAt: t.accountingRecordedAt,
    auditRecorded: t.auditRecordedAt !== null,
    auditRecordedAt: t.auditRecordedAt,
    completionAuditRecorded: t.completedAt !== null,
    completedAt: t.completedAt,
    projectionFinalized: t.finalizedAt !== null,
    finalizedAt: t.finalizedAt,
  }
}

export function normalizeRefundPersistenceTimestamp(value: unknown): string | null {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string" && /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value)
        ? new Date(value)
        : null
  if (!date || !Number.isFinite(date.getTime())) return null
  return date.toISOString()
}
