"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Home, Plus, List, User } from "lucide-react"
import { cn } from "@/lib/utils"
import { ROUTES } from "@/lib/router"
import { useI18n } from "@/components/i18n-provider"

export function MobileNav() {
  const pathname = usePathname()
  const { t } = useI18n()

  const navItems = [
    { href: ROUTES.HOME, icon: Home, label: t("nav.home", "Home") },
    { href: ROUTES.CREATE, icon: Plus, label: t("nav.create", "Create") },
    { href: ROUTES.PAYMENTS, icon: List, label: t("nav.sales", "Sales") },
    { href: ROUTES.PROFILE, icon: User, label: t("nav.profile", "Profile") },
  ]

  const ownerOperationalRoute = pathname === "/control-panel" || pathname === "/diagnostics" || pathname === "/emergency" || pathname === "/operations" || pathname.startsWith("/operations/")

  if (pathname.startsWith("/pay") || ownerOperationalRoute) {
    return null
  }

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border">
      <div className="flex items-center justify-around h-16 max-w-lg mx-auto px-4">
        {navItems.map(({ href, icon: Icon, label }) => {
          const isActive = pathname === href
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex flex-col items-center justify-center gap-1 flex-1 h-full transition-colors",
                isActive ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-5 w-5" />
              <span className="text-xs font-medium">{label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
