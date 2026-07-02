/**
 * Operations Console Layout
 * Owner-only access to platform management tools
 * Non-owners are redirected to /profile with 404 response
 */

"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useMerchant } from "@/lib/use-merchant"
import { useIsOwner } from "@/lib/owner-auth"

export default function OperationsLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const merchant = useMerchant()
  const merchantUid = merchant?.uid
  const isOwner = useIsOwner(merchantUid)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    // If not owner, redirect to profile
    if (mounted && !isOwner) {
      console.warn("[operations-layout] Non-owner attempted to access operations console")
      router.push("/profile")
    }
  }, [mounted, isOwner, router])

  // Show nothing until client-side verification is complete
  if (!mounted || !isOwner) {
    return <div className="min-h-screen flex items-center justify-center" />
  }

  return children
}
