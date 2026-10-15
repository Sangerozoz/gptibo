import test from 'node:test'
import assert from 'node:assert/strict'
import { categoryLabel, localized, orderedListedProducts, productCopy } from '../src/lib/direct-store-display.ts'

test('owner brand and product copy use the active language and fall back to Chinese', () => {
  assert.equal(localized('硅基生物', 'MEGHAN', 'en'), 'MEGHAN')
  assert.equal(localized('硅基生物', '', 'en'), '硅基生物')
  assert.equal(productCopy({ nameZh: '中文商品', nameEn: '', descriptionZh: '中文简介', descriptionEn: '' }, 'en').name, '中文商品')
  assert.equal(productCopy({ nameZh: '中文商品', nameEn: 'English item', descriptionZh: '中文简介', descriptionEn: 'English copy' }, 'en').description, 'English copy')
})

test('disabled category is absent from filters while its listed products remain in All Products', () => {
  const categories = [
    { id: 'a', nameZh: '可见', nameEn: 'Visible', active: true, sortOrder: 1 },
    { id: 'b', nameZh: '停用', nameEn: 'Disabled', active: false, sortOrder: 0 },
  ]
  assert.deepEqual(categoryLabel(categories, 'en').map(category => category.id), ['a'])
  const products = [
    { id: 'one', nameZh: '一', nameEn: '', descriptionZh: '', descriptionEn: '', categoryId: 'b', listed: true, sortOrder: 2, imageUrl: null },
    { id: 'two', nameZh: '二', nameEn: '', descriptionZh: '', descriptionEn: '', categoryId: 'a', listed: false, sortOrder: 0, imageUrl: null },
    { id: 'three', nameZh: '三', nameEn: '', descriptionZh: '', descriptionEn: '', categoryId: 'a', listed: true, sortOrder: 1, imageUrl: null },
  ]
  assert.deepEqual(orderedListedProducts(products).map(product => product.id), ['three', 'one'])
})
