import test from 'node:test'
import assert from 'node:assert/strict'
import type { Env } from '../worker/platform.ts'
import { FiveSimResultUncertainError, fivesimBuyActivation, fivesimCancel, fivesimCheck, fivesimConfigured, fivesimFinish, fivesimPrices, fivesimProfile } from '../worker/fivesim/client.ts'

const env = (token?: string) => ({ FIVESIM_API_TOKEN: token } as Env)
const order = { id: 11631253, phone: '+447350690992', operator: 'vodafone', product: 'openai', price: 21, status: 'PENDING', expires: '2026-10-15T08:28:38Z', sms: null, created_at: '2026-10-15T08:13:38Z', country: 'england' }

test('profile uses a server-side Bearer token and validates balance', async t => {
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    calls.push(String(url))
    assert.equal(String(url), 'https://5sim.net/v1/user/profile')
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer test-token')
    assert.equal(new Headers(options?.headers).get('Accept'), 'application/json')
    assert.equal(options?.redirect, 'manual')
    return Response.json({ id: 7, balance: 100.25, frozen_balance: 0 })
  })
  assert.equal(fivesimConfigured(env('test-token')), true)
  assert.deepEqual(await fivesimProfile(env('test-token')), { balance: 100.25, frozenBalance: 0 })
  assert.equal(calls.length, 1)
})

test('missing token fails locally and never calls upstream', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch') })
  assert.equal(fivesimConfigured(env('  ')), false)
  await assert.rejects(fivesimProfile(env('  ')), /5SIM 密钥尚未配置/)
  assert.equal(fetch.mock.callCount(), 0)
})

test('price lookup uses the public country and product endpoint', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), 'https://5sim.net/v1/guest/prices?country=england&product=openai')
    assert.equal(new Headers(options?.headers).has('Authorization'), false)
    return Response.json({ england: { openai: { vodafone: { cost: 8.5, count: 2, rate: 99.9 } } } })
  })
  assert.deepEqual(await fivesimPrices(env(), 'england', 'openai'), { vodafone: { cost: 8.5, count: 2, rate: 99.9 } })
})

test('buy sends one activation request with a price ceiling and parses the supplier order', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), 'https://5sim.net/v1/user/buy/activation/england/any/openai?maxPrice=21')
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer test-token')
    return Response.json(order)
  })
  assert.deepEqual(await fivesimBuyActivation(env('test-token'), { country: 'england', operator: 'any', product: 'openai', maxPrice: 21 }), { id: 11631253, phone: '+447350690992', operator: 'vodafone', product: 'openai', price: 21, status: 'PENDING', expires: '2026-10-15T08:28:38Z', sms: [], country: 'england' })
  assert.equal(fetch.mock.callCount(), 1)
})

test('check, finish and cancel use the original supplier order ID', async t => {
  const paths: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    paths.push(String(url))
    return Response.json({ ...order, status: paths.length === 1 ? 'RECEIVED' : paths.length === 2 ? 'FINISHED' : 'CANCELED', sms: [{ code: '09363', text: 'Verification 09363', sender: 'OpenAI', date: '2026-10-15T08:20:38Z' }] })
  })
  assert.equal((await fivesimCheck(env('test-token'), 11631253)).sms[0]?.code, '09363')
  assert.equal((await fivesimFinish(env('test-token'), 11631253)).status, 'FINISHED')
  assert.equal((await fivesimCancel(env('test-token'), 11631253)).status, 'CANCELED')
  assert.deepEqual(paths, ['https://5sim.net/v1/user/check/11631253', 'https://5sim.net/v1/user/finish/11631253', 'https://5sim.net/v1/user/cancel/11631253'])
})

test('invalid path segments and order IDs are rejected before network access', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch') })
  await assert.rejects(fivesimPrices(env(), '../user', 'openai'), /参数无效/)
  await assert.rejects(fivesimBuyActivation(env('test-token'), { country: 'england', operator: 'any', product: 'openai/other' }), /参数无效/)
  await assert.rejects(fivesimBuyActivation(env('test-token'), { country: 'england', operator: 'any', product: 'openai', maxPrice: 0 }), /价格上限无效/)
  await assert.rejects(fivesimBuyActivation(env('test-token'), { country: 'england', operator: 'vodafone', product: 'openai', maxPrice: 21 }), /价格上限仅支持任意运营商/)
  await assert.rejects(fivesimCheck(env('test-token'), -1), /订单编号无效/)
  assert.equal(fetch.mock.callCount(), 0)
})

test('no-free-phones is a confirmed rejection; lost buy response stays uncertain and is not retried', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('no free phones', { status: 200 }))
  await assert.rejects(fivesimBuyActivation(env('test-token'), { country: 'england', operator: 'any', product: 'openai' }), /暂无可用号码/)
  fetch.mock.restore()
  const lost = t.mock.method(globalThis, 'fetch', async () => { throw new Error('upstream-private-token') })
  await assert.rejects(fivesimBuyActivation(env('test-token'), { country: 'england', operator: 'any', product: 'openai' }), error => error instanceof FiveSimResultUncertainError && !error.message.includes('upstream-private-token'))
  assert.equal(lost.mock.callCount(), 1)
})

test('upstream errors and invalid JSON are sanitized', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('private upstream error', { status: 401 }))
  await assert.rejects(fivesimProfile(env('test-token')), error => error instanceof Error && !error.message.includes('private upstream error'))
  fetch.mock.restore()
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>private</html>', { status: 200 }))
  await assert.rejects(fivesimProfile(env('test-token')), /响应格式异常/)
})

test('a successful buy response without a valid order identity is still uncertain', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ success: true }))
  await assert.rejects(fivesimBuyActivation(env('test-token'), { country: 'england', operator: 'any', product: 'openai' }), FiveSimResultUncertainError)
  assert.equal(fetch.mock.callCount(), 1)
})
