"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  CheckCircle2,
  XCircle,
  AlertCircle,
  Copy,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Wifi,
  Globe,
  Server,
} from "lucide-react"
import { getSDKStatus } from "@/lib/pi-sdk"
import { unifiedStore } from "@/lib/unified-store"
import { useToast } from "@/hooks/use-toast"

export default function DiagnosticsPage() {
  const { toast } = useToast()
  const [diagnostics, setDiagnostics] = useState<any>(null)
  const [showDetails, setShowDetails] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const runDiagnostics = () => {
    setIsRefreshing(true)

    // Gather comprehensive diagnostic data
    const sdkStatus = getSDKStatus()
    const walletStatus = unifiedStore.getWalletStatus()
    const merchantState = unifiedStore.getMerchantState()
    const globalAnalytics = unifiedStore.getGlobalAnalytics()

    // Check network connectivity
    const isOnline = typeof navigator !== "undefined" ? navigator.onLine : false

    // Check Pi Browser detection
    const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "N/A"
    const isPiBrowser = userAgent.includes("PiBrowser") || userAgent.includes("Pi/")

    // Check localStorage availability
    let localStorageWorks = false
    try {
      localStorage.setItem("test", "test")
      localStorage.removeItem("test")
      localStorageWorks = true
    } catch (e) {
      localStorageWorks = false
    }

    // Get current URL info
    const currentURL = typeof window !== "undefined" ? window.location.href : "N/A"
    const currentDomain = typeof window !== "undefined" ? window.location.hostname : "N/A"
    const currentProtocol = typeof window !== "undefined" ? window.location.protocol : "N/A"
    const currentOrigin = typeof window !== "undefined" ? window.location.origin : "N/A"
    const isVercontent = currentOrigin.includes("vusercontent.net")
    const isLocalhost = currentOrigin.includes("localhost") || currentOrigin.includes("127.0.0.1")
    const configuredAppUrl = process.env.NEXT_PUBLIC_APP_URL || "Not configured"
    const configuredPiNetDomain = process.env.NEXT_PUBLIC_PINET_SUBDOMAIN || "Not configured"
    
    // Check if domain matches expected Pi domains
    const expectedDomains = ["flashpay.pi", "flashpay0734.pi"]
    const isDomainMatch = expectedDomains.includes(currentDomain)
    
    // Check wallet connection scope
    const hasPaymentsScope = walletStatus.isConnected && walletStatus.isInitialized

    // Check Pi SDK script tag
    const piScriptTag = typeof document !== "undefined" ? document.querySelector('script[src*="pi-sdk"]') : null
    const hasScriptTag = !!piScriptTag

    setDiagnostics({
      timestamp: new Date().toISOString(),
      environment: {
        isPiBrowser,
        isOnline,
        localStorageWorks,
        userAgent,
      },
      url: {
        currentURL,
        currentDomain,
        currentProtocol,
        currentOrigin,
        isVercontent,
        isLocalhost,
        configuredAppUrl,
        configuredPiNetDomain,
        expectedDomains,
        isDomainMatch,
        qrCodeWillUse: isVercontent || isLocalhost ? configuredAppUrl : currentOrigin,
      },
      scopes: {
        hasPaymentsScope,
        isWalletConnected: walletStatus.isConnected,
        canMakePayments: walletStatus.isConnected && walletStatus.isInitialized,
      },
      piSDK: {
        ...sdkStatus,
        hasScriptTag,
      },
      wallet: walletStatus,
      merchant: {
        isSetupComplete: merchantState.isSetupComplete,
        merchantId: merchantState.merchantId,
        piUsername: merchantState.piUsername || "Not connected",
        connectedAt: merchantState.connectedAt,
      },
      analytics: globalAnalytics,
    })

    setTimeout(() => setIsRefreshing(false), 500)
  }

  useEffect(() => {
    runDiagnostics()
  }, [])

  const copyToClipboard = () => {
    if (diagnostics) {
      navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2))
      toast({
        title: "Copied!",
        description: "Diagnostics copied to clipboard",
      })
    }
  }

  if (!diagnostics) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-4 text-primary" />
          <p>Running diagnostics...</p>
        </div>
      </div>
    )
  }

  const getStatusIcon = (condition: boolean) => {
    return condition ? (
      <CheckCircle2 className="h-5 w-5 text-green-600" />
    ) : (
      <XCircle className="h-5 w-5 text-red-600" />
    )
  }

  const getStatusBadge = (condition: boolean, trueText: string, falseText: string) => {
    return (
      <Badge variant={condition ? "default" : "destructive"} className="ml-2">
        {condition ? trueText : falseText}
      </Badge>
    )
  }

  // Determine overall status
  const criticalIssues = []
  const warnings = []

  if (!diagnostics.environment.isPiBrowser) {
    criticalIssues.push("Not running in Pi Browser")
  }

  if (!diagnostics.piSDK.hasPiSDK) {
    criticalIssues.push("Pi SDK not loaded")
  }

  if (!diagnostics.piSDK.hasScriptTag) {
    criticalIssues.push("Pi SDK script tag missing")
  }

  if (!diagnostics.environment.isOnline) {
    criticalIssues.push("No internet connection")
  }

  if (!diagnostics.piSDK.walletStatus.isInitialized) {
    warnings.push("SDK not initialized")
  }

  if (!diagnostics.merchant.isSetupComplete) {
    warnings.push("Wallet not connected")
  }

  if (diagnostics.url.isVercontent) {
    criticalIssues.push("Using Vercel preview URL (vusercontent.net) - QR codes won't work externally")
  }

  if (diagnostics.url.isLocalhost) {
    warnings.push("Using localhost - QR codes won't work on other devices")
  }

  if (diagnostics.url.configuredAppUrl === "Not configured") {
    warnings.push("NEXT_PUBLIC_APP_URL not configured - may cause QR code issues")
  }

  if (!diagnostics.url.isDomainMatch) {
    criticalIssues.push(
      `Domain mismatch: Current domain '${diagnostics.url.currentDomain}' is not in Pi Developer Portal. Expected: ${diagnostics.url.expectedDomains.join(" or ")}`
    )
  }

  if (!diagnostics.scopes.hasPaymentsScope && diagnostics.wallet.isInitialized) {
    warnings.push("Payments scope not granted - authentication may be required")
  }

  const isHealthy = criticalIssues.length === 0

  return (
    <div className="min-h-screen bg-background p-4 pb-24">
      <div className="max-w-2xl mx-auto space-y-4">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>System Diagnostics</CardTitle>
                <CardDescription>FlashPay App Health Check</CardDescription>
              </div>
              <Button onClick={runDiagnostics} disabled={isRefreshing} variant="outline" size="sm">
                <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-4 rounded-lg border bg-card">
                <div className="flex items-center gap-3">
                  {isHealthy ? (
                    <CheckCircle2 className="h-6 w-6 text-green-600" />
                  ) : (
                    <AlertCircle className="h-6 w-6 text-red-600" />
                  )}
                  <div>
                    <p className="font-semibold">{isHealthy ? "System Healthy" : "Issues Detected"}</p>
                    <p className="text-sm text-muted-foreground">
                      {criticalIssues.length} critical, {warnings.length} warnings
                    </p>
                  </div>
                </div>
                <Badge variant={isHealthy ? "default" : "destructive"}>{isHealthy ? "OK" : "ISSUES"}</Badge>
              </div>

              {criticalIssues.length > 0 && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Critical Issues</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc list-inside space-y-1 mt-2">
                      {criticalIssues.map((issue, i) => (
                        <li key={i} className="text-sm">
                          {issue}
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              {warnings.length > 0 && criticalIssues.length === 0 && (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle>Warnings</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc list-inside space-y-1 mt-2">
                      {warnings.map((warning, i) => (
                        <li key={i} className="text-sm">
                          {warning}
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Environment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {getStatusIcon(diagnostics.environment.isPiBrowser)}
                <span className="text-sm">Pi Browser Detection</span>
              </div>
              {getStatusBadge(diagnostics.environment.isPiBrowser, "Pi Browser", "Not Pi Browser")}
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Wifi className="h-5 w-5 text-muted-foreground" />
                <span className="text-sm">Internet Connection</span>
              </div>
              {getStatusBadge(diagnostics.environment.isOnline, "Online", "Offline")}
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {getStatusIcon(diagnostics.environment.localStorageWorks)}
                <span className="text-sm">LocalStorage Access</span>
              </div>
              {getStatusBadge(diagnostics.environment.localStorageWorks, "Working", "Blocked")}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Pi SDK Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {getStatusIcon(diagnostics.piSDK.hasScriptTag)}
                <span className="text-sm">SDK Script Loaded</span>
              </div>
              {getStatusBadge(diagnostics.piSDK.hasScriptTag, "Present", "Missing")}
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {getStatusIcon(diagnostics.piSDK.hasPiSDK)}
                <span className="text-sm">SDK Available</span>
              </div>
              {getStatusBadge(diagnostics.piSDK.hasPiSDK, "Available", "Not Found")}
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {getStatusIcon(diagnostics.wallet.isInitialized)}
                <span className="text-sm">SDK Initialized</span>
              </div>
              {getStatusBadge(diagnostics.wallet.isInitialized, "Yes", "No")}
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Server className="h-5 w-5 text-muted-foreground" />
                <span className="text-sm">Load Attempts</span>
              </div>
              <Badge variant="outline">{diagnostics.piSDK.sdkLoadAttempts}</Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Domain & Scope Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {getStatusIcon(diagnostics.url.isDomainMatch)}
                <span className="text-sm">Domain Match</span>
              </div>
              {getStatusBadge(diagnostics.url.isDomainMatch, "Correct", "Mismatch")}
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1">Current Domain</p>
              <code className="text-sm bg-muted px-2 py-1 rounded break-all">{diagnostics.url.currentDomain}</code>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1">Expected Domains</p>
              <div className="space-y-1">
                {diagnostics.url.expectedDomains.map((domain: string) => (
                  <code key={domain} className="text-sm bg-muted px-2 py-1 rounded block">
                    {domain}
                    {domain === diagnostics.url.configuredPiNetDomain && (
                      <Badge variant="outline" className="ml-2 text-xs">
                        Configured
                      </Badge>
                    )}
                  </code>
                ))}
              </div>
            </div>

            {!diagnostics.url.isDomainMatch && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle className="text-sm">Domain Mismatch (Case 1 Error)</AlertTitle>
                <AlertDescription className="text-xs space-y-1">
                  <p>You must access the app via one of the registered Pi domains:</p>
                  <ul className="list-disc list-inside mt-1">
                    {diagnostics.url.expectedDomains.map((domain: string) => (
                      <li key={domain}>{domain}</li>
                    ))}
                  </ul>
                  <p className="mt-2">
                    Current domain <code className="bg-background px-1">{diagnostics.url.currentDomain}</code> is not
                    registered in Pi Developer Portal.
                  </p>
                </AlertDescription>
              </Alert>
            )}

            <div className="flex items-center justify-between pt-2 border-t">
              <div className="flex items-center gap-2">
                {getStatusIcon(diagnostics.scopes.canMakePayments)}
                <span className="text-sm">Payments Scope</span>
              </div>
              {getStatusBadge(diagnostics.scopes.canMakePayments, "Granted", "Not Granted")}
            </div>

            {!diagnostics.scopes.canMakePayments && diagnostics.piSDK.hasPiSDK && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle className="text-sm">Payments Scope Missing (Case 2 Error)</AlertTitle>
                <AlertDescription className="text-xs space-y-1">
                  <p>The 'payments' scope is required to process payments.</p>
                  <p className="font-medium mt-2">Fix this by:</p>
                  <ol className="list-decimal list-inside space-y-1">
                    <li>Enable 'payments' scope in Pi Developer Portal</li>
                    <li>Ensure app status is 'Approved' or 'Development'</li>
                    <li>Clear Pi Browser app data</li>
                    <li>Re-authenticate with the app</li>
                  </ol>
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">URL Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Current Origin</p>
              <code className="text-sm bg-muted px-2 py-1 rounded break-all">{diagnostics.url.currentOrigin}</code>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1">Configured App URL</p>
              <code className="text-sm bg-muted px-2 py-1 rounded break-all">{diagnostics.url.configuredAppUrl}</code>
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-1">QR Codes Will Use</p>
              <code className="text-sm bg-muted px-2 py-1 rounded break-all font-semibold">
                {diagnostics.url.qrCodeWillUse}
              </code>
            </div>

            {diagnostics.url.isVercontent && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle className="text-sm">Vercel Preview URL Detected</AlertTitle>
                <AlertDescription className="text-xs">
                  vusercontent.net URLs are internal and won't work when scanned. Set NEXT_PUBLIC_APP_URL environment variable to your public domain.
                </AlertDescription>
              </Alert>
            )}

            {diagnostics.url.isLocalhost && (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle className="text-sm">Localhost Detected</AlertTitle>
                <AlertDescription className="text-xs">
                  QR codes will use {diagnostics.url.configuredAppUrl} instead of localhost.
                </AlertDescription>
              </Alert>
            )}

            <Alert>
              <Globe className="h-4 w-4" />
              <AlertTitle className="text-sm">Domain Registration</AlertTitle>
              <AlertDescription className="text-xs">
                This domain must be registered in Pi Developer Portal at developers.minepi.com
              </AlertDescription>
            </Alert>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Merchant Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {getStatusIcon(diagnostics.merchant.isSetupComplete)}
                <span className="text-sm">Wallet Connected</span>
              </div>
              {getStatusBadge(diagnostics.merchant.isSetupComplete, "Connected", "Not Connected")}
            </div>

            {diagnostics.merchant.isSetupComplete && (
              <>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Pi Username</p>
                  <code className="text-sm bg-muted px-2 py-1 rounded">@{diagnostics.merchant.piUsername}</code>
                </div>

                <div>
                  <p className="text-xs text-muted-foreground mb-1">Merchant ID</p>
                  <code className="text-xs bg-muted px-2 py-1 rounded font-mono">
                    {diagnostics.merchant.merchantId}
                  </code>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Technical Details</CardTitle>
              <Button onClick={() => setShowDetails(!showDetails)} variant="ghost" size="sm">
                {showDetails ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </Button>
            </div>
          </CardHeader>
          {showDetails && (
            <CardContent>
              <pre className="text-xs bg-muted p-4 rounded overflow-auto max-h-96">
                {JSON.stringify(diagnostics, null, 2)}
              </pre>
              <Button onClick={copyToClipboard} variant="outline" size="sm" className="mt-3 w-full bg-transparent">
                <Copy className="h-4 w-4 mr-2" />
                Copy Full Report
              </Button>
            </CardContent>
          )}
        </Card>

        <Card className="border-primary">
          <CardHeader>
            <CardTitle className="text-lg">Common Solutions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!diagnostics.environment.isPiBrowser && (
              <Alert>
                <AlertTitle className="text-sm">Not in Pi Browser</AlertTitle>
                <AlertDescription className="text-xs">
                  FlashPay requires Pi Browser. Download from pi.app and open this link inside the app.
                </AlertDescription>
              </Alert>
            )}

            {!diagnostics.piSDK.hasPiSDK && diagnostics.piSDK.hasScriptTag && (
              <Alert>
                <AlertTitle className="text-sm">SDK Not Loading</AlertTitle>
                <AlertDescription className="text-xs">
                  The Pi SDK script is present but not loading. Check your internet connection and try refreshing.
                </AlertDescription>
              </Alert>
            )}

            {!diagnostics.wallet.isInitialized && diagnostics.piSDK.hasPiSDK && (
              <Alert>
                <AlertTitle className="text-sm">SDK Not Initialized</AlertTitle>
                <AlertDescription className="text-xs">
                  The SDK is loaded but failed to initialize. This may indicate an app registration issue in Pi
                  Developer Portal.
                </AlertDescription>
              </Alert>
            )}

            {diagnostics.environment.isPiBrowser &&
              diagnostics.piSDK.hasPiSDK &&
              diagnostics.wallet.isInitialized &&
              !diagnostics.merchant.isSetupComplete && (
                <Alert>
                  <AlertTitle className="text-sm">Ready to Connect</AlertTitle>
                  <AlertDescription className="text-xs">
                    Everything looks good! Return to the home page and click "Connect Pi Wallet" to get started.
                  </AlertDescription>
                </Alert>
              )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
