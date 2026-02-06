"use client"

/**
 * UNIFIED DOMAIN MANAGEMENT SYSTEM
 *
 * Manages multiple Pi domains as independent operational units within the unified system.
 * All domain states are persistent and controlled through the operational core.
 *
 * PRIMARY DOMAIN: flashpay.pi (toggleable)
 * OPERATIONAL DOMAINS: Can be enabled/suspended independently
 */

import { CoreLogger } from "./core"
import { useState, useEffect } from "react"

export interface Domain {
  id: string
  name: string
  domain: string
  routes: string[]
  description: string
  enabled: boolean
  isPrimary: boolean
}

export const PRIMARY_DOMAIN = {
  id: "flashpay",
  name: "FlashPay",
  domain: "flashpay.pi",
  routes: ["/", "/create", "/pay", "/payments", "/profile"],
  description: "Primary payment request system",
  enabled: true,
  isPrimary: true,
}

export const OPERATIONAL_DOMAINS: Domain[] = [
  {
    id: "flashpay",
    name: "FlashPay",
    domain: "flashpay.pi",
    routes: ["/", "/create", "/pay", "/payments", "/profile"],
    description: "Primary payment request system",
    enabled: true,
    isPrimary: true,
  },
]

const STORAGE_KEY = "flashpay_domain_states"

/**
 * Domain Management Store
 * Single source of truth for domain states
 */
class DomainStore {
  private masterEnabled = false
  private domainStates: Map<string, boolean> = new Map()
  private listeners: Set<() => void> = new Set()

  constructor() {
    if (typeof window !== "undefined") {
      this.loadFromStorage()
      CoreLogger.info("Domain Management System initialized", {
        masterEnabled: this.masterEnabled,
        domains: OPERATIONAL_DOMAINS.length,
      })
    }
  }

  private loadFromStorage() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const data = JSON.parse(stored)
        this.masterEnabled = data.masterEnabled ?? false

        // Load individual domain states
        OPERATIONAL_DOMAINS.forEach((domain) => {
          const enabled = data.domains?.[domain.id] ?? domain.enabled
          this.domainStates.set(domain.id, enabled)
        })

        CoreLogger.info("Domain states loaded from storage")
      } else {
        // Initialize with default states
        OPERATIONAL_DOMAINS.forEach((domain) => {
          this.domainStates.set(domain.id, domain.enabled)
        })
      }
    } catch (error) {
      CoreLogger.error("Failed to load domain states", error)
    }
  }

  private saveToStorage() {
    try {
      const data = {
        masterEnabled: this.masterEnabled,
        domains: Object.fromEntries(this.domainStates),
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
      CoreLogger.info("Domain states saved to storage")
    } catch (error) {
      CoreLogger.error("Failed to save domain states", error)
    }
  }

  private notifyListeners() {
    this.listeners.forEach((listener) => listener())
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  isMasterEnabled(): boolean {
    return this.masterEnabled
  }

  setMasterEnabled(enabled: boolean) {
    this.masterEnabled = enabled
    this.saveToStorage()
    this.notifyListeners()
    CoreLogger.operation(`Domain master toggle ${enabled ? "ENABLED" : "DISABLED"}`)
  }

  isDomainEnabled(domainId: string): boolean {
    return this.domainStates.get(domainId) ?? false
  }

  setDomainEnabled(domainId: string, enabled: boolean) {
    if (!this.masterEnabled) {
      CoreLogger.guard(`Cannot change domain ${domainId}: master toggle is OFF`, true)
      return false
    }

    this.domainStates.set(domainId, enabled)
    this.saveToStorage()
    this.notifyListeners()
    CoreLogger.operation(`Domain ${domainId} ${enabled ? "ENABLED" : "SUSPENDED"}`)
    return true
  }

  getAllDomains(): Domain[] {
    return OPERATIONAL_DOMAINS.map((domain) => ({
      ...domain,
      enabled: this.domainStates.get(domain.id) ?? domain.enabled,
    }))
  }

  getDomain(domainId: string): Domain | undefined {
    const domain = OPERATIONAL_DOMAINS.find((d) => d.id === domainId)
    if (!domain) return undefined

    return {
      ...domain,
      enabled: this.domainStates.get(domain.id) ?? domain.enabled,
    }
  }

  canAccessRoute(route: string): boolean {
    // Control panel is always accessible
    if (route === "/control-panel") return true

    // Core pages are ALWAYS accessible
    const coreRoutes = ["/", "/create", "/pay", "/payments", "/profile"]
    const isCoreRoute = coreRoutes.some((r) => route === r || (r === "/pay" && route.startsWith("/pay")))

    if (isCoreRoute) {
      CoreLogger.guard(`Core route ${route} is always accessible`, false)
      return true
    }

    CoreLogger.guard(`No domain found for route: ${route}`, true)
    return false
  }

  getDomainForRoute(route: string): Domain | undefined {
    return OPERATIONAL_DOMAINS.find((d) =>
      d.routes.some((r) => route === r || (r === "/pay" && route.startsWith("/pay"))),
    )
  }
}

// Export singleton instance
export const domainStore = new DomainStore()

/**
 * React hook for domain management
 */
export function useDomains() {
  const [, forceUpdate] = useState({})

  useEffect(() => {
    const unsubscribe = domainStore.subscribe(() => {
      forceUpdate({})
    })
    return unsubscribe
  }, [])

  return {
    masterEnabled: domainStore.isMasterEnabled(),
    setMasterEnabled: (enabled: boolean) => domainStore.setMasterEnabled(enabled),
    domains: domainStore.getAllDomains(),
    setDomainEnabled: (domainId: string, enabled: boolean) => domainStore.setDomainEnabled(domainId, enabled),
    canAccessRoute: (route: string) => domainStore.canAccessRoute(route),
    getDomainForRoute: (route: string) => domainStore.getDomainForRoute(route),
  }
}
