"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { ExternalLink, XCircle, Ban } from "lucide-react"
import { initializePiSDK } from "@/lib/pi-sdk"
import { useToast } from "@/hooks/use-toast"
import { QRCode } from "@/components/qr-code"
import { executePayment, isPaymentPaid, canRetryPayment, getPaymentFromServer } from "@/lib/operations"
import { getPiNetUrl } from "@/lib/router"
import { unifiedStore } from "@/lib/unified-store"
import type { Payment } from "@/lib/types"

export default function PaymentContentWithId({ paymentId }: { paymentId: string }) {
  const { toast } = useToast()
  const [payment, setPayment] = useState<Payment | null>(null)
  const [loading, setLoading] = useState(true)
  const [isPaying, setIsPaying] = useState(false)
  const [piSDKReady, setPiSDKReady] = useState(false)

  console.log("[v0][PaymentPage] ========== PAYMENT PAGE COMPONENT LOADED ==========")
  console.log("[v0][PaymentPage] Payment ID from URL path:", paymentId)
  console.log("[v0][PaymentPage] Current URL:", typeof window !== "undefined" ? window.location.href : "SSR")

  useEffect(() => {
    let timeoutId: NodeJS.Timeout

    async function fetchPayment() {
      console.log("[v0] Fetching payment from server:", paymentId)
      setLoading(true)

      try {
        // Set a 10 second timeout
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("Timeout")), 10000)
        })

        const serverPayment = await Promise.race([
          getPaymentFromServer(paymentId),
          timeoutPromise
        ]) as Payment | null

        clearTimeout(timeoutId)

        if (serverPayment) {
          console.log("[v0] Payment found:", serverPayment)
          setPayment(serverPayment)
          unifiedStore.createPaymentWithId(
            serverPayment.id,
            serverPayment.amount,
            serverPayment.note || "",
            serverPayment.merchantId || "unknown",
          )
        } else {
          console.log("[v0] Payment NOT found in server")
          setPayment(null)
        }
      } catch (error) {
        console.error("[v0] Error fetching payment:", error)
        setPayment(null)
      }

      setLoading(false)
    }

    async function initPiSDK() {
      const hasPiSDK = typeof window !== "undefined" && !!window.Pi
      console.log("[v0] Pi SDK available:", hasPiSDK)

      if (hasPiSDK) {
        const ready = await initializePiSDK()
        setPiSDKReady(ready)
        console.log("[v0] Pi SDK ready:", ready)
      } else {
        // Even without Pi SDK, set ready to false so UI shows proper message
        setPiSDKReady(false)
      }
    }

    fetchPayment()
    initPiSDK()

    return () => {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [paymentId])

  const handlePay = () => {
    console.log("[v0] ========== PAY BUTTON CLICKED ==========")
    console.log("[v0] Payment object:", payment)
    console.log("[v0] Payment ID:", paymentId)
    console.log("[v0] Pi SDK Ready:", piSDKReady)
    console.log("[v0] Is Paying:", isPaying)
    
    if (!payment) {
      console.log("[v0] ERROR: No payment object, returning")
      return
    }

    console.log("[v0] Checking if payment is already paid...")
    if (isPaymentPaid(paymentId)) {
      console.log("[v0] Payment already paid, showing toast")
      toast({
        title: "Already Paid",
        description: "This payment has already been completed",
        variant: "destructive",
      })
      return
    }

    console.log("[v0] Setting isPaying to true...")
    setIsPaying(true)

    console.log("[v0] Calling executePayment...")
    executePayment(
      paymentId,
      (txid) => {
        console.log("[v0] ========== PAYMENT SUCCESS CALLBACK ==========")
        console.log("[v0] Transaction ID:", txid)
        toast({
          title: "Payment Successful",
          description: `Transaction ID: ${txid}`,
        })
        setIsPaying(false)
        getPaymentFromServer(paymentId).then((updated) => {
          if (updated) setPayment(updated)
        })
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

  const isPaid = payment.status === "PAID"
  // CRITICAL: Use PiNet URL for QR codes - this is the ONLY way to open payment links in Pi Browser
  // Format: https://flashpay0734.pinet.com/pay/{id}
  // This ensures QR scan → Pi Browser → Payment Page → Pi SDK payment flow
  const paymentQR = getPiNetUrl(paymentId)

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
            <div className="flex items-center justify-between">
              <CardTitle>Payment Details</CardTitle>
              <Badge variant={isPaid ? "default" : "secondary"}>
                {payment.status}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="text-center py-4">
              <div className="text-5xl font-bold text-primary mb-2">{payment.amount.toFixed(2)} π</div>
              {payment.note && <p className="text-sm text-muted-foreground mt-2">{payment.note}</p>}
            </div>

            {!isPaid && (
              <>
                <div className="flex items-center justify-center">
                  <QRCode value={paymentQR} size={240} />
                </div>

                <Button
                  onClick={handlePay}
                  disabled={isPaying || !piSDKReady}
                  className="w-full h-12 text-lg"
                  size="lg"
                >
                  {isPaying
                    ? "Processing..."
                    : !piSDKReady
                      ? "Loading Pi Wallet..."
                      : "Pay with Pi Wallet"}
                </Button>
              </>
            )}

            {isPaid && (
              <div className="p-4 bg-accent/10 text-accent rounded-lg text-center">
                <p className="font-semibold mb-1">Payment Completed</p>
                {payment.txid && <p className="text-xs font-mono mt-2">{payment.txid}</p>}
              </div>
            )}

            <div className="text-center text-xs text-muted-foreground">Payment ID: {paymentId}</div>
          </CardContent>
        </Card>

        <div className="text-center">
          <Link href="/">
            <Button variant="ghost" className="gap-2">
              <ExternalLink className="h-4 w-4" />
              Create Your Own Payment
            </Button>
          </Link>
        </div>
      </div>
    </div>
  )
}
