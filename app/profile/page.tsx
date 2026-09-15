"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useRouter } from "next/navigation"

import { getReceiptLink, ROUTES } from "@/lib/router"
import { useOwnerUid } from "@/lib/use-owner-uid"
import { config } from "@/lib/config"
import { useToast } from "@/hooks/use-toast"
import { useMerchant } from "@/lib/use-merchant"
import CustomerRefundStatusCard from "@/components/customer-refund-status-card"
import { unifiedStore } from "@/lib/unified-store"
import type { RefundPresentation } from "@/lib/types"
import { Shield, BarChart3, ArrowRight, LogOut, History, Wallet, Loader2, Search } from "lucide-react"
import { useI18n } from "@/components/i18n-provider"

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

function merchantAttentionStatus(item: OperationalPayment, t: (key: string) => string): string {
  if (item.refundPresentation?.merchantStatus === "refund_pending" || item.refundPresentation?.merchantStatus === "refund_confirmed") return t("profile.attention.refunding")
  if (item.refundPresentation?.merchantStatus === "refund_completed") return t("profile.attention.refunded")
  if (item.refundPresentation?.merchantStatus === "refund_attention_required") return t("profile.attention.refundAttention")
  if (
    item.settlementFailureState === "manual_review_required" ||
    item.refundStatus === "manual_review_required"
  ) return t("profile.attention.manualReview")
  if (item.settlementFailureState === "held") return t("profile.attention.held")
  if (
    item.status === "refund_pending" ||
    item.settlementFailureState === "refund_pending" ||
    item.refundStatus === "pending" ||
    item.refundStatus === "submitted"
  ) return t("profile.attention.refundPending")
  if (item.refundStatus === "failed") return t("profile.attention.refundFailed")
  if (item.status === "settlement_failed") return t("profile.attention.settlementFailed")
  if (item.settlementFailureState === "retryable" || item.nextRetryAt) return t("profile.attention.retryScheduled")
  if (
    item.status === "paid_to_app" ||
    item.status === "settlement_pending" ||
    item.settlementFailureState === "reconciling"
  ) return t("profile.attention.settlementProcessing")
  return t("profile.attention.reviewRequired")
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
  const { t } = useI18n()
  const { toast } = useToast()
  const [mounted, setMounted] = useState(false)
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [summary, setSummary] = useState<ProfileSummary | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [openRefundReceipts, setOpenRefundReceipts] = useState<Record<string, boolean>>({})
  const [dismissingRefundId, setDismissingRefundId] = useState<string | null>(null)
  const [receiptSearchId, setReceiptSearchId] = useState("")

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

  const handleDismissCompletedRefund = async (paymentId: string) => {
    if (!merchantState.merchantId || !merchantState.accessToken || dismissingRefundId) return
    setDismissingRefundId(paymentId)
    try {
      const response = await fetch(`${config.appUrl}/api/profile`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${merchantState.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          merchantId: merchantState.merchantId,
          paymentId,
          action: "dismiss_completed_refund",
        }),
      })
      if (!response.ok) throw new Error("Could not remove this refund from Profile")

      setSummary((current) => current
        ? { ...current, operationalPayments: (current.operationalPayments ?? []).filter((item) => item.paymentId !== paymentId) }
        : current)
      setOpenRefundReceipts((current) => {
        const next = { ...current }
        delete next[paymentId]
        return next
      })
      toast({ title: "Removed from Profile", description: "The refund record and receipt remain available in financial records." })
    } catch (error) {
      toast({
        title: "Could not remove refund",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      })
    } finally {
      setDismissingRefundId(null)
    }
  }

  const handleReceiptSearch = () => {
    const flashPayId = receiptSearchId.trim()
    if (!flashPayId || flashPayId.length > 128) {
      toast({ title: "FlashPay ID required", description: "Enter a valid FlashPay ID.", variant: "destructive" })
      return
    }
    router.push(getReceiptLink(flashPayId))
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
              <h1 className="text-2xl font-bold">{t("profile.account")}</h1>
            </div>
            <Button onClick={handleLogout} variant="outline" size="sm" className="gap-2 bg-transparent">
              <LogOut className="h-4 w-4" />
              {t("profile.logout")}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">{t("profile.settings")}</p>
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
            <CardTitle>{t("profile.summary")}</CardTitle>
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
                    <p className="text-xs text-muted-foreground">{t("profile.totalTransactions")}</p>
                    <p className="text-lg font-semibold">{summary.totalTransactions}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t("profile.settledTransactions")}</p>
                    <p className="text-lg font-semibold">{summary.settledTransactions}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t("profile.totalSettledAmount")}</p>
                    <p className="text-lg font-semibold">{summary.totalSettledAmount.toFixed(2)}π</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t("profile.pendingTransactions")}</p>
                    <p className="text-lg font-semibold">{summary.pendingTransactions}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t("profile.totalAwaitingAmount")}</p>
                    <p className="text-lg font-semibold">{summary.totalAwaitingAmount.toFixed(2)}π</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t("profile.failedTransactions")}</p>
                    <p className="text-lg font-semibold">{summary.failedTransactions}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t("profile.totalFailedAmount")}</p>
                    <p className="text-lg font-semibold">{summary.totalFailedAmount.toFixed(2)}π</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t("profile.cancelledTransactions")}</p>
                    <p className="text-lg font-semibold">{summary.cancelledTransactions}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">{t("profile.totalCancelledAmount")}</p>
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
                        <p className="text-xs font-medium text-muted-foreground">{t("profile.attention.title")}</p>
                        <p className="text-sm text-muted-foreground">{t("profile.attention.description")}</p>
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
                            <p className="text-muted-foreground mt-1">{merchantAttentionStatus(item, t)}</p>
                            {item.refundPresentation?.merchantStatus === "refund_completed" && (
                              <div className="mt-2">
                                <div className="flex flex-wrap gap-2">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setOpenRefundReceipts((current) => ({ ...current, [item.paymentId]: !current[item.paymentId] }))}
                                  >
                                    {openRefundReceipts[item.paymentId] ? t("profile.attention.hideRefund") : t("profile.attention.viewRefund")}
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    disabled={dismissingRefundId !== null}
                                    onClick={() => void handleDismissCompletedRefund(item.paymentId)}
                                  >
                                    {dismissingRefundId === item.paymentId ? t("profile.attention.removing") : t("profile.attention.remove")}
                                  </Button>
                                </div>
                                {openRefundReceipts[item.paymentId] && (
                                  <CustomerRefundStatusCard presentation={item.refundPresentation} status="ready" audience="merchant" />
                                )}
                              </div>
                            )}
                            {item.nextRetryAt && (
                              <p className="text-xs text-muted-foreground">{t("profile.attention.nextRetry")}: {formatProfileDateTime(item.nextRetryAt)}</p>
                            )}
                          </div>
                        ))}
                    </div>
                  )}
                {summary.latestTransaction && (
                  <div className="pt-3 border-t">
                    <p className="text-xs font-medium text-muted-foreground mb-2">{t("profile.latestTransaction")}</p>
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
                <form
                  className="border-t pt-3"
                  onSubmit={(event) => {
                    event.preventDefault()
                    handleReceiptSearch()
                  }}
                >
                  <p className="mb-2 text-xs font-medium text-muted-foreground">{t("profile.findReceipt")}</p>
                  <div className="flex gap-2">
                    <Input
                      value={receiptSearchId}
                      onChange={(event) => setReceiptSearchId(event.target.value)}
                      placeholder="FlashPay ID"
                      autoComplete="off"
                      spellCheck={false}
                      aria-label="FlashPay ID"
                    />
                    <Button type="submit" variant="outline" className="shrink-0 gap-2">
                      <Search className="h-4 w-4" />
                      {t("profile.find")}
                    </Button>
                  </div>
                </form>
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
              {t("profile.paymentRequests")}
            </CardTitle>
            <CardDescription>{t("profile.paymentRequestsDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => router.push(ROUTES.MERCHANT_PAYMENTS)} className="w-full" size="lg" variant="outline">
              <BarChart3 className="h-4 w-4 mr-2" />
              {t("profile.viewPaymentRequests")}
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </CardContent>
        </Card>

        {/* Transaction History Access */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <History className="h-5 w-5" />
              {t("profile.transactionHistory")}
            </CardTitle>
            <CardDescription>{t("profile.transactionHistoryDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => router.push("/transactions")} className="w-full" size="lg" variant="outline">
              <History className="h-4 w-4 mr-2" />
              {t("profile.viewAllTransactions")}
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
