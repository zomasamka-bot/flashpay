'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { unifiedStore } from '@/lib/unified-store'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { BackButton } from '@/components/back-button'
import { Spinner } from '@/components/ui/spinner'
import {
  Download,
  Copy,
  RefreshCw,
  TrendingUp,
  AlertCircle,
  CheckCircle,
  Clock,
  ArrowUpRight,
  FileText,
} from 'lucide-react'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'

interface Transfer {
  id: string
  transaction_id: string
  merchant_id: string
  merchant_address: string
  amount: number
  status: 'pending' | 'processing' | 'completed' | 'failed'
  pi_transfer_id?: string
  created_at: string
  completed_at?: string
  error_message?: string
  retry_count: number
}

interface TransferStats {
  total: number
  completed: number
  pending: number
  processing: number
  failed: number
  totalAmount: number
}

export default function TransfersPage() {
  const router = useRouter()
  const merchant = unifiedStore.getMerchant()
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [stats, setStats] = useState<TransferStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [retrying, setRetrying] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)

  useEffect(() => {
    if (!merchant?.id) {
      router.push('/profile')
      return
    }

    loadTransfers()
    const interval = autoRefresh ? setInterval(loadTransfers, 10000) : undefined
    return () => {
      if (interval) clearInterval(interval)
    }
  }, [merchant?.id, autoRefresh])

  async function loadTransfers() {
    try {
      if (!merchant?.id) return

      const response = await fetch(`/api/transfers?merchantId=${merchant.id}&limit=100`)

      if (!response.ok) {
        throw new Error('Failed to fetch transfers')
      }

      const data = await response.json()
      setTransfers(data.transfers || [])
      setStats(data.stats || null)
    } catch (err) {
      console.error('Failed to load transfers:', err)
      toast.error('Failed to load transfers')
    } finally {
      setLoading(false)
    }
  }

  async function retryTransfer(transferId: string) {
    try {
      setRetrying(transferId)
      const response = await fetch(`/api/transfers?action=retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transferId }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Retry failed')
      }

      toast.success('Transfer retry initiated')
      setTimeout(loadTransfers, 1000)
    } catch (err) {
      console.error('Retry failed:', err)
      toast.error(err instanceof Error ? err.message : 'Retry failed')
    } finally {
      setRetrying(null)
    }
  }

  async function exportTransfers(format: 'csv' | 'json') {
    try {
      setExporting(true)
      const response = await fetch(
        `/api/transfers?merchantId=${merchant?.id}&format=${format}`,
        { method: 'PUT' }
      )

      if (!response.ok) throw new Error('Export failed')

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `transfers_${merchant?.id}_${new Date().toISOString().split('T')[0]}.${format}`
      document.body.appendChild(a)
      a.click()
      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)

      toast.success(`Exported as ${format.toUpperCase()}`)
    } catch (err) {
      console.error('Export failed:', err)
      toast.error('Export failed')
    } finally {
      setExporting(false)
    }
  }

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard.writeText(text)
    setCopied(label)
    toast.success(`${label} copied`)
    setTimeout(() => setCopied(null), 2000)
  }

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-green-100 text-green-900'
      case 'processing':
        return 'bg-blue-100 text-blue-900'
      case 'pending':
        return 'bg-yellow-100 text-yellow-900'
      case 'failed':
        return 'bg-red-100 text-red-900'
      default:
        return 'bg-gray-100 text-gray-900'
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-4 w-4" />
      case 'processing':
        return <Clock className="h-4 w-4 animate-spin" />
      case 'failed':
        return <AlertCircle className="h-4 w-4" />
      default:
        return <Clock className="h-4 w-4" />
    }
  }

  const filteredTransfers = transfers.filter((t) => {
    if (statusFilter !== 'all' && t.status !== statusFilter) return false
    if (
      searchQuery &&
      !t.id.includes(searchQuery) &&
      !t.merchant_address.includes(searchQuery) &&
      !t.pi_transfer_id?.includes(searchQuery)
    ) {
      return false
    }
    return true
  })

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground flex items-center gap-2">
              <ArrowUpRight className="h-8 w-8 text-green-600" />
              Fund Transfers
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Monitor wallet-to-wallet fund transfers and settlement
            </p>
          </div>
          <BackButton />
        </div>

        {/* Summary Stats */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="text-xs">Total Transfers</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{stats.total}</p>
              </CardContent>
            </Card>

            <Card className="border-green-200 bg-green-50">
              <CardHeader className="pb-2">
                <CardDescription className="text-xs text-green-600">Completed</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold text-green-700">{stats.completed}</p>
              </CardContent>
            </Card>

            <Card className="border-blue-200 bg-blue-50">
              <CardHeader className="pb-2">
                <CardDescription className="text-xs text-blue-600">Processing</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold text-blue-700">{stats.processing}</p>
              </CardContent>
            </Card>

            <Card className="border-yellow-200 bg-yellow-50">
              <CardHeader className="pb-2">
                <CardDescription className="text-xs text-yellow-600">Pending</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold text-yellow-700">{stats.pending}</p>
              </CardContent>
            </Card>

            <Card className="border-red-200 bg-red-50">
              <CardHeader className="pb-2">
                <CardDescription className="text-xs text-red-600">Failed</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold text-red-700">{stats.failed}</p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Total Transferred */}
        {stats && (
          <Card className="border-green-300 bg-gradient-to-r from-green-50 to-emerald-50">
            <CardHeader>
              <CardTitle className="text-lg">Total Transferred</CardTitle>
              <CardDescription>All successfully transferred funds to your merchant wallet</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-4xl font-bold text-green-700">
                π{stats.totalAmount.toFixed(8)}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Controls */}
        <div className="flex flex-wrap gap-2 items-center">
          <Button
            size="sm"
            variant="outline"
            onClick={loadTransfers}
            disabled={loading}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={() => exportTransfers('csv')}
            disabled={exporting || transfers.length === 0}
          >
            <Download className="h-4 w-4 mr-2" />
            Export CSV
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={() => exportTransfers('json')}
            disabled={exporting || transfers.length === 0}
          >
            <Download className="h-4 w-4 mr-2" />
            Export JSON
          </Button>

          <div className="ml-auto flex items-center gap-2">
            <input
              type="checkbox"
              id="autoRefresh"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="h-4 w-4 rounded"
            />
            <label htmlFor="autoRefresh" className="text-sm text-muted-foreground cursor-pointer">
              Auto-refresh (10s)
            </label>
          </div>
        </div>

        {/* Filters */}
        <Card>
          <CardHeader>
            <CardTitle>Transfer History</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-4 flex-wrap">
              <Input
                placeholder="Search by ID, address, or Pi transfer ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 min-w-64"
              />
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="processing">Processing</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Transfers List */}
            {loading ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : filteredTransfers.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>No transfers found</p>
              </div>
            ) : (
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {filteredTransfers.map((transfer) => (
                  <div
                    key={transfer.id}
                    className="border border-border rounded-lg p-4 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <p className="text-sm font-mono text-muted-foreground">
                            {transfer.id.substring(0, 8)}...
                          </p>
                          <Badge className={getStatusBadgeColor(transfer.status)}>
                            <span className="flex items-center gap-1">
                              {getStatusIcon(transfer.status)}
                              {transfer.status.charAt(0).toUpperCase() + transfer.status.slice(1)}
                            </span>
                          </Badge>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold text-foreground">
                          π{transfer.amount.toFixed(8)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(transfer.created_at)}
                        </p>
                      </div>
                    </div>

                    {/* Details */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3 pb-3 border-t border-border pt-3 text-xs">
                      <div>
                        <p className="text-muted-foreground mb-1">Merchant Address</p>
                        <div className="flex items-center gap-1">
                          <p className="font-mono truncate text-xs">
                            {transfer.merchant_address.slice(0, 10)}...
                          </p>
                          <button
                            onClick={() =>
                              copyToClipboard(transfer.merchant_address, 'Address')
                            }
                            className="opacity-60 hover:opacity-100 transition-opacity flex-shrink-0"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                        </div>
                      </div>

                      <div>
                        <p className="text-muted-foreground mb-1">Retries</p>
                        <p className="font-semibold">{transfer.retry_count}/5</p>
                      </div>

                      {transfer.pi_transfer_id && (
                        <div>
                          <p className="text-muted-foreground mb-1">Pi Transfer ID</p>
                          <div className="flex items-center gap-1">
                            <p className="font-mono truncate text-xs">
                              {transfer.pi_transfer_id.slice(0, 10)}...
                            </p>
                            <button
                              onClick={() =>
                                copyToClipboard(transfer.pi_transfer_id || '', 'Transfer ID')
                              }
                              className="opacity-60 hover:opacity-100 transition-opacity flex-shrink-0"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      )}

                      {transfer.completed_at && (
                        <div>
                          <p className="text-muted-foreground mb-1">Completed</p>
                          <p>{formatDate(transfer.completed_at)}</p>
                        </div>
                      )}
                    </div>

                    {/* Error Message */}
                    {transfer.error_message && (
                      <div className="bg-red-50 border border-red-200 rounded p-2 mb-3">
                        <p className="text-xs text-red-900">{transfer.error_message}</p>
                      </div>
                    )}

                    {/* Retry Button */}
                    {transfer.status === 'failed' && transfer.retry_count < 5 && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => retryTransfer(transfer.id)}
                        disabled={retrying === transfer.id}
                        className="w-full"
                      >
                        {retrying === transfer.id ? (
                          <>
                            <Spinner className="w-3 h-3 mr-2" />
                            Retrying...
                          </>
                        ) : (
                          <>
                            <RefreshCw className="h-3 w-3 mr-2" />
                            Retry Transfer
                          </>
                        )}
                      </Button>
                    )}

                    {transfer.status === 'failed' && transfer.retry_count >= 5 && (
                      <div className="bg-red-50 border border-red-200 rounded p-2 text-center">
                        <p className="text-xs text-red-900">Max retries reached. Contact support.</p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Help */}
        <Card className="bg-blue-50 border-blue-200">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertCircle className="h-4 w-4" />
              How Transfers Work
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-blue-800 space-y-2">
            <p>
              When a payment is completed, funds are automatically transferred from the app wallet to your merchant wallet.
            </p>
            <p>
              <strong>Automatic Retry:</strong> If a transfer fails, the system automatically retries with exponential backoff (2s, 5s, 10s, 30s, 60s) up to 5 times.
            </p>
            <p>
              <strong>Manual Retry:</strong> Use the Retry button to manually retry failed transfers.
            </p>
            <p>
              <strong>Export:</strong> Download transfer history as CSV or JSON for accounting and reconciliation.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
