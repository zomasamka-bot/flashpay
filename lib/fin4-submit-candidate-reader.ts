import "server-only"

import { query } from "@/lib/db"

export type Fin4DurableCandidateClass =
  | "SETTLEMENT_SUBMIT_ENTRY_CANDIDATE"
  | "PREPARATION_REQUIRED_STAGE1"
  | "ALREADY_MOVED"
  | "BLOCKED_REFUND_AUTHORITY"
  | "BLOCKED_CERTIFICATION_HOLD"
  | "INDETERMINATE_INVALID_DURABLE_ROW"

export type Fin4DurableCandidate = Readonly<{
  paymentId: string
  stage: string
  sourceWallet: string
  a2uPaymentIdPresent: boolean
  a2uPaymentId: string | null
  merchantUid: string | null
  customerAmount: number | null
  preparedHashPresent: boolean
  preparedSequencePresent: boolean
  preparedEnvelopePresent: boolean
  movementPresent: boolean
  refundActive: boolean
  classification: Fin4DurableCandidateClass
  updatedAt: string | null
}>

export type Fin4SubmitCandidateScan = Readonly<{
  sourceWallet: string
  sameWalletRowCount: number
  submitEntryCandidateCount: number
  stage1PreparationCandidateCount: number
  movedCount: number
  blockedCount: number
  indeterminateCount: number
  provesTwoSubmitEntryCandidates: boolean
  nearestTwo: readonly Fin4DurableCandidate[]
  candidates: readonly Fin4DurableCandidate[]
}>

function nonEmptyExactString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value === value.trim()
}

function exactFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString()
  }
  return null
}

function activeCertificationHold(row: Record<string, unknown>): boolean {
  if (!nonEmptyExactString(row.certification_hold)) return false
  if (row.certification_hold_expires_at == null) return true
  const expiry = isoOrNull(row.certification_hold_expires_at)
  if (expiry === null) return true
  return Date.parse(expiry) > Date.now()
}

function classify(row: Record<string, unknown>, expectedSourceWallet: string): Fin4DurableCandidate {
  const paymentId = nonEmptyExactString(row.payment_id) ? row.payment_id : "INVALID"
  const stage = typeof row.stage === "string" ? row.stage : "INVALID"
  const sourceWallet = nonEmptyExactString(row.a2u_from_address) ? row.a2u_from_address : "INVALID"
  const a2uPaymentIdPresent = nonEmptyExactString(row.a2u_payment_id)
  const a2uPaymentId = a2uPaymentIdPresent ? String(row.a2u_payment_id) : null
  const merchantUid = nonEmptyExactString(row.merchant_uid) ? String(row.merchant_uid) : null
  const preparedEnvelopePresent = nonEmptyExactString(row.prepared_envelope_xdr)
  const preparedHashPresent = typeof row.prepared_tx_hash === "string" && /^[0-9a-f]{64}$/.test(row.prepared_tx_hash)
  const preparedSequencePresent = /^[1-9][0-9]*$/.test(String(row.prepared_sequence ?? ""))
  const movementPresent = typeof row.a2u_txid === "string" && /^[0-9a-f]{64}$/.test(row.a2u_txid)
  const refundActive = row.refund_active === true
  const updatedAt = isoOrNull(row.updated_at)

  const version = exactFiniteNumber(row.version)
  const customerAmount = exactFiniteNumber(row.customer_amount)
  const merchantAmount = exactFiniteNumber(row.merchant_amount)
  const appCommission = exactFiniteNumber(row.app_commission)
  const baseValid =
    paymentId !== "INVALID" &&
    ["a2u_created", "prepared", "horizon_confirmed", "pi_completed", "db_finalized"].includes(stage) &&
    sourceWallet === expectedSourceWallet &&
    a2uPaymentIdPresent &&
    nonEmptyExactString(row.a2u_to_address) &&
    nonEmptyExactString(row.merchant_id) &&
    nonEmptyExactString(row.merchant_uid) &&
    nonEmptyExactString(row.u2a_identifier) &&
    typeof row.u2a_txid === "string" && /^[0-9a-f]{64}$/.test(row.u2a_txid) &&
    version !== null && Number.isSafeInteger(version) && version >= 1 &&
    customerAmount !== null && customerAmount > 0 && merchantAmount === customerAmount && appCommission === 0 &&
    updatedAt !== null

  let classification: Fin4DurableCandidateClass
  if (!baseValid) {
    classification = "INDETERMINATE_INVALID_DURABLE_ROW"
  } else if (refundActive) {
    classification = "BLOCKED_REFUND_AUTHORITY"
  } else if (activeCertificationHold(row)) {
    classification = "BLOCKED_CERTIFICATION_HOLD"
  } else if (["horizon_confirmed", "pi_completed", "db_finalized"].includes(stage) || movementPresent) {
    classification = "ALREADY_MOVED"
  } else if (
    stage === "prepared" &&
    preparedEnvelopePresent && preparedHashPresent && preparedSequencePresent &&
    !movementPresent && row.horizon_fee_stroops == null && row.horizon_confirmed_at == null &&
    row.pi_completed_at == null && row.db_finalized_at == null
  ) {
    classification = "SETTLEMENT_SUBMIT_ENTRY_CANDIDATE"
  } else if (
    stage === "a2u_created" &&
    !preparedEnvelopePresent && !preparedHashPresent && row.prepared_sequence == null &&
    !movementPresent && row.horizon_fee_stroops == null && row.horizon_confirmed_at == null &&
    row.pi_completed_at == null && row.db_finalized_at == null
  ) {
    classification = "PREPARATION_REQUIRED_STAGE1"
  } else {
    classification = "INDETERMINATE_INVALID_DURABLE_ROW"
  }

  return {
    paymentId,
    stage,
    sourceWallet,
    a2uPaymentIdPresent,
    a2uPaymentId,
    merchantUid,
    customerAmount,
    preparedHashPresent,
    preparedSequencePresent,
    preparedEnvelopePresent,
    movementPresent,
    refundActive,
    classification,
    updatedAt,
  }
}

/**
 * FIN-4 R4G read-only durable candidate scan.
 *
 * This function executes SELECT only. It does not advance recovery cursors,
 * create Pi payments, sign XDR, submit Horizon transactions, mutate Redis, or
 * write any financial/durable authority. Its purpose is only to prove whether
 * two already-existing durable rows can enter the existing SETTLEMENT_SUBMIT
 * recovery gate from the same source wallet, and otherwise identify the two
 * closest durable rows for a separate preparation phase.
 */
export async function readFin4SameWalletSubmitCandidates(sourceWallet: string): Promise<Fin4SubmitCandidateScan | null> {
  if (!nonEmptyExactString(sourceWallet)) return null

  const rows = await query(
    `SELECT s.payment_id,s.version,s.stage,s.merchant_id,s.merchant_uid,s.customer_amount,s.merchant_amount,s.app_commission,
            s.u2a_identifier,s.u2a_txid,s.a2u_payment_id,s.a2u_from_address,s.a2u_to_address,
            s.prepared_envelope_xdr,s.prepared_tx_hash,s.prepared_sequence,s.a2u_txid,s.horizon_fee_stroops,
            s.horizon_confirmed_at,s.pi_completed_at,s.db_finalized_at,s.certification_hold,s.certification_hold_expires_at,s.updated_at,
            EXISTS(
              SELECT 1 FROM refund_checkpoints r
              WHERE r.payment_id=s.payment_id AND r.status<>'manual_review_required'
            ) AS refund_active
       FROM settlement_checkpoints s
      WHERE s.a2u_from_address=$1
        AND s.stage IN ('a2u_created','prepared','horizon_confirmed','pi_completed','db_finalized')
      ORDER BY CASE s.stage WHEN 'prepared' THEN 0 WHEN 'a2u_created' THEN 1 ELSE 2 END,
               s.updated_at DESC,s.payment_id ASC`,
    [sourceWallet],
  )
  if (!Array.isArray(rows)) return null

  const candidates = rows.map((row) => classify(row as Record<string, unknown>, sourceWallet))
  const submit = candidates.filter((x) => x.classification === "SETTLEMENT_SUBMIT_ENTRY_CANDIDATE")
  const stage1 = candidates.filter((x) => x.classification === "PREPARATION_REQUIRED_STAGE1")
  const moved = candidates.filter((x) => x.classification === "ALREADY_MOVED")
  const blocked = candidates.filter((x) => x.classification === "BLOCKED_REFUND_AUTHORITY" || x.classification === "BLOCKED_CERTIFICATION_HOLD")
  const indeterminate = candidates.filter((x) => x.classification === "INDETERMINATE_INVALID_DURABLE_ROW")
  const nearestTwo = [...submit, ...stage1].slice(0, 2)

  return {
    sourceWallet,
    sameWalletRowCount: candidates.length,
    submitEntryCandidateCount: submit.length,
    stage1PreparationCandidateCount: stage1.length,
    movedCount: moved.length,
    blockedCount: blocked.length,
    indeterminateCount: indeterminate.length,
    provesTwoSubmitEntryCandidates: submit.length >= 2,
    nearestTwo,
    candidates: candidates.slice(0, 25),
  }
}
