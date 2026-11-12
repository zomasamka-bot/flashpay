import type { FlashPayReceiptStatus, Payment, PaymentStatus } from "./types"

export function toReceiptStatus(
  status: PaymentStatus | string | null | undefined,
  details?: Pick<Payment, "settlementFailureState" | "refundStatus">,
): FlashPayReceiptStatus {
  if (status === "settled_to_merchant") return "successful"
  if (status === "refunded" || details?.refundStatus === "completed") return "refunded"
  if (status === "pending" || status === "paid_to_app" || status === "settlement_pending" || status === "refund_pending") return "processing"
  if (status === "cancelled") return "cancelled"
  if (details?.settlementFailureState === "held" || details?.settlementFailureState === "manual_review_required" || details?.refundStatus === "manual_review_required") return "needs_attention"
  if (status === "failed" || status === "settlement_failed") return "failed"
  return "needs_attention"
}

export function normalizeReceiptName(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.toLowerCase() === "customer") return null
  return trimmed
}

/** Preserve all seven ledger decimal places while retaining the familiar .00 display. */
export function formatReceiptAmount(amount:number):string {
 if(!Number.isFinite(amount)||amount<0)return '—'
 const [whole,fraction]=amount.toFixed(7).split('.')
 return whole+'.'+fraction.replace(/0+$/, '').padEnd(2,'0')
}
