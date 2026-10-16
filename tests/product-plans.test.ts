import test from 'node:test'
import assert from 'node:assert/strict'
import { selectProductPlanDetails } from '../src/admin/product-plans.ts'

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
