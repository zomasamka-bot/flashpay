"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { ExternalLink, Copy } from "lucide-react"
import { initializePiSDK, authenticateCustomer } from "@/lib/pi-sdk"
import { useToast } from "@/hooks/use-toast"
import { QRCode } from "@/components/qr-code"
import { executePayment, isPaymentPaid, getPaymentFromServer } from "@/lib/operations"
import { getPiNetUrl } from "@/lib/router"
import { unifiedStore } from "@/lib/unified-store"
import type { Payment } from "@/lib/types"

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
  const { toast } = useToast()
  const [payment, setPayment] = useState<Payment | null>(null)
  const [loading, setLoading] = useState(true)
  const [isPaying, setIsPaying] = useState(false)
  const [piSDKReady, setPiSDKReady] = useState(false)
  const [authStatus, setAuthStatus] = useState<"idle" | "authenticating" | "authenticated" | "failed">("idle")
  const [diagnostics, setDiagnostics] = useState<string[]>([])
  const [entryMode, setEntryMode] = useState<"pi" | "share">(entry)
  const [authoritativeLoaded, setAuthoritativeLoaded] = useState(false)

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
      if (mode === "share" || mode === "pi") {
        setEntryMode(mode)
        console.log("[v0][EntryMode] Detected entry mode from URL:", mode)
      } else {
        console.log("[v0][EntryMode] No entry mode in URL, using default:", entry)
      }
    }
  }, [])

  useEffect(() => {
    let abortController: AbortController | null = null
    let timeoutId: NodeJS.Timeout | null = null

    async function fetchPayment() {
      addDiagnostic(`Fetching payment: ${paymentId}`)
      console.log("[v0][PaymentPage] Entry mode:", entryMode)
      
      try {
        // For entry=pi with URL amount, show provisionally and fetch authoritatively once
        const urlAmountStr = urlAmount || (typeof window !== "undefined" ? new URLSearchParams(window.location.search).get('amount') : null)
        const urlNoteStr = urlNote || (typeof window !== "undefined" ? new URLSearchParams(window.location.search).get('note') : null)
        
        // CRITICAL FIX: Pi Browser deep link detection
        // When scanning QR code, Pi Browser opens pi://... which redirects to https://demo-.../pay/...
        // The entry=pi parameter tells us this is a deep-linked payment request
        if (entryMode === "pi" && urlAmountStr) {
          const amount = parseFloat(urlAmountStr)
          if (!isNaN(amount) && amount > 0) {
            // Show provisional payment data immediately to user
            const provisionalPayment: Payment = {
              id: paymentId,
              amount: amount,
              note: urlNoteStr || "",
              status: "pending",
              createdAt: new Date().toISOString(),
              merchantId: "unknown",
              accessToken: "",
            }
            console.log("[v0] ✅ Showing provisional payment from deep link:", provisionalPayment)
            addDiagnostic("✅ Payment loaded from QR code link")
            setPayment(provisionalPayment)
            setLoading(false)
            
            // Fetch authoritative payment in background with generous timeout for slow networks
            try {
              abortController = new AbortController()
              // Use 15 second timeout for Pi Browser (slower networks, older phones)
              timeoutId = setTimeout(() => {
                console.log("[v0] ⚠️ Payment fetch timeout after 15s - keeping provisional payment")
                abortController?.abort()
              }, 15000)
              
              const serverPayment = await getPaymentFromServer(paymentId, true, abortController.signal)
              if (timeoutId) clearTimeout(timeoutId)
              
              if (serverPayment) {
                console.log("[v0] ✅ Authoritative payment loaded:", serverPayment)
                setPayment(serverPayment)
                setAuthoritativeLoaded(true)
                addDiagnostic("✅ Payment verified from server")
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
                addDiagnostic("⚠️ Using payment data from QR code")
                // Keep showing provisional payment, disable Pay button
              }
            } catch (fetchError) {
              if (timeoutId) clearTimeout(timeoutId)
              console.warn("[v0] ⚠️ Failed to fetch authoritative payment:", fetchError)
              addDiagnostic(`Using provisional: ${fetchError}`)
              // Keep showing provisional payment, disable Pay button
            }
            return
          }
        }
        
        // Standard flow for non-pi entries or no URL amount - fetch once
        setLoading(true)
        addDiagnostic("Loading payment data...")
        
        try {
          abortController = new AbortController()
          // Use 15 second timeout for Pi Browser (slower networks)
          timeoutId = setTimeout(() => {
            console.log("[v0] ⚠️ Payment fetch timeout after 15s")
            abortController?.abort()
          }, 15000)
          
          const serverPayment = await getPaymentFromServer(paymentId, false, abortController.signal)
          if (timeoutId) clearTimeout(timeoutId)
          
          if (serverPayment) {
            console.log("[v0] ✅ Payment found from server:", serverPayment)
            addDiagnostic("✅ Payment loaded from server")
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
              addDiagnostic("✅ Using payment data from link")
              setPayment(fallbackPayment)
            } else {
              console.error("[v0] ❌ Invalid amount in URL parameters:", urlAmountStr)
              addDiagnostic("❌ Invalid payment amount")
              setPayment(null)
            }
          } else {
            console.error("[v0] ❌ Payment NOT found and no URL parameters available")
            addDiagnostic("❌ Payment not found")
            setPayment(null)
          }
        } catch (error) {
          console.error("[v0] Error fetching payment:", error)
          addDiagnostic(`❌ Error: ${error}`)
          setPayment(null)
        }
        
        setLoading(false)
      } catch (error) {
        console.error("[v0] Error in fetchPayment:", error)
        addDiagnostic(`❌ Fatal error: ${error}`)
        setPayment(null)
        setLoading(false)
      }
    }

    async function initPiSDK() {
      // CRITICAL FIX: Non-blocking Pi SDK initialization
      // Don't delay payment page rendering while waiting for SDK
      const hasPiSDK = typeof window !== "undefined" && !!window.Pi
      console.log("[v0][PaymentPage] Checking Pi SDK:", hasPiSDK ? "FOUND" : "NOT FOUND")

      if (hasPiSDK) {
        addDiagnostic("Initializing Pi SDK...")
        const result = await initializePiSDK()
        setPiSDKReady(result.success)
        
        if (result.success) {
          addDiagnostic("✅ Pi SDK ready - ready to pay")
          setAuthStatus("idle")
        } else {
          addDiagnostic("⚠️ Pi SDK init failed")
          setAuthStatus("failed")
        }
      } else {
        setPiSDKReady(false)
        setAuthStatus("failed")
        addDiagnostic("⚠️ Pi SDK not available")
      }
    }

    // Start payment fetch immediately
    fetchPayment()
    
    // Only initialize Pi SDK if entry mode is "pi" (not "share")
    // Do this asynchronously without blocking page render
    if (entryMode === "pi") {
      // Don't await - let it load in background
      initPiSDK().catch((e) => console.log("[v0] SDK init error (non-blocking):", e))
    } else {
      // Shared link mode - no Pi SDK initialization
      addDiagnostic("Shared link mode - no SDK needed")
      setPiSDKReady(false)
    }

    return () => {
      if (abortController) abortController.abort()
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [paymentId, entryMode, toast])

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
      (txid) => {
        console.log("[v0] ========== PAYMENT SUCCESS CALLBACK ==========")
        console.log("[v0] Transaction ID:", txid)
        toast({
          title: "Payment Submitted",
          description: "Waiting for blockchain confirmation...",
        })
        
        // Start polling for payment status updates
        console.log("[v0] Starting status polling...")
        const pollInterval = setInterval(async () => {
          console.log("[v0] Polling payment status...")
          const updated = await getPaymentFromServer(paymentId)
          
          if (updated) {
            console.log("[v0] Updated payment status:", updated.status)
            setPayment(updated)
            
            if (updated.status === "settled_to_merchant") {
              console.log("[v0] ✅ Payment confirmed and settled to merchant!")
              clearInterval(pollInterval)
              setIsPaying(false)
              toast({
                title: "Payment Successful",
                description: `Transaction ID: ${updated.u2aTxid || updated.a2uTxid || txid}`,
              })
            }
          }
        }, 3000) // Poll every 3 seconds
        
        // Stop polling after 5 minutes
        setTimeout(() => {
          console.log("[v0] Stopping status polling after 5 minutes")
          clearInterval(pollInterval)
          setIsPaying(false)
        }, 300000)
      },
      (error) => {
        console.log("[v0] ========== PAYMENT ERROR CALLBACK ==========")
        console.log("[v0] Error:", error)
        toast({
          title: "Payment Failed",
          description: error,
          variant: "destructive",
        })
        setIsPaying(false)
      },
    )
    console.log("[v0] executePayment called, waiting for callbacks...")
  }

  // If entry mode is "share", show bridge UI to open Pi Browser
  if (entryMode === "share" && urlAmount) {
    const piDeepLink = `pi://flashpay-two.vercel.app/pay/${paymentId}?amount=${urlAmount}&entry=pi${urlNote ? `&note=${encodeURIComponent(urlNote)}` : ""}`
    
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
  const paymentQR = getPiNetUrl(paymentId)

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
