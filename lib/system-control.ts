/**
 * System control state manager.
 * Manages kill switch and app-wide operational state in Redis.
 * This is the single source of truth for system control.
 */

import { redis, isRedisConfigured } from "./redis"

export interface SystemState {
  killSwitchEnabled: boolean
  maintenanceMessage: string
  lastToggleTime: number
  toggledBy?: string
}

const SYSTEM_STATE_KEY = "flashpay:system:state"

const DEFAULT_STATE: SystemState = {
  killSwitchEnabled: false,
  maintenanceMessage: "Maintenance in progress. Please try again later.",
  lastToggleTime: Date.now(),
}

/**
 * Get the current system state from Redis.
 * If Redis is not configured, defaults are used (app is always active).
 */
export async function getSystemState(): Promise<SystemState> {
  if (!isRedisConfigured) {
    return DEFAULT_STATE
  }

  try {
    const state = await redis.get<SystemState>(SYSTEM_STATE_KEY)
    return state || DEFAULT_STATE
  } catch (error) {
    console.error("[System Control] Failed to fetch system state:", error)
    return DEFAULT_STATE
  }
}

/**
 * Check if the app is currently active (kill switch is OFF).
 */
export async function isAppActive(): Promise<boolean> {
  const state = await getSystemState()
  return !state.killSwitchEnabled
}

/**
 * Toggle the kill switch ON (disable app).
 */
export async function enableKillSwitch(message?: string): Promise<SystemState> {
  if (!isRedisConfigured) {
    console.error("[System Control] Redis not configured, cannot enable kill switch")
    return DEFAULT_STATE
  }

  const newState: SystemState = {
    killSwitchEnabled: true,
    maintenanceMessage: message || DEFAULT_STATE.maintenanceMessage,
    lastToggleTime: Date.now(),
  }

  try {
    await redis.set(SYSTEM_STATE_KEY, newState, { ex: 86400 }) // 24 hour expiry for safety
    console.log("[System Control] Kill switch ENABLED")
    return newState
  } catch (error) {
    console.error("[System Control] Failed to enable kill switch:", error)
    throw error
  }
}

/**
 * Toggle the kill switch OFF (enable app).
 */
export async function disableKillSwitch(): Promise<SystemState> {
  if (!isRedisConfigured) {
    console.error("[System Control] Redis not configured, cannot disable kill switch")
    return DEFAULT_STATE
  }

  const newState: SystemState = {
    killSwitchEnabled: false,
    maintenanceMessage: "",
    lastToggleTime: Date.now(),
  }

  try {
    await redis.set(SYSTEM_STATE_KEY, newState)
    console.log("[System Control] Kill switch DISABLED")
    return newState
  } catch (error) {
    console.error("[System Control] Failed to disable kill switch:", error)
    throw error
  }
}

/**
 * Force reset the system state (emergency only).
 */
export async function resetSystemState(): Promise<SystemState> {
  if (!isRedisConfigured) {
    return DEFAULT_STATE
  }

  try {
    await redis.del(SYSTEM_STATE_KEY)
    console.log("[System Control] System state RESET to default")
    return DEFAULT_STATE
  } catch (error) {
    console.error("[System Control] Failed to reset system state:", error)
    throw error
  }
}
