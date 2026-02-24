"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export default function TestAuthPage() {
  const [result, setResult] = useState<string>("")
  const [loading, setLoading] = useState(false)

  const testAuth = async () => {
    setLoading(true)
    setResult("Testing authentication...")

    try {
      if (typeof window === "undefined" || !window.Pi) {
        setResult("❌ Pi SDK not available. Please open in Pi Browser.")
        setLoading(false)
        return
      }

      console.log("[v0] Testing Pi.authenticate with ['payments'] scope")
      
      const authResult = await window.Pi.authenticate(
        ["payments"],
        (payment: any) => {
          console.log("[v0] Incomplete payment:", payment)
        }
      )

      console.log("[v0] Auth test result:", authResult)

      const resultText = `
✅ Authentication completed

User ID: ${authResult?.user?.uid || "N/A"}
Username: ${authResult?.user?.username || "N/A"}
Access Token: ${authResult?.accessToken ? "Present" : "Missing"}

Requested Scopes: ["payments"]
Granted Scopes: ${JSON.stringify(authResult?.user?.scopes || [])}

Has Payments Scope: ${authResult?.user?.scopes?.includes("payments") ? "✅ YES" : "❌ NO"}

Full Response:
${JSON.stringify(authResult, null, 2)}
      `

      setResult(resultText)
      
      if (!authResult?.user?.scopes?.includes("payments")) {
        setResult(prev => prev + "\n\n⚠️ ISSUE: Payments scope not granted!\n\nPossible causes:\n1. User denied permission\n2. App not configured in Pi Developer Portal\n3. App needs verification\n4. Domain mismatch")
      }
    } catch (error: any) {
      console.error("[v0] Auth test error:", error)
      setResult(`❌ Error: ${error.message}\n\n${JSON.stringify(error, null, 2)}`)
    }

    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-2xl mx-auto py-8">
        <Card>
          <CardHeader>
            <CardTitle>Pi Authentication Test</CardTitle>
            <CardDescription>
              Test Pi.authenticate to see what scopes are being granted
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button onClick={testAuth} disabled={loading} className="w-full" size="lg">
              {loading ? "Testing..." : "Test Authentication"}
            </Button>

            {result && (
              <pre className="p-4 bg-muted rounded-lg text-xs overflow-x-auto whitespace-pre-wrap">
                {result}
              </pre>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
