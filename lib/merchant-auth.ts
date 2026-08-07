/**
 * Merchant authentication and authorization utilities
 * Verifies merchant identity from Pi API using access token
 */

/**
 * Verify merchant identity from Pi /v2/me endpoint
 * Returns the verified Pi UID and username
 */
export type MerchantTokenVerification =
  | {
      status: "valid"
      uid: string
      username: string
      scopes: string[]
      validUntil: number
    }
  | { status: "reconnect_required"; reason: string }
  | { status: "verification_unavailable"; reason: string }

const REQUIRED_MERCHANT_SCOPES = ["username", "payments", "wallet_address"] as const

export async function verifyMerchantTokenForHome(
  accessToken: string | undefined,
  expectedUid: string | undefined,
  expectedUsername: string | undefined,
): Promise<MerchantTokenVerification> {
  if (!accessToken) {
    return { status: "reconnect_required", reason: "missing access token" }
  }

  try {
    const response = await fetch("https://api.minepi.com/v2/me", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    })

    if (response.status === 401 || response.status === 403) {
      return { status: "reconnect_required", reason: `Pi /v2/me rejected token (${response.status})` }
    }

    if (!response.ok) {
      return { status: "verification_unavailable", reason: `Pi /v2/me returned ${response.status}` }
    }

    const data = await response.json()
    const credentials = data?.credentials
    const scopes = credentials?.scopes
    const validUntilTimestamp = credentials?.valid_until?.timestamp

    if (!data?.uid || typeof data.uid !== "string" || !data?.username || typeof data.username !== "string") {
      return { status: "verification_unavailable", reason: "Pi /v2/me response missing identity" }
    }

    if (!Array.isArray(scopes) || typeof validUntilTimestamp !== "number") {
      return { status: "verification_unavailable", reason: "Pi /v2/me response missing credentials" }
    }

    if (data.uid !== expectedUid || data.username !== expectedUsername) {
      return { status: "reconnect_required", reason: "Pi identity does not match the merchant session" }
    }

    if (validUntilTimestamp <= Math.floor(Date.now() / 1000)) {
      return { status: "reconnect_required", reason: "Pi access token has expired" }
    }

    const missingScope = REQUIRED_MERCHANT_SCOPES.find((scope) => !scopes.includes(scope))
    if (missingScope) {
      return { status: "reconnect_required", reason: `Pi credentials missing ${missingScope}` }
    }

    return {
      status: "valid",
      uid: data.uid,
      username: data.username,
      scopes,
      validUntil: validUntilTimestamp,
    }
  } catch (error) {
    console.error("[Merchant Auth] Home token verification unavailable:", error)
    return { status: "verification_unavailable", reason: "Pi /v2/me request failed" }
  }
} 

export async function verifyMerchantFromPiToken(accessToken?: string): Promise<{ uid: string; username: string } | null> {
  if (!accessToken) {
    return null
  }

  try {
    const response = await fetch("https://api.minepi.com/v2/me", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    })

    if (!response.ok) {
      console.error("[Merchant Auth] Failed to verify merchant from Pi:", response.status)
      return null
    }

    const data = await response.json()
    if (!data?.uid || !data?.username) {
      console.error("[Merchant Auth] Pi /v2/me response missing uid or username")
      return null
    }

    return { uid: data.uid, username: data.username }
  } catch (error) {
    console.error("[Merchant Auth] Error verifying merchant from Pi:", error)
    return null
  }
}

/**
 * Authorize merchant access to their own data
 * Expects accessToken in authorization header
 * Returns the verified merchant UID and username or null
 */
export async function authorizeFromHeader(authHeader?: string | null): Promise<{ uid: string; username: string } | null> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null
  }

  const token = authHeader.substring(7)
  return verifyMerchantFromPiToken(token)
}
