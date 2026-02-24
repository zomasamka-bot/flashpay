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
  merchantId: string // Added unique merchant identifier
  piUsername?: string
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
    merchantId: generateMerchantId(), // Auto-generate merchant ID
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

        // Parse dates
        parsed.payments = parsed.payments.map((p) => ({
          ...p,
          createdAt: new Date(p.createdAt),
          paidAt: p.paidAt ? new Date(p.paidAt) : undefined,
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
          createdAt: new Date(p.createdAt),
          paidAt: p.paidAt ? new Date(p.paidAt) : undefined,
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
              createdAt: new Date(p.createdAt),
              paidAt: p.paidAt ? new Date(p.paidAt) : undefined,
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
        amount,
        note,
        status: "PENDING",
        createdAt: new Date(),
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

  createPaymentWithId(id: string, amount: number, note: string, createdAt: string): Payment {
    const lockKey = `create-${id}`

    if (this.processingLocks.has(lockKey)) {
      CoreLogger.guard("Duplicate payment creation", true)
      throw new Error("Payment creation already in progress")
    }

    this.processingLocks.add(lockKey)

    try {
      const merchantId = this.state.session.currentMerchantId || this.state.merchant.merchantId

      const payment: Payment = {
        id, // Use backend-generated ID
        merchantId,
        amount,
        note,
        status: "PENDING",
        createdAt: new Date(createdAt),
      }

      this.state.payments.unshift(payment)
      this.saveToStorage()
      this.notify("payments")

      this.updateOwnerAnalytics()

      CoreLogger.info("Payment created with backend ID", { id: payment.id, merchantId, amount })
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
    const currentMerchantId = this.state.session.currentMerchantId || this.state.merchant.merchantId
    const payment = this.state.payments.find((p) => p.id === id)

    if (payment && payment.merchantId !== currentMerchantId) {
      CoreLogger.warn("Cross-merchant payment access blocked", {
        paymentId: id,
        paymentMerchantId: payment.merchantId,
        currentMerchantId,
      })
      return undefined
    }

    return payment
  }

  getAllPayments(): Payment[] {
    const currentMerchantId = this.state.session.currentMerchantId || this.state.merchant.merchantId
    return [...this.state.payments]
      .filter((p) => p.merchantId === currentMerchantId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  }

  updatePaymentStatus(id: string, status: PaymentStatus, txid?: string): boolean {
    const payment = this.getPayment(id)

    if (!payment) {
      CoreLogger.warn("Payment not found", { id })
      return false
    }

    if (payment.status === "PAID") {
      CoreLogger.guard("Double payment attempt", true)
      return false
    }

    payment.status = status
    if (status === "PAID") {
      payment.paidAt = new Date()
      payment.txid = txid
    }

    this.saveToStorage()
    this.notify("payments")

    this.updateOwnerAnalytics()

    CoreLogger.operation("Payment status updated", { id, status, txid })
    return true
  }

  getPaymentStats() {
    const currentMerchantId = this.state.session.currentMerchantId || this.state.merchant.merchantId
    const all = this.state.payments.filter((p) => p.merchantId === currentMerchantId)
    const paid = all.filter((p) => p.status === "PAID")
    const pending = all.filter((p) => p.status === "PENDING")
    const failed = all.filter((p) => p.status === "FAILED")
    const cancelled = all.filter((p) => p.status === "CANCELLED")
    const totalAmount = paid.reduce((sum, p) => sum + p.amount, 0)
    const conversionRate = all.length > 0 ? (paid.length / all.length) * 100 : 0

    return {
      totalPayments: all.length,
      paidPayments: paid.length,
      pendingPayments: pending.length,
      failedPayments: failed.length,
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
    return [...this.state.payments].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
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

      if (payment.status === "PAID") {
        stats.paidPayments++
        stats.totalAmount += payment.amount
      }

      if (!stats.firstPaymentDate || payment.createdAt < stats.firstPaymentDate) {
        stats.firstPaymentDate = payment.createdAt
      }

      if (!stats.lastPaymentDate || payment.createdAt > stats.lastPaymentDate) {
        stats.lastPaymentDate = payment.createdAt
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

  completeMerchantSetup(piUsername: string, walletAddress?: string) {
    const merchantId = this.state.merchant.merchantId

    this.state.merchant = {
      ...this.state.merchant,
      isSetupComplete: true,
      piUsername,
      walletAddress,
      connectedAt: new Date(),
    }

    this.state.session.currentMerchantId = merchantId

    this.saveToStorage()
    this.notify("merchant" as StateSection)
    CoreLogger.operation("Merchant setup completed", { piUsername, merchantId: this.state.merchant.merchantId })
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
