"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, CheckCircle2, LogOut, Search, Shield, Wallet } from "lucide-react"

import CustomerRefundStatusCard from "@/components/customer-refund-status-card"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useToast } from "@/hooks/use-toast"
import { config } from "@/lib/config"
import type { RefundPresentation } from "@/lib/types"
import { unifiedStore } from "@/lib/unified-store"
import { useMerchant } from "@/lib/use-merchant"
import { useOwnerUid } from "@/lib/use-owner-uid"

interface OperationalPayment {
  paymentId: string
  amount: number
  status: string
  settlementFailureState: string
  settlementFailureCode?: string
  nextRetryAt?: string
  refundStatus: string
  refundPresentation?: RefundPresentation
}

interface ProfileSummary {
  operationalPayments?: OperationalPayment[]
  settledTransactions: number
  totalSettledAmount: number
}

function isCompletedRefund(item: OperationalPayment): boolean {
  return item.refundPresentation?.merchantStatus === "refund_completed"
}

function needsAttention(item: OperationalPayment): boolean {
  if (isCompletedRefund(item)) return false
  if (item.status === "refunded" || item.refundStatus === "completed" || item.settlementFailureState === "refunded") return false

  return (
    item.refundPresentation?.merchantStatus === "refund_pending" ||
    item.refundPresentation?.merchantStatus === "refund_confirmed" ||
    item.refundPresentation?.merchantStatus === "refund_attention_required" ||
    item.status === "paid_to_app" ||
    item.status === "settlement_pending" ||
    item.status === "settlement_failed" ||
    item.status === "refund_pending" ||
    item.settlementFailureState === "manual_review_required" ||
    item.settlementFailureState === "held" ||
    item.settlementFailureState === "retryable" ||
    item.settlementFailureState === "reconciling" ||
    item.settlementFailureState === "refund_pending" ||
    item.refundStatus === "pending" ||
    item.refundStatus === "submitted" ||
    item.refundStatus === "failed" ||
    item.refundStatus === "manual_review_required" ||
    Boolean(item.nextRetryAt)
  )
}

function attentionLabel(item: OperationalPayment): string {
  if (item.refundPresentation?.merchantStatus === "refund_pending" || item.refundPresentation?.merchantStatus === "refund_confirmed") return "Refund in progress"
  if (item.refundPresentation?.merchantStatus === "refund_attention_required") return "Refund requires attention"
  if (item.settlementFailureState === "manual_review_required" || item.refundStatus === "manual_review_required") return "Manual review required"
  if (item.settlementFailureState === "held") return "Held for settlement safety"
  if (item.refundStatus === "failed") return "Refund review required"
  if (item.status === "settlement_failed") return "Settlement review required"
  if (item.settlementFailureState === "retryable" || item.nextRetryAt) return "Automatic retry scheduled"
  if (item.status === "paid_to_app" || item.status === "settlement_pending" || item.settlementFailureState === "reconciling") return "Settlement processing"
  return "Processing"
}

export default function ProfilePage() {
  const router = useRouter()
  const { toast } = useToast()
  const merchantState = useMerchant()
  const { uidData, verifyUid, clearUid } = useOwnerUid()

  const [mounted, setMounted] = useState(false)
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const [summary, setSummary] = useState<ProfileSummary | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [searchId, setSearchId] = useState("")
  const [openRefundReceipts, setOpenRefundReceipts] = useState<Record<string, boolean>>({})

  useEffect(() => setMounted(true), [])

  const merchantAuthenticated = Boolean(merchantState.merchantId.trim() && merchantState.accessToken?.trim())
  const merchantUsername = merchantState.piUsername?.trim() || merchantState.merchantId.trim()
  const isOwner = Boolean(config.ownerUid) && (
    (uidData.status === "success" && uidData.uid === config.ownerUid) ||
    (merchantAuthenticated && merchantState.uid === config.ownerUid)
  )

  useEffect(() => {
    const controller = new AbortController()

    const fetchProfileSummary = async () => {
      if (!merchantState.merchantId || !merchantState.accessToken) {
        setSummary(null)
        setSummaryError(null)
        setSummaryLoading(false)
        return
      }

      setSummary(null)
      setSummaryError(null)
      setSummaryLoading(true)

      try {
        const response = await fetch(
          `${config.appUrl}/api/profile?merchantId=${encodeURIComponent(merchantState.merchantId)}`,
          {
            headers: { Authorization: `Bearer ${merchantState.accessToken}` },
            signal: controller.signal,
          },
        )

        if (controller.signal.aborted) return
        if (!response.ok) {
          setSummaryError(`Failed to load profile: ${response.statusText}`)
          return
        }

        const data = await response.json()
        if (!controller.signal.aborted) setSummary(data)
      } catch (error) {
        if (!controller.signal.aborted) {
          setSummaryError(error instanceof Error ? error.message : "Error loading profile")
        }
      } finally {
        if (!controller.signal.aborted) setSummaryLoading(false)
      }
    }

    void fetchProfileSummary()
    return () => controller.abort()
  }, [merchantState.merchantId, merchantState.accessToken])

  const attentionPayments = useMemo(
    () => (summary?.operationalPayments ?? []).filter(needsAttention),
    [summary?.operationalPayments],
  )

  const completedRefunds = useMemo(
    () => (summary?.operationalPayments ?? []).filter(isCompletedRefund),
    [summary?.operationalPayments],
  )

  const handleConnectWallet = async () => {
    setIsAuthenticating(true)
    try {
      if (!window.Pi || typeof window.Pi.authenticate !== "function") throw new Error("Pi SDK not available")

      const authResult = await window.Pi.authenticate(["username", "payments", "wallet_address"], () => {})
      if (!authResult?.user) throw new Error("No user data from Pi Network")

      const uid = authResult.user.uid || authResult.user.userId || authResult.user.user_id || authResult.user.app_uid || authResult.user.appUid || ""
      const accessToken = authResult.accessToken
      if (!uid) throw new Error("No user ID returned")
      if (!accessToken) throw new Error("No access token returned")

      const username = authResult.user.username || ""
      const walletAddress = authResult.user.wallet_address || ""
      const verifyResult = await verifyUid(uid, accessToken, username)
      if (!verifyResult.success) throw new Error(verifyResult.error || "Owner verification failed")

      unifiedStore.completeMerchantSetup(username, walletAddress, uid)
      unifiedStore.updateMerchantState({ accessToken })
      toast({ title: "Connected", description: `Verified by Pi Network as @${username}` })
    } catch (error) {
      toast({
        title: "Connection Failed",
        description: error instanceof Error ? error.message : "Failed to connect wallet",
        variant: "destructive",
      })
    } finally {
      setIsAuthenticating(false)
    }
  }

  const handleLogout = () => {
    if (!confirm("Are you sure you want to log out?")) return
    clearUid()
    unifiedStore.clearMerchantAuth()
    router.push("/")
    toast({ title: "Logged out", description: "Your session has been cleared" })
  }

  const handleReceiptSearch = () => {
    const id = searchId.trim()
    if (!id) {
      toast({ title: "Enter a FlashPay ID", description: "Use the FlashPay ID shown on the payment or receipt.", variant: "destructive" })
      return
    }
    router.push(`/receipts/${encodeURIComponent(id)}`)
  }

  if (!mounted) return null

  return (
    <div className="min-h-screen pb-20 pt-4">
      <div className="mx-auto max-w-4xl space-y-6 px-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Shield className="h-6 w-6 text-primary" />
              <h1 className="text-2xl font-bold">Merchant Workspace</h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">Your FlashPay business account</p>
          </div>
          <Button onClick={handleLogout} variant="outline" size="sm" className="gap-2 bg-transparent">
            <LogOut className="h-4 w-4" />
            Logout
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Merchant</CardTitle>
            <CardDescription>Identity and Pi connection status</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-medium uppercase text-muted-foreground">Merchant identity</p>
                <p className="mt-1 text-lg font-semibold">{merchantAuthenticated ? `@${merchantUsername}` : "Not connected"}</p>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Wallet className="h-4 w-4" />
                <span className={merchantAuthenticated ? "font-medium text-green-700" : "text-muted-foreground"}>
                  {merchantAuthenticated ? "Pi connected" : "Pi not connected"}
                </span>
              </div>
            </div>
            {!merchantAuthenticated && (
              <p className="text-sm text-muted-foreground">Authenticate from Home to load your merchant workspace.</p>
            )}
            {isOwner && uidData.status !== "success" && (
              <Button onClick={handleConnectWallet} disabled={isAuthenticating} variant="outline" className="w-full">
                {isAuthenticating ? "Connecting..." : "Verify owner wallet"}
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Business Overview</CardTitle>
            <CardDescription>Simple merchant-facing totals from the authoritative profile read model</CardDescription>
          </CardHeader>
          <CardContent>
            {!merchantAuthenticated ? (
              <p className="text-sm text-muted-foreground">Connect your merchant account to view business totals.</p>
            ) : summaryLoading ? (
              <p className="text-sm text-muted-foreground">Loading business overview...</p>
            ) : summaryError ? (
              <p className="text-sm text-destructive">{summaryError}</p>
            ) : summary ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="rounded-lg border p-4">
                  <p className="text-xs font-medium uppercase text-muted-foreground">Total Sales</p>
                  <p className="mt-2 text-2xl font-bold">{summary.totalSettledAmount.toFixed(2)}π</p>
                </div>
                <div className="rounded-lg border p-4">
                  <p className="text-xs font-medium uppercase text-muted-foreground">Successful Payments</p>
                  <div className="mt-2 flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-green-700" />
                    <p className="text-2xl font-bold">{summary.settledTransactions}</p>
                  </div>
                </div>
                <div className="rounded-lg border p-4">
                  <p className="text-xs font-medium uppercase text-muted-foreground">Needs Attention</p>
                  <div className="mt-2 flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5 text-amber-700" />
                    <p className="text-2xl font-bold">{attentionPayments.length}</p>
                  </div>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Find a Receipt</CardTitle>
            <CardDescription>Search using the customer-facing FlashPay ID only</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault()
                handleReceiptSearch()
              }}
            >
              <Input
                value={searchId}
                onChange={(event) => setSearchId(event.target.value)}
                placeholder="FlashPay ID"
                autoComplete="off"
                spellCheck={false}
              />
              <Button type="submit" className="gap-2 sm:w-auto">
                <Search className="h-4 w-4" />
                Search
              </Button>
            </form>
          </CardContent>
        </Card>

        {attentionPayments.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Needs Attention</CardTitle>
              <CardDescription>Payments still processing or requiring review</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {attentionPayments.map((item) => (
                <button
                  key={item.paymentId}
                  type="button"
                  onClick={() => router.push(`/receipts/${encodeURIComponent(item.paymentId)}`)}
                  className="w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/50"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 break-all text-sm font-semibold">{item.paymentId}</span>
                    <span className="shrink-0 font-semibold">{item.amount.toFixed(2)}π</span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{attentionLabel(item)}</p>
                </button>
              ))}
            </CardContent>
          </Card>
        )}

        {completedRefunds.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Completed Refunds</CardTitle>
              <CardDescription>Kept visible for now; presentation dismissal is handled in K7</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {completedRefunds.map((item) => (
                <div key={item.paymentId} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 break-all text-sm font-semibold">{item.paymentId}</span>
                    <span className="shrink-0 font-semibold">{item.amount.toFixed(2)}π</span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => setOpenRefundReceipts((current) => ({ ...current, [item.paymentId]: !current[item.paymentId] }))}
                  >
                    {openRefundReceipts[item.paymentId] ? "Hide refund receipt" : "View refund receipt"}
                  </Button>
                  {openRefundReceipts[item.paymentId] && item.refundPresentation && (
                    <div className="mt-3">
                      <CustomerRefundStatusCard presentation={item.refundPresentation} status="ready" audience="merchant" />
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {isOwner && (
          <Card className="border-primary">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Operations Console
              </CardTitle>
              <CardDescription>Owner-only platform operations</CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={() => router.push("/operations")} className="w-full">Open Operations Console</Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
