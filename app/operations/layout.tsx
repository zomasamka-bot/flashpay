/**
 * Operations Console Layout
 * Owner-only access to platform management tools
 * Verified owner UID is checked from ownerUidStore
 */

"use client"

import { useEffect, useState } from "react"
import { useOwnerUid } from "@/lib/use-owner-uid"
import { config } from "@/lib/config"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useRouter } from "next/navigation"

export default function OperationsLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { uidData } = useOwnerUid()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // Owner verified - render console
  if (mounted && uidData.status === "success" && uidData.uid === config.ownerUid) {
    return children
  }

  // Explicitly denied - not the owner
  if (mounted && uidData.status === "success" && uidData.uid !== config.ownerUid) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <Card className="w-full max-w-md border-red-500/50">
          <CardHeader>
            <CardTitle className="text-red-600">Access Denied</CardTitle>
            <CardDescription>You do not have permission to access the Operations Console.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => router.push("/")}
              className="w-full"
            >
              Return to Home
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Still loading or no state
  return null
}
