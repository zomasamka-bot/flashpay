"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ExternalLink, XCircle, Loader2 } from "lucide-react"
import { initializePiSDK, authenticateCustomer } from "@/lib/pi-sdk"
import { useToast } from "@/hooks/use-toast"
import { executePayment, getPaymentFromServer } from "@/lib/operations"
import { unifiedStore } from "@/lib/unified-store"
import type { Payment } from "@/lib/types"

export function CustomerPaymentView({ paymentId }: { paymentId: string }) {
  const { toast } = useToast()
  const [payment, setPayment] = useState<Payment | null>(null)
  const [loading, setLoading] = useState(true)
  const [isPaying, setIsPaying] = useState(false)
  const [paymentStatus, setPaymentStatus] = useState<string>("")
  const [piSDKReady, setPiSDKReady] = useState(false)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [authError, setAuthError] = useState<string>("")
  const [isPaid, setIsPaid] = useState(false)
  const [isInPiBrowser, setIsInPiBrowser] = useState(true)

  useEffect(() => {
    console.log("[v0][CustomerView] Mounted with payment ID:", paymentId)
    console.log("[v0][CustomerView] Current domain:", typeof window !== "undefined" ? window.location.hostname : "N/A")
    
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
        console.log("[v0][CustomerView] Payment status:", serverPayment.status)
        setPayment(serverPayment)
        
        // Store in unifiedStore for executePayment
        if (loading) {
          unifiedStore.createPaymentWithId(
            serverPayment.id,
            serverPayment.amount,
            serverPayment.note || "",
            serverPayment.merchantId || "unknown",
          )
        }

        setIsPaid(serverPayment.status.toLowerCase() === "paid")
      } else {
        console.log("[v0][CustomerView] Payment not found")
        setPayment(null)
      }

      setLoading(false)
    }

    fetchPayment()

    // Poll for payment status updates every 2 seconds while payment is not completed
    const intervalId = setInterval(() => {
      if (payment && !isPaid && !isPaying) {
        console.log("[v0][CustomerView] Polling payment status...")
        fetchPayment()
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
    setPaymentStatus("Opening Pi Wallet...")

    executePayment(
      payment.id,
      (txid) => {
        console.log("[v0][CustomerView] Payment successful:", txid)
        setPaymentStatus("Payment complete!")
        toast({
          title: "Payment Successful",
          description: `Transaction ID: ${txid}`,
        })
        setIsPaying(false)
        
        setPayment({ ...payment, status: "paid", txid })
        setIsPaid(true)
      },
      (error) => {
        console.log("[v0][CustomerView] Payment error:", error)
        
        toast({
          title: "Payment Failed",
          description: error,
          variant: "destructive",
        })
        setIsPaying(false)
        setPaymentStatus("")
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
            <Badge variant={isPaid ? "default" : "secondary"}>
              {payment.status.toUpperCase()}
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

          {payment.txid && (
            <div className="p-3 bg-muted rounded-lg space-y-1">
              <div className="text-xs text-muted-foreground">Transaction ID</div>
              <div className="text-sm font-mono break-all">{payment.txid}</div>
              <a
                href={`https://blockexplorer.minepi.com/tx/${payment.txid}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary flex items-center gap-1 hover:underline"
              >
                View on Explorer <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}

          <div className="space-y-2">
            {!isInPiBrowser && !isPaid && (
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

            {isInPiBrowser && !isPaid && piSDKReady && (
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
                      {paymentStatus || "Processing..."}
                    </>
                  ) : (
                    "Pay with Pi Wallet"
                  )}
                </Button>
                {isPaying && paymentStatus && (
                  <p className="text-xs text-center text-muted-foreground">
                    {paymentStatus}
                  </p>
                )}
              </>
            )}

            {isInPiBrowser && !piSDKReady && !isPaid && (
              <div className="text-center text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mx-auto mb-2" />
                Connecting to Pi Network...
              </div>
            )}



            {isPaid && (
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
