"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Clock, CheckCircle, ExternalLink, XCircle, Ban } from "lucide-react"
import { usePayments } from "@/lib/use-payments"
import type { Payment } from "@/lib/types"
import { getPaymentLink, ROUTES } from "@/lib/router"

export default function PaymentsPage() {
  const payments = usePayments()

  const PaymentCard = ({ payment }: { payment: Payment }) => {
    const statusConfig = {
      PAID: {
        variant: "default" as const,
        icon: CheckCircle,
        color: "text-green-600",
        label: "PAID",
      },
      PENDING: {
        variant: "secondary" as const,
        icon: Clock,
        color: "text-yellow-600",
        label: "PENDING",
      },
      FAILED: {
        variant: "destructive" as const,
        icon: XCircle,
        color: "text-red-600",
        label: "FAILED",
      },
      CANCELLED: {
        variant: "outline" as const,
        icon: Ban,
        color: "text-gray-600",
        label: "CANCELLED",
      },
    }

    const config = statusConfig[payment.status]
    const StatusIcon = config.icon

    return (
      <Link href={getPaymentLink(payment.id)}>
        <Card className="hover:border-primary transition-colors">
          <CardContent className="p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant={config.variant}>{config.label}</Badge>
                  <StatusIcon className={`h-4 w-4 ${config.color} flex-shrink-0`} />
                </div>
                <div className="text-2xl font-bold text-primary mb-1">{payment.amount.toFixed(2)} π</div>
                {payment.note && <p className="text-sm text-muted-foreground line-clamp-2 mb-2">{payment.note}</p>}
                <p className="text-xs text-muted-foreground">
                  {payment.status === "PAID"
                    ? `Paid ${payment.paidAt?.toLocaleDateString()}`
                    : `Created ${payment.createdAt.toLocaleDateString()}`}
                </p>
              </div>
              <ExternalLink className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-1" />
            </div>
          </CardContent>
        </Card>
      </Link>
    )
  }

  return (
    <div className="min-h-screen pb-20 pt-4">
      <div className="max-w-lg mx-auto px-4">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-2">Payments</h1>
          <p className="text-muted-foreground">Track all your payment requests</p>
        </div>

        {payments.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Clock className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-50" />
              <p className="text-muted-foreground mb-4">No payments yet. Create your first payment request!</p>
              <Link href={ROUTES.CREATE}>
                <Button>Create Payment</Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {payments.map((payment) => (
              <PaymentCard key={payment.id} payment={payment} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
