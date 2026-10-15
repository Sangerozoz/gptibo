import type { DirectStore } from '../shared/direct-store.ts'
import { directMediaUrl } from '../shared/direct-store.ts'
import type { Env } from './platform.ts'

type SiteRow = { name_zh: string; name_en: string; logo_media_id: string | null }
type CategoryRow = { id: string; name_zh: string; name_en: string; sort_order: number; active: number }
type ProductRow = { id: string; name_zh: string; name_en: string; description_zh: string; description_en: string; category_id: string; sort_order: number; listed: number; image_media_id: string | null }

export async function publicDirectStore(env: Env): Promise<DirectStore> {
  const db = env.INTEREST_DB
  const [site, categories, products] = await Promise.all([
    db.prepare('SELECT name_zh,name_en,logo_media_id FROM direct_site WHERE id=1').first<SiteRow>(),
    db.prepare('SELECT id,name_zh,name_en,sort_order,active FROM direct_categories ORDER BY sort_order,id').all<CategoryRow>(),
    db.prepare('SELECT id,name_zh,name_en,description_zh,description_en,category_id,sort_order,listed,image_media_id FROM direct_products ORDER BY sort_order,id').all<ProductRow>(),
  ])
  if (!site) throw new Error('Direct store settings not initialized')
  return {
    site: { nameZh: site.name_zh, nameEn: site.name_en, logoUrl: directMediaUrl(site.logo_media_id) },
    categories: categories.results.map(row => ({ id: row.id, nameZh: row.name_zh, nameEn: row.name_en, sortOrder: row.sort_order, active: !!row.active })),
    products: products.results.map(row => ({ id: row.id, nameZh: row.name_zh, nameEn: row.name_en, descriptionZh: row.description_zh, descriptionEn: row.description_en, categoryId: row.category_id, sortOrder: row.sort_order, listed: !!row.listed, imageUrl: directMediaUrl(row.image_media_id) })),
  }
}
