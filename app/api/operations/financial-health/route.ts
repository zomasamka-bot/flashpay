import { NextRequest, NextResponse } from "next/server"

import { financialPresentationIntegrityCTE } from "@/lib/financial-presentation-integrity"
import { query } from "@/lib/db"
import { isRedisConfigured, redis } from "@/lib/redis"
import { verifyOwnerAuthorizationHeader } from "@/lib/owner-server-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const ACTIVE_KEY = "flashpay:recovery:active-payments:v1"
const READY_KEY = "flashpay:settlement:ready:v1"
const DRAIN_LEASE_KEY = "flashpay:recovery:transient:drain-lease:v1"
const PI_BACKPRESSURE_KEY = "flashpay:recovery:pi-create-backpressure:v1"

function count(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !/^[0-9]+$/.test(value))) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

export async function GET(request: NextRequest) {
  const auth = await verifyOwnerAuthorizationHeader(request.headers.get("authorization"))
  if (!auth.ok) return NextResponse.json({ error: "Unauthorized" }, { status: auth.status })

  const asOf = new Date().toISOString()
  let postgres: Record<string, number> | null = null
  if (process.env.DATABASE_URL) {
    const rows = await query(`WITH ${financialPresentationIntegrityCTE} SELECT
      COUNT(*) FILTER (WHERE settlement_status='settled_to_merchant') AS settled,
      (SELECT count(*) FROM settlement_checkpoints s WHERE s.stage <> 'db_finalized'
        AND (s.a2u_payment_id IS NOT NULL OR s.u2a_completed_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM refund_checkpoints f WHERE f.payment_id=s.payment_id))
      + COUNT(*) FILTER (WHERE settlement_status IN ('pending','paid_to_app','settlement_pending')
        AND NOT EXISTS (SELECT 1 FROM settlement_checkpoints s WHERE s.u2a_identifier=receipts.u2a_identifier)) AS settlement_open,
      COUNT(*) FILTER (WHERE settlement_status='settlement_failed') AS settlement_failed
      FROM receipts HAVING (SELECT valid FROM presentation_integrity)`, [null])
    const refunds = await query(`SELECT
      COUNT(*) FILTER (WHERE status='pending') AS refund_pending,
      COUNT(*) FILTER (WHERE status='manual_review_required') AS refund_manual_review
      FROM refund_checkpoints`)
    if (Array.isArray(rows) && rows.length === 1 && rows[0] && typeof rows[0] === "object" &&
        Array.isArray(refunds) && refunds.length === 1 && refunds[0] && typeof refunds[0] === "object") {
      const r = rows[0] as Record<string, unknown>
      const f = refunds[0] as Record<string, unknown>
      const values = [count(r.settled), count(r.settlement_open), count(r.settlement_failed), count(f.refund_pending), count(f.refund_manual_review)]
      if (values.every((v) => v !== null)) postgres = {
        settled: values[0]!, settlementOpen: values[1]!, settlementFailed: values[2]!,
        refundPending: values[3]!, refundManualReview: values[4]!,
      }
    }
  }

  let recovery: { active: number; ready: number; drainLeaseActive: boolean; piCreateBackpressureActive: boolean } | null = null
  if (isRedisConfigured) {
    try {
      const [active, ready, lease, backpressure] = await Promise.all([
        redis.scard(ACTIVE_KEY), redis.zcard(READY_KEY), redis.exists(DRAIN_LEASE_KEY), redis.get<unknown>(PI_BACKPRESSURE_KEY),
      ])
      const activeCount = count(active), readyCount = count(ready), leaseCount = count(lease)
      const until = backpressure === null ? 0 : count(backpressure)
      if (activeCount !== null && readyCount !== null && (leaseCount === 0 || leaseCount === 1) && until !== null) {
        recovery = { active: activeCount, ready: readyCount, drainLeaseActive: leaseCount === 1, piCreateBackpressureActive: Number.isSafeInteger(until) && until > Date.now() }
      }
    } catch {}
  }

  const available = postgres !== null && recovery !== null
  return NextResponse.json(
    { available, asOf, postgres, recovery, source: { postgres: postgres !== null, redis: recovery !== null } },
    { status: available ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  )
}
