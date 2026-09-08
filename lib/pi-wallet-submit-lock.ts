import "server-only"

import crypto from "crypto"
import { isRedisConfigured, redis } from "./redis"

const RELEASE_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`

export type PiWalletIntentOwner =
  | { kind: "settlement_claim"; paymentId: string }
  | { kind: "settlement_prepared"; paymentId: string; preparedHash: string; preparedSequence: string }
  | { kind: "refund_claim"; paymentId: string; refundId: string }

const INTENT_KEY_PREFIX = "flashpay:wallet:intent:v1:"
const INTENT_REPLACE_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current == ARGV[1] then
  return redis.call("SET", KEYS[1], ARGV[2]) and 1 or 0
end
return 0
`
const INTENT_RELEASE_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`

function canonicalIntentOwner(owner: unknown): PiWalletIntentOwner | null {
  if (!owner || typeof owner !== "object" || !("kind" in owner) || !("paymentId" in owner) || typeof owner.paymentId !== "string" || !owner.paymentId.trim() || owner.paymentId !== owner.paymentId.trim()) return null
  if (owner.kind === "settlement_claim") return { kind: "settlement_claim", paymentId: owner.paymentId }
  if (owner.kind === "refund_claim" && "refundId" in owner && typeof owner.refundId === "string" && owner.refundId.trim() && owner.refundId === owner.refundId.trim()) return { kind: "refund_claim", paymentId: owner.paymentId, refundId: owner.refundId }
  if (owner.kind === "settlement_prepared" && "preparedHash" in owner && typeof owner.preparedHash === "string" && /^[0-9a-f]{64}$/.test(owner.preparedHash) && "preparedSequence" in owner && typeof owner.preparedSequence === "string" && /^[1-9][0-9]*$/.test(owner.preparedSequence)) return { kind: "settlement_prepared", paymentId: owner.paymentId, preparedHash: owner.preparedHash, preparedSequence: owner.preparedSequence }
  return null
}

function canonicalIntentJson(owner: PiWalletIntentOwner): string {
  return JSON.stringify(owner)
}

function intentKey(sourceAddress: unknown): string | null {
  if (typeof sourceAddress !== "string" || !sourceAddress.trim() || sourceAddress !== sourceAddress.trim()) return null
  return `${INTENT_KEY_PREFIX}${sourceAddress}`
}

export async function readPiWalletIntent(sourceAddress: unknown): Promise<PiWalletIntentOwner | null> {
  if (!isRedisConfigured) return null
  const key = intentKey(sourceAddress)
  if (key === null) return null
  try {
    const stored = await redis.get<unknown>(key)
    if (stored === null) return null
    if (typeof stored !== "string") return null
    const parsed: unknown = JSON.parse(stored)
    const owner = canonicalIntentOwner(parsed)
    if (owner === null || canonicalIntentJson(owner) !== stored) return null
    return owner
  } catch {
    return null
  }
}

export async function claimPiWalletIntent(sourceAddress: unknown, owner: unknown): Promise<boolean> {
  if (!isRedisConfigured) return false
  const key = intentKey(sourceAddress)
  const canonical = canonicalIntentOwner(owner)
  if (key === null || canonical === null) return false
  const expected = canonicalIntentJson(canonical)
  try {
    const stored = await redis.get<unknown>(key)
    if (typeof stored === "string" && stored === expected) return true
    if (stored !== null && (typeof stored !== "string" || canonicalIntentOwner(JSON.parse(stored)) === null)) return false
    if (stored !== null) return false
    return (await redis.set(key, expected, { nx: true })) === "OK"
  } catch {
    return false
  }
}

export async function replacePiWalletIntent(sourceAddress: unknown, expectedOwner: unknown, nextOwner: unknown): Promise<boolean> {
  if (!isRedisConfigured) return false
  const key = intentKey(sourceAddress)
  const expected = canonicalIntentOwner(expectedOwner)
  const next = canonicalIntentOwner(nextOwner)
  if (key === null || expected === null || next === null) return false
  try {
    const result = await redis.eval<[string, string], number>(INTENT_REPLACE_SCRIPT, [key], [canonicalIntentJson(expected), canonicalIntentJson(next)])
    return result === 1
  } catch {
    return false
  }
}

export async function releasePiWalletIntent(sourceAddress: unknown, expectedOwner: unknown): Promise<boolean> {
  if (!isRedisConfigured) return false
  const key = intentKey(sourceAddress)
  const expected = canonicalIntentOwner(expectedOwner)
  if (key === null || expected === null) return false
  try {
    const result = await redis.eval<[string], number>(INTENT_RELEASE_SCRIPT, [key], [canonicalIntentJson(expected)])
    return result === 1
  } catch {
    return false
  }
}

export async function acquirePiWalletSubmitLock(
  sourceAddress: unknown,
): Promise<{ release: () => Promise<void> } | null> {
  if (
    !isRedisConfigured ||
    typeof sourceAddress !== "string" ||
    !sourceAddress.trim() ||
    sourceAddress !== sourceAddress.trim()
  ) {
    return null
  }

  const key = `flashpay:wallet:submit:${sourceAddress}`
  const token = crypto.randomUUID()

  try {
    const acquired = await redis.set(key, token, { nx: true, ex: 600 })
    if (acquired !== "OK") return null
  } catch {
    return null
  }

  let released = false
  return {
    release: async () => {
      if (released) return
      released = true
      try {
        await redis.eval(RELEASE_SCRIPT, [key], [token])
      } catch {
        return
      }
    },
  }
}
