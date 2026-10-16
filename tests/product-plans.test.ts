import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePlanPrice, planUpdateNote, selectProductPlanDetails } from '../src/admin/product-plans.ts'

test('product detail shows only its plans and their modification history', () => {
  const plans = [
    { id: 'plus', product_id: 'chatgpt' },
    { id: 'sms', product_id: 'codex-sms' },
    { id: 'pro', product_id: 'chatgpt' },
  ]
  const audit = [
    { target_id: 'sms', note: 'SMS changed' },
    { target_id: 'pro', note: 'Pro changed' },
    { target_id: 'plus', note: 'Plus changed' },
  ]

  assert.deepEqual(selectProductPlanDetails('chatgpt', plans, audit), {
    plans: [plans[0], plans[2]],
    audit: [audit[1], audit[2]],
  })
  assert.deepEqual(selectProductPlanDetails('new-product', plans, audit), { plans: [], audit: [] })
})

test('inline price accepts only positive yuan amounts with at most two decimal places', () => {
  assert.equal(parsePlanPrice('139.50'), 13950)
  assert.equal(parsePlanPrice('0.01'), 1)
  assert.equal(parsePlanPrice('100000'), 10000000)
  for (const value of ['', '0', '0.001', '12.345', '-5', '100000.01', 'abc']) assert.equal(parsePlanPrice(value), null)
})

test('inline saves describe price and sale status changes for the audit record', () => {
  const original = { price_cents: 13900, enabled: 1, display_label: '日常之选' }
  assert.equal(planUpdateNote(original, { priceCents: 14000, enabled: false, displayLabel: '热门推荐' }), '调整售价，套餐下架，修改标签')
  assert.equal(planUpdateNote({ ...original, enabled: 0 }, { priceCents: 13900, enabled: true, displayLabel: '日常之选' }), '套餐上架')
  assert.equal(planUpdateNote(original, { priceCents: 13900, enabled: true, displayLabel: '' }), '清除标签')
})
