"use client"
import { useEffect, type ReactNode } from "react"
import { usePathname } from "next/navigation"
import { showBottomNavigation } from "@/lib/ui-routes"

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname()
  const navigation = showBottomNavigation(path)
  useEffect(() => {
    const root = document.documentElement
    const nav = document.querySelector<HTMLElement>("[data-bottom-navigation]")
    const measure = () => root.style.setProperty("--bottom-navigation-height", `${navigation && nav ? nav.getBoundingClientRect().height : 0}px`)
    measure()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    if (nav) observer?.observe(nav)
    window.addEventListener("resize", measure)
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure) }
  }, [navigation, path])
  return <div className="app-content" data-navigation={navigation ? "visible" : "hidden"}>{children}</div>
}
