import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { verifyOwnerAuthorizationHeader } from "@/lib/owner-server-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Rows = Record<string, unknown>[]
const asRows = (v: unknown): Rows | null =>
  Array.isArray(v) && v.every((r) => typeof r === "object" && r !== null && !Array.isArray(r)) ? v as Rows : null

export async function GET(request: NextRequest) {
  const auth = await verifyOwnerAuthorizationHeader(request.headers.get("authorization"))
  if (!auth.ok) return NextResponse.json({ error: "Unauthorized" }, { status: auth.status })
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: "PostgreSQL unavailable" }, { status: 503 })

  // R100-15: final production financial snapshot. Strictly SELECT-only:
  // no repair, retry, queue mutation, Redis mutation, Pi/Horizon call, or financial movement.
  try {
    const [duplicatesRaw, balancesRaw, overlapsRaw, orphansRaw, refundFinalityRaw, totalsRaw, constraintsRaw] = await Promise.all([
      query(`
        SELECT identity, value, duplicate_count FROM (
          SELECT 'transactions.payment_id' identity, payment_id value, COUNT(*)::bigint duplicate_count FROM transactions GROUP BY payment_id HAVING COUNT(*)>1
          UNION ALL SELECT 'receipts.transaction_id', transaction_id::text, COUNT(*)::bigint FROM receipts GROUP BY transaction_id HAVING COUNT(*)>1
          UNION ALL SELECT 'refund_accounting_records.refund_id', refund_id, COUNT(*)::bigint FROM refund_accounting_records GROUP BY refund_id HAVING COUNT(*)>1
          UNION ALL SELECT 'refund_accounting_records.payment_id', payment_id, COUNT(*)::bigint FROM refund_accounting_records GROUP BY payment_id HAVING COUNT(*)>1
          UNION ALL SELECT 'refund_accounting_records.refund_payment_id', refund_payment_id, COUNT(*)::bigint FROM refund_accounting_records GROUP BY refund_payment_id HAVING COUNT(*)>1
          UNION ALL SELECT 'refund_accounting_records.refund_txid', refund_txid, COUNT(*)::bigint FROM refund_accounting_records GROUP BY refund_txid HAVING COUNT(*)>1
          UNION ALL SELECT 'refund_checkpoints.payment_id', payment_id, COUNT(*)::bigint FROM refund_checkpoints GROUP BY payment_id HAVING COUNT(*)>1
          UNION ALL SELECT 'refund_checkpoints.idempotency_key', idempotency_key, COUNT(*)::bigint FROM refund_checkpoints GROUP BY idempotency_key HAVING COUNT(*)>1
        ) d ORDER BY identity,value
      `),
      query(`
        WITH canonical AS (
          SELECT merchant_id, COALESCE(SUM(merchant_amount),0) canonical_settled
          FROM receipts WHERE settlement_status='settled_to_merchant' GROUP BY merchant_id
        ), merchants AS (
          SELECT merchant_id FROM merchant_balances UNION SELECT merchant_id FROM canonical
        )
        SELECT m.merchant_id, COALESCE(b.settled,0) stored_settled, COALESCE(c.canonical_settled,0) canonical_settled,
               COALESCE(b.settled,0)-COALESCE(c.canonical_settled,0) settled_delta, COALESCE(b.unsettled,0) stored_unsettled
        FROM merchants m LEFT JOIN merchant_balances b USING(merchant_id) LEFT JOIN canonical c USING(merchant_id)
        WHERE COALESCE(b.settled,0)<>COALESCE(c.canonical_settled,0) OR COALESCE(b.unsettled,0)<>0
        ORDER BY m.merchant_id
      `),
      query(`
        SELECT s.payment_id, s.stage settlement_stage, r.refund_id, r.stage refund_stage, r.status refund_status
        FROM settlement_checkpoints s JOIN refund_checkpoints r ON r.payment_id=s.payment_id
        WHERE s.stage IN ('a2u_created','prepared','horizon_confirmed','pi_completed','db_finalized')
          AND r.status<>'manual_review_required'
        ORDER BY s.payment_id
      `),
      query(`
        SELECT kind, id FROM (
          SELECT 'receipt_without_transaction' kind, r.id::text id
          FROM receipts r LEFT JOIN transactions t ON t.id=r.transaction_id WHERE t.id IS NULL
          UNION ALL
          SELECT 'refund_accounting_without_checkpoint', a.refund_id
          FROM refund_accounting_records a LEFT JOIN refund_checkpoints c ON c.refund_id=a.refund_id WHERE c.refund_id IS NULL
          UNION ALL
          SELECT 'completed_refund_without_accounting', c.refund_id
          FROM refund_checkpoints c LEFT JOIN refund_accounting_records a ON a.refund_id=c.refund_id
          WHERE c.stage='audit_recorded' AND c.status='completed' AND a.refund_id IS NULL
        ) x ORDER BY kind,id
      `),
      query(`
        SELECT c.refund_id,c.payment_id,c.refund_payment_id,c.refund_txid,
          (SELECT COUNT(*) FROM refund_audit_events e WHERE e.refund_id=c.refund_id AND e.event_type='refund_completed')::bigint completed_events,
          (SELECT COUNT(*) FROM refund_audit_events e WHERE e.refund_id=c.refund_id AND e.event_type='refund_projection_finalized')::bigint projection_events
        FROM refund_checkpoints c
        WHERE c.stage='audit_recorded' AND c.status='completed'
          AND (
            (SELECT COUNT(*) FROM refund_audit_events e WHERE e.refund_id=c.refund_id AND e.event_type='refund_completed')<>1 OR
            (SELECT COUNT(*) FROM refund_audit_events e WHERE e.refund_id=c.refund_id AND e.event_type='refund_projection_finalized')<>1
          )
        ORDER BY c.refund_id
      `),
      query(`
        SELECT
          (SELECT COUNT(*) FROM transactions)::bigint transactions,
          (SELECT COUNT(*) FROM receipts)::bigint receipts,
          (SELECT COUNT(*) FROM merchant_balances)::bigint merchant_balances,
          (SELECT COUNT(*) FROM settlement_checkpoints)::bigint settlement_checkpoints,
          (SELECT COUNT(*) FROM refund_checkpoints)::bigint refund_checkpoints,
          (SELECT COUNT(*) FROM refund_accounting_records)::bigint refund_accounting_records
      `),
      query(`
        SELECT conrelid::regclass::text table_name, conname, contype, pg_get_constraintdef(oid) definition
        FROM pg_constraint
        WHERE conrelid IN ('transactions'::regclass,'receipts'::regclass,'merchant_balances'::regclass,
          'settlement_checkpoints'::regclass,'refund_checkpoints'::regclass,'refund_accounting_records'::regclass)
        ORDER BY conrelid::regclass::text,conname
      `),
    ])

    const duplicates=asRows(duplicatesRaw), balances=asRows(balancesRaw), overlaps=asRows(overlapsRaw),
      orphans=asRows(orphansRaw), refundFinality=asRows(refundFinalityRaw), totals=asRows(totalsRaw), constraints=asRows(constraintsRaw)
    if(!duplicates||!balances||!overlaps||!orphans||!refundFinality||!totals||totals.length!==1||!constraints)
      return NextResponse.json({error:"R100-15 production financial snapshot indeterminate"},{status:503,headers:{"Cache-Control":"no-store"}})

    const evidence={
      diagnostic:"R100_15_FINAL_PRODUCTION_FINANCIAL_SNAPSHOT_READ_ONLY",readOnly:true,financialMovementExecuted:false,
      asOf:new Date().toISOString(),totals:totals[0],duplicateIdentityCount:duplicates.length,
      merchantBalanceMismatchCount:balances.length,settlementRefundOverlapCount:overlaps.length,
      orphanCount:orphans.length,refundFinalityMismatchCount:refundFinality.length,
      duplicates,balanceMismatches:balances,settlementRefundOverlaps:overlaps,orphans,refundFinalityMismatches:refundFinality,
      constraintCount:constraints.length,constraints
    }
    console.warn("[R100-15 FINANCIAL SNAPSHOT]",JSON.stringify(evidence))
    return NextResponse.json(evidence,{headers:{"Cache-Control":"no-store"}})
  } catch(error) {
    console.error("[R100-15 FINANCIAL SNAPSHOT] INDETERMINATE",error)
    return NextResponse.json({error:"R100-15 production financial snapshot unavailable"},{status:503,headers:{"Cache-Control":"no-store"}})
  }
}
