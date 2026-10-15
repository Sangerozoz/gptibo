import test from 'node:test'
import assert from 'node:assert/strict'
import { customerFixture } from './customer-fixture.ts'

test('direct catalog exposes owner brand, categories and existing products without changing partner catalogs', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const direct = await (await s.request('/api/catalog')).json()
  assert.deepEqual(direct.site, { nameZh: '硅基生物', nameEn: 'MEGHAN', logoUrl: null })
  assert.deepEqual(direct.categories.map((category: { id: string }) => category.id), ['ai', 'learning', 'mail', 'tool'])
  assert.equal(direct.products.find((product: { id: string }) => product.id === 'chatgpt').listed, true)
  assert.equal(direct.products.find((product: { id: string }) => product.id === 'codex-sms').categoryId, 'tool')
  const partner = await s.agent('Partner')
  const partnerCatalog = await (await s.request('/api/catalog?partner=' + partner.id.slice(0, 6))).json()
  assert.equal(partnerCatalog.site, undefined)
  assert.equal(partnerCatalog.categories, undefined)
})

test('owner site settings require authentication, same origin and current version', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const endpoint = '/api/admin/direct-store/site'
  assert.equal((await s.request(endpoint)).status, 401)
  const original = await (await s.request(endpoint, undefined, s.admin)).json()
  assert.equal(original.version, 0)
  const changed = { nameZh: '新店名', nameEn: '', logoMediaId: null, version: original.version }
  assert.equal((await s.request(endpoint, changed, s.admin, 'https://elsewhere.test')).status, 403)
  assert.equal((await s.request(endpoint, changed, s.admin)).status, 200)
  assert.deepEqual((await (await s.request('/api/catalog')).json()).site, { nameZh: '新店名', nameEn: '', logoUrl: null })
  assert.equal((await s.request(endpoint, changed, s.admin)).status, 409)
  assert.equal(s.db.prepare("SELECT count(*) n FROM admin_audit WHERE action='direct-site-update'").get()!.n, 1)
})

test('owner can create, reorder and deactivate categories without removing their products', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const list = '/api/admin/direct-store/categories'
  const createdResponse = await s.request(list, { nameZh: '新分类', nameEn: 'New category' }, s.admin)
  assert.equal(createdResponse.status, 201)
  const created = (await createdResponse.json()).category
  assert.match(created.id, /^[a-z0-9-]+$/)
  const productEndpoint = '/api/admin/direct-store/products/chatgpt'
  const product = (await (await s.request(productEndpoint, undefined, s.admin)).json()).product
  assert.equal((await s.request(productEndpoint, { ...product, categoryId: created.id }, s.admin)).status, 200)
  assert.equal((await s.request(list + '/' + created.id, { nameZh: '改名分类', nameEn: '', active: false, version: created.version }, s.admin)).status, 200)
  const publicCatalog = await (await s.request('/api/catalog')).json()
  assert.equal(publicCatalog.categories.find((category: { id: string }) => category.id === created.id).active, false)
  assert.equal(publicCatalog.products.find((item: { id: string }) => item.id === 'chatgpt').categoryId, created.id)
  const ids = publicCatalog.categories.map((category: { id: string }) => category.id).reverse()
  assert.equal((await s.request(list + '/order', { ids, version: 0 }, s.admin)).status, 200)
  assert.deepEqual((await (await s.request('/api/catalog')).json()).categories.map((category: { id: string }) => category.id), ids)
  assert.equal((await s.request(list + '/order', { ids, version: 0 }, s.admin)).status, 409)
})

test('owner product edits and ordering reach the public catalog, and hidden products reject direct checkout', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  const buyer = (await s.request('/api/orders/client', {})).headers.get('Set-Cookie')!.split(';')[0]
  const checkout = () => s.request('/api/orders', { email: 'buyer@example.test', plan: 'plus', expectedPrice: 13900, key: crypto.randomUUID() }, buyer)
  const existing = await checkout()
  assert.equal(existing.status, 201)
  const endpoint = '/api/admin/direct-store/products/chatgpt'
  const product = (await (await s.request(endpoint, undefined, s.admin)).json()).product
  assert.equal((await s.request(endpoint, { ...product, nameZh: '我的 AI 商品', nameEn: '', descriptionZh: '新的简介', listed: false }, s.admin)).status, 200)
  const catalog = await (await s.request('/api/catalog')).json()
  assert.equal(catalog.products.find((item: { id: string }) => item.id === 'chatgpt').nameZh, '我的 AI 商品')
  assert.equal(catalog.products.find((item: { id: string }) => item.id === 'chatgpt').listed, false)
  assert.equal((await checkout()).status, 409)
  assert.equal((await (await s.request('/api/orders', undefined, buyer)).json()).orders.length, 1)
  const order = catalog.products.map((item: { id: string }) => item.id).reverse()
  assert.equal((await s.request('/api/admin/direct-store/products/order', { ids: order, version: 0 }, s.admin)).status, 200)
  assert.deepEqual((await (await s.request('/api/catalog')).json()).products.map((item: { id: string }) => item.id), order)
  assert.equal((await s.request(endpoint, { ...product, nameZh: '陈旧更新' }, s.admin)).status, 409)
})
