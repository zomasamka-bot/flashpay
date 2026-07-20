"use client"

import { useEffect, useRef, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ExternalLink, XCircle, Loader2 } from "lucide-react"
import { initializePiSDK, authenticateCustomer } from "@/lib/pi-sdk"
import { useToast } from "@/hooks/use-toast"
import { executePayment, getPaymentFromServer, handlePaymentRecovery } from "@/lib/operations"
import { unifiedStore } from "@/lib/unified-store"
import { getStatusLabel, getStatusColor, isPaid as isPaymentSettled, isProcessingStatus } from "@/lib/payment-status"
import { getRetryDecision, shouldSuppressErrorCallback, isPaymentSettled as isSettled } from "@/lib/retry-decision"
import { isPaymentFinal } from "@/lib/a2u-response"
import type { Payment, PaymentStatus } from "@/lib/types"

export function CustomerPaymentView({ 
  paymentId, 
  onSuccess, 
  onError 
}: { 
  paymentId: string
  onSuccess?: (u2aTxid: string) => void
  onError?: (error: string) => void
}) {
  const { toast } = useToast()
  const [payment, setPayment] = useState<Payment | null>(null)
  const [loading, setLoading] = useState(true)
  const [isPaying, setIsPaying] = useState(false)
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus | null>(null)
  const [progressMessage, setProgressMessage] = useState<string>("")
  const [piSDKReady, setPiSDKReady] = useState(false)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [authError, setAuthError] = useState<string>("")
  const [isPaymentPaid, setIsPaymentPaid] = useState(false)
  const [isInPiBrowser, setIsInPiBrowser] = useState(true)
  // CRITICAL: Store executed paymentId to prevent multi-execution per paymentId (synchronous ref guard)
  const successCallbackExecutedPaymentIdRef = useRef<string | null>(null)

  useEffect(() => {
    console.log("[v0][CustomerView] Mounted with payment ID:", paymentId)
    console.log("[v0][CustomerView] Current domain:", typeof window !== "undefined" ? window.location.hostname : "N/A")
    
    // GUARD: Reset ref when paymentId changes to allow callback for new payment
    successCallbackExecutedPaymentIdRef.current = null
    
    // Check if running in Pi Browser
    const checkPiBrowser = typeof window !== "undefined" && !!window.Pi
    setIsInPiBrowser(checkPiBrowser)
    console.log("[v0][CustomerView] Running in Pi Browser:", checkPiBrowser)
    
    if (!checkPiBrowser) {
      console.log("[v0][CustomerView] Not in Pi Browser - will show deep link button")
      return
    }
    
    async function init() {
      console.log("[v0][CustomerView] Initializing Pi SDK...")
      const sdkResult = await initializePiSDK()
      setPiSDKReady(sdkResult.success)
      console.log("[v0][CustomerView] Pi SDK ready:", sdkResult.success)

      if (!sdkResult.success) {
        console.error("[v0][CustomerView] Pi SDK initialization failed:", sdkResult.error)
        setAuthError(sdkResult.error || "Failed to initialize Pi SDK")
        toast({
          title: "Pi SDK Error",
          description: sdkResult.error || "Failed to connect to Pi Network",
          variant: "destructive",
        })
      }
    }
    
    init()
  }, [paymentId, toast])

  useEffect(() => {
    async function fetchPayment() {
      if (!paymentId) return

      if (loading) {
        console.log("[v0][CustomerView] Initial fetch for payment:", paymentId)
      }

      const serverPayment = await getPaymentFromServer(paymentId)

      if (serverPayment) {
        console.log("[v0][CustomerView] Payment status from server:", serverPayment.status)
        
        // CRITICAL: Never downgrade from settled_to_merchant
        // If local state is already settled, preserve it and its transaction identifiers
        const currentStatus = payment?.status
        if (currentStatus === "settled_to_merchant" && serverPayment.status !== "settled_to_merchant") {
          console.log("[v0][CustomerView] ⚠️ PROTECTION: Ignoring server status downgrade")
          console.log("[v0][CustomerView] Local settled_to_merchant preserved, server returned:", serverPayment.status)
          return
        }
        
        setPayment(serverPayment)
        
        // Store in unifiedStore for executePayment
        if (loading) {
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
        }

        setPaymentStatus(serverPayment.status)
        setIsPaymentPaid(isPaymentSettled(serverPayment.status))
      } else {
        console.log("[v0][CustomerView] Payment not found")
        setPayment(null)
      }

      setLoading(false)
    }

    fetchPayment()

    // Poll for payment status updates every 2 seconds while payment is not completed
    const intervalId = setInterval(() => {
      if (payment && !isPaymentPaid && !isPaying) {
        console.log("[v0][CustomerView] Polling payment status...")
        
        // Check for recovery states during polling
        if (
          payment.status === "settlement_pending" ||
          payment.status === "paid_to_app" ||
          (payment.requiresDbReconciliation && payment.a2uTxid) ||
          (payment.horizonSuccessFlag && !payment.requiresDbReconciliation)
        ) {
          console.log("[v0][CustomerView] Recovery state detected - attempting recovery:", payment.status)
          handlePaymentRecovery(
            payment,
            (txid) => {
              console.log("[v0][CustomerView] Recovery successful - calling onSuccess")
              setPaymentStatus("settled_to_merchant")
              setIsPaymentPaid(true)
              setIsPaying(false)
              toast({
                title: "Payment Completed",
                description: `Settlement confirmed. Transaction: ${txid}`,
              })
            },
            (error) => {
              console.log("[v0][CustomerView] Recovery failed:", error)
              // Continue polling, don't fail yet
            },
          )
        } else {
          // Normal polling
          fetchPayment()
        }
      }
    }, 2000)

    return () => clearInterval(intervalId)
  }, [paymentId, payment, isPaying])

  const handlePay = async () => {
    if (!payment || !piSDKReady) {
      console.log("[v0][CustomerView] Cannot pay - missing requirements")
      console.log("[v0][CustomerView] - payment:", !!payment)
      console.log("[v0][CustomerView] - piSDKReady:", piSDKReady)
      return
    }

    console.log("[v0][CustomerView] ========== PAYMENT BUTTON CLICKED ==========")
    console.log("[v0][CustomerView] Authentication will be handled inside createPiPayment")
    
    setIsPaying(true)
    setProgressMessage("Opening Pi Wallet...")

    executePayment(
      payment.id,
      (u2aTxid) => {
        console.log("[v0][CustomerView] Callback received U2A txid:", u2aTxid)
        console.log("[v0][CustomerView] Fetching canonical server state to validate finality predicate")
        
        // CRITICAL: Never set settled_to_merchant locally
        // Fetch canonical payment from server (forces reconciliation verification)
        ;(async () => {
          try {
            const response = await fetch(`/api/payments/${paymentId}`)
            if (!response.ok) {
              console.error("[v0][CustomerView] Failed to fetch server payment state:", response.status)
              if (onError) {
                onError("Failed to verify payment settlement with server")
              }
              setIsPaying(false)
              return
            }

            const serverPayment: Payment = await response.json()
            console.log("[v0][CustomerView] Server payment state:", {
              status: serverPayment.status,
              piCompleted: serverPayment.piCompleted,
              dbRecorded: serverPayment.dbRecorded,
              u2aTxid: !!serverPayment.u2aTxid,
              a2uTxid: !!serverPayment.a2uTxid,
              requiresDbReconciliation: serverPayment.requiresDbReconciliation,
            })

            // Validate exact finality predicate (matches buildA2USuccessResponse)
            const isCanonicallyFinal =
              serverPayment.status === "settled_to_merchant" &&
              serverPayment.piCompleted === true &&
              serverPayment.dbRecorded === true &&
              !!serverPayment.u2aTxid &&
              !!serverPayment.a2uTxid &&
              serverPayment.requiresDbReconciliation !== true

            if (!isCanonicallyFinal) {
              console.warn("[v0][CustomerView] Server payment does not meet finality predicate yet", {
                status: serverPayment.status,
                piCompleted: serverPayment.piCompleted,
                dbRecorded: serverPayment.dbRecorded,
              })
              
              // Update local state from server but DO NOT call onSuccess
              unifiedStore.addPayment(serverPayment)
              setPayment(serverPayment)
              setPaymentStatus(serverPayment.status)
              setIsPaying(false)
              
              // Show progress message instead of success
              setProgressMessage(`Processing settlement... (${serverPayment.status})`)
              return
            }

            // CRITICAL: Use single source of truth finality predicate
            if (!isPaymentFinal(serverPayment)) {
              console.error("[v0][CustomerView] ERROR: Finality predicate failed - aborting onSuccess")
              setIsPaying(false)
              return
            }
            
            // Verify response belongs to current paymentId before updating success UI or callback
            if (serverPayment.paymentId !== paymentId) {
              console.error("[v0][CustomerView] ERROR: Response paymentId mismatch - aborting", {
                current: paymentId,
                response: serverPayment.paymentId,
              })
              setIsPaying(false)
              return
            }
            
            console.log("[v0][CustomerView] ✓ Payment meets finality predicate for paymentId:", paymentId)
            
            unifiedStore.addPayment(serverPayment)
            setPayment(serverPayment)
            setPaymentStatus("settled_to_merchant")
            setIsPaymentPaid(true)
            setIsPaying(false)
            
            toast({
              title: "Payment Successful",
              description: `Settlement complete. Transaction: ${serverPayment.u2aTxid}`,
            })
            
            // GUARD: Execute onSuccess callback once per paymentId using stored paymentId ref
            if (successCallbackExecutedPaymentIdRef.current !== paymentId && onSuccess && serverPayment.u2aTxid) {
              // Mark this paymentId as executed before calling (prevent re-entry)
              successCallbackExecutedPaymentIdRef.current = paymentId
              console.log("[v0][CustomerView] Executing onSuccess callback for paymentId:", paymentId)
              onSuccess(serverPayment.u2aTxid)
            } else if (successCallbackExecutedPaymentIdRef.current === paymentId) {
              console.log("[v0][CustomerView] onSuccess callback already executed for this paymentId - skipping duplicate")
            }
          } catch (err) {
            console.error("[v0][CustomerView] Error fetching server state:", err)
            if (onError) {
              onError("Failed to verify payment settlement")
            }
            setIsPaying(false)
          }
        })()
      },
      (error) => {
        console.log("[v0][CustomerView] Payment error callback:", error)
        
        const currentPayment = unifiedStore.getPayment(paymentId)
        if (!currentPayment) {
          console.log("[v0][CustomerView] Payment not found for error handling")
          return
        }

        // CRITICAL: Do NOT invoke error callback for processing states (paid_to_app, settlement_pending)
        // These are not failures - they're in-flight states being recovered server-side
        if (shouldSuppressErrorCallback(currentPayment)) {
          console.log("[v0][CustomerView] Suppressing error callback for state:", currentPayment.status)
          console.log("[v0][CustomerView] Payment will continue in background recovery")
          setIsPaying(false)
          setProgressMessage("")
          // Keep polling, don't show error
          return
        }
        
        // Only show error for actual failures (failed, cancelled, settlement_failed pre-Horizon)
        toast({
          title: "Payment Failed",
          description: error,
          variant: "destructive",
        })
        setIsPaying(false)
        setProgressMessage("")
        setPaymentStatus(null)
      },
    )
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">Loading payment...</p>
        </div>
      </div>
    )
  }

  if (!payment) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-destructive" />
              Payment Not Found
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              This payment link is invalid or has expired.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }



  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-b from-background to-muted">
      <Card className="max-w-md w-full">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Payment Request</CardTitle>
            <Badge variant={getStatusColor(payment.status)}>
              {getStatusLabel(payment.status)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="text-center space-y-2">
            <div className="text-5xl font-bold text-primary">
              {payment.amount} Pi
            </div>
            {payment.note && (
              <p className="text-muted-foreground">{payment.note}</p>
            )}
          </div>

          {payment.u2aTxid && (
            <div className="p-3 bg-muted rounded-lg space-y-1">
              <div className="text-xs text-muted-foreground">Transaction ID</div>
              <div className="text-sm font-mono break-all">{payment.u2aTxid}</div>
              <a
                href={`https://blockexplorer.minepi.com/tx/${payment.u2aTxid}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary flex items-center gap-1 hover:underline"
              >
                View on Explorer <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}

          <div className="space-y-2">
            {!isInPiBrowser && !isPaymentPaid && (
              <div className="space-y-3 p-4 bg-primary/10 border border-primary/20 rounded-lg">
                <div className="text-center space-y-2">
                  <p className="font-medium text-primary">Pi Browser Required</p>
                  <p className="text-sm text-muted-foreground">
                    This payment must be opened in Pi Browser to process the transaction.
                  </p>
                </div>
                <Button
                  onClick={() => {
                    const currentUrl = window.location.href
                    window.location.href = `pi://browser.open?url=${encodeURIComponent(currentUrl)}`
                  }}
                  className="w-full"
                  size="lg"
                >
                  Open in Pi Browser
                </Button>
                <p className="text-xs text-center text-muted-foreground">
                  Make sure you have Pi Browser installed on your device
                </p>
              </div>
            )}

            {isInPiBrowser && !isPaymentPaid && piSDKReady && (
              <>
                <Button
                  onClick={handlePay}
                  disabled={isPaying}
                  className="w-full"
                  size="lg"
                >
                  {isPaying ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {progressMessage || "Processing..."}
                    </>
                  ) : (
                    "Pay with Pi Wallet"
                  )}
                </Button>
                {isPaying && progressMessage && (
                  <p className="text-xs text-center text-muted-foreground">
                    {progressMessage}
                  </p>
                )}
              </>
            )}

            {isInPiBrowser && !piSDKReady && !isPaymentPaid && (
              <div className="text-center text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mx-auto mb-2" />
                Connecting to Pi Network...
              </div>
            )}



            {isPaymentPaid && (
              <div className="text-center text-sm text-muted-foreground">
                This payment has been completed
              </div>
            )}
          </div>

          <div className="text-xs text-center text-muted-foreground">
            Payment ID: {payment.id.slice(0, 8)}...
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
