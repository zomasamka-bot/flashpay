"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Home, Plus, List, User } from "lucide-react"
import { cn } from "@/lib/utils"
import { ROUTES } from "@/lib/router"

export function MobileNav() {
  const pathname = usePathname()

  const navItems = [
    { href: ROUTES.HOME, icon: Home, label: "Home" },
    { href: ROUTES.CREATE, icon: Plus, label: "Create" },
    { href: ROUTES.PAYMENTS, icon: List, label: "Payments" },
    { href: ROUTES.PROFILE, icon: User, label: "Profile" },
  ]

  if (pathname.startsWith("/pay")) {
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
