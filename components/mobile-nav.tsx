"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Home, Plus, List, User } from "lucide-react"
import { cn } from "@/lib/utils"
import { ROUTES } from "@/lib/router"
import { useI18n } from "@/components/i18n-provider"
import { showBottomNavigation } from "@/lib/ui-routes"

export function MobileNav() {
  const pathname = usePathname()
  const { t } = useI18n()

  const navItems = [
    { href: ROUTES.HOME, icon: Home, label: t("nav.home", "Home") },
    { href: ROUTES.CREATE, icon: Plus, label: t("nav.create", "Create") },
    { href: ROUTES.PAYMENTS, icon: List, label: t("nav.sales", "Sales") },
    { href: ROUTES.PROFILE, icon: User, label: t("nav.profile", "Profile") },
  ]

  if (!showBottomNavigation(pathname)) {
    return null
  }

  return (
    <nav data-bottom-navigation aria-label={t("nav.navigation", "Main navigation")} className="bottom-navigation fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border print:hidden">
      <div className="flex items-stretch justify-around min-h-16 max-w-lg mx-auto px-2">
        {navItems.map(({ href, icon: Icon, label }) => {
          const isActive = pathname === href
          return (
            <Link
              key={href}
              href={href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex min-w-0 flex-col items-center justify-center gap-1 flex-1 px-1 py-2 text-center transition-colors",
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
