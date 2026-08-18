"use client"

import { useEffect, useRef, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { ExternalLink, Copy } from "lucide-react"
import { initializePiSDK, authenticateCustomer, authenticateCustomerForRefundRead } from "@/lib/pi-sdk"
import { readCustomerRefundPresentationClient } from "@/lib/customer-refund-presentation-client"
import CustomerRefundStatusCard from "@/components/customer-refund-status-card"
import { useToast } from "@/hooks/use-toast"
import { QRCode } from "@/components/qr-code"
import { executePayment, isPaymentPaid, getPaymentFromServer } from "@/lib/operations"
import { getPiNetUrl } from "@/lib/router"
import { unifiedStore } from "@/lib/unified-store"
import type { Payment, RefundPresentation } from "@/lib/types"

// UI-only mapper for settlement status display
function mapSettlementStatusForDisplay(status: string): string {
  const lowerStatus = status.toLowerCase()
  if (lowerStatus === "settled_to_merchant") return "Settled"
  if (lowerStatus === "pending" || lowerStatus === "paid_to_app" || lowerStatus === "settlement_pending") return "Processing"
  if (lowerStatus === "failed" || lowerStatus === "settlement_failed") return "Failed"
  if (lowerStatus === "cancelled") return "Cancelled"
  return "Other"
}

export default function PaymentContentWithId({ 
  paymentId, 
  urlAmount, 
  urlNote,
  entry = "pi"
}: { 
  paymentId: string
  urlAmount?: string
  urlNote?: string
  entry?: "pi" | "share"
}) {
  // Debug: Log props received from server route
  console.log("[v0][PaymentContentWithId] Component initialized with props:", { paymentId, urlAmount, urlNote, entry })

  const { toast } = useToast()
  const [payment, setPayment] = useState<Payment | null>(null)
  const [loading, setLoading] = useState(true)
  const [isPaying, setIsPaying] = useState(false)
  const [piSDKReady, setPiSDKReady] = useState(false)
  const [authStatus, setAuthStatus] = useState<"idle" | "authenticating" | "authenticated" | "failed">("idle")
  const [diagnostics, setDiagnostics] = useState<string[]>([])
  const [entryMode, setEntryMode] = useState<"pi" | "share">(entry)
  const [authoritativeLoaded, setAuthoritativeLoaded] = useState(false)
  const [refundPresentation, setRefundPresentation] = useState<RefundPresentation | undefined>()
  const [refundViewStatus, setRefundViewStatus] = useState<"loading" | "ready" | "indeterminate">("loading")
  const refundAccessTokenRef = useRef<string | null>(null)
  const refundFlowActiveRef = useRef(false)
  const refundAbortRef = useRef<AbortController | null>(null)

  const addDiagnostic = (message: string) => {
    const timestamp = new Date().toLocaleTimeString()
    setDiagnostics(prev => [...prev, `[${timestamp}] ${message}`])
    console.log("[v0][Diagnostic]", message)
  }

  // Check if we have a stored payment ID from before auth (in case of redirect)
  useEffect(() => {
    if (typeof window !== "undefined") {
      const storedPaymentId = sessionStorage.getItem("flashpay_current_payment_id")
      
      if (storedPaymentId && storedPaymentId !== paymentId) {
        console.warn("[v0][PaymentPage] ⚠️ Payment ID mismatch after navigation!")
        console.warn("[v0][PaymentPage] Expected:", storedPaymentId)
        console.warn("[v0][PaymentPage] Got:", paymentId)
      }
    }
  }, [paymentId])

  // Detect entry mode from URL parameter (share or pi)
  useEffect(() => {
    if (typeof window !== "undefined") {
      const urlParams = new URLSearchParams(window.location.search)
      const mode = urlParams.get("entry") as "pi" | "share" | null
      const urlAmount = urlParams.get("amount")
      console.log("[v0][EntryMode] URL search string:", window.location.search)
      console.log("[v0][EntryMode] Parsed entry param:", mode)
      console.log("[v0][EntryMode] Parsed amount param:", urlAmount)
      console.log("[v0][EntryMode] entry prop received:", entry)
      
      if (mode === "share" || mode === "pi") {
        setEntryMode(mode)
        console.log("[v0][EntryMode] Detected entry mode from URL:", mode)
      } else if (urlAmount && !isNaN(parseFloat(urlAmount))) {
        // Default to 'pi' mode if amount is in URL but entry param missing
        // This handles QR codes that include amount but may lose entry param in some browsers
        setEntryMode("pi")
        console.log("[v0][EntryMode] Auto-detected pi mode from amount param in URL")
      } else {
        console.log("[v0][EntryMode] No entry mode detected, entry prop:", entry)
      }
    }
  }, [])

  useEffect(() => {
    let abortController: AbortController | null = null

    async function fetchPayment() {
      addDiagnostic(`Fetching payment: ${paymentId}`)
      
      try {
        // For entry=pi with URL amount, show provisionally and fetch authoritatively once
        const urlAmountStr = urlAmount || (typeof window !== "undefined" ? new URLSearchParams(window.location.search).get('amount') : null)
        const urlNoteStr = urlNote || (typeof window !== "undefined" ? new URLSearchParams(window.location.search).get('note') : null)
        
        if (entryMode === "pi" && urlAmountStr) {
          const amount = parseFloat(urlAmountStr)
          if (!isNaN(amount) && amount > 0) {
            // Show provisional payment data immediately
            const provisionalPayment: Payment = {
              id: paymentId,
              amount: amount,
              note: urlNoteStr || "",
              status: "pending",
              createdAt: new Date().toISOString(),
              merchantId: "unknown",
              accessToken: "",
            }
            console.log("[v0] ✅ Showing provisional payment from URL params:", provisionalPayment)
            setPayment(provisionalPayment)
            setLoading(false)
            
            // Fetch authoritative payment ONCE with short timeout
            try {
              abortController = new AbortController()
              const timeoutId = setTimeout(() => abortController?.abort(), 5000) // 5 second timeout
              
              const serverPayment = await getPaymentFromServer(paymentId, true, abortController.signal)
              clearTimeout(timeoutId)
              
              if (serverPayment) {
                console.log("[v0] ✅ Authoritative payment loaded:", serverPayment)
                setPayment(serverPayment)
                setAuthoritativeLoaded(true)
                // Store in unifiedStore for payment execution
                unifiedStore.createPaymentWithId(
                  serverPayment.id,
                  serverPayment.amount,
                  serverPayment.note || "",
                  serverPayment.createdAt,
                  serverPayment.merchantId,
                  serverPayment.merchantAddress,
                  serverPayment.merchantUid,
                  serverPayment.accessToken
                )
              } else {
                console.warn("[v0] ⚠️ Authoritative payment not available from server")
                addDiagnostic("Server payment not available - using provisional data")
                // Keep showing provisional payment, disable Pay button
              }
            } catch (fetchError) {
              console.warn("[v0] ⚠️ Failed to fetch authoritative payment:", fetchError)
              addDiagnostic(`Failed to fetch payment from server: ${fetchError}`)
              // Keep showing provisional payment, disable Pay button
            }
            return
          }
        }
        
        // Standard flow for non-pi entries or no URL amount - fetch once
        setLoading(true)
        
        try {
          abortController = new AbortController()
          const timeoutId = setTimeout(() => abortController?.abort(), 5000) // 5 second timeout
          
          const serverPayment = await getPaymentFromServer(paymentId, false, abortController.signal)
          clearTimeout(timeoutId)
          
          if (serverPayment) {
            console.log("[v0] ✅ Payment found from server:", serverPayment)
            setPayment(serverPayment)
            setAuthoritativeLoaded(true)
            unifiedStore.createPaymentWithId(
              serverPayment.id,
              serverPayment.amount,
              serverPayment.note || "",
              serverPayment.createdAt,
              serverPayment.merchantId,
              serverPayment.merchantAddress,
              serverPayment.merchantUid,
              serverPayment.accessToken
            )
          } else if (urlAmountStr) {
            // Fallback to URL parameters if no server payment
            const amount = parseFloat(urlAmountStr)
            if (!isNaN(amount) && amount > 0) {
              const fallbackPayment: Payment = {
                id: paymentId,
                amount: amount,
                note: urlNoteStr || "",
                status: "pending",
                createdAt: new Date().toISOString(),
                merchantId: "unknown",
                accessToken: "",
              }
              console.log("[v0] ✅ Created fallback payment from URL params:", fallbackPayment)
              setPayment(fallbackPayment)
            } else {
              console.error("[v0] ❌ Invalid amount in URL parameters:", urlAmountStr)
              setPayment(null)
            }
          } else {
            console.error("[v0] ❌ Payment NOT found and no URL parameters available")
            setPayment(null)
          }
        } catch (error) {
          console.error("[v0] Error fetching payment:", error)
          setPayment(null)
        }
        
        setLoading(false)
      } catch (error) {
        console.error("[v0] Error in fetchPayment:", error)
        setPayment(null)
        setLoading(false)
      }
    }

    async function initPiSDK() {
      // For Pi entry mode, wait for SDK readiness promise once
      if (entryMode === "pi") {
        try {
          if (window.__PI_SDK_READY__) {
            addDiagnostic("Awaiting Pi SDK readiness...")
            await window.__PI_SDK_READY__
            addDiagnostic("Pi SDK readiness resolved")
          }
        } catch (error) {
          addDiagnostic(`Pi SDK readiness rejected: ${error}`)
          setPiSDKReady(false)
          setAuthStatus("failed")
          return
        }
      }

      const hasPiSDK = typeof window !== "undefined" && !!window.Pi
      addDiagnostic(`Checking Pi SDK: ${hasPiSDK ? "FOUND" : "NOT FOUND"}`)

      if (hasPiSDK) {
        addDiagnostic("Initializing Pi SDK...")
        const result = await initializePiSDK()
        setPiSDKReady(result.success)
        
        if (result.success) {
          addDiagnostic("Pi SDK ready - you can now pay")
          setAuthStatus("idle")
        } else {
          addDiagnostic("Pi SDK initialization failed")
          setAuthStatus("failed")
        }
      } else {
        setPiSDKReady(false)
        setAuthStatus("failed")
        addDiagnostic("ERROR: Not in Pi Browser - window.Pi not found")
      }
    }

    fetchPayment()
    // Only initialize Pi SDK if entry mode is "pi" (not "share")
    if (entryMode === "pi") {
      initPiSDK()
    } else {
      // Shared link mode - no Pi SDK initialization
      addDiagnostic("Shared link mode - Pi SDK initialization skipped")
      setPiSDKReady(false)
    }

    return () => {
      if (abortController) abortController.abort()
    }
  }, [paymentId, entryMode, toast])

  const paymentStatus = payment?.status

  useEffect(() => {
    const refundStatuses = new Set(["settlement_failed", "refund_pending", "refunded"])
    const isRefundFlow = entryMode === "pi" && authoritativeLoaded && paymentStatus !== undefined && refundStatuses.has(paymentStatus)

    if (!isRefundFlow || !piSDKReady) {
      if (!isRefundFlow) {
        const controller = refundAbortRef.current
        if (controller) {
          controller.abort()
          if (refundAbortRef.current === controller) {
            refundAbortRef.current = null
            refundAccessTokenRef.current = null
            refundFlowActiveRef.current = false
          }
        }
      }
      return
    }
    if (refundFlowActiveRef.current) return

    refundFlowActiveRef.current = true
    const controller = new AbortController()
    refundAbortRef.current = controller
    setRefundViewStatus("loading")

    const loadRefundPresentation = async () => {
      const authResult = await authenticateCustomerForRefundRead()
      if (controller.signal.aborted || refundAbortRef.current !== controller) return
      if (!authResult.success) {
        if (controller.signal.aborted || refundAbortRef.current !== controller) return
        setRefundViewStatus("indeterminate")
        if (refundAbortRef.current === controller) {
          controller.abort()
          refundAbortRef.current = null
          refundAccessTokenRef.current = null
          refundFlowActiveRef.current = false
        }
        return
      }

      if (controller.signal.aborted || refundAbortRef.current !== controller) return
      refundAccessTokenRef.current = authResult.accessToken
      const signal = controller.signal
      let inFlight = false
      const poll = async () => {
        if (controller.signal.aborted || refundAbortRef.current !== controller || inFlight) return
        inFlight = true
        try {
        const token = refundAccessTokenRef.current
        if (!token) return
        const result = await readCustomerRefundPresentationClient(paymentId, token, signal)
        if (controller.signal.aborted || refundAbortRef.current !== controller) return
        if (result.outcome === "FOUND") {
          if (controller.signal.aborted || refundAbortRef.current !== controller) return
          setRefundPresentation(result.presentation)
          if (controller.signal.aborted || refundAbortRef.current !== controller) return
          setRefundViewStatus("ready")
          if (["refund_completed", "refund_delayed", "attention_required"].includes(result.presentation.customerStatus)) {
            if (refundAbortRef.current === controller) {
              controller.abort()
              refundAbortRef.current = null
              refundAccessTokenRef.current = null
              refundFlowActiveRef.current = false
            }
          }
        } else if (result.outcome === "UNAUTHORIZED" || result.outcome === "FORBIDDEN") {
          if (controller.signal.aborted || refundAbortRef.current !== controller) return
          setRefundViewStatus("indeterminate")
          if (refundAbortRef.current === controller) {
            controller.abort()
            refundAbortRef.current = null
            refundAccessTokenRef.current = null
            refundFlowActiveRef.current = false
          }
        }
        } finally {
          inFlight = false
        }
      }

      await poll()
      if (controller.signal.aborted || refundAbortRef.current !== controller) return
      const interval = window.setInterval(poll, 10000)
      if (controller.signal.aborted || refundAbortRef.current !== controller) {
        window.clearInterval(interval)
        return
      }
      signal.addEventListener("abort", () => window.clearInterval(interval), { once: true })
    }

    loadRefundPresentation().catch(() => {
      if (controller.signal.aborted || refundAbortRef.current !== controller) return
      setRefundViewStatus("indeterminate")
      if (refundAbortRef.current === controller) {
        controller.abort()
        refundAbortRef.current = null
        refundAccessTokenRef.current = null
        refundFlowActiveRef.current = false
      }
    })

    return () => {
      if (refundAbortRef.current === controller) {
        controller.abort()
        refundAbortRef.current = null
        refundAccessTokenRef.current = null
        refundFlowActiveRef.current = false
      }
    }
  }, [authoritativeLoaded, entryMode, paymentStatus, paymentId, piSDKReady])

  const pollingStartedRef = useRef(false)
  const startPostSubmitPolling = (txid: string, processingStatus?: "paid_to_app" | "settlement_pending") => {
    if (pollingStartedRef.current) return
    pollingStartedRef.current = true
    console.log("[v0] Starting status polling...")
    let stopped = false
    let lastProcessingStatus: "paid_to_app" | "settlement_pending" | null = processingStatus ?? null
    let inFlight = false
    const pollInterval = setInterval(async () => {
      if (stopped || inFlight) return
      inFlight = true
      try {
      console.log("[v0] Polling payment status...")
      const updated = await getPaymentFromServer(paymentId, true)
      if (stopped) return
      if (updated) {
        console.log("[v0] Updated payment status:", updated.status)
        if (["settlement_failed", "refund_pending", "refunded"].includes(updated.status)) {
          setPayment(updated)
          stopped = true
          clearInterval(pollInterval)
          return
        }
        if (updated.status === "paid_to_app" || updated.status === "settlement_pending") {
          lastProcessingStatus = updated.status
          setPayment(updated)
          return
        }
        if (updated.status === "settled_to_merchant") {
          stopped = true
          clearInterval(pollInterval)
          console.log("[v0] ✅ Payment confirmed and settled to merchant!")
          setPayment(updated)
          setIsPaying(false)
          toast({ title: "Payment Successful", description: `Transaction ID: ${updated.u2aTxid || updated.a2uTxid || txid}` })
        }
      }
      } finally {
        inFlight = false
      }
    }, 3000)
    setTimeout(() => {
      stopped = true
      clearInterval(pollInterval)
      console.log("[v0] Stopping status polling after 5 minutes")
      if (lastProcessingStatus === null) setIsPaying(false)
    }, 300000)
  }

  const handlePay = async () => {
    addDiagnostic("PAY BUTTON CLICKED")
    addDiagnostic(`Payment ID: ${paymentId}`)
    addDiagnostic(`Amount: ${payment?.amount} Pi`)
    addDiagnostic(`Pi SDK Ready: ${piSDKReady}`)
    addDiagnostic(`Auth Status: ${authStatus}`)
    
    if (!payment) {
      addDiagnostic("ERROR: No payment object")
      return
    }

    if (isPaymentPaid(paymentId)) {
      addDiagnostic("Payment already completed")
      toast({
        title: "Already Paid",
        description: "This payment has already been completed",
        variant: "destructive",
      })
      return
    }

    // Authenticate inline if not already authenticated
    if (authStatus !== "authenticated") {
      addDiagnostic("Starting authentication...")
      setAuthStatus("authenticating")
      
      const authResult = await authenticateCustomer()
      
      if (!authResult.success) {
        addDiagnostic(`AUTH FAILED: ${authResult.error}`)
        setAuthStatus("failed")
        toast({
          title: "Authentication Required",
          description: authResult.error || "Please authenticate with Pi Browser",
          variant: "destructive",
        })
        return
      }
      
      addDiagnostic("Authentication successful")
      setAuthStatus("authenticated")
    }

    addDiagnostic("Calling Pi.createPayment()...")
    setIsPaying(true)

    executePayment(
      paymentId,
      async (txid) => {
        console.log("[v0] ========== PAYMENT SUCCESS CALLBACK ==========")
        console.log("[v0] Transaction ID:", txid)
        toast({
          title: "Payment Submitted",
          description: "Waiting for blockchain confirmation...",
        })
        
        try {
          const updated = await getPaymentFromServer(paymentId, true)
          if (updated?.status === "settled_to_merchant") {
            setPayment(updated)
            setIsPaying(false)
            toast({
              title: "Payment Successful",
              description: `Transaction ID: ${updated.u2aTxid || updated.a2uTxid || txid}`,
            })
          }
        } catch {
          // Preserve the existing success callback semantics.
        }
      },
      async (error) => {
        try {
          const updated = await getPaymentFromServer(paymentId, true)
          if (updated && ["settlement_failed", "refund_pending", "refunded"].includes(updated.status)) {
            setPayment(updated)
            return
          }
        } catch {
          // Preserve the existing generic failure handling below.
        }
        console.log("[v0] ========== PAYMENT ERROR CALLBACK ==========")
        console.log("[v0] Error:", error)
        toast({
          title: "Payment Failed",
          description: error,
          variant: "destructive",
        })
        setIsPaying(false)
      },
      (status) => {
        setPayment((current) => current ? { ...current, status } : current)
        startPostSubmitPolling("", status)
      },
    )
    console.log("[v0] executePayment called, waiting for callbacks...")
  }

  // If entry mode is "share", show bridge UI to open Pi Browser
  if (entryMode === "share" && urlAmount) {
    const piDeepLink = `pi://flashpay-two.vercel.app/pay/${encodeURIComponent(paymentId)}?amount=${encodeURIComponent(urlAmount)}&entry=pi${urlNote ? `&note=${encodeURIComponent(urlNote)}` : ""}`
    
    return (
      <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/5 py-8 px-4 flex items-center">
        <div className="max-w-md mx-auto w-full space-y-6">
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary text-primary-foreground mb-4">
              <span className="text-2xl">π</span>
            </div>
            <h1 className="text-2xl font-bold mb-2">FlashPay Request</h1>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-center">Payment Ready</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="text-center py-4">
                <div className="text-5xl font-bold text-primary mb-2">{parseFloat(urlAmount).toFixed(2)} π</div>
                {urlNote && <p className="text-sm text-muted-foreground mt-2">{urlNote}</p>}
              </div>

              <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-4 text-center">
                <p className="text-sm text-blue-900 dark:text-blue-100">To complete this payment, open this link in Pi Browser</p>
              </div>

              <Button
                onClick={() => {
                  window.location.href = piDeepLink
                }}
                className="w-full h-12 text-lg gap-2"
                size="lg"
              >
                <span>Open in Pi Browser & Pay</span>
              </Button>

              <p className="text-xs text-center text-muted-foreground">
                Payment ID: {paymentId}
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="p-8 text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-muted-foreground">Loading payment...</p>
            <p className="text-xs text-muted-foreground mt-2">ID: {paymentId}</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!payment) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle className="text-center">Payment Not Found</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-center">
            <p className="text-muted-foreground">
              Payment ID: {paymentId}
            </p>
            <p className="text-sm text-muted-foreground">
              This payment doesn't exist or has been removed.
            </p>
            <Link href="/">
              <Button className="w-full">Go to Home</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  const isPaid = payment.status === "settled_to_merchant"
  const isRefundView = entryMode === "pi" && authoritativeLoaded && ["settlement_failed", "refund_pending", "refunded"].includes(payment.status)
  const paymentQR = getPiNetUrl(paymentId)

  if (isRefundView) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/5 py-8 px-4">
        <div className="max-w-md mx-auto space-y-6">
          <CustomerRefundStatusCard presentation={refundPresentation} status={refundViewStatus} />
        </div>
      </div>
    )
  }

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast({
        title: "Copied",
        description: `${label} copied to clipboard`,
      })
    } catch {
      toast({
        title: "Copy Failed",
        description: "Could not copy to clipboard",
        variant: "destructive",
      })
    }
  }

  const shareReceipt = async () => {
    const receiptText = `FlashPay Receipt\nAmount: ${payment.amount.toFixed(2)}π\nStatus: ${mapSettlementStatusForDisplay(payment.status)}\nMerchant ID: ${payment.merchantId}\n${payment.note ? `Note: ${payment.note}\n` : ""}Payment ID: ${paymentId}`
    
    if (navigator.share) {
      try {
        await navigator.share({
          title: "FlashPay Receipt",
          text: receiptText,
        })
      } catch (error) {
        if (String(error).includes("AbortError")) return
        copyToClipboard(receiptText, "Receipt")
      }
    } else {
      copyToClipboard(receiptText, "Receipt")
    }
  }

  const sharePaymentId = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: "FlashPay Payment ID",
          text: paymentId,
        })
      } catch (error) {
        if (String(error).includes("AbortError")) return
        copyToClipboard(paymentId, "Payment ID")
      }
    } else {
      copyToClipboard(paymentId, "Payment ID")
    }
  }
  
  // CRITICAL: Log the origin context to diagnose app_id mismatches
  if (typeof window !== "undefined") {
    console.log("[v0][QR-Generation] ===== QR CODE GENERATION CONTEXT =====")
    console.log("[v0][QR-Generation] Merchant opened from:", window.location.origin)
    console.log("[v0][QR-Generation] Merchant domain:", window.location.hostname)
    console.log("[v0][QR-Generation] QR URL generated:", paymentQR)
    console.log("[v0][QR-Generation]")
    console.log("[v0][QR-Generation] When customer scans this QR:")
    const qrOrigin = paymentQR.match(/pi:\/\/([^\/]+)/)?.[1]
    console.log("[v0][QR-Generation]   → Will redirect to:", `https://${qrOrigin}`)
    console.log("[v0][QR-Generation]   → Customer will authenticate under:", qrOrigin)
    console.log("[v0][QR-Generation]   → Merchant authenticated under:", window.location.hostname)
    console.log("[v0][QR-Generation]")
    if (qrOrigin === window.location.hostname) {
      console.log("[v0][QR-Generation] ✅ SAME DOMAIN - Merchant and Customer will use same app context")
    } else {
      console.log("[v0][QR-Generation] ⚠️  DIFFERENT DOMAINS - This may cause app_id mismatch!")
      console.log("[v0][QR-Generation]   Merchant:", window.location.hostname)
      console.log("[v0][QR-Generation]   Customer:", qrOrigin)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-secondary/5 py-8 px-4">
      <div className="max-w-md mx-auto space-y-6">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary text-primary-foreground mb-4">
            <span className="text-2xl">π</span>
          </div>
          <h1 className="text-2xl font-bold mb-2">FlashPay Request</h1>
        </div>

        <Card>
          <CardHeader>
            {isPaid ? (
              <CardTitle className="text-center">FlashPay Receipt</CardTitle>
            ) : (
              <div className="flex items-center justify-between">
                <CardTitle>Payment Details</CardTitle>
                <Badge variant="secondary">
                  {payment.status}
                </Badge>
              </div>
            )}
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="text-center py-4">
              <div className="text-5xl font-bold text-primary mb-2">{payment.amount.toFixed(2)} π</div>
              {payment.note && <p className="text-sm text-muted-foreground mt-2">{payment.note}</p>}
            </div>

            {isPaid ? (
              <>
                <div className="p-4 bg-accent/10 text-accent rounded-lg space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium">Status</span>
                    <Badge variant="default">{mapSettlementStatusForDisplay(payment.status)}</Badge>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium">Merchant</span>
                    <span className="text-sm font-mono">{payment.merchantId}</span>
                  </div>
                </div>

                <div className="space-y-2">
                  <Button
                    onClick={shareReceipt}
                    variant="outline"
                    className="w-full gap-2"
                  >
                    <Copy className="h-4 w-4" />
                    Copy Receipt
                  </Button>
                  <Button
                    onClick={() => copyToClipboard(paymentId, "Payment ID")}
                    variant="outline"
                    className="w-full gap-2"
                  >
                    <Copy className="h-4 w-4" />
                    Copy Payment ID
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-center">
                  <QRCode value={paymentQR} size={240} />
                </div>

                {authStatus === "authenticating" && (
                  <div className="p-4 bg-muted rounded-lg text-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-2"></div>
                    <p className="text-sm text-muted-foreground">Authenticating with Pi Browser...</p>
                  </div>
                )}

                {authStatus === "failed" && (
                  <div className="p-4 bg-destructive/10 text-destructive rounded-lg text-center">
                    <p className="text-sm font-semibold mb-1">Authentication Failed</p>
                    <p className="text-xs">Please open this page in Pi Browser</p>
                  </div>
                )}

                <Button
                  onClick={handlePay}
                  disabled={isPaying || !piSDKReady || authStatus === "failed" || !authoritativeLoaded}
                  className="w-full h-12 text-lg"
                  size="lg"
                >
                  {isPaying
                    ? "Confirming on blockchain..."
                    : authStatus === "authenticating"
                      ? "Authenticating..."
                      : authStatus === "failed"
                        ? "Authentication Failed"
                        : !piSDKReady
                          ? "Loading Pi Wallet..."
                          : !authoritativeLoaded
                            ? "Loading Payment..."
                            : "Pay with Pi Wallet"}
                </Button>
                
                {isPaying && (
                  <p className="text-xs text-center text-muted-foreground">
                    Blockchain confirmation may take 1-2 minutes. Please wait...
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>


      </div>
    </div>
  )
}
