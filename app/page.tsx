"use client"

import { UIMessage, useUIText } from "@/components/ui-message"
import { copyText, openExternalUrl } from "@/lib/browser-actions"

import { useState, useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Check, Wallet, AlertCircle, Share2, Copy, DollarSign, X, Globe2 } from "lucide-react";
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { createPayment, getPaymentFromServer } from "@/lib/operations"
import { acquireCreateIntent, finishCreateIntent, beginNextCustomerIntent, readSavedCreateIntent } from "@/lib/create-intent-client"

import { authenticateMerchant } from "@/lib/pi-sdk"
import { QRCode } from "@/components/qr-code"
import { usePaymentById, usePaymentStats } from "@/lib/use-payments"
import { useLoadPaymentHistory } from "@/lib/use-load-payment-history"
import { useMerchant } from "@/lib/use-merchant"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { CustomerPaymentView } from "@/components/customer-payment-view"
import { useI18n } from "@/components/i18n-provider"
import { LOCALE_METADATA, LOCALE_STORAGE_KEY, SUPPORTED_LOCALES, isAppLocale, type AppLocale } from "@/lib/i18n/config"
import { unifiedStore } from "@/lib/unified-store"
import {createMerchantActivityPrewarm} from "@/lib/merchant-activity-prewarm"

export default function HomePage() {
  useRouter()
  const { toast } = useToast()
  const { locale, setLocale, t } = useI18n()
  const tr = useUIText()

  // Load persistent payment history on app mount
  const verifiedHistorySummary = useLoadPaymentHistory()

  const [amount, setAmount] = useState("")
  const [createNote, setCreateNote] = useState("")
  const enteredRequestRef = useRef({amount, note:createNote})
  enteredRequestRef.current={amount,note:createNote}
  const [displayAmount, setDisplayAmount] = useState("0.00")
  const [currentPaymentId, setCurrentPaymentId] = useState<string | null>(null)
  const [showQR, setShowQR] = useState(false)
  const [redirecting] = useState(false)
  const hasShownSuccessRef = useRef(false)
  const createInFlightRef = useRef(false)
  const [isCreating, setIsCreating] = useState(false)
  const merchantSetup = useMerchant()
  // Prepare on opening an authenticated merchant page, before the create click.
  // No payment identity, amount, wallet authority or QR is created here.
  const prepareMerchantRef=useRef<ReturnType<typeof createMerchantActivityPrewarm>|null>(null)
  useEffect(()=>{
    prepareMerchantRef.current??=createMerchantActivityPrewarm((...args)=>fetch(...args))
    const prepare=()=>{
      if(document.visibilityState!=='visible'||/^#\/pay\//.test(window.location.hash))return
      void prepareMerchantRef.current!(unifiedStore.getMerchantState())
    }
    prepare()
    // No background timer or repeated idle polling. Returning to the merchant
    // page or entering an amount refreshes only a throttled, verified hint.
    window.addEventListener('focus',prepare)
    window.addEventListener('pointerdown',prepare,{passive:true})
    window.addEventListener('keydown',prepare)
    document.addEventListener('visibilitychange',prepare)
    return()=>{
      window.removeEventListener('focus',prepare)
      window.removeEventListener('pointerdown',prepare)
      window.removeEventListener('keydown',prepare)
      document.removeEventListener('visibilitychange',prepare)
    }
  },[merchantSetup.uid,merchantSetup.merchantId,merchantSetup.accessToken])
  const [savedRequest, setSavedRequest] = useState<Awaited<ReturnType<typeof readSavedCreateIntent>>>(null)
  useEffect(() => {
    let current = true
    const merchant = unifiedStore.getMerchantState()
    setSavedRequest(null)
    if (!merchant.uid || !merchant.merchantId) { setSavedRequest(null); return }
    void readSavedCreateIntent(merchant.uid,merchant.merchantId).then(async value => {
      if (!current || !value) return
      if (!value.completed) setSavedRequest(value)
      if (!merchant.accessToken) return
      try {
        const response=await fetch(`/api/payments/create-intent?intentId=${encodeURIComponent(value.id)}`,{
          headers:{Authorization:`Bearer ${merchant.accessToken}`},cache:"no-store",redirect:"error"})
        if(!response.ok)return
        const resolved=await response.json()
        if(resolved.resolution!=="FOUND"||resolved.intentId!==value.id||resolved.merchantUid!==value.merchantUid||
          resolved.merchantId!==value.merchantId||resolved.amount!==value.amount||resolved.note!==value.note)return
        const original=await getPaymentFromServer(resolved.paymentId,true)
        if(!current||createInFlightRef.current||!original||original.merchantId!==value.merchantId||original.amount!==value.amount)return
        await finishCreateIntent(value.id)
        if(!current||createInFlightRef.current)return
        setSavedRequest(null)
        // Recover the original QR, never create another request on page load.
        if(!["settled_to_merchant","refunded","cancelled","failed"].includes(original.status) &&
          (enteredRequestRef.current.amount==="" || (Number(enteredRequestRef.current.amount)===value.amount && enteredRequestRef.current.note===value.note))){
          setAmount(String(original.amount));setDisplayAmount(String(original.amount));setCreateNote(value.note)
          setCurrentPaymentId(original.id);setShowQR(true)
        }
      } catch { /* Uncertain identity is retained for an explicit same-intent retry. */ }
    }).catch(() => { if (current) setSavedRequest(null) })
    return () => { current = false }
  }, [merchantSetup.uid, merchantSetup.merchantId, merchantSetup.accessToken])
  const [isConnecting, setIsConnecting] = useState(false)
  const [sdkInitStatus, setSdkInitStatus] = useState<"loading" | "ready" | "error">("loading")
  const [sdkError, setSdkError] = useState<string | null>(null)

  usePaymentStats()

  const payment = usePaymentById(currentPaymentId || "")

  // CRITICAL: Check for payment ID on mount
  const [isCustomerView, setIsCustomerView] = useState(false)
  const [customerPaymentId, setCustomerPaymentId] = useState<string | null>(null)
  const [customerBridgeToken, setCustomerBridgeToken] = useState<string | null>(null)
  const [routeResolved, setRouteResolved] = useState(false)
  const [showShareMenu, setShowShareMenu] = useState(false)
  const [showConversion, setShowConversion] = useState(false)
  useEffect(() => {
    if (!showConversion) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.querySelector<HTMLElement>("[data-conversion-dialog] button")?.focus()
    return () => { previous?.focus({preventScroll:true}) }
  }, [showConversion])
  const [showLanguageSelector, setShowLanguageSelector] = useState(false)
  const [localAmount, setLocalAmount] = useState("")
  const [currency, setCurrency] = useState("USD")
  const [piRate, setPiRate] = useState("1")
  
  useEffect(() => {
    // Check hash first (Pi Browser QR route: #/pay/{id})
    const hashMatch = window.location.hash.match(/^#\/pay\/([0-9a-f-]{36})\/?(?:\?(.*))?$/i)
    if (hashMatch && hashMatch[1]) {
      const id = hashMatch[1]
      const hashParams = new URLSearchParams(hashMatch[2] || "")
      const localeHint = hashParams.get("lang")?.toLowerCase()
      const bridgeToken = hashParams.get("bridge")
      setCustomerBridgeToken(bridgeToken)
      if (isAppLocale(localeHint)) {
        try { window.localStorage.setItem(LOCALE_STORAGE_KEY, localeHint) } catch {}
        setLocale(localeHint)
      }
      console.log("[v0][Home-Init] Detected hash payment ID:", id)
      setIsCustomerView(true)
      setCustomerPaymentId(id)
      setRouteResolved(true)
      return
    }
    
    // Fallback: check pathname (Vercel production: /pay/{id})
    const pathnameMatch = window.location.pathname.match(/^\/pay\/([0-9a-f-]{36})\/?$/i)
    if (pathnameMatch && pathnameMatch[1]) {
      const id = pathnameMatch[1]
      console.log("[v0][Home-Init] Detected pathname payment ID:", id)
      setIsCustomerView(true)
      setCustomerPaymentId(id)
      setRouteResolved(true)
      return
    }
    
    // Fallback: check query param (backward compatibility)
    const urlParams = new URLSearchParams(window.location.search)
    const id = urlParams.get("id")
    if (id) {
      console.log("[v0][Home-Init] Detected query param payment ID:", id)
      setIsCustomerView(true)
      setCustomerPaymentId(id)
      setRouteResolved(true)
      return
    }
    
    console.log("[v0][Home-Init] No payment ID detected, rendering merchant form")
    setRouteResolved(true)
  }, [])

  // Initialize Pi SDK on app load (skip for customer view)
  useEffect(() => {
    if (redirecting || !routeResolved || isCustomerView) {
      return
    }
    
    const observeSDKReadiness = async () => {
      try {
        if (!window.__PI_SDK_READY__) throw new Error("Pi SDK readiness is unavailable")
        await window.__PI_SDK_READY__
        setSdkInitStatus("ready")
        setSdkError(null)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to initialize Pi SDK"
        setSdkInitStatus("error")
        setSdkError(message)
        toast({ title: "SDK Initialization Failed", description: message, variant: "destructive" })
      }
    }

    void observeSDKReadiness()
  }, [redirecting, toast, routeResolved, isCustomerView])

  useEffect(() => {
    if (payment?.status === "settled_to_merchant" && showQR && !hasShownSuccessRef.current) {
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

      // Only show final success toast when payment is fully settled to merchant
      // While paid_to_app/settlement_pending, show "Processing..." instead
      toast({
        title: "Payment Received!",
        description: `${payment.amount} Pi — settlement completing`,
      })

      setTimeout(() => {
        handleNextCustomer()
      }, 1000)
    }
  }, [payment?.status, showQR])

  const handleNextCustomer = async () => {
    try {
      await beginNextCustomerIntent()
    } catch (error) {
      toast({ title: "Payment identity unresolved", description: error instanceof Error ? error.message : "Cannot start another payment", variant: "destructive" })
      return
    }
    setAmount("")
    setCreateNote("")
    setSavedRequest(null)
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


    if (createInFlightRef.current) return
    createInFlightRef.current = true
    setIsCreating(true)
    try {
      const merchant = unifiedStore.getMerchantState()
      // This fresh button action may advance an acknowledged request. In-flight
      // and cross-tab epoch guards still prevent a queued click becoming a new one.
      const previous=await readSavedCreateIntent(merchant.uid || "",merchant.merchantId)
      if(previous?.completed)await beginNextCustomerIntent()
      const intentId = await acquireCreateIntent(merchant.uid || "", merchant.merchantId, amountNum, createNote)
      const result = await createPayment(amountNum, createNote, intentId)

      if (result.success && result.data) {
        await finishCreateIntent(intentId)
        setSavedRequest(null)
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
        description: error instanceof Error ? error.message : "Payment creation uncertain; retry the original request",
        variant: "destructive",
      })
    } finally {
      createInFlightRef.current = false
      setIsCreating(false)
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


  // Payment data is fetched from backend by ID, not from URL (authoritative source)
  const paymentLink = currentPaymentId && payment
    ? `pi://flashpay-two.vercel.app/pay/${encodeURIComponent(currentPaymentId)}?amount=${encodeURIComponent(String(payment.amount))}&entry=pi&lang=${encodeURIComponent(locale)}${payment.note ? `&note=${encodeURIComponent(payment.note)}` : ""}`
    : ""
  console.log("[v0][Home] Current payment ID:", currentPaymentId)
  console.log("[v0][Home] Payment object exists:", !!payment)
  console.log("[v0][Home] Final payment link (QR):", paymentLink)

  // Payment sharing handlers
  const sharePaymentUrl = currentPaymentId && payment
    ? `https://flashpay-two.vercel.app/pay/${encodeURIComponent(currentPaymentId)}?amount=${encodeURIComponent(String(payment.amount))}&entry=share&lang=${encodeURIComponent(locale)}${payment.note ? `&note=${encodeURIComponent(payment.note)}` : ""}`
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

    const shareText = `Pay ${payment?.amount || 0}π to @${merchantSetup.piUsername}: ${sharePaymentUrl}`
    const pi = window.Pi as (typeof window.Pi & {
      openShareDialog?: (title: string, message: string) => Promise<unknown> | unknown
    }) | undefined

    // Inside Pi Browser, use Pi's native OS share bridge first. On Android this
    // opens the phone share sheet directly instead of FlashPay's fallback menu.
    if (typeof pi?.openShareDialog === "function") {
      try {
        await pi.openShareDialog("FlashPay Invoice", shareText)
        return
      } catch (error) {
        if ((error as Error).name === "AbortError") return
        console.error("Pi native share failed:", error)
      }
    }

    // Standards-based fallback for browsers outside Pi Browser.
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({
          title: "FlashPay Invoice",
          text: shareText,
        })
        return
      } catch (error) {
        if ((error as Error).name === "AbortError") return
        console.error("Native share failed:", error)
      }
    }

    setShowShareMenu(true)
  }

  const handleShareWhatsApp = () => {
    const text = `Pay ${payment?.amount || 0}π to @${merchantSetup.piUsername}: ${sharePaymentUrl}`
    const wa = `https://wa.me/?text=${encodeURIComponent(text)}`
    openExternalUrl(wa)
    setShowShareMenu(false)
  }

  const handleShareTelegram = () => {
    const tg = `https://t.me/share/url?url=${encodeURIComponent(sharePaymentUrl)}&text=${encodeURIComponent(`Pay ${payment?.amount || 0}π`)}`
    openExternalUrl(tg)
    setShowShareMenu(false)
  }

  const handleShareSMS = () => {
    const text = `Pay ${payment?.amount || 0}π: ${sharePaymentUrl}`
    const separator = /iPad|iPhone|iPod/.test(navigator.userAgent) ? "&" : "?"
    const sms = `sms:${separator}body=${encodeURIComponent(text)}`
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
      if (!await copyText(sharePaymentUrl)) throw new Error("COPY_UNAVAILABLE")
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
      if (!await copyText(currentPaymentId || "")) throw new Error("COPY_UNAVAILABLE")
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

  // Show loader while route is resolving
  if (!routeResolved) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="mb-4 inline-block h-12 w-12 animate-spin rounded-full border-4 border-border border-t-primary"></div>
          <p className="text-sm text-muted-foreground"> <UIMessage text={"Loading payment..."} /> </p>
        </div>
      </div>
    )
  }

  // CUSTOMER VIEW: Show payment page when ID detected in URL
  if (isCustomerView && customerPaymentId) {
    return <CustomerPaymentView paymentId={customerPaymentId} bridgeToken={customerBridgeToken} />
  }

  if (showQR && currentPaymentId) {
    if (typeof window !== "undefined") {
      console.log("[v0][HomePage-QR] ===== QR CODE GENERATION CONTEXT =====")
      console.log("[v0][HomePage-QR] Merchant opened from:", window.location.origin)
      console.log("[v0][HomePage-QR] Payment QR URL:", paymentLink)
      console.log("[v0][HomePage-QR]")
      console.log("[v0][HomePage-QR] When customer scans this QR:")
      const qrOrigin = paymentLink.match(/pi:\/\/([^\/\?]+)/)?.[1]
      console.log("[v0][HomePage-QR]   → Will redirect to:", qrOrigin ? `https://${qrOrigin}` : "Pi Browser")
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
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">{t("home.verifiedTotal", "Verified total:")}</span>
              <span className="font-semibold">{verifiedHistorySummary?.settledTransactions ?? "—"} <UIMessage text={"sales"} /> </span>
              <span className="font-semibold">{verifiedHistorySummary ? verifiedHistorySummary.total.toFixed(2) : "—"} π</span>
            </div>
            <div className="flex min-w-0 max-w-full items-center gap-2 break-all text-xs text-muted-foreground">
              <Check className="h-3 w-3 text-green-600" />
              <span>@{merchantSetup.piUsername}</span>
            </div>
          </div>
        </div>

        {/* QR Payment View */}
        <div className="flex-1 flex flex-col items-center justify-center px-4 pt-8 pb-32 safe-area-inset-bottom">
          <div className="text-sm text-muted-foreground mb-4">{t("home.scanQr", "Scan QR Code to Pay")}</div>

          <div className="bg-white p-8 rounded-3xl shadow-2xl mb-6">
            <QRCode value={paymentLink} size={300} />
          </div>

          <div className="text-xs text-center text-muted-foreground mb-6 max-w-xs"> <UIMessage text={"Scan and open in Pi Browser for fastest payment"} /> </div>

          <div className="text-6xl font-bold mb-4 tabular-nums">
            {displayAmount}
            <span className="text-4xl text-muted-foreground ml-2">π</span>
          </div>

          {payment?.financialContract && <div className="mb-4 text-sm text-muted-foreground"> <UIMessage text={"Merchant commission:"} /> {Number(payment.financialContract.commissionStroops)/1e7} <UIMessage text={"π · Merchant net:"} /> {Number(payment.financialContract.merchantNetStroops)/1e7} π</div>}
          <div className="flex items-center gap-2 px-6 py-3 rounded-full bg-yellow-500/10 text-yellow-700 dark:text-yellow-500 mb-8">
            {payment?.status === "settled_to_merchant" ? (
              <>
                <Check className="h-5 w-5" />
                <span className="font-semibold">{t("home.paymentReceived", "Payment Received!")}</span>
              </>
            ) : (
              <>
                <div className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
                <span>{t("home.waitingPayment", "Waiting for payment...")}</span>
              </>
            )}
          </div>

          {/* Payment Sharing Section */}
          <div className="mb-8 space-y-3">
            <div className="flex gap-2">
              <Button onClick={handleSharePayment} variant="outline" className="flex-1 gap-2">
                <Share2 className="h-4 w-4" />
                {t("home.sharePayment", "Share Payment")}
              </Button>
              <Button onClick={handleCopyLink} variant="outline" className="flex-1 gap-2">
                <Copy className="h-4 w-4" />
                {t("home.copyLink", "Copy Link")}
              </Button>
            </div>

            {/* Payment ID Display */}
            {currentPaymentId && (
              <div className="flex items-center justify-between gap-2 p-3 rounded-lg bg-muted/50 text-xs">
                <div className="flex flex-col gap-1">
                  <span className="text-muted-foreground">{t("home.paymentId", "Payment ID")}</span>
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
                <Button onClick={handleShareSMS} variant="ghost" size="sm" className="text-xs h-10"> <UIMessage text={"SMS"} /> </Button>
                <Button onClick={handleShareEmail} variant="ghost" size="sm" className="text-xs h-10"> <UIMessage text={"Email"} /> </Button>
                <Button onClick={handleCopyLink} variant="ghost" size="sm" className="text-xs h-10 col-span-2">
                  {t("home.copyLink", "Copy Link")}
                </Button>
                <Button onClick={() => setShowShareMenu(false)} variant="ghost" size="sm" className="text-xs h-10 col-span-2">
                  {t("common.close", "Close")}
                </Button>
              </div>
            )}
          </div>

          <Button onClick={handleNextCustomer} className="h-14 px-12 text-lg" size="lg">
            {t("home.nextCustomer", "Next Customer")}
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
            <div className="text-sm font-medium"> <UIMessage text={"Pi SDK Failed to Load"} /> </div>
            <div className="text-xs mt-1">{sdkError}</div>
            <div className="flex gap-2 mt-2">
              <Button onClick={() => window.location.reload()} variant="outline" size="sm" className="h-7 text-xs">
                {t("common.reload", "Reload Page")}
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
                {sdkInitStatus === "loading" ? tr("Loading Pi SDK...") : tr("Wallet not connected")}
              </span>
            </div>
            <Button
              onClick={handleConnectWallet}
              disabled={isConnecting || sdkInitStatus !== "ready"}
              size="sm"
              variant="secondary"
              className="h-8 text-xs"
            >
              {isConnecting ? tr("Connecting...") : sdkInitStatus === "loading" ? tr("Please wait...") : tr("Connect Pi Wallet")}
            </Button>
          </div>
        </div>
      )}

      {/* Merchant Operational Data - Always Visible */}
      {merchantSetup.isSetupComplete && (
        <div className="border-b bg-muted/30 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">{t("home.verifiedTotal", "Verified total:")}</span>
              <span className="font-semibold">{verifiedHistorySummary?.settledTransactions ?? "—"} <UIMessage text={"sales"} /> </span>
              <span className="font-semibold">{verifiedHistorySummary ? verifiedHistorySummary.total.toFixed(2) : "—"} π</span>
            </div>
            <div className="flex min-w-0 max-w-full items-center gap-2 break-all text-xs text-muted-foreground">
              <Check className="h-3 w-3 text-green-600" />
              <span>@{merchantSetup.piUsername}</span>
            </div>
          </div>
        </div>
      )}

      {/* POS Terminal - Payment Input */}
      <div className="flex-1 flex flex-col px-4 py-6 pb-32 md:pb-6 safe-area-inset-bottom">
        {savedRequest && !showQR && (
          <Alert className="mb-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <p>{t("home.savedRequest", "An earlier request is saved. Restore its original amount before retrying; do not create a replacement.")}</p>
              <p className="mt-1 break-all text-xs">{savedRequest.amount} Pi · {savedRequest.id}</p>
              <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => {
                setAmount(String(savedRequest.amount)); setDisplayAmount(String(savedRequest.amount)); setCreateNote(savedRequest.note)
              }}>{t("home.restoreRequest", "Restore saved request")}</Button>
            </AlertDescription>
          </Alert>
        )}
        {/* Amount Display */}
        <div className="text-center py-8">
          <div className="text-sm text-muted-foreground mb-2">{t("home.amount", "Amount")}</div>
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
            {t("common.clear", "Clear")}
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
          disabled={isCreating || !amount || Number.parseFloat(amount) <= 0 || !merchantSetup.isSetupComplete}
          aria-busy={isCreating}
          className="w-full h-16 text-xl gap-2"
          size="lg"
        >
          <Check className="h-6 w-6" />
          {isCreating ? tr("Preparing your request…") : t("home.generateQr", "Generate QR Code")}
        </Button>

        {/* Explicitly retire only an acknowledged payment identity after reload. */}
        <Button
          onClick={handleNextCustomer}
          variant="outline"
          className="w-full mt-3"
        >
          {t("home.nextCustomer", "Next Customer / New Payment")}
        </Button>

        {/* Convert Local Price Button */}
        <Button
          onClick={() => setShowConversion(true)}
          variant="outline"
          className="w-full mt-3 gap-2"
        >
          <DollarSign className="h-4 w-4" />
          {t("home.convertLocal", "Convert Local Price to Pi")}
        </Button>

        {/* Language Selector — presentation only */}
        <div className="relative mt-2">
          <Button
            onClick={() => setShowLanguageSelector((open) => !open)}
            variant="outline"
            className="w-full gap-2"
            aria-haspopup="listbox"
            aria-expanded={showLanguageSelector}
          >
            <Globe2 className="h-4 w-4" />
            {t("common.language", "Language")} · {LOCALE_METADATA[locale].nativeName}
          </Button>
          {showLanguageSelector && (
            <div
              role="listbox"
              aria-label={t("common.language", "Language")}
              className="absolute bottom-full z-40 mb-2 w-full max-h-[50dvh] overflow-y-auto rounded-md border bg-background shadow-md"
            >
              {SUPPORTED_LOCALES.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="option"
                  aria-selected={locale === option}
                  onClick={() => {
                    setLocale(option as AppLocale)
                    setShowLanguageSelector(false)
                  }}
                  className="flex w-full items-center justify-between px-4 py-2.5 text-start text-sm hover:bg-muted focus:bg-muted focus:outline-none"
                >
                  <span>{LOCALE_METADATA[option].nativeName}</span>
                  {locale === option ? <Check className="h-4 w-4" /> : null}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Currency Conversion Modal */}
      {showConversion && (
        <div className="fixed inset-0 z-50 flex items-start md:items-center justify-center p-4 md:p-0 pt-16 md:pt-0 overflow-y-auto">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowConversion(false)} />
          <div data-conversion-dialog role="dialog" aria-modal="true" aria-labelledby="conversion-title" onKeyDown={(event) => {
            if (event.key === "Escape") setShowConversion(false)
            if (event.key === "Tab") {
              const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href]')).filter(el => el.offsetParent !== null)
              const first = controls[0], last = controls[controls.length - 1]
              if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
              else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
            }
          }} className="app-dialog relative bg-background rounded-lg w-full md:max-w-md overflow-y-auto flex flex-col pb-6">
            {/* Header */}
            <div className="flex items-center justify-between mb-4 shrink-0 px-6 pt-6">
              <h2 id="conversion-title" className="text-lg font-semibold">{t("convert.title", "Convert to Pi")}</h2>
              <Button
                onClick={() => setShowConversion(false)}
                aria-label={t("common.close")}
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
                <label className="text-sm font-medium">{t("convert.localAmount", "Local Amount")}</label>
                <Input
                  type="number"
                  placeholder={t("convert.enterAmount", "Enter amount")}
                  value={localAmount}
                  onChange={(e) => setLocalAmount(e.target.value)}
                  className="text-lg"
                />
              </div>

              {/* Currency Selector */}
              <div className="space-y-2">
                <label className="text-sm font-medium">{t("convert.currency", "Currency")}</label>
                <Select value={currency} onValueChange={setCurrency}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USD"> <UIMessage text={"USD (US Dollar)"} /> </SelectItem>
                    <SelectItem value="EUR"> <UIMessage text={"EUR (Euro)"} /> </SelectItem>
                    <SelectItem value="GBP"> <UIMessage text={"GBP (British Pound)"} /> </SelectItem>
                    <SelectItem value="JPY"> <UIMessage text={"JPY (Japanese Yen)"} /> </SelectItem>
                    <SelectItem value="CNY"> <UIMessage text={"CNY (Chinese Yuan)"} /> </SelectItem>
                    <SelectItem value="INR"> <UIMessage text={"INR (Indian Rupee)"} /> </SelectItem>
                    <SelectItem value="KES"> <UIMessage text={"KES (Kenyan Shilling)"} /> </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Pi Reference Rate */}
              <div className="space-y-2">
                <label className="text-sm font-medium">{t("convert.piRate", "Pi Reference Rate")}</label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">1 Pi =</span>
                  <Input
                    type="number"
                    placeholder={t("convert.rate", "Rate")}
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
                      <p className="text-xs text-muted-foreground mb-2">{t("convert.piAmount", "Pi Amount")}</p>
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
                      {t("convert.useAmount", "Use This Pi Amount")}
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
