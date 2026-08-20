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
import type { RefundPresentation } from "@/lib/types"
import { Shield, BarChart3, ArrowRight, LogOut, History, Wallet, Loader2 } from "lucide-react"

type SettlementStatus = "settled_to_merchant" | "pending" | "paid_to_app" | "settlement_pending" | "failed" | "settlement_failed" | "cancelled" | "completed" | string | null | undefined

const profileDateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
})

function formatProfileDateTime(createdAt: string): string {
  const date = new Date(createdAt)
  if (!Number.isFinite(date.getTime())) {
    return "Unavailable"
  }
  return profileDateFormatter.format(date)
}

function mapSettlementStatus(status: SettlementStatus): string {
  if (status === "settled_to_merchant") return "Settled"
  if (status === "pending" || status === "paid_to_app" || status === "settlement_pending") return "Processing"
  if (status === "failed" || status === "settlement_failed") return "Failed"
  if (status === "cancelled") return "Cancelled"
  if (status === "completed") return "Legacy Completed"
  return "Other"
}

function merchantAttentionStatus(item: OperationalPayment): string {
  if (item.refundPresentation?.merchantStatus === "refund_pending" || item.refundPresentation?.merchantStatus === "refund_confirmed") return "Failed — Refunding customer"
  if (item.refundPresentation?.merchantStatus === "refund_completed") return "Failed — Refunded to customer"
  if (item.refundPresentation?.merchantStatus === "refund_attention_required") return "Failed — Refund requires attention"
  if (
    item.settlementFailureState === "manual_review_required" ||
    item.refundStatus === "manual_review_required"
  ) return "Manual review required"
  if (item.settlementFailureState === "held") return "Held for settlement safety"
  if (
    item.status === "refund_pending" ||
    item.settlementFailureState === "refund_pending" ||
    item.refundStatus === "pending" ||
    item.refundStatus === "submitted"
  ) return "Refund pending"
  if (item.refundStatus === "failed") return "Refund failed — review required"
  if (item.status === "settlement_failed") return "Settlement failed — review required"
  if (item.settlementFailureState === "retryable" || item.nextRetryAt) return "Automatic retry scheduled"
  if (
    item.status === "paid_to_app" ||
    item.status === "settlement_pending" ||
    item.settlementFailureState === "reconciling"
  ) return "Settlement processing"
  return "Review required"
}

interface OperationalPayment {
  paymentId: string
  amount: number
  status: string
  settlementFailureState: string
  settlementFailureCode?: string
  heldAt?: string
  nextRetryAt?: string
  refundStatus: string
  refundPaymentId?: string
  refundTxid?: string
  u2aTxid?: string
  a2uPaymentId?: string
  a2uTxid?: string
  refundPresentation?: RefundPresentation
  updatedAt?: string
}

interface ProfileSummary {
  operationalPayments?: OperationalPayment[]
  totalTransactions: number
  settledTransactions: number
  totalSettledAmount: number
  pendingTransactions: number
  totalAwaitingAmount: number
  failedTransactions: number
  totalFailedAmount: number
  cancelledTransactions: number
  totalCancelledAmount: number
  completedTransactions: number
  totalCompletedAmount: number
  latestTransaction: {
    transactionId: string
    reference: string
    amount: number
    createdAt: string
    settlementStatus: string | null
  } | null
}

function ProfileContent() {
  const router = useRouter()
  const { toast } = useToast()
  const [mounted, setMounted] = useState(false)
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [summary, setSummary] = useState<ProfileSummary | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [openRefundReceipts, setOpenRefundReceipts] = useState<Record<string, boolean>>({})

  // Owner UID verification — stores result separately from payment system
  const { uidData, verifyUid, clearUid } = useOwnerUid()
  const piUsername = uidData.username
  const copyRefundReceipt = async (presentation: RefundPresentation) => {
    const fields = [
      ["Amount", `${presentation.amount}π`],
      ["Payment ID", presentation.paymentId],
      ["Refund ID", presentation.refundId],
      ["Refund payment ID", presentation.refundPaymentId],
      ["Refund transaction ID", presentation.refundTxid],
      ["Network", presentation.blockchain.network],
      ["Requested at", presentation.requestedAt ? formatProfileDateTime(presentation.requestedAt) : ""],
      ["Blockchain transaction at", presentation.blockchain.transactionAt ? formatProfileDateTime(presentation.blockchain.transactionAt) : ""],
      ["Completed at", presentation.finalization.completedAt ? formatProfileDateTime(presentation.finalization.completedAt) : ""],
      ["Finalized at", presentation.finalization.finalizedAt ? formatProfileDateTime(presentation.finalization.finalizedAt) : ""],
    ].filter(([, value]) => Boolean(value))
    await navigator.clipboard.writeText(fields.map(([label, value]) => `${label}: ${value}`).join("\n"))
  }
  
  // Canonical merchant state for continuity
  const merchantState = useMerchant()

  useEffect(() => {
    setMounted(true)
  }, [])

  // Fetch profile summary when merchant state changes
  useEffect(() => {
    const controller = new AbortController()

    const fetchProfileSummary = async () => {
      // Clear if credentials missing
      if (!merchantState.merchantId || !merchantState.accessToken) {
        setSummary(null)
        setSummaryError(null)
        setSummaryLoading(false)
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
          signal: controller.signal,
        })

        if (controller.signal.aborted) return

        if (!response.ok) {
          setSummary(null)
          setSummaryError(`Failed to load profile: ${response.statusText}`)
          return
        }

        const data = await response.json()

        if (controller.signal.aborted) return

        setSummary(data)
      } catch (err) {
        if (controller.signal.aborted) return

        setSummary(null)
        setSummaryError(err instanceof Error ? err.message : "Error loading profile")
      } finally {
        if (!controller.signal.aborted) {
          setSummaryLoading(false)
        }
      }
    }

    fetchProfileSummary()
    return () => controller.abort()
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

  // Merchant authentication and username
  const merchantAuthenticated = Boolean(merchantState.merchantId.trim() && merchantState.accessToken?.trim())
  const merchantUsername = merchantState.piUsername?.trim() || merchantState.merchantId.trim()

  // Owner-only visibility for Wallet Connection card
  const showOwnerWalletCard = merchantAuthenticated && Boolean(config.ownerUid) && Boolean(merchantState.uid) && merchantState.uid === config.ownerUid

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
          {merchantAuthenticated && <p className="text-xs text-muted-foreground mt-1">@{merchantUsername}</p>}
        </div>

        {/* Wallet Connection Status */}
        {showOwnerWalletCard && (
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
        )}

        {/* Profile Summary */}
        <Card>
          <CardHeader>
            <CardTitle>Profile Summary</CardTitle>
          </CardHeader>
          <CardContent>
            {!merchantAuthenticated ? (
              <p className="text-sm text-muted-foreground">
                Authenticate from Home to load your merchant profile
              </p>
            ) : summaryLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading profile...</span>
              </div>
            ) : summaryError ? (
              <p className="text-sm text-destructive">{summaryError}</p>
            ) : summary ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
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
                    <p className="text-lg font-semibold">{summary.totalSettledAmount.toFixed(2)}π</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Pending Transactions</p>
                    <p className="text-lg font-semibold">{summary.pendingTransactions}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Total Awaiting Amount</p>
                    <p className="text-lg font-semibold">{summary.totalAwaitingAmount.toFixed(2)}π</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Failed Transactions</p>
                    <p className="text-lg font-semibold">{summary.failedTransactions}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Total Failed Amount</p>
                    <p className="text-lg font-semibold">{summary.totalFailedAmount.toFixed(2)}π</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Cancelled Transactions</p>
                    <p className="text-lg font-semibold">{summary.cancelledTransactions}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Total Cancelled Amount</p>
                    <p className="text-lg font-semibold">{summary.totalCancelledAmount.toFixed(2)}π</p>
                  </div>
                  {(summary.completedTransactions > 0 || summary.totalCompletedAmount > 0) && (
                    <>
                      <div>
                        <p className="text-xs text-muted-foreground">Legacy Completed Transactions</p>
                        <p className="text-lg font-semibold">{summary.completedTransactions}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Legacy Completed Amount</p>
                        <p className="text-lg font-semibold">{summary.totalCompletedAmount.toFixed(2)}π</p>
                      </div>
                    </>
                  )}
                </div>
                {summary.operationalPayments &&
                  summary.operationalPayments.filter(
                    (item) =>
                      item.refundPresentation?.merchantStatus === "refund_completed" ||
                      (item.status !== "refunded" &&
                        item.refundStatus !== "completed" &&
                        item.settlementFailureState !== "refunded"),
                  ).length > 0 && (
                    <div className="pt-3 border-t space-y-3">
                      <div>
                        <p className="text-xs font-medium text-muted-foreground">Payments Requiring Attention</p>
                        <p className="text-sm text-muted-foreground">Payments still being settled or requiring action.</p>
                      </div>
                      {summary.operationalPayments
                        .filter(
                          (item) =>
                            item.refundPresentation?.merchantStatus === "refund_completed" || (item.status !== "refunded" && item.refundStatus !== "completed" && item.settlementFailureState !== "refunded"),
                        )
                        .map((item) => (
                          <div key={item.paymentId} className="rounded-md border p-3 text-sm">
                            <div className="flex items-center justify-between gap-3">
                              <span className="font-medium">{item.paymentId}</span>
                              <span>{item.amount.toFixed(2)}π</span>
                            </div>
                            <p className="text-muted-foreground mt-1">{merchantAttentionStatus(item)}</p>
                            {item.refundPresentation?.merchantStatus === "refund_completed" && (
                              <div className="mt-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setOpenRefundReceipts((current) => ({ ...current, [item.paymentId]: !current[item.paymentId] }))}
                                >
                                  {openRefundReceipts[item.paymentId] ? "Hide refund receipt" : "Tap to view refund receipt"}
                                </Button>
                                {openRefundReceipts[item.paymentId] && (
                                  <div className="mt-2 rounded-md border bg-muted/30 p-2 text-xs space-y-1">
                                    <p><span className="text-muted-foreground">Amount:</span> {item.refundPresentation.amount}π</p>
                                    <p><span className="text-muted-foreground">Payment ID:</span> {item.refundPresentation.paymentId}</p>
                                    <p><span className="text-muted-foreground">Refund ID:</span> {item.refundPresentation.refundId}</p>
                                    {item.refundPresentation.refundPaymentId && <p><span className="text-muted-foreground">Refund payment ID:</span> {item.refundPresentation.refundPaymentId}</p>}
                                    {item.refundPresentation.refundTxid && <p><span className="text-muted-foreground">Refund transaction ID:</span> {item.refundPresentation.refundTxid}</p>}
                                    {item.refundPresentation.blockchain.network && <p><span className="text-muted-foreground">Network:</span> {item.refundPresentation.blockchain.network}</p>}
                                    {item.refundPresentation.requestedAt && <p><span className="text-muted-foreground">Requested at:</span> {formatProfileDateTime(item.refundPresentation.requestedAt)}</p>}
                                    {item.refundPresentation.blockchain.transactionAt && <p><span className="text-muted-foreground">Blockchain transaction at:</span> {formatProfileDateTime(item.refundPresentation.blockchain.transactionAt)}</p>}
                                    {item.refundPresentation.finalization.completedAt && <p><span className="text-muted-foreground">Completed at:</span> {formatProfileDateTime(item.refundPresentation.finalization.completedAt)}</p>}
                                    {item.refundPresentation.finalization.finalizedAt && <p><span className="text-muted-foreground">Finalized at:</span> {formatProfileDateTime(item.refundPresentation.finalization.finalizedAt)}</p>}
                                    <Button type="button" variant="ghost" size="sm" onClick={() => void copyRefundReceipt(item.refundPresentation!)}>Copy receipt</Button>
                                  </div>
                                )}
                              </div>
                            )}
                            {item.nextRetryAt && (
                              <p className="text-xs text-muted-foreground">Next retry: {formatProfileDateTime(item.nextRetryAt)}</p>
                            )}
                          </div>
                        ))}
                    </div>
                  )}
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
                        <span className="text-muted-foreground">Date:</span> {formatProfileDateTime(summary.latestTransaction.createdAt)}
                      </p>
                      {summary.latestTransaction.settlementStatus && (
                        <p>
                          <span className="text-muted-foreground">Status:</span> {mapSettlementStatus(summary.latestTransaction.settlementStatus)}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : null}
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
