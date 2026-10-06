import { NextResponse } from "next/server"
import { isRedisConfigured, redis } from "@/lib/redis"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const RUN_ID = "FIN4-20261005-1643-D50D"
const R4E_PREFIX = "flashpay:cert:fin4:r4e:v1:"
const R4T_PREFIX = "flashpay:cert:fin4:r4t:lock-probe:"

type KeyMeta = { key: string; type: string; ttlSeconds: number }

async function inventoryPrefix(prefix: string): Promise<KeyMeta[]> {
  let cursor = 0
  const keys = new Set<string>()
  do {
    const page = await redis.scan(cursor, { match: `${prefix}*`, count: 200 })
    cursor = Number(page[0])
    for (const key of page[1]) keys.add(String(key))
  } while (cursor !== 0)

  const sorted = [...keys].sort()
  return Promise.all(sorted.map(async (key) => ({
    key,
    type: await redis.type(key),
    ttlSeconds: await redis.ttl(key),
  })))
}

export async function GET() {
  if (process.env.VERCEL_ENV !== "production" || !isRedisConfigured) {
    return NextResponse.json({ ok: false, reason: "PRODUCTION_REDIS_UNAVAILABLE", mutationExecuted: false }, { status: 503 })
  }
  try {
    const [r4e, r4t] = await Promise.all([
      inventoryPrefix(R4E_PREFIX),
      inventoryPrefix(R4T_PREFIX),
    ])
    return NextResponse.json({
      ok: true,
      action: "step8-redis-certification-inventory",
      runId: RUN_ID,
      inventory: {
        r4ePrefixCount: r4e.length,
        r4tPrefixCount: r4t.length,
        r4e,
        r4t,
      },
      reads: ["SCAN", "TYPE", "TTL"],
      valuesRead: false,
      mutationExecuted: false,
      financialAuthorityMutated: false,
    })
  } catch (error) {
    return NextResponse.json({ ok: false, reason: "REDIS_INVENTORY_FAILED", error: String(error), mutationExecuted: false }, { status: 503 })
  }
}
