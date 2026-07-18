"use client"

/**
 * ============================================================================
 * UNIFIED STATE STORE - SINGLE SOURCE OF TRUTH
 * ============================================================================
 *
 * Consolidates ALL application state into one centralized store:
 * - Payments data (merchant-scoped)
 * - Domain toggles
 * - User/session info
 * - Wallet connection status
 * - UI states
 * - Merchant setup status
 * - Owner-only operational data (hidden from merchants)
 *
 * Features:
 * - Instant in-app synchronization via subscriptions
 * - Cross-tab synchronization via localStorage events
 * - Timestamp-based conflict resolution
 * - Persistent storage with automatic save/load
 * - Centralized error handling
 * - Unified logging
 * - Multi-tenant merchant isolation
 */

import type { Payment, PaymentStatus, MerchantAnalytics, GlobalAnalytics } from "./types"
import { CoreLogger } from "./core"
import { OPERATIONAL_DOMAINS, type Domain } from "./domains"

// ============================================================================
// STATE TYPES
// ============================================================================

export interface UserSession {
  isAuthenticated: boolean
  userId?: string
  username?: string
  lastActivity: Date
  currentMerchantId: string // Added for merchant scoping
}

export interface MerchantState {
  isSetupComplete: boolean
  merchantId: string
  piUsername?: string
  uid?: string // App-specific UID from Pi.authenticate() - must be verified via /v2/me
  accessToken?: string // Used to verify uid with Pi /v2/me endpoint
  verifiedUid?: string // The uid returned by Pi /v2/me - this is the real merchantUid for A2U
  walletAddress?: string
  connectedAt?: Date
}

export interface WalletStatus {
  isConnected: boolean
  isPiSDKAvailable: boolean
  isInitialized: boolean
  lastChecked: Date
}

export interface UIState {
  theme: "light" | "dark"
  sidebarOpen: boolean
  lastVisitedRoute: string
}

export interface DomainState {
  masterEnabled: boolean
  domains: Record<string, boolean>
}

export interface OwnerOnlyState {
  globalAnalytics: GlobalAnalytics
  allMerchantIds: string[]
  systemHealth: {
    lastCheck: Date
    status: "healthy" | "warning" | "critical"
  }
}

export interface UnifiedState {
  // Payments (merchant-scoped)
  payments: Payment[]

  // Domains
  domainState: DomainState

  // Merchant
  merchant: MerchantState

  // User & Session
  session: UserSession

  // Wallet
  wallet: WalletStatus

  // UI
  ui: UIState

  _owner: OwnerOnlyState

  // Metadata
  lastUpdated: number
  version: string
}

// ============================================================================
// DEFAULT STATE
// ============================================================================

function generateMerchantId(): string {
  return `merchant_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

const DEFAULT_STATE: UnifiedState = {
  payments: [],
  domainState: {
    masterEnabled: false,
    domains: Object.fromEntries(OPERATIONAL_DOMAINS.map((d) => [d.id, d.enabled])),
  },
  merchant: {
    isSetupComplete: false,
    merchantId: "",
    piUsername: "",
    uid: "", // Unverified uid from Pi.authenticate()
    accessToken: "", // Used to verify with Pi /v2/me
    verifiedUid: "", // The verified uid returned by Pi /v2/me - use this for A2U
    walletAddress: "",
  },
  session: {
    isAuthenticated: false,
    lastActivity: new Date(),
    currentMerchantId: "", // Set during merchant setup
  },
  wallet: {
    isConnected: false,
    isPiSDKAvailable: typeof window !== "undefined" && !!window.Pi,
    isInitialized: false,
    lastChecked: new Date(),
  },
  ui: {
    theme: "light",
    sidebarOpen: false,
    lastVisitedRoute: "/",
  },
  _owner: {
    globalAnalytics: {
      totalMerchants: 0,
      totalPayments: 0,
      totalVolume: 0,
      activeMerchants: 0,
      merchantAnalytics: [],
    },
    allMerchantIds: [],
    systemHealth: {
      lastCheck: new Date(),
      status: "healthy",
    },
  },
  lastUpdated: Date.now(),
  version: "1.0.0",
}

// ============================================================================
// UNIFIED STORE
// ============================================================================

const STORAGE_KEY = "flashpay_unified_state"
const OWNER_STORAGE_KEY = "flashpay_owner_data"

function getMerchantStorageKey(merchantId: string): string {
  return `flashpay_merchant_${merchantId}_data`
}

const OWNER_SECRET = process.env.NEXT_PUBLIC_OWNER_SECRET || "flashpay_admin_2025"

type StateListener = () => void
type StateSection = keyof Omit<UnifiedState, "lastUpdated" | "version">

class UnifiedStateStore {
  private state: UnifiedState = { ...DEFAULT_STATE }
  private listeners = new Map<StateSection | "all", Set<StateListener>>()
  private processingLocks = new Set<string>()
  private saveTimeout: NodeJS.Timeout | null = null
  private initialized = false

  constructor() {
    if (typeof window !== "undefined") {
      this.loadFromStorage()
      this.setupCrossTabSync()
      this.setupWalletCheck()
      this.initialized = true
      CoreLogger.info("Unified State Store initialized", {
        merchantId: this.state.merchant.merchantId,
        payments: this.state.payments.length,
        masterEnabled: this.state.domainState.masterEnabled,
      })
    }
  }

  // ========================================================================
  // STORAGE & SYNC
  // ========================================================================

  private loadFromStorage() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as UnifiedState

        // Keep createdAt and paidAt as ISO strings; parse only for sorting/comparison locally
        parsed.payments = parsed.payments.map((p) => ({
          ...p,
          createdAt: typeof p.createdAt === "string" ? p.createdAt : new Date(p.createdAt).toISOString(),
          paidAt: p.paidAt ? (typeof p.paidAt === "string" ? p.paidAt : new Date(p.paidAt).toISOString()) : undefined,
        }))
        parsed.session.lastActivity = new Date(parsed.session.lastActivity)
        parsed.wallet.lastChecked = new Date(parsed.wallet.lastChecked)
        if (parsed.merchant.connectedAt) {
          parsed.merchant.connectedAt = new Date(parsed.merchant.connectedAt)
        }
        if (parsed._owner?.systemHealth?.lastCheck) {
          parsed._owner.systemHealth.lastCheck = new Date(parsed._owner.systemHealth.lastCheck)
        }

        if (!parsed.merchant.merchantId) {
          parsed.merchant.merchantId = generateMerchantId()
        }

        if (!parsed.session.currentMerchantId) {
          parsed.session.currentMerchantId = parsed.merchant.merchantId
        }

        this.state = parsed

        this.loadMerchantPayments()

        CoreLogger.info("State loaded from storage", {
          merchantId: this.state.merchant.merchantId,
          payments: this.state.payments.length,
          timestamp: new Date(this.state.lastUpdated).toISOString(),
        })
      }
    } catch (error) {
      CoreLogger.error("Failed to load state from storage", error)
      this.state = { ...DEFAULT_STATE }
    }
  }

  private loadMerchantPayments() {
    try {
      const merchantId = this.state.merchant.merchantId
      const merchantKey = getMerchantStorageKey(merchantId)
      const merchantData = localStorage.getItem(merchantKey)

      if (merchantData) {
        const parsed = JSON.parse(merchantData) as { payments: Payment[] }
        this.state.payments = parsed.payments.map((p) => ({
          ...p,
          createdAt: typeof p.createdAt === "string" ? p.createdAt : new Date(p.createdAt).toISOString(),
          paidAt: p.paidAt ? (typeof p.paidAt === "string" ? p.paidAt : new Date(p.paidAt).toISOString()) : undefined,
        }))

        CoreLogger.info("Merchant payments loaded", {
          merchantId,
          count: this.state.payments.length,
        })
      }
    } catch (error) {
      CoreLogger.error("Failed to load merchant payments", error)
    }
  }

  private saveToStorage() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
    }

    this.saveTimeout = setTimeout(() => {
      try {
        this.state.lastUpdated = Date.now()
        const merchantData = { ...this.state }

        const globalState = { ...merchantData, payments: [] }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(globalState))

        const merchantId = this.state.merchant.merchantId
        const merchantKey = getMerchantStorageKey(merchantId)
        const merchantPayments = {
          payments: this.state.payments.filter((p) => p.merchantId === merchantId),
        }
        localStorage.setItem(merchantKey, JSON.stringify(merchantPayments))

        CoreLogger.info("State saved to storage", {
          merchantId,
          paymentsCount: merchantPayments.payments.length,
        })
      } catch (error) {
        CoreLogger.error("Failed to save state to storage", error)
      }
    }, 100)
  }

  private saveOwnerData() {
    try {
      localStorage.setItem(OWNER_STORAGE_KEY, JSON.stringify(this.state._owner))
      CoreLogger.info("Owner data saved")
    } catch (error) {
      CoreLogger.error("Failed to save owner data", error)
    }
  }

  private setupCrossTabSync() {
    if (typeof window === "undefined") return

    window.addEventListener("storage", (event) => {
      if (event.key === STORAGE_KEY && event.newValue) {
        try {
          const newState = JSON.parse(event.newValue) as UnifiedState

          if (newState.lastUpdated > this.state.lastUpdated) {
            CoreLogger.sync("Cross-tab update detected, applying newer state")

            newState.payments = newState.payments.map((p) => ({
              ...p,
              createdAt: typeof p.createdAt === "string" ? p.createdAt : new Date(p.createdAt).toISOString(),
              paidAt: p.paidAt ? (typeof p.paidAt === "string" ? p.paidAt : new Date(p.paidAt).toISOString()) : undefined,
            }))
            newState.session.lastActivity = new Date(newState.session.lastActivity)
            newState.wallet.lastChecked = new Date(newState.wallet.lastChecked)
            if (newState.merchant.connectedAt) {
              newState.merchant.connectedAt = new Date(newState.merchant.connectedAt)
            }

            this.state = newState
            this.notifyAllListeners()
          } else {
            CoreLogger.sync("Cross-tab update ignored (older timestamp)")
          }
        } catch (error) {
          CoreLogger.error("Failed to parse cross-tab update", error)
        }
      }
    })

    CoreLogger.info("Cross-tab synchronization enabled")
  }

  private setupWalletCheck() {
    if (typeof window === "undefined") return

    const checkWallet = () => {
      const isPiAvailable = !!window.Pi
      if (isPiAvailable !== this.state.wallet.isPiSDKAvailable) {
        this.updateWalletStatus({
          isPiSDKAvailable: isPiAvailable,
          lastChecked: new Date(),
        })
      }
    }

    checkWallet()
    setInterval(checkWallet, 5000)
  }

  // ========================================================================
  // SUBSCRIPTION
  // ========================================================================

  subscribe(section: StateSection | "all", listener: StateListener): () => void {
    if (!this.listeners.has(section)) {
      this.listeners.set(section, new Set())
    }
    this.listeners.get(section)!.add(listener)

    CoreLogger.sync(`Subscriber added to ${section} (total: ${this.listeners.get(section)!.size})`)

    return () => {
      this.listeners.get(section)?.delete(listener)
      CoreLogger.sync(`Subscriber removed from ${section}`)
    }
  }

  private notify(section: StateSection) {
    this.listeners.get(section)?.forEach((listener) => listener())
    this.listeners.get("all")?.forEach((listener) => listener())
    CoreLogger.sync(`Notified listeners for ${section}`)
  }

  private notifyAllListeners() {
    this.listeners.forEach((listeners, section) => {
      listeners.forEach((listener) => listener())
    })
    CoreLogger.sync("Notified all listeners (cross-tab sync)")
  }

  // ========================================================================
  // PAYMENTS (MERCHANT-SCOPED)
  // ========================================================================

  /**
   * CRITICAL GATE: Only pending status can start a fresh customer U2A
   * This prevents duplicate payment creation for payments already sent to Pi
   */
  canStartFreshPayment(status: PaymentStatus): boolean {
    return status === "pending"
  }

  createPayment(amount: number, note: string): Payment {
    const lockKey = `create-${Date.now()}`

    if (this.processingLocks.has(lockKey)) {
      CoreLogger.guard("Duplicate payment creation", true)
      throw new Error("Payment creation already in progress")
    }

    this.processingLocks.add(lockKey)

    try {
      const merchantId = this.state.session.currentMerchantId || this.state.merchant.merchantId

      const payment: Payment = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        merchantId, // Auto-scope to current merchant
        accessToken: this.state.merchant.accessToken || "",
        amount,
        note,
        status: "pending",
        createdAt: new Date().toISOString(),
      }

      this.state.payments.unshift(payment)
      this.saveToStorage()
      this.notify("payments")

      this.updateOwnerAnalytics()

      CoreLogger.info("Payment created", { id: payment.id, merchantId, amount })
      return payment
    } finally {
      this.processingLocks.delete(lockKey)
    }
  }

  createPaymentWithId(id: string, amount: number, note: string, createdAt: string, merchantId?: string, merchantAddress?: string, merchantUid?: string, accessToken?: string): Payment {
    const lockKey = `create-${id}`

    if (this.processingLocks.has(lockKey)) {
      CoreLogger.guard("Duplicate payment creation", true)
      throw new Error("Payment creation already in progress")
    }

    this.processingLocks.add(lockKey)

    try {
      // Use provided merchantId/merchantAddress/merchantUid/accessToken OR fall back to current state
      // This ensures the payment stores the EXACT values it was created with
      const finalMerchantId = merchantId || this.state.session.currentMerchantId || this.state.merchant.merchantId
      const finalMerchantAddress = merchantAddress || this.state.merchant.walletAddress || ""
      const finalMerchantUid = merchantUid || this.state.merchant.uid || ""
      const finalAccessToken = accessToken || this.state.merchant.accessToken || ""

      const payment: Payment = {
        id, // Use backend-generated ID
        merchantId: finalMerchantId,
        merchantAddress: finalMerchantAddress,
        merchantUid: finalMerchantUid, // CRITICAL: Store UID for A2U transfers
        accessToken: finalAccessToken, // CRITICAL: Store accessToken for A2U verification at settlement time
        amount,
        note,
        status: "pending",
        createdAt: createdAt, // Keep as ISO string; parse locally only for sorting/comparison
      }

      this.state.payments.unshift(payment)
      this.saveToStorage()
      this.notify("payments")

      this.updateOwnerAnalytics()

      CoreLogger.info("Payment created with backend ID", { id: payment.id, merchantId: finalMerchantId, merchantUid: finalMerchantUid, hasAccessToken: !!finalAccessToken, amount })
      return payment
    } finally {
      this.processingLocks.delete(lockKey)
    }
  }

  addPayment(payment: Payment): void {
    const existingPayment = this.state.payments.find((p) => p.id === payment.id)

    if (existingPayment) {
      CoreLogger.warn("Payment already exists, skipping", { id: payment.id })
      return
    }

    this.state.payments.unshift(payment)
    this.saveToStorage()
    this.notify("payments")
    this.updateOwnerAnalytics()

    CoreLogger.info("Payment added from backend", {
      id: payment.id,
      merchantId: payment.merchantId,
      amount: payment.amount,
    })
  }

  getPayment(id: string): Payment | undefined {
    // Return payment regardless of currentMerchantId
    // Each payment has its own merchantId stored
    const payment = this.state.payments.find((p) => p.id === id)
    return payment
  }

  getAllPayments(): Payment[] {
    // Return ALL payments without filtering by currentMerchantId
    // The merchantId is stored in each payment, use it for filtering if needed
    return [...this.state.payments]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }

  updatePaymentStatus(id: string, status: PaymentStatus, txid?: string): boolean {
    const payment = this.getPayment(id)

    if (!payment) {
      CoreLogger.warn("Payment not found", { id })
      return false
    }

    if (payment.status === "settled_to_merchant") {
      CoreLogger.guard("Double payment attempt", true)
      return false
    }

    payment.status = status
    if (status === "paid_to_app") {
      payment.paidAt = new Date().toISOString()
      payment.u2aTxid = txid // Standardized identifier: u2aTxid replaces legacy txid
    }
    if (status === "settled_to_merchant") {
      payment.settledAt = new Date().toISOString()
    }

    this.saveToStorage()
    this.notify("payments")

    this.updateOwnerAnalytics()

    CoreLogger.operation("Payment status updated", { id, status, txid })
    return true
  }

  addPaymentIdentifier(id: string, field: string, value: string): boolean {
    const payment = this.getPayment(id)

    if (!payment) {
      CoreLogger.warn("Payment not found for identifier storage", { id, field })
      return false
    }

    // Add field dynamically - store verified identifiers (u2aTxid, a2uTxid, etc.)
    ;(payment as any)[field] = value

    this.saveToStorage()
    this.notify("payments")

    CoreLogger.operation("Payment identifier stored", { id, field, valueLength: value.length })
    return true
  }

  getPaymentStats() {
    // Return stats for all payments (no filtering by currentMerchantId which may vary)
    // CRITICAL: Only settled_to_merchant counts as PAID (success)
    // paid_to_app and settlement_pending are processing states
    // settlement_failed with terminal flags (a2uTxid/horizonSuccessFlag) blocks retry
    const all = this.state.payments
    
    // ONLY settled_to_merchant is successfully paid
    const paid = all.filter((p) => p.status === "settled_to_merchant")
    
    // Processing states (NOT errors, NOT failures)
    const processing = all.filter((p) => p.status === "paid_to_app" || p.status === "settlement_pending")
    
    // Pre-settlement failures (retryable if no a2uTxid/horizonSuccessFlag)
    const failed = all.filter((p) => p.status === "failed")
    
    // settlement_failed can have both retryable and terminal variants
    const settlementFailed = all.filter((p) => p.status === "settlement_failed")
    
    // Cancelled (user initiated)
    const cancelled = all.filter((p) => p.status === "cancelled")
    
    const totalAmount = paid.reduce((sum, p) => sum + p.amount, 0)
    const conversionRate = all.length > 0 ? (paid.length / all.length) * 100 : 0

    return {
      totalPayments: all.length,
      paidPayments: paid.length,
      processingPayments: processing.length,
      failedPayments: failed.length,
      settlementFailedPayments: settlementFailed.length,
      cancelledPayments: cancelled.length,
      totalAmount,
      conversionRate,
    }
  }

  clearAllPayments() {
    const currentMerchantId = this.state.session.currentMerchantId || this.state.merchant.merchantId
    this.state.payments = this.state.payments.filter((p) => p.merchantId !== currentMerchantId)
    this.saveToStorage()
    this.notify("payments")
    CoreLogger.operation("Current merchant payments cleared", { merchantId: currentMerchantId })
  }

  // ========================================================================
  // OWNER-ONLY METHODS (CROSS-MERCHANT DATA)
  // ========================================================================

  private isOwnerAuthenticated(): boolean {
    const ownerAuth = localStorage.getItem("flashpay_owner_auth")
    return ownerAuth === OWNER_SECRET
  }

  authenticateOwner(secret: string): boolean {
    if (secret === OWNER_SECRET) {
      localStorage.setItem("flashpay_owner_auth", secret)
      CoreLogger.info("Owner authenticated")
      return true
    }
    CoreLogger.warn("Owner authentication failed")
    return false
  }

  getAllPaymentsAcrossMerchants(): Payment[] {
    if (!this.isOwnerAuthenticated()) {
      CoreLogger.warn("Unauthorized: Owner access required")
      return []
    }
    return [...this.state.payments].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }

  getGlobalAnalytics(): GlobalAnalytics {
    if (!this.isOwnerAuthenticated()) {
      CoreLogger.warn("Unauthorized: Owner access required")
      return {
        totalMerchants: 0,
        totalPayments: 0,
        totalVolume: 0,
        activeMerchants: 0,
        merchantAnalytics: [],
      }
    }
    return this.state._owner.globalAnalytics
  }

  private updateOwnerAnalytics() {
    const allMerchantIds = new Set<string>()
    const merchantStatsMap = new Map<string, MerchantAnalytics>()

    this.state.payments.forEach((payment) => {
      allMerchantIds.add(payment.merchantId)

      if (!merchantStatsMap.has(payment.merchantId)) {
        merchantStatsMap.set(payment.merchantId, {
          merchantId: payment.merchantId,
          totalPayments: 0,
          paidPayments: 0,
          totalAmount: 0,
        })
      }

      const stats = merchantStatsMap.get(payment.merchantId)!
      stats.totalPayments++

      if (payment.status === "settled_to_merchant") {
        stats.paidPayments++
        stats.totalAmount += payment.amount
      }

      const paymentDate = new Date(payment.createdAt)
      if (!stats.firstPaymentDate || paymentDate < stats.firstPaymentDate) {
        stats.firstPaymentDate = paymentDate
      }

      if (!stats.lastPaymentDate || paymentDate > stats.lastPaymentDate) {
        stats.lastPaymentDate = paymentDate
      }
    })

    const merchantAnalytics = Array.from(merchantStatsMap.values())
    const totalVolume = merchantAnalytics.reduce((sum, m) => sum + m.totalAmount, 0)
    const activeMerchants = merchantAnalytics.filter((m) => m.paidPayments > 0).length

    this.state._owner.globalAnalytics = {
      totalMerchants: allMerchantIds.size,
      totalPayments: this.state.payments.length,
      totalVolume,
      activeMerchants,
      merchantAnalytics,
    }

    this.state._owner.allMerchantIds = Array.from(allMerchantIds)
    this.saveOwnerData()
  }

  // ========================================================================
  // DOMAINS
  // ========================================================================

  isMasterEnabled(): boolean {
    return this.state.domainState.masterEnabled
  }

  setMasterEnabled(enabled: boolean) {
    this.state.domainState.masterEnabled = enabled
    this.saveToStorage()
    this.notify("domainState")
    CoreLogger.operation(`Master toggle ${enabled ? "ENABLED" : "DISABLED"}`)
  }

  isDomainEnabled(domainId: string): boolean {
    return this.state.domainState.domains[domainId] ?? false
  }

  setDomainEnabled(domainId: string, enabled: boolean): boolean {
    if (!this.state.domainState.masterEnabled) {
      CoreLogger.guard(`Cannot change domain ${domainId}: master is OFF`, true)
      return false
    }

    this.state.domainState.domains[domainId] = enabled
    this.saveToStorage()
    this.notify("domainState")
    CoreLogger.operation(`Domain ${domainId} ${enabled ? "ENABLED" : "SUSPENDED"}`)
    return true
  }

  getAllDomains(): Domain[] {
    return OPERATIONAL_DOMAINS.map((domain) => ({
      ...domain,
      enabled: this.isDomainEnabled(domain.id),
    }))
  }

  // ========================================================================
  // SESSION
  // ========================================================================

  updateSession(updates: Partial<UserSession>) {
    this.state.session = {
      ...this.state.session,
      ...updates,
      lastActivity: new Date(),
    }
    this.saveToStorage()
    this.notify("session")
    CoreLogger.info("Session updated", updates)
  }

  getSession(): UserSession {
    return this.state.session
  }

  // ========================================================================
  // WALLET
  // ========================================================================

  updateWalletStatus(updates: Partial<WalletStatus>) {
    this.state.wallet = {
      ...this.state.wallet,
      ...updates,
    }
    this.saveToStorage()
    this.notify("wallet")
    CoreLogger.info("Wallet status updated", updates)
  }

  getWalletStatus(): WalletStatus {
    return this.state.wallet
  }

  // ========================================================================
  // UI STATE
  // ========================================================================

  updateUIState(updates: Partial<UIState>) {
    this.state.ui = {
      ...this.state.ui,
      ...updates,
    }
    this.saveToStorage()
    this.notify("ui")
  }

  getUIState(): UIState {
    return this.state.ui
  }

  // ========================================================================
  // MERCHANT
  // ========================================================================

  getMerchantState(): MerchantState {
    return this.state.merchant
  }

  updateMerchantState(updates: Partial<MerchantState>) {
    this.state.merchant = {
      ...this.state.merchant,
      ...updates,
    }
    this.saveToStorage()
    this.notify("merchant" as StateSection)
    CoreLogger.info("Merchant state updated", updates)
  }

  completeMerchantSetup(piUsername: string, walletAddress?: string, uid?: string) {
    // Use piUsername as the stable merchantId
    // This ensures the same merchant always has the same ID across sessions
    const merchantId = piUsername

    // VERIFICATION: Log uid being stored
    const uidHash = uid ? uid.charAt(0) + uid.charAt(uid.length - 1) + uid.length : "EMPTY"
    console.log("[v0] [STORE] Storing merchant setup:")
    console.log("[v0]   merchantId:", merchantId)
    console.log("[v0]   uid received:", uid)
    console.log("[v0]   uid signature:", uidHash)
    console.log("[v0]   uid type:", typeof uid)

    this.state.merchant = {
      ...this.state.merchant,
      isSetupComplete: true,
      merchantId,
      piUsername,
      walletAddress: walletAddress || undefined,
      uid: uid || undefined, // CRITICAL: Store EXACT uid without transformation
      connectedAt: new Date(),
    }

    this.state.session.currentMerchantId = merchantId

    this.saveToStorage()
    
    // VERIFICATION: Log what was actually stored
    console.log("[v0] [STORE] Merchant setup stored:")
    console.log("[v0]   stored uid:", this.state.merchant.uid)
    console.log("[v0]   stored uid signature:", this.state.merchant.uid ? this.state.merchant.uid.charAt(0) + this.state.merchant.uid.charAt(this.state.merchant.uid.length - 1) + this.state.merchant.uid.length : "EMPTY")
    console.log("[v0]   uid matches input:", this.state.merchant.uid === uid)
    
    this.notify("merchant" as StateSection)
    CoreLogger.operation("Merchant setup completed", { piUsername, merchantId, hasWalletAddress: !!walletAddress, hasUid: !!uid })
  }

  // CRITICAL: Clear all merchant auth data for fresh re-authentication
  clearMerchantAuth() {
    console.log("[v0] [STORE] Clearing all merchant auth data...")
    
    this.state.merchant = {
      isSetupComplete: false,
      merchantId: "",
      piUsername: "",
      uid: "",
      accessToken: "",
      verifiedUid: "",
      walletAddress: "",
      connectedAt: undefined,
    }
    
    this.state.session.currentMerchantId = ""
    
    this.saveToStorage()
    this.notify("merchant" as StateSection)
    this.notify("session" as StateSection)
    
    console.log("[v0] [STORE] ✓ All merchant auth data cleared")
    CoreLogger.operation("Merchant auth cleared - ready for fresh authentication")
  }

  // ========================================================================
  // SYSTEM
  // ========================================================================

  getFullState(): UnifiedState {
    return { ...this.state }
  }

  resetState() {
    this.state = { ...DEFAULT_STATE }
    this.saveToStorage()
    this.notifyAllListeners()
    CoreLogger.operation("State reset to defaults")
  }

  isInitialized(): boolean {
    return this.initialized
  }
}

export const unifiedStore = new UnifiedStateStore()

export function useUnifiedStore() {
  return unifiedStore
}
