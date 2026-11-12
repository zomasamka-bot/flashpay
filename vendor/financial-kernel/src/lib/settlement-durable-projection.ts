import {netImpact} from './payment-financial-contract'
import "server-only"

import type { Payment } from "./types"
import { getSettlementCheckpointAuthoritative, getDurableU2AIngressAuthoritative, verifySettlementRefundAuthorityExclusion, readDr11RefundCertificationHold } from "./db"

/** Read-only reconstruction. Neither a Redis value nor a network absence can grant
 * financial authority. The authoritative Settlement read supplies the original durable U2A identity. */
export async function readDurableSettlementProjection(paymentId: string): Promise<Payment | null> {
  const settlement = await getSettlementCheckpointAuthoritative(paymentId)
  if (settlement.outcome !== "FOUND") {
    // Reuse the original F2-3 pre-A2U projection contract for a scoped wake:
    // a completed U2A can survive loss of Redis before Stage1 exists. This is
    // not Settlement finality and cannot grant a submission attempt.
    const ingress = await getDurableU2AIngressAuthoritative(paymentId)
    if (ingress.outcome !== "FOUND" || ingress.checkpoint.completedAt === null) return null
    const authority = await verifySettlementRefundAuthorityExclusion(paymentId)
    if (authority.outcome !== "CLEAR" || authority.refundActive) return null
    const hold = await readDr11RefundCertificationHold(paymentId)
    if (hold.outcome !== "ABSENT") return null
    const d = ingress.checkpoint
    return {
      id:d.paymentId, merchantId:d.merchantId, merchantUid:d.merchantUid, accessToken:"", redisProjectionVersion:1,
      ...(d.financialContract?{financialContract:d.financialContract}:{}),
    amount:d.customerAmount, customerAmount:d.customerAmount, note:"", status:"paid_to_app", createdAt:d.createdAt,
      piPaymentId:d.u2aIdentifier, u2aTxid:d.u2aTxid, payerUid:d.payerUid, payerUidSource:"verified_u2a",
      payerUidCapturedAt:d.verifiedAt, paidAt:d.completedAt!, settlementDispatchRequestedAt:d.completedAt!,
    }
  }
  const d = settlement.checkpoint
  if (!d.payerUid || !d.u2aVerifiedAt || !d.paidAt) return null
  if (d.stage === "a2u_created" && (!d.a2uCreateAttemptedAt || Date.parse(d.a2uCreateAttemptedAt) < Date.parse(d.paidAt))) return null
  const prepared = d.stage !== "a2u_created"
  const moved = d.stage === "horizon_confirmed" || d.stage === "pi_completed" || d.stage === "db_finalized"
  const piDone = d.stage === "pi_completed" || d.stage === "db_finalized"
  const dbDone = d.stage === "db_finalized"
  return {
    id:d.paymentId, merchantId:d.merchantId, merchantUid:d.merchantUid, accessToken:"", redisProjectionVersion:1,
    ...(d.financialContract?{financialContract:d.financialContract}:{}),
    amount:d.customerAmount, customerAmount:d.customerAmount, merchantAmount:d.merchantAmount, appCommission:d.appCommission,
    note:"", status:dbDone?"settled_to_merchant":prepared?"settlement_pending":"paid_to_app",
    createdAt:d.createdAt, paidAt:d.paidAt, settlementDispatchRequestedAt:d.paidAt,
    piPaymentId:d.u2aIdentifier, u2aTxid:d.u2aTxid, payerUid:d.payerUid,
    payerUidSource:"verified_u2a", payerUidCapturedAt:d.u2aVerifiedAt, payerRefundEligible:false,
    a2uPaymentId:d.a2uPaymentId, a2uFromAddress:d.a2uFromAddress, a2uToAddress:d.a2uToAddress,
    settlementFailureState:"none",
    ...(d.a2uCreateAttemptedAt?{lastAttemptAt:d.a2uCreateAttemptedAt}:{}),
    ...(dbDone?{settledAt:d.dbFinalizedAt}:{}),
    ...(prepared?{a2uPreparedEnvelopeXdr:d.preparedEnvelopeXdr,a2uPreparedTxHash:d.preparedTxHash,a2uPreparedSequence:d.preparedSequence}:{}),
    ...(moved?{a2uTxid:d.a2uTxid,horizonSuccessFlag:true,horizonSuccessAt:d.horizonConfirmedAt,horizonFeeCharged:d.horizonFeeStroops!/10_000_000,
      appNetImpact:netImpact(d.customerAmount,d.merchantAmount,d.horizonFeeStroops!/10_000_000,d.financialContract),
      piCompletionPending:!piDone,piCompleted:piDone,requiresDbReconciliation:piDone&&!dbDone,dbRecorded:dbDone}:{}),
  }
}
