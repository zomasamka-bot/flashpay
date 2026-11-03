import "server-only"

import { getDurableU2AIngressAuthoritative, getSettlementCheckpointAuthoritative, readSettlementRefundAuthority } from "./db"
import { getRefundCheckpointsByPaymentIds } from "./refund-checkpoint-store"

/** Read-only presentation guard. A Redis flag can request a final view, but
 * cannot establish it. No queue, checkpoint, receipt, balance or send is changed.
 * Non-final views retain their existing processing/recovery contract. */
export async function verifyFinalPaymentPresentation(payment: Record<string, unknown>): Promise<boolean> {
  const settlement = payment.status === "settled_to_merchant"
  const refund = payment.status === "refunded" || payment.refundStatus === "completed" || payment.settlementFailureState === "refunded"
  if (!settlement && !refund) return true
  if (settlement && refund) return false
  const id = payment.id
  if (typeof id !== "string" || !id || id !== id.trim()) return false
  try {
    const authority = await readSettlementRefundAuthority(id)
    if (authority.outcome !== "CLEAR") return false
    if (settlement) {
      if (!authority.settlementActive || authority.refundActive) return false
      const durable = await getSettlementCheckpointAuthoritative(id)
      if (durable.outcome !== "FOUND" || durable.checkpoint.stage !== "db_finalized") return false
      const d = durable.checkpoint
      if (d.paymentId !== id || d.merchantId !== payment.merchantId || d.merchantUid !== payment.merchantUid ||
          d.customerAmount !== payment.amount || (payment.customerAmount != null && d.customerAmount !== payment.customerAmount) ||
          (payment.merchantAmount != null && d.merchantAmount !== payment.merchantAmount) ||
          (payment.appCommission != null && payment.appCommission !== 0) ||
          d.u2aIdentifier !== payment.piPaymentId || d.u2aTxid !== payment.u2aTxid || d.a2uTxid !== payment.a2uTxid ||
          (payment.a2uPaymentId != null && d.a2uPaymentId !== payment.a2uPaymentId)) return false
    } else {
      if (authority.settlementActive || !authority.refundActive) return false
      const ingress = await getDurableU2AIngressAuthoritative(id)
      const refunds = await getRefundCheckpointsByPaymentIds([id])
      const r = refunds.state === "ok" ? refunds.checkpoints.get(id) : undefined
      if (ingress.outcome !== "FOUND" || ingress.checkpoint.completedAt === null || !r ||
          r.status !== "completed" || r.stage !== "audit_recorded") return false
      const d = ingress.checkpoint
      if (d.paymentId !== id || d.merchantId !== payment.merchantId || d.merchantUid !== payment.merchantUid ||
          d.customerAmount !== payment.amount || d.u2aIdentifier !== payment.piPaymentId ||
          r.paymentId !== id || r.payerUid !== d.payerUid || r.amount !== d.customerAmount ||
          (payment.refundPaymentId != null && payment.refundPaymentId !== r.refundPaymentId) ||
          (payment.refundTxid != null && payment.refundTxid !== r.refundTxid)) return false
    }
    const confirmation = await readSettlementRefundAuthority(id)
    return confirmation.outcome === "CLEAR" && confirmation.settlementActive === authority.settlementActive &&
      confirmation.refundActive === authority.refundActive
  } catch {
    return false
  }
}
