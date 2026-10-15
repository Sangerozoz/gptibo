import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveStorefrontLocale, translateStorefront } from '../src/lib/storefront-locale.ts'

test('explicit language selection wins over browser preferences', () => {
  assert.equal(resolveStorefrontLocale('en', ['zh-CN']), 'en')
  assert.equal(resolveStorefrontLocale('zh-CN', ['en-US']), 'zh-CN')
})

test('first visit selects the first supported browser language and safely defaults to Chinese', () => {
  assert.equal(resolveStorefrontLocale(null, ['en-GB', 'zh-CN']), 'en')
  assert.equal(resolveStorefrontLocale(null, ['zh-TW', 'en-US']), 'zh-CN')
  assert.equal(resolveStorefrontLocale('invalid', ['fr-FR', 'EN-us']), 'en')
  assert.equal(resolveStorefrontLocale(null, ['fr-FR']), 'zh-CN')
  assert.equal(resolveStorefrontLocale(null, []), 'zh-CN')
})

test('translations preserve Chinese defaults, shop content and literal interpolation values', () => {
  assert.equal(translateStorefront('zh-CN', '硅基生物 · 会员订阅与工具服务'), '硅基生物 · 会员订阅与工具服务')
  assert.equal(translateStorefront('en', '硅基生物 · 会员订阅与工具服务'), 'MEGHAN · Subscriptions & tools')
  assert.equal(translateStorefront('en', '全部商品'), 'All products')
  assert.equal(translateStorefront('zh-CN', '全部商品'), '全部商品')
  assert.equal(translateStorefront('en', '商家自定义公告'), '商家自定义公告')
  assert.equal(translateStorefront('en', '{product} 上线提醒', { product: 'Claude $& {product}' }), 'Claude $& {product} launch updates')
  assert.equal(translateStorefront('zh-CN', '{product} 上线提醒', { product: 'Claude' }), 'Claude 上线提醒')
  assert.equal(translateStorefront('en', 'toString'), 'toString')
  assert.equal(translateStorefront('en', '{product} 上线提醒'), '{product} launch updates')
})
