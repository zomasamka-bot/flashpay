import "server-only"

import { redis, isRedisConfigured } from "@/lib/redis"

export interface DomainControlState {
  version: 1
  revision: number
  flashpayEnabled: boolean
  updatedAt: number
  updatedBy?: string
}

export type DomainControlRead =
  | { ok: true; state: DomainControlState; source: "redis" | "default" }
  | { ok: false; reason: "redis_unavailable" | "invalid_state" }

const DOMAIN_CONTROL_KEY = "flashpay:domain:control:v1"

function defaultState(): DomainControlState {
  return { version: 1, revision: 0, flashpayEnabled: true, updatedAt: Date.now() }
}

function parseState(data: unknown): DomainControlState | null {
  let parsed: unknown = data
  if (typeof data === "string") {
    try { parsed = JSON.parse(data) } catch { return null }
  }
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  if (obj.version !== 1 || typeof obj.flashpayEnabled !== "boolean" || typeof obj.updatedAt !== "number") return null
  if (typeof obj.revision !== "number" || !Number.isSafeInteger(obj.revision) || obj.revision < 0) return null
  return {
    version: 1,
    revision: obj.revision,
    flashpayEnabled: obj.flashpayEnabled,
    updatedAt: obj.updatedAt,
    updatedBy: typeof obj.updatedBy === "string" ? obj.updatedBy : undefined,
  }
}

export async function readDomainControlState(): Promise<DomainControlRead> {
  if (!isRedisConfigured) return { ok: false, reason: "redis_unavailable" }
  try {
    const data = await redis.get(DOMAIN_CONTROL_KEY)
    if (data === null || data === undefined) return { ok: true, state: defaultState(), source: "default" }
    const state = parseState(data)
    return state ? { ok: true, state, source: "redis" } : { ok: false, reason: "invalid_state" }
  } catch (error) {
    console.error("[Domain Control] Failed to read domain state:", error)
    return { ok: false, reason: "redis_unavailable" }
  }
}

export class StaleDomainControlRevisionError extends Error {
  constructor() { super("Stale domain control revision"); this.name = "StaleDomainControlRevisionError" }
}

const CAS_DOMAIN_CONTROL_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local currentRevision = 0
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok or type(decoded) ~= 'table' then return -2 end
  local revision = decoded['revision']
  if type(revision) ~= 'number' or revision < 0 or revision % 1 ~= 0 then return -2 end
  currentRevision = revision
end
local expected = tonumber(ARGV[1])
if currentRevision ~= expected then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`

export async function setFlashPayDomainEnabled(enabled: boolean, updatedBy: string, expectedRevision: number): Promise<DomainControlState> {
  if (!isRedisConfigured) throw new Error("Domain control Redis is not configured")
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Valid expected domain revision is required")
  const state: DomainControlState = {
    version: 1,
    revision: expectedRevision + 1,
    flashpayEnabled: enabled,
    updatedAt: Date.now(),
    updatedBy,
  }
  const result = await redis.eval(CAS_DOMAIN_CONTROL_SCRIPT, [DOMAIN_CONTROL_KEY], [String(expectedRevision), JSON.stringify(state)])
  if (result === 0) throw new StaleDomainControlRevisionError()
  if (result !== 1) throw new Error("Domain control state is invalid")
  console.log(`[Domain Control] FlashPay domain ${enabled ? "ENABLED" : "DISABLED"}`)
  return state
}
