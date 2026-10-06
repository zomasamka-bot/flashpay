import { NextResponse } from "next/server"
import { isRedisConfigured, redis } from "@/lib/redis"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const RUN_ID = "FIN4-20261005-1643-D50D"
const R4E_PREFIX = "flashpay:cert:fin4:r4e:v1:"
const R4T_PREFIX = "flashpay:cert:fin4:r4t:lock-probe:"
const EVENTS_KEY = `${R4E_PREFIX}${RUN_ID}:events`

async function countPrefix(prefix: string): Promise<number> {
  let cursor = 0
  let count = 0
  do {
    const page = await redis.scan(cursor, { match: `${prefix}*`, count: 200 })
    cursor = Number(page[0])
    count += page[1].length
  } while (cursor !== 0)
  return count
}

export async function GET() {
  if (process.env.VERCEL_ENV !== "production" || !isRedisConfigured) {
    return NextResponse.json({ ok: false, reason: "PRODUCTION_REDIS_UNAVAILABLE", mutationExecuted: false }, { status: 503 })
  }
  try {
    const [r4eCount, r4tCount, eventsExists, eventsType, eventsTtl] = await Promise.all([
      countPrefix(R4E_PREFIX),
      countPrefix(R4T_PREFIX),
      redis.exists(EVENTS_KEY),
      redis.type(EVENTS_KEY),
      redis.ttl(EVENTS_KEY),
    ])
    return NextResponse.json({
      ok: true,
      action: "step8-redis-certification-inventory",
      runId: RUN_ID,
      inventory: {
        r4ePrefixCount: r4eCount,
        r4tPrefixCount: r4tCount,
        eventsKey: { exists: eventsExists === 1, type: eventsType, ttlSeconds: eventsTtl },
      },
      reads: ["SCAN", "EXISTS", "TYPE", "TTL"],
      mutationExecuted: false,
      financialAuthorityMutated: false,
    })
  } catch (error) {
    return NextResponse.json({ ok: false, reason: "REDIS_INVENTORY_FAILED", error: String(error), mutationExecuted: false }, { status: 503 })
  }
}
