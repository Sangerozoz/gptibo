import { seedAdminEmailCode } from './admin-email-fixture.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import worker from '../worker/index.ts'
import { alipay, canonical, gateway, responseObjectText, type AlipayConfig } from '../worker/payments/alipay.ts'
import { amountCents, amountText } from '../worker/payments/types.ts'
import { applyPaymentResult, findPayment, reconcilePayments } from '../worker/payments/service.ts'
import { totpCode } from '../worker/totp.ts'
import type { Env, Statement, Value } from '../worker/platform.ts'

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const config: AlipayConfig = { ALIPAY_APP_ID: '2026000000000000', ALIPAY_SELLER_ID: '2088000000000000', ALIPAY_APP_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), ALIPAY_PUBLIC_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
const signText = (text: string) => sign('RSA-SHA256', Buffer.from(text), keys.privateKey).toString('base64')
const reply = (method: string, data: Record<string, unknown>) => { const raw = JSON.stringify(data); return new Response(`{"${method.replaceAll('.', '_')}_response":${raw},"sign":"${signText(raw)}"}`) }
const order = { id: 'YMX-EXAMPLE', amountCents: 13900, subject: '硅基生物 · Plus', expiresAt: Date.now() + 900000 }
const trade = (id = order.id, amount = '139.00') => ({ code: '10000', out_trade_no: id, total_amount: amount, seller_id: config.ALIPAY_SELLER_ID, trade_status: 'TRADE_SUCCESS', trade_no: '202609270000000001' })
type TestContext = Parameters<Parameters<typeof test>[1]>[0]
function mockGateway(t: TestContext, handler: (method: string, biz: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>) {
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://openapi.alipay.com/gateway.do')
    assert.equal(options.redirect, 'manual') // Cloudflare rejects redirect:error.
    const params = Object.fromEntries(new URLSearchParams(String(options.body)))
    assert.equal(params.sign_type, 'RSA2')
    assert.ok(verify('RSA-SHA256', Buffer.from(canonical(params)), keys.publicKey, Buffer.from(params.sign, 'base64')))
    return reply(params.method, await handler(params.method, JSON.parse(params.biz_content)))
  })
}
test('integer amounts have no float rounding, exponent or overprecision acceptance', () => {
  assert.equal(amountText(13901), '139.01'); assert.equal(amountCents('139.1'), 13910); assert.equal(amountCents(139), 13900)
  for (const value of ['1e2', '-1', '1.001', 'NaN', '00.01']) assert.throws(() => amountCents(value))
  for (const value of [0, 0.1, NaN, -1, 10000001]) assert.throws(() => amountText(value))
})
test('precreate is signed, uses server amount and refuses non-Alipay QR URLs', async t => {
  let qr = 'https://qr.alipay.com/example'
  mockGateway(t, (method, biz) => { assert.equal(method, 'alipay.trade.precreate'); assert.equal(biz.total_amount, '139.00'); return { code: '10000', out_trade_no: order.id, qr_code: qr } })
  assert.equal((await alipay(config).create(order, 'https://shop.example.invalid/api/payments/notify/alipay')).qr, qr)
  qr = 'https://qr.alipay.com.evil.test/example'
  await assert.rejects(alipay(config).create(order, 'https://shop.example.invalid/notify'))
})
test('gateway rejects redirects without forwarding the signed request', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    assert.equal(options.redirect, 'manual')
    return new Response(null, { status: 302, headers: { Location: 'https://other.example.test/' } })
  })
  await assert.rejects(gateway(config, 'alipay.trade.query', {}), /gateway unavailable/)
})

test('raw response parsing preserves escapes and rejects forged or duplicate response objects', async t => {
  const raw = '{"code":"10000","nested":{"quote":"\\\"}"},"qr_code":"https:\\/\\/qr.alipay.com\\/abc"}'
  assert.equal(responseObjectText(`{"alipay_trade_query_response":${raw}}`, 'alipay_trade_query_response'), raw)
  let body = `{"alipay_trade_query_response":${raw},"sign":"${signText(raw)}"}`
  t.mock.method(globalThis, 'fetch', async () => new Response(body))
  await gateway(config, 'alipay.trade.query', {})
  body = `{"alipay_trade_query_response":${raw},"alipay_trade_query_response":{"code":"10000","trade_status":"TRADE_SUCCESS"},"sign":"${signText(raw)}"}`
  await assert.rejects(gateway(config, 'alipay.trade.query', {}), /object mismatch/)
  body = '{"alipay_trade_query_response":{"code":"10000"},"sign":"ZmFrZQ=="}'
  await assert.rejects(gateway(config, 'alipay.trade.query', {}), /signature invalid/)
})
test('signed query still checks seller, order, amount, trade number and status', async t => {
  let response: Record<string, unknown> = trade()
  mockGateway(t, () => response)
  assert.equal((await alipay(config).query(order)).status, 'paid')
  delete response.seller_id // The official standard query schema omits seller_id.
  assert.equal((await alipay(config).query(order)).status, 'paid')
  for (const patch of [{ seller_id: 'other' }, { total_amount: '139.01' }, { out_trade_no: 'other' }, { trade_no: '' }, { trade_status: 'unknown' }]) {
    response = { ...trade(), ...patch }; await assert.rejects(alipay(config).query(order))
  }
  response = { code: '40004', sub_code: 'ACQ.TRADE_NOT_EXIST' }
  assert.equal((await alipay(config).query(order)).status, 'not_found')
})
test('partial refunds use approved amount and stable request ID; query matches original and refund amounts', async t => {
  let amount = '20.01'; const refund = { id: 'refund-case', amountCents: 2001 }
  mockGateway(t, (method, biz) => {
    assert.equal(biz.out_request_no, refund.id)
    if (method === 'alipay.trade.refund') { assert.equal(biz.refund_amount, '20.01'); return { ...trade(), refund_fee: amount, fund_change: 'Y' } }
    return { ...trade(), out_request_no: refund.id, refund_amount: amount, refund_status: 'REFUND_SUCCESS' }
  })
  assert.equal((await alipay(config).refund(order, refund)).refunded, true)
  assert.equal((await alipay(config).queryRefund(order, refund)).refunded, true)
  amount = '20.00'
  await assert.rejects(alipay(config).refund(order, refund)); await assert.rejects(alipay(config).queryRefund(order, refund))
  await assert.rejects(alipay(config).refund(order, { ...refund, amountCents: 14000 }))
})
test('successful refund-query response without refund_status means no confirmed refund yet', async t => {
  mockGateway(t, () => ({ code: '10000' }))
  assert.equal((await alipay(config).queryRefund(order, { id: 'refund-case', amountCents: 2001 })).refunded, false)
})
function notice(values: Record<string, string> = {}) {
  const data = { app_id: config.ALIPAY_APP_ID, seller_id: config.ALIPAY_SELLER_ID, sign_type: 'RSA2', out_trade_no: order.id, total_amount: '139.00', trade_status: 'TRADE_SUCCESS', trade_no: '202609270000000001', ...values }
  return new URLSearchParams({ ...data, sign: signText(canonical(data, ['sign', 'sign_type'])) })
}
const noticeRequest = (form: URLSearchParams) => new Request('https://shop.example.invalid/api/payments/notify/alipay', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form })
test('notifications reject duplicate fields, modified payloads, wrong app/seller and oversized bodies', async () => {
  assert.equal((await alipay(config).notification(noticeRequest(notice()))).status, 'paid')
  const tampered = notice(); tampered.set('total_amount', '1400')
  const duplicate = notice(); duplicate.append('total_amount', '139.00')
  for (const form of [tampered, duplicate, notice({ app_id: 'other' }), notice({ seller_id: 'other' }), notice({ oversized: 'a'.repeat(17000) })]) await assert.rejects(alipay(config).notification(noticeRequest(form)))
})
async function setup(t: TestContext) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  const dir = new URL('../migrations/', import.meta.url)
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, dir), 'utf8'))
  const bound = new WeakMap<Statement, { sql: string; values: Value[] }>()
  const env: Env = { ...config, ORDER_TESTING_ENABLED: 'true', PAYMENT_PROVIDER: 'alipay', PAYMENT_CHECKOUT_ENABLED: 'true', PAYMENT_NOTIFY_ORIGIN: 'https://shop.example.invalid', ADMIN_EMAIL: 'admin@example.invalid', ADMIN_USERNAME: 'tester', ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', ASSETS: { fetch: async () => new Response('asset') }, INTEREST_LIMITER: { limit: async () => ({ success: true }) }, API_LIMITER: { limit: async () => ({ success: true }) }, EXPENSIVE_LIMITER: { limit: async () => ({ success: true }) }, INTEREST_DB: {
    prepare(sql) {
      const state = { sql, values: [] as Value[] }; const statement: Statement = { bind(...values) { state.values = values; return this }, async first<T>() { return (db.prepare(sql).get(...state.values) ?? null) as T | null }, async all<T>() { return { results: db.prepare(sql).all(...state.values) as T[] } }, async run() { return db.prepare(sql).run(...state.values) } }; bound.set(statement, state); return statement
    },
    async batch(statements) { db.exec('BEGIN'); try { const result = statements.map(s => { const state = bound.get(s)!; return db.prepare(state.sql).run(...state.values) }); db.exec('COMMIT'); return result } catch (e) { db.exec('ROLLBACK'); throw e } },
  } }
  const request = (path: string, data?: unknown, cookie = '') => worker.fetch(new Request('https://shop.example.invalid' + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: 'https://shop.example.invalid', 'Content-Type': 'application/json', Cookie: cookie }, body: data === undefined ? undefined : JSON.stringify(data) }), env)
  const cookie = (await request('/api/orders/client', {})).headers.get('Set-Cookie')!.split(';')[0]
  const created = await (await request('/api/orders', { plan: 'plus', expectedPrice: 13900, key: crypto.randomUUID(), email: 'test@example.test' }, cookie)).json()
  const id = created.order.id as string
  const pay = (action: string, owner = cookie) => request(`/api/orders/${id}/payment`, { action }, owner)
  const live = () => db.prepare("UPDATE orders SET mode='live' WHERE id=?").run(id)
  const notify = (values: Record<string, string> = {}) => worker.fetch(noticeRequest(notice({ out_trade_no: id, ...values })), env)
  const admin = async () => (await request('/api/admin/login', { username: 'tester', code: await totpCode(env.ADMIN_TOTP_SECRET!), ...await seedAdminEmailCode(db, env) })).headers.get('Set-Cookie')!.split(';')[0]
  return { db, env, request, cookie, id, pay, live, notify, admin }
}
test('historical manual 25x orders retain their original Alipay route and paid admin completion', async t => {
  const s = await setup(t); s.env.ORDER_TESTING_ENABLED = 'false'
  const catalog = await (await s.request('/api/catalog')).json()
  assert.equal(catalog.checkoutEnabled, false)
  assert.equal(catalog.plans.find((p: { id: string }) => p.id === 'pro-25x').enabled, 0)
  assert.equal(catalog.plans.find((p: { id: string }) => p.id === 'plus').enabled, 0)
  const admin = await s.admin()
  assert.equal((await s.request('/api/orders', { plan: 'pro-25x', expectedPrice: 450000, key: crypto.randomUUID(), email: 'manual@example.test' }, s.cookie)).status, 409)
  // An order created before the automatic integration has no supplier snapshot.
  s.db.prepare("INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,status,created_at,updated_at,customer_email,mode,payment_status,last_event_id) SELECT ?,owner_hash,?,'pro-25x','Pro 25×',450000,'pending',created_at,updated_at,'manual@example.test','live','unpaid',last_event_id FROM orders WHERE id=?").run('YMX-LEGACY25', crypto.randomUUID(), s.id)
  const order = (await (await s.request('/api/orders/YMX-LEGACY25', undefined, s.cookie)).json()).order
  assert.equal(order.mode, 'live'); assert.equal(order.planName, 'Pro 25×'); assert.equal(order.manualFulfillment, true)
  assert.equal(order.fulfillment, undefined)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM recharge_orders WHERE order_id=?').get(order.id)!.n, 0)
  const actions = `/api/admin/orders/${order.id}/actions`
  const complete = { action: 'manual-complete', version: 0, note: '人工开通完成' }
  assert.equal((await s.request(actions, complete, s.cookie)).status, 401)
  assert.equal((await s.request(actions, complete, admin)).status, 409)
  mockGateway(t, (method, biz) => {
    assert.equal(biz.out_trade_no, order.id)
    if (method === 'alipay.trade.precreate') {
      assert.equal(biz.total_amount, '4500.00'); assert.match(String(biz.subject), /Pro 25×/)
      return { code: '10000', out_trade_no: order.id, qr_code: 'https://qr.alipay.com/manual25x' }
    }
    assert.equal(method, 'alipay.trade.query')
    return trade(order.id, '4500.00')
  })
  assert.equal((await s.request(`/api/orders/${order.id}/payment`, { action: 'create' }, s.cookie)).status, 200)
  assert.equal((await s.request(`/api/orders/${order.id}/payment`, { action: 'query' }, s.cookie)).status, 200)
  assert.equal((await s.request(`/api/orders/${order.id}/fulfillment`, { action: 'query' }, s.cookie)).status, 409)
  const current = (await (await s.request(`/api/orders/${order.id}`, undefined, s.cookie)).json()).order
  assert.equal(current.paymentStatus, 'paid'); assert.equal(current.status, 'session')
  const started = await s.request(actions, { action: 'manual-start', version: current.version, note: '开始人工开通' }, admin)
  assert.equal(started.status, 200)
  const processing = (await started.json()).order
  assert.equal(processing.status, 'processing')
  s.db.prepare('UPDATE orders SET refund_hold=1 WHERE id=?').run(order.id)
  assert.equal((await s.request(actions, { ...complete, version: processing.version }, admin)).status, 409)
  s.db.prepare('UPDATE orders SET refund_hold=0,redemption_blocked=1 WHERE id=?').run(order.id)
  assert.equal((await s.request(actions, { ...complete, version: processing.version }, admin)).status, 409)
  s.db.prepare('UPDATE orders SET redemption_blocked=0 WHERE id=?').run(order.id)
  assert.equal((await s.request(actions, complete, admin)).status, 409)
  const done = await s.request(actions, { ...complete, version: processing.version }, admin)
  assert.equal(done.status, 200); assert.equal((await done.json()).order.status, 'success')
  assert.equal((await s.request(actions, { ...complete, version: processing.version + 1 }, admin)).status, 409)
})

test('25x cannot fall back to independent payment when automatic checkout is unavailable', async t => {
  const s = await setup(t); s.env.ORDER_TESTING_ENABLED = 'false'; s.env.PAYMENT_CHECKOUT_ENABLED = 'false'
  const catalog = await (await s.request('/api/catalog')).json()
  assert.equal(catalog.plans.find((p: { id: string }) => p.id === 'pro-25x').enabled, 0)
  assert.equal((await s.request('/api/orders', { plan: 'pro-25x', expectedPrice: 450000, key: crypto.randomUUID(), email: 'manual@example.test' }, s.cookie)).status, 409)
})

test('checkout cannot charge a demo order; real payment creation is gated and owner isolated', async t => {
  const s = await setup(t); let creates = 0
  mockGateway(t, (_method, biz) => { creates++; return { code: '10000', out_trade_no: biz.out_trade_no, qr_code: 'https://qr.alipay.com/example' } })
  assert.equal((await s.pay('create')).status, 409); assert.equal(creates, 0)
  s.live(); s.env.PAYMENT_CHECKOUT_ENABLED = 'false'
  assert.equal((await s.pay('create')).status, 503)
  s.env.PAYMENT_CHECKOUT_ENABLED = 'true'
  const other = (await s.request('/api/orders/client', {})).headers.get('Set-Cookie')!.split(';')[0]
  assert.equal((await s.pay('create', other)).status, 404)
  assert.equal((await s.pay('create')).status, 200); assert.equal((await s.pay('create')).status, 200); assert.equal(creates, 1)
  assert.equal((await findPayment(s.env, s.id))!.amount_cents, 13900)
})
test('concurrent create makes one gateway call, and a crash lease can expire safely', async t => {
  const s = await setup(t); s.live(); let creates = 0
  mockGateway(t, async (_m, biz) => { creates++; await new Promise(r => setTimeout(r, 20)); return { code: '10000', out_trade_no: biz.out_trade_no, qr_code: 'https://qr.alipay.com/example' } })
  const result = await Promise.all([s.pay('create'), s.pay('create')])
  assert.deepEqual(result.map(r => r.status).sort(), [200, 409]); assert.equal(creates, 1)
  s.db.exec("UPDATE payments SET lease_token='crashed',lease_until=1")
  assert.equal((await s.pay('create')).status, 200)
})
test('callbacks atomically update order once; wrong amount/app, unknown order and stale close cannot corrupt paid state', async t => {
  const s = await setup(t); s.live()
  mockGateway(t, (_m, biz) => ({ code: '10000', out_trade_no: biz.out_trade_no, qr_code: 'https://qr.alipay.com/example' }))
  await s.pay('create')
  for (const values of [{ total_amount: '1.00' }, { app_id: 'other' }, { out_trade_no: 'YMX-UNKNOWN' }]) assert.equal((await s.notify(values)).status, 400)
  assert.equal(s.db.prepare('SELECT payment_status FROM orders').get()!.payment_status, 'unpaid')
  const result = await Promise.all([s.notify(), s.notify()]); assert.deepEqual(result.map(r => r.status), [200, 200])
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM order_events WHERE action='payment-confirmed'").get()!.n, 1)
  assert.equal(s.db.prepare('SELECT status FROM orders').get()!.status, 'session')
  assert.equal((await s.notify({ trade_status: 'TRADE_CLOSED' })).status, 200)
  assert.equal((await findPayment(s.env, s.id))!.state, 'paid')
  assert.equal((await s.notify({ trade_no: 'different-trade' })).status, 400)
  assert.equal((await s.request(`/api/orders/${s.id}/demo-actions`, { action: 'submit-success', version: 1 }, s.cookie)).status, 403)
})
test('an audit failure rolls back the payment receipt and a repeated notification recovers', async t => {
  const s = await setup(t); s.live()
  mockGateway(t, (_m, biz) => ({ code: '10000', out_trade_no: biz.out_trade_no, qr_code: 'https://qr.alipay.com/example' }))
  await s.pay('create')
  s.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON order_events WHEN NEW.action='payment-confirmed' BEGIN SELECT RAISE(ABORT, 'fail'); END")
  assert.equal((await s.notify()).status, 400); assert.equal((await findPayment(s.env, s.id))!.state, 'pending')
  s.db.exec('DROP TRIGGER fail_receipt')
  assert.equal((await s.notify()).status, 200)
})
test('channel selection is pinned and turning checkout off does not stop old order queries or notifications', async t => {
  const s = await setup(t); s.live()
  mockGateway(t, (m, biz) => m === 'alipay.trade.precreate' ? { code: '10000', out_trade_no: biz.out_trade_no, qr_code: 'https://qr.alipay.com/example' } : trade(s.id))
  await s.pay('create'); s.env.PAYMENT_PROVIDER = 'future-platform'; s.env.PAYMENT_CHECKOUT_ENABLED = 'false'
  assert.equal((await s.pay('query')).status, 200)
  assert.equal((await findPayment(s.env, s.id))!.state, 'paid')
  assert.equal((await s.notify()).status, 200)
})
test('close uncertainty does not cancel an order; late payment and reconciliation recover without a browser', async t => {
  const s = await setup(t); s.live(); let paid = false
  mockGateway(t, (m, biz) => m === 'alipay.trade.precreate' ? { code: '10000', out_trade_no: biz.out_trade_no, qr_code: 'https://qr.alipay.com/example' } : paid && m === 'alipay.trade.query' ? trade(s.id) : { code: '40004', sub_code: 'ACQ.TRADE_NOT_EXIST' })
  await s.pay('create'); assert.equal((await s.pay('close')).status, 200)
  assert.equal(s.db.prepare('SELECT status FROM orders').get()!.status, 'pending')
  paid = true; await reconcilePayments(s.env)
  assert.equal(s.db.prepare('SELECT payment_status FROM orders').get()!.payment_status, 'paid')
})
test('verified close preserves terminal paid state even when a payment notification arrives concurrently', async t => {
  const s = await setup(t); s.live()
  mockGateway(t, (_m, biz) => ({ code: '10000', out_trade_no: biz.out_trade_no, qr_code: 'https://qr.alipay.com/example' }))
  await s.pay('create'); const p = (await findPayment(s.env, s.id))!
  await Promise.all([applyPaymentResult(s.env, p, { orderId: s.id, amountCents: 13900, status: 'closed' }), s.notify()])
  assert.equal(s.db.prepare('SELECT payment_status,status FROM orders').get()!.payment_status, 'paid')
  assert.equal((await findPayment(s.env, s.id))!.state, 'paid')
})
test('reviewed refund uses original gateway, and retry after local bookkeeping failure never sends a second refund', async t => {
  const s = await setup(t); s.live(); let refunds = 0; let refunded = false
  mockGateway(t, (m, biz) => {
    if (m === 'alipay.trade.precreate') return { code: '10000', out_trade_no: biz.out_trade_no, qr_code: 'https://qr.alipay.com/example' }
    if (m === 'alipay.trade.fastpay.refund.query') return refunded ? { ...trade(s.id), out_request_no: biz.out_request_no, refund_status: 'REFUND_SUCCESS', refund_amount: '139.00' } : { code: '40004', sub_code: 'ACQ.TRADE_NOT_EXIST' }
    if (m === 'alipay.trade.refund') { refunds++; refunded = true; return { ...trade(s.id), fund_change: 'Y', refund_fee: '139.00' } }
    throw new Error('Unexpected method')
  })
  await s.pay('create'); await s.notify()
  const admin = await s.admin()
  assert.equal((await s.request(`/api/orders/${s.id}/refunds`, { key: crypto.randomUUID(), reason: '取消服务', version: 1 }, s.cookie)).status, 201)
  const row = s.db.prepare('SELECT * FROM refund_cases').get()!
  assert.equal((await s.request('/api/admin/refunds/' + row.id, { action: 'approve', version: 0, amountCents: 13900, note: '同意' }, admin)).status, 200)
  assert.equal((await (await s.request('/api/admin/refunds/' + row.id, undefined, admin)).json()).paymentProvider, 'alipay')
  assert.equal((await s.request('/api/admin/refunds/' + row.id, { action: 'complete', version: 1, reference: 'manual-bypass', note: 'test' }, admin)).status, 409)
  s.db.exec("CREATE TRIGGER fail_refund BEFORE UPDATE ON refund_cases WHEN NEW.status='refunded' BEGIN SELECT RAISE(ABORT, 'fail'); END")
  const complete = () => s.request('/api/admin/refunds/' + row.id, { action: 'execute-refund', version: 1, note: '执行原路退款' }, admin)
  assert.equal((await complete()).status, 503); assert.equal(refunds, 1)
  assert.equal(s.db.prepare('SELECT refund_hold FROM orders').get()!.refund_hold, 1)
  s.db.exec('DROP TRIGGER fail_refund'); s.env.PAYMENT_PROVIDER = 'future-platform'
  assert.equal((await complete()).status, 200); assert.equal(refunds, 1)
  assert.equal(s.db.prepare('SELECT refunded_cents FROM orders').get()!.refunded_cents, 13900)
})

test('admin one-cent tests cannot be created publicly, leak to recovered buyers or enter business revenue', async t => {
  const s = await setup(t); s.env.PAYMENT_CHECKOUT_ENABLED = 'false'; s.env.PAYMENT_TEST_ENABLED = 'true'
  const path = '/api/admin/payments/test'; const data = { email: 'test@example.test', key: crypto.randomUUID(), amountCents: 99999, partner: 'forged' }
  assert.equal((await s.request(path, data, s.cookie)).status, 401)
  const admin = await s.admin()
  const response = await s.request(path, data, admin); assert.equal(response.status, 201)
  const o = (await response.json()).order
  assert.equal(o.amountCents, 1); assert.equal((await (await s.request(path, data, admin)).json()).order.id, o.id)
  assert.equal((await s.request(path, { ...data, key: crypto.randomUUID() }, admin)).status, 409)
  assert.equal((await s.request('/api/orders/' + o.id, undefined, s.cookie)).status, 404)
  assert.equal((await s.request('/api/orders/' + o.id + '/payment', { action: 'create' }, s.cookie)).status, 404)
  assert.equal(s.db.prepare('SELECT partner_id FROM orders WHERE id=?').get(o.id)!.partner_id, null)
  const overview = (await (await s.request('/api/admin/overview', undefined, admin)).json()).stats
  assert.equal(overview.total, 1); assert.equal(overview.paid_amount, 0)
  const orders = (await (await s.request('/api/orders', undefined, s.cookie)).json()).orders
  assert.ok(orders.every((item: { id: string }) => item.id !== o.id))
  s.env.PAYMENT_TEST_ENABLED = 'false'
  assert.equal((await s.request(path + '/' + o.id, { action: 'create' }, admin)).status, 503)
  assert.equal((await s.request(path + '/' + o.id, { action: 'close' }, admin)).status, 200)
  assert.equal(s.db.prepare('SELECT status FROM orders WHERE id=?').get(o.id)!.status, 'cancelled')
})

test('real admin test uses shared payment callback and refund workflow, with duplicate refund protection', async t => {
  const s = await setup(t); s.env.PAYMENT_CHECKOUT_ENABLED = 'false'; s.env.PAYMENT_TEST_ENABLED = 'true'
  const admin = await s.admin(); const path = '/api/admin/payments/test'
  const o = (await (await s.request(path, { key: crypto.randomUUID(), email: 'test@example.test' }, admin)).json()).order
  let refunded = false; let refunds = 0
  mockGateway(t, (method, biz) => {
    if (method === 'alipay.trade.precreate') { assert.equal(biz.total_amount, '0.01'); assert.match(String(biz.subject), /支付联调测试/); return { code: '10000', out_trade_no: o.id, qr_code: 'https://qr.alipay.com/real-test' } }
    if (method === 'alipay.trade.fastpay.refund.query') return refunded ? { ...trade(o.id, '0.01'), out_request_no: biz.out_request_no, refund_status: 'REFUND_SUCCESS', refund_amount: '0.01' } : { code: '40004', sub_code: 'ACQ.TRADE_NOT_EXIST' }
    if (method === 'alipay.trade.refund') { assert.equal(biz.refund_amount, '0.01'); refunded = true; refunds++; return { ...trade(o.id, '0.01'), refund_fee: '0.01', fund_change: 'Y' } }
    throw new Error('Unexpected gateway method')
  })
  assert.equal((await s.request(path + '/' + o.id, { action: 'create' }, admin)).status, 200)
  assert.equal((await s.request(path + '/' + o.id, { action: 'refund' }, admin)).status, 409)
  const callback = () => worker.fetch(noticeRequest(notice({ out_trade_no: o.id, total_amount: '0.01' })), s.env)
  assert.equal((await callback()).status, 200)
  let current = (await (await s.request(path + '/' + o.id, undefined, admin)).json()).order
  assert.equal(current.paymentStatus, 'paid'); assert.ok(current.payment.notifiedAt); assert.equal(current.status, 'session')
  assert.equal((await s.request(path + '/' + o.id, { action: 'refund' }, admin)).status, 200)
  assert.equal((await s.request(path + '/' + o.id, { action: 'refund' }, admin)).status, 200)
  assert.equal(refunds, 1); assert.equal((await callback()).status, 200)
  current = (await (await s.request(path + '/' + o.id, undefined, admin)).json()).order
  assert.equal(current.refundedCents, 1); assert.equal(current.refund.status, 'refunded')
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_debits').get()!.n, 0)
  assert.equal((await (await s.request('/api/admin/overview', undefined, admin)).json()).stats.refund_amount, 0)
})

test('missing expired QR trades retire only after the safety window', async t => {
  const s = await setup(t); s.live()
  mockGateway(t, (method, biz) => method === 'alipay.trade.precreate' ? { code: '10000', out_trade_no: biz.out_trade_no, qr_code: 'https://qr.alipay.com/test' } : { code: '40004', sub_code: 'ACQ.TRADE_NOT_EXIST' })
  await s.pay('create'); s.db.prepare('UPDATE payments SET expires_at=?').run(Date.now() - 30000)
  await s.pay('query'); assert.equal((await findPayment(s.env, s.id))!.state, 'pending')
  s.db.prepare('UPDATE payments SET expires_at=?').run(Date.now() - 121000)
  await s.pay('query'); assert.equal((await findPayment(s.env, s.id))!.state, 'closed')
})
