import { ApiError, json, type Env, type Statement } from '../platform.ts'
import { getOrder, type Order } from '../order-state.ts'
import { emailCheckoutEnabled, sendSavedDelivery } from '../email-delivery.ts'
import { membershipDeliveryMessage, siteEmail } from '../email.ts'
import { call, configuration, configured, goodsDetail, AccountSupplierRejected, moneyCents, validateGoods, type Goods, type SupplierOrder } from './client.ts'

type Purchase = { order_id: string; goods_id: number; goods_name: string; api_base: string; app_id: string; max_cost_cents: number; instructions: string; state: 'prepared' | 'creating' | 'unknown' | 'purchased' | 'rejected'; supplier_order: string | null; actual_cost_cents: number | null; cards: string | null; attempted_at: number | null; lease_token: string | null; lease_until: number; updated_at: number }
export type GmailSnapshot = { goods: Goods; base: string; appId: string; ceiling: number; instructions: string }
const find = (env: Env, id: string) => env.INTEREST_DB.prepare('SELECT * FROM account_supplier_orders WHERE order_id=?').bind(id).first<Purchase>()
const eligibility = "plan='gmail-account' AND mode='live' AND is_test=0 AND payment_status='paid' AND refund_hold=0 AND refunded_cents=0 AND redemption_blocked=0 AND status IN ('session','processing')"
export function gmailCheckoutEnabled(env: Env) {
  return env.ACCOUNT_SUPPLIER_CHECKOUT_ENABLED === 'true' && configured(env) && emailCheckoutEnabled(env) && /^\d+$/.test(env.ACCOUNT_SUPPLIER_GOODS_ID ?? '') && Number(env.ACCOUNT_SUPPLIER_GOODS_ID) > 0 && /^\d+$/.test(env.ACCOUNT_SUPPLIER_MAX_COST_CENTS ?? '') && Number(env.ACCOUNT_SUPPLIER_MAX_COST_CENTS) > 0
}
export async function gmailSnapshot(env: Env, sale: number, supply: number | undefined, instructions: string): Promise<GmailSnapshot> {
  if (!gmailCheckoutEnabled(env)) throw new ApiError('Gmail 自动发货暂未开放。', 409)
  const ceiling = Number(env.ACCOUNT_SUPPLIER_MAX_COST_CENTS)
  if (!Number.isSafeInteger(ceiling) || ceiling >= sale || (supply !== undefined && (ceiling >= supply || supply > sale))) throw new ApiError('Gmail 采购成本与售价配置不匹配。', 409)
  const goods = await goodsDetail(env, Number(env.ACCOUNT_SUPPLIER_GOODS_ID)); validateGoods(goods, ceiling)
  const { base, appId } = configuration(env)
  return { goods, base, appId, ceiling, instructions }
}
export function gmailSnapshotStatement(env: Env, id: string, snapshot: GmailSnapshot): Statement {
  return env.INTEREST_DB.prepare('INSERT INTO account_supplier_orders(order_id,goods_id,goods_name,api_base,app_id,max_cost_cents,instructions,updated_at) SELECT id,?,?,?,?,?,?,? FROM orders WHERE id=? ON CONFLICT DO NOTHING')
    .bind(snapshot.goods.goodsId, snapshot.goods.name, snapshot.base, snapshot.appId, snapshot.ceiling, snapshot.instructions, Date.now(), id)
}
export async function gmailCatalog<T extends { id: string; enabled: number; price_cents: number; cost_cents?: number }>(env: Env, plans: T[], partnerId?: string) {
  const plan = plans.find(p => p.id === 'gmail-account')
  if (!plan?.enabled) return plans
  let available = false
  try {
    const supply = partnerId ? await env.INTEREST_DB.prepare("SELECT cost_cents FROM partner_prices WHERE partner_id=? AND plan='gmail-account'").bind(partnerId).first<{ cost_cents: number }>() : null
    if (partnerId && !supply) return plans.map(p => p.id === 'gmail-account' ? { ...p, enabled: 0 } : p)
    await gmailSnapshot(env, plan.price_cents, supply?.cost_cents ?? plan.cost_cents, ''); available = true
  } catch { /* Fail closed, keep the rest of the catalog available. */ }
  return plans.map(p => p.id === 'gmail-account' ? { ...p, enabled: available ? p.enabled : 0 } : p)
}
async function storePurchase(env: Env, row: Purchase, lease: string, result: SupplierOrder) {
  if (typeof result.orderNumber !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.orderNumber) || result.outerNumber !== row.order_id || result.count !== 1 || result.status !== 3 || moneyCents(result.retMoney) !== 0) throw new ApiError('采购结果待人工核对。', 409)
  const cost = moneyCents(result.money)
  if (cost > row.max_cost_cents || !Array.isArray(result.cards) || result.cards.length !== 1) throw new ApiError('采购金额或账号数量待核对。', 409)
  const card = result.cards[0]
  if (!card || typeof card.cardId !== 'string' || !card.cardId || typeof card.cardNo !== 'string' || !card.cardNo.trim() || typeof card.cardPwd !== 'string' || card.status !== 0 || card.cardNo.length + card.cardPwd.length > 8000) throw new ApiError('采购账号资料待核对。', 409)
  await env.INTEREST_DB.prepare("UPDATE account_supplier_orders SET state='purchased',supplier_order=?,actual_cost_cents=?,cards=?,updated_at=? WHERE order_id=? AND lease_token=? AND state IN ('creating','unknown')")
    .bind(result.orderNumber, cost, JSON.stringify([{ cardId: card.cardId, cardNo: card.cardNo, cardPwd: card.cardPwd, status: card.status }]), Date.now(), row.order_id, lease).run()
}
async function prepareEmail(env: Env, row: Purchase, lease: string) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM || !row.cards) return
  const order = await getOrder(env, row.order_id), cards = JSON.parse(row.cards) as { cardNo: string; cardPwd: string }[]
  const value = cards.map(c => c.cardNo + (c.cardPwd ? '\n密码：' + c.cardPwd : '')).join('\n\n')
  const message = JSON.stringify({ from: env.RESEND_FROM, to: [order.customer_email], ...siteEmail(env, membershipDeliveryMessage('cdk', order.id, value, row.instructions, 'gmail-account')) })
  const event = crypto.randomUUID(), now = Date.now()
  await env.INTEREST_DB.batch([
    env.INTEREST_DB.prepare(`INSERT INTO email_deliveries(order_id,kind,value,instructions,mail_body,request_key,created_at,updated_at) SELECT id,'cdk',?,?,?,?,?,? FROM orders WHERE id=? AND ${eligibility} AND EXISTS(SELECT 1 FROM account_supplier_orders k WHERE k.order_id=orders.id AND k.state='purchased' AND k.lease_token=?) ON CONFLICT DO NOTHING`)
      .bind(value, row.instructions, message, crypto.randomUUID(), now, now, order.id, lease),
    env.INTEREST_DB.prepare(`UPDATE orders SET status='processing',updated_at=?,version=version+1,last_event_id=? WHERE id=? AND ${eligibility} AND EXISTS(SELECT 1 FROM email_deliveries d WHERE d.order_id=orders.id) AND NOT EXISTS(SELECT 1 FROM order_events e WHERE e.order_id=orders.id AND e.action='gmail-purchased')`)
      .bind(now, event, order.id),
    env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT ?,id,'system','gmail-purchased','session',status,'Gmail 采购已核验，准备邮件发货',version,? FROM orders WHERE id=? AND last_event_id=?")
      .bind(event, now, order.id, event),
  ])
  await sendSavedDelivery(env, await getOrder(env, order.id))
}
export async function fulfillGmail(env: Env, id: string) {
  let row = await find(env, id)
  if (!row || row.state === 'rejected') return
  // Kill switch pauses new procurement, but still reconciles existing purchases.
  if (row.attempted_at === null && env.ACCOUNT_SUPPLIER_CHECKOUT_ENABLED !== 'true') return
  const config = configuration(env)
  if (row.api_base !== config.base || row.app_id !== config.appId) throw new ApiError('采购账户已变化，请核对原供应商账户。', 409)
  const now = Date.now(), lease = crypto.randomUUID()
  await env.INTEREST_DB.prepare(`UPDATE account_supplier_orders SET lease_token=?,lease_until=?,updated_at=? WHERE order_id=? AND lease_until<=? AND EXISTS(SELECT 1 FROM orders WHERE id=account_supplier_orders.order_id AND ${eligibility})`)
    .bind(lease, now + 60000, now, id, now).run()
  row = (await find(env, id))!
  if (row.lease_token !== lease) return
  try {
    if (row.state === 'purchased') { await prepareEmail(env, row, lease); return }
    if (row.attempted_at === null) {
      // All nonfinancial checks happen before permanently marking an attempt.
      validateGoods(await goodsDetail(env, row.goods_id), row.max_cost_cents)
      const event = crypto.randomUUID(), attemptTime = Date.now()
      await env.INTEREST_DB.batch([
        env.INTEREST_DB.prepare("UPDATE account_supplier_orders SET state='creating',attempted_at=?,updated_at=? WHERE order_id=? AND lease_token=? AND attempted_at IS NULL AND lease_until>?").bind(attemptTime, attemptTime, id, lease, attemptTime),
        env.INTEREST_DB.prepare(`UPDATE orders SET status='processing',started_at=COALESCE(started_at,?),updated_at=?,version=version+1,last_event_id=? WHERE id=? AND ${eligibility} AND EXISTS(SELECT 1 FROM account_supplier_orders k WHERE k.order_id=orders.id AND k.lease_token=? AND k.attempted_at=?)`).bind(attemptTime, attemptTime, event, id, lease, attemptTime),
        env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT ?,id,'system','gmail-purchase-start','session',status,'付款已确认，开始采购 Gmail 账号',version,? FROM orders WHERE id=? AND last_event_id=?").bind(event, attemptTime, id, event),
      ])
      row = (await find(env, id))!
      if (row.lease_token !== lease || row.attempted_at !== attemptTime || row.state !== 'creating') return
      // There is deliberately no retry of /create, even after a crash/timeout.
      let result: SupplierOrder
      try { result = await call<SupplierOrder>(env, '/order/create', { goodsId: row.goods_id, count: 1, notifyUrl: '', outerNumber: id, safePrice: row.max_cost_cents / 100, sku: '', attach: [] }) }
      catch (error) {
        if (error instanceof AccountSupplierRejected) await env.INTEREST_DB.prepare("UPDATE account_supplier_orders SET state='rejected',updated_at=? WHERE order_id=? AND lease_token=?").bind(Date.now(), id, lease).run()
        throw error
      }
      if (typeof result.orderNumber !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.orderNumber)) throw new ApiError('采购编号待核对。', 502)
      await env.INTEREST_DB.prepare('UPDATE account_supplier_orders SET supplier_order=? WHERE order_id=? AND lease_token=?').bind(result.orderNumber, id, lease).run()
    }
    row = (await find(env, id))!
    const result = await call<SupplierOrder>(env, '/order/getDetail', { orderNumber: row.supplier_order ?? '', outerNumber: id })
    // Supplier failure/refund is terminal for procurement; no replacement buy.
    if ((result.status === 4 || result.status === 5) && result.outerNumber === id && (!row.supplier_order || row.supplier_order === result.orderNumber)) {
      await env.INTEREST_DB.prepare("UPDATE account_supplier_orders SET state='rejected',updated_at=? WHERE order_id=? AND lease_token=?").bind(Date.now(), id, lease).run()
      return
    }
    if (row.supplier_order && result.orderNumber !== row.supplier_order) throw new ApiError('采购单号不匹配。', 409)
    await storePurchase(env, row, lease, result)
    await prepareEmail(env, (await find(env, id))!, lease)
  } catch (error) {
    await env.INTEREST_DB.prepare("UPDATE account_supplier_orders SET state='unknown',updated_at=? WHERE order_id=? AND lease_token=? AND state='creating'").bind(Date.now(), id, lease).run()
    throw error
  } finally {
    await env.INTEREST_DB.prepare('UPDATE account_supplier_orders SET lease_until=0 WHERE order_id=? AND lease_token=?').bind(id, lease).run()
  }
}
export async function reconcileGmail(env: Env) {
  const rows = (await env.INTEREST_DB.prepare(`SELECT k.order_id FROM account_supplier_orders k JOIN orders o ON o.id=k.order_id WHERE k.state<>'rejected' AND k.lease_until<=? AND o.mode='live' AND o.is_test=0 AND o.payment_status='paid' AND o.refund_hold=0 AND o.refunded_cents=0 AND o.redemption_blocked=0 AND o.status IN ('session','processing') ORDER BY k.updated_at LIMIT 10`).bind(Date.now()).all<{ order_id: string }>()).results
  let failed = 0
  for (const row of rows) {
    try { await fulfillGmail(env, row.order_id) }
    catch { failed++; await env.INTEREST_DB.prepare('UPDATE account_supplier_orders SET updated_at=? WHERE order_id=?').bind(Date.now(), row.order_id).run() }
  }
  return { checked: rows.length, failed }
}
export async function adminGmailOrder(env: Env, order: Order) {
  const row = await find(env, order.id)
  return json({ purchase: row ? { state: row.state, goodsId: row.goods_id, goodsName: row.goods_name, supplierOrder: row.supplier_order, maxCostCents: row.max_cost_cents, actualCostCents: row.actual_cost_cents, updatedAt: row.updated_at } : null })
}
export async function confirmGmailNotPurchased(env: Env, order: Order, data: Record<string, unknown>) {
  if (data.confirmed !== true || typeof data.note !== 'string' || data.note.trim().length < 6 || data.note.length > 500 || data.orderVersion !== order.version || !Number.isSafeInteger(data.updatedAt)) throw new ApiError('请核对原采购单无扣款、无发货，并填写核查说明；订单变化后需刷新。', 409)
  const now = Date.now(), token = crypto.randomUUID()
  await env.INTEREST_DB.batch([
    env.INTEREST_DB.prepare("UPDATE account_supplier_orders SET state='rejected',lease_token=?,updated_at=? WHERE order_id=? AND updated_at=? AND state IN ('creating','unknown') AND lease_until<=? AND cards IS NULL AND EXISTS(SELECT 1 FROM orders o WHERE o.id=account_supplier_orders.order_id AND o.version=?)").bind(token, now, order.id, Number(data.updatedAt), now, order.version),
    env.INTEREST_DB.prepare("UPDATE orders SET status='failed',updated_at=?,version=version+1,last_event_id=? WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM account_supplier_orders k WHERE k.order_id=orders.id AND k.lease_token=? AND k.state='rejected')").bind(now, token, order.id, order.version, token),
    env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT ?,id,?,'gmail-purchase-reconciled',?,status,?,version,? FROM orders WHERE id=? AND last_event_id=?").bind(token, 'admin:' + env.ADMIN_USERNAME, order.status, '管理员确认原采购单无扣款及无发货：' + data.note.trim(), now, order.id, token),
  ])
  if (!await env.INTEREST_DB.prepare('SELECT id FROM order_events WHERE id=?').bind(token).first()) throw new ApiError('采购仍在处理或记录已更新，请刷新后核对。', 409)
  return adminGmailOrder(env, order)
}
export async function gmailProductsRoute(request: Request, env: Env, url: URL) {
  if (request.method !== 'GET') throw new ApiError('请求方式不支持。', 405)
  if (url.pathname === '/api/admin/account_supplier') return json({ configured: configured(env), checkoutEnabled: gmailCheckoutEnabled(env), goodsId: Number(env.ACCOUNT_SUPPLIER_GOODS_ID) || null, maxCostCents: Number(env.ACCOUNT_SUPPLIER_MAX_COST_CENTS) || null })
  if (url.pathname === '/api/admin/account_supplier/goods') {
    const page = Number(url.searchParams.get('page') ?? 1), query = url.searchParams.get('q') ?? 'gmail'
    if (!Number.isInteger(page) || page < 1 || page > 1000 || query.length > 100) throw new ApiError('查询条件无效。')
    const result = await call<{ allCount: number; allPage: number; items: Goods[] }>(env, '/goods/getList', { page, goodsType: '', keyWord: query, skuType: '', showDirId: '', dirId: '', brandId: '' })
    if (!Array.isArray(result.items)) throw new ApiError('商品列表格式异常。', 502)
    return json({ total: result.allCount, pages: result.allPage, goods: result.items.map(g => ({ goodsId: g.goodsId, name: g.name, priceCents: moneyCents(g.salesPrice), enabled: g.status === 1 })) })
  }
  const match = url.pathname.match(/^\/api\/admin\/account_supplier\/goods\/(\d+)$/)
  if (!match) throw new ApiError('接口不存在。', 404)
  const g = await goodsDetail(env, Number(match[1]))
  return json({ goodsId: g.goodsId, name: g.name, priceCents: moneyCents(g.salesPrice), stock: g.stockCount, enabled: g.status === 1 })
}
