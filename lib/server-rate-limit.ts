import "server-only"

import { createHash } from "crypto"
import { redis, isRedisConfigured } from "@/lib/redis"

export type FinancialRateLimitResult =
  | { outcome: "ALLOWED"; remaining: number }
  | { outcome: "LIMITED"; retryAfterSeconds: number }
  | { outcome: "UNAVAILABLE" }

type RateLimitInput = {
  namespace: "payments-create" | "pi-approve" | "pi-complete"
  subject: string
  limit: number
  windowSeconds: number
}

function opaqueSubject(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

/**
 * Abuse control only. This is never financial authority and never changes a
 * payment, checkpoint, queue, accounting row, Pi payment, or Horizon movement.
 * Redis uncertainty is explicit so each caller can choose the safe lifecycle
 * behavior instead of accidentally turning limiter availability into money truth.
 */
export async function consumeFinancialRateLimit(input: RateLimitInput): Promise<FinancialRateLimitResult> {
  if (!isRedisConfigured) return { outcome: "UNAVAILABLE" }
  const subject = input.subject.trim()
  if (!subject || !Number.isSafeInteger(input.limit) || input.limit < 1 || !Number.isSafeInteger(input.windowSeconds) || input.windowSeconds < 1) {
    return { outcome: "UNAVAILABLE" }
  }

  const bucket = Math.floor(Date.now() / (input.windowSeconds * 1000))
  const key = `flashpay:ratelimit:${input.namespace}:v1:${opaqueSubject(subject)}:${bucket}`
  try {
    const raw = await redis.eval<[string], number>(`
      local n=redis.call('INCR',KEYS[1])
      if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end
      return n
    `, [key], [String(input.windowSeconds + 2)])
    const count = Number(raw)
    if (!Number.isSafeInteger(count) || count < 1) return { outcome: "UNAVAILABLE" }
    if (count > input.limit) {
      const ttlRaw = await redis.ttl(key)
      const ttl = Number(ttlRaw)
      return { outcome: "LIMITED", retryAfterSeconds: Number.isSafeInteger(ttl) && ttl > 0 ? ttl : input.windowSeconds }
    }
    return { outcome: "ALLOWED", remaining: Math.max(0, input.limit - count) }
  } catch (error) {
    console.warn("[R101-8 RATE LIMIT] unavailable", { namespace: input.namespace, error: error instanceof Error ? error.message : String(error) })
    return { outcome: "UNAVAILABLE" }
  }
}
