import { NextRequest, NextResponse } from "next/server"
import { verifyOwnerAuthorizationHeader } from "@/lib/owner-server-auth"
import { redis, isRedisConfigured } from "@/lib/redis"

const NO_STORE = { "Cache-Control": "no-cache, no-store, must-revalidate" }
const DR10_ENV = "FLASHPAY_DR10_TOTAL_REDIS_LOSS_TEST"
const RECOVERY_SECRET_ENV = "FLASHPAY_TRANSIENT_RECOVERY_SECRET"
const CONFIRM = "TOTAL_REDIS_LOSS"
const CENSUS_CONFIRM = "CENSUS_ONLY"
const DR10_MAINTENANCE_KEY = "flashpay:certification:dr10:maintenance:v1"

function authError(status: 401 | 403 | 500 | 503) {
  return status === 500 ? "Owner verification not configured" :
    status === 503 ? "Owner verification unavailable" : "Unauthorized"
}

export async function POST(request: NextRequest) {
  const auth = await verifyOwnerAuthorizationHeader(request.headers.get("authorization"))
  if (!auth.ok) return NextResponse.json({ error: authError(auth.status) }, { status: auth.status, headers: NO_STORE })

  if (process.env.VERCEL_ENV !== "production" || process.env[DR10_ENV] !== "1") {
    return NextResponse.json({ error: "DR10 live fault injection disabled" }, { status: 403, headers: NO_STORE })
  }
  const recoverySecret = process.env[RECOVERY_SECRET_ENV]
  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL
  if (!recoverySecret || !productionHost || !/^[A-Za-z0-9.-]+$/.test(productionHost)) {
    return NextResponse.json({ error: "DR10 internal authority unavailable" }, { status: 503, headers: NO_STORE })
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const censusOnly=body?.confirmation===CENSUS_CONFIRM
  console.warn("[DR52 DR10 OWNER REQUEST] received", { ownerUid: auth.uid, censusOnly })
  if (!censusOnly && body?.confirmation !== CONFIRM) {
    return NextResponse.json({ error: "Exact DR10 confirmation required" }, { status: 400, headers: NO_STORE })
  }

  const target = new URL("/api/recovery/transient", `https://${productionHost}`)
  target.searchParams.set("mode", censusOnly ? "dr10-keyspace-census" : "dr10-total-redis-loss")
  let maintenanceToken: string | null = null
  if (!censusOnly) {
    if (!isRedisConfigured) return NextResponse.json({ error: "DR10 maintenance authority unavailable" }, { status: 503, headers: NO_STORE })
    maintenanceToken = crypto.randomUUID()
    const armed = await redis.set(DR10_MAINTENANCE_KEY, maintenanceToken, { nx: true, ex: 120 })
    if (armed !== "OK") return NextResponse.json({ error: "DR10 maintenance already active" }, { status: 409, headers: NO_STORE })
  }
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "x-flashpay-transient-recovery-secret": recoverySecret,
        ...(censusOnly ? {} : { "x-flashpay-dr10-confirm": CONFIRM }),
      },
      cache: "no-store",
      redirect: "error",
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      const internalError = payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).error === "string"
        ? (payload as Record<string, unknown>).error as string
        : "DR10 internal error unavailable"
      const safeInternalError = internalError.startsWith("DR10 ") ? internalError : "DR10 internal error unavailable"
      console.error("[DR45 DR10 OWNER TRIGGER] internal injection rejected", { status: response.status, internalError: safeInternalError })
      return NextResponse.json({ error: "DR10 internal injection rejected", status: response.status, internalError: safeInternalError }, { status: 502, headers: NO_STORE })
    }
    console.warn(censusOnly ? "[DR49 DR10 OWNER CENSUS] census accepted" : "[DR45 DR10 OWNER TRIGGER] injection accepted", {
      ownerUid: auth.uid,
      state: payload && typeof payload === "object" ? (payload as Record<string, unknown>).state : undefined,
    })
    return NextResponse.json({ success: true, result: payload }, { status: 200, headers: NO_STORE })
  } catch (error) {
    console.error("[DR45 DR10 OWNER TRIGGER] internal request failed", { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: "DR10 internal request failed" }, { status: 503, headers: NO_STORE })
  } finally {
    if (maintenanceToken) {
      try {
        await redis.eval<[string], number>("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", [DR10_MAINTENANCE_KEY], [maintenanceToken])
      } catch { console.warn("[DR56 DR10 MAINTENANCE] cleanup deferred to TTL") }
    }
  }
}
