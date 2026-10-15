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
