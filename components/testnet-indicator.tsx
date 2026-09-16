"use client"

import { Badge } from "@/components/ui/badge"
import { usePathname } from "next/navigation"

export function TestnetIndicator() {
  const pathname = usePathname()
  const ownerOperationalRoute = pathname === "/control-panel" || pathname === "/diagnostics" || pathname === "/emergency" || pathname === "/operations" || pathname.startsWith("/operations/")
  if (ownerOperationalRoute) return null

  return (
    <div className="fixed top-2 right-2 z-50">
      <Badge variant="secondary" className="bg-secondary/80 backdrop-blur-sm">
        Testnet
      </Badge>
    </div>
  )
}
