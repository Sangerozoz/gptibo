import type { DirectStore } from '../shared/direct-store.ts'
import { directMediaUrl } from '../shared/direct-store.ts'
import { ApiError, body, json, type Env } from './platform.ts'

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

type VersionedSite = SiteRow & { version: number }
type VersionedCategory = CategoryRow & { version: number }
type VersionedProduct = ProductRow & { version: number }
const siteView = (row: VersionedSite) => ({ nameZh: row.name_zh, nameEn: row.name_en, logoMediaId: row.logo_media_id, logoUrl: directMediaUrl(row.logo_media_id), version: row.version })
const categoryView = (row: VersionedCategory) => ({ id: row.id, nameZh: row.name_zh, nameEn: row.name_en, sortOrder: row.sort_order, active: !!row.active, version: row.version })
const productView = (row: VersionedProduct) => ({ id: row.id, nameZh: row.name_zh, nameEn: row.name_en, descriptionZh: row.description_zh, descriptionEn: row.description_en, categoryId: row.category_id, sortOrder: row.sort_order, listed: !!row.listed, imageMediaId: row.image_media_id, imageUrl: directMediaUrl(row.image_media_id), version: row.version })
const textField = (value: unknown, max: number, label: string, required = false) => {
  if (typeof value !== 'string' || Array.from(value.trim()).length > max || (required && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) throw new ApiError(`请填写有效的${label}。`)
  return value.trim()
}
const versionField = (value: unknown) => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ApiError('版本无效，请刷新后重试。')
  return Number(value)
}
const boolField = (value: unknown, label: string) => {
  if (typeof value !== 'boolean') throw new ApiError(`请选择有效的${label}。`)
  return Number(value)
}
const mediaField = async (env: Env, value: unknown) => {
  if (value === null) return null
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value) || !await env.INTEREST_DB.prepare('SELECT id FROM direct_media WHERE id=?').bind(value).first()) throw new ApiError('图片无效，请重新上传。')
  return value
}
function imageBytes(data: unknown) {
  if (typeof data !== 'string') throw new ApiError('请选择 PNG 或 JPG 图片。')
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(data)
  if (!match || match[2].length > 470000) throw new ApiError('图片格式或大小无效。')
  let decoded: string
  try { decoded = atob(match[2]) } catch { throw new ApiError('图片内容无效。') }
  const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0))
  if (bytes.length < 32) throw new ApiError('图片内容无效。')
  if (bytes.length > 350000) throw new ApiError('图片大小需小于 350 KB。', 413)
  let width = 0, height = 0
  if (match[1] === 'image/png') {
    const signature = [137,80,78,71,13,10,26,10]
    if (!signature.every((byte, index) => bytes[index] === byte) || bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 13 || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') throw new ApiError('PNG 图片内容无效。')
    const view = new DataView(bytes.buffer)
    width = view.getUint32(16); height = view.getUint32(20)
  } else {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new ApiError('JPG 图片内容无效。')
    let offset = 2
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) break
      const marker = bytes[offset + 1]
      if (marker === 0xda) break
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
      if (length < 2 || offset + length + 2 > bytes.length) break
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        height = (bytes[offset + 5] << 8) | bytes[offset + 6]
        width = (bytes[offset + 7] << 8) | bytes[offset + 8]
        break
      }
      offset += length + 2
    }
  }
  if (!width || !height || width > 2048 || height > 2048) throw new ApiError('图片尺寸无效或超过 2048 像素。')
  return { mime: match[1], base64: match[2], bytes }
}
const audit = (env: Env, id: string, action: string, target: string, note: string) => env.INTEREST_DB.prepare('INSERT INTO admin_audit(id,action,target_id,note,created_at) VALUES (?,?,?,?,?)').bind(id, action, target, note, Date.now())
async function updated(env: Env, id: string, message: string) {
  if (!await env.INTEREST_DB.prepare('SELECT id FROM admin_audit WHERE id=?').bind(id).first()) throw new ApiError(message, 409)
}
async function ordered(env: Env, kind: 'categories' | 'products', data: Record<string, unknown>) {
  const db = env.INTEREST_DB, table = kind === 'categories' ? 'direct_categories' : 'direct_products'
  const known = (await db.prepare(`SELECT id FROM ${table} ORDER BY sort_order,id`).all<{ id: string }>()).results.map(row => row.id)
  const ids = data.ids
  if (!Array.isArray(ids) || ids.length !== known.length || new Set(ids).size !== known.length || !ids.every(id => known.includes(id))) throw new ApiError('排序列表无效，请刷新后重试。')
  const version = versionField(data.version), event = crypto.randomUUID()
  await db.batch([
    db.prepare('UPDATE direct_order_state SET version=version+1,change_id=? WHERE kind=? AND version=? AND (SELECT count(*) FROM ' + table + ')=?').bind(event, kind, version, ids.length),
    ...ids.map((id, position) => db.prepare(`UPDATE ${table} SET sort_order=? WHERE id=? AND EXISTS(SELECT 1 FROM direct_order_state WHERE kind=? AND change_id=?)`).bind(position, id, kind, event)),
    db.prepare("INSERT INTO admin_audit(id,action,target_id,note,created_at) SELECT ?,'direct-order-update',?,?,? FROM direct_order_state WHERE kind=? AND change_id=?").bind(event, kind, `admin:${env.ADMIN_USERNAME} 更新排序`, Date.now(), kind, event),
  ])
  await updated(env, event, '排序已被更新，请刷新后重试。')
  return json({ version: version + 1 })
}

export async function directStoreAdminRoute(request: Request, env: Env, path: string): Promise<Response> {
  const db = env.INTEREST_DB, method = request.method
  if (path === '/api/admin/direct-store/media') {
    if (method !== 'POST') throw new ApiError('请求方式不支持。', 405)
    const data = await body(request, 500000)
    const { mime, base64 } = imageBytes(data.image)
    const id = crypto.randomUUID()
    await db.prepare('INSERT INTO direct_media(id,mime,base64,created_at) VALUES (?,?,?,?)').bind(id, mime, base64, Date.now()).run()
    return json({ id, url: directMediaUrl(id) }, 201)
  }
  if (path === '/api/admin/direct-store/site') {
    if (method === 'GET') {
      const row = await db.prepare('SELECT name_zh,name_en,logo_media_id,version FROM direct_site WHERE id=1').first<VersionedSite>()
      if (!row) throw new ApiError('店铺设置尚未初始化。', 503)
      return json(siteView(row))
    }
    if (method !== 'POST') throw new ApiError('请求方式不支持。', 405)
    const data = await body(request), version = versionField(data.version)
    const nameZh = textField(data.nameZh, 32, '中文店名', true), nameEn = textField(data.nameEn, 32, '英文店名')
    const logo = await mediaField(env, data.logoMediaId), event = crypto.randomUUID()
    await db.batch([
      db.prepare('UPDATE direct_site SET name_zh=?,name_en=?,logo_media_id=?,version=version+1,change_id=?,updated_at=? WHERE id=1 AND version=?').bind(nameZh, nameEn, logo, event, Date.now(), version),
      db.prepare("INSERT INTO admin_audit(id,action,target_id,note,created_at) SELECT ?,'direct-site-update','platform',?,? FROM direct_site WHERE id=1 AND change_id=?").bind(event, `admin:${env.ADMIN_USERNAME} 更新店铺形象`, Date.now(), event),
    ])
    await updated(env, event, '店铺设置已更新，请刷新后重试。')
    const row = await db.prepare('SELECT name_zh,name_en,logo_media_id,version FROM direct_site WHERE id=1').first<VersionedSite>()
    return json(siteView(row!))
  }
  if (path === '/api/admin/direct-store/categories/order' && method === 'POST') return ordered(env, 'categories', await body(request))
  if (path === '/api/admin/direct-store/categories') {
    if (method === 'GET') {
      const rows = (await db.prepare('SELECT id,name_zh,name_en,sort_order,active,version FROM direct_categories ORDER BY sort_order,id').all<VersionedCategory>()).results
      const state = await db.prepare("SELECT version FROM direct_order_state WHERE kind='categories'").first<{ version: number }>()
      return json({ categories: rows.map(categoryView), orderVersion: state?.version ?? 0 })
    }
    if (method !== 'POST') throw new ApiError('请求方式不支持。', 405)
    const data = await body(request), nameZh = textField(data.nameZh, 32, '分类中文名称', true), nameEn = textField(data.nameEn, 32, '分类英文名称')
    const id = 'cat-' + crypto.randomUUID(), event = crypto.randomUUID(), now = Date.now()
    await db.batch([
      db.prepare('INSERT INTO direct_categories(id,name_zh,name_en,sort_order,updated_at) VALUES (?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM direct_categories),?)').bind(id, nameZh, nameEn, now),
      audit(env, event, 'direct-category-create', id, `admin:${env.ADMIN_USERNAME} 新增分类`),
    ])
    const row = await db.prepare('SELECT id,name_zh,name_en,sort_order,active,version FROM direct_categories WHERE id=?').bind(id).first<VersionedCategory>()
    return json({ category: categoryView(row!) }, 201)
  }
  const categoryMatch = path.match(/^\/api\/admin\/direct-store\/categories\/([a-z0-9-]+)$/)
  if (categoryMatch) {
    if (method !== 'POST') throw new ApiError('请求方式不支持。', 405)
    const data = await body(request), version = versionField(data.version)
    const nameZh = textField(data.nameZh, 32, '分类中文名称', true), nameEn = textField(data.nameEn, 32, '分类英文名称'), active = boolField(data.active, '分类状态')
    const event = crypto.randomUUID(), id = categoryMatch[1]
    await db.batch([
      db.prepare('UPDATE direct_categories SET name_zh=?,name_en=?,active=?,version=version+1,change_id=?,updated_at=? WHERE id=? AND version=?').bind(nameZh, nameEn, active, event, Date.now(), id, version),
      db.prepare("INSERT INTO admin_audit(id,action,target_id,note,created_at) SELECT ?,'direct-category-update',id,?,? FROM direct_categories WHERE id=? AND change_id=?").bind(event, `admin:${env.ADMIN_USERNAME} 更新分类`, Date.now(), id, event),
    ])
    await updated(env, event, '分类已更新，请刷新后重试。')
    const row = await db.prepare('SELECT id,name_zh,name_en,sort_order,active,version FROM direct_categories WHERE id=?').bind(id).first<VersionedCategory>()
    return json({ category: categoryView(row!) })
  }
  if (path === '/api/admin/direct-store/products/order' && method === 'POST') return ordered(env, 'products', await body(request))
  if (path === '/api/admin/direct-store/products' && method === 'GET') {
    const rows = (await db.prepare('SELECT id,name_zh,name_en,description_zh,description_en,category_id,sort_order,listed,image_media_id,version FROM direct_products ORDER BY sort_order,id').all<VersionedProduct>()).results
    const state = await db.prepare("SELECT version FROM direct_order_state WHERE kind='products'").first<{ version: number }>()
    return json({ products: rows.map(productView), orderVersion: state?.version ?? 0 })
  }
  const productMatch = path.match(/^\/api\/admin\/direct-store\/products\/([a-z0-9-]+)$/)
  if (productMatch) {
    const id = productMatch[1]
    if (method === 'GET') {
      const row = await db.prepare('SELECT id,name_zh,name_en,description_zh,description_en,category_id,sort_order,listed,image_media_id,version FROM direct_products WHERE id=?').bind(id).first<VersionedProduct>()
      if (!row) throw new ApiError('商品不存在。', 404)
      return json({ product: productView(row) })
    }
    if (method !== 'POST') throw new ApiError('请求方式不支持。', 405)
    const data = await body(request), version = versionField(data.version)
    const nameZh = textField(data.nameZh, 64, '商品中文名称', true), nameEn = textField(data.nameEn, 64, '商品英文名称')
    const descriptionZh = textField(data.descriptionZh, 200, '商品中文简介'), descriptionEn = textField(data.descriptionEn, 200, '商品英文简介')
    const categoryId = data.categoryId
    if (typeof categoryId !== 'string' || !await db.prepare('SELECT id FROM direct_categories WHERE id=?').bind(categoryId).first()) throw new ApiError('分类不存在，请重新选择。')
    const listed = boolField(data.listed, '商品状态'), image = await mediaField(env, data.imageMediaId), event = crypto.randomUUID()
    await db.batch([
      db.prepare('UPDATE direct_products SET name_zh=?,name_en=?,description_zh=?,description_en=?,category_id=?,listed=?,image_media_id=?,version=version+1,change_id=?,updated_at=? WHERE id=? AND version=?').bind(nameZh, nameEn, descriptionZh, descriptionEn, categoryId, listed, image, event, Date.now(), id, version),
      db.prepare("INSERT INTO admin_audit(id,action,target_id,note,created_at) SELECT ?,'direct-product-update',id,?,? FROM direct_products WHERE id=? AND change_id=?").bind(event, `admin:${env.ADMIN_USERNAME} 更新商品`, Date.now(), id, event),
    ])
    await updated(env, event, '商品已更新，请刷新后重试。')
    const row = await db.prepare('SELECT id,name_zh,name_en,description_zh,description_en,category_id,sort_order,listed,image_media_id,version FROM direct_products WHERE id=?').bind(id).first<VersionedProduct>()
    return json({ product: productView(row!) })
  }
  throw new ApiError('未找到直营设置接口。', 404)
}

export async function isDirectProductListed(env: Env, id: string) {
  const row = await env.INTEREST_DB.prepare('SELECT listed FROM direct_products WHERE id=?').bind(id).first<{ listed: number }>()
  return row?.listed === 1
}

export async function directMediaRoute(request: Request, env: Env, path: string) {
  if (request.method !== 'GET') throw new ApiError('请求方式不支持。', 405)
  const id = path.match(/^\/api\/direct-media\/([a-f0-9-]{36})$/)?.[1]
  if (!id) throw new ApiError('图片不存在。', 404)
  const row = await env.INTEREST_DB.prepare('SELECT mime,base64 FROM direct_media WHERE id=?').bind(id).first<{ mime: string; base64: string }>()
  if (!row) throw new ApiError('图片不存在。', 404)
  const bytes = Uint8Array.from(atob(row.base64), char => char.charCodeAt(0))
  return new Response(bytes, { headers: { 'Content-Type': row.mime, 'Content-Length': String(bytes.length), 'Cache-Control': 'public, max-age=31536000, immutable', 'ETag': `"${id}"`, 'X-Content-Type-Options': 'nosniff' } })
}
