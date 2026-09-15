export const SUPPORTED_LOCALES = ["en", "ar", "ru", "uk", "vi", "hi", "zh"] as const

export type AppLocale = (typeof SUPPORTED_LOCALES)[number]
export type TextDirection = "ltr" | "rtl"
export type TranslationDictionary = Readonly<Record<string, string>>
export type TranslationValues = Readonly<Record<string, string | number>>

export const DEFAULT_LOCALE: AppLocale = "en"
export const LOCALE_STORAGE_KEY = "flashpay:locale:v1"

export interface LocaleMetadata {
  locale: AppLocale
  htmlLang: string
  nativeName: string
  direction: TextDirection
}

export const LOCALE_METADATA: Record<AppLocale, LocaleMetadata> = {
  en: { locale: "en", htmlLang: "en", nativeName: "English", direction: "ltr" },
  ar: { locale: "ar", htmlLang: "ar", nativeName: "العربية", direction: "rtl" },
  ru: { locale: "ru", htmlLang: "ru", nativeName: "Русский", direction: "ltr" },
  uk: { locale: "uk", htmlLang: "uk", nativeName: "Українська", direction: "ltr" },
  vi: { locale: "vi", htmlLang: "vi", nativeName: "Tiếng Việt", direction: "ltr" },
  hi: { locale: "hi", htmlLang: "hi", nativeName: "हिन्दी", direction: "ltr" },
  zh: { locale: "zh", htmlLang: "zh-Hans", nativeName: "中文", direction: "ltr" },
}

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

export function normalizeAppLocale(value: string | null | undefined): AppLocale | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase().replace(/_/g, "-")
  if (!normalized) return null

  const language = normalized.split("-")[0]
  return isAppLocale(language) ? language : null
}

export function getLocaleDirection(locale: AppLocale): TextDirection {
  return LOCALE_METADATA[locale].direction
}
