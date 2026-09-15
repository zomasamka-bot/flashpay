import { NextRequest, NextResponse } from "next/server"

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
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

export async function GET(request: NextRequest) {
  const auth = await verifyOwnerAuthorizationHeader(request.headers.get("authorization"))
  if (!auth.ok) return NextResponse.json({ error: "Unauthorized" }, { status: auth.status })

  const asOf = new Date().toISOString()
  let postgres: Record<string, number> | null = null
  if (process.env.DATABASE_URL) {
    const rows = await query(`SELECT
      COUNT(*) FILTER (WHERE settlement_status='settled_to_merchant') AS settled,
      COUNT(*) FILTER (WHERE settlement_status IN ('pending','paid_to_app','settlement_pending')) AS settlement_open,
      COUNT(*) FILTER (WHERE settlement_status='settlement_failed') AS settlement_failed
      FROM receipts`)
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
      const activeCount = count(active), readyCount = count(ready)
      if (activeCount !== null && readyCount !== null) {
        const until = typeof backpressure === "string" && /^[0-9]+$/.test(backpressure) ? Number(backpressure) : 0
        recovery = { active: activeCount, ready: readyCount, drainLeaseActive: Number(lease) === 1, piCreateBackpressureActive: Number.isSafeInteger(until) && until > Date.now() }
      }
    } catch {}
  }

  const available = postgres !== null && recovery !== null
  return NextResponse.json(
    { available, asOf, postgres, recovery, source: { postgres: postgres !== null, redis: recovery !== null } },
    { status: available ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  )
}
