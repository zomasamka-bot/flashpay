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
  CONTROL_PANEL: "/control-panel",
  DIAGNOSTICS: "/diagnostics",
} as const

export function getPaymentLink(id: string): string {
  return `${ROUTES.PAY}/${id}`
}

/**
 * Pi Network Subdomain Configuration
 * IMPORTANT: This MUST match the subdomain registered in the Pi Developer Portal
 * For flashpay, the registered subdomain is: flashpay0734.pi
 */
const PI_NETWORK_SUBDOMAIN = "flashpay0734.pi"

/**
 * Returns a Pi Browser deep link (pi://) for use in QR codes.
 * The pi:// protocol ensures the link opens in Pi Browser, not a regular browser.
 * CRITICAL: Uses the registered Pi Network subdomain, NOT the Vercel URL.
 */
export function getPiNetPaymentUrl(id: string): string {
  return `pi://${PI_NETWORK_SUBDOMAIN}/pay/${id}`
}

/** @deprecated Use getPiNetPaymentUrl instead */
export function getPiNetUrl(id: string): string {
  return getPiNetPaymentUrl(id)
}

export function getPiDeepLink(id: string, domain = PI_NETWORK_SUBDOMAIN, amount?: number, note?: string): string {
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
    ROUTES.CONTROL_PANEL,
    ROUTES.DIAGNOSTICS,
  ]
  return allRoutes.includes(path)
}
