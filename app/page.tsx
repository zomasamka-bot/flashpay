"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Check, Wallet, AlertCircle, Activity } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { createPayment } from "@/lib/operations"
import { ROUTES, getPiNetUrl } from "@/lib/router"
import { initializePiSDK, authenticateMerchant, getSDKStatus } from "@/lib/pi-sdk"
import { QRCode } from "@/components/qr-code"
import { usePaymentById, usePaymentStats } from "@/lib/use-payments"
import { useMerchant } from "@/lib/use-merchant"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { CustomerPaymentView } from "@/components/customer-payment-view"

export default function HomePage() {
  const router = useRouter()
  const { toast } = useToast()

  const [amount, setAmount] = useState("")
  const [displayAmount, setDisplayAmount] = useState("0.00")
  const [currentPaymentId, setCurrentPaymentId] = useState<string | null>(null)
  const [showQR, setShowQR] = useState(false)
  const [redirecting, setRedirecting] = useState(false)
  const hasShownSuccessRef = useRef(false)
  const merchantSetup = useMerchant()
  const [isConnecting, setIsConnecting] = useState(false)
  const [sdkInitStatus, setSdkInitStatus] = useState<"loading" | "ready" | "error">("loading")
  const [sdkError, setSdkError] = useState<string | null>(null)

  const paymentStats = usePaymentStats()

  const payment = usePaymentById(currentPaymentId || "")

  // CRITICAL: Check for payment ID on mount
  const [isCustomerView, setIsCustomerView] = useState(false)
  const [customerPaymentId, setCustomerPaymentId] = useState<string | null>(null)
  
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search)
    const paymentId = urlParams.get('id')
    
    if (paymentId) {
      setIsCustomerView(true)
      setCustomerPaymentId(paymentId)
      return
    }
  }, [])

  useEffect(() => {
    // Skip SDK init if redirecting
    if (redirecting) {
      return
    }
    
    const init = async () => {
      const result = await initializePiSDK()

      if (result.success) {
        setSdkInitStatus("ready")
        setSdkError(null)
      } else {
        setSdkInitStatus("error")
        setSdkError(result.error || "Failed to initialize Pi SDK")

        toast({
          title: "SDK Initialization Failed",
          description: result.error || "Failed to load Pi SDK",
          variant: "destructive",
        })
      }
    }

    init()
  }, [redirecting])

  useEffect(() => {
    if (payment?.status === "PAID" && showQR && !hasShownSuccessRef.current) {
      hasShownSuccessRef.current = true

      try {
        const audio = new Audio(
          "data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSyDzPLaizsIHGy/7OihUBELTKXh8LJnHwU7k9nxy3ksBSd7x/Dgjz8KFmK36+ulVhQLSKHe8rtsIQUsgs7y2Yk6CB1tv+zooVASC06o4vGwZiAFOpPZ8cx5LAcofMfw4I8+ChhjuOrrpVYVC0mi3vK8ayIFK4LO8tuKOggcbL/s6KFRDw1NqOLxsWYgBTuU2fHMeSsHKH3H8OCNPQ==",
        )
        audio.play().catch(() => {})
      } catch {}

      if (navigator.vibrate) {
        navigator.vibrate([100, 50, 100])
      }

      toast({
        title: "Payment Received!",
        description: `${payment.amount} Pi paid successfully`,
      })

      setTimeout(() => {
        handleNextCustomer()
      }, 1000)
    }
  }, [payment?.status, showQR])

  const handleNextCustomer = () => {
    setAmount("")
    setDisplayAmount("0.00")
    setCurrentPaymentId(null)
    setShowQR(false)
    hasShownSuccessRef.current = false
  }

  const handleNumberClick = (num: string) => {
    if (showQR) return

    if (num === ".") {
      if (amount.includes(".")) return
      const newAmount = amount === "" ? "0." : amount + "."
      setAmount(newAmount)
      setDisplayAmount(newAmount)
    } else {
      const newAmount = amount === "0" ? num : amount + num
      setAmount(newAmount)
      const formatted = Number.parseFloat(newAmount || "0").toFixed(2)
      setDisplayAmount(formatted)
    }
  }

  const handleClear = () => {
    if (showQR) return
    setAmount("")
    setDisplayAmount("0.00")
  }

  const handleBackspace = () => {
    if (showQR) return
    const newAmount = amount.slice(0, -1)
    setAmount(newAmount)
    setDisplayAmount(newAmount ? Number.parseFloat(newAmount).toFixed(2) : "0.00")
  }

  const handleQuickAmount = (value: number) => {
    if (showQR) return
    setAmount(value.toString())
    setDisplayAmount(value.toFixed(2))
  }

  const handleGenerateQR = async () => {
    const amountNum = Number.parseFloat(amount)

    if (!amountNum || amountNum <= 0) {
      toast({
        title: "Invalid Amount",
        description: "Please enter a valid Pi amount",
        variant: "destructive",
      })
      return
    }

    if (!merchantSetup.isSetupComplete) {
      toast({
        title: "Wallet Not Connected",
        description: "Please connect your Pi Wallet first to accept payments",
        variant: "destructive",
      })
      return
    }

    try {
      const result = await createPayment(amountNum, "")

      if (result.success && result.data) {
        setCurrentPaymentId(result.data.id)
        setShowQR(true)
        hasShownSuccessRef.current = false
      } else {
        toast({
          title: "Error",
          description: result.error || "Failed to create payment",
          variant: "destructive",
        })
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Unexpected error creating payment",
        variant: "destructive",
      })
    }
  }

  const handleConnectWallet = async () => {
    if (sdkInitStatus === "loading") {
      toast({
        title: "Please Wait",
        description: "Pi SDK is still loading. Please wait a moment and try again.",
        variant: "default",
      })
      return
    }

    if (sdkInitStatus === "error") {
      toast({
        title: "SDK Not Available",
        description: sdkError || "Pi SDK failed to initialize. Please refresh the page.",
        variant: "destructive",
      })
      return
    }

    setIsConnecting(true)

    try {
      const result = await authenticateMerchant()

      if (result.success) {
        toast({
          title: "Wallet Connected",
          description: `Verified by Pi Network as @${result.username}`,
        })
      } else {
        toast({
          title: "Connection Failed",
          description: result.error || "Could not connect Pi Wallet",
          variant: "destructive",
        })
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to connect wallet. Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsConnecting(false)
    }
  }

  const showDebugInfo = () => {
    const status = getSDKStatus()
    console.log("[v0] SDK Status:", status)
    router.push(ROUTES.DIAGNOSTICS)
  }

  // CRITICAL: Include payment data in URL for Preview environments without KV
  // Format: pi://flashpay-two.vercel.app/pay/{id}?amount=X&note=Y
  // This ensures the customer can see payment even if storage fails
  const paymentLink = currentPaymentId && payment
    ? `pi://${(process.env.NEXT_PUBLIC_APP_URL || "https://flashpay-two.vercel.app").replace('https://', '')}/pay/${currentPaymentId}?amount=${payment.amount}${payment.note ? `&note=${encodeURIComponent(payment.note)}` : ""}`
    : ""

  // CUSTOMER VIEW: Show payment page when ID detected in URL
  if (isCustomerView && customerPaymentId) {
    return <CustomerPaymentView paymentId={customerPaymentId} />
  }

  if (showQR && currentPaymentId) {
    return (
      <div className="min-h-screen flex flex-col">
        {/* Merchant Operational Data - Always Visible */}
        <div className="border-b bg-muted/30 px-4 py-3">
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-4">
              <span className="text-muted-foreground">Today:</span>
              <span className="font-semibold">{paymentStats.paidPayments} sales</span>
              <span className="font-semibold">{paymentStats.totalAmount.toFixed(2)} π</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Check className="h-3 w-3 text-green-600" />
              <span>@{merchantSetup.piUsername}</span>
            </div>
          </div>
        </div>

        {/* QR Payment View */}
        <div className="flex-1 flex flex-col items-center justify-center px-4 py-8">
          <div className="text-sm text-muted-foreground mb-4">Scan QR Code to Pay</div>

          <div className="bg-white p-8 rounded-3xl shadow-2xl mb-6">
            <QRCode value={paymentLink} size={300} />
          </div>

          <div className="text-xs text-center text-muted-foreground mb-6 max-w-xs">
            Scan and open in Pi Browser for fastest payment
          </div>

          <div className="text-6xl font-bold mb-4 tabular-nums">
            {displayAmount}
            <span className="text-4xl text-muted-foreground ml-2">π</span>
          </div>

          <div className="flex items-center gap-2 px-6 py-3 rounded-full bg-yellow-500/10 text-yellow-700 dark:text-yellow-500 mb-8">
            {payment?.status === "PAID" ? (
              <>
                <Check className="h-5 w-5" />
                <span className="font-semibold">Payment Received!</span>
              </>
            ) : (
              <>
                <div className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
                <span>Waiting for payment...</span>
              </>
            )}
          </div>

          <Button onClick={handleNextCustomer} className="h-14 px-12 text-lg" size="lg">
            Next Customer
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col">
      {sdkInitStatus === "error" && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            <div className="text-sm font-medium">Pi SDK Failed to Load</div>
            <div className="text-xs mt-1">{sdkError}</div>
            <div className="flex gap-2 mt-2">
              <Button onClick={() => window.location.reload()} variant="outline" size="sm" className="h-7 text-xs">
                Reload Page
              </Button>
              <Button onClick={showDebugInfo} variant="outline" size="sm" className="h-7 text-xs bg-transparent">
                <Activity className="h-3 w-3 mr-1" />
                Diagnostics
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {!merchantSetup.isSetupComplete && sdkInitStatus !== "error" && (
        <div className="bg-yellow-500/10 border-b border-yellow-500/20 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-1">
              <Wallet className="h-4 w-4 text-yellow-700 dark:text-yellow-500" />
              <span className="text-sm text-yellow-700 dark:text-yellow-500">
                {sdkInitStatus === "loading" ? "Loading Pi SDK..." : "Wallet not connected"}
              </span>
            </div>
            <Button
              onClick={handleConnectWallet}
              disabled={isConnecting || sdkInitStatus !== "ready"}
              size="sm"
              variant="secondary"
              className="h-8 text-xs"
            >
              {isConnecting ? "Connecting..." : sdkInitStatus === "loading" ? "Please wait..." : "Connect Pi Wallet"}
            </Button>
          </div>
        </div>
      )}

      {/* Merchant Operational Data - Always Visible */}
      {merchantSetup.isSetupComplete && (
        <div className="border-b bg-muted/30 px-4 py-3">
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-4">
              <span className="text-muted-foreground">Today:</span>
              <span className="font-semibold">{paymentStats.paidPayments} sales</span>
              <span className="font-semibold">{paymentStats.totalAmount.toFixed(2)} π</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Check className="h-3 w-3 text-green-600" />
              <span>@{merchantSetup.piUsername}</span>
            </div>
          </div>
        </div>
      )}

      {/* POS Terminal - Payment Input */}
      <div className="flex-1 flex flex-col px-4 py-6">
        {/* Amount Display */}
        <div className="text-center py-8">
          <div className="text-sm text-muted-foreground mb-2">Amount</div>
          <div className="text-6xl font-bold tabular-nums">
            {displayAmount}
            <span className="text-4xl text-muted-foreground ml-2">π</span>
          </div>
        </div>

        {/* Quick Amount Buttons */}
        <div className="grid grid-cols-4 gap-2 mb-6">
          <Button onClick={() => handleQuickAmount(1)} variant="outline" className="h-12">
            1π
          </Button>
          <Button onClick={() => handleQuickAmount(5)} variant="outline" className="h-12">
            5π
          </Button>
          <Button onClick={() => handleQuickAmount(10)} variant="outline" className="h-12">
            10π
          </Button>
          <Button onClick={() => handleQuickAmount(50)} variant="outline" className="h-12">
            50π
          </Button>
        </div>

        {/* Number Pad */}
        <div className="grid grid-cols-4 gap-3 mb-6">
          {["1", "2", "3"].map((num) => (
            <Button
              key={num}
              onClick={() => handleNumberClick(num)}
              variant="outline"
              className="h-16 text-2xl font-semibold"
            >
              {num}
            </Button>
          ))}
          <Button onClick={handleBackspace} variant="outline" className="h-16 row-span-2 bg-transparent">
            <ArrowLeft className="h-6 w-6" />
          </Button>

          {["4", "5", "6"].map((num) => (
            <Button
              key={num}
              onClick={() => handleNumberClick(num)}
              variant="outline"
              className="h-16 text-2xl font-semibold"
            >
              {num}
            </Button>
          ))}

          {["7", "8", "9"].map((num) => (
            <Button
              key={num}
              onClick={() => handleNumberClick(num)}
              variant="outline"
              className="h-16 text-2xl font-semibold"
            >
              {num}
            </Button>
          ))}
          <Button onClick={handleClear} variant="outline" className="h-16 text-sm bg-transparent">
            Clear
          </Button>

          <Button
            onClick={() => handleNumberClick("0")}
            variant="outline"
            className="h-16 text-2xl font-semibold col-span-2"
          >
            0
          </Button>
          <Button onClick={() => handleNumberClick(".")} variant="outline" className="h-16 text-2xl font-semibold">
            .
          </Button>
        </div>

        {/* Generate QR Button */}
        <Button
          onClick={handleGenerateQR}
          disabled={!amount || Number.parseFloat(amount) <= 0 || !merchantSetup.isSetupComplete}
          className="w-full h-16 text-xl gap-2"
          size="lg"
        >
          <Check className="h-6 w-6" />
          Generate QR Code
        </Button>

        <Button onClick={showDebugInfo} variant="ghost" size="sm" className="mt-4 text-xs">
          <Activity className="h-3 w-3 mr-1" />
          System Diagnostics
        </Button>
      </div>
    </div>
  )
}
