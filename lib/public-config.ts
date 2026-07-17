/**
 * Public-facing configuration
 * SAFE FOR CLIENT CODE AND BROWSER BUNDLE
 * 
 * Only NEXT_PUBLIC_* environment variables and derived non-secret values.
 * Never import server-config.ts into any file with "use client".
 */

export const publicConfig = {
  // App URL — always points to Vercel backend
  appUrl: process.env.NEXT_PUBLIC_APP_URL || "https://flashpay-two.vercel.app",

  // Owner UID — the only user who can access Operations Console
  // Set this to your Pi UID to enable owner-only operational features
  // Example: NEXT_PUBLIC_OWNER_UID=ccc3bf32-25c2-4d9a-bdb3-a8ffb2beb8fa
  ownerUid: process.env.NEXT_PUBLIC_OWNER_UID || "",

  get isOwnerConfigured(): boolean {
    return !!this.ownerUid
  },
} as const
