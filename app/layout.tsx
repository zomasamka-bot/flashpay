import type React from "react"
import type { Metadata, Viewport } from "next"
import { GeistSans } from "geist/font/sans"
import { GeistMono } from "geist/font/mono"
import "./globals.css"
import { MobileNav } from "@/components/mobile-nav"
import { TestnetIndicator } from "@/components/testnet-indicator"
import { Toaster } from "@/components/ui/toaster"
import { DomainGuard } from "@/components/domain-guard"
import { ErrorBoundary } from "@/components/error-boundary"
import { PiSDKLoader } from "@/components/pi-sdk-loader"
import { Analytics } from "@vercel/analytics/next"

export const metadata: Metadata = {
  title: "FlashPay - Fast Pi Payments",
  description: "FlashPay - Create Pi payment requests in seconds",
  generator: "v0.app",
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#6366f1",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <head>
        <style>{`
html {
  font-family: ${GeistSans.style.fontFamily};
  --font-sans: ${GeistSans.variable};
  --font-mono: ${GeistMono.variable};
}
        `}</style>
      </head>
      <body>
        <ErrorBoundary>
          <PiSDKLoader>
            <TestnetIndicator />
            <DomainGuard>{children}</DomainGuard>
            <MobileNav />
            <Toaster />
          </PiSDKLoader>
        </ErrorBoundary>
        <Analytics />
      </body>
    </html>
  )
}
