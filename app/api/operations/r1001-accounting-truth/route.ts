import { NextRequest, NextResponse } from "next/server"

import { query } from "@/lib/db"
import { verifyOwnerAuthorizationHeader } from "@/lib/owner-server-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Rows = Record<string, unknown>[]

function rows(value: unknown): Rows | null {
  return Array.isArray(value) && value.every((row) => typeof row === "object" && row !== null && !Array.isArray(row))
    ? value as Rows
    : null
}

export async function GET(request: NextRequest) {
  const auth = await verifyOwnerAuthorizationHeader(request.headers.get("authorization"))
  if (!auth.ok) return NextResponse.json({ error: "Unauthorized" }, { status: auth.status })
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: "PostgreSQL unavailable" }, { status: 503 })

  // R100-1: production accounting truth. SELECT-only evidence; never repairs,
  // migrates, queues, retries, or authorizes any financial movement.
  const [constraintsRaw, uniqueIndexesRaw, duplicatesRaw, balanceMismatchesRaw, refundAccountingDuplicatesRaw, totalsRaw] = await Promise.all([
    query(`
      SELECT conrelid::regclass::text AS table_name, conname, contype,
             pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid IN (
        'transactions'::regclass, 'receipts'::regclass, 'merchant_balances'::regclass,
        'settlement_checkpoints'::regclass, 'refund_checkpoints'::regclass,
        'refund_accounting_records'::regclass
      )
      ORDER BY conrelid::regclass::text, conname
    `),
    query(`
      SELECT schemaname, tablename, indexname, indexdef
      FROM pg_indexes
      WHERE schemaname='public'
        AND tablename IN ('transactions','receipts','merchant_balances','settlement_checkpoints','refund_checkpoints','refund_accounting_records')
        AND indexdef ILIKE '%UNIQUE%'
      ORDER BY tablename, indexname
    `),
    query(`
      SELECT 'transactions.payment_id' AS identity, payment_id AS value, COUNT(*)::bigint AS duplicate_count
      FROM transactions GROUP BY payment_id HAVING COUNT(*) > 1
      UNION ALL
      SELECT 'receipts.transaction_id', transaction_id::text, COUNT(*)::bigint
      FROM receipts GROUP BY transaction_id HAVING COUNT(*) > 1
      UNION ALL
      SELECT 'receipts.u2a_identifier', u2a_identifier, COUNT(*)::bigint
      FROM receipts WHERE u2a_identifier IS NOT NULL GROUP BY u2a_identifier HAVING COUNT(*) > 1
      UNION ALL
      SELECT 'receipts.u2a_txid', u2a_txid, COUNT(*)::bigint
      FROM receipts WHERE u2a_txid IS NOT NULL GROUP BY u2a_txid HAVING COUNT(*) > 1
      UNION ALL
      SELECT 'receipts.a2u_identifier', a2u_identifier, COUNT(*)::bigint
      FROM receipts WHERE a2u_identifier IS NOT NULL GROUP BY a2u_identifier HAVING COUNT(*) > 1
      UNION ALL
      SELECT 'receipts.a2u_txid', a2u_txid, COUNT(*)::bigint
      FROM receipts WHERE a2u_txid IS NOT NULL GROUP BY a2u_txid HAVING COUNT(*) > 1
      UNION ALL
      SELECT 'settlement_checkpoints.a2u_payment_id', a2u_payment_id, COUNT(*)::bigint
      FROM settlement_checkpoints WHERE a2u_payment_id IS NOT NULL GROUP BY a2u_payment_id HAVING COUNT(*) > 1
      UNION ALL
      SELECT 'settlement_checkpoints.prepared_tx_hash', prepared_tx_hash, COUNT(*)::bigint
      FROM settlement_checkpoints WHERE prepared_tx_hash IS NOT NULL GROUP BY prepared_tx_hash HAVING COUNT(*) > 1
      UNION ALL
      SELECT 'settlement_checkpoints.a2u_txid', a2u_txid, COUNT(*)::bigint
      FROM settlement_checkpoints WHERE a2u_txid IS NOT NULL GROUP BY a2u_txid HAVING COUNT(*) > 1
      ORDER BY identity, value
    `),
    query(`
      WITH canonical AS (
        SELECT merchant_id, COALESCE(SUM(merchant_amount),0) AS canonical_settled
        FROM receipts WHERE settlement_status='settled_to_merchant' GROUP BY merchant_id
      ), all_merchants AS (
        SELECT merchant_id FROM merchant_balances UNION SELECT merchant_id FROM canonical
      )
      SELECT m.merchant_id, COALESCE(b.settled,0) AS stored_settled,
             COALESCE(c.canonical_settled,0) AS canonical_settled,
             COALESCE(b.settled,0)-COALESCE(c.canonical_settled,0) AS settled_delta,
             COALESCE(b.unsettled,0) AS stored_unsettled
      FROM all_merchants m
      LEFT JOIN merchant_balances b USING (merchant_id)
      LEFT JOIN canonical c USING (merchant_id)
      WHERE COALESCE(b.settled,0)<>COALESCE(c.canonical_settled,0) OR COALESCE(b.unsettled,0)<>0
      ORDER BY m.merchant_id
    `),
    query(`
      SELECT identity, value, duplicate_count FROM (
        SELECT 'refund_accounting_records.refund_id' AS identity, refund_id AS value, COUNT(*)::bigint AS duplicate_count FROM refund_accounting_records GROUP BY refund_id HAVING COUNT(*)>1
        UNION ALL SELECT 'refund_accounting_records.payment_id', payment_id, COUNT(*)::bigint FROM refund_accounting_records GROUP BY payment_id HAVING COUNT(*)>1
        UNION ALL SELECT 'refund_accounting_records.refund_payment_id', refund_payment_id, COUNT(*)::bigint FROM refund_accounting_records GROUP BY refund_payment_id HAVING COUNT(*)>1
        UNION ALL SELECT 'refund_accounting_records.refund_txid', refund_txid, COUNT(*)::bigint FROM refund_accounting_records GROUP BY refund_txid HAVING COUNT(*)>1
        UNION ALL SELECT 'refund_checkpoints.payment_id', payment_id, COUNT(*)::bigint FROM refund_checkpoints GROUP BY payment_id HAVING COUNT(*)>1
        UNION ALL SELECT 'refund_checkpoints.idempotency_key', idempotency_key, COUNT(*)::bigint FROM refund_checkpoints GROUP BY idempotency_key HAVING COUNT(*)>1
      ) d ORDER BY identity, value
    `),
    query(`
      SELECT
        (SELECT COUNT(*) FROM transactions)::bigint AS transactions,
        (SELECT COUNT(*) FROM receipts)::bigint AS receipts,
        (SELECT COUNT(*) FROM merchant_balances)::bigint AS merchant_balances,
        (SELECT COUNT(*) FROM settlement_checkpoints)::bigint AS settlement_checkpoints,
        (SELECT COUNT(*) FROM refund_checkpoints)::bigint AS refund_checkpoints,
        (SELECT COUNT(*) FROM refund_accounting_records)::bigint AS refund_accounting_records
    `),
  ])

  const constraints = rows(constraintsRaw)
  const uniqueIndexes = rows(uniqueIndexesRaw)
  const duplicates = rows(duplicatesRaw)
  const balanceMismatches = rows(balanceMismatchesRaw)
  const refundAccountingDuplicates = rows(refundAccountingDuplicatesRaw)
  const totals = rows(totalsRaw)

  if (!constraints || !uniqueIndexes || !duplicates || !balanceMismatches || !refundAccountingDuplicates || !totals || totals.length !== 1) {
    console.error("[R100-1 ACCOUNTING TRUTH] INDETERMINATE", { constraints: !!constraints, uniqueIndexes: !!uniqueIndexes, duplicates: !!duplicates, balanceMismatches: !!balanceMismatches, refundAccountingDuplicates: !!refundAccountingDuplicates, totals: !!totals })
    return NextResponse.json({ error: "R100-1 accounting truth indeterminate" }, { status: 503, headers: { "Cache-Control": "no-store" } })
  }

  const evidence = {
    diagnostic: "R100_1_PRODUCTION_ACCOUNTING_TRUTH_READ_ONLY",
    readOnly: true,
    financialMovementExecuted: false,
    asOf: new Date().toISOString(),
    totals: totals[0],
    duplicateIdentityCount: duplicates.length,
    refundDuplicateIdentityCount: refundAccountingDuplicates.length,
    merchantBalanceMismatchCount: balanceMismatches.length,
    duplicates,
    refundAccountingDuplicates,
    balanceMismatches,
    constraints,
    uniqueIndexes,
  }

  // Deliberately emitted to Vercel Runtime Logs so R100-1 can be certified
  // from the owner's authenticated Operations Console without exposing tokens.
  console.warn("[R100-1 ACCOUNTING TRUTH]", JSON.stringify(evidence))
  return NextResponse.json(evidence, { headers: { "Cache-Control": "no-store" } })
}
