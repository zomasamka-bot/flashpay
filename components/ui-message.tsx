"use client"
import { useCallback } from "react"
import { usePathname } from "next/navigation"
import { useI18n } from "@/components/i18n-provider"
import { translateUpperOperationsText } from "@/components/upper-operations-arabic-layer"
import { UI_KEYS } from "@/lib/i18n/ui-keys"
import { isOwnerRoute } from "@/lib/ui-routes"

export function useUIText() {
  const {t, locale} = useI18n()
  const owner = isOwnerRoute(usePathname())
  return useCallback((text: string) => {
    if (owner) return translateUpperOperationsText(locale, text)
    const key = UI_KEYS[text]
    return key ? t(key, text) : text
  }, [t, locale, owner])
}
export function UIMessage({text}: {text: string}) {
  const translate = useUIText()
  return <>{translate(text)}</>
}
