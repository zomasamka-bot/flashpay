"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertCircle, CheckCircle2, RefreshCw, Loader2 } from "lucide-react"
import { useToast } from "@/hooks/use-toast"

interface ResetStatus {
  success: boolean
  totalPayments?: number
  byStatus?: {
    pending: number
    paid: number
    failed: number
  }
  isBlocked?: boolean
  message?: string
  error?: string
}

export function PaymentResetPanel() {
  const { toast } = useToast()
  const [status, setStatus] = useState<ResetStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [resetting, setResetting] = useState(false)

  const checkStatus = async () => {
    try {
      setLoading(true)
      const response = await fetch("/api/reset/payments")
      const data = await response.json()
      setStatus(data)
    } catch (error) {
      console.error("Failed to check status:", error)
      setStatus({
        success: false,
        error: "Failed to check system status",
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    checkStatus()
    const interval = setInterval(checkStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  const handleReset = async () => {
    if (!window.confirm("⚠️  This will clear ALL pending payments and reset the system. Continue?")) {
      return
    }

    setResetting(true)
    try {
      const response = await fetch("/api/reset/payments", {
        method: "POST",
      })

      const data = await response.json()

      if (data.success) {
        toast({
          title: "System Reset Complete ✅",
          description: `Cleared ${data.paymentsCleaned || 0} stuck payment(s). System is now ready for new payments.`,
        })
        setTimeout(() => checkStatus(), 1000)
      } else {
        toast({
          title: "Reset Failed",
          description: data.error || "Unable to reset system",
          variant: "destructive",
        })
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to reset system",
        variant: "destructive",
      })
    } finally {
      setResetting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span className="ml-2">Checking system status...</span>
      </div>
    )
  }

  const isBlocked = status?.isBlocked
  const pendingCount = status?.byStatus?.pending ?? 0
  const totalPayments = status?.totalPayments ?? 0

  return (
    <div className="w-full max-w-2xl mx-auto p-4 space-y-4">
      {/* Status Alert */}
      {isBlocked ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>System Blocked ⚠️</AlertTitle>
          <AlertDescription className="mt-2">
            <div className="space-y-2">
              <p>
                <strong>{pendingCount} pending payment(s)</strong> are preventing new payments from being created.
              </p>
              <p className="text-sm">
                This happens when a payment gets stuck in the Pi Network&apos;s pending state. The system cannot
                accept new payments until this is cleared.
              </p>
            </div>
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>System Healthy ✅</AlertTitle>
          <AlertDescription>
            All payments are flowing normally. The system is ready to accept new payments.
          </AlertDescription>
        </Alert>
      )}

      {/* Payment Status Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span>Payment Status</span>
            <Button onClick={checkStatus} size="sm" variant="ghost" className="ml-auto h-8 w-8 p-0">
              <RefreshCw className="h-4 w-4" />
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            <div className="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
              <div className="text-3xl font-bold text-yellow-700 dark:text-yellow-500">{pendingCount}</div>
              <div className="text-sm text-yellow-700 dark:text-yellow-500 mt-1">Pending</div>
            </div>
            <div className="p-4 rounded-lg bg-green-500/10 border border-green-500/20">
              <div className="text-3xl font-bold text-green-700 dark:text-green-500">
                {status?.byStatus?.paid ?? 0}
              </div>
              <div className="text-sm text-green-700 dark:text-green-500 mt-1">Paid</div>
            </div>
            <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20">
              <div className="text-3xl font-bold text-red-700 dark:text-red-500">{status?.byStatus?.failed ?? 0}</div>
              <div className="text-sm text-red-700 dark:text-red-500 mt-1">Failed</div>
            </div>
          </div>
          <div className="text-xs text-muted-foreground mt-4">Total payments: {totalPayments}</div>
        </CardContent>
      </Card>

      {/* Reset Button */}
      {isBlocked && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle>System Recovery</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              The system is blocked by stuck pending payment(s). Use the button below to:
            </p>
            <ul className="text-sm space-y-2 text-muted-foreground">
              <li>• Clear all {pendingCount} stuck pending payment(s)</li>
              <li>• Restore Pi Network payment flow</li>
              <li>• Allow new payments to be created</li>
            </ul>

            <Button
              onClick={handleReset}
              disabled={resetting}
              variant="destructive"
              className="w-full h-12"
              size="lg"
            >
              {resetting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Resetting System...
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Clear Stuck Payments & Reset
                </>
              )}
            </Button>

            <p className="text-xs text-destructive/80">
              ⚠️ Warning: This will permanently delete the {pendingCount} stuck payment(s) from the system.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Help Text */}
      <div className="p-4 rounded-lg bg-muted text-sm space-y-2">
        <p className="font-semibold">How to Use This Reset Panel:</p>
        <ul className="space-y-1 text-muted-foreground list-disc list-inside">
          <li>
            <strong>Green</strong> - System is healthy, payments are flowing normally
          </li>
          <li>
            <strong>Red</strong> - System is blocked by stuck pending payment(s)
          </li>
          <li>
            <strong>Click Reset Button</strong> - Clear stuck payments and restore system
          </li>
          <li>The status refreshes automatically every 5 seconds</li>
        </ul>
      </div>
    </div>
  )
}
