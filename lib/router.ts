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
 * Returns a Pi Browser "Scan to Pay" QR code payload.
 * Encodes as "flashpay:{UUID}" for merchant Home scanner.
 * Scanner extracts UUID and renders PaymentContentWithId.
 * Payment data is fetched from backend by ID, not URL (authoritative source).
 */
export function getPiScanQRPayload(id: string): string {
  return `flashpay:${id}`
}

/**
 * Returns a Pi Browser deep link for use in QR codes.
 * Routes through hash (#/pay/{id}) since PiNet App Studio reduces inner app URL to / before React.
 * Hash routing persists across the PiNet facade and is visible in address bar.
 * Payment data is fetched from backend by ID, not URL (authoritative source).
 */
export function getPiNetPaymentUrl(id: string, amount?: number, note?: string): string {
  return `https://flashpayaefebeff3375.pinet.com/#/pay/${encodeURIComponent(id)}`
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
