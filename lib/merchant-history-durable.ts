import { query } from "@/lib/db"

/** Read-only, bounded durable identity inventory. No payment-state inference. */
export type DurableMerchantHistoryIdentity = {
  paymentId: string
  merchantId: string
  merchantUid: string
  amount: number
  createdAt: string
  createdAtMs: number
}

export async function listDurableMerchantHistoryIdentities(): Promise<DurableMerchantHistoryIdentity[]> {
  // Fetch one extra row so a truncated inventory can never be certified.
  const rows = await query(`
    SELECT i.payment_id AS "paymentId", i.merchant_id AS "merchantId",
           i.merchant_uid AS "merchantUid", i.customer_amount::text AS amount,
           to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
           floor(extract(epoch from i.created_at) * 1000)::bigint::text AS "createdAtMs",
           c.payment_id AS "checkpointId", c.merchant_id AS "checkpointMerchantId",
           c.merchant_uid AS "checkpointMerchantUid",
           c.customer_amount::text AS "checkpointAmount",
           c.merchant_amount::text AS "merchantAmount",
           c.app_commission::text AS commission
    FROM payment_create_intents i
    LEFT JOIN settlement_checkpoints c ON c.payment_id = i.payment_id
    ORDER BY i.payment_id ASC LIMIT 2001
  `)
  if (!rows || rows.length > 2000) throw new Error("Merchant history durable inventory unavailable or over bound")
  const identities: DurableMerchantHistoryIdentity[] = []
  const seen = new Set<string>()
  for (const raw of rows) {
    const r = raw as Record<string, unknown>
    const paymentId = r.paymentId
    const merchantId = r.merchantId
    const merchantUid = r.merchantUid
    const amount = Number(r.amount)
    const createdAtMs = Number(r.createdAtMs)
    const createdAt = r.createdAt
    if (typeof paymentId !== "string" || !paymentId || paymentId !== paymentId.trim() || seen.has(paymentId) ||
        typeof merchantId !== "string" || !merchantId || merchantId !== merchantId.trim() ||
        typeof merchantUid !== "string" || !merchantUid || merchantUid !== merchantUid.trim() ||
        typeof createdAt !== "string" || !Number.isSafeInteger(createdAtMs) ||
        new Date(createdAtMs).toISOString() !== createdAt || !Number.isFinite(amount) || amount <= 0 ||
        r.checkpointId !== paymentId || r.checkpointMerchantId !== merchantId ||
        r.checkpointMerchantUid !== merchantUid || Number(r.checkpointAmount) !== amount ||
        Number(r.merchantAmount) !== amount || Number(r.commission) !== 0) {
      throw new Error("Merchant history durable identity contradictory")
    }
    seen.add(paymentId)
    identities.push({ paymentId, merchantId, merchantUid, amount, createdAt, createdAtMs })
  }
  return identities
}
