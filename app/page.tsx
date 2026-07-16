"use client"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Check, Wallet, AlertCircle, Share2, Copy, DollarSign, X, AlertTriangle } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { createPayment } from "@/lib/operations"
import { getPiNetUrl } from "@/lib/router"
import { config } from "@/lib/config"
import { initializePiSDK, authenticateMerchant } from "@/lib/pi-sdk"
import { QRCode } from "@/components/qr-code"
import { usePaymentById, usePaymentStats } from "@/lib/use-payments"
import { useLoadPaymentHistory } from "@/lib/use-load-payment-history"
import { useMerchant } from "@/lib/use-merchant"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { CustomerPaymentView } from "@/components/customer-payment-view"

export default function HomePage() {
  const router = useRouter()
  const { toast } = useToast()

  // Load persistent payment history on app mount
  useLoadPaymentHistory()

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
  const [showShareMenu, setShowShareMenu] = useState(false)
  const [showConversion, setShowConversion] = useState(false)
  const [localAmount, setLocalAmount] = useState("")
  const [currency, setCurrency] = useState("USD")
  const [piRate, setPiRate] = useState("1")
  
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search)
    const paymentId = urlParams.get('id')
    
    if (paymentId) {
      setIsCustomerView(true)
      setCustomerPaymentId(paymentId)
      return
    }
  }, [])

  // Initialize Pi SDK on app load
  useEffect(() => {
    if (redirecting) {
      return
    }
    
    const init = async () => {
      console.log("[v0] Initializing Pi SDK...")
      const result = await initializePiSDK()

      if (result.success) {
        console.log("[v0] Pi SDK initialized - waiting for wallet session to be ready...")
        
        // CRITICAL FIX: Wait a moment for the Pi Wallet session to fully initialize
        // Pi.init() makes the SDK available, but the user's wallet session needs time to be ready
        // This prevents "Pi wallet not responding" errors by ensuring the wallet is listening
        // when we call Pi.authenticate()
        setTimeout(() => {
          setSdkInitStatus("ready")
          setSdkError(null)
          console.log("[v0] Wallet session ready - authentication can now proceed")
        }, 500)
      } else {
        setSdkInitStatus("error")
        setSdkError(result.error || "Failed to initialize Pi SDK")
        console.error("[v0] Pi SDK initialization failed:", result.error)

        toast({
          title: "SDK Initialization Failed",
          description: result.error || "Failed to load Pi SDK",
          variant: "destructive",
        })
      }
    }

    init()
  }, [redirecting, toast])

  // Manual authentication - user controls when to authenticate
  const handleManualAuthenticate = async () => {
    setIsConnecting(true)
    console.log("[v0] User manually triggered authentication")
    
    try {
      const result = await authenticateMerchant()
      
      if (result.success) {
        console.log("[v0] ✓ Merchant authenticated successfully")
        toast({
          title: "Connected",
          description: "Your Pi Wallet has been connected successfully",
        })
      } else {
        console.error("[v0] ✗ Authentication failed:", result.error)
        toast({
          title: "Connection Failed",
          description: result.error || "Failed to connect wallet",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("[v0] Authentication error:", error)
      toast({
        title: "Error",
        description: "An unexpected error occurred during authentication",
        variant: "destructive",
      })
    } finally {
      setIsConnecting(false)
    }
  }

  useEffect(() => {
    if (payment?.status === "paid" && showQR && !hasShownSuccessRef.current) {
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


  // CRITICAL: Include payment data in URL for Preview environments without KV
  // QR links use Pi deep link (entry=pi) and stable Vercel domain via getPiNetUrl
  // Never depends on window.location.origin or preview domain
  const getPaymentLinkForQR = (paymentId: string) => {
    const baseUrl = getPiNetUrl(paymentId)
    const amount = payment?.amount || 0
    const noteParam = payment?.note ? `&note=${encodeURIComponent(payment.note)}` : ""
    return `${baseUrl}?amount=${amount}&entry=pi${noteParam}`
  }
  
  const paymentLink = currentPaymentId && payment ? getPaymentLinkForQR(currentPaymentId) : ""

  // Payment sharing handlers
  // Shared HTTPS URL with entry=share for bridge UI, includes amount and note
  const sharePaymentUrl = currentPaymentId && payment 
    ? `https://flashpay-two.vercel.app/pay/${currentPaymentId}?amount=${payment.amount}&entry=share${payment.note ? `&note=${encodeURIComponent(payment.note)}` : ""}`
    : ""
  
  const handleSharePayment = async () => {
    // Validate payment data exists
    if (!currentPaymentId || !sharePaymentUrl) {
      toast({
        title: "Share failed",
        description: "Payment data not available",
        variant: "destructive",
      })
      return
    }

    // Try native share first if available
    if (navigator.share) {
      try {
        // Check if device can share the full data
        if (navigator.canShare && navigator.canShare({ url: sharePaymentUrl })) {
          await navigator.share({
            title: "FlashPay Invoice",
            text: `Pay ${payment?.amount || 0}π to @${merchantSetup.piUsername}`,
            url: sharePaymentUrl,
          })
          return
        }
      } catch (error) {
        // Only proceed to fallback if it's not a user cancel
        if ((error as Error).name === "AbortError") {
          return
        }
        // If full share failed, try text-only share
        try {
          await navigator.share({
            title: "FlashPay Invoice",
            text: `Pay ${payment?.amount || 0}π: ${sharePaymentUrl}`,
          })
          return
        } catch (textError) {
          if ((textError as Error).name === "AbortError") {
            return
          }
        }
      }
    }

    // Native share unavailable or failed - show fallback menu
    setShowShareMenu(true)
  }

  const handleShareWhatsApp = () => {
    const text = `Pay ${payment?.amount || 0}π to @${merchantSetup.piUsername}: ${sharePaymentUrl}`
    const wa = `https://wa.me/?text=${encodeURIComponent(text)}`
    window.open(wa, "_blank")
    setShowShareMenu(false)
  }

  const handleShareTelegram = () => {
    const text = `Pay ${payment?.amount || 0}π to @${merchantSetup.piUsername}\n${sharePaymentUrl}`
    const tg = `https://t.me/share/url?url=${encodeURIComponent(sharePaymentUrl)}&text=${encodeURIComponent(`Pay ${payment?.amount || 0}π`)}`
    window.open(tg, "_blank")
    setShowShareMenu(false)
  }

  const handleShareSMS = () => {
    const text = `Pay ${payment?.amount || 0}π: ${sharePaymentUrl}`
    const sms = `sms:?body=${encodeURIComponent(text)}`
    window.location.href = sms
    setShowShareMenu(false)
  }

  const handleShareEmail = () => {
    const subject = "FlashPay Invoice"
    const body = `Pay ${payment?.amount || 0}π to @${merchantSetup.piUsername}\n\n${sharePaymentUrl}`
    const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    window.location.href = mailto
    setShowShareMenu(false)
  }

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(sharePaymentUrl)
      toast({
        title: "Copied!",
        description: "Payment link copied to clipboard",
      })
    } catch (error) {
      console.error("Copy failed:", error)
      toast({
        title: "Copy failed",
        description: "Unable to copy link",
        variant: "destructive",
      })
    }
  }

  const handleCopyPaymentId = async () => {
    try {
      await navigator.clipboard.writeText(currentPaymentId || "")
      toast({
        title: "Copied!",
        description: "Payment ID copied to clipboard",
      })
    } catch (error) {
      console.error("Copy failed:", error)
      toast({
        title: "Copy failed",
        description: "Unable to copy ID",
        variant: "destructive",
      })
    }
  }

  const handleUseConvertedAmount = () => {
    const local = Number.parseFloat(localAmount)
    const rate = Number.parseFloat(piRate)

    if (!localAmount || !piRate || local <= 0 || rate <= 0) {
      toast({
        title: "Invalid input",
        description: "Please enter valid amounts",
        variant: "destructive",
      })
      return
    }

    const piAmount = (local / rate).toFixed(8).replace(/\.?0+$/, "")
    setAmount(piAmount)
    setDisplayAmount(piAmount)
    setShowConversion(false)
    setLocalAmount("")
    toast({
      title: "Amount set",
      description: `Pi amount set to ${piAmount}π`,
    })
  }

  // CUSTOMER VIEW: Show payment page when ID detected in URL
  if (isCustomerView && customerPaymentId) {
    return <CustomerPaymentView paymentId={customerPaymentId} />
  }

  if (showQR && currentPaymentId) {
    if (typeof window !== "undefined") {
      console.log("[v0][HomePage-QR] ===== QR CODE GENERATION CONTEXT =====")
      console.log("[v0][HomePage-QR] Merchant opened from:", window.location.origin)
      console.log("[v0][HomePage-QR] Payment QR URL:", paymentLink)
      console.log("[v0][HomePage-QR]")
      console.log("[v0][HomePage-QR] When customer scans this QR:")
      const qrOrigin = paymentLink.match(/pi:\/\/([^\/\?]+)/)?.[1]
      console.log("[v0][HomePage-QR]   → Will redirect to:", `https://${qrOrigin}`)
      console.log("[v0][HomePage-QR]   → Customer will authenticate under:", `${qrOrigin}`)
      console.log("[v0][HomePage-QR]   → Merchant authenticated under:", window.location.hostname)
      console.log("[v0][HomePage-QR]")
      if (qrOrigin === window.location.hostname) {
        console.log("[v0][HomePage-QR] ✅ SAME DOMAIN - Payment flow will use same app context")
      } else {
        console.log("[v0][HomePage-QR] ⚠️  DIFFERENT DOMAINS - Risk of app_id mismatch!")
      }
    }
    
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
            {payment?.status === "paid" ? (
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

          {/* Payment Sharing Section */}
          <div className="mb-8 space-y-3">
            <div className="flex gap-2">
              <Button onClick={handleSharePayment} variant="outline" className="flex-1 gap-2">
                <Share2 className="h-4 w-4" />
                Share Payment
              </Button>
              <Button onClick={handleCopyLink} variant="outline" className="flex-1 gap-2">
                <Copy className="h-4 w-4" />
                Copy Link
              </Button>
            </div>

            {/* Payment ID Display */}
            {currentPaymentId && (
              <div className="flex items-center justify-between gap-2 p-3 rounded-lg bg-muted/50 text-xs">
                <div className="flex flex-col gap-1">
                  <span className="text-muted-foreground">Payment ID</span>
                  <code className="font-mono font-semibold break-all">{currentPaymentId}</code>
                </div>
                <Button
                  onClick={handleCopyPaymentId}
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2 flex-shrink-0"
                  title="Copy Payment ID"
                >
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
            )}

            {/* Share Menu Fallback */}
            {showShareMenu && (
              <div className="grid grid-cols-2 gap-2 p-3 rounded-lg bg-secondary/20 border border-secondary">
                <Button onClick={handleShareWhatsApp} variant="ghost" size="sm" className="text-xs h-10">
                  WhatsApp
                </Button>
                <Button onClick={handleShareTelegram} variant="ghost" size="sm" className="text-xs h-10">
                  Telegram
                </Button>
                <Button onClick={handleShareSMS} variant="ghost" size="sm" className="text-xs h-10">
                  SMS
                </Button>
                <Button onClick={handleShareEmail} variant="ghost" size="sm" className="text-xs h-10">
                  Email
                </Button>
                <Button onClick={handleCopyLink} variant="ghost" size="sm" className="text-xs h-10 col-span-2">
                  Copy Link
                </Button>
                <Button onClick={() => setShowShareMenu(false)} variant="ghost" size="sm" className="text-xs h-10 col-span-2">
                  Close
                </Button>
              </div>
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
      <div className="flex-1 flex flex-col px-4 py-6 pb-32 md:pb-6 safe-area-inset-bottom">
        {/* Amount Display */}
        <div className="text-center py-8">
          <div className="text-sm text-muted-foreground mb-2">Amount</div>
          <div className="text-6xl font-bold tabular-nums">
            {displayAmount}
            <span className="text-4xl text-muted-foreground ml-2">π</span>
          </div>
        </div>

        {/* Quick Amount Buttons */}
        <div className="grid grid-cols-4 gap-1.5 md:gap-2 mb-3 md:mb-6">
          <Button onClick={() => handleQuickAmount(1)} variant="outline" className="h-9 md:h-12">
            1π
          </Button>
          <Button onClick={() => handleQuickAmount(5)} variant="outline" className="h-9 md:h-12">
            5π
          </Button>
          <Button onClick={() => handleQuickAmount(10)} variant="outline" className="h-9 md:h-12">
            10π
          </Button>
          <Button onClick={() => handleQuickAmount(50)} variant="outline" className="h-9 md:h-12">
            50π
          </Button>
        </div>

        {/* Number Pad */}
        <div className="grid grid-cols-4 gap-2 md:gap-3 mb-3 md:mb-6">
          {["1", "2", "3"].map((num) => (
            <Button
              key={num}
              onClick={() => handleNumberClick(num)}
              variant="outline"
              className="h-13 md:h-16 text-xl md:text-2xl font-semibold"
            >
              {num}
            </Button>
          ))}
          <Button onClick={handleBackspace} variant="outline" className="h-13 md:h-16 row-span-2 bg-transparent">
            <ArrowLeft className="h-5 md:h-6 w-5 md:w-6" />
          </Button>

          {["4", "5", "6"].map((num) => (
            <Button
              key={num}
              onClick={() => handleNumberClick(num)}
              variant="outline"
              className="h-13 md:h-16 text-xl md:text-2xl font-semibold"
            >
              {num}
            </Button>
          ))}

          {["7", "8", "9"].map((num) => (
            <Button
              key={num}
              onClick={() => handleNumberClick(num)}
              variant="outline"
              className="h-13 md:h-16 text-xl md:text-2xl font-semibold"
            >
              {num}
            </Button>
          ))}
          <Button onClick={handleClear} variant="outline" className="h-13 md:h-16 text-xs md:text-sm bg-transparent">
            Clear
          </Button>

          <Button
            onClick={() => handleNumberClick("0")}
            variant="outline"
            className="h-13 md:h-16 text-xl md:text-2xl font-semibold col-span-2"
          >
            0
          </Button>
          <Button onClick={() => handleNumberClick(".")} variant="outline" className="h-13 md:h-16 text-xl md:text-2xl font-semibold">
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

        {/* Convert Local Price Button */}
        <Button
          onClick={() => setShowConversion(true)}
          variant="outline"
          className="w-full mt-3 gap-2"
        >
          <DollarSign className="h-4 w-4" />
          Convert Local Price to Pi
        </Button>
      </div>

      {/* Currency Conversion Modal */}
      {showConversion && (
        <div className="fixed inset-0 z-50 flex items-start md:items-center justify-center p-4 md:p-0 pt-16 md:pt-0 overflow-y-auto">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowConversion(false)} />
          <div className="relative bg-background rounded-t-lg md:rounded-lg w-full md:max-w-md max-h-[calc(100vh-120px)] md:max-h-[90vh] overflow-y-auto flex flex-col pb-20 md:pb-6">
            {/* Header */}
            <div className="flex items-center justify-between mb-4 shrink-0 px-6 pt-6">
              <h2 className="text-lg font-semibold">Convert to Pi</h2>
              <Button
                onClick={() => setShowConversion(false)}
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto px-6 space-y-4">
              {/* Local Amount */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Local Amount</label>
                <Input
                  type="number"
                  placeholder="Enter amount"
                  value={localAmount}
                  onChange={(e) => setLocalAmount(e.target.value)}
                  className="text-lg"
                />
              </div>

              {/* Currency Selector */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Currency</label>
                <Select value={currency} onValueChange={setCurrency}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USD">USD (US Dollar)</SelectItem>
                    <SelectItem value="EUR">EUR (Euro)</SelectItem>
                    <SelectItem value="GBP">GBP (British Pound)</SelectItem>
                    <SelectItem value="JPY">JPY (Japanese Yen)</SelectItem>
                    <SelectItem value="CNY">CNY (Chinese Yuan)</SelectItem>
                    <SelectItem value="INR">INR (Indian Rupee)</SelectItem>
                    <SelectItem value="KES">KES (Kenyan Shilling)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Pi Reference Rate */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Pi Reference Rate</label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">1 Pi =</span>
                  <Input
                    type="number"
                    placeholder="Rate"
                    value={piRate}
                    onChange={(e) => setPiRate(e.target.value)}
                    className="flex-1"
                  />
                  <span className="text-sm">{currency}</span>
                </div>
              </div>

              {/* Calculated Pi Amount and Button */}
              {(() => {
                const localNum = Number.parseFloat(localAmount)
                const rateNum = Number.parseFloat(piRate)
                const isValid = !isNaN(localNum) && !isNaN(rateNum) && localNum > 0 && rateNum > 0
                const piAmount = isValid ? (localNum / rateNum).toFixed(8).replace(/\.?0+$/, "") : "0"
                
                return isValid ? (
                  <div className="p-4 rounded-lg bg-secondary/20 space-y-4 mt-6">
                    <div>
                      <p className="text-xs text-muted-foreground mb-2">Pi Amount</p>
                      <p className="text-3xl font-bold">{piAmount}π</p>
                    </div>
                    <Button
                      onClick={() => {
                        setAmount(piAmount)
                        setDisplayAmount(piAmount)
                        setShowConversion(false)
                        setLocalAmount("")
                        setPiRate("")
                      }}
                      className="w-full"
                    >
                      Use This Pi Amount
                    </Button>
                  </div>
                ) : null
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
