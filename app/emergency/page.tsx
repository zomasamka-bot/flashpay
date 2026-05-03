"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, AlertTriangle } from "lucide-react"
import { useRouter } from "next/navigation"
import { BackButton } from "@/components/back-button"

interface StuckPayment {
  key: string
  id: string
  amount: number
  status: string
  createdAt: string
  note: string
}

export default function EmergencyPage() {
  const router = useRouter()
  const [stuckPayments, setStuckPayments] = useState<StuckPayment[]>([])
  const [loading, setLoading] = useState(true)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState<string>("")
  const [success, setSuccess] = useState<string>("")
  const [refreshing, setRefreshing] = useState(false)

  const checkStuckPayments = async () => {
    try {
      setRefreshing(true)
      const response = await fetch("/api/emergency/clear-stuck-payment")
      const data = await response.json()
      
      if (response.ok) {
        setStuckPayments(data.stuckPayments || [])
        setError("")
      } else {
        setError(data.error || "Failed to check for stuck payments")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error checking payments")
    } finally {
      setRefreshing(false)
      setLoading(false)
    }
  }

  useEffect(() => {
    checkStuckPayments()
  }, [])

  const handleClear = async () => {
    if (!window.confirm("This will clear all stuck pending payments. Continue?")) {
      return
    }

    try {
      setClearing(true)
      setError("")
      setSuccess("")

      const response = await fetch("/api/emergency/clear-stuck-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })

      const data = await response.json()

      if (response.ok) {
        setSuccess(`✅ Cleared ${data.clearedCount} stuck payment(s). System ready for new payments.`)
        setStuckPayments([])
        
        // Redirect to home after 2 seconds
        setTimeout(() => {
          router.push("/")
        }, 2000)
      } else {
        setError(data.error || "Failed to clear payments")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error clearing payments")
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-2xl mx-auto">
        <BackButton />

        <div className="mt-6">
          <h1 className="text-3xl font-bold mb-2">Emergency Payment Recovery</h1>
          <p className="text-muted-foreground mb-6">
            Clear stuck pending payments that are blocking the system
          </p>

          {error && (
            <Card className="mb-6 border-red-500/50 bg-red-50/50 dark:bg-red-950/20">
              <CardContent className="pt-6">
                <div className="flex gap-3">
                  <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-red-700 dark:text-red-300">Error</p>
                    <p className="text-red-600 dark:text-red-400 text-sm mt-1">{error}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {success && (
            <Card className="mb-6 border-green-500/50 bg-green-50/50 dark:bg-green-950/20">
              <CardContent className="pt-6">
                <div className="flex gap-3">
                  <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-semibold text-green-700 dark:text-green-300">Success</p>
                    <p className="text-green-600 dark:text-green-400 text-sm mt-1">{success}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {loading ? (
            <Card>
              <CardContent className="pt-6 flex items-center justify-center gap-3">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span>Checking for stuck payments...</span>
              </CardContent>
            </Card>
          ) : (
            <>
              {stuckPayments.length > 0 ? (
                <Card className="mb-6 border-orange-500/50 bg-orange-50/50 dark:bg-orange-950/20">
                  <CardHeader>
                    <CardTitle className="text-orange-700 dark:text-orange-400">
                      <AlertTriangle className="inline h-5 w-5 mr-2" />
                      Stuck Payments Found
                    </CardTitle>
                    <CardDescription>
                      {stuckPayments.length} pending payment(s) are blocking the payment system
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3 mb-6">
                      {stuckPayments.map((payment) => (
                        <div key={payment.id} className="p-3 bg-white dark:bg-gray-900 rounded border border-orange-200 dark:border-orange-900">
                          <div className="flex justify-between items-start mb-2">
                            <div>
                              <p className="font-mono text-sm text-muted-foreground">{payment.id}</p>
                              <p className="text-lg font-semibold">{payment.amount} Pi</p>
                            </div>
                            <Badge className="bg-orange-600">PENDING</Badge>
                          </div>
                          {payment.note && <p className="text-sm text-muted-foreground">{payment.note}</p>}
                          <p className="text-xs text-muted-foreground mt-2">
                            Created: {new Date(payment.createdAt).toLocaleString()}
                          </p>
                        </div>
                      ))}
                    </div>

                    <Button
                      onClick={handleClear}
                      disabled={clearing || refreshing}
                      className="w-full bg-red-600 hover:bg-red-700 text-white"
                      size="lg"
                    >
                      {clearing ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Clearing...
                        </>
                      ) : (
                        <>
                          Clear {stuckPayments.length} Stuck Payment(s)
                        </>
                      )}
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                <Card className="mb-6 border-green-500/50 bg-green-50/50 dark:bg-green-950/20">
                  <CardContent className="pt-6">
                    <div className="flex gap-3">
                      <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="font-semibold text-green-700 dark:text-green-300">System Healthy</p>
                        <p className="text-green-600 dark:text-green-400 text-sm mt-1">
                          No stuck payments found. The system is ready for new payments.
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              <div className="flex gap-2">
                <Button
                  onClick={checkStuckPayments}
                  disabled={refreshing || clearing}
                  variant="outline"
                  className="flex-1"
                >
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Refresh
                </Button>
                <Button
                  onClick={() => router.push("/")}
                  variant="outline"
                  className="flex-1"
                >
                  Back to Home
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
