/**
 * UNIFIED ROUTER - Single Source of Truth for Navigation
 *
 * This file defines all valid routes in the FlashPay application.
 * No other component should define routes outside of this system.
 */

export const ROUTES = {
  // Main application routes
  HOME: "/",
  CREATE: "/create",
  PAY: "/pay",
  PAYMENTS: "/payments",
  PROFILE: "/profile",
  CONTROL_PANEL: "/control-panel",
  DIAGNOSTICS: "/diagnostics",
} as const

/**
 * Helper to build payment link with ID
 */
export function getPaymentLink(id: string): string {
  return `${ROUTES.PAY}?id=${id}`
}

// Helper to build PiNet HTTPS URL using path parameter (more reliable than query params)
// Pi apps use subdomain format: https://{appIdentifier}.pinet.com/pay/{id}
export function getPiNetUrl(id: string): string {
  // Use PiNet app identifier without .pi suffix
  const appIdentifier = process.env.NEXT_PUBLIC_PINET_SUBDOMAIN?.replace('.pi', '') || "flashpay0734"
  return `https://${appIdentifier}.pinet.com/pay/${id}`
}

// Helper to build Pi Browser deep link for production (after domain activation)
export function getPiDeepLink(id: string, domain = "flashpay.pi", amount?: number, note?: string): string {
  const baseLink = `pi://${domain}/pay?id=${id}`

  if (amount !== undefined) {
    const encodedNote = note ? encodeURIComponent(note) : ""
    return `${baseLink}&amount=${amount}${encodedNote ? `&note=${encodedNote}` : ""}`
  }

  return baseLink
}

/**
 * Helper to build full payment URL for web browsers
 */
export function getPaymentUrl(id: string, baseUrl?: string): string {
  const base = baseUrl || (typeof window !== "undefined" ? window.location.origin : "https://flashpay-two.vercel.app")
  return `${base}${getPaymentLink(id)}` // Returns simple URL with only ID parameter
}

/**
 * Helper to build full HTTPS payment URL with embedded data for testing
 */
export function getPaymentUrlWithData(id: string, amount: number, note?: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://flashpay-two.vercel.app"
  const encodedNote = note ? encodeURIComponent(note) : ""
  return `${baseUrl}/pay?id=${id}&amount=${amount}${encodedNote ? `&note=${encodedNote}` : ""}`
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
  ]

  return allRoutes.includes(path)
}
