/**
 * UNIFIED ROUTER - Single Source of Truth for Navigation
 *
 * This file defines all valid routes in the FlashPay application.
 * No other component should define routes outside of this system.
 */

/**
 * Get Pi Browser deep link URL for QR codes
 * CRITICAL: QR codes must use pi:// protocol to force opening in Pi Browser
 * Format: pi://flashpay-two.vercel.app/pay/{id}
 * 
 * When scanned with any camera:
 * - Standard HTTPS URL opens in default browser (wrong)
 * - pi:// protocol forces Pi Browser to handle the link (correct)
 */
export function getPiNetPaymentUrl(id: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://flashpay-two.vercel.app"
  const httpsUrl = `${baseUrl}/pay/${id}`
  
  // Convert HTTPS URL to Pi Browser deep link
  // Remove https:// and add pi:// protocol
  const domain = httpsUrl.replace('https://', '')
  return `pi://${domain}`
}

export const ROUTES = {
  // Main application routes
  HOME: "/",
  CREATE: "/create",
  PAY: "/pay",
  PAYMENTS: "/payments",
  PROFILE: "/profile",
  CONTROL_PANEL: "/control-panel",
  DIAGNOSTICS: "/diagnostics",
  
  // Legal pages
  PRIVACY: "/privacy",
  TERMS: "/terms",
} as const

/**
 * Helper to build payment link with ID
 */
export function getPaymentLink(id: string): string {
  return `${ROUTES.PAY}/${id}`
}

/**
 * DEPRECATED: Use getPiNetPaymentUrl instead
 * Kept for backwards compatibility
 */
export function getPiNetUrl(id: string): string {
  return getPiNetPaymentUrl(id)
}

// Helper to build Pi Browser deep link for production (after domain activation)
export function getPiDeepLink(id: string, domain = "flashpay.pi", amount?: number, note?: string): string {
  const baseLink = `pi://${domain}/pay/${id}`

  if (amount !== undefined) {
    const encodedNote = note ? encodeURIComponent(note) : ""
    return `${baseLink}?amount=${amount}${encodedNote ? `&note=${encodedNote}` : ""}`
  }

  return baseLink
}

/**
 * Helper to build full payment URL for web browsers
 */
export function getPaymentUrl(id: string, baseUrl?: string): string {
  const base = baseUrl || (typeof window !== "undefined" ? window.location.origin : (process.env.NEXT_PUBLIC_APP_URL || ""))
  return `${base}/pay/${id}`
}

/**
 * Helper to build full HTTPS payment URL with embedded data for testing
 */
export function getPaymentUrlWithData(id: string, amount: number, note?: string): string {
  const baseUrl = typeof window !== "undefined" ? window.location.origin : (process.env.NEXT_PUBLIC_APP_URL || "")
  const encodedNote = note ? encodeURIComponent(note) : ""
  return `${baseUrl}/pay/${id}?amount=${amount}${encodedNote ? `&note=${encodedNote}` : ""}`
}

/**
 * Check if a path is a valid route
 */
export function isValidRoute(path: string): boolean {
  const allRoutes = [
    ROUTES.HOME,
    ROUTES.CREATE,
    ROUTES.PAY,
    ROUTES.PAYMENTS,
    ROUTES.PROFILE,
    ROUTES.CONTROL_PANEL,
    ROUTES.DIAGNOSTICS,
    ROUTES.PRIVACY,
    ROUTES.TERMS,
  ]

  return allRoutes.includes(path)
}

/**
 * Helper to get the public base URL
 */
function getPublicBaseUrl(): string {
  return typeof window !== "undefined" ? window.location.origin : (process.env.NEXT_PUBLIC_APP_URL || "");
}
