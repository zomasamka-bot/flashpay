"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, AlertTriangle } from "lucide-react"
import { useRouter } from "next/navigation"
import { BackButton } from "@/components/back-button"
import { useOwnerUid } from "@/lib/use-owner-uid"
import { config } from "@/lib/config"

interface StuckPayment {
  id: string
  amount: number
  status: string
  createdAt: string
  note: string
}

export default function EmergencyPage() {
  const router = useRouter()
  const { uidData } = useOwnerUid()
  const [stuckPayments, setStuckPayments] = useState<StuckPayment[]>([])
  const [loading, setLoading] = useState(true)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState<string>("")
  const [success, setSuccess] = useState<string>("")
  const [refreshing, setRefreshing] = useState(false)

  const checkStuckPayments = async () => {
    try {
      setRefreshing(true)
      
      if (uidData.status !== "success" || !uidData.accessToken || uidData.uid !== config.ownerUid) {
        setError("Not authorized. Only the owner can access this page.")
        return
      }
      
      const response = await fetch("/api/emergency/clear-stuck-payment", {
        headers: { Authorization: `Bearer ${uidData.accessToken}` }
      })
      const data = await response.json()
      
      if (response.ok) {
        setStuckPayments(data.stuckPayments || [])
        setError("")
      } else if (response.status === 401) {
        setError("Authentication failed. Please authenticate with Pi.")
      } else if (response.status === 403) {
        setError("You are not authorized to access this. Owner credentials required.")
      } else if (response.status === 500) {
        setError("Owner UID not configured on the server.")
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
  }, [uidData.status, uidData.uid, uidData.accessToken])

  const handleClear = async (paymentId: string) => {
    if (!window.confirm(`Clear stuck payment ${paymentId}? This cannot be undone.`)) {
      return
    }

    try {
      setClearing(true)
      setError("")
      setSuccess("")

      if (uidData.status !== "success" || !uidData.accessToken || uidData.uid !== config.ownerUid) {
        setError("Not authorized. Only the owner can clear payments.")
        return
      }

      const response = await fetch("/api/emergency/clear-stuck-payment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${uidData.accessToken}`
        },
        body: JSON.stringify({ paymentId })
      })

      const data = await response.json()

      if (response.ok) {
        setSuccess(`Cleared payment ${paymentId}. System ready for new payments.`)
        setStuckPayments(stuckPayments.filter(p => p.id !== paymentId))
        
        // Redirect to home after 2 seconds
        setTimeout(() => {
          router.push("/")
        }, 2000)
      } else if (response.status === 401) {
        setError("Authentication failed. Please authenticate with Pi.")
      } else if (response.status === 403) {
        setError("You are not authorized. Owner credentials required.")
      } else if (response.status === 409) {
        setError(data.error || "Cannot clear this payment - status not pending")
      } else if (response.status === 500) {
        setError("Owner UID not configured on the server.")
      } else {
        setError(data.error || "Failed to clear payment")
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
                          <Button
                            onClick={() => handleClear(payment.id)}
                            disabled={clearing || refreshing}
                            className="mt-3 w-full bg-red-600 hover:bg-red-700 text-white text-sm"
                            size="sm"
                          >
                            {clearing ? (
                              <>
                                <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                                Clearing...
                              </>
                            ) : (
                              <>
                                Clear This Payment
                              </>
                            )}
                          </Button>
                        </div>
                      ))}
                    </div>
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
