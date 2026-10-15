import { query } from "@/lib/db"

/** FIN-100B: a payment's checkpoint time is not its original creation time.
 * This inventory certifies historical membership ONLY when an original-time
 * authority has been independently recorded in PostgreSQL. Neither Redis nor
 * later financial-event clocks may be promoted into that authority here.
 */
export type DurableMerchantHistoryIdentity = {
  paymentId: string
  merchantId: string
  merchantUid: string
  amount: number
  createdAt: string
  createdAtMs: number
}

function exactOriginalTime(raw: Record<string, unknown>): DurableMerchantHistoryIdentity {
  const paymentId = raw.paymentId
  const merchantId = raw.merchantId
  const merchantUid = raw.merchantUid
  const amount = Number(raw.amount)
  const createdAt = raw.createdAt
  const createdAtMs = Number(raw.createdAtMs)
  // If both independently durable original-create clocks exist, refuse to
  // silently prefer either on disagreement. They must agree to the millisecond.
  const intentTimeMs = raw.intentOriginalTimeMs == null ? null : Number(raw.intentOriginalTimeMs)
  const evidenceTimeMs = raw.evidenceOriginalTimeMs == null ? null : Number(raw.evidenceOriginalTimeMs)
  if ((intentTimeMs !== null && (!Number.isSafeInteger(intentTimeMs) || intentTimeMs <= 0)) ||
      (evidenceTimeMs !== null && (!Number.isSafeInteger(evidenceTimeMs) || evidenceTimeMs <= 0)) ||
      (intentTimeMs !== null && evidenceTimeMs !== null && intentTimeMs !== evidenceTimeMs))
    throw new Error("Merchant history original creation clocks contradictory")
  if (typeof paymentId !== "string" || !paymentId || paymentId !== paymentId.trim() ||
      typeof merchantId !== "string" || !merchantId || merchantId !== merchantId.trim() ||
      typeof merchantUid !== "string" || !merchantUid || merchantUid !== merchantUid.trim() ||
      !Number.isFinite(amount) || amount <= 0 ||
      typeof createdAt !== "string" || !Number.isSafeInteger(createdAtMs) || createdAtMs <= 0 ||
      !Number.isFinite(new Date(createdAtMs).getTime()) || new Date(createdAtMs).toISOString() !== createdAt ||
      raw.checkpointId !== paymentId || raw.checkpointMerchantId !== merchantId ||
      raw.checkpointMerchantUid !== merchantUid || Number(raw.checkpointAmount) !== amount ||
      Number(raw.merchantAmount) !== amount || Number(raw.commission) !== 0)
    throw new Error("Merchant history durable identity contradictory")
  return { paymentId, merchantId, merchantUid, amount, createdAt, createdAtMs }
}

async function legacyEvidenceTableExists(): Promise<boolean> {
  const rows = await query(`SELECT to_regclass('public.payment_creation_time_evidence') IS NOT NULL AS "exists"`)
  if (!rows || rows.length !== 1 || typeof (rows[0] as Record<string, unknown>).exists !== "boolean")
    throw new Error("Merchant history time evidence catalog unavailable")
  return (rows[0] as Record<string, unknown>).exists === true
}

/** No writes. The evidence table must be populated only after separate,
 * independently verified original-create-event proof. The migration does NOT
 * backfill timestamps from Redis/checkpoint/receipt/settlement timestamps.
 */
export async function listDurableMerchantHistoryIdentities(): Promise<DurableMerchantHistoryIdentity[]> {
  const evidenceReady = await legacyEvidenceTableExists()
  // The NULL branch deliberately fails closed on any legacy row until the
  // separately reviewed immutable evidence ledger is provisioned and certified.
  const evidenceJoin = evidenceReady
    ? `LEFT JOIN payment_creation_time_evidence e ON e.payment_id = c.payment_id`
    : `LEFT JOIN (SELECT NULL::text AS payment_id, NULL::timestamptz AS original_created_at,
                        NULL::text AS merchant_id, NULL::text AS merchant_uid,
                        NULL::numeric AS customer_amount) e ON FALSE`
  const rows = await query(`
    SELECT c.payment_id AS "paymentId", c.merchant_id AS "merchantId",
           c.merchant_uid AS "merchantUid", c.customer_amount::text AS amount,
           CASE WHEN i.payment_id IS NOT NULL
                THEN to_char(i.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                WHEN e.payment_id IS NOT NULL
                THEN to_char(e.original_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                ELSE NULL END AS "createdAt",
           CASE WHEN i.payment_id IS NOT NULL
                THEN floor(extract(epoch from i.created_at)*1000)::bigint::text
                WHEN e.payment_id IS NOT NULL
                THEN floor(extract(epoch from e.original_created_at)*1000)::bigint::text
                ELSE NULL END AS "createdAtMs",
           c.payment_id AS "checkpointId", c.merchant_id AS "checkpointMerchantId",
           c.merchant_uid AS "checkpointMerchantUid",
           c.customer_amount::text AS "checkpointAmount",
           c.merchant_amount::text AS "merchantAmount",
           c.app_commission::text AS commission,
           i.payment_id AS "intentId", i.merchant_id AS "intentMerchantId",
           i.merchant_uid AS "intentMerchantUid", i.customer_amount::text AS "intentAmount",
           CASE WHEN i.payment_id IS NOT NULL THEN floor(extract(epoch from i.created_at)*1000)::bigint::text ELSE NULL END AS "intentOriginalTimeMs",
           CASE WHEN e.payment_id IS NOT NULL THEN floor(extract(epoch from e.original_created_at)*1000)::bigint::text ELSE NULL END AS "evidenceOriginalTimeMs",
           e.payment_id AS "evidenceId", e.merchant_id AS "evidenceMerchantId",
           e.merchant_uid AS "evidenceMerchantUid", e.customer_amount::text AS "evidenceAmount"
    FROM settlement_checkpoints c
    LEFT JOIN payment_create_intents i ON i.payment_id = c.payment_id
    ${evidenceJoin}
    ORDER BY c.payment_id ASC LIMIT 2001
  `)
  if (!rows || rows.length > 2000) throw new Error("Merchant history durable inventory unavailable or over bound")
  const results: DurableMerchantHistoryIdentity[] = []
  const seen = new Set<string>()
  let unresolved = 0
  for (const source of rows) {
    const r = source as Record<string, unknown>
    if (r.intentId !== null && (r.intentId !== r.paymentId || r.intentMerchantId !== r.merchantId ||
        r.intentMerchantUid !== r.merchantUid || Number(r.intentAmount) !== Number(r.amount)))
      throw new Error("Merchant history create intent identity contradictory")
    if (r.evidenceId !== null && (r.evidenceId !== r.paymentId || r.evidenceMerchantId !== r.merchantId ||
        r.evidenceMerchantUid !== r.merchantUid || Number(r.evidenceAmount) !== Number(r.amount)))
      throw new Error("Merchant history original-time evidence identity contradictory")
    if (r.intentId === null && r.evidenceId === null) { unresolved++; continue }
    const identity = exactOriginalTime(r)
    if (seen.has(identity.paymentId)) throw new Error("Merchant history duplicate durable identity")
    seen.add(identity.paymentId)
    results.push(identity)
  }
  // Do NOT silently exclude historical rows: returning only modern intents
  // made legitimate legacy Redis projections look orphaned. Distinguish lack of
  // evidence from invalid membership, while preventing a misleading history.
  if (unresolved > 0) throw new Error(`Merchant history original creation evidence absent: ${unresolved} historical records`)
  return results
}

/** Read-only financial membership (NOT original-time or finality certification).
 * This counts the complete bounded durable checkpoint population independently
 * of Redis. A historical checkpoint is never discarded for lacking create time.
 */
export type MerchantHistoryCoverage = {
  totalCheckpointIdentities: number
  originalTimeCertified: number
  originalTimeMissing: number
  completeChronology: boolean
}

export async function readMerchantHistoryCoverage(): Promise<MerchantHistoryCoverage> {
  const evidenceReady = await legacyEvidenceTableExists()
  const evidenceJoin = evidenceReady
    ? `LEFT JOIN payment_creation_time_evidence e ON e.payment_id = c.payment_id`
    : `LEFT JOIN (SELECT NULL::text AS payment_id, NULL::timestamptz AS original_created_at,
                        NULL::text AS merchant_id, NULL::text AS merchant_uid,
                        NULL::numeric AS customer_amount) e ON FALSE`
  const rows = await query(`
    SELECT c.payment_id AS "paymentId", c.merchant_id AS "merchantId",
           c.merchant_uid AS "merchantUid", c.customer_amount::text AS amount,
           c.merchant_amount::text AS "merchantAmount", c.app_commission::text AS commission,
           i.payment_id AS "intentId", i.merchant_id AS "intentMerchantId",
           i.merchant_uid AS "intentMerchantUid", i.customer_amount::text AS "intentAmount",
           CASE WHEN i.payment_id IS NOT NULL THEN floor(extract(epoch from i.created_at)*1000)::bigint::text ELSE NULL END AS "intentMs",
           e.payment_id AS "evidenceId", e.merchant_id AS "evidenceMerchantId",
           e.merchant_uid AS "evidenceMerchantUid", e.customer_amount::text AS "evidenceAmount",
           CASE WHEN e.payment_id IS NOT NULL THEN floor(extract(epoch from e.original_created_at)*1000)::bigint::text ELSE NULL END AS "evidenceMs"
    FROM settlement_checkpoints c
    LEFT JOIN payment_create_intents i ON i.payment_id = c.payment_id
    ${evidenceJoin}
    ORDER BY c.payment_id ASC LIMIT 2001
  `)
  if (!Array.isArray(rows) || rows.length > 2000) throw new Error("Merchant history coverage over bound or unavailable")
  const seen = new Set<string>()
  let timeCertified = 0
  for (const item of rows) {
    const r = item as Record<string, unknown>
    const id = r.paymentId
    const amount = Number(r.amount)
    if (typeof id !== "string" || !id || id !== id.trim() || seen.has(id) ||
        typeof r.merchantId !== "string" || !r.merchantId || r.merchantId !== r.merchantId.trim() ||
        typeof r.merchantUid !== "string" || !r.merchantUid || r.merchantUid !== r.merchantUid.trim() ||
        !Number.isFinite(amount) || amount <= 0 ||
        Number(r.merchantAmount) !== amount || Number(r.commission) !== 0)
      throw new Error("Merchant history durable checkpoint authority contradictory")
    seen.add(id)
    if (r.intentId !== null && (r.intentId !== id || r.intentMerchantId !== r.merchantId ||
        r.intentMerchantUid !== r.merchantUid || Number(r.intentAmount) !== amount))
      throw new Error("Merchant history intent contradiction")
    if (r.evidenceId !== null && (r.evidenceId !== id || r.evidenceMerchantId !== r.merchantId ||
        r.evidenceMerchantUid !== r.merchantUid || Number(r.evidenceAmount) !== amount))
      throw new Error("Merchant history evidence contradiction")
    const intentMs = r.intentMs == null ? null : Number(r.intentMs)
    const evidenceMs = r.evidenceMs == null ? null : Number(r.evidenceMs)
    // A durable witness cannot be treated as absent simply because its clock is NULL.
    if ((r.intentId !== null && intentMs === null) ||
        (r.evidenceId !== null && evidenceMs === null))
      throw new Error("Merchant history durable original-time witness missing clock")
    if ((intentMs !== null && (!Number.isSafeInteger(intentMs) || intentMs <= 0)) ||
        (evidenceMs !== null && (!Number.isSafeInteger(evidenceMs) || evidenceMs <= 0)) ||
        (intentMs !== null && evidenceMs !== null && intentMs !== evidenceMs))
      throw new Error("Merchant history original creation time contradictory")
    if (intentMs !== null || evidenceMs !== null) timeCertified++
  }
  return { totalCheckpointIdentities: seen.size, originalTimeCertified: timeCertified,
    originalTimeMissing: seen.size - timeCertified,
    completeChronology: timeCertified === seen.size }
}

/** Read-only historical membership inventory for presentation diagnostics only.
 * Missing original-create evidence is explicitly NULL. This is NOT eligible
 * for Redis timestamp certification, recovery index repair, or financial finality.
 */
export type HistoricalMembershipWithoutCreationTime = {
  paymentId: string
  merchantId: string
  merchantUid: string
  amount: number
  createdAt: null
  creationTimeAuthority: "missing"
}

export async function listHistoricalMembershipWithoutCreationTime(merchantId: string): Promise<HistoricalMembershipWithoutCreationTime[]> {
  if (!merchantId || merchantId !== merchantId.trim()) throw new Error("Merchant history requested merchant invalid")
  const evidenceReady = await legacyEvidenceTableExists()
  const evidenceJoin = evidenceReady
    ? `LEFT JOIN payment_creation_time_evidence e ON e.payment_id = c.payment_id`
    : `LEFT JOIN (SELECT NULL::text AS payment_id, NULL::timestamptz AS original_created_at,
                        NULL::text AS merchant_id, NULL::text AS merchant_uid,
                        NULL::numeric AS customer_amount) e ON FALSE`
  const rows = await query(`
    SELECT c.payment_id AS "paymentId", c.merchant_id AS "merchantId",
           c.merchant_uid AS "merchantUid", c.customer_amount::text AS amount,
           c.merchant_amount::text AS "merchantAmount", c.app_commission::text AS commission,
           i.payment_id AS "intentId", i.merchant_id AS "intentMerchantId",
           i.merchant_uid AS "intentMerchantUid", i.customer_amount::text AS "intentAmount",
           CASE WHEN i.payment_id IS NOT NULL THEN floor(extract(epoch from i.created_at)*1000)::bigint::text ELSE NULL END AS "intentOriginalTimeMs",
           e.payment_id AS "evidenceId", e.merchant_id AS "evidenceMerchantId",
           e.merchant_uid AS "evidenceMerchantUid", e.customer_amount::text AS "evidenceAmount",
           CASE WHEN e.payment_id IS NOT NULL THEN floor(extract(epoch from e.original_created_at)*1000)::bigint::text ELSE NULL END AS "evidenceOriginalTimeMs"
    FROM settlement_checkpoints c
    LEFT JOIN payment_create_intents i ON i.payment_id = c.payment_id
    ${evidenceJoin}
    WHERE c.merchant_id = $1
    ORDER BY c.payment_id ASC LIMIT 2001
  `, [merchantId])
  if (!rows || rows.length > 2000) throw new Error("Merchant history durable inventory unavailable or over bound")
  const seen = new Set<string>()
  const result: HistoricalMembershipWithoutCreationTime[] = []
  for (const source of rows) {
    const r = source as Record<string, unknown>
    if (typeof r.paymentId !== "string" || !r.paymentId || r.paymentId !== r.paymentId.trim() ||
        typeof r.merchantId !== "string" || !r.merchantId || r.merchantId !== r.merchantId.trim() ||
        typeof r.merchantUid !== "string" || !r.merchantUid || r.merchantUid !== r.merchantUid.trim() ||
        !Number.isFinite(Number(r.amount)) || Number(r.amount) <= 0 ||
        Number(r.merchantAmount) !== Number(r.amount) || Number(r.commission) !== 0 ||
        seen.has(r.paymentId)) throw new Error("Merchant historical membership contradictory")
    // Even a row omitted from the undated presentation must have consistent
    // durable time evidence: never silently hide a foreign/mismatched join.
    if (r.intentId !== null && (r.intentId !== r.paymentId || r.intentMerchantId !== r.merchantId ||
        r.intentMerchantUid !== r.merchantUid || Number(r.intentAmount) !== Number(r.amount)))
      throw new Error("Merchant history intent authority contradictory")
    if (r.evidenceId !== null && (r.evidenceId !== r.paymentId || r.evidenceMerchantId !== r.merchantId ||
        r.evidenceMerchantUid !== r.merchantUid || Number(r.evidenceAmount) !== Number(r.amount)))
      throw new Error("Merchant history time evidence authority contradictory")
    const intentMs = r.intentOriginalTimeMs === null ? null : Number(r.intentOriginalTimeMs)
    const evidenceMs = r.evidenceOriginalTimeMs === null ? null : Number(r.evidenceOriginalTimeMs)
    if ((r.intentId !== null && intentMs === null) ||
        (r.evidenceId !== null && evidenceMs === null))
      throw new Error("Merchant history original-time witness missing clock")
    if ((intentMs !== null && (!Number.isSafeInteger(intentMs) || intentMs <= 0)) ||
        (evidenceMs !== null && (!Number.isSafeInteger(evidenceMs) || evidenceMs <= 0)) ||
        (intentMs !== null && evidenceMs !== null && intentMs !== evidenceMs))
      throw new Error("Merchant history original creation clocks contradictory")
    seen.add(r.paymentId)
    if (r.intentId === null && r.evidenceId === null) {
      result.push({ paymentId: r.paymentId, merchantId: r.merchantId,
        merchantUid: r.merchantUid, amount: Number(r.amount),
        createdAt: null, creationTimeAuthority: "missing" })
    }
  }
  return result
}

export async function readDurableOriginalPaymentCreationTime(
  paymentId: string, merchantId: string, merchantUid: string, amount: number
): Promise<string> {
  const evidenceReady = await legacyEvidenceTableExists()
  const evidenceJoin = evidenceReady
    ? `LEFT JOIN payment_creation_time_evidence e ON e.payment_id = c.payment_id`
    : `LEFT JOIN (SELECT NULL::text AS payment_id, NULL::timestamptz AS original_created_at,
                        NULL::text AS merchant_id, NULL::text AS merchant_uid,
                        NULL::numeric AS customer_amount) e ON FALSE`
  const rows = await query(`
    SELECT c.payment_id AS "paymentId", c.merchant_id AS "merchantId",
           c.merchant_uid AS "merchantUid", c.customer_amount::text AS amount,
           COALESCE(i.created_at, e.original_created_at) AS "evidenceRaw",
           to_char(COALESCE(i.created_at,e.original_created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
           floor(extract(epoch from COALESCE(i.created_at,e.original_created_at))*1000)::bigint::text AS "createdAtMs",
           c.payment_id AS "checkpointId", c.merchant_id AS "checkpointMerchantId",
           c.merchant_uid AS "checkpointMerchantUid", c.customer_amount::text AS "checkpointAmount",
           c.merchant_amount::text AS "merchantAmount", c.app_commission::text AS commission,
           i.payment_id AS "intentId", i.merchant_id AS "intentMerchantId",
           i.merchant_uid AS "intentMerchantUid", i.customer_amount::text AS "intentAmount",
           CASE WHEN i.payment_id IS NOT NULL THEN floor(extract(epoch from i.created_at)*1000)::bigint::text ELSE NULL END AS "intentOriginalTimeMs",
           CASE WHEN e.payment_id IS NOT NULL THEN floor(extract(epoch from e.original_created_at)*1000)::bigint::text ELSE NULL END AS "evidenceOriginalTimeMs",
           e.payment_id AS "evidenceId", e.merchant_id AS "evidenceMerchantId",
           e.merchant_uid AS "evidenceMerchantUid", e.customer_amount::text AS "evidenceAmount"
    FROM settlement_checkpoints c
    LEFT JOIN payment_create_intents i ON i.payment_id=c.payment_id
    ${evidenceJoin}
    WHERE c.payment_id=$1 AND c.merchant_id=$2 AND c.merchant_uid=$3 AND c.customer_amount=$4
    LIMIT 2`, [paymentId, merchantId, merchantUid, amount])
  if (!rows || rows.length !== 1) throw new Error("Original creation time exact authority absent")
  const r = rows[0] as Record<string, unknown>
  if (r.intentId === null && r.evidenceId === null) throw new Error("Original creation time proof missing for historical payment")
  if (r.intentId !== null && (r.intentId !== paymentId || r.intentMerchantId !== merchantId ||
      r.intentMerchantUid !== merchantUid || Number(r.intentAmount) !== amount))
    throw new Error("Original creation time intent contradiction")
  if (r.evidenceId !== null && (r.evidenceId !== paymentId || r.evidenceMerchantId !== merchantId ||
      r.evidenceMerchantUid !== merchantUid || Number(r.evidenceAmount) !== amount))
    throw new Error("Original creation time evidence contradiction")
  return exactOriginalTime(r).createdAt
}
