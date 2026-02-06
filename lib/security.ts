/**
 * ============================================================================
 * UNIFIED SECURITY & OPERATIONAL LAYER
 * ============================================================================
 *
 * Centralizes all security checks, error handling, and operational controls
 * within the unified system.
 *
 * Features:
 * - Safety boundaries (wallet, domain, master toggle checks)
 * - Rate limiting for operations
 * - Input validation
 * - Error tracking with tracking IDs
 * - Compliance flags
 * - Operational monitoring
 */

import { CoreLogger } from "./core"
import { unifiedStore } from "./unified-store"

// ============================================================================
// TYPES
// ============================================================================

export interface SecurityCheck {
  passed: boolean
  reason?: string
  trackingId: string
}

export interface OperationError {
  trackingId: string
  timestamp: Date
  operation: string
  error: string
  details?: any
}

export interface RateLimitConfig {
  maxAttempts: number
  windowMs: number
}

// ============================================================================
// OPERATIONAL FLAGS
// ============================================================================

export const OPERATIONAL_FLAGS = {
  TESTNET_ONLY: true,
  REQUIRE_WALLET: true,
  REQUIRE_DOMAIN_ENABLED: true,
  REQUIRE_MASTER_ENABLED: false, // Master doesn't block flashpay.pi main operations
  ENABLE_RATE_LIMITING: true,
  ENABLE_AUDIT_LOGGING: true,
} as const

// ============================================================================
// TRACKING ID GENERATOR
// ============================================================================

function generateTrackingId(): string {
  return `TRK-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`
}

// ============================================================================
// ERROR TRACKING
// ============================================================================

class ErrorTracker {
  private errors: OperationError[] = []
  private maxErrors = 100

  logError(operation: string, error: string, details?: any): string {
    const trackingId = generateTrackingId()

    const operationError: OperationError = {
      trackingId,
      timestamp: new Date(),
      operation,
      error,
      details,
    }

    this.errors.push(operationError)

    // Keep only latest maxErrors
    if (this.errors.length > this.maxErrors) {
      this.errors = this.errors.slice(-this.maxErrors)
    }

    CoreLogger.error(`[${trackingId}] ${operation}: ${error}`, details)

    return trackingId
  }

  getRecentErrors(limit = 20): OperationError[] {
    return this.errors.slice(-limit).reverse()
  }

  clearErrors() {
    this.errors = []
    CoreLogger.info("Error tracking cleared")
  }

  getErrorById(trackingId: string): OperationError | undefined {
    return this.errors.find((e) => e.trackingId === trackingId)
  }
}

export const errorTracker = new ErrorTracker()

// ============================================================================
// RATE LIMITING
// ============================================================================

class RateLimiter {
  private attempts = new Map<string, number[]>()

  check(key: string, config: RateLimitConfig): { allowed: boolean; remainingAttempts: number } {
    if (!OPERATIONAL_FLAGS.ENABLE_RATE_LIMITING) {
      return { allowed: true, remainingAttempts: config.maxAttempts }
    }

    const now = Date.now()
    const windowStart = now - config.windowMs

    // Get attempts within the window
    const recentAttempts = (this.attempts.get(key) || []).filter((timestamp) => timestamp > windowStart)

    this.attempts.set(key, recentAttempts)

    const allowed = recentAttempts.length < config.maxAttempts

    if (allowed) {
      recentAttempts.push(now)
      this.attempts.set(key, recentAttempts)
    }

    const remainingAttempts = Math.max(0, config.maxAttempts - recentAttempts.length)

    CoreLogger.guard(`Rate limit check for ${key}: ${allowed ? "ALLOWED" : "BLOCKED"}`, !allowed)

    return { allowed, remainingAttempts }
  }

  reset(key: string) {
    this.attempts.delete(key)
    CoreLogger.info(`Rate limit reset for ${key}`)
  }

  resetAll() {
    this.attempts.clear()
    CoreLogger.info("All rate limits reset")
  }
}

export const rateLimiter = new RateLimiter()

// ============================================================================
// INPUT VALIDATION
// ============================================================================

export class InputValidator {
  static validateAmount(amount: number): { valid: boolean; error?: string } {
    if (typeof amount !== "number" || isNaN(amount)) {
      return { valid: false, error: "Amount must be a valid number" }
    }

    if (amount <= 0) {
      return { valid: false, error: "Amount must be greater than zero" }
    }

    if (amount > 1000000) {
      return { valid: false, error: "Amount exceeds maximum limit (1,000,000 Pi)" }
    }

    if (!Number.isFinite(amount)) {
      return { valid: false, error: "Amount must be finite" }
    }

    // Check decimal places (max 7 for Pi)
    const decimalPlaces = (amount.toString().split(".")[1] || "").length
    if (decimalPlaces > 7) {
      return { valid: false, error: "Amount cannot have more than 7 decimal places" }
    }

    return { valid: true }
  }

  static validateNote(note: string): { valid: boolean; error?: string } {
    if (typeof note !== "string") {
      return { valid: false, error: "Note must be a string" }
    }

    if (note.length > 500) {
      return { valid: false, error: "Note cannot exceed 500 characters" }
    }

    return { valid: true }
  }

  static validatePaymentId(id: string): { valid: boolean; error?: string } {
    if (typeof id !== "string" || id.trim().length === 0) {
      return { valid: false, error: "Payment ID is required" }
    }

    if (id.length > 100) {
      return { valid: false, error: "Payment ID is invalid" }
    }

    return { valid: true }
  }
}

// ============================================================================
// SECURITY CHECKS
// ============================================================================

export class SecurityGuard {
  /**
   * Check if wallet is connected (when required)
   */
  static checkWallet(): SecurityCheck {
    const trackingId = generateTrackingId()

    if (!OPERATIONAL_FLAGS.REQUIRE_WALLET) {
      return { passed: true, trackingId }
    }

    const wallet = unifiedStore.getWalletStatus()

    if (!wallet.isPiSDKAvailable) {
      CoreLogger.guard("Wallet check: Pi SDK not available", true)
      return {
        passed: false,
        reason: "Pi Wallet SDK is not available. Please open this app in Pi Browser.",
        trackingId,
      }
    }

    if (!wallet.isConnected) {
      CoreLogger.guard("Wallet check: not connected", true)
      return {
        passed: false,
        reason: "Wallet is not connected. Please connect your Pi Wallet to continue.",
        trackingId,
      }
    }

    CoreLogger.guard("Wallet check", false)
    return { passed: true, trackingId }
  }

  /**
   * Check if domain is enabled for the given route
   */
  static checkDomainAccess(domainId: string): SecurityCheck {
    const trackingId = generateTrackingId()

    if (!OPERATIONAL_FLAGS.REQUIRE_DOMAIN_ENABLED) {
      return { passed: true, trackingId }
    }

    const enabled = unifiedStore.isDomainEnabled(domainId)

    if (!enabled) {
      CoreLogger.guard(`Domain access check for ${domainId}`, true)
      return {
        passed: false,
        reason: `This service (${domainId}) is currently disabled. Please contact support.`,
        trackingId,
      }
    }

    CoreLogger.guard(`Domain access check for ${domainId}`, false)
    return { passed: true, trackingId }
  }

  /**
   * Check if master toggle allows operations
   */
  static checkMasterToggle(): SecurityCheck {
    const trackingId = generateTrackingId()

    if (!OPERATIONAL_FLAGS.REQUIRE_MASTER_ENABLED) {
      return { passed: true, trackingId }
    }

    const masterEnabled = unifiedStore.isMasterEnabled()

    if (!masterEnabled) {
      CoreLogger.guard("Master toggle check", true)
      return {
        passed: false,
        reason: "System maintenance in progress. Please try again later.",
        trackingId,
      }
    }

    CoreLogger.guard("Master toggle check", false)
    return { passed: true, trackingId }
  }

  /**
   * Comprehensive pre-operation check
   */
  static preOperationCheck(operation: string, domainId?: string): SecurityCheck {
    const trackingId = generateTrackingId()

    CoreLogger.operation(`Pre-operation check for: ${operation}`, { trackingId })

    // Check testnet flag
    if (OPERATIONAL_FLAGS.TESTNET_ONLY) {
      CoreLogger.info(`Operation ${operation} running in TESTNET mode`)
    }

    // Check master toggle (if required)
    const masterCheck = this.checkMasterToggle()
    if (!masterCheck.passed) {
      return masterCheck
    }

    // Check domain access (if domain specified)
    if (domainId) {
      const domainCheck = this.checkDomainAccess(domainId)
      if (!domainCheck.passed) {
        return domainCheck
      }
    }

    CoreLogger.guard(`Pre-operation check for ${operation}`, false)
    return { passed: true, trackingId }
  }
}

// ============================================================================
// SYSTEM HEALTH MONITORING
// ============================================================================

export class SystemMonitor {
  static getSystemHealth() {
    const wallet = unifiedStore.getWalletStatus()
    const payments = unifiedStore.getAllPayments()
    const recentErrors = errorTracker.getRecentErrors(10)

    const health = {
      status: recentErrors.length === 0 ? "PASS" : "FAIL",
      timestamp: new Date(),
      checks: {
        walletSDK: wallet.isPiSDKAvailable ? "PASS" : "FAIL",
        storeInitialized: unifiedStore.isInitialized() ? "PASS" : "FAIL",
        paymentsLoaded: payments.length >= 0 ? "PASS" : "FAIL",
        noRecentErrors: recentErrors.length === 0 ? "PASS" : "FAIL",
      },
      metrics: {
        totalPayments: payments.length,
        paidPayments: payments.filter((p) => p.status === "PAID").length,
        recentErrors: recentErrors.length,
        walletConnected: wallet.isConnected,
      },
      recentErrors: recentErrors.slice(0, 5),
    }

    CoreLogger.info("System health check completed", health)
    return health
  }

  static getOperationalStatus() {
    return {
      flags: OPERATIONAL_FLAGS,
      timestamp: new Date(),
      environment: "TESTNET",
      domain: typeof window !== "undefined" ? window.location.hostname : "unknown",
    }
  }
}

// ============================================================================
// AUDIT LOGGING
// ============================================================================

interface AuditEntry {
  trackingId: string
  timestamp: Date
  operation: string
  userId?: string
  details: any
  outcome: "success" | "failure"
}

class AuditLogger {
  private entries: AuditEntry[] = []
  private maxEntries = 200

  log(operation: string, details: any, outcome: "success" | "failure", userId?: string): string {
    if (!OPERATIONAL_FLAGS.ENABLE_AUDIT_LOGGING) {
      return ""
    }

    const trackingId = generateTrackingId()

    const entry: AuditEntry = {
      trackingId,
      timestamp: new Date(),
      operation,
      userId,
      details,
      outcome,
    }

    this.entries.push(entry)

    // Keep only latest entries
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries)
    }

    CoreLogger.operation(`[AUDIT] ${operation} - ${outcome.toUpperCase()}`, {
      trackingId,
      details,
    })

    return trackingId
  }

  getRecentAudits(limit = 50): AuditEntry[] {
    return this.entries.slice(-limit).reverse()
  }

  getAuditById(trackingId: string): AuditEntry | undefined {
    return this.entries.find((e) => e.trackingId === trackingId)
  }

  clearAudits() {
    this.entries = []
    CoreLogger.info("Audit log cleared")
  }
}

export const auditLogger = new AuditLogger()
