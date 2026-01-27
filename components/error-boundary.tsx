"use client"

import { Component, type ReactNode } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle, RefreshCcw, Home } from "lucide-react"
import { CoreLogger } from "@/lib/core"
import { errorTracker } from "@/lib/security"
import { useRouter } from "next/navigation"

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error?: Error
  errorInfo?: any
  trackingId?: string
}

/**
 * Unified Error Boundary
 * Catches all React errors and displays friendly error screen
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: any) {
    // Log to unified error tracking
    const trackingId = errorTracker.logError("React Error Boundary", error.message, {
      stack: error.stack,
      componentStack: errorInfo.componentStack,
    })

    CoreLogger.error("Application error caught by boundary", {
      error: error.message,
      trackingId,
    })

    this.setState({ errorInfo, trackingId })
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined, trackingId: undefined })
  }

  render() {
    if (this.state.hasError) {
      return <ErrorScreen trackingId={this.state.trackingId} onReset={this.handleReset} />
    }

    return this.props.children
  }
}

function ErrorScreen({ trackingId, onReset }: { trackingId?: string; onReset: () => void }) {
  const router = useRouter()

  return (
    <div className="flex items-center justify-center min-h-screen bg-gradient-to-b from-background to-muted/20 p-4">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <div className="h-16 w-16 rounded-full bg-red-100 dark:bg-red-950 flex items-center justify-center">
              <AlertTriangle className="h-8 w-8 text-red-600" />
            </div>
          </div>
          <CardTitle>Something went wrong</CardTitle>
          <CardDescription>We encountered an unexpected error. Don't worry, your data is safe.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {trackingId && (
            <div className="p-3 rounded-lg bg-muted border">
              <p className="text-xs text-muted-foreground mb-1">Error Tracking ID</p>
              <Badge variant="outline" className="font-mono text-xs">
                {trackingId}
              </Badge>
            </div>
          )}

          <div className="space-y-2">
            <Button onClick={onReset} className="w-full">
              <RefreshCcw className="h-4 w-4 mr-2" />
              Try Again
            </Button>
            <Button onClick={() => router.push("/")} variant="outline" className="w-full">
              <Home className="h-4 w-4 mr-2" />
              Go to Home
            </Button>
          </div>

          <p className="text-xs text-center text-muted-foreground">
            If this problem persists, please report the tracking ID to support.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
