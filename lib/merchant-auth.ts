/**
 * Merchant authentication and authorization utilities
 * Verifies merchant identity from Pi API using access token
 */

/**
 * Verify merchant identity from Pi /v2/me endpoint
 * Returns the verified Pi UID and username
 */
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
