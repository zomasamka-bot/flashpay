/**
 * Unified Router — single source of truth for all navigation routes.
 * No other file should define application routes outside of this module.
 */

import { config } from "./config"

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
 * Get the current origin from browser context
 * Prioritize window.location.origin to ensure same-domain authentication
 * Falls back to config.appUrl for SSR or offline context
 */
function getCurrentOrigin(): string {
  if (typeof window !== "undefined" && window.location.origin) {
    return window.location.origin
  }
  return config.appUrl
}

/**
 * Returns a Pi Browser deep link (pi://) for use in QR codes.
 * Uses window.location.origin to ensure merchant and customer authenticate under the same app context.
 * This is CRITICAL: if merchant opens from pinet.com but QR uses vercel.app, different app_ids result.
 */
export function getPiNetPaymentUrl(id: string): string {
  const currentOrigin = getCurrentOrigin()
  const domain = currentOrigin.replace("https://", "").replace("http://", "")
  return `pi://${domain}/pay/${id}`
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
