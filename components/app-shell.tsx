"use client"
import { useEffect, type ReactNode } from "react"
import { usePathname } from "next/navigation"
import { showBottomNavigation } from "@/lib/ui-routes"

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname()
  const navigation = showBottomNavigation(path)
  useEffect(() => {
    const root = document.documentElement
    // Legacy Android WebViews may omit their system-bar safe-area inset.
    root.dataset.androidWebview = /Android/i.test(navigator.userAgent) && /PiBrowser|; wv\)/i.test(navigator.userAgent) ? "true" : "false"
    const nav = document.querySelector<HTMLElement>("[data-bottom-navigation]")
    const measure = () => {
      const v = window.visualViewport
      const keyboard = !!v && v.scale === 1 && window.innerHeight - v.height > 150 && /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")
      root.dataset.keyboardOpen = String(keyboard)
      root.style.setProperty("--bottom-navigation-height", `${navigation && nav && !keyboard ? nav.getBoundingClientRect().height : 0}px`)
    }
    measure()
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    if (nav) observer?.observe(nav)
    window.addEventListener("resize", measure)
    window.visualViewport?.addEventListener("resize", measure)
    document.addEventListener("focusin", measure)
    document.addEventListener("focusout", measure)
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); window.visualViewport?.removeEventListener("resize", measure); document.removeEventListener("focusin", measure); document.removeEventListener("focusout", measure) }
  }, [navigation, path])
  return <div className="app-content" data-navigation={navigation ? "visible" : "hidden"}>{children}</div>
}
