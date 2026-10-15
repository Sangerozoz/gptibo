import type { DirectCategory, DirectProduct } from '../../shared/direct-store'
import type { StorefrontLocale } from './storefront-locale'

export function localized(zh: string, en: string, locale: StorefrontLocale) {
  return locale === 'en' && en.trim() ? en.trim() : zh
}

export function productCopy(product: Pick<DirectProduct, 'nameZh' | 'nameEn' | 'descriptionZh' | 'descriptionEn'>, locale: StorefrontLocale) {
  return { name: localized(product.nameZh, product.nameEn, locale), description: localized(product.descriptionZh, product.descriptionEn, locale) }
}

export function categoryLabel(categories: readonly DirectCategory[], locale: StorefrontLocale) {
  return categories.filter(category => category.active).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)).map(category => ({ ...category, name: localized(category.nameZh, category.nameEn, locale) }))
}

export function orderedListedProducts(products: readonly DirectProduct[]) {
  return products.filter(product => product.listed).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
}
