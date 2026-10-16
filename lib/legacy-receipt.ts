import type { PostgresHistoricalReceiptView } from "./types"
import { normalizeReceiptName, toReceiptStatus } from "./receipt-presentation"

/** Pure guard for the historical read model: PostgreSQL receipt + transaction
 * must agree on merchant, UID, and amount. This never creates a new payment
 * identity, settlement, receipt, or original creation timestamp.
 */
export function buildPostgresHistoricalReceipt(
  value: unknown, authenticatedMerchant: string,
): PostgresHistoricalReceiptView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const transactionId = row.transactionId
  if (typeof transactionId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transactionId) ||
      typeof authenticatedMerchant !== "string" || !authenticatedMerchant) return null
  if (row.transactionMerchantId !== authenticatedMerchant ||
      row.receiptMerchantId !== authenticatedMerchant ||
      typeof row.transactionMerchantUid !== "string" ||
      row.receiptMerchantUid !== row.transactionMerchantUid) return null

  const amount = Number(row.transactionAmount)
  if (row.transactionAmount === null || row.receiptAmount === null ||
      !Number.isFinite(amount) || amount <= 0 || Number(row.receiptAmount) !== amount) return null
  if (row.customerAmount !== null && row.customerAmount !== undefined &&
      Number(row.customerAmount) !== amount) return null
  if (row.merchantAmount !== null && row.merchantAmount !== undefined &&
      Number(row.merchantAmount) !== amount) return null
  if (row.appCommission !== null && row.appCommission !== undefined &&
      Number(row.appCommission) !== 0) return null
  if (row.receiptCurrency !== "π" ||
      (row.receiptU2aIdentifier !== null && row.receiptU2aIdentifier !== undefined &&
        row.receiptU2aIdentifier !== row.transactionPaymentId)) return null

  const recorded = row.receiptTimestamp
  const timestamp = recorded instanceof Date ? recorded.getTime() :
    typeof recorded === "string" && recorded.trim() ? Date.parse(recorded) : NaN
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null
  if (row.receiptSettlementStatus !== null && row.receiptSettlementStatus !== undefined &&
      typeof row.receiptSettlementStatus !== "string") return null
  if (row.transactionDescription !== null && row.transactionDescription !== undefined &&
      typeof row.transactionDescription !== "string") return null

  return {
    receiptAuthority: "postgres_transaction",
    transactionId,
    merchantName: authenticatedMerchant,
    customerName: normalizeReceiptName(row.payerUsername),
    amount,
    currency: "π",
    status: toReceiptStatus(row.receiptSettlementStatus as string | null | undefined),
    // Receipt event timestamp; NOT the original payment creation time.
    receiptRecordedAt: new Date(timestamp).toISOString(),
    note: typeof row.transactionDescription === "string" ? row.transactionDescription.trim() || null : null,
  }
}
