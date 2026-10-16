import test from 'node:test'
import assert from 'node:assert/strict'
import { getAdminNavigation } from '../src/admin/navigation.ts'

test('admin menu follows business tasks and keeps the overview first', () => {
  const groups = getAdminNavigation(true)
  assert.deepEqual(groups.map(group => group.label), ['概览', '店铺与商品', '订单与客户', '数据与财务', '代理业务', '系统设置'])
  assert.deepEqual(groups.map(group => group.items.map(item => item.id)), [
    ['overview'],
    ['store-settings', 'contacts', 'categories', 'products'],
    ['orders', 'refunds', 'customers'],
    ['visitors', 'accounting'],
    ['partners', 'tickets', 'invoices'],
    ['integrations', 'security'],
  ])
  assert.equal(groups.find(group => group.id === 'store')?.items.find(item => item.id === 'products')?.label, '商品管理')
  const ids = groups.flatMap(group => group.items.map(item => item.id))
  assert.equal(ids.length, 15)
  assert.equal(new Set(ids).size, ids.length)
})

test('closed partner mode removes the whole agent group and keeps everyday pages', () => {
  const groups = getAdminNavigation(false)
  assert.equal(groups.some(group => group.id === 'partners'), false)
  assert.equal(groups.flatMap(group => group.items).length, 12)
  assert.equal(groups[0].items[0].id, 'overview')
  assert.equal(groups.at(-1)?.items.at(-1)?.id, 'security')
})
