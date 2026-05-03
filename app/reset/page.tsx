"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { PasswordGate } from "@/components/password-gate"
import { BackButton } from "@/components/back-button"
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

function PaymentResetContent() {
  const { toast } = useToast()
  const [status, setStatus] = useState<ResetStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [resetting, setResetting] = useState(false)

  const checkStatus = async () => {
    try {
      setLoading(true)
      const response = await fetch("/api/reset/payments", {
        method: "GET",
      })
      const data = await response.json()
      setStatus(data)
    } catch (error) {
      console.error("[v0] Failed to check payment status:", error)
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
    if (!window.confirm("⚠️ This will clear ALL pending payments and reset the system. Continue?")) {
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
      console.error("[v0] Reset error:", error)
      toast({
        title: "Error",
        description: "Failed to reset system",
        variant: "destructive",
      })
    } finally {
      setResetting(false)
    }
  }

  const isBlocked = status?.isBlocked
  const pendingCount = status?.byStatus?.pending ?? 0
  const paidCount = status?.byStatus?.paid ?? 0
  const failedCount = status?.byStatus?.failed ?? 0
  const totalPayments = status?.totalPayments ?? 0

  return (
    <div className="min-h-screen pb-20 pt-4 bg-background">
      <div className="max-w-2xl mx-auto px-4 space-y-6">
        {/* Header */}
        <div className="mb-6 flex items-center gap-3">
          <BackButton />
          <div>
            <h1 className="text-2xl font-bold">Payment System Reset</h1>
            <p className="text-sm text-muted-foreground">Clear stuck payments and restore the payment flow</p>
          </div>
        </div>

        {/* Status Loading */}
        {loading ? (
          <Card>
            <CardContent className="flex items-center justify-center p-8">
              <Loader2 className="h-6 w-6 animate-spin mr-3" />
              <span>Checking system status...</span>
            </CardContent>
          </Card>
        ) : (
          <>
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
                      This happens when a payment gets stuck in the Pi Network&apos;s pending state. Use the reset button
                      below to clear this and restore the payment flow.
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

            {/* Payment Status */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span>Payment Status</span>
                  <Button onClick={checkStatus} size="sm" variant="ghost" className="h-8 w-8 p-0">
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
                    <div className="text-3xl font-bold text-green-700 dark:text-green-500">{paidCount}</div>
                    <div className="text-sm text-green-700 dark:text-green-500 mt-1">Paid</div>
                  </div>
                  <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20">
                    <div className="text-3xl font-bold text-red-700 dark:text-red-500">{failedCount}</div>
                    <div className="text-sm text-red-700 dark:text-red-500 mt-1">Failed</div>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground mt-4">Total payments tracked: {totalPayments}</div>
              </CardContent>
            </Card>

            {/* Reset Action */}
            {isBlocked && (
              <Card className="border-destructive/50 bg-destructive/5">
                <CardHeader>
                  <CardTitle className="text-destructive">Emergency Reset Required</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-sm text-muted-foreground">The system is blocked by stuck pending payment(s).</p>
                  <p className="text-sm text-muted-foreground">This reset will:</p>
                  <ul className="text-sm space-y-2 text-muted-foreground list-disc list-inside">
                    <li>Clear {pendingCount} stuck pending payment(s) from Redis</li>
                    <li>Restore Pi Network payment flow</li>
                    <li>Allow new payments to be created immediately</li>
                  </ul>

                  <Button
                    onClick={handleReset}
                    disabled={resetting}
                    variant="destructive"
                    className="w-full h-12 mt-4"
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

                  <p className="text-xs text-destructive/80 mt-2">
                    ⚠️ Warning: This will permanently delete the {pendingCount} stuck payment record(s). This action
                    cannot be undone.
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Info Card */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">How This Works</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-3 text-muted-foreground">
                <p>
                  <strong>What causes stuck payments?</strong> When a payment enters Pi Network&apos;s pending state, it
                  can sometimes get stuck if the completion callback fails or times out.
                </p>
                <p>
                  <strong>Why does it block new payments?</strong> Pi Network enforces a rule: only one pending payment
                  can exist at a time. A stuck payment blocks the entire flow.
                </p>
                <p>
                  <strong>Is it safe to reset?</strong> Yes. This only deletes the stuck pending record. Completed (paid)
                  transactions are preserved.
                </p>
                <p>
                  <strong>What happens after reset?</strong> The system state clears immediately. You can create new
                  payments right away.
                </p>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}

export default function PaymentResetPage() {
  return (
    <PasswordGate>
      <PaymentResetContent />
    </PasswordGate>
  )
}
