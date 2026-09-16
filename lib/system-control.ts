/**
 * System control state manager.
 * Operational control only; never a financial authority.
 */

import { redis, isRedisConfigured } from "./redis"

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

async function nextRevision(expectedRevision?: number): Promise<number> {
  const current = await readSystemState()
  if (!current.ok) throw new Error(`System control state unavailable: ${current.reason}`)
  if (expectedRevision !== undefined && current.state.revision !== expectedRevision) {
    throw new Error("Stale system control revision")
  }
  return current.state.revision + 1
}

export async function isAppActive(): Promise<boolean> {
  const result = await readSystemState()
  // M3 does not wire this into payment/app availability. Unknown control state is
  // therefore reported as inactive to control callers only, never as financial truth.
  return result.ok ? !result.state.killSwitchEnabled : false
}

export async function enableKillSwitch(message?: string, toggledBy?: string, expectedRevision?: number): Promise<SystemState> {
  if (!isRedisConfigured) throw new Error("System control Redis is not configured")
  const now = Date.now()
  const newState: SystemState = {
    version: 1,
    revision: await nextRevision(expectedRevision),
    killSwitchEnabled: true,
    maintenanceMessage: message || defaultState(now).maintenanceMessage,
    lastToggleTime: now,
    toggledBy,
    expiresAt: now + KILL_SWITCH_TTL_SECONDS * 1000,
  }
  await redis.set(SYSTEM_STATE_KEY, JSON.stringify(newState), { ex: KILL_SWITCH_TTL_SECONDS })
  console.log("[System Control] Kill switch ENABLED")
  return newState
}

export async function disableKillSwitch(toggledBy?: string, expectedRevision?: number): Promise<SystemState> {
  if (!isRedisConfigured) throw new Error("System control Redis is not configured")
  const newState: SystemState = {
    version: 1,
    revision: await nextRevision(expectedRevision),
    killSwitchEnabled: false,
    maintenanceMessage: "",
    lastToggleTime: Date.now(),
    toggledBy,
    expiresAt: null,
  }
  await redis.set(SYSTEM_STATE_KEY, JSON.stringify(newState))
  console.log("[System Control] Kill switch DISABLED")
  return newState
}

export async function resetSystemState(toggledBy?: string, expectedRevision?: number): Promise<SystemState> {
  if (!isRedisConfigured) throw new Error("System control Redis is not configured")
  const newState: SystemState = {
    ...defaultState(),
    revision: await nextRevision(expectedRevision),
    toggledBy,
  }
  await redis.set(SYSTEM_STATE_KEY, JSON.stringify(newState))
  console.log("[System Control] Control state RESET to default")
  return newState
}
