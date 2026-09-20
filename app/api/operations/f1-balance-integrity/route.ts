import { NextRequest, NextResponse } from "next/server"

import { query } from "@/lib/db"
import { verifyOwnerAuthorizationHeader } from "@/lib/owner-server-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function safeCount(value: unknown): number | null {
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

export async function GET(request: NextRequest) {
  const auth = await verifyOwnerAuthorizationHeader(request.headers.get("authorization"))
  if (!auth.ok) return NextResponse.json({ error: "Unauthorized" }, { status: auth.status })
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: "PostgreSQL unavailable" }, { status: 503 })

  // F1D diagnostic: SELECT-only. It must never mutate accounting state.
  const mismatchRows = await query(`
    WITH canonical AS (
      SELECT r.merchant_id, COALESCE(SUM(r.merchant_amount), 0) AS canonical_settled
      FROM receipts r
      WHERE r.settlement_status = 'settled_to_merchant'
      GROUP BY r.merchant_id
    ),
    all_merchants AS (
      SELECT merchant_id FROM merchant_balances
      UNION
      SELECT merchant_id FROM canonical
    )
    SELECT m.merchant_id,
           COALESCE(b.settled, 0) AS stored_settled,
           COALESCE(c.canonical_settled, 0) AS canonical_settled,
           COALESCE(b.settled, 0) - COALESCE(c.canonical_settled, 0) AS settled_delta,
           COALESCE(b.unsettled, 0) AS stored_unsettled
    FROM all_merchants m
    LEFT JOIN merchant_balances b ON b.merchant_id = m.merchant_id
    LEFT JOIN canonical c ON c.merchant_id = m.merchant_id
    WHERE COALESCE(b.settled, 0) <> COALESCE(c.canonical_settled, 0)
       OR COALESCE(b.unsettled, 0) <> 0
    ORDER BY m.merchant_id
  `)

  const duplicatePayments = await query(`
    SELECT payment_id, COUNT(*) AS duplicate_count
    FROM transactions
    GROUP BY payment_id
    HAVING COUNT(*) > 1
    ORDER BY payment_id
  `)

  const duplicateReceipts = await query(`
    SELECT transaction_id, COUNT(*) AS duplicate_count
    FROM receipts
    GROUP BY transaction_id
    HAVING COUNT(*) > 1
    ORDER BY transaction_id
  `)

  const constraints = await query(`
    SELECT conrelid::regclass::text AS table_name,
           conname,
           contype,
           pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid IN (
      'transactions'::regclass,
      'receipts'::regclass,
      'merchant_balances'::regclass
    )
    ORDER BY conrelid::regclass::text, conname
  `)

  const totals = await query(`
    SELECT
      (SELECT COUNT(*) FROM merchant_balances) AS merchant_balance_rows,
      (SELECT COUNT(*) FROM transactions) AS transaction_rows,
      (SELECT COUNT(*) FROM receipts) AS receipt_rows,
      (SELECT COUNT(*) FROM receipts WHERE settlement_status = 'settled_to_merchant') AS settled_receipt_rows
  `)

  if (![mismatchRows, duplicatePayments, duplicateReceipts, constraints, totals].every(Array.isArray)) {
    return NextResponse.json({ error: "F1 balance integrity diagnostic indeterminate" }, { status: 503, headers: { "Cache-Control": "no-store" } })
  }

  const totalRow = totals![0]
  if (!totalRow || typeof totalRow !== "object") {
    return NextResponse.json({ error: "F1 balance integrity totals indeterminate" }, { status: 503, headers: { "Cache-Control": "no-store" } })
  }
  const t = totalRow as Record<string, unknown>
  const counts = {
    merchantBalanceRows: safeCount(t.merchant_balance_rows),
    transactionRows: safeCount(t.transaction_rows),
    receiptRows: safeCount(t.receipt_rows),
    settledReceiptRows: safeCount(t.settled_receipt_rows),
  }
  if (Object.values(counts).some((v) => v === null)) {
    return NextResponse.json({ error: "F1 balance integrity counts invalid" }, { status: 503, headers: { "Cache-Control": "no-store" } })
  }

  return NextResponse.json({
    diagnostic: "F1_BALANCE_INTEGRITY_READ_ONLY",
    readOnly: true,
    asOf: new Date().toISOString(),
    counts,
    mismatchCount: mismatchRows!.length,
    duplicatePaymentIdCount: duplicatePayments!.length,
    duplicateReceiptTransactionIdCount: duplicateReceipts!.length,
    mismatches: mismatchRows,
    duplicatePayments,
    duplicateReceipts,
    constraints,
  }, { headers: { "Cache-Control": "no-store" } })
}
