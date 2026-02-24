"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { ExternalLink } from "lucide-react"
import { initializePiSDK, authenticateCustomer } from "@/lib/pi-sdk"
import { useToast } from "@/hooks/use-toast"
import { QRCode } from "@/components/qr-code"
import { executePayment, isPaymentPaid, getPaymentFromServer } from "@/lib/operations"
import { getPiNetUrl } from "@/lib/router"
import { unifiedStore } from "@/lib/unified-store"
import type { Payment } from "@/lib/types"

export default function PaymentContentWithId({ 
  paymentId, 
  urlAmount, 
  urlNote 
}: { 
  paymentId: string
  urlAmount?: string
  urlNote?: string
}) {
  const { toast } = useToast()
  const [payment, setPayment] = useState<Payment | null>(null)
  const [loading, setLoading] = useState(true)
  const [isPaying, setIsPaying] = useState(false)
  const [piSDKReady, setPiSDKReady] = useState(false)
  const [authStatus, setAuthStatus] = useState<"idle" | "authenticating" | "authenticated" | "failed">("idle")
  const [diagnostics, setDiagnostics] = useState<string[]>([])

  const addDiagnostic = (message: string) => {
    const timestamp = new Date().toLocaleTimeString()
    setDiagnostics(prev => [...prev, `[${timestamp}] ${message}`])
    console.log("[v0][Diagnostic]", message)
  }

  console.log("[v0][PaymentPage] ========== PAYMENT PAGE COMPONENT LOADED ==========")
  console.log("[v0][PaymentPage] Payment ID from URL path:", paymentId)
  console.log("[v0][PaymentPage] URL params from props - amount:", urlAmount, "note:", urlNote)
  console.log("[v0][PaymentPage] urlAmount type:", typeof urlAmount)
  console.log("[v0][PaymentPage] urlAmount value:", urlAmount)
  console.log("[v0][PaymentPage] urlAmount is undefined?", urlAmount === undefined)
  console.log("[v0][PaymentPage] urlAmount is null?", urlAmount === null)
  console.log("[v0][PaymentPage] Current URL:", typeof window !== "undefined" ? window.location.href : "SSR")
  
  // Also check window.location.search for URL params
  if (typeof window !== "undefined") {
    const urlParams = new URLSearchParams(window.location.search)
    console.log("[v0][PaymentPage] URL search params:", window.location.search)
    console.log("[v0][PaymentPage] Parsed amount from URL:", urlParams.get('amount'))
    console.log("[v0][PaymentPage] Parsed note from URL:", urlParams.get('note'))
  }
  
  // Check if we have a stored payment ID from before auth (in case of redirect)
  useEffect(() => {
    if (typeof window !== "undefined") {
      const storedPaymentId = sessionStorage.getItem("flashpay_current_payment_id")
      console.log("[v0][PaymentPage] Stored payment ID in sessionStorage:", storedPaymentId)
      console.log("[v0][PaymentPage] Current payment ID from URL:", paymentId)
      
      if (storedPaymentId && storedPaymentId !== paymentId) {
        console.warn("[v0][PaymentPage] ⚠️ Payment ID mismatch after navigation!")
        console.warn("[v0][PaymentPage] Expected:", storedPaymentId)
        console.warn("[v0][PaymentPage] Got:", paymentId)
      }
    }
  }, [paymentId])

  useEffect(() => {
    let timeoutId: NodeJS.Timeout

    async function fetchPayment() {
      addDiagnostic(`Fetching payment: ${paymentId}`)
      setLoading(true)

      try {
        // Retry logic: Try up to 3 times with 30 second timeout each
        let serverPayment: Payment | null = null
        let attempts = 0
        const maxAttempts = 3

        while (!serverPayment && attempts < maxAttempts) {
          attempts++
          addDiagnostic(`Attempt ${attempts}/${maxAttempts} to fetch payment`)
          
          try {
            const timeoutPromise = new Promise((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error("Timeout")), 30000)
            })

            serverPayment = await Promise.race([
              getPaymentFromServer(paymentId),
              timeoutPromise
            ]) as Payment | null

            clearTimeout(timeoutId)
            
            if (serverPayment) {
              addDiagnostic("Payment retrieved successfully")
            } else if (attempts < maxAttempts) {
              addDiagnostic(`No payment found, retrying in 2 seconds...`)
              await new Promise(resolve => setTimeout(resolve, 2000))
            }
          } catch (attemptError) {
            addDiagnostic(`Attempt ${attempts} failed: ${attemptError}`)
            if (attempts < maxAttempts) {
              await new Promise(resolve => setTimeout(resolve, 2000))
            }
          }
        }

        if (serverPayment) {
          console.log("[v0] ✅ Payment found from server:", serverPayment)
          setPayment(serverPayment)
          unifiedStore.createPaymentWithId(
            serverPayment.id,
            serverPayment.amount,
            serverPayment.note || "",
            serverPayment.merchantId || "unknown",
          )
        } else {
          // FALLBACK: Use URL parameters when server doesn't have the payment
          // Check both props and window.location as backup
          let amountStr = urlAmount
          let noteStr = urlNote
          
          if (!amountStr && typeof window !== "undefined") {
            const urlParams = new URLSearchParams(window.location.search)
            amountStr = urlParams.get('amount') || undefined
            noteStr = urlParams.get('note') || undefined
            console.log("[v0] ⚠️ Props urlAmount was empty, using window.location.search")
            console.log("[v0] Extracted amount:", amountStr, "note:", noteStr)
          }
          
          if (amountStr) {
            console.log("[v0] ⚠️ Payment NOT found on server, using URL parameters as fallback")
            const amount = parseFloat(amountStr)
            if (!isNaN(amount) && amount > 0) {
              const fallbackPayment: Payment = {
                id: paymentId,
                amount: amount,
                note: noteStr || "",
                status: "PENDING",
                createdAt: new Date(),
                merchantId: "unknown",
              }
              console.log("[v0] ✅ Created fallback payment from URL params:", fallbackPayment)
              setPayment(fallbackPayment)
              unifiedStore.createPaymentWithId(
                paymentId,
                amount,
                noteStr || "",
                "unknown",
              )
            } else {
              console.error("[v0] ❌ Invalid amount in URL parameters:", amountStr)
              setPayment(null)
            }
          } else {
            console.error("[v0] ❌ Payment NOT found and no URL parameters available")
            console.error("[v0] urlAmount prop:", urlAmount)
            console.error("[v0] window.location.search:", typeof window !== "undefined" ? window.location.search : "N/A")
            setPayment(null)
          }
        }
      } catch (error) {
        console.error("[v0] Error fetching payment:", error)
        setPayment(null)
      }

      setLoading(false)
    }

    async function initPiSDK() {
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
    initPiSDK()

    return () => {
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [paymentId, toast])

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
            
            if (updated.status === "PAID" || updated.status === "paid") {
              console.log("[v0] ✅ Payment confirmed on blockchain!")
              clearInterval(pollInterval)
              setIsPaying(false)
              toast({
                title: "Payment Successful",
                description: `Transaction ID: ${updated.txid || txid}`,
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
                  disabled={isPaying || !piSDKReady || authStatus === "failed"}
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
                          : "Pay with Pi Wallet"}
                </Button>
                
                {isPaying && (
                  <p className="text-xs text-center text-muted-foreground">
                    Blockchain confirmation may take 1-2 minutes. Please wait...
                  </p>
                )}
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

        {diagnostics.length > 0 && (
          <Card className="bg-muted/50">
            <CardHeader>
              <CardTitle className="text-sm">System Diagnostics</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {diagnostics.map((msg, idx) => (
                  <div key={idx} className="text-xs font-mono text-muted-foreground">
                    {msg}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
