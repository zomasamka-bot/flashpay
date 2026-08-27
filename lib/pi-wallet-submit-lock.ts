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
