import { redis, isRedisConfigured } from './redis'
import type { Payment } from './types'

export type PaymentProjectionCasResult =
  | { outcome: 'UPDATED'; payment: Payment }
  | { outcome: 'CONFLICT'; current: Payment | null }
  | { outcome: 'MISSING' | 'INVALID' | 'UNAVAILABLE' }

export function paymentProjectionVersion(payment: Pick<Payment, 'redisProjectionVersion'>): number | null {
  const value = payment.redisProjectionVersion
  if (value === undefined) return 0
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function parsePayment(value: unknown): Payment | null {
  if (!value) return null
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Payment : null
  } catch {
    return null
  }
}

/**
 * F2-6: optimistic fencing for the Redis Payment projection.
 * Every mutation must advance redisProjectionVersion. A stale writer that read
 * an older version cannot overwrite a newer projection. Missing legacy version
 * is treated as version 0 exactly once for backwards-compatible adoption.
 */
export async function compareAndSwapPaymentProjection(
  paymentId: string,
  expected: Payment,
  next: Payment,
): Promise<PaymentProjectionCasResult> {
  if (!isRedisConfigured) return { outcome: 'UNAVAILABLE' }
  if (!paymentId || expected.id !== paymentId || next.id !== paymentId) return { outcome: 'INVALID' }
  const expectedVersion = paymentProjectionVersion(expected)
  if (expectedVersion === null || expectedVersion >= Number.MAX_SAFE_INTEGER) return { outcome: 'INVALID' }
  const nextVersion = expectedVersion + 1
  const encoded = JSON.stringify({ ...next, redisProjectionVersion: nextVersion })

  let result: number
  try {
    result = Number(await redis.eval<[string, string, string], number>(`
local raw=redis.call('GET',KEYS[1]); if not raw then return -1 end
local ok,current=pcall(cjson.decode,raw); if not ok or type(current)~='table' then return -2 end
if current.id~=ARGV[1] then return -2 end
local expected=tonumber(ARGV[2]); if not expected or expected<0 or expected~=math.floor(expected) then return -2 end
local version=current.redisProjectionVersion
if version==nil then version=0 end
if type(version)~='number' or version<0 or version~=math.floor(version) then return -2 end
if version~=expected then return 0 end
local nextOk,next=pcall(cjson.decode,ARGV[3]); if not nextOk or type(next)~='table' then return -2 end
if next.id~=ARGV[1] or next.redisProjectionVersion~=expected+1 then return -2 end
redis.call('SET',KEYS[1],ARGV[3]); return 1
`, [`payment:${paymentId}`], [paymentId, String(expectedVersion), encoded]))
  } catch {
    return { outcome: 'UNAVAILABLE' }
  }

  if (result === 1) {
    const readBack = parsePayment(await redis.get(`payment:${paymentId}`))
    if (!readBack || readBack.id !== paymentId || readBack.redisProjectionVersion !== nextVersion) return { outcome: 'INVALID' }
    return { outcome: 'UPDATED', payment: readBack }
  }
  if (result === 0) return { outcome: 'CONFLICT', current: parsePayment(await redis.get(`payment:${paymentId}`)) }
  if (result === -1) return { outcome: 'MISSING' }
  return { outcome: 'INVALID' }
}
