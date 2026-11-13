"use client"

import {publicNetworkLabel} from "@/lib/public-network"
import { Badge } from "@/components/ui/badge"
import { usePathname } from "next/navigation"

export function TestnetIndicator() {
  const pathname = usePathname()
  const ownerOperationalRoute = pathname === "/control-panel" || pathname === "/diagnostics" || pathname === "/emergency" || pathname === "/operations" || pathname.startsWith("/operations/")
  if (ownerOperationalRoute) return null

  return (
    <div className="flex justify-end px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-1 print:hidden">
      <Badge variant="secondary" className="bg-secondary/80 backdrop-blur-sm">
        {publicNetworkLabel}
      </Badge>
    </div>
  )
}
