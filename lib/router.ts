/**
 * Unified Router — single source of truth for all navigation routes.
 * No other file should define application routes outside of this module.
 */

import { config } from "./config"

/**
 * Detects if running in Pi Browser on vusercontent.
 * In vusercontent, we use relative /api/... URLs instead of config.appUrl
 * to avoid cross-origin fetch issues.
 */
export function isInPiBrowser(): boolean {
  if (typeof window === "undefined") return false
  const origin = window.location.origin
  // Pi Browser vusercontent domains: *.vusercontent.net
  return origin.includes("vusercontent.net")
}

/**
 * Returns the correct API base URL for the current environment.
 * - Pi Browser (vusercontent): relative /api/
 * - Vercel/other: config.appUrl/api/
 */
export function getApiUrl(endpoint: string): string {
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`
  if (isInPiBrowser()) {
    console.log(`[v0][router] Pi Browser detected - using relative URL: /api${path}`)
    return `/api${path}`
  }
  const url = `${config.appUrl}/api${path}`
  console.log(`[v0][router] Using config.appUrl: ${url}`)
  return url
}

export const ROUTES = {
  HOME: "/",
  CREATE: "/create",
  PAY: "/pay",
  PAYMENTS: "/payments",
  MERCHANT_PAYMENTS: "/merchant/payments",
  PROFILE: "/profile",
  PRIVACY: "/privacy",
  TERMS: "/terms",
  TRANSACTIONS: "/transactions",
  // Owner-only operations console routes
  OPERATIONS: "/operations",
  OPERATIONS_DOMAINS: "/operations/domains",
  // Legacy routes (still exist for backward compatibility, now in operations)
  CONTROL_PANEL: "/control-panel",
  DIAGNOSTICS: "/diagnostics",
} as const

export function getPaymentLink(id: string): string {
  return `${ROUTES.PAY}/${id}`
}

/**
 * Returns a Pi Browser deep link (pi://) for use in QR codes.
 * Always uses the stable Vercel domain to ensure consistent QR behavior
 * regardless of whether the merchant is on Vercel, Pi Browser, or PiNet.
 */
export function getPiNetPaymentUrl(id: string): string {
  return `pi://flashpay-two.vercel.app/pay/${id}`
}

/** @deprecated Use getPiNetPaymentUrl instead */
export function getPiNetUrl(id: string): string {
  return getPiNetPaymentUrl(id)
}

export function getPiDeepLink(id: string, domain = "flashpay.pi", amount?: number, note?: string): string {
  const baseLink = `pi://${domain}/pay/${id}`
  if (amount !== undefined) {
    const encodedNote = note ? encodeURIComponent(note) : ""
    return `${baseLink}?amount=${amount}${encodedNote ? `&note=${encodedNote}` : ""}`
  }
  return baseLink
}

export function getPaymentUrl(id: string, baseUrl?: string): string {
  const base = baseUrl || config.appUrl
  return `${base}/pay/${id}`
}

export function isValidRoute(path: string): boolean {
  const allRoutes: string[] = [
    ROUTES.HOME,
    ROUTES.CREATE,
    ROUTES.PAY,
    ROUTES.PAYMENTS,
    ROUTES.MERCHANT_PAYMENTS,
    ROUTES.PROFILE,
    ROUTES.PRIVACY,
    ROUTES.TERMS,
    ROUTES.TRANSACTIONS,
    ROUTES.OPERATIONS,
    ROUTES.OPERATIONS_DOMAINS,
    ROUTES.CONTROL_PANEL,
    ROUTES.DIAGNOSTICS,
  ]
  return allRoutes.includes(path)
}
