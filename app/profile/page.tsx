"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useRouter } from "next/navigation"

import { ROUTES } from "@/lib/router"
import { useOwnerUid } from "@/lib/use-owner-uid"
import { config } from "@/lib/config"
import { useToast } from "@/hooks/use-toast"
import { Shield, BarChart3, ArrowRight, LogOut, History, Wallet } from "lucide-react"

function ProfileContent() {
  const router = useRouter()
  const { toast } = useToast()
  const [mounted, setMounted] = useState(false)
  const [isAuthenticating, setIsAuthenticating] = useState(false)

  // Owner UID verification — stores result separately from payment system
  const { uidData, verifyUid, clearUid } = useOwnerUid()
  const piUsername = uidData.username

  useEffect(() => {
    setMounted(true)
  }, [])



  // Independent Profile authentication - calls window.Pi.authenticate directly
  const handleConnectWallet = async () => {
    setIsAuthenticating(true)

    try {
      if (!window.Pi || typeof window.Pi.authenticate !== "function") {
        throw new Error("Pi SDK not available")
      }

      // Direct call to Pi.authenticate - completely independent from Home
      const authResult = await window.Pi.authenticate(
        ["username", "payments", "wallet_address"],
        () => {
          // Ignore incomplete payments during profile auth
        }
      )

      if (!authResult || !authResult.user) {
        throw new Error("No user data from Pi Network")
      }

      // Extract UID from various possible field names
      const uid =
        authResult.user.uid ||
        authResult.user.userId ||
        authResult.user.user_id ||
        authResult.user.app_uid ||
        authResult.user.appUid ||
        ""

      if (!uid) {
        throw new Error("No user ID returned")
      }

      const accessToken = authResult.accessToken
      if (!accessToken) {
        throw new Error("No access token returned")
      }

      const username = authResult.user.username || ""

      // Store ONLY in isolated ownerUidStore, verify against NEXT_PUBLIC_OWNER_UID
      const verifyResult = await verifyUid(uid, accessToken, username)

      if (!verifyResult.success) {
        throw new Error(verifyResult.error || "Owner verification failed")
      }

      toast({
        title: "Connected",
        description: `Verified by Pi Network as @${username}`,
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Failed to connect wallet"
      toast({
        title: "Connection Failed",
        description: errorMsg,
        variant: "destructive",
      })
    } finally {
      setIsAuthenticating(false)
    }
  }

  // Disconnect wallet and clear owner UID
  const handleDisconnect = () => {
    if (confirm("Disconnect wallet and clear authentication?")) {
      clearUid()
      toast({
        title: "Disconnected",
        description: "Wallet connection cleared",
      })
    }
  }

  const handleLogout = () => {
    if (confirm("Are you sure you want to log out?")) {
      clearUid()
      router.push("/")
      toast({
        title: "Logged out",
        description: "Your session has been cleared",
      })
    }
  }

  if (!mounted) {
    return null
  }

  // Owner access: Verified UID must exactly match NEXT_PUBLIC_OWNER_UID
  const isOwner = uidData.status === "success" && uidData.uid === config.ownerUid
  const isConnected = uidData.status === "success"

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
            <Button onClick={handleLogout} variant="outline" size="sm" className="gap-2 bg-transparent">
              <LogOut className="h-4 w-4" />
              Logout
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">Your account settings</p>
          {isConnected && piUsername && <p className="text-xs text-muted-foreground mt-1">@{piUsername}</p>}
        </div>

        {/* Wallet Connection Status */}
        <Card className={isConnected ? "border-green-200 bg-green-50" : "border-yellow-200 bg-yellow-50"}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="h-5 w-5" />
              Wallet Connection
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isConnected ? (
              <div className="space-y-3">
                <div className="text-sm">
                  <p className="font-medium text-green-900">Wallet Connected</p>
                  <p className="text-xs text-green-700 mt-1">Your wallet has been authenticated with FlashPay</p>
                </div>
                <Button onClick={handleDisconnect} variant="outline" className="w-full gap-2">
                  Disconnect Wallet
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-yellow-900">
                  Connect your Pi Wallet to access your profile features
                </p>
                <Button 
                  onClick={handleConnectWallet} 
                  disabled={isAuthenticating}
                  className="w-full gap-2"
                >
                  <Wallet className="h-4 w-4" />
                  {isAuthenticating ? "Connecting..." : "Connect Wallet"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

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
  return <ProfileContent />
}
