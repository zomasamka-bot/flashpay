import { NextResponse } from "next/server"
import { isRedisConfigured, redis } from "@/lib/redis"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const R4E_PREFIX = "flashpay:cert:fin4:r4e:v1:"
const R4T_PREFIX = "flashpay:cert:fin4:r4t:lock-probe:"
const EXACT_KEYS = [
  "flashpay:cert:fin4:r4e:v1:FIN4-20261004-1742-A7B9:events",
  "flashpay:cert:fin4:r4e:v1:FIN4-20261005-1104-A055:events",
  "flashpay:cert:fin4:r4e:v1:FIN4-20261005-1204-90EF:events",
  "flashpay:cert:fin4:r4e:v1:FIN4-20261005-1217-870A:events",
  "flashpay:cert:fin4:r4e:v1:FIN4-20261005-1338-EEA2:events",
  "flashpay:cert:fin4:r4e:v1:FIN4-20261005-1410-A82A:events",
  "flashpay:cert:fin4:r4e:v1:FIN4-20261005-1643-D50D:events",
] as const

const ATOMIC_EXACT_CLEANUP = `
for i = 1, #KEYS do
  if redis.call('EXISTS', KEYS[i]) ~= 1 then return {'ABORT_MISSING', KEYS[i]} end
  local t = redis.call('TYPE', KEYS[i])
  local tn = t
  if type(t) == 'table' then tn = t['ok'] end
  if tn ~= 'list' then return {'ABORT_TYPE', KEYS[i], tostring(tn)} end
end
for i = 1, #KEYS do redis.call('DEL', KEYS[i]) end
return {'DELETED', tostring(#KEYS)}
`

async function scanCount(prefix: string): Promise<number> {
  let cursor = 0
  let count = 0
  do {
    const page = await redis.scan(cursor, { match: `${prefix}*`, count: 200 })
    cursor = Number(page[0])
    count += page[1].length
  } while (cursor !== 0)
  return count
}

export async function POST(request: Request) {
  if (process.env.VERCEL_ENV !== "production" || !isRedisConfigured) return NextResponse.json({ ok: false, reason: "PRODUCTION_REDIS_UNAVAILABLE", mutationExecuted: false }, { status: 503 })
  const body = await request.json().catch(() => null)
  if (body?.action !== "delete-exact-seven-fin4-event-lists") return NextResponse.json({ ok: false, reason: "EXACT_ACTION_REQUIRED", mutationExecuted: false }, { status: 400 })
  try {
    const preflight = await Promise.all(EXACT_KEYS.map(async (key) => ({ key, exists: await redis.exists(key), type: await redis.type(key) })))
    if (preflight.some((item) => item.exists !== 1 || item.type !== "list")) return NextResponse.json({ ok: false, reason: "PREFLIGHT_MISMATCH", preflight, mutationExecuted: false }, { status: 409 })
    const atomic = await redis.eval<[], string[]>(ATOMIC_EXACT_CLEANUP, [...EXACT_KEYS], [])
    const deleted = Array.isArray(atomic) && atomic[0] === "DELETED" && atomic[1] === "7"
    if (!deleted) return NextResponse.json({ ok: false, reason: "ATOMIC_CLEANUP_ABORTED", atomic, mutationExecuted: false }, { status: 409 })
    const [remainingExact, r4ePrefixCount, r4tPrefixCount] = await Promise.all([
      Promise.all(EXACT_KEYS.map(async (key) => ({ key, exists: await redis.exists(key) }))), scanCount(R4E_PREFIX), scanCount(R4T_PREFIX),
    ])
    const exactRemaining = remainingExact.filter((item) => item.exists !== 0)
    const verifiedZero = exactRemaining.length === 0 && r4ePrefixCount === 0 && r4tPrefixCount === 0
    return NextResponse.json({ ok: verifiedZero, action: "step8-exact-seven-fin4-event-lists-cleanup", allowlistCount: EXACT_KEYS.length, atomic, readBack: { exactRemaining, r4ePrefixCount, r4tPrefixCount }, mutationExecuted: true, mutationScope: "EXACT_ALLOWLIST_ONLY", financialAuthorityMutated: false }, { status: verifiedZero ? 200 : 500 })
  } catch (error) {
    return NextResponse.json({ ok: false, reason: "STEP8_CLEANUP_FAILED", error: String(error), mutationScope: "EXACT_ALLOWLIST_ONLY" }, { status: 503 })
  }
}
