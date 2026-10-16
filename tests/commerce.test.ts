import { seedAdminEmailCode } from './admin-email-fixture.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import worker from '../worker/index.ts'
import { totpCode } from '../worker/totp.ts'
import { hash, type Env, type Statement, type Value } from '../worker/platform.ts'
import type { DefaultSupplySettings } from '../shared/partner-default-prices.ts'
import { PAYOUT_COOLDOWN_MS } from '../worker/finance.ts'
import { generateReferralCode } from '../shared/partner-link.ts'
import { emptyAnnouncement } from '../shared/announcements.ts'
import { provisionPartner } from '../worker/partner-provision.ts'

const credential = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
async function setup() {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'))
  const bound = new WeakMap<Statement, { sql: string; values: Value[] }>()
  const env: Env = {
    ORDER_TESTING_ENABLED: 'true', PUBLIC_SITE_ORIGIN: 'https://shop.example.invalid', ASSETS: { fetch: async () => new Response('asset') }, ADMIN_EMAIL: 'admin@example.invalid', ADMIN_USERNAME: 'tester', ADMIN_TOTP_SECRET: credential,
    INTEREST_LIMITER: { limit: async () => ({ success: true }) },
    API_LIMITER: { limit: async () => ({ success: true }) },
    EXPENSIVE_LIMITER: { limit: async () => ({ success: true }) },
    INTEREST_DB: {
      prepare(sql: string): Statement {
        const state = { sql, values: [] as Value[] }
        const statement: Statement = { bind(...values) { state.values = values; return this }, async first<T>() { return (db.prepare(sql).get(...state.values) ?? null) as T | null }, async all<T>() { return { results: db.prepare(sql).all(...state.values) as T[] } }, async run() { return db.prepare(sql).run(...state.values) } }
        bound.set(statement, state); return statement
      },
      async batch(statements) {
        db.exec('BEGIN')
        try { const results = statements.map(s => { const state = bound.get(s)!; const prepared = db.prepare(state.sql); return /^\s*SELECT\b/i.test(state.sql) ? { results: prepared.all(...state.values) } : prepared.run(...state.values) }); db.exec('COMMIT'); return results }
        catch (e) { db.exec('ROLLBACK'); throw e }
      },
    },
  }
  const request = (path: string, data?: unknown, cookie = '', origin = 'https://shop.example.invalid') => worker.fetch(new Request('https://shop.example.invalid' + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie }, body: data === undefined ? undefined : JSON.stringify(data) }), env)
  const buyer = async () => (await request('/api/orders/client', {})).headers.get('Set-Cookie')!.split(';')[0]
  const login = async () => {
    const response = await request('/api/admin/login', { username: 'tester', code: await totpCode(credential), ...await seedAdminEmailCode(db, env) })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('Set-Cookie')!, /HttpOnly; SameSite=Strict.*Secure/)
    return response.headers.get('Set-Cookie')!.split(';')[0]
  }
  const create = async (cookie: string, plan = 'plus', expectedPrice = 13900, key = crypto.randomUUID()) => {
    const response = await request('/api/orders', { email: 'buyer@example.test', plan, expectedPrice, key }, cookie)
    assert.equal(response.status, 201, await response.clone().text())
    return (await response.json()).order
  }
  return { db, env, request, buyer, login, create }
}

async function accountingOrder(s: Awaited<ReturnType<typeof setup>>, buyer: string, plan = 'plus', price = 13400) {
  const catalogPrice = s.db.prepare('SELECT price_cents FROM catalog_plans WHERE id=?').get(plan)!.price_cents as number
  const order = await s.create(buyer, plan, catalogPrice)
  s.db.prepare("UPDATE orders SET mode='live',payment_status='paid',status='success',price_cents=? WHERE id=?").run(price,order.id)
  return order.id as string
}

test('plan display labels start with Plus, save through admin, and reach direct and partner catalogs', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const initialCatalog = (await (await s.request('/api/catalog')).json()).plans
  const initial = initialCatalog.find((plan: { id: string }) => plan.id === 'plus')
  assert.equal(initial.display_label, '日常之选')
  assert.equal(initialCatalog.find((plan: { id: string }) => plan.id === 'pro-5x').display_label, '')
  const admin = await s.login()
  const plus = (await (await s.request('/api/admin/plans', undefined, admin)).json()).plans.find((plan: { id: string }) => plan.id === 'plus')
  const change = (displayLabel: unknown, version = plus.version) => ({ priceCents: plus.price_cents, enabled: Boolean(plus.enabled), displayLabel, version, note: '调整套餐标签' })
  assert.equal((await s.request('/api/admin/plans/plus', change('热门推荐'))).status, 401)
  assert.equal((await s.request('/api/admin/plans/plus', change(42), admin)).status, 400)
  assert.equal((await s.request('/api/admin/plans/plus', change('太'.repeat(21)), admin)).status, 400)
  assert.equal((await s.request('/api/admin/plans/plus', change('热门推荐'), admin)).status, 200)
  assert.equal(s.db.prepare("SELECT display_label FROM catalog_plans WHERE id='plus'").get()!.display_label, '热门推荐')
  assert.equal((await s.request('/api/admin/plans/plus', change('旧标签'), admin)).status, 409)
  const direct = (await (await s.request('/api/catalog')).json()).plans.find((plan: { id: string }) => plan.id === 'plus')
  assert.equal(direct.display_label, '热门推荐')
  const now = Date.now()
  s.db.prepare('INSERT INTO partners(id,slug,name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('label-agent', 'label-agent', '标签代理', 'label-agent@example.test', now, now)
  s.db.prepare('INSERT INTO partner_prices(partner_id,plan,cost_cents,price_cents) SELECT ?,id,price_cents,price_cents FROM catalog_plans').run('label-agent')
  const partnerResponse = await s.request('/api/catalog?partner=label-agent')
  assert.equal(partnerResponse.status, 200, await partnerResponse.clone().text())
  const partner = (await partnerResponse.json()).plans.find((plan: { id: string }) => plan.id === 'plus')
  assert.equal(partner.display_label, '热门推荐')
  assert.equal((await s.request('/api/admin/plans/plus', change('', plus.version + 1), admin)).status, 200)
  assert.equal((await (await s.request('/api/catalog')).json()).plans.find((plan: { id: string }) => plan.id === 'plus').display_label, '')
})

test('5SIM admin connection check is authenticated, read-only, and does not expose credentials', async t => {
  const s = await setup(); t.after(() => s.db.close())
  assert.equal((await s.request('/api/admin/fivesim/status')).status, 401)
  const admin = await s.login()
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(String(url), 'https://5sim.net/v1/user/profile')
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer private-five-sim-key')
    return Response.json({ id: 9, email: 'supplier-private@example.test', balance: 42.75, frozen_balance: 0 })
  })
  assert.deepEqual(await (await s.request('/api/admin/fivesim/status', undefined, admin)).json(), { configured: false, connected: false })
  assert.equal(fetch.mock.callCount(), 0)
  assert.equal((await (await s.request('/api/admin/overview', undefined, admin)).json()).integrations.fivesim, false)
  s.env.FIVESIM_API_TOKEN = 'private-five-sim-key'
  const response = await s.request('/api/admin/fivesim/status', undefined, admin)
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.deepEqual(payload, { configured: true, connected: true, balance: 42.75 })
  assert.doesNotMatch(JSON.stringify(payload), /private-five-sim-key|supplier-private/)
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal((await (await s.request('/api/admin/overview', undefined, admin)).json()).integrations.fivesim, true)
})

test('verification settings are public when this worker has no Turnstile', async t => {
  const s = await setup(); t.after(() => s.db.close())
  for (const path of ['/api/orders/verification', '/api/orders/verification?purpose=auth']) {
    const response = await s.request(path)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { enabled: false })
  }
})

test('accounting report subtracts earned agent commissions and separates paid unfinished and unpaid orders', async t => {
  const s = await setup(); t.after(() => s.db.close()); const buyer = await s.buyer(); const admin = await s.login()
  const now = Date.now()
  s.db.prepare('INSERT INTO partners(id,slug,name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('report-agent','REPORT','报表代理','report@example.test',now,now)
  const plus = await accountingOrder(s,buyer); const pro = await accountingOrder(s,buyer,'pro-5x',68700); await accountingOrder(s,buyer,'plus',16900)
  s.db.prepare("UPDATE orders SET partner_id='report-agent',partner_name='报表代理',cost_cents=11300 WHERE id=?").run(plus)
  s.db.prepare("UPDATE orders SET partner_id='report-agent',partner_name='报表代理',cost_cents=65000 WHERE id=?").run(pro)
  const unfinished = await accountingOrder(s,buyer); s.db.prepare("UPDATE orders SET status='processing' WHERE id=?").run(unfinished)
  const unpaid = await s.create(buyer); s.db.prepare("UPDATE orders SET mode='live' WHERE id=?").run(unpaid.id)
  const demo = await s.create(buyer); s.db.prepare("UPDATE orders SET payment_status='simulated',status='success' WHERE id=?").run(demo.id)
  const testing = await accountingOrder(s,buyer); s.db.prepare('UPDATE orders SET is_test=1 WHERE id=?').run(testing)
  assert.equal((await s.request('/api/admin/accounting/report')).status,401)
  assert.equal((await s.request('/api/admin/accounting/report',undefined,buyer)).status,401)
  const completed = await (await s.request('/api/admin/accounting/report',undefined,admin)).json()
  assert.equal(completed.totals.order_count,3); assert.equal(completed.totals.paid_count,3); assert.equal(completed.totals.completed_count,3)
  assert.equal(completed.totals.paid_cents,99000); assert.equal(completed.totals.cost_cents,86400)
  assert.equal(completed.totals.commission_cents,5800); assert.equal(completed.totals.profit_cents,6800)
  assert.equal(completed.groups.find(g => g.plan==='pro-5x').profit_cents,1200)
  s.db.prepare("INSERT INTO partner_payouts(id,partner_id,amount_cents,status,recipient,created_at,request_key) VALUES ('report-paid','report-agent',2100,'paid','fixture',?,'fixture')").run(now)
  s.db.prepare("UPDATE orders SET payout_id='report-paid' WHERE id=?").run(plus)
  s.db.prepare("INSERT INTO partner_prices(partner_id,plan,cost_cents,price_cents) VALUES ('report-agent','plus',12000,14000)").run()
  const afterPayout = await (await s.request('/api/admin/accounting/report',undefined,admin)).json()
  assert.equal(afterPayout.totals.commission_cents,5800); assert.equal(afterPayout.totals.profit_cents,6800)
  const all = await (await s.request('/api/admin/accounting/report?status=all',undefined,admin)).json()
  assert.equal(all.totals.order_count,5); assert.equal(all.totals.paid_count,4); assert.equal(all.totals.paid_cents,112400)
  assert.equal(all.totals.completed_paid_cents,99000); assert.equal(all.totals.cost_cents,86400); assert.equal(all.totals.profit_cents,6800)
  assert.equal(all.orders.find(o => o.id===unfinished).cost_cents,0); assert.equal(all.orders.find(o => o.id===unpaid.id).paid_cents,0)
  for (const status of ['pending','session','processing','success','failed','cancelled','refunded']) assert.equal((await s.request('/api/admin/accounting/report?status='+status,undefined,admin)).status,200)
  assert.equal(s.db.prepare('SELECT version FROM accounting_state').get()!.version,0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM accounting_settlements').get()!.n,0)
})

test('accounting report applies exact inclusive-start exclusive-end order time bounds and rejects invalid filters', async t => {
  const s = await setup(); t.after(() => s.db.close()); const buyer = await s.buyer(); const admin = await s.login()
  const start = Date.parse('2026-09-29T19:46:00+08:00'); const end = Date.parse('2026-09-30T20:00:01+08:00')
  const ids = []
  for (const at of [start-1,start,end-1,end]) { const id = await accountingOrder(s,buyer); ids.push(id); s.db.prepare('UPDATE orders SET created_at=? WHERE id=?').run(at,id) }
  const data = await (await s.request(`/api/admin/accounting/report?start=${start}&end=${end}&status=success`,undefined,admin)).json()
  assert.equal(data.totals.order_count,2); assert.equal(data.totals.paid_cents,26800); assert.deepEqual(new Set(data.orders.map(o => o.id)),new Set([ids[1],ids[2]]))
  for (const q of ['status=unknown','start=no','end=-1','page=0','page=1.5',`start=${end}&end=${start}`,`start=${start}&end=${start}`,'start=1e3']) assert.equal((await s.request('/api/admin/accounting/report?'+q,undefined,admin)).status,400,q)
  const empty = await (await s.request('/api/admin/accounting/report?start='+end+'&status=failed',undefined,admin)).json()
  assert.equal(empty.totals.order_count,0); assert.equal(empty.totals.profit_cents,0); assert.deepEqual(empty.groups,[])
})

test('accounting report retains settled procurement snapshots and handles proportional refunds and supplier margin caps', async t => {
  const s = await setup(); t.after(() => s.db.close()); const buyer = await s.buyer(); const admin = await s.login()
  const now = Date.now(); s.db.prepare('INSERT INTO partners(id,slug,name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('report-agent','REPORT','报表代理','report@example.test',now,now)
  const id = await accountingOrder(s,buyer)
  s.db.prepare("UPDATE orders SET partner_id='report-agent',cost_cents=11300 WHERE id=?").run(id)
  const key = crypto.randomUUID(); assert.equal((await s.request('/api/admin/accounting/close',{version:0,key},admin)).status,201)
  s.db.prepare("UPDATE accounting_costs SET cost_cents=10000 WHERE plan='plus'").run()
  s.db.prepare('UPDATE orders SET refunded_cents=1000 WHERE id=?').run(id)
  s.db.prepare("INSERT INTO recharge_orders(order_id,account,product_code,collection_mode,create_body,updated_at,refunded_cents,financial_hold,merchant_margin_cents) VALUES (?,'fixture','plus','platform_collect','{}',?,1000,0,1500)").run(id,now)
  const data = await (await s.request('/api/admin/accounting/report?status=refunded',undefined,admin)).json()
  assert.equal(data.totals.order_count,1); assert.equal(data.totals.cost_cents,11300); assert.equal(data.totals.refund_cents,1000)
  assert.equal(data.totals.commission_cents,1500); assert.equal(data.totals.profit_cents,-400)
  assert.equal(data.totals.completed_refund_cents,1000)
  const history = await (await s.request('/api/admin/accounting/'+key,undefined,admin)).json()
  assert.equal(history.settlement.profit_cents,2100)
  // Without a supplier cap, use the same cumulative refund rounding as payouts.
  s.db.prepare('DELETE FROM recharge_orders WHERE order_id=?').run(id)
  const proportional = await (await s.request('/api/admin/accounting/report',undefined,admin)).json()
  assert.equal(proportional.totals.commission_cents,1944); assert.equal(proportional.totals.profit_cents,-844)
  s.db.prepare('UPDATE orders SET refunded_cents=13400 WHERE id=?').run(id)
  const full = await (await s.request('/api/admin/accounting/report',undefined,admin)).json()
  assert.equal(full.totals.commission_cents,0); assert.equal(full.totals.profit_cents,-11300)
})

test('accounting report marks unknown costs, missing commissions and financial holds rather than showing a false total', async t => {
  const s = await setup(); t.after(() => s.db.close()); const buyer = await s.buyer(); const admin = await s.login()
  await accountingOrder(s,buyer,'pro-25x',450000)
  const held = await accountingOrder(s,buyer); s.db.prepare('UPDATE orders SET refund_hold=1 WHERE id=?').run(held)
  s.db.prepare('INSERT INTO partners(id,slug,name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('report-agent','REPORT','报表代理','report@example.test',Date.now(),Date.now())
  const missing = await accountingOrder(s,buyer); s.db.prepare("UPDATE orders SET partner_id='report-agent',cost_cents=NULL WHERE id=?").run(missing)
  const data = await (await s.request('/api/admin/accounting/report',undefined,admin)).json()
  assert.equal(data.totals.order_count,3); assert.equal(data.totals.missing_cost_count,1); assert.equal(data.totals.missing_commission_count,1); assert.equal(data.totals.held_count,1)
  assert.equal(data.totals.profit_cents,null); assert.equal(data.orders.find(o => o.id===held).profit_cents,null)
  s.db.prepare("UPDATE orders SET cost_cents=11300 WHERE id=?").run(missing)
  s.db.prepare("INSERT INTO recharge_orders(order_id,account,product_code,collection_mode,create_body,updated_at,financial_hold) VALUES (?,'fixture','plus','platform_collect','{}',?,0)").run(missing,Date.now())
  const unknownSupplier = await (await s.request('/api/admin/accounting/report',undefined,admin)).json()
  assert.equal(unknownSupplier.totals.missing_commission_count,1)
})

test('accounting report paginates order rows while keeping aggregate totals for the complete filtered set', async t => {
  const s = await setup(); t.after(() => s.db.close()); const buyer = await s.buyer(); const admin = await s.login()
  for (let i=0;i<21;i++) await accountingOrder(s,buyer)
  const first = await (await s.request('/api/admin/accounting/report',undefined,admin)).json()
  const second = await (await s.request('/api/admin/accounting/report?page=2',undefined,admin)).json()
  assert.equal(first.totals.order_count,21); assert.equal(first.totals.profit_cents,44100); assert.deepEqual(second.totals,first.totals)
  assert.equal(first.orders.length,20); assert.equal(second.orders.length,1)
  assert.equal(new Set([...first.orders,...second.orders].map(o => o.id)).size,21)
})

test('accounting is admin-only, excludes incomplete/demo/test orders and saves immutable retail-minus-procurement totals', async t => {
  const s = await setup(); t.after(() => s.db.close()); const buyer = await s.buyer(); const admin = await s.login()
  const plus = await accountingOrder(s,buyer); await accountingOrder(s,buyer,'pro-5x',68700)
  const demo = await s.create(buyer); s.db.prepare("UPDATE orders SET payment_status='simulated',status='success' WHERE id=?").run(demo.id)
  const incomplete = await accountingOrder(s,buyer); s.db.prepare("UPDATE orders SET status='processing' WHERE id=?").run(incomplete)
  const testOrder = await accountingOrder(s,buyer); s.db.prepare('UPDATE orders SET is_test=1 WHERE id=?').run(testOrder)
  assert.equal((await s.request('/api/admin/accounting',undefined,buyer)).status,401)
  assert.equal((await s.request('/api/admin/accounting/close',{ version: 0,key:crypto.randomUUID() },buyer)).status,401)
  assert.equal((await s.request('/api/admin/accounting/close',{ version: 0,key:crypto.randomUUID() },admin,'https://evil.test')).status,403)
  const preview = await (await s.request('/api/admin/accounting',undefined,admin)).json()
  assert.deepEqual(preview.totals,{ order_count:2,adjustment_count:0,sale_cents:82100,cost_cents:75100,refund_cents:0,profit_cents:7000,missing_cost_count:0,first_at:preview.fromAt })
  const key = crypto.randomUUID(); const response = await s.request('/api/admin/accounting/close',{version:preview.version,key},admin)
  assert.equal(response.status,201,await response.clone().text()); const closed = (await response.json()).settlement
  assert.equal(closed.profit_cents,7000); assert.equal(closed.order_count,2); assert.equal(closed.from_at,preview.fromAt)
  const detail = await (await s.request('/api/admin/accounting/'+key,undefined,admin)).json()
  assert.equal(detail.total,2); assert.equal(detail.items.find((i: {order_id:string}) => i.order_id===plus).cost_cents,11300)
  s.db.prepare('UPDATE accounting_costs SET cost_cents=1 WHERE plan=\'plus\'').run()
  assert.equal((await (await s.request('/api/admin/accounting/'+key,undefined,admin)).json()).settlement.profit_cents,7000)
  const next = await (await s.request('/api/admin/accounting',undefined,admin)).json()
  assert.equal(next.totals.order_count,0); assert.equal(next.fromAt,closed.closed_at); assert.equal(next.historyTotal,1)
  assert.equal((await s.request('/api/admin/accounting/close',{version:next.version,key:crypto.randomUUID()},admin)).status,409)
  assert.equal((await s.request('/api/admin/accounting/close',{version:preview.version,key},admin)).status,200)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM accounting_settlements').get()!.n,1)
})

test('accounting carries late completed and held orders forward and applies subsequent refunds exactly once', async t => {
  const s = await setup(); t.after(() => s.db.close()); const buyer = await s.buyer(); const admin = await s.login()
  const paid = await accountingOrder(s,buyer); const late = await accountingOrder(s,buyer); const held = await accountingOrder(s,buyer)
  s.db.prepare("UPDATE orders SET status='processing' WHERE id=?").run(late)
  s.db.prepare('UPDATE orders SET refund_hold=1 WHERE id=?').run(held)
  const preview = await (await s.request('/api/admin/accounting',undefined,admin)).json()
  assert.equal(preview.heldCount,1); assert.equal(preview.totals.order_count,1)
  const first = (await (await s.request('/api/admin/accounting/close',{version:preview.version,key:crypto.randomUUID()},admin)).json()).settlement
  s.db.prepare("UPDATE orders SET status='success' WHERE id=?").run(late)
  s.db.prepare('UPDATE orders SET refund_hold=0 WHERE id=?').run(held)
  s.db.prepare('UPDATE orders SET refunded_cents=1000 WHERE id=?').run(paid)
  const next = await (await s.request('/api/admin/accounting',undefined,admin)).json()
  assert.equal(next.fromAt,first.closed_at); assert.equal(next.totals.order_count,2); assert.equal(next.totals.adjustment_count,1); assert.equal(next.totals.profit_cents,3200)
  const key = crypto.randomUUID(); assert.equal((await s.request('/api/admin/accounting/close',{version:next.version,key},admin)).status,201)
  const clean = await (await s.request('/api/admin/accounting',undefined,admin)).json()
  assert.equal(clean.totals.order_count,0); assert.equal(clean.totals.adjustment_count,0)
  s.db.prepare('UPDATE orders SET refunded_cents=13400 WHERE id=?').run(paid)
  const refund = await (await s.request('/api/admin/accounting',undefined,admin)).json()
  assert.equal(refund.totals.refund_cents,12400); assert.equal(refund.totals.profit_cents,-12400)
  assert.equal((await s.request('/api/admin/accounting/close',{version:refund.version,key:crypto.randomUUID()},admin)).status,201)
  assert.equal(s.db.prepare('SELECT SUM(refund_cents) n FROM accounting_items WHERE order_id=?').get(paid)!.n,13400)
})

test('accounting refuses unknown costs, validates settings and guards stale costs and concurrent closes', async t => {
  const s = await setup(); t.after(() => s.db.close()); const buyer = await s.buyer(); const admin = await s.login()
  await accountingOrder(s,buyer,'pro-25x',450000)
  const preview = await (await s.request('/api/admin/accounting',undefined,admin)).json()
  assert.equal(preview.totals.missing_cost_count,1)
  assert.equal((await s.request('/api/admin/accounting/close',{version:preview.version,key:crypto.randomUUID()},admin)).status,409)
  const costs = preview.costs.map((c: {plan:string;cost_cents:number|null}) => ({plan:c.plan,cost_cents:c.plan==='pro-25x'?325000:c.cost_cents}))
  for (const invalid of [[...costs,costs[0]], costs.map((c: {plan:string;cost_cents:number|null}) => ({...c,cost_cents:-1})),[],[{plan:'plus',cost_cents:'11300'}]]) assert.equal((await s.request('/api/admin/accounting/costs',{version:0,costs:invalid},admin)).status,400)
  assert.equal((await s.request('/api/admin/accounting/costs',{version:0,costs},admin)).status,200)
  assert.equal((await s.request('/api/admin/accounting/costs',{version:0,costs},admin)).status,409)
  assert.equal((await s.request('/api/admin/accounting/close',{version:0,key:crypto.randomUUID()},admin)).status,409)
  const current = await (await s.request('/api/admin/accounting',undefined,admin)).json()
  assert.equal(current.totals.profit_cents,125000)
  const results = await Promise.all([s.request('/api/admin/accounting/close',{version:current.version,key:crypto.randomUUID()},admin),s.request('/api/admin/accounting/close',{version:current.version,key:crypto.randomUUID()},admin)])
  assert.deepEqual(results.map(r => r.status).sort(),[201,409])
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM accounting_settlements').get()!.n,1)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM accounting_items').get()!.n,1)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='accounting-close'").get()!.n,1)
})

test('accounting waits for supplier financial reconciliation and snapshots the confirmed refund', async t => {
  const s = await setup(); t.after(() => s.db.close()); const buyer = await s.buyer(); const admin = await s.login()
  const id = await accountingOrder(s,buyer)
  s.db.prepare("INSERT INTO recharge_orders(order_id,account,product_code,collection_mode,create_body,updated_at,refunded_cents,financial_hold) VALUES (?,'fixture','plus','platform_collect','{}',?,1000,1)").run(id,Date.now())
  const held = await (await s.request('/api/admin/accounting',undefined,admin)).json()
  assert.equal(held.heldCount,1); assert.equal(held.totals.order_count,0)
  assert.equal((await s.request('/api/admin/accounting/close',{version:0,key:crypto.randomUUID()},admin)).status,409)
  s.db.prepare('UPDATE recharge_orders SET financial_hold=0 WHERE order_id=?').run(id)
  const eligible = await (await s.request('/api/admin/accounting',undefined,admin)).json()
  assert.equal(eligible.totals.refund_cents,1000); assert.equal(eligible.totals.profit_cents,1100)
  assert.equal((await s.request('/api/admin/accounting/close',{version:0,key:crypto.randomUUID()},admin)).status,201)
  s.db.prepare('UPDATE recharge_orders SET refunded_cents=2000 WHERE order_id=?').run(id)
  const refund = await (await s.request('/api/admin/accounting',undefined,admin)).json()
  assert.equal(refund.totals.adjustment_count,1); assert.equal(refund.totals.refund_cents,1000)
})

test('accounting rolls snapshots and cursor back if audit fails and provides paginated saved detail', async t => {
  const s = await setup(); t.after(() => s.db.close()); const buyer = await s.buyer(); const admin = await s.login()
  for (let i=0;i<51;i++) await accountingOrder(s,buyer)
  s.db.exec("CREATE TRIGGER fail_accounting BEFORE INSERT ON admin_audit WHEN NEW.action='accounting-close' BEGIN SELECT RAISE(ABORT,'private accounting failure'); END")
  const key = crypto.randomUUID(); const failed = await s.request('/api/admin/accounting/close',{version:0,key},admin)
  assert.equal(failed.status,503); assert.doesNotMatch(await failed.text(),/private accounting failure/)
  assert.equal(s.db.prepare('SELECT version FROM accounting_state').get()!.version,0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM accounting_items').get()!.n,0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM accounting_settlements').get()!.n,0)
  s.db.exec('DROP TRIGGER fail_accounting')
  assert.equal((await s.request('/api/admin/accounting/close',{version:0,key},admin)).status,201)
  const detail = await (await s.request('/api/admin/accounting/'+key+'?page=1',undefined,admin)).json()
  const second = await (await s.request('/api/admin/accounting/'+key+'?page=2',undefined,admin)).json()
  assert.equal(detail.total,51); assert.equal(detail.items.length,50); assert.equal(second.items.length,1)
  assert.equal(new Set([...detail.items,...second.items].map(i => i.order_id)).size,51)
  assert.equal((await s.request('/api/admin/accounting/'+key+'?page=0',undefined,admin)).status,400)
})

test('subscription migration preserves old orders and custom partner prices while adding 25x', async t => {
  const s = await setup(); t.after(() => s.db.close())
  // Reconstruct the pre-migration catalog before replaying the upgrade.
  s.db.exec("DELETE FROM accounting_costs WHERE plan='pro-25x'; DELETE FROM partner_default_prices WHERE plan='pro-25x'; DELETE FROM catalog_plans WHERE id='pro-25x'; UPDATE catalog_plans SET name='Pro 20×',renewal_only=1 WHERE id='pro-20x'")
  const buyer = await s.buyer(); const order = await s.create(buyer, 'pro-20x', 140000)
  const now = Date.now()
  s.db.prepare('INSERT INTO partners(id,slug,name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)').run('old-partner', 'old-shop', '旧代理', 'old@example.test', now, now)
  s.db.prepare('INSERT INTO partner_prices(partner_id,plan,cost_cents,price_cents) VALUES (?,?,?,?)').run('old-partner', 'pro-20x', 110000, 155000)
  s.db.exec(readFileSync(new URL('../migrations/0017_chatgpt_subscription_tiers.sql', import.meta.url), 'utf8'))
  const catalog = (await (await s.request('/api/catalog')).json()).plans
  const ten = catalog.find((p: { id: string }) => p.id === 'pro-20x')
  assert.equal(ten.name, 'Pro 10×'); assert.equal(ten.price_cents, 140000); assert.equal(ten.renewal_only, 0)
  const stored = s.db.prepare('SELECT plan_name,price_cents FROM orders WHERE id=?').get(order.id)!
  assert.equal(stored.plan_name, 'Pro 20×'); assert.equal(stored.price_cents, 140000)
  const oldPrices = s.db.prepare("SELECT cost_cents,price_cents FROM partner_prices WHERE partner_id='old-partner' AND plan='pro-20x'").get()!
  assert.equal(oldPrices.cost_cents, 110000); assert.equal(oldPrices.price_cents, 155000)
  const added = s.db.prepare("SELECT cost_cents,price_cents FROM partner_prices WHERE partner_id='old-partner' AND plan='pro-25x'").get()!
  assert.equal(added.cost_cents, 330000); assert.equal(added.price_cents, 450000)
  const created = await s.create(buyer, 'pro-25x', 450000)
  assert.equal(created.planName, 'Pro 25×')
})

test('redemption marker requires admin, valid input and current version; concurrent saves create one audit without altering money', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const buyer = await s.buyer(); const admin = await s.login(); const order = await s.create(buyer)
  const path = `/api/admin/orders/${order.id}/actions`
  const data = { action: 'redemption-control', blocked: true, note: '已人工退款，停止兑换', version: 0 }
  assert.equal((await s.request(path, data, buyer)).status, 401)
  assert.equal((await s.request(path, data, admin, 'https://evil.test')).status, 403)
  for (const invalid of [{ blocked: 'true' }, { blocked: 1 }, { note: '' }, { note: 'x'.repeat(501) }]) assert.equal((await s.request(path, { ...data, ...invalid }, admin)).status, 400)
  const results = await Promise.all([s.request(path, data, admin), s.request(path, data, admin)])
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409])
  const row = s.db.prepare('SELECT * FROM orders WHERE id=?').get(order.id)!
  assert.equal(row.redemption_blocked, 1); assert.equal(row.version, 1)
  assert.equal(row.status, 'pending'); assert.equal(row.refunded_cents, 0); assert.equal(row.price_cents, 13900)
  assert.equal(row.payment_status, 'unpaid'); assert.equal(s.db.prepare('SELECT COUNT(*) n FROM refund_cases').get()!.n, 0)
  const detail = (await (await s.request('/api/admin/orders/' + order.id, undefined, admin)).json())
  assert.equal(detail.events.filter((e: { action: string }) => e.action === 'redemption-block').length, 1)
  assert.match(detail.events.at(-1).note, /已人工退款/)
  assert.equal((await s.request(path, { ...data, blocked: false }, admin)).status, 409)
  const publicOrder = (await (await s.request('/api/orders/' + order.id, undefined, buyer)).json()).order
  assert.equal(publicOrder.redemptionBlocked, true)
  assert.doesNotMatch(JSON.stringify(publicOrder), /已人工退款/)
})

test('redemption marker prevents demo retries and settlement, persists through notes, and can only be released explicitly', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const buyer = await s.buyer(); const admin = await s.login(); const order = await s.create(buyer); const other = await s.create(buyer)
  s.db.prepare("UPDATE orders SET status='failed',payment_status='simulated' WHERE id=?").run(order.id)
  const adminPath = `/api/admin/orders/${order.id}/actions`
  assert.equal((await s.request(adminPath, { action: 'redemption-control', blocked: true, note: '作废不退款', version: 0 }, admin)).status, 200)
  for (const action of ['pay','retry','acquire-phone','submit-success','submit-failed']) assert.equal((await s.request(`/api/orders/${order.id}/demo-actions`, { action, version: 1 }, buyer)).status, 409)
  assert.equal((await s.request(adminPath, { action: 'retry', note: '不能绕过停用', version: 1 }, admin)).status, 409)
  assert.equal((await s.request(adminPath, { action: 'note', note: '补充内部备注', version: 1 }, admin)).status, 200)
  assert.equal(s.db.prepare('SELECT redemption_blocked FROM orders WHERE id=?').get(order.id)!.redemption_blocked, 1)
  assert.equal((await s.request(`/api/orders/${other.id}/demo-actions`, { action: 'pay', version: 0 }, buyer)).status, 200)
  s.db.prepare("UPDATE orders SET status='processing',outcome='success',started_at=? WHERE id=?").run(Date.now()-6000, order.id)
  const blocked = (await (await s.request('/api/orders/' + order.id, undefined, buyer)).json()).order
  assert.equal(blocked.status, 'processing'); assert.equal(blocked.redemptionBlocked, true)
  s.db.prepare("UPDATE orders SET status='failed' WHERE id=?").run(order.id)
  assert.equal((await s.request(adminPath, { action: 'redemption-control', blocked: false, note: '误标，核对后恢复', version: 2 }, admin)).status, 200)
  assert.equal((await s.request(`/api/orders/${order.id}/demo-actions`, { action: 'retry', version: 3 }, buyer)).status, 200)
  const events = s.db.prepare("SELECT action FROM order_events WHERE order_id=? AND action LIKE 'redemption-%' ORDER BY order_version").all(order.id)
  assert.deepEqual(events.map(e => e.action), ['redemption-block','redemption-unblock'])
})

test('redemption marker and audit roll back together on database failure', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const buyer = await s.buyer(); const admin = await s.login(); const order = await s.create(buyer)
  s.db.exec("CREATE TRIGGER fail_redemption_audit BEFORE INSERT ON order_events WHEN NEW.action='redemption-block' BEGIN SELECT RAISE(ABORT,'private database error'); END")
  const response = await s.request(`/api/admin/orders/${order.id}/actions`, { action: 'redemption-control', blocked: true, note: '停止兑换', version: 0 }, admin)
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private database error/)
  const row = s.db.prepare('SELECT redemption_blocked,version FROM orders WHERE id=?').get(order.id)!
  assert.equal(row.redemption_blocked, 0); assert.equal(row.version, 0)
})

test('administrator configuration, authentication, CSRF, credential rotation and logout protect all management data', async t => {
  const s = await setup(); t.after(() => s.db.close())
  assert.equal((await s.request('/api/admin/orders')).status, 401)
  assert.equal((await s.request('/api/admin/interest')).status, 401)
  assert.equal((await s.request('/api/admin/login', { username: 'tester', password: 'wrong' })).status, 401)
  assert.equal((await s.request('/api/admin/login', {}, '', 'https://evil.test')).status, 403)
  const cookie = await s.login()
  assert.equal((await s.request('/api/admin/orders', undefined, cookie)).status, 200)
  assert.equal(s.db.prepare('SELECT token_hash FROM admin_sessions').get()!.token_hash === cookie.split('=')[1], false)
  s.env.ADMIN_TOTP_SECRET = 'B'.repeat(32)
  assert.equal((await s.request('/api/admin/orders', undefined, cookie)).status, 401)
  s.env.ADMIN_TOTP_SECRET = credential
  s.db.exec('UPDATE admin_sessions SET expires_at=0')
  assert.equal((await s.request('/api/admin/orders', undefined, cookie)).status, 401)
  s.db.exec('DELETE FROM admin_totp_usage')
  const nextCookie = await s.login()
  assert.equal((await s.request('/api/admin/logout', {}, nextCookie)).status, 200)
  assert.equal((await s.request('/api/admin/orders', undefined, nextCookie)).status, 401)
  delete s.env.ADMIN_TOTP_SECRET
  assert.equal((await (await s.request('/api/admin/session')).json()).configured, false)
  assert.equal((await s.request('/api/admin/orders')).status, 503)
})

function adminMail(t: Parameters<Parameters<typeof test>[1]>[0], s: Awaited<ReturnType<typeof setup>>) {
  s.env.RESEND_API_KEY = 'test'; s.env.RESEND_FROM = 'GPTibo <noreply@shop.example.invalid>'
  const mails: { to: string[]; text: string; html: string; subject: string }[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://api.resend.com/emails')
    assert.match(new Headers(options.headers).get('Idempotency-Key')!, /^admin-login\//)
    mails.push(JSON.parse(String(options.body)))
    return Response.json({ id: 'test-admin-email' })
  })
  const random = crypto.getRandomValues.bind(crypto)
  t.mock.method(crypto, 'getRandomValues', (array: Uint32Array | Uint8Array) => {
    if (array instanceof Uint32Array) { array.fill(1234); return array }
    return random(array)
  })
  const send = () => s.request('/api/admin/login/email-code', { username: 'tester', email: 'attacker@example.test' })
  return { mails, send }
}

test('explicit local development mode opens admin only on loopback with testing enabled', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const local = (path: string) => worker.fetch(new Request('http://127.0.0.1:8787' + path), s.env)
  s.env.ADMIN_DEV_BYPASS = 'true'
  s.env.PUBLIC_SITE_ORIGIN = 'http://127.0.0.1:5173'
  delete s.env.ADMIN_TOTP_SECRET
  assert.deepEqual(await (await local('/api/admin/session')).json(), {
    configured: true, authenticated: true, devMode: true, mailReady: false,
    username: 'tester', partnerModeEnabled: true,
  })
  assert.equal((await local('/api/admin/orders')).status, 200)
  assert.equal((await s.request('/api/admin/orders')).status, 503)
  s.env.ORDER_TESTING_ENABLED = 'false'
  assert.equal((await local('/api/admin/orders')).status, 503)
  s.env.ORDER_TESTING_ENABLED = 'true'
  s.env.PUBLIC_SITE_ORIGIN = 'https://shop.example.invalid'
  assert.equal((await local('/api/admin/orders')).status, 503)
  s.env.PUBLIC_SITE_ORIGIN = 'http://127.0.0.1:5173'
  s.env.ADMIN_DEV_BYPASS = 'false'
  assert.equal((await local('/api/admin/orders')).status, 503)
})

test('admin login requires all three fields and sends codes only to the fixed mailbox', async t => {
  const s = await setup(); t.after(() => s.db.close()); const mail = adminMail(t, s)
  const session = await (await s.request('/api/admin/session')).json()
  assert.equal(session.authenticated, false); assert.equal(session.mailReady, true); assert.equal('username' in session, false)
  const unknown = await s.request('/api/admin/login/email-code', { username: 'unknown', email: 'attacker@example.test' })
  assert.equal(unknown.status, 200); assert.equal(mail.mails.length, 0)
  const sent = await mail.send(); assert.equal(sent.status, 200)
  const result = await sent.json(); assert.equal('emailCode' in result, false); assert.equal('username' in result, false)
  assert.deepEqual(mail.mails[0].to, ['admin@example.invalid']); assert.match(mail.mails[0].text, /001234/); assert.match(mail.mails[0].subject, /管理后台/)
  const row = s.db.prepare('SELECT * FROM admin_email_login_codes').get()!
  assert.notEqual(row.code_hash, '001234'); assert.equal(row.ready, 1); assert.equal(row.consumed_by, null)
  const payload = { username: 'tester', code: await totpCode(credential), emailCode: '001234', challenge: result.challenge }
  for (const data of [{ username: 'tester', code: payload.code }, { ...payload, username: 'wrong' }, { ...payload, emailCode: '999999' }, { ...payload, code: 'invalid' }]) {
    const r = await s.request('/api/admin/login', data); assert.equal(r.status, 401); assert.equal(r.headers.has('Set-Cookie'), false)
  }
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM admin_totp_usage').get()!.n, 0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM admin_sessions').get()!.n, 0)
  const login = await s.request('/api/admin/login', payload); assert.equal(login.status, 200)
  assert.match(login.headers.get('Set-Cookie')!, /HttpOnly; SameSite=Strict.*Secure/)
  const cookie = login.headers.get('Set-Cookie')!.split(';')[0]
  assert.equal((await s.request('/api/admin/orders', undefined, cookie)).status, 200)
  assert.notEqual(s.db.prepare('SELECT consumed_by FROM admin_email_login_codes').get()!.consumed_by, null)
  assert.equal((await s.request('/api/admin/login', { ...payload, code: await totpCode(credential, Math.floor(Date.now()/30000)+1) })).status, 401)
})

test('admin email resend invalidates the previous challenge and expires at ten minutes', async t => {
  let now = 1234567890000; t.mock.method(Date, 'now', () => now)
  const s = await setup(); t.after(() => s.db.close()); const mail = adminMail(t, s)
  const first = await (await mail.send()).json()
  assert.equal((await mail.send()).status, 429)
  now += 60000
  const second = await (await mail.send()).json()
  assert.notEqual(first.challenge, second.challenge); assert.equal(mail.mails.length, 2)
  const login = (challenge: string) => s.request('/api/admin/login', { username: 'tester', code: 'invalid', emailCode: '001234', challenge })
  assert.equal((await login(first.challenge)).status, 401)
  now += 600000
  assert.equal((await login(second.challenge)).status, 401)
  assert.equal(s.db.prepare('SELECT attempts FROM admin_email_login_codes').get()!.attempts, 0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM admin_sessions').get()!.n, 0)
})

test('admin email challenges lock after five failed attempts without consuming TOTP', async t => {
  const s = await setup(); t.after(() => s.db.close()); const payload = await seedAdminEmailCode(s.db, s.env)
  for (let i = 0; i < 5; i++) assert.equal((await s.request('/api/admin/login', { ...payload, username: 'tester', code: 'invalid' })).status, 401)
  assert.equal((await s.request('/api/admin/login', { ...payload, username: 'tester', code: await totpCode(credential) })).status, 401)
  assert.equal(s.db.prepare('SELECT attempts FROM admin_email_login_codes').get()!.attempts, 5)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM admin_totp_usage').get()!.n, 0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM admin_sessions').get()!.n, 0)
})

test('admin email delivery failure removes the challenge and preserves the resend limit', async t => {
  const s = await setup(); t.after(() => s.db.close()); const mail = adminMail(t, s)
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 500 }))
  assert.equal((await mail.send()).status, 503)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM admin_email_login_codes').get()!.n, 0)
  assert.equal((await mail.send()).status, 429)
  assert.equal((await s.request('/api/admin/login/email-code', { username: 'tester' }, '', 'https://evil.test')).status, 403)
  delete s.env.RESEND_API_KEY
  assert.equal((await mail.send()).status, 503)
})

test('admin email codes cannot authenticate until delivery has completed', async t => {
  const s = await setup(); t.after(() => s.db.close()); const mail = adminMail(t, s)
  let finishDelivery!: () => void, notifySending!: () => void
  const sending = new Promise<void>(resolve => { notifySending = resolve })
  const delivery = new Promise<void>(resolve => { finishDelivery = resolve })
  t.mock.method(globalThis, 'fetch', async () => { notifySending(); await delivery; return Response.json({ id: 'test-mail' }) })
  const pending = mail.send(); await sending
  const row = s.db.prepare('SELECT * FROM admin_email_login_codes').get()!
  assert.equal(row.ready, 0)
  const payload = { username: 'tester', code: await totpCode(credential), emailCode: '001234', challenge: row.id }
  assert.equal((await s.request('/api/admin/login', payload)).status, 401)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM admin_sessions').get()!.n, 0)
  finishDelivery(); assert.equal((await pending).status, 200)
  assert.equal((await s.request('/api/admin/login', payload)).status, 200)
})

test('admin email sends are bounded per hour and per IP, including unknown usernames', async t => {
  let now = 1234567890000; t.mock.method(Date, 'now', () => now)
  const s = await setup(); t.after(() => s.db.close()); const mail = adminMail(t, s)
  for (let i = 0; i < 5; i++) { assert.equal((await mail.send()).status, 200); now += 60000 }
  assert.equal((await mail.send()).status, 429); assert.equal(mail.mails.length, 5)
  now += 3600000
  for (let i = 0; i < 10; i++) assert.equal((await s.request('/api/admin/login/email-code', { username: 'unknown' })).status, 200)
  assert.equal((await s.request('/api/admin/login/email-code', { username: 'unknown' })).status, 429)
})

test('concurrent admin logins share a single email claim and roll back claims if session creation fails', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const payload = { username: 'tester', code: await totpCode(credential), ...await seedAdminEmailCode(s.db, s.env) }
  const batch = s.env.INTEREST_DB.batch.bind(s.env.INTEREST_DB)
  s.env.INTEREST_DB.batch = statements => batch([...statements, s.env.INTEREST_DB.prepare('INSERT INTO missing_auth_table VALUES (1)')])
  assert.equal((await s.request('/api/admin/login', payload)).status, 503)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM admin_totp_usage').get()!.n, 0)
  assert.equal(s.db.prepare('SELECT consumed_by FROM admin_email_login_codes').get()!.consumed_by, null)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM admin_sessions').get()!.n, 0)
  s.env.INTEREST_DB.batch = batch
  const responses = await Promise.all([s.request('/api/admin/login', payload), s.request('/api/admin/login', payload)])
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 401])
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM admin_sessions').get()!.n, 1)
})

test('old TOTP-only admin sessions and challenges from rotated credentials cannot authenticate', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const token = 'a'.repeat(64)
  s.db.prepare('INSERT INTO admin_sessions(token_hash,credential_version,expires_at) VALUES (?,?,?)').run(await hash(token), await hash('totp:tester:' + credential), Date.now()+600000)
  assert.equal((await (await s.request('/api/admin/session', undefined, '__Host-ymx_admin=' + token)).json()).authenticated, false)
  const payload = await seedAdminEmailCode(s.db, s.env)
  s.env.ADMIN_USERNAME = 'renamed'
  assert.equal((await s.request('/api/admin/login', { ...payload, username: 'renamed', code: await totpCode(credential) })).status, 401)
  assert.equal(s.db.prepare('SELECT consumed_by FROM admin_email_login_codes').get()!.consumed_by, null)
})

test('login throttling persists per IP and prevents repeated code guesses', async t => {
  const s = await setup(); t.after(() => s.db.close())
  for (let i = 0; i < 8; i++) assert.equal((await s.request('/api/admin/login', { username: 'tester', password: 'bad' })).status, 401)
  assert.equal((await s.request('/api/admin/login', { username: 'tester', code: await totpCode(credential) })).status, 429)
  s.db.exec('UPDATE admin_login_limits SET reset_at=0')
  await s.login()
})

test('TOTP replay and concurrent logins consume a time step only once, including across IPs', async t => {
  const now = 1234567890000; t.mock.method(Date, 'now', () => now)
  const s = await setup(); t.after(() => s.db.close())
  const step = Math.floor(now / 30000)
  const login = async (code: string, ip: string) => worker.fetch(new Request('https://shop.example.invalid/api/admin/login', { method: 'POST', headers: { Origin: 'https://shop.example.invalid', 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ username: 'tester', code, ...await seedAdminEmailCode(s.db, s.env) }) }), s.env)
  const code = await totpCode(credential, step)
  const responses = await Promise.all([login(code, '192.0.2.1'), login(code, '192.0.2.2')])
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 401])
  assert.equal((await login(code, '192.0.2.3')).status, 401)
  assert.equal((await login(await totpCode(credential, step - 1), '192.0.2.4')).status, 401)
  assert.equal((await login(await totpCode(credential, step + 1), '192.0.2.5')).status, 200)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM admin_sessions').get()!.n, 2)
})

test('account-wide TOTP throttling bounds guesses spread over different IPs', async t => {
  const s = await setup(); t.after(() => s.db.close())
  for (let i = 0; i < 31; i++) {
    const response = await worker.fetch(new Request('https://shop.example.invalid/api/admin/login', { method: 'POST', headers: { Origin: 'https://shop.example.invalid', 'Content-Type': 'application/json', 'CF-Connecting-IP': `192.0.2.${i}` }, body: JSON.stringify({ username: 'tester', code: 'invalid' }) }), s.env)
    assert.equal(response.status, i < 30 ? 401 : 429)
  }
})

test('orders use server prices, idempotent creation, owner isolation and durable snapshots', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const a = await s.buyer(); const b = await s.buyer(); const key = crypto.randomUUID()
  assert.equal((await s.request('/api/orders')).status, 401)
  assert.equal((await s.request('/api/orders', { email: 'buyer@example.test', plan: 'plus', expectedPrice: 1, key }, a)).status, 409)
  const order = await s.create(a, 'plus', 13900, key)
  const repeat = await s.request('/api/orders', { email: 'buyer@example.test', plan: 'plus', expectedPrice: 1, price: 1, status: 'success', key }, a)
  assert.equal((await repeat.json()).order.id, order.id)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 1)
  assert.equal((await s.request('/api/orders', { email: 'buyer@example.test', plan: 'pro-5x', expectedPrice: 69900, key }, a)).status, 409)
  assert.equal((await s.request('/api/orders/' + order.id, undefined, b)).status, 404)
  assert.equal((await s.request(`/api/orders/${order.id}/demo-actions`, { action: 'pay', version: 0 }, b)).status, 404)
  assert.equal((await (await s.request('/api/orders', undefined, b)).json()).orders.length, 0)
  const restored = (await (await s.request('/api/orders', undefined, a)).json()).orders[0]
  assert.equal(restored.price, 139); assert.equal(restored.mode, 'demo'); assert.equal(restored.paymentStatus, 'unpaid')
  assert.equal('owner_hash' in restored, false); assert.equal('outcome' in restored, false)
  assert.equal((await s.request('/api/orders', { email: 'buyer@example.test', plan: 'plus', expectedPrice: 13900, key: crypto.randomUUID() }, a, 'https://evil.test')).status, 403)
})

test('public launch preparation closes new orders and legacy actions while preserving order and refund history', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const buyer = await s.buyer(); const old = await s.create(buyer)
  s.db.prepare("UPDATE orders SET status='session',payment_status='simulated' WHERE id=?").run(old.id)
  delete s.env.ORDER_TESTING_ENABLED
  s.env.PAYMENT_CHECKOUT_ENABLED = 'true'
  const catalog = await (await s.request('/api/catalog')).json()
  assert.equal(catalog.checkoutEnabled, false)
  const create = await s.request('/api/orders', { email: 'buyer@example.test', plan: 'plus', expectedPrice: 13900, key: crypto.randomUUID() }, buyer)
  assert.equal(create.status, 409)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 1)
  assert.equal((await s.request('/api/orders/' + old.id, undefined, buyer)).status, 200)
  assert.equal((await s.request(`/api/orders/${old.id}/refunds`, undefined, buyer)).status, 200)
  const before = s.db.prepare('SELECT COUNT(*) n FROM order_events').get()!.n
  for (const action of ['pay', 'acquire-phone', 'submit-success', 'submit-failed', 'retry']) {
    assert.equal((await s.request(`/api/orders/${old.id}/demo-actions`, { action, version: 0 }, buyer)).status, 409)
  }
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM order_events').get()!.n, before)
  assert.equal((await s.request(`/api/orders/${old.id}/refunds`, { reason: '查看历史订单', key: crypto.randomUUID(), version: 0 }, buyer)).status, 409)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM refund_cases').get()!.n, 0)
})

test('explicit testing configuration opens checkout and retains nonfinancial order accounting', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const catalog = await (await s.request('/api/catalog')).json()
  assert.equal(catalog.checkoutEnabled, true)
  assert.equal(catalog.testingEnabled, true)
  const buyer = await s.buyer(); const order = await s.create(buyer)
  const paid = await s.request(`/api/orders/${order.id}/demo-actions`, { action: 'pay', version: 0 }, buyer)
  assert.equal(paid.status, 200)
  const result = (await paid.json()).order
  assert.equal(result.mode, 'demo')
  assert.equal(result.paymentStatus, 'simulated')
  assert.equal((await s.request(`/api/orders/${order.id}/refunds`, { reason: '检查售后流程', key: crypto.randomUUID(), version: result.version }, buyer)).status, 201)
  const admin = await s.login()
  const overview = (await (await s.request('/api/admin/overview', undefined, admin)).json()).stats
  assert.equal(overview.paid_amount, 0)
  assert.equal(overview.refund_amount, 0)
  assert.equal(overview.demo_amount, 13900)
})

test('state transitions require payment and phone acquisition; concurrent actions produce one audited change', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const buyer = await s.buyer(); const order = await s.create(buyer, 'codex-sms-once', 1000)
  const action = (action: string, version: number) => s.request(`/api/orders/${order.id}/demo-actions`, { action, version }, buyer)
  assert.equal((await action('submit-success', 0)).status, 409)
  const [p1,p2] = await Promise.all([action('pay', 0), action('pay', 0)])
  assert.deepEqual([p1.status,p2.status].sort(), [200,409])
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM order_events').get()!.n, 2)
  assert.equal((await action('submit-success', 1)).status, 409)
  assert.equal((await action('acquire-phone', 1)).status, 200)
  assert.equal((await action('submit-failed', 2)).status, 200)
  s.db.prepare('UPDATE orders SET started_at=?').run(Date.now() - 5000)
  const result = (await (await s.request('/api/orders/' + order.id, undefined, buyer)).json()).order
  assert.equal(result.status, 'failed'); assert.equal(result.paymentStatus, 'simulated')
  assert.equal((await action('retry', result.version)).status, 200)
  assert.equal((await action('submit-success', result.version + 1)).status, 200)
  s.db.prepare('UPDATE orders SET started_at=?').run(Date.now() - 5000)
  assert.equal((await (await s.request('/api/orders/' + order.id, undefined, buyer)).json()).order.status, 'success')
  s.db.prepare("UPDATE orders SET mode='live', payment_status='paid'").run()
  assert.equal((await action('pay', 0)).status, 403)
})

test('admin notes, permitted cancellation and plan edits are audited; paused plans and stale prices cannot create orders', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const buyer = await s.buyer(); const order = await s.create(buyer); const admin = await s.login()
  const action = (data: unknown) => s.request(`/api/admin/orders/${order.id}/actions`, data, admin)
  assert.equal((await action({ action: 'note', version: 0, note: '' })).status, 400)
  assert.equal((await action({ action: 'success', version: 0, note: 'not allowed' })).status, 409)
  assert.equal((await action({ action: 'note', version: 0, note: '确认客户要求' })).status, 200)
  assert.equal((await action({ action: 'cancel', version: 0, note: 'stale' })).status, 409)
  assert.equal((await action({ action: 'cancel', version: 1, note: '用户暂不购买' })).status, 200)
  const detail = await (await s.request('/api/admin/orders/' + order.id, undefined, admin)).json()
  assert.equal(detail.events.length, 3); assert.equal(detail.order.status, 'cancelled')
  const planBody = { priceCents: 13950, enabled: false, version: 0, note: '临时暂停' }
  assert.equal((await s.request('/api/admin/plans/plus', planBody, admin, 'https://evil.test')).status, 403)
  assert.equal((await s.request('/api/admin/plans/plus', planBody, admin)).status, 200)
  assert.equal((await s.request('/api/admin/plans/plus', planBody, admin)).status, 409)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM admin_audit').get()!.n, 1)
  assert.equal((await s.request('/api/orders', { email: 'buyer@example.test', plan: 'plus', expectedPrice: 13950, key: crypto.randomUUID() }, buyer)).status, 409)
  assert.equal((await (await s.request('/api/catalog')).json()).plans[0].enabled, 0)
  assert.equal((await s.request('/api/admin/plans/plus', { ...planBody, enabled: true, version: 1 }, admin)).status, 200)
  assert.equal((await s.request('/api/orders', { email: 'buyer@example.test', plan: 'plus', expectedPrice: 13900, key: crypto.randomUUID() }, buyer)).status, 409)
  const newer = await s.create(buyer, 'plus', 13950)
  assert.equal(newer.price, 139.5); assert.equal(detail.order.price, 139)
  const overview = await (await s.request('/api/admin/overview', undefined, admin)).json()
  assert.equal(overview.stats.total, 2); assert.equal(overview.stats.paid_amount, 0)
  assert.equal((await (await s.request('/api/admin/orders?status=cancelled', undefined, admin)).json()).total, 1)
  assert.equal((await s.request('/api/admin/orders?status=bogus', undefined, admin)).status, 400)
  assert.equal((await s.request('/api/admin/orders?page=-1', undefined, admin)).status, 400)
})

test('database errors fail closed; transaction rollback prevents partial order creation', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const buyer = await s.buyer()
  s.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON order_events BEGIN SELECT RAISE(ABORT, 'private detail'); END")
  const response = await s.request('/api/orders', { email: 'buyer@example.test', plan: 'plus', expectedPrice: 13900, key: crypto.randomUUID() }, buyer)
  assert.equal(response.status, 503); assert.equal((await response.text()).includes('private detail'), false)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders').get()!.n, 0)
})

async function seedPartner(s: Awaited<ReturnType<typeof setup>>, _admin: string, slug = 'corn-shop') {
  // Legacy accounts are fixtures, so these tests never send live opening emails.
  const id = crypto.randomUUID(); const now = Date.now()
  s.db.prepare('INSERT INTO partners(id,slug,name,email,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, slug, '玉米伙伴', slug.toLowerCase() + '@example.test', now, now)
  const costs: Record<string, number> = { plus: 10000, 'pro-5x': 60000, 'pro-20x': 120000, 'pro-25x': 330000, 'codex-sms-once': 700 }
  for (const plan of s.db.prepare('SELECT id,price_cents FROM catalog_plans').all()) s.db.prepare('INSERT INTO partner_prices(partner_id,plan,cost_cents,price_cents) VALUES (?,?,?,?)').run(id, plan.id, costs[String(plan.id)] ?? plan.price_cents, plan.price_cents)
  return id
}

test('Telegram initializes shop contacts, protects application metadata and reuses the queued invitation key', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login()
  const keys: string[] = []
  mockPartnerMail(t, s)
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => { keys.push(new Headers(options.headers).get('Idempotency-Key')!); return Response.json({ id: 'test-mail' }) })
  const now = Date.now()
  s.db.prepare("INSERT INTO telegram_partner_sessions(user_id,group_id,step,wechat,qq,email,expires_at,lock_token,lock_until) VALUES (101,-10042,'confirm','private_wechat','12345678','tg@example.test',?,'fixture-lock',?)").run(now + 3600000, now + 60000)
  const partner = await provisionPartner(s.env, 'tg@example.test', 'Telegram fixture', { userId: 101, groupId: -10042, lockToken: 'fixture-lock', wechat: 'private_wechat', qq: '12345678' })
  assert.equal((await s.request('/api/admin/partners/' + partner.id)).status, 401)
  const details = await (await s.request('/api/admin/partners/' + partner.id, undefined, admin)).json()
  assert.equal(details.telegramApplication.wechat, 'private_wechat')
  assert.equal(details.telegramApplication.qq, '12345678')
  const catalog = await (await s.request('/api/catalog?partner=' + partner.slug)).json()
  assert.deepEqual(catalog.supportContacts, { wechat: 'private_wechat', qq: '12345678', email: '' })
  assert.equal(catalog.telegramApplication, undefined)
  const list = await (await s.request('/api/admin/partners', undefined, admin)).json()
  const agent = list.rows.find((p: { id: string }) => p.id === partner.id)
  assert.equal(agent.wechat, 'private_wechat'); assert.equal(agent.qq, '12345678')
  const preview = await (await s.request('/api/admin/partners/' + partner.id + '/support-contacts', undefined, admin)).json()
  assert.deepEqual(preview.contacts, catalog.supportContacts)
  assert.equal(preview.version, 1)
  assert.ok(!JSON.stringify(catalog).includes('tg@example.test'))
  assert.equal((await s.request('/api/admin/partners/' + partner.id + '/invitation', {}, admin)).status, 200)
  const application = s.db.prepare('SELECT * FROM telegram_partner_applications').get()!
  assert.equal(keys[0], 'partner-welcome/telegram-' + application.id)
  assert.equal(application.mail_status, 'sent')
  assert.equal(application.notice_sent, 0)
})
function mockPartnerMail(t: Parameters<Parameters<typeof test>[1]>[0], s: Awaited<ReturnType<typeof setup>>) {
  const mails: { to: string[]; text: string }[] = []
  s.env.RESEND_API_KEY = 'test-only'; s.env.RESEND_FROM = 'login@example.test'; s.env.PARTNER_AUTH_SECRET = 'private-test-only-secret-32-characters-long'
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => { assert.equal(url, 'https://api.resend.com/emails'); mails.push(JSON.parse(String(options.body))); return Response.json({ id: 'test-mail' }) })
  return { mails, async send(email = 'corn-shop@example.test') { const r = await s.request('/api/partner/auth/send', { email }); assert.equal(r.status, 200); const data = await r.json(); return { challenge: data.challenge, code: mails.at(-1)!.text.match(/\b\d{6}\b/)![0] } }, async login(email = 'corn-shop@example.test') { const data = await this.send(email); const r = await s.request('/api/partner/auth/verify', data); assert.equal(r.status, 200, await r.clone().text()); return r.headers.get('set-cookie')!.split(';')[0] } }
}

test('admin partner list returns each agents own WeChat and QQ, keeps empty contacts and search totals', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login()
  const first = await seedPartner(s, admin, 'FIRSTA'); const second = await seedPartner(s, admin, 'SECONA'); const empty = await seedPartner(s, admin, 'EMPTYA')
  s.db.prepare("UPDATE support_contacts SET wechat='platform_wechat',qq='99999999' WHERE owner='platform'").run()
  s.db.prepare('INSERT INTO support_contacts(owner,partner_id,wechat,qq) VALUES (?,?,?,?)').run(first, first, 'first_wechat', '12345678')
  s.db.prepare('INSERT INTO support_contacts(owner,partner_id,wechat,qq) VALUES (?,?,?,?)').run(second, second, 'second_wechat', '')
  assert.equal((await s.request('/api/admin/partners')).status, 401)
  const response = await s.request('/api/admin/partners', undefined, admin)
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const data = await response.json(); assert.equal(data.total, 3)
  const contacts = Object.fromEntries(data.rows.map((row: { id: string; wechat: string; qq: string }) => [row.id, { wechat:row.wechat, qq:row.qq }]))
  assert.deepEqual(contacts[first], { wechat:'first_wechat', qq:'12345678' })
  assert.deepEqual(contacts[second], { wechat:'second_wechat', qq:'' })
  assert.deepEqual(contacts[empty], { wechat:'', qq:'' })
  const search = await (await s.request('/api/admin/partners?q=firsta%40example.test', undefined, admin)).json()
  assert.equal(search.total, 1); assert.equal(search.rows[0].id, first); assert.equal(search.rows[0].wechat, 'first_wechat')
  const next = await (await s.request('/api/admin/partners?page=2', undefined, admin)).json()
  assert.equal(next.total, 3); assert.deepEqual(next.rows, [])
})

test('partner opening sends only a login link; the partner requests an OTP before login and self pricing', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login(); const mail = mockPartnerMail(t, s)
  const payload = { email: 'NEW@example.test' }
  assert.equal((await s.request('/api/admin/partners', payload)).status, 401)
  const response = await s.request('/api/admin/partners', payload, admin)
  assert.equal(response.status, 201, await response.clone().text())
  const result = await response.json()
  assert.match(result.slug, /^[A-Z0-9]{6}$/); assert.equal(result.invitationSent, true)
  assert.equal(mail.mails.length, 1); assert.deepEqual(mail.mails[0].to, ['new@example.test'])
  assert.match(mail.mails[0].text, /账号已开通/); assert.match(mail.mails[0].text, /https:\/\/shop.example.invalid\/join/)
  const stored = s.db.prepare('SELECT * FROM partners WHERE id=?').get(result.id)!
  assert.equal(stored.slug, result.slug)
  assert.equal(stored.name, '代理商店')
  assert.equal(String(stored.name).includes('@'), false)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_prices WHERE partner_id=?').get(result.id)!.n, 10)
  assert.doesNotMatch(mail.mails[0].text, /\b\d{6}\b|10 分钟/)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_login_codes').get()!.n, 0)
  assert.equal((await s.request('/api/partner/auth/verify', { email: 'NEW@example.test', code: '001234' })).status, 401)
  const { code } = await mail.send('new@example.test')
  const login = await s.request('/api/partner/auth/verify', { email: 'NEW@example.test', code })
  assert.equal(login.status, 200, await login.clone().text())
  const cookie = login.headers.get('set-cookie')!.split(';')[0]
  assert.equal((await s.request('/api/partner/auth/verify', { email: 'new@example.test', code })).status, 401)
  assert.equal((await s.request('/api/partner/prices/plus', { priceCents: 15900, version: 0 }, cookie)).status, 200)
  assert.equal((await s.request('/api/partner/prices/plus', { priceCents: 13899, version: 1 }, cookie)).status, 400)
  const catalog = await (await s.request('/api/catalog?partner=' + result.slug)).json()
  assert.equal(catalog.partner.slug, result.slug); assert.equal(catalog.plans[0].price_cents, 15900)
  assert.equal('cost_cents' in catalog.plans[0], false); assert.equal('email' in catalog.partner, false)
  assert.equal((await s.request('/api/catalog?partner=' + result.slug.toLowerCase())).status, 404)
  const buyer = await s.buyer()
  const orderResponse = await s.request('/api/orders', { email: 'buyer@example.test', plan: 'plus', expectedPrice: 15900, partner: result.slug, key: crypto.randomUUID() }, buyer)
  assert.equal(orderResponse.status, 201)
  const order = (await orderResponse.json()).order
  const snapshot = s.db.prepare('SELECT partner_id,price_cents,cost_cents FROM orders WHERE id=?').get(order.id)!
  assert.equal(snapshot.partner_id, result.id); assert.equal(snapshot.price_cents, 15900); assert.equal(snapshot.cost_cents, 13900)
  assert.equal((await s.request('/api/admin/partners', payload, admin)).status, 409)
  assert.equal(mail.mails.length, 2)
})

const defaultPricesPath = '/api/admin/partners/default-prices'
const defaultCosts = { 'x-premium-3m': 1700, 'x-premium-6m': 3400, plus: 11300, 'pro-5x': 65000, 'pro-20x': 105000, 'pro-25x': 330000, 'codex-sms-once': 400, 'gemini-pro-18m': 1990, 'duolingo-12m': 1990, 'gmail-account': 1000 }
function defaultPricesPayload(settings: DefaultSupplySettings, costs: Record<string, number> = defaultCosts) {
  return { version: settings.version, prices: settings.plans.map(plan => ({ plan: plan.id, costCents: costs[plan.id] ?? plan.cost_cents, catalogVersion: plan.catalog_version })) }
}

test('default supply prices require an administrator and same-origin writes, and stay private', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login(); const mail = mockPartnerMail(t, s)
  await seedPartner(s, admin); const partner = await mail.login()
  assert.equal((await s.request(defaultPricesPath)).status, 401)
  assert.equal((await s.request(defaultPricesPath, undefined, partner)).status, 401)
  const settings: DefaultSupplySettings = await (await s.request(defaultPricesPath, undefined, admin)).json()
  assert.equal(settings.version, 2); assert.equal(settings.plans.length, 10)
  for (const plan of settings.plans) assert.equal(plan.cost_cents, plan.id === 'pro-25x' ? 330000 : plan.id === 'gmail-account' ? 1000 : plan.price_cents)
  const payload = defaultPricesPayload(settings)
  assert.equal((await s.request(defaultPricesPath, payload, partner)).status, 401)
  assert.equal((await s.request(defaultPricesPath, payload, admin, 'https://evil.test')).status, 403)
  assert.equal((await s.request('/api/partner/default-prices', undefined, partner)).status, 404)
  for (const path of ['/api/catalog', '/api/catalog?partner=corn-shop']) {
    const catalog = await (await s.request(path)).json()
    assert.equal(catalog.plans.some((plan: Record<string, unknown>) => 'cost_cents' in plan), false)
  }
})

test('saved defaults are copied into new partners, preserve existing partner and order prices, and keep initial retail above cost', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login(); mockPartnerMail(t, s)
  const existing = await seedPartner(s, admin); const buyer = await s.buyer()
  const existingOrder = await s.request('/api/orders', { email: 'buyer@example.test', plan: 'plus', expectedPrice: 13900, partner: 'corn-shop', key: crypto.randomUUID() }, buyer)
  const orderId = (await existingOrder.json()).order.id
  const settings = await (await s.request(defaultPricesPath, undefined, admin)).json()
  const saved = await s.request(defaultPricesPath, defaultPricesPayload(settings), admin)
  assert.equal(saved.status, 200, await saved.clone().text())
  assert.equal((await saved.json()).version, settings.version + 1)
  assert.equal(s.db.prepare('SELECT cost_cents FROM partner_prices WHERE partner_id=? AND plan=?').get(existing, 'plus')!.cost_cents, 10000)
  assert.equal(s.db.prepare('SELECT cost_cents FROM orders WHERE id=?').get(orderId)!.cost_cents, 10000)
  const opened = await s.request('/api/admin/partners', { email: 'default-new@example.test' }, admin)
  assert.equal(opened.status, 201); const first = await opened.json()
  for (const row of s.db.prepare('SELECT * FROM partner_prices WHERE partner_id=?').all(first.id)) {
    assert.equal(row.cost_cents, defaultCosts[String(row.plan) as keyof typeof defaultCosts])
    assert.equal(row.price_cents, s.db.prepare('SELECT price_cents FROM catalog_plans WHERE id=?').get(row.plan)!.price_cents)
  }
  const next = await (await s.request(defaultPricesPath, undefined, admin)).json()
  assert.equal((await s.request(defaultPricesPath, defaultPricesPayload(next, { ...defaultCosts, plus: 10500 }), admin)).status, 200)
  assert.equal(s.db.prepare('SELECT cost_cents FROM partner_prices WHERE partner_id=? AND plan=?').get(first.id, 'plus')!.cost_cents, 11300)
  s.db.prepare('UPDATE catalog_plans SET price_cents=9900,version=version+1 WHERE id=?').run('plus')
  const later = await s.request('/api/admin/partners', { email: 'default-later@example.test' }, admin)
  assert.equal(later.status, 201, await later.clone().text())
  const second = await later.json()
  const plus = s.db.prepare('SELECT cost_cents,price_cents FROM partner_prices WHERE partner_id=? AND plan=?').get(second.id, 'plus')!
  assert.equal(plus.cost_cents, 10500); assert.equal(plus.price_cents, 10500)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM admin_audit WHERE action=?').get('partner-default-prices')!.n, 2)
  const orderResponse = await s.request('/api/orders', { email: 'buyer@example.test', plan: 'plus', expectedPrice: 10500, partner: second.slug, key: crypto.randomUUID() }, buyer)
  assert.equal(orderResponse.status, 201)
  const order = (await orderResponse.json()).order
  assert.equal(s.db.prepare('SELECT cost_cents FROM orders WHERE id=?').get(order.id)!.cost_cents, 10500)
})

test('invalid, incomplete and stale default price submissions cannot change any price', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login()
  const settings = await (await s.request(defaultPricesPath, undefined, admin)).json()
  const before = s.db.prepare('SELECT * FROM partner_default_prices ORDER BY plan').all()
  for (const cost of [0, -1, 1.2, 10000001, '11300', null, 14000]) {
    const payload = defaultPricesPayload(settings); (payload.prices[0] as Record<string, unknown>).costCents = cost
    assert.equal((await s.request(defaultPricesPath, payload, admin)).status, 400)
  }
  for (const prices of [null, [], [{ plan: 'plus', costCents: 11300 }], [null, ...defaultPricesPayload(settings).prices.slice(1)]]) {
    assert.equal((await s.request(defaultPricesPath, { version: settings.version, prices }, admin)).status, 400)
  }
  const duplicate = defaultPricesPayload(settings); duplicate.prices[1] = duplicate.prices[0]
  assert.equal((await s.request(defaultPricesPath, duplicate, admin)).status, 400)
  const unknown = defaultPricesPayload(settings); unknown.prices[0].plan = 'unknown'
  assert.equal((await s.request(defaultPricesPath, unknown, admin)).status, 400)
  assert.equal((await s.request(defaultPricesPath, { ...defaultPricesPayload(settings), version: '0' }, admin)).status, 400)
  const staleCatalog = defaultPricesPayload(settings); staleCatalog.prices[0].catalogVersion++
  assert.equal((await s.request(defaultPricesPath, staleCatalog, admin)).status, 409)
  assert.deepEqual(s.db.prepare('SELECT * FROM partner_default_prices ORDER BY plan').all(), before)
  assert.equal((await s.request(defaultPricesPath, defaultPricesPayload(settings), admin)).status, 200)
  assert.equal((await s.request(defaultPricesPath, defaultPricesPayload(settings, { ...defaultCosts, plus: 10000 }), admin)).status, 409)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM admin_audit WHERE action=?').get('partner-default-prices')!.n, 1)
})

test('concurrent default saves select one complete set, and catalog races leave all defaults untouched', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login()
  const settings = await (await s.request(defaultPricesPath, undefined, admin)).json()
  const a = defaultPricesPayload(settings); const b = defaultPricesPayload(settings, { plus: 9900, 'pro-5x': 60000, 'pro-20x': 100000, 'pro-25x': 330000, 'codex-sms-once': 300 })
  const results = await Promise.all([s.request(defaultPricesPath, a, admin), s.request(defaultPricesPath, b, admin)])
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409])
  const winner = results[0].status === 200 ? a : b
  for (const row of winner.prices) assert.equal(s.db.prepare('SELECT cost_cents FROM partner_default_prices WHERE plan=?').get(row.plan)!.cost_cents, row.costCents)
  const latest = await (await s.request(defaultPricesPath, undefined, admin)).json()
  const before = s.db.prepare('SELECT * FROM partner_default_prices ORDER BY plan').all()
  const batch = s.env.INTEREST_DB.batch.bind(s.env.INTEREST_DB)
  t.mock.method(s.env.INTEREST_DB, 'batch', async (statements: Statement[]) => {
    s.db.exec("UPDATE catalog_plans SET version=version+1 WHERE id='plus'")
    return batch(statements)
  })
  assert.equal((await s.request(defaultPricesPath, defaultPricesPayload(latest), admin)).status, 409)
  assert.deepEqual(s.db.prepare('SELECT * FROM partner_default_prices ORDER BY plan').all(), before)
  assert.equal(s.db.prepare('SELECT version FROM partner_default_price_settings WHERE id=1').get()!.version, settings.version + 1)
})

test('a failed default price audit rolls back settings and all prices', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login()
  const settings = await (await s.request(defaultPricesPath, undefined, admin)).json()
  const before = s.db.prepare('SELECT * FROM partner_default_prices ORDER BY plan').all()
  s.db.exec("CREATE TRIGGER fail_default_audit BEFORE INSERT ON admin_audit WHEN NEW.action='partner-default-prices' BEGIN SELECT RAISE(ABORT,'private database detail'); END")
  const result = await s.request(defaultPricesPath, defaultPricesPayload(settings), admin)
  assert.equal(result.status, 503); assert.doesNotMatch(await result.text(), /private database detail/)
  assert.deepEqual(s.db.prepare('SELECT * FROM partner_default_prices ORDER BY plan').all(), before)
  assert.equal(s.db.prepare('SELECT version FROM partner_default_price_settings WHERE id=1').get()!.version, settings.version)
})

test('existing eight-letter referral codes still resolve prices and attribute new orders', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login()
  const id = await seedPartner(s, admin, 'ABCDEFGH')
  const catalogResponse = await s.request('/api/catalog?partner=ABCDEFGH')
  assert.equal(catalogResponse.status, 200)
  const catalog = await catalogResponse.json()
  assert.equal(catalog.partner.slug, 'ABCDEFGH')
  const buyer = await s.buyer()
  const response = await s.request('/api/orders', { email: 'buyer@example.test', plan: 'plus', expectedPrice: 13900, partner: 'ABCDEFGH', key: crypto.randomUUID() }, buyer)
  assert.equal(response.status, 201)
  const { order } = await response.json()
  assert.equal(s.db.prepare('SELECT partner_id FROM orders WHERE id=?').get(order.id)!.partner_id, id)
})

test('admin order detail identifies the originating partner without exposing source metadata to customers', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login(); const partnerId = await seedPartner(s, admin, 'SOURCE')
  s.db.prepare('INSERT INTO support_contacts(owner,partner_id,wechat,qq,email) VALUES (?,?,?,?,?)').run(partnerId, partnerId, 'source_wechat', '12345678', 'source-help@example.test')
  const buyer = await s.buyer()
  const response = await s.request('/api/orders', { email: 'buyer@example.test', plan: 'plus', expectedPrice: 13900, partner: 'SOURCE', key: crypto.randomUUID() }, buyer)
  assert.equal(response.status, 201)
  const order = (await response.json()).order
  const detail = await (await s.request('/api/admin/orders/' + order.id, undefined, admin)).json()
  assert.deepEqual(detail.order.partnerSource, { id: partnerId, slug: 'SOURCE', name: '玉米伙伴', email: 'source@example.test', wechat: 'source_wechat', qq: '12345678' })
  assert.equal(detail.order.partnerName, '玉米伙伴')
  assert.equal('partnerSource' in order, false)
  const direct = await s.create(buyer, 'plus', 13900)
  const directDetail = await (await s.request('/api/admin/orders/' + direct.id, undefined, admin)).json()
  assert.equal(directDetail.order.partnerSource, null)
})

test('platform support contacts require admin access, persist and expose only explicitly configured public fields', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const empty = { wechat: '', qq: '', email: '' }
  assert.deepEqual((await (await s.request('/api/catalog')).json()).supportContacts, empty)
  assert.equal((await s.request('/api/admin/support-contacts')).status, 401)
  const admin = await s.login()
  const contacts = { wechat: ' recharge_support ', qq: '12345678', email: ' SUPPORT@example.test ' }
  assert.equal((await s.request('/api/admin/support-contacts', { ...contacts, version: 0 }, admin, 'https://evil.test')).status, 403)
  const response = await s.request('/api/admin/support-contacts', { ...contacts, version: 0 }, admin)
  assert.equal(response.status, 200)
  const expected = { contacts: { wechat: 'recharge_support', qq: '12345678', email: 'support@example.test' }, qrMediaIds: { wechat: null, qq: null }, version: 1 }
  assert.deepEqual(await response.json(), expected)
  assert.deepEqual(await (await s.request('/api/admin/support-contacts', undefined, admin)).json(), expected)
  const catalogResponse = await s.request('/api/catalog')
  assert.equal(catalogResponse.headers.get('Cache-Control'), 'no-store')
  assert.deepEqual((await catalogResponse.json()).supportContacts, expected.contacts)
  assert.equal((await s.request('/api/admin/support-contacts', { ...empty, version: 0 }, admin)).status, 409)
  assert.equal((await s.request('/api/admin/support-contacts', { ...empty, version: 1 }, admin)).status, 200)
  assert.deepEqual((await (await s.request('/api/catalog')).json()).supportContacts, empty)
})

test('contact QR uploads require shop access and appear only on the owning storefront until removed', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/tc8AAAAASUVORK5CYII='
  const image = 'data:image/png;base64,' + png
  assert.equal((await s.request('/api/admin/support-contacts/media', { image })).status, 401)
  assert.equal((await s.request('/api/partner/support-contacts/media', { image })).status, 401)
  const admin = await s.login()
  assert.equal((await s.request('/api/admin/support-contacts/media', { image }, admin, 'https://evil.test')).status, 403)
  assert.equal((await s.request('/api/admin/support-contacts/media', { image: 'data:image/png;base64,' + 'A'.repeat(80) }, admin)).status, 400)
  const uploaded = await s.request('/api/admin/support-contacts/media', { image }, admin)
  assert.equal(uploaded.status, 201)
  const media = await uploaded.json()
  assert.match(media.url, /^\/api\/direct-media\/[a-f0-9-]{36}$/)
  const publicImage = await s.request(media.url)
  assert.equal(publicImage.status, 200)
  assert.equal(publicImage.headers.get('Content-Type'), 'image/png')
  assert.deepEqual(Buffer.from(await publicImage.arrayBuffer()), Buffer.from(png, 'base64'))
  assert.equal((await s.request('/api/admin/support-contacts', { wechat: '', qq: '', email: '', wechatQrMediaId: 'missing', version: 0 }, admin)).status, 400)
  const saved = await s.request('/api/admin/support-contacts', { wechat: '', qq: '', email: '', wechatQrMediaId: media.id, version: 0 }, admin)
  assert.equal(saved.status, 200)
  assert.deepEqual(await saved.json(), { contacts: { wechat: '', qq: '', email: '', wechatQrUrl: media.url }, qrMediaIds: { wechat: media.id, qq: null }, version: 1 })
  assert.deepEqual((await (await s.request('/api/catalog')).json()).supportContacts, { wechat: '', qq: '', email: '', wechatQrUrl: media.url })
  assert.equal((await s.request('/api/admin/support-contacts', { wechat: 'help', qq: '', email: '', version: 1 }, admin)).status, 200)
  assert.equal((await (await s.request('/api/catalog')).json()).supportContacts.wechatQrUrl, media.url)
  assert.equal((await s.request('/api/admin/support-contacts', { wechat: 'help', qq: '', email: '', wechatQrMediaId: null, version: 2 }, admin)).status, 200)
  assert.deepEqual((await (await s.request('/api/catalog')).json()).supportContacts, { wechat: 'help', qq: '', email: '' })
})

test('partner can upload and manage its own contact QR without changing platform contacts', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login()
  const first = await seedPartner(s, admin, 'ABCDEF')
  const own = await mockPartnerMail(t, s).login('ABCDEF@example.test')
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/tc8AAAAASUVORK5CYII='
  const uploaded = await s.request('/api/partner/support-contacts/media', { image }, own)
  assert.equal(uploaded.status, 201)
  const media = await uploaded.json()
  const saved = await s.request('/api/partner/support-contacts', { wechat: '', qq: '12345678', email: '', qqQrMediaId: media.id, version: 0 }, own)
  assert.equal(saved.status, 200)
  assert.deepEqual((await (await s.request('/api/catalog?partner=ABCDEF')).json()).supportContacts, { wechat: '', qq: '12345678', email: '', qqQrUrl: media.url })
  assert.deepEqual((await (await s.request('/api/catalog')).json()).supportContacts, { wechat: '', qq: '', email: '' })
  const preview = await (await s.request('/api/admin/partners/' + first + '/support-contacts', undefined, admin)).json()
  assert.equal(preview.qrMediaIds.qq, media.id)
  assert.equal(preview.contacts.qqQrUrl, media.url)
})

test('partner announcements are private until enabled, isolated by authenticated shop and previewed read-only', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login()
  const first = await seedPartner(s, admin, 'ABCDEF'); const second = await seedPartner(s, admin, 'GHIJKL')
  const mail = mockPartnerMail(t, s); const own = await mail.login('ABCDEF@example.test'); const other = await mail.login('GHIJKL@example.test')
  const path = '/api/partner/announcement'
  const payload = { enabled: true, placement: 'both', title: '服务通知', content: '第一行\n第二行 <script>alert(1)</script>', version: 0 }
  assert.equal((await s.request(path)).status, 401)
  assert.equal((await s.request(path, payload, admin)).status, 401)
  assert.deepEqual(await (await s.request(path, undefined, own)).json(), emptyAnnouncement)
  assert.equal((await (await s.request('/api/catalog?partner=ABCDEF')).json()).announcement, null)
  assert.equal((await s.request(path, payload, own, 'https://evil.test')).status, 403)
  const saved = await s.request(path, { ...payload, partnerId: second }, own)
  assert.equal(saved.status, 200); assert.deepEqual(await saved.json(), { ...payload, version: 1 })
  const catalog = await (await s.request('/api/catalog?partner=ABCDEF')).json()
  assert.deepEqual(catalog.announcement, { ...payload, version: 1 })
  assert.equal('change_id' in catalog.announcement, false); assert.equal('partner_id' in catalog.announcement, false)
  assert.equal((await (await s.request('/api/catalog')).json()).announcement, null)
  assert.equal((await (await s.request('/api/catalog?partner=GHIJKL')).json()).announcement, null)
  assert.deepEqual(await (await s.request(path, undefined, other)).json(), emptyAnnouncement)
  const preview = '/api/admin/partners/' + first + '/announcement'
  assert.equal((await s.request(preview)).status, 401)
  assert.equal((await s.request(preview, undefined, own)).status, 401)
  assert.equal((await s.request(preview, payload, admin)).status, 405)
  assert.deepEqual(await (await s.request(preview, undefined, admin)).json(), { ...payload, version: 1 })
  assert.equal((await s.request(path, { ...payload, enabled: false, version: 1 }, own)).status, 200)
  assert.equal((await (await s.request('/api/catalog?partner=ABCDEF')).json()).announcement, null)
  assert.equal((await (await s.request(path, undefined, own)).json()).content, payload.content)
  s.db.prepare('UPDATE partners SET active=0 WHERE id=?').run(first)
  assert.equal((await s.request(path, { ...payload, version: 2 }, own)).status, 401)
  assert.equal((await s.request('/api/catalog?partner=ABCDEF')).status, 404)
})

test('announcement validation and atomic saves prevent invalid content, lost updates and partial audit failures', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login(); const id = await seedPartner(s, admin, 'ABCDEF')
  const own = await mockPartnerMail(t, s).login('ABCDEF@example.test'); const path = '/api/partner/announcement'
  const payload = { enabled: true, placement: 'home', title: '公告', content: '服务通知', version: 0 }
  for (const change of [{ enabled: 1 }, { placement: 'orders' }, { placement: ['home'] }, { title: ' ' }, { content: '\n' }, { title: null }, { title: '字'.repeat(81) }, { content: '字'.repeat(5001) }, { content: 'bad\u0000text' }, { version: -1 }, { version: '0' }]) {
    assert.equal((await s.request(path, { ...payload, ...change }, own)).status, 400)
  }
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_announcements').get()!.n, 0)
  const results = await Promise.all([s.request(path, payload, own), s.request(path, { ...payload, title: '并发公告' }, own)])
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409])
  assert.equal((await s.request(path, payload, own)).status, 409)
  const saved = await (await s.request(path, undefined, own)).json()
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='partner-announcement'").get()!.n, 1)
  s.db.exec("CREATE TRIGGER fail_announcement_audit BEFORE INSERT ON admin_audit WHEN NEW.action='partner-announcement' BEGIN SELECT RAISE(ABORT, 'private announcement detail'); END")
  const failed = await s.request(path, { ...payload, version: 1, content: 'changed' }, own)
  assert.equal(failed.status, 503); assert.equal((await failed.text()).includes('private announcement detail'), false)
  assert.deepEqual(await (await s.request(path, undefined, own)).json(), saved)
  s.db.exec('DROP TRIGGER fail_announcement_audit')
  assert.equal((await s.request(path, { ...payload, placement: 'product', version: 1, content: '字'.repeat(5000) }, own)).status, 200)
  assert.equal((await (await s.request('/api/catalog?partner=ABCDEF')).json()).announcement.content.length, 5000)
  // Revocation after authentication but before the transaction must also block saving.
  const batch = s.env.INTEREST_DB.batch.bind(s.env.INTEREST_DB)
  t.mock.method(s.env.INTEREST_DB, 'batch', async statements => { s.db.prepare('UPDATE partners SET auth_version=auth_version+1 WHERE id=?').run(id); return batch(statements) })
  assert.equal((await s.request(path, { ...payload, version: 2 }, own)).status, 409)
  assert.equal(s.db.prepare('SELECT version FROM partner_announcements WHERE partner_id=?').get(id)!.version, 2)
})

test('partner support contacts are separate from login mail and isolated by authenticated shop, including read-only preview', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login()
  const first = await seedPartner(s, admin, 'ABCDEF'); const second = await seedPartner(s, admin, 'GHIJKL')
  const mail = mockPartnerMail(t, s)
  const own = await mail.login('ABCDEF@example.test'); const other = await mail.login('GHIJKL@example.test')
  await s.request('/api/admin/support-contacts', { wechat: 'platform', qq: '', email: 'platform@example.test', version: 0 }, admin)
  const initial = await (await s.request('/api/catalog?partner=ABCDEF')).json()
  assert.deepEqual(initial.supportContacts, { wechat: '', qq: '', email: '' })
  assert.equal(JSON.stringify(initial).includes('abcdef@example.test'), false)
  assert.equal((await s.request('/api/partner/support-contacts')).status, 401)
  const contacts = { wechat: 'agent_help', qq: '87654321', email: 'agent-help@example.test' }
  assert.equal((await s.request('/api/partner/support-contacts', { ...contacts, version: 0 }, own, 'https://evil.test')).status, 403)
  assert.equal((await s.request('/api/partner/support-contacts', { ...contacts, version: 0, owner: second, partnerId: second }, own)).status, 200)
  assert.deepEqual((await (await s.request('/api/catalog?partner=ABCDEF')).json()).supportContacts, contacts)
  assert.deepEqual((await (await s.request('/api/catalog?partner=GHIJKL')).json()).supportContacts, { wechat: '', qq: '', email: '' })
  assert.deepEqual((await (await s.request('/api/partner/support-contacts', undefined, other)).json()).contacts, { wechat: '', qq: '', email: '' })
  const preview = '/api/admin/partners/' + first + '/support-contacts'
  assert.equal((await s.request(preview)).status, 401)
  assert.equal((await s.request(preview, { ...contacts, version: 1 }, admin)).status, 405)
  assert.deepEqual((await (await s.request(preview, undefined, admin)).json()).contacts, contacts)
  s.db.prepare('UPDATE partners SET active=0 WHERE id=?').run(first)
  assert.equal((await s.request('/api/partner/support-contacts', { ...contacts, version: 1 }, own)).status, 401)
  assert.equal((await s.request('/api/catalog?partner=ABCDEF')).status, 404)
})

test('customer orders resolve support contacts from their own shop across creation, history, actions and contact changes', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login()
  const first = await seedPartner(s, admin, 'ABCDEF'); const second = await seedPartner(s, admin, 'GHIJKL'); await seedPartner(s, admin, 'MNOPQR')
  const empty = { wechat: '', qq: '', email: '' }
  const platform = { wechat: 'platform_help', qq: '12345678', email: 'platform-help@example.test' }
  const firstContacts = { wechat: 'agent_one', qq: '23456789', email: 'first-help@example.test' }
  const secondContacts = { wechat: 'agent_two', qq: '34567890', email: 'second-help@example.test' }
  assert.equal((await s.request('/api/admin/support-contacts', { ...platform, version: 0 }, admin)).status, 200)
  for (const [id, contacts] of [[first, firstContacts], [second, secondContacts]] as const) s.db.prepare('INSERT INTO support_contacts(owner,partner_id,wechat,qq,email) VALUES (?,?,?,?,?)').run(id, id, contacts.wechat, contacts.qq, contacts.email)
  const buyer = await s.buyer(); const direct = await s.create(buyer)
  assert.deepEqual(direct.supportContacts, platform)
  const expected = new Map([[direct.id, platform]])
  let firstOrder: { id: string; version: number } | undefined
  for (const [slug, contacts] of [['ABCDEF', firstContacts], ['GHIJKL', secondContacts], ['MNOPQR', empty]] as const) {
    const response = await s.request('/api/orders', { email: 'buyer@example.test', plan: 'plus', expectedPrice: 13900, key: crypto.randomUUID(), partner: slug }, buyer)
    assert.equal(response.status, 201)
    const { order } = await response.json()
    assert.deepEqual(order.supportContacts, contacts); assert.equal(order.customerEmail, 'buyer@example.test')
    expected.set(order.id, contacts)
    if (slug === 'ABCDEF') firstOrder = order
  }
  const history = await (await s.request('/api/orders?partner=GHIJKL', undefined, buyer)).json()
  assert.equal(history.orders.length, 4)
  for (const order of history.orders) assert.deepEqual(order.supportContacts, expected.get(order.id))
  const detail = await (await s.request('/api/orders/' + firstOrder!.id + '?partner=GHIJKL', undefined, buyer)).json()
  assert.deepEqual(detail.order.supportContacts, firstContacts)
  assert.equal('partner_id' in detail.order, false)
  const paid = await (await s.request('/api/orders/' + firstOrder!.id + '/demo-actions', { action: 'pay', version: firstOrder!.version }, buyer)).json()
  assert.deepEqual(paid.order.supportContacts, firstContacts)
  s.db.prepare('UPDATE support_contacts SET email=?,version=version+1 WHERE owner=?').run('updated-help@example.test', first)
  s.db.prepare('UPDATE partners SET active=0 WHERE id=?').run(first)
  const updated = await (await s.request('/api/orders/' + firstOrder!.id, undefined, buyer)).json()
  assert.deepEqual(updated.order.supportContacts, { ...firstContacts, email: 'updated-help@example.test' })
  assert.equal(updated.order.customerEmail, 'buyer@example.test')
  const stranger = await s.buyer()
  assert.equal((await s.request('/api/orders/' + firstOrder!.id, undefined, stranger)).status, 404)
})

test('support contact validation, concurrent updates and audit failures cannot overwrite newer or partially saved settings', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login()
  const contacts = { wechat: 'recharge_help', qq: '12345678', email: 'support@example.test', version: 0 }
  for (const change of [{ wechat: 'x'.repeat(65) }, { qq: 'not-a-number' }, { email: 'invalid' }, { email: 'help@example.test\n' }, { wechat: null }, { version: -1 }]) {
    assert.equal((await s.request('/api/admin/support-contacts', { ...contacts, ...change }, admin)).status, 400)
  }
  const results = await Promise.all([s.request('/api/admin/support-contacts', contacts, admin), s.request('/api/admin/support-contacts', { ...contacts, wechat: 'other_help' }, admin)])
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409])
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='support-contacts'").get()!.n, 1)
  const saved = await (await s.request('/api/admin/support-contacts', undefined, admin)).json()
  s.db.exec("CREATE TRIGGER fail_contact_audit BEFORE INSERT ON admin_audit WHEN NEW.action='support-contacts' BEGIN SELECT RAISE(ABORT, 'private database detail'); END")
  const failed = await s.request('/api/admin/support-contacts', { ...contacts, version: 1, wechat: 'changed' }, admin)
  assert.equal(failed.status, 503)
  assert.equal((await failed.text()).includes('private database detail'), false)
  assert.deepEqual(await (await s.request('/api/admin/support-contacts', undefined, admin)).json(), saved)
})

test('opening and invitation retry report mail failures without losing or duplicating accounts', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login()
  const payload = { email: 'new@example.test' }
  assert.equal((await s.request('/api/admin/partners', payload, admin)).status, 503)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partners').get()!.n, 0)
  const mail = mockPartnerMail(t, s)
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 500 }))
  const failed = await s.request('/api/admin/partners', payload, admin)
  assert.equal(failed.status, 201)
  const result = await failed.json(); assert.equal(result.invitationSent, false); assert.match(result.message, /发送失败/)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partners').get()!.n, 1)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_login_codes').get()!.n, 0)
  const path = '/api/admin/partners/' + result.id + '/invitation'
  assert.equal((await s.request(path, {})).status, 401)
  assert.equal((await s.request(path, {}, admin, 'https://evil.test')).status, 403)
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => { mail.mails.push(JSON.parse(String(options.body))); return Response.json({ id: 'test-mail' }) })
  assert.equal((await s.request(path, {}, admin)).status, 200)
  assert.equal((await s.request(path, {}, admin)).status, 429)
  assert.equal(s.db.prepare('SELECT slug FROM partners WHERE id=?').get(result.id)!.slug, result.slug)
  assert.doesNotMatch(mail.mails.at(-1)!.text, /\b\d{6}\b|10 分钟/)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_login_codes').get()!.n, 0)
  const { code } = await mail.send(payload.email)
  assert.equal((await s.request('/api/partner/auth/verify', { email: 'other@example.test', code })).status, 401)
  assert.equal((await s.request('/api/partner/auth/verify', { email: payload.email, code })).status, 200)
  s.db.exec('UPDATE partner_login_codes SET expires_at=0,used=0')
  assert.equal((await s.request('/api/partner/auth/verify', { email: payload.email, code })).status, 401)
  s.db.exec('UPDATE partners SET active=0')
  assert.equal((await s.request(path, {}, admin)).status, 409)
})

test('resending an invitation neither creates nor invalidates a login code requested by the partner', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login()
  const id = await seedPartner(s, admin); const mail = mockPartnerMail(t, s)
  const data = await mail.send()
  const before = s.db.prepare('SELECT * FROM partner_login_codes').get()
  const path = '/api/admin/partners/' + id + '/invitation'
  assert.equal((await s.request(path, {}, admin)).status, 200)
  assert.doesNotMatch(mail.mails.at(-1)!.text, /\b\d{6}\b/)
  assert.deepEqual(s.db.prepare('SELECT * FROM partner_login_codes').get(), before)
  assert.equal((await s.request('/api/partner/auth/verify', data)).status, 200)
})

test('referral codes include digits and discard biased bytes', t => {
  t.mock.method(crypto, 'getRandomValues', (array: Uint8Array) => {
    array.set([252, 253, 254, 255, 0, 26, 1, 27, 2, 35])
    return array
  })
  assert.equal(generateReferralCode(), 'A0B1C9')
})

test('generated referral collisions retry and concurrent openings cannot duplicate an email', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login(); const mail = mockPartnerMail(t, s)
  await seedPartner(s, admin, 'AAAAAA')
  const random = crypto.getRandomValues.bind(crypto); let calls = 0
  t.mock.method(crypto, 'getRandomValues', (array: Uint8Array | Uint32Array) => {
    if (array instanceof Uint8Array && calls++ === 0) { array.fill(0); return array }
    return random(array)
  })
  const response = await s.request('/api/admin/partners', { email: 'collision@example.test', name: 'ignored', slug: 'ignored', prices: [] }, admin)
  assert.equal(response.status, 201)
  const result = await response.json(); assert.notEqual(result.slug, 'AAAAAA'); assert.match(result.slug, /^[A-Z0-9]{6}$/)
  assert.equal(s.db.prepare('SELECT name FROM partners WHERE id=?').get(result.id)!.name, '代理商店')
  const payload = { email: 'race@example.test' }
  const results = await Promise.all([s.request('/api/admin/partners', payload, admin), s.request('/api/admin/partners', payload, admin)])
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409])
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partners WHERE email=?').get(payload.email)!.n, 1)
  assert.equal(mail.mails.filter(m => m.to[0] === payload.email).length, 1)
})

test('partner email login is single use, private, limited and revoked after disable or email change', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login(); const id = await seedPartner(s, admin)
  assert.equal((await s.request('/api/admin/partners')).status, 401)
  assert.equal((await s.request('/api/partner/dashboard')).status, 401)
  assert.equal((await s.request('/api/partner/auth/send', { email: 'corn-shop@example.test' })).status, 503)
  const mail = mockPartnerMail(t, s); const data = await mail.send()
  assert.equal((await s.request('/api/partner/auth/verify', data, '', 'https://evil.test')).status, 403)
  const [a,b] = await Promise.all([s.request('/api/partner/auth/verify', data), s.request('/api/partner/auth/verify', data)])
  assert.deepEqual([a.status,b.status].sort(), [200,401])
  const cookie = (a.status === 200 ? a : b).headers.get('set-cookie')!.split(';')[0]
  assert.equal((await s.request('/api/partner/dashboard', undefined, cookie)).status, 200)
  assert.equal((await s.request('/api/admin/partners', undefined, cookie)).status, 401)
  assert.equal((await s.request('/api/admin/partners/' + id + '/preview', undefined, cookie)).status, 401)
  assert.equal((await s.request('/api/partner/auth/send', { email: 'corn-shop@example.test' })).status, 429)
  const unknown = await s.request('/api/partner/auth/send', { email: 'unknown@example.test' }); assert.equal(unknown.status, 200); assert.equal(mail.mails.length, 1)
  assert.equal((await s.request('/api/admin/partners/' + id, { name: '新名称', email: 'corn-shop@example.test', active: false, version: 0 }, admin)).status, 200)
  assert.equal((await s.request('/api/partner/dashboard', undefined, cookie)).status, 401)
  assert.equal((await s.request('/api/catalog?partner=corn-shop')).status, 404)
  assert.equal((await s.request('/api/admin/partners/' + id, { name: '新名称', email: 'changed@example.test', active: true, version: 1 }, admin)).status, 200)
  assert.equal((await s.request('/api/partner/dashboard', undefined, cookie)).status, 401)
  const changed = await mail.login('changed@example.test')
  assert.equal((await s.request('/api/partner/auth/logout', {}, changed)).status, 200)
  assert.equal((await s.request('/api/partner/dashboard', undefined, changed)).status, 401)
})

test('email codes expire, stop after five guesses and fail closed on provider failure', async t => {
  const s = await setup(); t.after(() => s.db.close()); await seedPartner(s, await s.login()); const mail = mockPartnerMail(t, s)
  const data = await mail.send()
  for (let i = 0; i < 5; i++) assert.equal((await s.request('/api/partner/auth/verify', { ...data, code: data.code === '000000' ? '000001' : '000000' })).status, 401)
  assert.equal((await s.request('/api/partner/auth/verify', data)).status, 401)
  s.db.exec('DELETE FROM admin_login_limits')
  const expired = await mail.send(); s.db.exec('UPDATE partner_login_codes SET expires_at=0')
  assert.equal((await s.request('/api/partner/auth/verify', expired)).status, 401)
  s.db.exec('DELETE FROM admin_login_limits')
  t.mock.method(globalThis, 'fetch', async () => new Response('provider error', { status: 500 }))
  assert.equal((await s.request('/api/partner/auth/send', { email: 'corn-shop@example.test' })).status, 503)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_login_codes').get()!.n, 0)
})

test('partner shops enforce prices, ownership, snapshots and idempotency without exposing cost to customers', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login(); const id = await seedPartner(s, admin); const otherId = await seedPartner(s, admin, 'another-shop'); const mail = mockPartnerMail(t, s); const cookie = await mail.login()
  assert.equal((await s.request('/api/partner/prices/plus', { priceCents: 9999, version: 0 }, cookie)).status, 400)
  assert.equal((await s.request('/api/partner/prices/plus', { priceCents: 12900, version: 0 }, cookie)).status, 200)
  assert.equal((await s.request('/api/partner/prices/plus', { priceCents: 13000, version: 0 }, cookie)).status, 409)
  const catalog = await (await s.request('/api/catalog?partner=corn-shop')).json()
  assert.equal(catalog.plans[0].price_cents, 12900); assert.equal('cost_cents' in catalog.plans[0], false); assert.equal('email' in catalog.partner, false)
  const buyer = await s.buyer(); const key = crypto.randomUUID(); const payload = { email: 'buyer@example.test', plan: 'plus', expectedPrice: 12900, partner: 'corn-shop', key }
  assert.equal((await s.request('/api/orders', { email: 'buyer@example.test', ...payload, expectedPrice: 10000 }, buyer)).status, 409)
  const created = await s.request('/api/orders', payload, buyer); assert.equal(created.status, 201); const order = (await created.json()).order
  assert.equal(order.partnerName, '玉米伙伴'); assert.equal('cost_cents' in order, false)
  assert.equal((await (await s.request('/api/orders', payload, buyer)).json()).order.id, order.id)
  assert.equal((await s.request('/api/orders', { email: 'buyer@example.test', ...payload, partner: 'another-shop' }, buyer)).status, 409)
  assert.equal((await s.request('/api/orders', { email: 'buyer@example.test', ...payload, partner: undefined }, buyer)).status, 409)
  const stored = s.db.prepare('SELECT * FROM orders WHERE id=?').get(order.id)!; assert.equal(stored.partner_id, id); assert.equal(stored.cost_cents, 10000)
  assert.equal((await s.request(`/api/admin/partners/${id}/prices/plus`, { costCents: 9500, version: 1 }, admin)).status, 200)
  assert.equal(s.db.prepare('SELECT cost_cents FROM orders WHERE id=?').get(order.id)!.cost_cents, 10000)
  const otherCookie = await mail.login('another-shop@example.test')
  assert.equal((await (await s.request('/api/partner/orders', undefined, otherCookie)).json()).total, 0)
  const rows = (await (await s.request('/api/partner/orders', undefined, cookie)).json()).rows
  assert.equal(rows.length, 1); assert.equal('owner_hash' in rows[0], false); assert.equal('sms_phone' in rows[0], false)
  assert.equal(rows[0].customer_email, 'buyer@example.test')
  assert.equal((await s.request('/api/admin/partners/' + otherId, undefined, cookie)).status, 401)
  assert.equal((await s.request('/api/catalog?partner=nonexistent')).status, 404)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='partner-price'").get()!.n, 1)
})

test('settlement reserves real completed margins once, rejects demo earnings and releases only rejected requests', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login(); const id = await seedPartner(s, admin); const mail = mockPartnerMail(t, s); const cookie = await mail.login(); const buyer = await s.buyer()
  const create = async () => { const r = await s.request('/api/orders', { email: 'buyer@example.test', plan: 'plus', expectedPrice: 13900, partner: 'corn-shop', key: crypto.randomUUID() }, buyer); assert.equal(r.status, 201); return (await r.json()).order.id as string }
  const demo = await create(); s.db.prepare("UPDATE orders SET status='success',payment_status='simulated' WHERE id=?").run(demo)
  assert.equal((await s.request('/api/partner/payouts', { recipient: 'test recipient', key: crypto.randomUUID() }, cookie)).status, 409)
  const live = await create(); s.db.prepare("UPDATE orders SET mode='live',status='success',payment_status='paid' WHERE id=?").run(live)
  const payload = { recipient: 'test recipient', key: crypto.randomUUID() }
  const results = await Promise.all([s.request('/api/partner/payouts', payload, cookie), s.request('/api/partner/payouts', payload, cookie)])
  assert.ok(results.every(r => [200,201].includes(r.status)))
  const ps = s.db.prepare('SELECT * FROM partner_payouts').get()!; assert.equal(ps.amount_cents, 3900); assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_payouts').get()!.n, 1)
  assert.equal((await (await s.request('/api/admin/orders/' + live, undefined, admin)).json()).order.settlementStatus, 'pending')
  assert.equal(s.db.prepare('SELECT payout_id FROM orders WHERE id=?').get(demo)!.payout_id, null)
  assert.equal((await (await s.request('/api/partner/dashboard', undefined, cookie)).json()).stats.available, 0)
  assert.equal((await s.request('/api/partner/payouts', { ...payload, key: crypto.randomUUID() }, cookie)).status, 409)
  assert.equal((await s.request('/api/admin/partner-payouts/' + ps.id, { action: 'rejected', note: '请修正收款信息', version: 0 }, admin)).status, 200)
  assert.equal((await (await s.request('/api/admin/orders/' + live, undefined, admin)).json()).order.settlementStatus, null)
  assert.equal((await (await s.request('/api/partner/dashboard', undefined, cookie)).json()).stats.available, 3900)
  s.db.prepare('UPDATE partner_payouts SET created_at=? WHERE id=?').run(Date.now()-PAYOUT_COOLDOWN_MS, ps.id)
  const next = await s.request('/api/partner/payouts', { ...payload, key: crypto.randomUUID() }, cookie); assert.equal(next.status, 201)
  const ps2 = s.db.prepare("SELECT * FROM partner_payouts WHERE status='pending'").get()!
  assert.equal((await s.request('/api/admin/partner-payouts/' + ps2.id, { action: 'paid', note: '已线下付款', reference: '', version: 0 }, admin)).status, 400)
  assert.equal((await s.request('/api/admin/partner-payouts/' + ps2.id, { action: 'approve', note: '审核通过', version: 0 }, admin)).status, 200)
  const handled = await Promise.all([s.request('/api/admin/partner-payouts/' + ps2.id, { action: 'paid', note: '已线下付款', reference: 'test-reference', version: 1 }, admin), s.request('/api/admin/partner-payouts/' + ps2.id, { action: 'paid', note: '并发重复登记', reference: 'test-reference', version: 1 }, admin)])
  assert.deepEqual(handled.map(r => r.status).sort(), [200,409])
  assert.equal(s.db.prepare('SELECT payout_id FROM orders WHERE id=?').get(live)!.payout_id, ps2.id)
  const adminDetail = await (await s.request('/api/admin/orders/' + live, undefined, admin)).json()
  const adminList = await (await s.request('/api/admin/orders', undefined, admin)).json()
  const partnerList = await (await s.request('/api/partner/orders', undefined, cookie)).json()
  assert.equal(adminDetail.order.settlementStatus, 'paid')
  assert.equal(adminList.orders.find((o: { id: string }) => o.id === live).settlementStatus, 'paid')
  assert.equal(partnerList.rows.find((o: { id: string }) => o.id === live).payout_status, 'paid')
  assert.equal(adminList.orders.find((o: { id: string }) => o.id === demo).settlementStatus, null)
  const dashboard = await (await s.request('/api/partner/dashboard', undefined, cookie)).json(); assert.equal(dashboard.totals.paid, 3900); assert.equal(dashboard.stats.demo_profit, 3900); assert.equal(dashboard.stats.available, 0)
  assert.equal(dashboard.partner.id, id)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_payout_items WHERE order_id=?').get(live)!.n, 2)
  assert.equal((await (await s.request('/api/admin/partner-payouts/' + ps.id, undefined, admin)).json()).items[0].profit_cents, 3900)
})

test('partner reads settle only their due demo orders, once, and admin filtered orders see completed results', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const admin = await s.login(); await seedPartner(s, admin); await seedPartner(s, admin, 'another-shop')
  const mail = mockPartnerMail(t, s); const partner = await mail.login(); const buyer = await s.buyer()
  async function create(slug = 'corn-shop') {
    const r = await s.request('/api/orders', { email: 'buyer@example.test', plan: 'plus', expectedPrice: 13900, partner: slug, key: crypto.randomUUID() }, buyer)
    assert.equal(r.status, 201)
    const id = (await r.json()).order.id
    s.db.prepare("UPDATE orders SET status='processing',payment_status='simulated',outcome='success',started_at=? WHERE id=?").run(Date.now() - 6000, id)
    return id
  }
  const own = await create(); const other = await create('another-shop'); const live = await create(); const fresh = await create(); const failed = await create()
  s.db.prepare("UPDATE orders SET mode='live',payment_status='paid' WHERE id=?").run(live)
  s.db.prepare('UPDATE orders SET started_at=? WHERE id=?').run(Date.now(), fresh)
  s.db.prepare("UPDATE orders SET outcome='failed' WHERE id=?").run(failed)
  const responses = await Promise.all([s.request('/api/partner/orders', undefined, partner), s.request('/api/partner/dashboard', undefined, partner)])
  assert.ok(responses.every(r => r.status === 200))
  const state = (id: string) => s.db.prepare('SELECT status FROM orders WHERE id=?').get(id)!.status
  assert.equal(state(own), 'success'); assert.equal(state(failed), 'failed')
  for (const id of [other, live, fresh]) assert.equal(state(id), 'processing')
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM order_events WHERE order_id=? AND action='demo-settle'").get(own)!.n, 1)
  const dashboard = await responses[1].json(); assert.equal(dashboard.stats.demo_profit, 3900); assert.equal(dashboard.stats.available, 0)
  const filtered = await s.request('/api/admin/orders?status=success', undefined, admin)
  assert.equal(filtered.status, 200); assert.ok((await filtered.json()).orders.some((o: { id: string }) => o.id === other))
  assert.equal(state(live), 'processing')
})

test('concurrent approve and reject preserve exactly one settlement decision and reservation state', async t => {
  const s = await setup(); t.after(() => s.db.close()); const admin = await s.login(); await seedPartner(s, admin)
  const mail = mockPartnerMail(t, s); const partner = await mail.login(); const buyer = await s.buyer()
  const response = await s.request('/api/orders', { email: 'buyer@example.test', plan: 'plus', expectedPrice: 13900, partner: 'corn-shop', key: crypto.randomUUID() }, buyer)
  const order = (await response.json()).order.id
  s.db.prepare("UPDATE orders SET mode='live',status='success',payment_status='paid' WHERE id=?").run(order)
  assert.equal((await s.request('/api/partner/payouts', { recipient: 'test recipient', key: crypto.randomUUID() }, partner)).status, 201)
  const payout = s.db.prepare('SELECT * FROM partner_payouts').get()!
  assert.equal((await s.request('/api/admin/partner-payouts/' + payout.id, { action: 'approve', note: '审核通过', version: 0 }, admin)).status, 200)
  const results = await Promise.all(['paid', 'rejected'].map(action => s.request('/api/admin/partner-payouts/' + payout.id, { action, note: 'race test', reference: 'test-only', version: 1 }, admin)))
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409])
  const stored = s.db.prepare('SELECT * FROM partner_payouts').get()!
  assert.equal(stored.status, results[0].status === 200 ? 'paid' : 'rejected')
  assert.equal(s.db.prepare('SELECT payout_id FROM orders WHERE id=?').get(order)!.payout_id, stored.status === 'paid' ? payout.id : null)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='payout-handle'").get()!.n, 1)
  assert.equal(s.db.prepare('SELECT SUM(profit_cents) n FROM partner_payout_items WHERE payout_id=?').get(payout.id)!.n, stored.amount_cents)
})

test('mandatory email and verified recovery isolate orders across devices and revoke on logout', async t => {
  const s = await setup(); t.after(() => s.db.close()); const buyer = await s.buyer(); const other = await s.buyer()
  const payload = { plan:'plus', expectedPrice:13900, key:crypto.randomUUID() }
  for (const email of [undefined, '', 'bad-email']) assert.equal((await s.request('/api/orders', {...payload,email},buyer)).status,400)
  const r = await s.request('/api/orders',{...payload,email:'  Buyer@Example.test  '},buyer); assert.equal(r.status,201)
  const id = (await r.json()).order.id
  assert.equal(s.db.prepare('SELECT customer_email FROM orders WHERE id=?').get(id)!.customer_email,'buyer@example.test')
  assert.equal((await s.request('/api/orders/'+id,undefined,other)).status,404)
  assert.equal((await s.request('/api/orders/recovery/send',{email:'buyer@example.test'})).status,503)
  const mail = mockPartnerMail(t,s)
  const send = await (await s.request('/api/orders/recovery/send',{email:'buyer@example.test'})).json()
  const code = mail.mails[0].text.match(/\b\d{6}\b/)![0]
  assert.equal((await s.request('/api/orders/recovery/verify',{...send,code},other,'https://evil.test')).status,403)
  const verified = await s.request('/api/orders/recovery/verify',{...send,code},other); assert.equal(verified.status,200)
  const cookie = other+'; '+verified.headers.get('set-cookie')!.split(';')[0]
  assert.equal((await s.request('/api/orders/recovery/verify',{...send,code},other)).status,401)
  assert.equal((await s.request('/api/orders/'+id,undefined,cookie)).status,200)
  const list = await (await s.request('/api/orders',undefined,cookie)).json(); assert.equal(list.orders.length,1); assert.equal(list.recoveryEmail,'buyer@example.test')
  const unrelated = await s.request('/api/orders',{...payload,key:crypto.randomUUID(),email:'different@example.test'},buyer)
  const unrelatedId = (await unrelated.json()).order.id
  assert.equal((await s.request('/api/orders/'+unrelatedId,undefined,cookie)).status,404)
  assert.equal((await s.request('/api/orders/recovery/logout',{},cookie)).status,200)
  assert.equal((await s.request('/api/orders/'+id,undefined,cookie)).status,404)
  assert.equal((await s.request('/api/orders/'+id,undefined,buyer)).status,200)
  assert.equal((await s.request('/api/orders/recovery/send',{email:'missing@example.test'})).status,200); assert.equal(mail.mails.length,1)
  s.db.exec('DELETE FROM admin_login_limits')
  const second = await (await s.request('/api/orders/recovery/send',{email:'buyer@example.test'})).json()
  const correct = mail.mails.at(-1)!.text.match(/\b\d{6}\b/)![0]
  for(let i=0;i<5;i++) assert.equal((await s.request('/api/orders/recovery/verify',{...second,code:correct==='000000'?'000001':'000000'})).status,401)
  assert.equal((await s.request('/api/orders/recovery/verify',{...second,code:correct})).status,401)
})

test('refund review freezes delivery, supports cancellation and rejection, and completes once', async t => {
  const s = await setup(); t.after(() => s.db.close()); const buyer=await s.buyer(); const other=await s.buyer(); const admin=await s.login(); const order=await s.create(buyer)
  const path='/api/orders/'+order.id+'/refunds'
  const apply=async()=> { const o=s.db.prepare('SELECT version FROM orders WHERE id=?').get(order.id)!; return s.request(path,{reason:'服务未交付',key:crypto.randomUUID(),version:o.version},buyer) }
  assert.equal((await apply()).status,409)
  await s.request('/api/orders/'+order.id+'/demo-actions',{action:'pay',version:0},buyer)
  assert.equal((await s.request(path,undefined,other)).status,404)
  assert.equal((await apply()).status,201)
  let c=s.db.prepare('SELECT * FROM refund_cases').get()!
  assert.equal((await s.request('/api/orders/'+order.id+'/demo-actions',{action:'submit-success',version:2},buyer)).status,409)
  assert.equal((await s.request(path,{action:'cancel',id:c.id,version:0},buyer)).status,200)
  assert.equal(s.db.prepare('SELECT refund_hold FROM orders WHERE id=?').get(order.id)!.refund_hold,0)
  assert.equal((await apply()).status,201)
  c=s.db.prepare("SELECT * FROM refund_cases WHERE status='pending'").get()!
  assert.equal((await s.request('/api/admin/refunds/'+c.id,{action:'reject',note:'补充信息后重试',version:0},admin)).status,200)
  assert.equal((await apply()).status,201)
  c=s.db.prepare("SELECT * FROM refund_cases WHERE status='pending'").get()!
  assert.equal((await s.request('/api/admin/refunds/'+c.id,{action:'approve',amountCents:100,note:'部分退款',version:0},admin)).status,400)
  assert.equal((await s.request('/api/admin/refunds/'+c.id,{action:'approve',amountCents:13900,note:'同意全额退款',version:0},admin)).status,200)
  assert.equal((await s.request(path,{action:'cancel',id:c.id,version:1},buyer)).status,409)
  const results=await Promise.all([1,2].map(()=>s.request('/api/admin/refunds/'+c.id,{action:'complete',note:'模拟退款成功',version:1},admin)))
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409])
  assert.equal(s.db.prepare('SELECT refunded_cents FROM orders WHERE id=?').get(order.id)!.refunded_cents,13900)
  assert.equal((await apply()).status,409)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM refund_events WHERE case_id=? AND status='refunded'").get(c.id)!.n,1)
})

async function financeFixture(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const s=await setup(); t.after(()=>s.db.close()); const admin=await s.login(); await seedPartner(s,admin); const mail=mockPartnerMail(t,s); const partner=await mail.login(); const buyer=await s.buyer()
  const create=async()=> { const r=await s.request('/api/orders',{email:'buyer@example.test',plan:'plus',expectedPrice:13900,partner:'corn-shop',key:crypto.randomUUID()},buyer); assert.equal(r.status,201); const id=(await r.json()).order.id; s.db.prepare("UPDATE orders SET mode='live',status='success',payment_status='paid' WHERE id=?").run(id); return id as string }
  const payout=()=>s.request('/api/partner/payouts',{recipient:'test account / recipient',key:crypto.randomUUID()},partner)
  const apply=async(id:string)=> { const o=s.db.prepare('SELECT version FROM orders WHERE id=?').get(id)!; const r=await s.request('/api/orders/'+id+'/refunds',{reason:'申请退款',key:crypto.randomUUID(),version:o.version},buyer); assert.equal(r.status,201,await r.clone().text()); return s.db.prepare("SELECT * FROM refund_cases WHERE order_id=? AND status='pending'").get(id)! }
  const review=async(id:unknown,amount:number)=>{const r=await s.request('/api/admin/refunds/'+id,{action:'approve',amountCents:amount,note:'审核同意',version:0},admin); assert.equal(r.status,200,await r.clone().text())}
  const complete=(id:unknown)=>s.request('/api/admin/refunds/'+id,{action:'complete',reference:'TEST-REFUND',note:'已核实退款到账',version:1},admin)
  return {...s,admin,partner,buyer,create,payout,apply,review,complete}
}

test('unsettled external refunds and unfinished orders do not block payout of unrelated completed earnings', async t => {
  const s = await financeFixture(t)
  const heldIds: string[] = []
  for (const status of ['session', 'failed', 'success']) {
    const id = await s.create(); heldIds.push(id)
    s.db.prepare('UPDATE orders SET status=? WHERE id=?').run(status, id)
    s.db.prepare("INSERT INTO recharge_orders(order_id,account,product_code,collection_mode,create_body,remote_id,payment_status,updated_at,refunded_cents,merchant_margin_cents,financial_hold) VALUES (?,'test','plus','platform_collect','{}',?,'refunded',?,13900,0,1)").run(id, 'refund-' + id, Date.now())
  }
  const incomplete = await s.create(); s.db.prepare("UPDATE orders SET status='processing' WHERE id=?").run(incomplete)
  const refunded = await s.create(); s.db.prepare('UPDATE orders SET refunded_cents=price_cents WHERE id=?').run(refunded)
  const healthy = await s.create()
  const expected = s.db.prepare('SELECT price_cents-cost_cents profit FROM orders WHERE id=?').get(healthy)!.profit
  const snapshot = s.db.prepare('SELECT * FROM recharge_orders ORDER BY order_id').all()
  const dashboard = (await (await s.request('/api/partner/dashboard', undefined, s.partner)).json()).stats
  assert.equal(dashboard.available, expected); assert.equal(dashboard.withdrawalHeld, false)
  // Frozen completed orders must not require a supplier request to withdraw other earnings.
  // This fixture deliberately has no supplier credentials.
  assert.equal((await s.payout()).status, 201)
  const payout = s.db.prepare('SELECT * FROM partner_payouts').get()!
  assert.equal(payout.amount_cents, expected)
  assert.deepEqual(s.db.prepare('SELECT order_id FROM partner_payout_items').all().map(row => row.order_id), [healthy])
  assert.equal((await s.request('/api/admin/partner-payouts/' + payout.id, { action: 'approve', version: 0, note: '仅审核正常完成订单收益' }, s.admin)).status, 200)
  assert.deepEqual(s.db.prepare('SELECT * FROM recharge_orders ORDER BY order_id').all(), snapshot)
  for (const id of [...heldIds, incomplete, refunded]) assert.equal(s.db.prepare('SELECT payout_id FROM orders WHERE id=?').get(id)!.payout_id, null)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_debits').get()!.n, 0)
})

test('unmatched refunds on paid commissions still block new payouts and approval of unrelated pending earnings', async t => {
  const s = await financeFixture(t); const paidOrder = await s.create()
  assert.equal((await s.payout()).status, 201)
  const paid = s.db.prepare('SELECT * FROM partner_payouts').get()!
  const paidPath = '/api/admin/partner-payouts/' + paid.id
  assert.equal((await s.request(paidPath, { action: 'approve', version: 0, note: '测试审核' }, s.admin)).status, 200)
  assert.equal((await s.request(paidPath, { action: 'paid', version: 1, note: '测试登记', reference: 'TEST-ONLY' }, s.admin)).status, 200)
  s.db.prepare('UPDATE partner_payouts SET cooldown_exempt=1 WHERE id=?').run(paid.id)
  await s.create(); assert.equal((await s.payout()).status, 201)
  const pending = s.db.prepare("SELECT * FROM partner_payouts WHERE status='pending'").get()!
  s.db.prepare("INSERT INTO recharge_orders(order_id,account,product_code,collection_mode,create_body,remote_id,payment_status,updated_at,refunded_cents,merchant_margin_cents,financial_hold) VALUES (?,'test','plus','platform_collect','{}','paid-refund','refunded',?,13900,0,1)").run(paidOrder, Date.now())
  const dashboard = (await (await s.request('/api/partner/dashboard', undefined, s.partner)).json()).stats
  assert.equal(dashboard.withdrawalHeld, true)
  const pendingPath = '/api/admin/partner-payouts/' + pending.id
  assert.equal((await s.request(pendingPath, { action: 'approve', version: 0, note: '应阻止未核对已付佣金' }, s.admin)).status, 409)
  assert.equal((await s.request(pendingPath, { action: 'rejected', version: 0, note: '先核对历史佣金' }, s.admin)).status, 200)
  s.db.prepare('UPDATE partner_payouts SET cooldown_exempt=1').run()
  assert.equal((await s.payout()).status, 409)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_payouts').get()!.n, 2)
})

test('minimum withdrawal is 10 yuan and concurrent reviews reserve exactly one audit', async t=>{
  const s=await financeFixture(t); const id=await s.create()
  s.db.prepare('UPDATE orders SET cost_cents=12901 WHERE id=?').run(id)
  assert.equal((await s.payout()).status,409)
  s.db.prepare('UPDATE orders SET cost_cents=12900 WHERE id=?').run(id)
  assert.equal((await s.payout()).status,201)
  const p=s.db.prepare('SELECT * FROM partner_payouts').get()!
  assert.equal(p.amount_cents,1000)
  const path='/api/admin/partner-payouts/'+p.id
  assert.equal((await s.request(path,{action:'paid',note:'未审核',reference:'TEST',version:0},s.admin)).status,409)
  const results=await Promise.all([1,2].map(()=>s.request(path,{action:'approve',note:'通过',version:0},s.admin)))
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409])
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='payout-review'").get()!.n,1)
})

test('withdrawals enforce a 24-hour cooldown atomically, preserve retries and include returned requests', async t => {
  const s = await financeFixture(t); await s.create()
  const now = Date.now(); t.mock.method(Date, 'now', () => now)
  const cooldownMs = 24 * 60 * 60 * 1000
  let dashboard = (await (await s.request('/api/partner/dashboard', undefined, s.partner)).json()).stats
  assert.equal(dashboard.minimum, 1000); assert.equal(dashboard.nextPayoutAt, null); assert.equal(dashboard.payoutCoolingDown, false)
  const payload = { recipient: 'test account / recipient', key: crypto.randomUUID() }
  assert.equal((await s.request('/api/partner/payouts', payload, s.partner)).status, 201)
  const payout = s.db.prepare('SELECT * FROM partner_payouts').get()!
  assert.equal((await s.request('/api/partner/payouts', payload, s.partner)).status, 200)
  assert.equal(s.db.prepare('SELECT created_at FROM partner_payouts').get()!.created_at, now)
  dashboard = (await (await s.request('/api/partner/dashboard', undefined, s.partner)).json()).stats
  assert.equal(dashboard.nextPayoutAt, now + cooldownMs); assert.equal(dashboard.payoutCoolingDown, true)
  assert.equal((await s.request('/api/admin/partner-payouts/' + payout.id, { action: 'rejected', note: '修正收款信息', version: 0 }, s.admin)).status, 200)
  assert.equal((await s.payout()).status, 409)
  assert.equal(s.db.prepare('SELECT payout_id FROM orders').get()!.payout_id, null)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='payout-request'").get()!.n, 1)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM payout_notifications').get()!.n, 1)
  s.db.prepare('UPDATE partner_payouts SET created_at=?').run(now - cooldownMs + 1)
  assert.equal((await s.payout()).status, 409)
  dashboard = (await (await s.request('/api/partner/dashboard', undefined, s.partner)).json()).stats
  assert.equal(dashboard.nextPayoutAt, now + 1); assert.equal(dashboard.payoutCoolingDown, true)
  s.db.prepare('UPDATE partner_payouts SET created_at=?').run(now - cooldownMs)
  dashboard = (await (await s.request('/api/partner/dashboard', undefined, s.partner)).json()).stats
  assert.equal(dashboard.nextPayoutAt, now); assert.equal(dashboard.payoutCoolingDown, false)
  const attempts = await Promise.all([s.payout(), s.payout()])
  assert.deepEqual(attempts.map(r => r.status).sort(), [201, 409])
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_payouts').get()!.n, 2)
  assert.equal((await s.request('/api/partner/payouts', payload, s.partner)).status, 200)
})

test('an explicit cooldown reset preserves payout history and the next request starts a new cooldown', async t => {
  const s = await financeFixture(t); await s.create(); assert.equal((await s.payout()).status, 201)
  const payout = s.db.prepare('SELECT * FROM partner_payouts').get()!
  const path = '/api/admin/partner-payouts/' + payout.id
  assert.equal((await s.request(path, { action: 'approve', note: '测试审核', version: 0 }, s.admin)).status, 200)
  assert.equal((await s.request(path, { action: 'paid', note: '测试记账', reference: 'TEST-RESET', version: 1 }, s.admin)).status, 200)
  await s.create()
  assert.equal((await s.payout()).status, 409)
  const original = s.db.prepare('SELECT * FROM partner_payouts WHERE id=?').get(payout.id)!
  const resetPath = '/api/admin/partners/' + payout.partner_id + '/payout-cooldown/reset'
  const reset = { key: crypto.randomUUID(), note: '核对完成，允许重新申请' }
  const resetResponse = await s.request(resetPath, reset, s.admin)
  assert.equal(resetResponse.status, 200)
  assert.deepEqual(await resetResponse.json(), { ok: true, resetPartners: 1, resetPayouts: 1 })
  const unchanged = s.db.prepare('SELECT * FROM partner_payouts WHERE id=?').get(payout.id)!
  assert.deepEqual({ ...unchanged }, { ...original, cooldown_exempt: 1 })
  let stats = (await (await s.request('/api/partner/dashboard', undefined, s.partner)).json()).stats
  assert.equal(stats.nextPayoutAt, null); assert.equal(stats.payoutCoolingDown, false)
  assert.equal((await s.payout()).status, 201)
  const next = s.db.prepare("SELECT * FROM partner_payouts WHERE status='pending'").get()!
  assert.equal(next.cooldown_exempt, 0)
  // Retrying a timed-out reset cannot exempt a subsequent payout.
  assert.equal((await s.request(resetPath, reset, s.admin)).status, 200)
  assert.equal(s.db.prepare('SELECT cooldown_exempt FROM partner_payouts WHERE id=?').get(next.id)!.cooldown_exempt, 0)
  stats = (await (await s.request('/api/partner/dashboard', undefined, s.partner)).json()).stats
  assert.equal(stats.nextPayoutAt, Number(next.created_at) + 24 * 60 * 60 * 1000); assert.equal(stats.payoutCoolingDown, true)
  // Exempting a record does not release its orders or override pending reviews.
  assert.equal((await s.request(resetPath, { ...reset, key: crypto.randomUUID() }, s.admin)).status, 200)
  stats = (await (await s.request('/api/partner/dashboard', undefined, s.partner)).json()).stats
  assert.equal(stats.nextPayoutAt, null); assert.equal(stats.payoutCoolingDown, false)
  await s.create()
  assert.equal((await s.payout()).status, 409)
  assert.equal(s.db.prepare('SELECT payout_id FROM orders WHERE payout_id=?').get(next.id)!.payout_id, next.id)
})

test('reset all cooldowns includes disabled partners across pages and preserves financial records', async t => {
  const s = await financeFixture(t); await s.create(); await s.payout()
  const first = s.db.prepare('SELECT * FROM partner_payouts').get()!
  for (let i = 0; i < 24; i++) {
    const partnerId = await seedPartner(s, s.admin, 'reset-shop-' + i)
    if (i % 2) s.db.prepare('UPDATE partners SET active=0 WHERE id=?').run(partnerId)
    s.db.prepare("INSERT INTO partner_payouts(id,partner_id,amount_cents,status,recipient,created_at,request_key,cooldown_exempt) VALUES (?,?,1200,?,'test recipient',?,?,?)")
      .run(crypto.randomUUID(), partnerId, i % 2 ? 'rejected' : 'paid', Date.now(), crypto.randomUUID(), Number(i === 0))
  }
  const snapshot = () => [
    s.db.prepare('SELECT * FROM partner_payouts ORDER BY id').all(),
    s.db.prepare('SELECT * FROM orders ORDER BY id').all(),
    s.db.prepare('SELECT * FROM partner_payout_items ORDER BY payout_id,order_id').all(),
    s.db.prepare('SELECT * FROM partner_debits ORDER BY id').all(),
    s.db.prepare('SELECT * FROM partners ORDER BY id').all(),
  ]
  const before = snapshot()
  const path = '/api/admin/partners/payout-cooldown/reset', payload = { key: crypto.randomUUID(), note: '所有代理已核对' }
  const responses = await Promise.all([s.request(path, payload, s.admin), s.request(path, payload, s.admin)])
  for (const response of responses) {
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, resetPartners: 24, resetPayouts: 24 })
  }
  const after = snapshot()
  assert.deepEqual(after[0].map(p => ({ ...p })), before[0].map(p => ({ ...p, cooldown_exempt: 1 })))
  assert.deepEqual(after.slice(1), before.slice(1))
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='payout-cooldown-reset-all'").get()!.n, 1)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='payout-cooldown-reset'").get()!.n, 24)
  assert.equal((await s.payout()).status, 409, 'A pending application still blocks another application')
  const laterPartner = await seedPartner(s, s.admin, 'reset-later')
  const laterPayout = crypto.randomUUID()
  s.db.prepare("INSERT INTO partner_payouts(id,partner_id,amount_cents,status,recipient,created_at,request_key) VALUES (?,?,1200,'paid','test recipient',?,?)")
    .run(laterPayout, laterPartner, Date.now(), crypto.randomUUID())
  assert.equal((await s.request(path, payload, s.admin)).status, 200)
  assert.equal(s.db.prepare('SELECT cooldown_exempt FROM partner_payouts WHERE id=?').get(laterPayout)!.cooldown_exempt, 0)
  assert.equal((await s.request('/api/admin/partners/' + first.partner_id + '/payout-cooldown/reset', payload, s.admin)).status, 409)
})

test('single cooldown reset is scoped, admin-only, validates inputs and rolls back its audit on failure', async t => {
  const s = await financeFixture(t); await s.create(); await s.payout()
  const payout = s.db.prepare('SELECT * FROM partner_payouts').get()!
  const otherPartner = await seedPartner(s, s.admin, 'reset-other')
  const otherPayout = crypto.randomUUID()
  s.db.prepare("INSERT INTO partner_payouts(id,partner_id,amount_cents,status,recipient,created_at,request_key) VALUES (?,?,1200,'paid','test recipient',?,?)")
    .run(otherPayout, otherPartner, Date.now(), crypto.randomUUID())
  const path = '/api/admin/partners/' + payout.partner_id + '/payout-cooldown/reset'
  const allPath = '/api/admin/partners/payout-cooldown/reset'
  const payload = { key: crypto.randomUUID(), note: '只重置指定代理' }
  for (const endpoint of [path, allPath]) {
    assert.equal((await s.request(endpoint, payload)).status, 401)
    assert.equal((await s.request(endpoint, payload, s.partner)).status, 401)
    assert.equal((await s.request(endpoint, payload, s.admin, 'https://evil.test')).status, 403)
    assert.equal((await s.request(endpoint, undefined, s.admin)).status, 405)
    for (const invalid of [{ ...payload, key: 'bad' }, { ...payload, note: '' }, { ...payload, note: 'x'.repeat(501) }]) {
      assert.equal((await s.request(endpoint, invalid, s.admin)).status, 400)
    }
  }
  assert.equal((await s.request('/api/admin/partners/' + crypto.randomUUID() + '/payout-cooldown/reset', payload, s.admin)).status, 404)
  const original = s.db.prepare('SELECT * FROM partner_payouts WHERE id=?').get(payout.id)!
  s.db.exec("CREATE TRIGGER fail_cooldown_reset BEFORE UPDATE OF cooldown_exempt ON partner_payouts BEGIN SELECT RAISE(ABORT,'test reset failure'); END")
  assert.equal((await s.request(path, payload, s.admin)).status, 503)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM admin_audit WHERE id=? OR id LIKE ?').get(payload.key, payload.key + ':%')!.n, 0)
  assert.deepEqual(s.db.prepare('SELECT * FROM partner_payouts WHERE id=?').get(payout.id), original)
  s.db.exec('DROP TRIGGER fail_cooldown_reset')
  const response = await s.request(path, payload, s.admin)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, resetPartners: 1, resetPayouts: 1 })
  assert.equal(s.db.prepare('SELECT cooldown_exempt FROM partner_payouts WHERE id=?').get(otherPayout)!.cooldown_exempt, 0)
  assert.equal((await s.request('/api/admin/partners/' + otherPartner + '/payout-cooldown/reset', payload, s.admin)).status, 409)
  const noOp = await s.request(path, { ...payload, key: crypto.randomUUID() }, s.admin)
  assert.deepEqual(await noOp.json(), { ok: true, resetPartners: 0, resetPayouts: 0 })
})

test('unreviewed payout is returned on refund; partial refunds recalculate margin and preserve snapshots', async t=>{
  const s=await financeFixture(t); const first=await s.create(); const second=await s.create()
  assert.equal((await s.payout()).status,201)
  const p=s.db.prepare('SELECT * FROM partner_payouts').get()!
  const c=await s.apply(first)
  assert.equal(s.db.prepare('SELECT status FROM partner_payouts WHERE id=?').get(p.id)!.status,'rejected')
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM orders WHERE payout_id IS NOT NULL').get()!.n,0)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_payout_items WHERE payout_id=?').get(p.id)!.n,2)
  await s.review(c.id,6950); assert.equal((await s.complete(c.id)).status,200)
  const dashboard=await (await s.request('/api/partner/dashboard',undefined,s.partner)).json(); assert.equal(dashboard.stats.available,5850)
  s.db.prepare('UPDATE partner_payouts SET created_at=? WHERE id=?').run(Date.now()-PAYOUT_COOLDOWN_MS, p.id)
  assert.equal((await s.payout()).status,201)
  const next=s.db.prepare("SELECT * FROM partner_payouts WHERE status='pending'").get()!; assert.equal(next.amount_cents,5850)
  const c2=await s.apply(second); await s.review(c2.id,13900); assert.equal((await s.complete(c2.id)).status,200)
  assert.equal((await s.payout()).status,409)
})

test('reviewed transfers must reconcile before refund, paid commissions become a single future deduction', async t=>{
  const s=await financeFixture(t); const first=await s.create(); await s.payout(); const p=s.db.prepare('SELECT * FROM partner_payouts').get()!
  const path='/api/admin/partner-payouts/'+p.id
  assert.equal((await s.request(path,{action:'approve',note:'通过',version:0},s.admin)).status,200)
  const c=await s.apply(first); await s.review(c.id,13900)
  assert.equal((await s.complete(c.id)).status,409)
  assert.equal((await s.request(path,{action:'paid',note:'已转账',reference:'TEST-PAY',version:1},s.admin)).status,200)
  s.db.prepare('UPDATE partner_payouts SET created_at=? WHERE id=?').run(Date.now()-PAYOUT_COOLDOWN_MS, p.id)
  await s.create(); await s.create()
  assert.equal((await s.payout()).status,409)
  const results=await Promise.all([s.complete(c.id),s.complete(c.id)])
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409])
  assert.equal(s.db.prepare('SELECT SUM(amount_cents) amount FROM partner_debits').get()!.amount,3900)
  assert.equal((await s.payout()).status,201)
  const next=s.db.prepare("SELECT * FROM partner_payouts WHERE status='pending'").get()!; assert.equal(next.gross_cents,7800); assert.equal(next.deduction_cents,3900); assert.equal(next.amount_cents,3900)
  assert.equal((await s.request('/api/admin/partner-payouts/'+next.id,{action:'rejected',note:'修改收款信息',version:0},s.admin)).status,200)
  assert.equal(s.db.prepare('SELECT payout_id FROM partner_debits').get()!.payout_id,null)
  const historical=await (await s.request('/api/admin/partner-payouts/'+next.id,undefined,s.admin)).json(); assert.equal(historical.deductions[0].amount_cents,3900)
  s.db.prepare('UPDATE partner_payouts SET created_at=? WHERE id=?').run(Date.now()-PAYOUT_COOLDOWN_MS, next.id)
  assert.equal((await s.payout()).status,201)
  const final=s.db.prepare("SELECT * FROM partner_payouts WHERE status='pending'").get()!; assert.equal(final.amount_cents,3900)
})

test('recovery expiry and delivery failure never create access, and secrets rotate sessions', async t=>{
  const s=await setup(); t.after(()=>s.db.close()); const buyer=await s.buyer(); await s.create(buyer); const mail=mockPartnerMail(t,s)
  const send=async()=> { s.db.exec('DELETE FROM admin_login_limits'); const r=await s.request('/api/orders/recovery/send',{email:'buyer@example.test'}); assert.equal(r.status,200); return {...await r.json(),code:mail.mails.at(-1)!.text.match(/\b\d{6}\b/)![0]} }
  const expired=await send(); s.db.exec('UPDATE customer_login_codes SET expires_at=0')
  assert.equal((await s.request('/api/orders/recovery/verify',expired)).status,401)
  const data=await send(); const responses=await Promise.all([s.request('/api/orders/recovery/verify',data),s.request('/api/orders/recovery/verify',data)])
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,401])
  const cookie=responses.find(r=>r.status===200)!.headers.get('set-cookie')!.split(';')[0]
  assert.equal((await (await s.request('/api/orders/recovery/session',undefined,cookie)).json()).email,'buyer@example.test')
  s.env.PARTNER_AUTH_SECRET='rotated-private-key-for-testing-only'
  assert.equal((await (await s.request('/api/orders/recovery/session',undefined,cookie)).json()).email,null)
  s.db.exec('DELETE FROM admin_login_limits'); t.mock.method(globalThis,'fetch',async()=>new Response('fail',{status:500}))
  assert.equal((await s.request('/api/orders/recovery/send',{email:'buyer@example.test'})).status,503)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM customer_login_codes').get()!.n,0)
})

test('cumulative proportional refunds deduct only remaining paid commission and never exceed order total', async t=>{
  const s=await financeFixture(t); const id=await s.create(); const first=await s.apply(id)
  assert.equal((await s.request('/api/admin/refunds/'+first.id,{action:'approve',amountCents:13901,note:'超过金额',version:0},s.admin)).status,400)
  await s.review(first.id,6950); assert.equal((await s.complete(first.id)).status,200)
  await s.create(); assert.equal((await s.payout()).status,201)
  const p=s.db.prepare("SELECT * FROM partner_payouts WHERE status='pending'").get()!; assert.equal(p.amount_cents,5850)
  const path='/api/admin/partner-payouts/'+p.id
  assert.equal((await s.request(path,{action:'approve',note:'测试',version:0},s.admin)).status,200)
  assert.equal((await s.request(path,{action:'paid',note:'测试',reference:'TEST',version:1},s.admin)).status,200)
  const second=await s.apply(id); assert.equal(second.requested_cents,6950); await s.review(second.id,6950)
  assert.equal((await s.complete(second.id)).status,200)
  assert.equal(s.db.prepare('SELECT SUM(amount_cents) amount FROM partner_debits').get()!.amount,1950)
  assert.equal(s.db.prepare('SELECT refunded_cents FROM orders WHERE id=?').get(id)!.refunded_cents,13900)
})

test('Duolingo partial warranty refunds forfeit all unpaid commission', async t => {
  const s = await financeFixture(t)
  const id = await s.create()
  s.db.prepare("UPDATE orders SET plan='duolingo-12m',plan_name='多邻国一年' WHERE id=?").run(id)
  const c = await s.apply(id)
  await s.review(c.id, 1)
  assert.equal((await s.complete(c.id)).status, 200)
  const dashboard = await (await s.request('/api/partner/dashboard', undefined, s.partner)).json()
  assert.equal(dashboard.stats.available, 0)
  assert.equal(dashboard.stats.debt, 0)
  assert.equal((await s.payout()).status, 409)
  const orders = await (await s.request('/api/partner/orders', undefined, s.partner)).json()
  assert.equal(orders.rows.find((o: { id: string }) => o.id === id).profit_cents, 0)
})

test('Duolingo paid commission is deducted once even when further refunds arrive after deduction', async t => {
  const s = await financeFixture(t)
  const id = await s.create()
  s.db.prepare("UPDATE orders SET plan='duolingo-12m',plan_name='多邻国一年' WHERE id=?").run(id)
  assert.equal((await s.payout()).status, 201)
  const pay = async (p: { id: unknown }) => {
    const path = '/api/admin/partner-payouts/' + p.id
    assert.equal((await s.request(path, { action: 'approve', note: 'fixture', version: 0 }, s.admin)).status, 200)
    assert.equal((await s.request(path, { action: 'paid', note: 'fixture', reference: 'fixture', version: 1 }, s.admin)).status, 200)
    s.db.prepare('UPDATE partner_payouts SET created_at=? WHERE id=?').run(Date.now() - PAYOUT_COOLDOWN_MS, p.id as string)
  }
  await pay(s.db.prepare('SELECT id FROM partner_payouts').get() as { id: string })
  const first = await s.apply(id)
  await s.review(first.id, 1)
  assert.equal((await s.complete(first.id)).status, 200)
  const detail = await (await s.request('/api/admin/refunds/' + first.id, undefined, s.admin)).json()
  assert.equal(detail.hasPartner, true)
  assert.deepEqual(detail.partnerDebit, { amount_cents: 3900, payout_id: null, payout_status: null })
  await s.create(); await s.create()
  assert.equal((await s.payout()).status, 201)
  const next = s.db.prepare("SELECT * FROM partner_payouts WHERE status='pending'").get()!
  assert.equal(next.amount_cents, 3900)
  assert.equal(next.deduction_cents, 3900)
  await pay(next as { id: string })
  const second = await s.apply(id)
  await s.review(second.id, 13899)
  assert.equal((await s.complete(second.id)).status, 200)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_debits').get()!.n, 1)
  const settled = await (await s.request('/api/admin/refunds/' + first.id, undefined, s.admin)).json()
  assert.equal(settled.partnerDebit.payout_status, 'paid')
  const repeated = await (await s.request('/api/admin/refunds/' + second.id, undefined, s.admin)).json()
  assert.equal(repeated.partnerDebit, null)
  await s.create()
  assert.equal((await s.payout()).status, 201)
  assert.equal(s.db.prepare("SELECT deduction_cents FROM partner_payouts WHERE status='pending'").get()!.deduction_cents, 0)
})

test('admin mailbox comes from server configuration and rotation revokes sessions', async t => {
  const s = await setup(); t.after(() => s.db.close())
  const mail = adminMail(t, s)
  s.env.ADMIN_EMAIL = 'owner@example.invalid'
  const sent = await mail.send()
  assert.equal(sent.status, 200)
  assert.deepEqual(mail.mails[0].to, ['owner@example.invalid'])
  const { challenge } = await sent.json()
  const login = await s.request('/api/admin/login', { username: 'tester', code: await totpCode(credential), emailCode: '001234', challenge })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('Set-Cookie')!.split(';')[0]
  assert.equal((await s.request('/api/admin/orders', undefined, cookie)).status, 200)
  s.env.ADMIN_EMAIL = 'new-owner@example.invalid'
  assert.equal((await s.request('/api/admin/orders', undefined, cookie)).status, 401)
  delete s.env.ADMIN_EMAIL
  assert.equal((await (await s.request('/api/admin/session')).json()).configured, false)
  assert.equal((await mail.send()).status, 503)
  assert.equal(mail.mails.length, 1)
})
