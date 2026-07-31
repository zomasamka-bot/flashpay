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
 * Intelligently generates QR URL based on runtime environment.
 * - On Vercel: QR opens payment page on Vercel
 * - In Pi Browser: QR opens payment page on flashpayaefebeff3375.pinet.com
 * - Includes amount and note as URL parameters
 */
export function getSmartQRUrl(id: string, amount?: number, note?: string): string {
  let domain = "flashpay-two.vercel.app"
  
  // Detect if running in Pi Browser or pinet.com environment
  if (typeof window !== "undefined") {
    const hostname = window.location.hostname
    console.log("[v0][QR-Smart] Generating QR URL - Current hostname:", hostname)
    
    // If already on pinet.com, use pinet.com in the QR code
    if (hostname.includes("pinet.com")) {
      domain = "flashpayaefebeff3375.pinet.com"
      console.log("[v0][QR-Smart] Running on pinet.com - using pinet.com domain")
    } else {
      console.log("[v0][QR-Smart] Running on Vercel - using Vercel domain")
    }
  }
  
  const baseUrl = `pi://${domain}/pay/${id}`
  
  // Add query parameters if provided
  const params = new URLSearchParams()
  if (amount !== undefined) {
    params.append("amount", amount.toString())
  }
  if (note) {
    params.append("note", note)
  }
  
  const queryString = params.toString()
  return queryString ? `${baseUrl}?${queryString}` : baseUrl
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
