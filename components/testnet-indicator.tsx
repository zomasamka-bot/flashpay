"use client"

import { Badge } from "@/components/ui/badge"

export function TestnetIndicator() {
  return (
    <div className="fixed top-2 right-2 z-50">
      <Badge variant="secondary" className="bg-secondary/80 backdrop-blur-sm">
        Testnet
      </Badge>
    </div>
  )
}
