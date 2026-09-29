import { timingSafeEqual } from "crypto"
import { NextRequest, NextResponse } from "next/server"
import { neon } from "@neondatabase/serverless"
import { runDr17SharedResourceSafe10k } from "@/lib/dr17-shared-certification.mjs"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

const RELEASE = "DR110"
const EXECUTION_KEY = "dr17-shared-safe-10k-dr110"
const RECOVERY_SECRET_ENV = "FLASHPAY_TRANSIENT_RECOVERY_SECRET"

function constantTimeSecretEqual(expected: string | undefined, provided: string | null): boolean {
  if (!expected || !provided) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function authorized(request: NextRequest): boolean {
  const bearerHeader = request.headers.get("authorization")
  const bearer = bearerHeader?.startsWith("Bearer ") ? bearerHeader.slice(7) : null
  if (constantTimeSecretEqual(process.env.CRON_SECRET, bearer)) return true
  return constantTimeSecretEqual(process.env[RECOVERY_SECRET_ENV], request.headers.get("x-flashpay-transient-recovery-secret"))
}

function sqlClient() {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) throw new Error("DATABASE_URL is required")
  return neon(databaseUrl)
}

export async function GET(request: NextRequest) {
  // Authentication is deliberately before any database access.
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  const sql = sqlClient()
  try {
    const rows = await sql`SELECT execution_key,release,status,started_at,finished_at,report,error_code
      FROM dr17_cert_execution WHERE execution_key=${EXECUTION_KEY} LIMIT 1`
    return NextResponse.json({ release: RELEASE, execution: rows[0] ?? null }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    // GET is read-only: a not-yet-created certification table is represented as no execution.
    const code = error instanceof Error ? error.message : String(error)
    if (/dr17_cert_execution/i.test(code) && /(does not exist|undefined table|relation)/i.test(code)) {
      return NextResponse.json({ release: RELEASE, execution: null }, { headers: { "Cache-Control": "no-store" } })
    }
    throw error
  }
}

export async function POST(request: NextRequest) {
  // Authentication and production boundary are deliberately before any database/Redis access.
  if (!authorized(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  if (process.env.VERCEL_ENV !== "production") return NextResponse.json({ error: "production_only" }, { status: 403 })

  const sql = sqlClient()
  // Keep the Neon query function in its concrete inferred form; no generic helper boundary.
  await sql`CREATE TABLE IF NOT EXISTS dr17_cert_execution (
    execution_key text PRIMARY KEY,
    release text NOT NULL,
    status text NOT NULL CHECK (status IN ('running','passed','failed')),
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    report jsonb,
    error_code text
  )`
  const claimed = await sql`INSERT INTO dr17_cert_execution(execution_key,release,status)
    VALUES(${EXECUTION_KEY},${RELEASE},'running') ON CONFLICT (execution_key) DO NOTHING RETURNING execution_key`
  if (claimed.length !== 1) {
    const existing = await sql`SELECT status,started_at,finished_at,report,error_code FROM dr17_cert_execution WHERE execution_key=${EXECUTION_KEY} LIMIT 1`
    return NextResponse.json({ error: "one_shot_already_claimed", execution: existing[0] ?? null }, { status: 409 })
  }

  try {
    console.log(JSON.stringify({ event: "dr17_dr110_started", release: RELEASE, executionKey: EXECUTION_KEY }))
    const report = await runDr17SharedResourceSafe10k({ trustedProductionExecution: true })
    await sql`UPDATE dr17_cert_execution SET status='passed',finished_at=now(),report=${JSON.stringify(report)}::jsonb WHERE execution_key=${EXECUTION_KEY}`
    console.log(JSON.stringify({ event: "dr17_dr110_completed", ...report }))
    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 180) : "unknown_error"
    await sql`UPDATE dr17_cert_execution SET status='failed',finished_at=now(),error_code=${code} WHERE execution_key=${EXECUTION_KEY}`
    console.error(JSON.stringify({ event: "dr17_dr110_failed", errorCode: code }))
    return NextResponse.json({ certification: "FAIL", gate: "DR17-DR110-EXECUTION-BRIDGE", errorCode: code }, { status: 500 })
  }
}
