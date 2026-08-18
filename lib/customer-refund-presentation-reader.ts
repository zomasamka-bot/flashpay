import "server-only"

import { query } from "@/lib/db"
import { readRefundPresentation } from "@/lib/refund-presentation-reader"
import type { RefundPresentation } from "@/lib/types"

export type CustomerRefundPresentationReadResult =
  | { outcome: "FOUND"; presentation: RefundPresentation }
  | { outcome: "NOT_FOUND" }
  | { outcome: "FORBIDDEN" }
  | { outcome: "INDETERMINATE" }

export async function readCustomerRefundPresentation(
  paymentId: string,
  verifiedCallerUid: string,
): Promise<CustomerRefundPresentationReadResult> {
  if (!paymentId || !verifiedCallerUid) return { outcome: "INDETERMINATE" }

  try {
    const rows = await query(
      "SELECT refund_id,payment_id,payer_uid FROM refund_checkpoints WHERE payment_id=$1 LIMIT 2",
      [paymentId],
    )
    if (!Array.isArray(rows)) return { outcome: "INDETERMINATE" }
    if (rows.length === 0) return { outcome: "NOT_FOUND" }
    if (rows.length > 1) return { outcome: "INDETERMINATE" }

    const row = rows[0] as Record<string, unknown>
    if (
      typeof row.refund_id !== "string" ||
      typeof row.payment_id !== "string" ||
      typeof row.payer_uid !== "string" ||
      row.payment_id !== paymentId
    ) return { outcome: "INDETERMINATE" }
    if (row.payer_uid !== verifiedCallerUid) return { outcome: "FORBIDDEN" }

    const result = await readRefundPresentation(row.refund_id)
    if (result.outcome !== "FOUND" || result.presentation.paymentId !== paymentId) {
      return { outcome: "INDETERMINATE" }
    }
    return { outcome: "FOUND", presentation: result.presentation }
  } catch {
    return { outcome: "INDETERMINATE" }
  }
}
