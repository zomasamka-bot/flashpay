import type { AppLocale } from "@/lib/i18n/config"
import type { TranslationDictionary } from "@/lib/i18n/config"

const dictionaryLoaders: Record<AppLocale, () => Promise<TranslationDictionary>> = {
  en: () => import("@/lib/i18n/dictionaries/en").then((module) => module.default),
  ar: () => import("@/lib/i18n/dictionaries/ar").then((module) => module.default),
  ru: () => import("@/lib/i18n/dictionaries/ru").then((module) => module.default),
  es: () => import("@/lib/i18n/dictionaries/es").then((module) => module.default),
  vi: () => import("@/lib/i18n/dictionaries/vi").then((module) => module.default),
  hi: () => import("@/lib/i18n/dictionaries/hi").then((module) => module.default),
  zh: () => import("@/lib/i18n/dictionaries/zh").then((module) => module.default),
}

export async function loadDictionary(locale: AppLocale): Promise<TranslationDictionary> {
  return dictionaryLoaders[locale]()
}
