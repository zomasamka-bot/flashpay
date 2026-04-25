"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { useSettlementStatus, useProcessSettlements, type Settlement } from "@/lib/use-settlements"
import { Calendar, CheckCircle, Clock, AlertCircle, TrendingUp, Send } from "lucide-react"

interface MerchantSettlementsViewProps {
  merchantId: string | null
}

export function MerchantSettlementsView({ merchantId }: MerchantSettlementsViewProps) {
  const { stats, history, loading, error, refetch } = useSettlementStatus(merchantId)
  const { processSettlements, processing: processLoading } = useProcessSettlements(merchantId)

  const handleProcessSettlements = async () => {
    await processSettlements()
    // Refetch status after processing
    setTimeout(refetch, 1000)
  }

  if (!merchantId) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-center text-muted-foreground">Please authenticate to view settlements</p>
        </CardContent>
      </Card>
    )
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return (
          <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
            <CheckCircle className="h-3 w-3 mr-1" />
            Completed
          </Badge>
        )
      case "processing":
        return (
          <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
            <Clock className="h-3 w-3 mr-1 animate-spin" />
            Processing
          </Badge>
        )
      case "queued":
        return (
          <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400">
            <Clock className="h-3 w-3 mr-1" />
            Pending
          </Badge>
        )
      case "failed":
        return (
          <Badge className="bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400">
            <AlertCircle className="h-3 w-3 mr-1" />
            Failed
          </Badge>
        )
      default:
        return <Badge>{status}</Badge>
    }
  }

  return (
    <div className="space-y-6">
      {/* Settlement Stats */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="text-sm text-muted-foreground mb-2">Settled</div>
              <div className="text-3xl font-bold text-green-600">{stats.settled.toFixed(2)} π</div>
              <p className="text-xs text-muted-foreground mt-2">Already transferred</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="text-sm text-muted-foreground mb-2">Unsettled</div>
              <div className="text-3xl font-bold text-yellow-600">{stats.unsettled.toFixed(2)} π</div>
              <p className="text-xs text-muted-foreground mt-2">{stats.pendingCount} pending</p>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="text-sm text-muted-foreground mb-2">Total Balance</div>
              <div className="text-3xl font-bold">
                {(stats.settled + stats.unsettled).toFixed(2)} π
              </div>
              <p className="text-xs text-muted-foreground mt-2">settled + unsettled</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Process Button */}
      {stats && stats.pendingCount > 0 && (
        <Card className="border-yellow-200 bg-yellow-50 dark:bg-yellow-900/20">
          <CardContent className="pt-6 flex items-center justify-between">
            <div>
              <p className="font-semibold text-yellow-900 dark:text-yellow-200">
                {stats.pendingCount} settlements ready to process
              </p>
              <p className="text-sm text-yellow-700 dark:text-yellow-300">
                {stats.unsettled.toFixed(2)} π waiting for transfer
              </p>
            </div>
            <Button
              onClick={handleProcessSettlements}
              disabled={processLoading}
              className="whitespace-nowrap"
            >
              {processLoading ? (
                <>
                  <Spinner className="h-4 w-4 mr-2" />
                  Processing...
                </>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" />
                  Process Now
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Settlement History */}
      <Card>
        <CardHeader>
          <CardTitle>Settlement History</CardTitle>
          <CardDescription>
            Track all settlements and their blockchain transaction IDs
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : error ? (
            <div className="text-center py-8 text-red-600">
              <AlertCircle className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>{error}</p>
            </div>
          ) : history && history.length > 0 ? (
            <div className="space-y-3">
              {history.map((settlement: Settlement) => (
                <div key={settlement.id} className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/50 transition">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      {getStatusBadge(settlement.status)}
                      <span className="text-sm font-mono text-muted-foreground">
                        {settlement.payment_id?.slice(0, 8)}...
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {new Date(settlement.created_at).toLocaleDateString()}
                      </span>
                      {settlement.completed_at && (
                        <span>Completed {new Date(settlement.completed_at).toLocaleDateString()}</span>
                      )}
                    </div>
                  </div>

                  <div className="text-right ml-4">
                    <div className="text-lg font-bold">{settlement.amount.toFixed(2)} π</div>
                    {settlement.txid && (
                      <div className="text-xs font-mono text-green-600 mt-1">
                        <a
                          href={`https://explorer.minepi.com/transaction/${settlement.txid}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline break-all"
                        >
                          {settlement.txid.slice(0, 16)}...
                        </a>
                      </div>
                    )}
                    {settlement.error_message && (
                      <div className="text-xs text-red-600 mt-1">{settlement.error_message}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <TrendingUp className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No settlements yet</p>
              <p className="text-sm">Settlements will appear here after payments complete</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
