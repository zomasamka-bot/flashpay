"use client"

import { useState } from "react"
import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Check } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { BackButton } from "@/components/back-button"
import { createPayment } from "@/lib/operations"
import { getPaymentLink, ROUTES } from "@/lib/router"

export default function CreatePaymentPage() {
  const router = useRouter()
  const { toast } = useToast()
  const [amount, setAmount] = useState("")
  const [note, setNote] = useState("")
  const [isCreating, setIsCreating] = useState(false)

  useEffect(() => {
    router.replace(ROUTES.HOME)
  }, [router])

  const handleCreate = async () => {
    const amountNum = Number.parseFloat(amount)

    if (!amountNum || amountNum <= 0) {
      toast({
        title: "Invalid Amount",
        description: "Please enter a valid Pi amount",
        variant: "destructive",
      })
      return
    }

    setIsCreating(true)

    try {
      const result = await createPayment(amountNum, note)

      if (result.success && result.data) {
        toast({
          title: "Payment Created",
          description: "Your payment request is ready to share",
        })

        router.push(getPaymentLink(result.data.id))
      } else {
        toast({
          title: "Error",
          description: result.error || "Failed to create payment",
          variant: "destructive",
        })
      }
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div className="min-h-screen pb-20 pt-4">
      <div className="max-w-lg mx-auto px-4">
        <div className="flex items-center gap-4 mb-6">
          <BackButton />
          <h1 className="text-2xl font-bold">Create Payment</h1>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Payment Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="amount">Amount (π)</Label>
              <div className="relative">
                <Input
                  id="amount"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="text-2xl h-14 pr-12"
                />
                <div className="absolute right-4 top-1/2 -translate-y-1/2 text-2xl text-muted-foreground font-medium">
                  π
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="note">Note (Optional)</Label>
              <Textarea
                id="note"
                placeholder="e.g., Payment for services, Product purchase..."
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={4}
                className="resize-none"
              />
            </div>

            <Button
              onClick={handleCreate}
              disabled={isCreating || !amount}
              className="w-full h-12 text-lg gap-2"
              size="lg"
            >
              {isCreating ? (
                "Creating..."
              ) : (
                <>
                  <Check className="h-5 w-5" />
                  Create Payment Request
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        <div className="mt-6 p-4 bg-muted rounded-lg">
          <p className="text-sm text-muted-foreground">
            After creating, you'll receive a shareable link and QR code that anyone can use to pay you through Pi
            Wallet.
          </p>
        </div>
      </div>
    </div>
  )
}
