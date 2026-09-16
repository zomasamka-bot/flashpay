"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Activity, Shield, User } from "lucide-react"
import { cn } from "@/lib/utils"

const links = [
  { href: "/operations", label: "Operations", icon: Activity },
  { href: "/control-panel", label: "Control", icon: Shield },
  { href: "/profile", label: "Profile", icon: User },
]

export function OwnerOperationsHeader() {
  const pathname = usePathname()
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85 pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex min-h-14 max-w-4xl items-center gap-2 px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">FlashPay Owner Operations</div>
          <div className="text-[11px] text-muted-foreground">Operational control plane</div>
        </div>
        <span className="shrink-0 rounded-full bg-secondary px-2.5 py-1 text-[11px] font-semibold" aria-label="Pi Network environment: Testnet">Testnet</span>
      </div>
      <nav aria-label="Owner operations" className="mx-auto flex max-w-4xl border-t px-2 sm:px-4">
        {links.map(({ href, label, icon: Icon }) => {
          const active = href === "/operations" ? pathname === href || pathname.startsWith("/operations/") : pathname === href
          return <Link key={href} href={href} aria-current={active ? "page" : undefined} className={cn("flex min-h-11 flex-1 items-center justify-center gap-1.5 border-b-2 px-2 text-xs font-medium transition-colors sm:text-sm", active ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}><Icon className="h-4 w-4" aria-hidden="true" />{label}</Link>
        })}
      </nav>
    </header>
  )
}
