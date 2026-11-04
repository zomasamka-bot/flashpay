import { timingSafeEqual } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

// The cutover was sampled on the production database. Neither QStash nor an
// event caller can move the boundary. The four holds are defense in depth.
const cutover = "2026-11-04T10:28:42.166721Z"
const historicalHolds = [
  "7cad03c1a69a025362c64bf87079ed7397fcb6bfdd42b22341aef24bdaeb81b2",
  "ee15246aef237459dc61c9fbb495123d0a7dfccec0560c4087e62841c406d1be",
  "f8f2a12f2f46ace8844ba5f804b1ebcb35739bac4ab23b73425cc6814e259b7d",
  "f0f9e1d0836977dcb258ef3d2f8e49e2e59de695b92c06e1a34c105e32383e88",
]

function matches(expected: string | undefined, supplied: string | null) {
  if (!expected || !supplied) return false
  const a = Buffer.from(expected), b = Buffer.from(supplied)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function observe(request: NextRequest) {
  const url = new URL(request.url)
  const subjects = url.searchParams.getAll("paymentId")
  const id = subjects[0]
  if ([...url.searchParams.keys()].some(k => k !== "paymentId") || subjects.length > 1 ||
      (id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))) {
    return NextResponse.json({ error: "Invalid recovery scope" }, { status: 400 })
  }
  // Read all new intents on periodic wake. A retry or a fresh process starts
  // from durable state without a mutable cursor, clearing keys, or dispatching.
  const rows = await query(`
    WITH scoped AS (
      SELECT i.payment_id, i.merchant_id, i.merchant_uid, i.customer_amount
      FROM public.payment_create_intents i
      WHERE i.created_at > $1::timestamptz AND i.created_at <= statement_timestamp()
        AND ($2::text IS NULL OR i.payment_id = $2)
        AND encode(sha256(convert_to(i.payment_id,'UTF8')),'hex') <> ALL($3::text[])
    ), classified AS (
      SELECT CASE
        WHEN c.payment_id IS NULL OR c.merchant_id IS DISTINCT FROM i.merchant_id OR c.merchant_uid IS DISTINCT FROM i.merchant_uid
          OR c.customer_amount IS DISTINCT FROM i.customer_amount OR c.merchant_amount IS DISTINCT FROM i.customer_amount OR c.app_commission IS DISTINCT FROM 0
          OR i.customer_amount <= 0 OR (r.payment_id IS NOT NULL AND r.amount <> i.customer_amount)
          THEN 'held'
        WHEN r.status = 'manual_review_required' OR r.stage = 'wallet_submission_started'
          OR EXISTS (SELECT 1 FROM public.financial_wallet_submission_attempts a WHERE a.owner_payment_id=i.payment_id)
          THEN 'held'
        WHEN r.payment_id IS NOT NULL AND c.stage <> 'payment_identity' THEN 'held'
        WHEN c.stage='db_finalized' OR r.status='completed' THEN 'terminal_checkpoint'
        ELSE 'pending'
      END AS state
      FROM scoped i LEFT JOIN public.settlement_checkpoints c USING (payment_id)
      LEFT JOIN public.refund_checkpoints r USING (payment_id)
    )
    SELECT current_setting('neon.branch_id',true) AS branch,
      count(*) FILTER (WHERE state='held')::int AS held,
      count(*) FILTER (WHERE state='pending')::int AS pending,
      count(*) FILTER (WHERE state='terminal_checkpoint')::int AS terminal
    FROM classified`, [cutover, id ?? null, historicalHolds])
  const counts = rows?.[0] as {branch?: string; held?: number; pending?: number; terminal?: number} | undefined
  if (rows?.length !== 1 || counts?.branch !== "br-tiny-mode-aliatv40" ||
      ![counts.held, counts.pending, counts.terminal].every(n => Number.isSafeInteger(n) && Number(n) >= 0)) {
    return NextResponse.json({ error: "Recovery observation unavailable" }, { status: 503 })
  }
  const result = { mode: "observe_only", scope: id ? "one" : "since_cutover", held: counts.held,
    pending: counts.pending, terminalCheckpoints: counts.terminal, financialDispatch: false }
  console.info("[Recovery new intents]", result)
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } })
}

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization")
  if (!auth?.startsWith("Bearer ") || !matches(process.env.CRON_SECRET, auth.slice(7)))
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  return observe(request)
}

export async function POST(request: NextRequest) {
  if (!matches(process.env.FLASHPAY_TRANSIENT_RECOVERY_SECRET, request.headers.get("x-flashpay-transient-recovery-secret")))
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  return observe(request)
}
