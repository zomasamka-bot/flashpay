"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { useRouter } from "next/navigation"

import { ROUTES } from "@/lib/router"
import { useOwnerUid } from "@/lib/use-owner-uid"
import { config } from "@/lib/config"
import { useToast } from "@/hooks/use-toast"
import { useMerchant } from "@/lib/use-merchant"
import { unifiedStore } from "@/lib/unified-store"
import { Shield, BarChart3, ArrowRight, LogOut, History, Wallet, Loader2 } from "lucide-react"

interface ProfileSummary {
  totalTransactions: number
  settledTransactions: number
  totalSettledAmount: number
  latestTransaction?: {
    reference: string
    amount: number
    createdAt: string
    settlementStatus?: string
  }
}

function ProfileContent() {
  const router = useRouter()
  const { toast } = useToast()
  const [mounted, setMounted] = useState(false)
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [summary, setSummary] = useState<ProfileSummary | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)

  // Owner UID verification — stores result separately from payment system
  const { uidData, verifyUid, clearUid } = useOwnerUid()
  const piUsername = uidData.username
  
  // Canonical merchant state for continuity
  const merchantState = useMerchant()

  useEffect(() => {
    setMounted(true)
  }, [])

  // Fetch profile summary when merchant state changes
  useEffect(() => {
    const fetchProfileSummary = async () => {
      // Clear if credentials missing
      if (!merchantState.merchantId || !merchantState.accessToken) {
        setSummary(null)
        setSummaryError(null)
        return
      }

      // Clear before request
      setSummary(null)
      setSummaryError(null)
      setSummaryLoading(true)

      try {
        const url = `${config.appUrl}/api/profile?merchantId=${encodeURIComponent(merchantState.merchantId)}`
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${merchantState.accessToken}`,
          },
        })

        if (!response.ok) {
          setSummary(null)
          setSummaryError(`Failed to load profile: ${response.statusText}`)
          return
        }

        const data = await response.json()
        setSummary(data)
      } catch (err) {
        setSummary(null)
        setSummaryError(err instanceof Error ? err.message : "Error loading profile")
      } finally {
        setSummaryLoading(false)
      }
    }

    fetchProfileSummary()
  }, [merchantState.merchantId, merchantState.accessToken])



  // Profile authentication - verifies owner AND persists to canonical merchant state
  const handleConnectWallet = async () => {
    setIsAuthenticating(true)

    try {
      if (!window.Pi || typeof window.Pi.authenticate !== "function") {
        throw new Error("Pi SDK not available")
      }

      // Call Pi.authenticate with owner scopes
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
      const walletAddress = authResult.user.wallet_address || ""

      // PHASE 1: Store in isolated ownerUidStore and verify against NEXT_PUBLIC_OWNER_UID
      const verifyResult = await verifyUid(uid, accessToken, username)

      if (!verifyResult.success) {
        throw new Error(verifyResult.error || "Owner verification failed")
      }

      // PHASE 1: Persist same verified identity through canonical merchant state
      // This bridges Profile auth to the merchant pages (Home, Payments, etc.)
      unifiedStore.completeMerchantSetup(username, walletAddress, uid)
      unifiedStore.updateMerchantState({ accessToken })

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

  // Disconnect wallet and clear both owner UID and merchant state
  const handleDisconnect = () => {
    if (confirm("Disconnect wallet and clear authentication?")) {
      // Clear from both stores for consistent state
      clearUid()
      unifiedStore.clearMerchantAuth()
      
      toast({
        title: "Disconnected",
        description: "Wallet connection cleared",
      })
    }
  }

  const handleLogout = () => {
    if (confirm("Are you sure you want to log out?")) {
      // Clear from both stores for consistent state
      clearUid()
      unifiedStore.clearMerchantAuth()
      
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

        {/* Profile Summary */}
        {isConnected && (
          <Card>
            <CardHeader>
              <CardTitle>Profile Summary</CardTitle>
            </CardHeader>
            <CardContent>
              {summaryLoading && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Loading profile...</span>
                </div>
              )}
              {summaryError && !summaryLoading && (
                <p className="text-sm text-destructive">{summaryError}</p>
              )}
              {summary && !summaryLoading && (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <p className="text-xs text-muted-foreground">Total Transactions</p>
                      <p className="text-lg font-semibold">{summary.totalTransactions}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Settled Transactions</p>
                      <p className="text-lg font-semibold">{summary.settledTransactions}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Total Settled Amount</p>
                      <p className="text-lg font-semibold">π{summary.totalSettledAmount}</p>
                    </div>
                  </div>
                  {summary.latestTransaction && (
                    <div className="pt-3 border-t">
                      <p className="text-xs font-medium text-muted-foreground mb-2">Latest Transaction</p>
                      <div className="space-y-1 text-sm">
                        <p>
                          <span className="text-muted-foreground">Reference:</span> {summary.latestTransaction.reference}
                        </p>
                        <p>
                          <span className="text-muted-foreground">Amount:</span> π{summary.latestTransaction.amount}
                        </p>
                        <p>
                          <span className="text-muted-foreground">Date:</span> {summary.latestTransaction.createdAt}
                        </p>
                        {summary.latestTransaction.settlementStatus && (
                          <p>
                            <span className="text-muted-foreground">Status:</span> {summary.latestTransaction.settlementStatus}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

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
