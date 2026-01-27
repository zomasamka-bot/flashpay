"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ExternalLink, XCircle, Loader2 } from "lucide-react"
import { initializePiSDK } from "@/lib/pi-sdk"
import { useToast } from "@/hooks/use-toast"
import { executePayment, getPaymentFromServer } from "@/lib/operations"
import { unifiedStore } from "@/lib/unified-store"
import type { Payment } from "@/lib/types"

export function CustomerPaymentView({ paymentId }: { paymentId: string }) {
  const { toast } = useToast()
  const [payment, setPayment] = useState<Payment | null>(null)
  const [loading, setLoading] = useState(true)
  const [isPaying, setIsPaying] = useState(false)
  const [piSDKReady, setPiSDKReady] = useState(false)

  useEffect(() => {
    console.log("[v0][CustomerView] Mounted with payment ID:", paymentId)
    
    async function init() {
      console.log("[v0][CustomerView] Initializing Pi SDK...")
      const result = await initializePiSDK()
      setPiSDKReady(result.success)
      console.log("[v0][CustomerView] Pi SDK ready:", result.success)
    }
    
    init()
  }, [paymentId])

  useEffect(() => {
    async function fetchPayment() {
      if (!paymentId) return

      setLoading(true)
      console.log("[v0][CustomerView] Fetching payment:", paymentId)

      const serverPayment = await getPaymentFromServer(paymentId)

      if (serverPayment) {
        console.log("[v0][CustomerView] Payment found:", serverPayment)
        setPayment(serverPayment)
        
        // Store in unifiedStore for executePayment
        unifiedStore.createPaymentWithId(
          serverPayment.id,
          serverPayment.amount,
          serverPayment.note || "",
          serverPayment.merchantId || "unknown",
        )
      } else {
        console.log("[v0][CustomerView] Payment not found")
        setPayment(null)
      }

      setLoading(false)
    }

    fetchPayment()
  }, [paymentId])

  const handlePay = async () => {
    if (!payment || !piSDKReady) return

    setIsPaying(true)
    console.log("[v0][CustomerView] Starting payment execution...")

    await executePayment(
      payment.id,
      (txid) => {
        console.log("[v0][CustomerView] Payment successful:", txid)
        toast({
          title: "Payment Successful",
          description: `Transaction ID: ${txid}`,
        })
        setIsPaying(false)
        
        // Update payment display
        setPayment({ ...payment, status: "PAID" })
      },
      (error) => {
        console.log("[v0][CustomerView] Payment error:", error)
        
        const isVerificationError = error.toLowerCase().includes("unverified") || 
                                    error.toLowerCase().includes("not verified") ||
                                    error.toLowerCase().includes("verification required")
        
        toast({
          title: isVerificationError ? "App Not Verified" : "Payment Failed",
          description: isVerificationError 
            ? "This app is currently unverified. Payment functionality will be available after Pi Network verification is complete."
            : error,
          variant: "destructive",
        })
        setIsPaying(false)
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

  const isPaid = payment.status === "PAID"

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-b from-background to-muted">
      <Card className="max-w-md w-full">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Payment Request</CardTitle>
            <Badge variant={isPaid ? "default" : "secondary"}>
              {payment.status}
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
            {!isPaid && piSDKReady && (
              <Button
                onClick={handlePay}
                disabled={isPaying}
                className="w-full"
                size="lg"
              >
                {isPaying ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Processing...
                  </>
                ) : (
                  "Pay with Pi Wallet"
                )}
              </Button>
            )}

            {!piSDKReady && (
              <div className="text-center text-sm text-muted-foreground">
                Initializing Pi SDK...
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
