"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useRouter } from "next/navigation"
import { useMerchant } from "@/lib/use-merchant"
import { unifiedStore } from "@/lib/unified-store"
import { usePasswordAuth } from "@/lib/use-password-auth"
import { PasswordGate } from "@/components/password-gate"
import { ROUTES } from "@/lib/router"
import { useOwnerUid } from "@/lib/use-owner-uid"
import { config } from "@/lib/config"
import { Shield, BarChart3, ArrowRight, LogOut, History } from "lucide-react"

function ProfileContent() {
  const router = useRouter()
  const merchant = useMerchant()
  const { logout } = usePasswordAuth()
  const [mounted, setMounted] = useState(false)
  const merchantUid = merchant?.uid
  const accessToken = merchant?.accessToken

  // Owner UID verification — completely isolated from payment system
  const { uidData, verifyUid } = useOwnerUid()

  useEffect(() => {
    setMounted(true)
  }, [])

  // Verify owner UID when merchant credentials are available
  useEffect(() => {
    if (mounted && merchantUid && accessToken && !uidData.uid) {
      verifyUid(merchantUid, accessToken).catch(() => {
        // Owner verification is non-critical; continue without owner features
      })
    }
  }, [mounted, merchantUid, accessToken, uidData.uid, verifyUid])

  const handleLogout = () => {
    if (confirm("Are you sure you want to log out? You'll need the password to access this page again.")) {
      logout()
      router.push("/")
    }
  }

  const handleClearAndReconnect = () => {
    if (confirm("This will clear all wallet connection data and force a fresh authentication. Continue?")) {
      unifiedStore.clearMerchantAuth()
      router.push("/")
    }
  }

  if (!mounted) {
    return null
  }

  // Owner access: Verified UID must exactly match NEXT_PUBLIC_OWNER_UID
  const isOwner = uidData.status === "success" && uidData.uid === config.ownerUid

  return (
    <div className="min-h-screen pb-20 pt-4">
      <div className="max-w-4xl mx-auto px-4 space-y-6">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Shield className="h-6 w-6 text-primary" />
              <h1 className="text-2xl font-bold">Account</h1>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={handleClearAndReconnect} variant="outline" size="sm" className="gap-2 bg-transparent text-blue-600 hover:text-blue-700">
                Reconnect Wallet
              </Button>
              <Button onClick={handleLogout} variant="outline" size="sm" className="gap-2 bg-transparent">
                <LogOut className="h-4 w-4" />
                Logout
              </Button>
            </div>
          </div>
          <p className="text-sm text-muted-foreground">Your account settings</p>
          {merchant?.piUsername && <p className="text-xs text-muted-foreground mt-1">@{merchant.piUsername}</p>}
        </div>

        {/* Owner Operations Console Link (Owner Only) */}
        {isOwner && (
          <Card className="border-2 border-primary">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Operations Console
              </CardTitle>
              <CardDescription>Access platform management tools</CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => router.push("/operations")} className="w-full" size="lg">
                <Shield className="h-4 w-4 mr-2" />
                Open Operations Console
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Merchant Payment Requests */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5" />
              Payment Requests
            </CardTitle>
            <CardDescription>View and track payment requests you created</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => router.push(ROUTES.MERCHANT_PAYMENTS)} className="w-full" size="lg" variant="outline">
              <BarChart3 className="h-4 w-4 mr-2" />
              View Payment Requests
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </CardContent>
        </Card>

        {/* Transaction History Access */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <History className="h-5 w-5" />
              Transaction History
            </CardTitle>
            <CardDescription>View receipts and complete transaction ledger</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => router.push("/transactions")} className="w-full" size="lg" variant="outline">
              <History className="h-4 w-4 mr-2" />
              View All Transactions
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export default function ProfilePage() {
  return (
    <PasswordGate>
      <ProfileContent />
    </PasswordGate>
  )
}
