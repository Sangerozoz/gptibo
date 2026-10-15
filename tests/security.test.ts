import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import worker from '../worker/index.ts'
import type { Env } from '../worker/platform.ts'
import { boundedResponseText } from '../worker/bounded-response.ts'
import { call as delivery_supplier } from '../worker/delivery_supplier/client.ts'
import { call as account_supplier } from '../worker/account_supplier/client.ts'
import { sendVerificationEmail } from '../worker/email.ts'

const safeEnv = () => ({
  API_LIMITER: { limit: async () => ({ success: true }) },
  EXPENSIVE_LIMITER: { limit: async () => ({ success: true }) },
  ASSETS: { fetch: async () => new Response('asset') },
} as unknown as Env)

test('plaintext API writes cannot reach login, callbacks, D1 or suppliers; reads redirect with the path and query intact', async () => {
  const blocked = new Proxy({}, { get() { throw new Error('No binding may run for plaintext traffic') } }) as Env
  for (const path of ['/api/admin/login', '/api/orders', '/api/recharge/webhook', '/api/payments/notify/alipay']) {
    const response = await worker.fetch(new Request('http://shop.example.invalid' + path, { method: 'POST', body: '{}' }), blocked)
    assert.equal(response.status, 403)
    assert.equal(response.headers.get('Location'), null)
    assert.equal(response.headers.get('Set-Cookie'), null)
  }
  const response = await worker.fetch(new Request('http://shop.example.invalid/api/catalog?partner=ABCD1234'), blocked)
  assert.equal(response.status, 308)
  assert.equal(response.headers.get('Location'), 'https://shop.example.invalid/api/catalog?partner=ABCD1234')
  for (const host of ['localhost', '127.0.0.1']) {
    assert.equal((await worker.fetch(new Request(`http://${host}:8787/api/unknown`), safeEnv())).status, 404)
  }
})

test('API security headers protect success, denial, malformed callbacks and errors without caching or leaking cookies', async () => {
  const env = safeEnv()
  const requests = [
    new Request('https://shop.example.invalid/api/admin/session'),
    new Request('https://shop.example.invalid/api/admin/orders'),
    new Request('https://shop.example.invalid/api/recharge/webhook', { method: 'POST', body: '{}' }),
    new Request('https://shop.example.invalid/api/payments/notify/alipay', { method: 'POST', body: '{}' }),
    new Request('https://shop.example.invalid/api/unknown'),
  ]
  for (const request of requests) {
    const response = await worker.fetch(request, env)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
    assert.equal(response.headers.get('X-Frame-Options'), 'DENY')
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer')
    assert.equal(response.headers.get('Strict-Transport-Security'), 'max-age=15552000')
    assert.match(response.headers.get('Content-Security-Policy')!, /default-src 'none'/)
    assert.equal(response.headers.get('Set-Cookie'), null)
  }
  env.API_LIMITER.limit = async () => ({ success: false })
  const limited = await worker.fetch(requests[0], env)
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('Retry-After'), '60')
  env.API_LIMITER.limit = async () => { throw new Error('private limiter data') }
  assert.equal((await worker.fetch(requests[0], env)).status, 503)
})

test('central response wrapper preserves buyer cookie flags and never discloses unexpected visitor database errors', async () => {
  const env = safeEnv()
  const headers = { Origin: 'https://shop.example.invalid', 'Content-Type': 'application/json' }
  const response = await worker.fetch(new Request('https://shop.example.invalid/api/orders/client', { method: 'POST', headers, body: '{}' }), env)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('Set-Cookie')!, /^__Host-ymx_buyer=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/)
  env.INTEREST_DB = { prepare() { throw new Error('D1_ERROR secret-column database-id') } } as Env['INTEREST_DB']
  const failed = await worker.fetch(new Request('https://shop.example.invalid/api/visitors', { method: 'POST', headers, body: JSON.stringify({ visitorId: crypto.randomUUID(), path: '/' }) }), env)
  assert.equal(failed.status, 503)
  assert.deepEqual(await failed.json(), { error: '统计暂不可用。' })
  const rejected = await worker.fetch(new Request('https://shop.example.invalid/api/visitors', { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: '{}' }), env)
  assert.equal(rejected.status, 403)
})

test('stream limits count bytes without trusting Content-Length, cancel excess streams, and decode split UTF-8', async () => {
  const encoded = new TextEncoder().encode('安全')
  const split = new ReadableStream({ start(c) { c.enqueue(encoded.slice(0, 2)); c.enqueue(encoded.slice(2)); c.close() } })
  assert.equal(await boundedResponseText(new Response(split), 6), '安全')
  let cancelled = false
  const oversized = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(9)) }, cancel() { cancelled = true } })
  await assert.rejects(boundedResponseText(new Response(oversized, { headers: { 'Content-Length': '1' } }), 8), /too large/)
  assert.equal(cancelled, true)
  await assert.rejects(boundedResponseText(new Response(new Uint8Array([255]))), /encoded data/)
})

test('automatic suppliers reject oversized and malformed responses with fixed safe errors', async t => {
  const env = { DELIVERY_SUPPLIER_API_KEY: 'mock-key', ACCOUNT_SUPPLIER_API_BASE: 'https://supplier.example.test', ACCOUNT_SUPPLIER_APP_ID: '123', ACCOUNT_SUPPLIER_APP_SECRET: 'mock-secret' } as Env
  for (const content of ['{"private":"' + 'x'.repeat(256000) + '"}', 'not-json PRIVATE', 'null']) {
    t.mock.method(globalThis, 'fetch', async () => new Response(content))
    for (const invoke of [() => delivery_supplier(env, '/products'), () => account_supplier(env, '/goods/getDetail', { goodsId: 1 })]) {
      await assert.rejects(invoke(), e => e instanceof Error && !e.message.includes('PRIVATE') && !e.message.includes('private'))
    }
    t.mock.restoreAll()
  }
})

test('deploy config keeps alternate Worker entrypoints closed and static responses carry HSTS', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'))
  assert.equal(config.workers_dev, false)
  assert.equal(config.preview_urls, false)
  assert.match(readFileSync(new URL('../public/_headers', import.meta.url), 'utf8'), /Strict-Transport-Security: max-age=15552000/)
})

test('verification email redirects cannot forward a login code or request body to another service', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    calls++
    assert.equal(options.redirect, 'manual')
    return new Response(null, { status: 307, headers: { Location: 'https://evil.test/steal' } })
  })
  await assert.rejects(sendVerificationEmail({ RESEND_API_KEY: 'mock-key', RESEND_FROM: '硅基生物 <login@example.test>', PUBLIC_SITE_ORIGIN: 'https://shop.example.invalid' } as Env, 'order-recovery', 'buyer@example.test', '123456', crypto.randomUUID()), /delivery failed/)
  assert.equal(calls, 1)
})
