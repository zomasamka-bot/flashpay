"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  DEFAULT_LOCALE,
  LOCALE_METADATA,
  LOCALE_STORAGE_KEY,
  getLocaleDirection,
  isAppLocale,
  type AppLocale,
  type TranslationDictionary,
  type TranslationValues,
} from "@/lib/i18n/config"
import { loadDictionary } from "@/lib/i18n/load-dictionary"

interface I18nContextValue {
  locale: AppLocale
  direction: "ltr" | "rtl"
  ready: boolean
  setLocale: (locale: AppLocale) => void
  t: (key: string, fallback?: string, values?: TranslationValues) => string
}

function formatMessage(template: string, values?: TranslationValues): string {
  if (!values) return template
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => {
    const value = values[key]
    return value === undefined ? match : String(value)
  })
}

const EMPTY_DICTIONARY: TranslationDictionary = Object.freeze({})

const I18nContext = createContext<I18nContextValue | null>(null)

function readStoredLocale(): AppLocale {
  if (typeof window === "undefined") return DEFAULT_LOCALE
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    return isAppLocale(stored) ? stored : DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

function persistLocale(locale: AppLocale): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // Storage can be unavailable in private/restricted WebViews. Locale remains in-memory.
  }
}

function applyDocumentLocale(locale: AppLocale): void {
  if (typeof document === "undefined") return
  const metadata = LOCALE_METADATA[locale]
  document.documentElement.lang = metadata.htmlLang
  document.documentElement.dir = metadata.direction
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(DEFAULT_LOCALE)
  const [initialized, setInitialized] = useState(false)
  const [dictionary, setDictionary] = useState<TranslationDictionary>(EMPTY_DICTIONARY)
  const [englishFallback, setEnglishFallback] = useState<TranslationDictionary>(EMPTY_DICTIONARY)
  const [ready, setReady] = useState(false)
  const loadSequenceRef = useRef(0)

  useEffect(() => {
    const storedLocale = readStoredLocale()
    setLocaleState(storedLocale)
    applyDocumentLocale(storedLocale)
    setInitialized(true)
  }, [])

  useEffect(() => {
    if (!initialized) return
    const sequence = ++loadSequenceRef.current
    setReady(false)
    applyDocumentLocale(locale)
    persistLocale(locale)

    const load = async () => {
      const [selected, english] = await Promise.all([
        loadDictionary(locale).catch(() => null),
        locale === DEFAULT_LOCALE ? Promise.resolve(null) : loadDictionary(DEFAULT_LOCALE).catch(() => null),
      ])
      if (loadSequenceRef.current !== sequence) return

      const activeDictionary = selected ?? english ?? EMPTY_DICTIONARY
      setDictionary(activeDictionary)
      setEnglishFallback(locale === DEFAULT_LOCALE ? activeDictionary : english ?? EMPTY_DICTIONARY)
      setReady(true)
    }

    void load()
  }, [initialized, locale])

  const setLocale = useCallback((nextLocale: AppLocale) => {
    if (!isAppLocale(nextLocale)) return
    setLocaleState(nextLocale)
  }, [])

  const t = useCallback((key: string, fallback?: string, values?: TranslationValues): string => {
    const template = dictionary[key] ?? englishFallback[key] ?? fallback ?? key
    return formatMessage(template, values)
  }, [dictionary, englishFallback])

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    direction: getLocaleDirection(locale),
    ready,
    setLocale,
    t,
  }), [locale, ready, setLocale, t])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext)
  if (!context) throw new Error("useI18n must be used within I18nProvider")
  return context
}
