/**
 * ============================================================================
 * FLASHPAY UNIFIED OPERATIONAL CORE
 * ============================================================================
 *
 * This file defines and LOCKS the unified system architecture for FlashPay.
 *
 * MANDATORY RULES:
 * ----------------
 * 1. ALL pages must use ONLY the unified hooks (usePayments, usePayment, usePaymentStats)
 * 2. ALL operations must go through the operations layer (createPayment, executePayment, etc.)
 * 3. NO page-level state for payments data
 * 4. NO duplicated logic
 * 5. NO direct store access from pages
 * 6. ALL navigation must use the unified router (ROUTES, getPaymentLink)
 *
 * SYSTEM COMPONENTS:
 * ------------------
 * - lib/payments-store.ts   → Single source of truth for payment data
 * - lib/operations.ts       → Operational control layer
 * - lib/use-payments.ts     → React hooks for real-time sync
 * - lib/router.ts           → Unified navigation system
 * - lib/pi-sdk.ts           → Pi Wallet integration
 * - lib/types.ts            → Shared type definitions
 *
 * PAGE BINDINGS (LOCKED):
 * -----------------------
 * app/page.tsx              → usePaymentStats() for dashboard
 * app/create/page.tsx       → createPayment() to generate requests
 * app/pay/payment-content.tsx → usePayment(id), executePayment() for public page
 * app/payments/page.tsx     → usePayments() for list view
 * app/profile/page.tsx      → usePaymentStats() for statistics
 *
 * OPERATIONAL GUARANTEES:
 * -----------------------
 * ✓ Single persistent store with localStorage
 * ✓ Real-time synchronization across all pages
 * ✓ Duplicate payment prevention
 * ✓ Double payment blocking
 * ✓ Invalid route handling with 404
 * ✓ Atomic status updates
 * ✓ Unified error handling
 * ✓ Comprehensive logging
 *
 * STATUS: LOCKED 🔒
 * -----------------
 * This architecture is finalized and should not be modified without
 * understanding the full system impact.
 */

export const CORE_VERSION = "1.0.0"
export const CORE_STATUS = "LOCKED" as const

export const CORE_FEATURES = {
  UNIFIED_STORE: true,
  UNIFIED_OPERATIONS: true,
  UNIFIED_ROUTER: true,
  DOMAIN_MANAGEMENT: true,
} as const

/**
 * Validates that the unified system is properly initialized
 */
export function validateCoreSystem(): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []

  // Check if running in browser
  if (typeof window === "undefined") {
    return { valid: true, errors: [] }
  }

  // Check localStorage availability
  try {
    localStorage.setItem("flashpay_test", "test")
    localStorage.removeItem("flashpay_test")
  } catch {
    errors.push("localStorage not available")
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Core event logger
 * Provides unified logging for all operational events
 */
interface LogEntry {
  timestamp: Date
  level: "info" | "warn" | "error" | "operation" | "sync" | "guard"
  message: string
  details?: any
}

export class CoreLogger {
  private static prefix = "[FlashPay Core]"
  private static logs: LogEntry[] = []
  private static maxLogs = 100

  private static addLog(level: LogEntry["level"], message: string, details?: any) {
    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      message,
      details,
    }

    this.logs.push(entry)

    // Keep only the latest maxLogs entries
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs)
    }
  }

  static info(message: string, ...args: any[]) {
    console.log(`${this.prefix} ${message}`, ...args)
    this.addLog("info", message, args.length > 0 ? args : undefined)
  }

  static warn(message: string, ...args: any[]) {
    console.warn(`${this.prefix} ${message}`, ...args)
    this.addLog("warn", message, args.length > 0 ? args : undefined)
  }

  static error(message: string, ...args: any[]) {
    console.error(`${this.prefix} ${message}`, ...args)
    this.addLog("error", message, args.length > 0 ? args : undefined)
  }

  static operation(operation: string, details?: any) {
    console.log(`${this.prefix} [OPERATION] ${operation}`, details || "")
    this.addLog("operation", operation, details)
  }

  static sync(message: string) {
    console.log(`${this.prefix} [SYNC] ${message}`)
    this.addLog("sync", message)
  }

  static guard(message: string, blocked: boolean) {
    if (blocked) {
      console.warn(`${this.prefix} [GUARD] 🛑 BLOCKED: ${message}`)
      this.addLog("guard", `BLOCKED: ${message}`)
    } else {
      console.log(`${this.prefix} [GUARD] ✓ PASSED: ${message}`)
      this.addLog("guard", `PASSED: ${message}`)
    }
  }

  static getLogs(limit = 50): LogEntry[] {
    return this.logs.slice(-limit).reverse()
  }

  static clearLogs() {
    this.logs = []
    console.log(`${this.prefix} Logs cleared`)
  }
}

/**
 * System health check
 */
export function getSystemHealth() {
  const validation = validateCoreSystem()

  return {
    version: CORE_VERSION,
    status: CORE_STATUS,
    valid: validation.valid,
    errors: validation.errors,
    timestamp: new Date().toISOString(),
  }
}
