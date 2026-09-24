/**
 * System control state manager.
 * Operational control only; never a financial authority.
 */

import { redis, isRedisConfigured } from "./redis"
import { createOperationalAuditEvent, OPERATIONAL_AUDIT_KEY, OPERATIONAL_AUDIT_MAX_EVENTS, type OperationalAuditAction } from "./operational-audit"

export interface SystemState {
  version: 1
  revision: number
  killSwitchEnabled: boolean
  maintenanceMessage: string
  lastToggleTime: number
  toggledBy?: string
  expiresAt: number | null
}

export type SystemStateRead =
  | { ok: true; state: SystemState; source: "redis" | "default" }
  | { ok: false; reason: "redis_unavailable" | "invalid_state" }

const SYSTEM_STATE_KEY = "flashpay:system:state"
const KILL_SWITCH_TTL_SECONDS = 86400

function defaultState(now = Date.now()): SystemState {
  return {
    version: 1,
    revision: 0,
    killSwitchEnabled: false,
    maintenanceMessage: "Maintenance in progress. Please try again later.",
    lastToggleTime: now,
    expiresAt: null,
  }
}

function parseState(data: unknown): SystemState | null {
  let parsed: unknown = data
  if (typeof data === "string") {
    try { parsed = JSON.parse(data) } catch { return null }
  }
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>

  // Backward-compatible read of the pre-M3 shape.
  if (
    typeof obj.killSwitchEnabled !== "boolean" ||
    typeof obj.maintenanceMessage !== "string" ||
    typeof obj.lastToggleTime !== "number"
  ) return null

  return {
    version: 1,
    revision: typeof obj.revision === "number" && Number.isSafeInteger(obj.revision) && obj.revision >= 0 ? obj.revision : 0,
    killSwitchEnabled: obj.killSwitchEnabled,
    maintenanceMessage: obj.maintenanceMessage,
    lastToggleTime: obj.lastToggleTime,
    toggledBy: typeof obj.toggledBy === "string" ? obj.toggledBy : undefined,
    expiresAt: typeof obj.expiresAt === "number" ? obj.expiresAt : null,
  }
}

export async function readSystemState(): Promise<SystemStateRead> {
  if (!isRedisConfigured) return { ok: false, reason: "redis_unavailable" }
  try {
    const data = await redis.get(SYSTEM_STATE_KEY)
    if (data === null || data === undefined) return { ok: true, state: defaultState(), source: "default" }
    const state = parseState(data)
    return state ? { ok: true, state, source: "redis" } : { ok: false, reason: "invalid_state" }
  } catch (error) {
    console.error("[System Control] Failed to fetch system state:", error)
    return { ok: false, reason: "redis_unavailable" }
  }
}

export async function getSystemState(): Promise<SystemState> {
  const result = await readSystemState()
  if (!result.ok) throw new Error(`System control state unavailable: ${result.reason}`)
  return result.state
}

export class StaleSystemControlRevisionError extends Error {
  constructor() {
    super("Stale system control revision")
    this.name = "StaleSystemControlRevisionError"
  }
}

const CAS_SYSTEM_STATE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local currentRevision = 0
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok or type(decoded) ~= 'table' then return -2 end
  local revision = decoded['revision']
  if revision ~= nil then
    if type(revision) ~= 'number' or revision < 0 or revision % 1 ~= 0 then return -2 end
    currentRevision = revision
  end
end
local expected = tonumber(ARGV[1])
if currentRevision ~= expected then return 0 end
local ttl = tonumber(ARGV[3])
if ttl and ttl > 0 then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ttl)
else
  redis.call('SET', KEYS[1], ARGV[2])
end
redis.call('LPUSH', KEYS[2], ARGV[4])
redis.call('LTRIM', KEYS[2], 0, tonumber(ARGV[5]) - 1)
return 1
`

async function compareAndSetSystemState(expectedRevision: number, newState: SystemState, auditEvent: string, ttlSeconds = 0): Promise<SystemState> {
  if (!isRedisConfigured) throw new Error("System control Redis is not configured")
  const result = await redis.eval(CAS_SYSTEM_STATE_SCRIPT, [SYSTEM_STATE_KEY, OPERATIONAL_AUDIT_KEY], [String(expectedRevision), JSON.stringify(newState), String(ttlSeconds), auditEvent, String(OPERATIONAL_AUDIT_MAX_EVENTS)])
  if (result === 0) throw new StaleSystemControlRevisionError()
  if (result !== 1) throw new Error("System control state is invalid")
  return newState
}

export async function isAppActive(): Promise<boolean> {
  const result = await readSystemState()
  // M3 does not wire this into payment/app availability. Unknown control state is
  // therefore reported as inactive to control callers only, never as financial truth.
  return result.ok ? !result.state.killSwitchEnabled : false
}

export async function enableKillSwitch(message: string | undefined, toggledBy: string, expectedRevision: number, audit: { requestId: string; reason: string; previousEnabled: boolean }): Promise<SystemState> {
  if (!isRedisConfigured) throw new Error("System control Redis is not configured")
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Valid expected system control revision is required")
  const now = Date.now()
  const newState: SystemState = {
    version: 1,
    revision: expectedRevision + 1,
    killSwitchEnabled: true,
    maintenanceMessage: message || defaultState(now).maintenanceMessage,
    lastToggleTime: now,
    toggledBy,
    expiresAt: now + KILL_SWITCH_TTL_SECONDS * 1000,
  }
  const event = createOperationalAuditEvent({ action: "control.enable", actorUid: toggledBy, requestId: audit.requestId, previousRevision: expectedRevision, resultingRevision: newState.revision, previousEnabled: audit.previousEnabled, resultingEnabled: true, reason: audit.reason })
  const committed = await compareAndSetSystemState(expectedRevision, newState, JSON.stringify(event), KILL_SWITCH_TTL_SECONDS)
  console.log("[System Control] Kill switch ENABLED")
  return committed
}

export async function disableKillSwitch(toggledBy: string, expectedRevision: number, audit: { requestId: string; reason: string; previousEnabled: boolean }): Promise<SystemState> {
  if (!isRedisConfigured) throw new Error("System control Redis is not configured")
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Valid expected system control revision is required")
  const newState: SystemState = {
    version: 1,
    revision: expectedRevision + 1,
    killSwitchEnabled: false,
    maintenanceMessage: "",
    lastToggleTime: Date.now(),
    toggledBy,
    expiresAt: null,
  }
  const event = createOperationalAuditEvent({ action: "control.disable", actorUid: toggledBy, requestId: audit.requestId, previousRevision: expectedRevision, resultingRevision: newState.revision, previousEnabled: audit.previousEnabled, resultingEnabled: false, reason: audit.reason })
  const committed = await compareAndSetSystemState(expectedRevision, newState, JSON.stringify(event))
  console.log("[System Control] Kill switch DISABLED")
  return committed
}

export async function resetSystemState(toggledBy: string, expectedRevision: number, audit: { requestId: string; reason: string; previousEnabled: boolean }): Promise<SystemState> {
  if (!isRedisConfigured) throw new Error("System control Redis is not configured")
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Valid expected system control revision is required")
  const newState: SystemState = {
    ...defaultState(),
    revision: expectedRevision + 1,
    toggledBy,
  }
  const event = createOperationalAuditEvent({ action: "control.reset", actorUid: toggledBy, requestId: audit.requestId, previousRevision: expectedRevision, resultingRevision: newState.revision, previousEnabled: audit.previousEnabled, resultingEnabled: newState.killSwitchEnabled, reason: audit.reason })
  const committed = await compareAndSetSystemState(expectedRevision, newState, JSON.stringify(event))
  console.log("[System Control] Control state RESET to default")
  return committed
}

