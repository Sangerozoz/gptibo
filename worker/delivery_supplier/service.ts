import { ApiError, json, type Env, type Statement } from '../platform.ts'
import { getOrder, type Order } from '../order-state.ts'
import { emailCheckoutEnabled, sendSavedDelivery, validateValue } from '../email-delivery.ts'
import { emailProduct } from '../../shared/email-products.ts'
import { membershipDeliveryMessage, siteEmail } from '../email.ts'
import { call, credentialHash, isDeliverySupplierPlan, mappings, DeliverySupplierReceiptRejected, products, purchaseReceipt, rate, USD_MICROS_PER_CENT, usdMicros, validateProduct, type Product, type SupplierOrder } from './client.ts'

type Purchase = { order_id: string; service_id: string; credential_hash: string; request_key: string; request_body: string; max_usd_cents: number; cny_per_usd: number; instructions: string; state: string; supplier_order: string | null; actual_usd_cents: number | null; actual_usd_micros: number | null; actual_cost_cents: number | null; value: string | null; attempted_at: number | null; lease_token: string | null; lease_until: number; next_check_at: number; updated_at: number }
type Snapshot = { serviceId: string; fingerprint: string; ceiling: number; fx: number; instructions: string }
const find = (env: Env, id: string) => env.INTEREST_DB.prepare('SELECT * FROM delivery_supplier_orders WHERE order_id=?').bind(id).first<Purchase>()
const eligibility = "mode='live' AND is_test=0 AND payment_status='paid' AND refund_hold=0 AND refunded_cents=0 AND redemption_blocked=0 AND status IN ('session','processing')"
export function delivery_supplierCheckoutEnabled(env: Env) {
  try { return env.DELIVERY_SUPPLIER_CHECKOUT_ENABLED === 'true' && !!env.DELIVERY_SUPPLIER_API_KEY && rate(env) > 0 && emailCheckoutEnabled(env) } catch { return false }
}
export async function delivery_supplierSnapshot(env: Env, plan: string, sale: number, supply: number | undefined, instructions: string, list?: Product[]): Promise<Snapshot> {
  if (!isDeliverySupplierPlan(plan) || !delivery_supplierCheckoutEnabled(env)) throw new ApiError('该商品自动发货暂未开放。', 409)
  const mapping = mappings[plan], fx = rate(env), ceiling = mapping.maxUsdCents
  const cost = Math.ceil(ceiling * fx)
  if (cost >= sale || (supply !== undefined && (cost >= supply || supply > sale))) throw new ApiError('采购成本与售价不匹配。', 409)
  validateProduct(list ?? await products(env), mapping.id, ceiling)
  return { serviceId: mapping.id, fingerprint: await credentialHash(env), ceiling, fx, instructions }
}
export function delivery_supplierSnapshotStatement(env: Env, id: string, s: Snapshot): Statement {
  return env.INTEREST_DB.prepare('INSERT INTO delivery_supplier_orders(order_id,service_id,credential_hash,request_key,request_body,max_usd_cents,cny_per_usd,instructions,updated_at) SELECT id,?,?,?,?,?,?,?,? FROM orders WHERE id=? ON CONFLICT DO NOTHING')
    .bind(s.serviceId, s.fingerprint, purchaseReceipt(id), JSON.stringify({ service_id: s.serviceId, quantity: 1, precheck: true, include_proofs: true }), s.ceiling, s.fx, s.instructions, Date.now(), id)
}
export async function delivery_supplierCatalog<T extends { id: string; enabled: number; price_cents: number; cost_cents?: number }>(env: Env, plans: T[], partnerId?: string) {
  let list: Product[] = []
  if (delivery_supplierCheckoutEnabled(env) && plans.some(p => isDeliverySupplierPlan(p.id) && p.enabled)) { try { list = await products(env) } catch { /* Fail closed. */ } }
  return Promise.all(plans.map(async p => {
    if (!isDeliverySupplierPlan(p.id) || !p.enabled) return p
    try {
      const supply = partnerId ? await env.INTEREST_DB.prepare('SELECT cost_cents FROM partner_prices WHERE partner_id=? AND plan=?').bind(partnerId, p.id).first<{ cost_cents: number }>() : null
      if (partnerId && !supply) throw new Error('Missing offer')
      await delivery_supplierSnapshot(env, p.id, p.price_cents, supply?.cost_cents ?? p.cost_cents, '', list)
      return p
    } catch { return { ...p, enabled: 0 } }
  }))
}
async function prepareDelivery(env: Env, row: Purchase, lease: string) {
  if (!row.value || !env.RESEND_FROM) return
  const order = await getOrder(env, row.order_id), product = emailProduct(order.plan)!
  const message = JSON.stringify({ from: env.RESEND_FROM, to: [order.customer_email], ...siteEmail(env, membershipDeliveryMessage(product.kind, order.id, row.value, row.instructions, order.plan)) })
  const event = crypto.randomUUID(), now = Date.now()
  await env.INTEREST_DB.batch([
    env.INTEREST_DB.prepare(`INSERT INTO email_deliveries(order_id,kind,value,instructions,mail_body,request_key,created_at,updated_at) SELECT id,?,?,?,?,?,?,? FROM orders WHERE id=? AND ${eligibility} AND EXISTS(SELECT 1 FROM delivery_supplier_orders n WHERE n.order_id=orders.id AND n.state='purchased' AND n.lease_token=?) ON CONFLICT DO NOTHING`).bind(product.kind, row.value, row.instructions, message, crypto.randomUUID(), now, now, order.id, lease),
    env.INTEREST_DB.prepare(`UPDATE orders SET status='processing',updated_at=?,version=version+1,last_event_id=? WHERE id=? AND ${eligibility} AND EXISTS(SELECT 1 FROM email_deliveries d WHERE d.order_id=orders.id) AND NOT EXISTS(SELECT 1 FROM order_events e WHERE e.order_id=orders.id AND e.action='delivery_supplier-delivered')`).bind(now, event, order.id),
    env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT ?,id,'system','delivery_supplier-delivered','processing',status,'采购已核验，领取资料已交付订单页，准备邮件发货',version,? FROM orders WHERE id=? AND last_event_id=?").bind(event, now, order.id, event),
  ])
  await sendSavedDelivery(env, await getOrder(env, order.id))
}
export async function fulfillDeliverySupplier(env: Env, id: string) {
  let row = await find(env, id)
  if (!row || row.state === 'rejected' || row.next_check_at > Date.now()) return
  if (row.attempted_at === null && !delivery_supplierCheckoutEnabled(env)) return
  if (row.credential_hash !== await credentialHash(env)) throw new ApiError('采购凭据已变化，请恢复原凭据核对原单。', 409)
  const lease = crypto.randomUUID(), now = Date.now()
  await env.INTEREST_DB.prepare(`UPDATE delivery_supplier_orders SET lease_token=?,lease_until=?,updated_at=? WHERE order_id=? AND lease_until<=? AND EXISTS(SELECT 1 FROM orders WHERE id=delivery_supplier_orders.order_id AND ${eligibility})`).bind(lease, now + 90000, now, id, now).run()
  row = (await find(env, id))!
  if (row.lease_token !== lease) return
  try {
    if (row.state === 'purchased') { await prepareDelivery(env, row, lease); return }
    if (row.attempted_at === null) {
      // Never change a receipt that might already have charged the supplier wallet.
      if (row.request_key === 'ymx/' + id && !row.supplier_order) {
        await env.INTEREST_DB.prepare('UPDATE delivery_supplier_orders SET request_key=? WHERE order_id=? AND lease_token=? AND attempted_at IS NULL AND supplier_order IS NULL AND request_key=?').bind(purchaseReceipt(id), id, lease, row.request_key).run()
        row = (await find(env, id))!
      }
      validateProduct(await products(env), row.service_id, row.max_usd_cents)
      const profile = await call<{ wallet_balance: number }>(env, '/me')
      if (usdMicros(profile.wallet_balance) < row.max_usd_cents * USD_MICROS_PER_CENT) throw new ApiError('供应商余额不足，待补充后自动发货。', 409)
      const event = crypto.randomUUID(), attempted = Date.now()
      await env.INTEREST_DB.batch([
        env.INTEREST_DB.prepare("UPDATE delivery_supplier_orders SET state='creating',attempted_at=?,updated_at=? WHERE order_id=? AND lease_token=? AND attempted_at IS NULL AND lease_until>?").bind(attempted, attempted, id, lease, attempted),
        env.INTEREST_DB.prepare(`UPDATE orders SET status='processing',started_at=COALESCE(started_at,?),updated_at=?,version=version+1,last_event_id=? WHERE id=? AND ${eligibility} AND EXISTS(SELECT 1 FROM delivery_supplier_orders n WHERE n.order_id=orders.id AND n.lease_token=? AND n.attempted_at=?)`).bind(attempted, attempted, event, id, lease, attempted),
        env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT ?,id,'system','delivery_supplier-purchase-start','session',status,'付款已确认，开始自动采购',version,? FROM orders WHERE id=? AND last_event_id=?").bind(event, attempted, id, event),
      ])
      row = (await find(env, id))!
      if (row.lease_token !== lease || row.attempted_at !== attempted || row.state !== 'creating') return
    }
    // Persist the receipt/body before any charge. Lost responses reuse both exactly.
    if (!row.supplier_order) {
      const created = await call<SupplierOrder>(env, '/order', row.request_key, row.request_body)
      if (typeof created.order_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(created.order_id)) throw new ApiError('原采购编号待核对。', 502)
      await env.INTEREST_DB.prepare('UPDATE delivery_supplier_orders SET supplier_order=? WHERE order_id=? AND lease_token=?').bind(created.order_id, id, lease).run()
      row = (await find(env, id))!
    }
    const data = await call<{ order: SupplierOrder }>(env, '/order/' + encodeURIComponent(row.supplier_order!)), result = data.order
    if (!result || result.order_id !== row.supplier_order || (result.service_id !== undefined && result.service_id !== row.service_id) || result.requested_quantity !== 1) throw new ApiError('原采购订单信息待核对。', 409)
    if (result.order_status === 'refunded' && usdMicros(result.net_charged_amount) === 0 && usdMicros(result.refunded_amount) === usdMicros(result.charged_amount) && result.delivered_quantity === 0) {
      const event = crypto.randomUUID(), time = Date.now()
      await env.INTEREST_DB.batch([
        env.INTEREST_DB.prepare("UPDATE delivery_supplier_orders SET state='rejected',updated_at=? WHERE order_id=? AND lease_token=?").bind(time, id, lease),
        env.INTEREST_DB.prepare(`UPDATE orders SET status='failed',updated_at=?,version=version+1,last_event_id=? WHERE id=? AND ${eligibility} AND EXISTS(SELECT 1 FROM delivery_supplier_orders n WHERE n.order_id=orders.id AND n.lease_token=? AND n.state='rejected')`).bind(time, event, id, lease),
        env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT ?,id,'system','delivery_supplier-refunded','processing',status,'供应商确认采购已退款，请通过原订单处理客户售后',version,? FROM orders WHERE id=? AND last_event_id=?").bind(event, time, id, event),
      ]); return
    }
    if (result.order_status !== 'success') {
      const delay = Math.min(3600, Math.max(60, Number(result.retry_after_seconds) || 60)) * 1000
      await env.INTEREST_DB.prepare("UPDATE delivery_supplier_orders SET state='pending',next_check_at=?,updated_at=? WHERE order_id=? AND lease_token=?").bind(Date.now() + delay, Date.now(), id, lease).run(); return
    }
    const cost = usdMicros(result.charged_amount), values = result.delivered_products
    if (cost <= 0 || cost > row.max_usd_cents * USD_MICROS_PER_CENT || usdMicros(result.refunded_amount) !== 0 || usdMicros(result.net_charged_amount) !== cost || result.delivered_quantity !== 1 || result.partial_delivery !== false || !Array.isArray(values) || values.length !== 1) throw new ApiError('采购金额或交付数量待核对。', 409)
    const order = await getOrder(env, id), value = validateValue(emailProduct(order.plan)!.kind, values[0])
    await env.INTEREST_DB.prepare("UPDATE delivery_supplier_orders SET state='purchased',actual_usd_micros=?,actual_usd_cents=?,actual_cost_cents=?,value=?,updated_at=? WHERE order_id=? AND lease_token=?").bind(cost, Math.round(cost / USD_MICROS_PER_CENT), Math.round(cost * row.cny_per_usd / USD_MICROS_PER_CENT), value, Date.now(), id, lease).run()
    await prepareDelivery(env, (await find(env, id))!, lease)
  } catch (error) {
    if (error instanceof DeliverySupplierReceiptRejected && !row.supplier_order) {
      const event = crypto.randomUUID(), time = Date.now()
      await env.INTEREST_DB.batch([
        env.INTEREST_DB.prepare("UPDATE delivery_supplier_orders SET state='rejected',updated_at=? WHERE order_id=? AND lease_token=? AND supplier_order IS NULL AND value IS NULL").bind(time, id, lease),
        env.INTEREST_DB.prepare(`UPDATE orders SET status='failed',updated_at=?,version=version+1,last_event_id=? WHERE id=? AND ${eligibility} AND EXISTS(SELECT 1 FROM delivery_supplier_orders n WHERE n.order_id=orders.id AND n.lease_token=? AND n.state='rejected')`).bind(time, event, id, lease),
        env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT ?,id,'system','delivery_supplier-receipt-rejected','processing',status,'供应商明确返回 INVALID_IDEMPOTENCY_KEY，未接受采购，停止自动重试',version,? FROM orders WHERE id=? AND last_event_id=?").bind(event, time, id, event),
      ])
      throw error
    }
    await env.INTEREST_DB.prepare("UPDATE delivery_supplier_orders SET state=CASE WHEN state='creating' THEN 'unknown' ELSE state END,next_check_at=?,updated_at=? WHERE order_id=? AND lease_token=?").bind(Date.now() + 60000, Date.now(), id, lease).run()
    throw error
  } finally { await env.INTEREST_DB.prepare('UPDATE delivery_supplier_orders SET lease_until=0 WHERE order_id=? AND lease_token=?').bind(id, lease).run() }
}
export async function reconcileDeliverySupplier(env: Env) {
  const rows = (await env.INTEREST_DB.prepare(`SELECT n.order_id FROM delivery_supplier_orders n JOIN orders o ON o.id=n.order_id WHERE n.state<>'rejected' AND n.next_check_at<=? AND n.lease_until<=? AND o.mode='live' AND o.is_test=0 AND o.payment_status='paid' AND o.refund_hold=0 AND o.refunded_cents=0 AND o.redemption_blocked=0 AND o.status IN ('session','processing') ORDER BY n.updated_at LIMIT 10`).bind(Date.now(), Date.now()).all<{ order_id: string }>()).results
  for (const row of rows) { try { await fulfillDeliverySupplier(env, row.order_id) } catch { /* Retry original receipt, never substitute a new purchase. */ } }
}
export async function delivery_supplierAdmin(env: Env, id: string) {
  const row = await find(env, id)
  return json({ purchase: row ? { state: row.state, supplierOrder: row.supplier_order, actualUsdMicros: row.actual_usd_micros, actualUsdCents: row.actual_usd_cents, actualCostCents: row.actual_cost_cents, cnyPerUsd: row.cny_per_usd, updatedAt: row.updated_at } : null })
}

// Reissue only the legacy receipt explicitly rejected before a purchase was accepted.
// Timeouts, pending orders and confirmed supplier refunds cannot use this recovery.
export async function retryDeliverySupplierRejectedReceipt(env: Env, order: Order, data: Record<string, unknown>) {
  if (data.confirmed !== true || typeof data.note !== 'string' || data.note.trim().length < 6 || data.note.length > 500 || data.orderVersion !== order.version || !Number.isSafeInteger(data.updatedAt)) throw new ApiError('请核实原采购未发生并填写说明，订单变化后需刷新。', 409)
  const now = Date.now(), event = crypto.randomUUID()
  await env.INTEREST_DB.batch([
    env.INTEREST_DB.prepare(`UPDATE delivery_supplier_orders SET request_key=?,state='prepared',attempted_at=NULL,next_check_at=0,lease_token=?,updated_at=? WHERE order_id=? AND updated_at=? AND request_key=? AND state='rejected' AND supplier_order IS NULL AND value IS NULL AND lease_until<=? AND EXISTS(SELECT 1 FROM orders o WHERE o.id=delivery_supplier_orders.order_id AND o.version=? AND o.status='failed' AND o.mode='live' AND o.is_test=0 AND o.payment_status='paid' AND o.refund_hold=0 AND o.refunded_cents=0 AND o.redemption_blocked=0 AND EXISTS(SELECT 1 FROM order_events e WHERE e.id=o.last_event_id AND e.action='delivery_supplier-receipt-rejected')) AND NOT EXISTS(SELECT 1 FROM email_deliveries d WHERE d.order_id=delivery_supplier_orders.order_id)`)
      .bind(purchaseReceipt(order.id), event, now, order.id, Number(data.updatedAt), 'ymx/' + order.id, now, order.version),
    env.INTEREST_DB.prepare("UPDATE orders SET status='session',updated_at=?,version=version+1,last_event_id=? WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM delivery_supplier_orders n WHERE n.order_id=orders.id AND n.lease_token=? AND n.state='prepared')").bind(now, event, order.id, order.version, event),
    env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT ?,id,?,'delivery_supplier-receipt-recovered','failed',status,?,version,? FROM orders WHERE id=? AND last_event_id=?").bind(event, 'admin:' + env.ADMIN_USERNAME, '核实原请求被拒绝且未采购，修正编号恢复原订单：' + data.note.trim(), now, order.id, event),
  ])
  if (!await env.INTEREST_DB.prepare('SELECT id FROM order_events WHERE id=?').bind(event).first()) throw new ApiError('仅明确拒绝的旧采购编号可恢复，请刷新后核对。', 409)
  return delivery_supplierAdmin(env, order.id)
}

export async function confirmDeliverySupplierNotPurchased(env: Env, order: Order, data: Record<string, unknown>) {
  if (data.confirmed !== true || typeof data.note !== 'string' || data.note.trim().length < 6 || data.note.length > 500 || data.orderVersion !== order.version || !Number.isSafeInteger(data.updatedAt)) throw new ApiError('请核对原采购单无扣款、无发货，并填写核查说明；订单变化后需刷新。', 409)
  const now = Date.now(), token = crypto.randomUUID()
  await env.INTEREST_DB.batch([
    env.INTEREST_DB.prepare("UPDATE delivery_supplier_orders SET state='rejected',lease_token=?,updated_at=? WHERE order_id=? AND updated_at=? AND state IN ('creating','unknown') AND lease_until<=? AND value IS NULL AND supplier_order IS NULL AND EXISTS(SELECT 1 FROM orders o WHERE o.id=delivery_supplier_orders.order_id AND o.version=?)").bind(token, now, order.id, Number(data.updatedAt), now, order.version),
    env.INTEREST_DB.prepare("UPDATE orders SET status='failed',updated_at=?,version=version+1,last_event_id=? WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM delivery_supplier_orders k WHERE k.order_id=orders.id AND k.lease_token=? AND k.state='rejected')").bind(now, token, order.id, order.version, token),
    env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT ?,id,?,'delivery_supplier-purchase-reconciled',?,status,?,version,? FROM orders WHERE id=? AND last_event_id=?").bind(token, 'admin:' + env.ADMIN_USERNAME, order.status, '管理员确认原采购单无扣款及无发货：' + data.note.trim(), now, order.id, token),
  ])
  if (!await env.INTEREST_DB.prepare('SELECT id FROM order_events WHERE id=?').bind(token).first()) throw new ApiError('采购仍在处理或记录已更新，请刷新后核对。', 409)
  return delivery_supplierAdmin(env, order.id)
}
