import { isDeliverySupplierPlan } from './delivery_supplier/client.ts'
import { isXGiftPlan, xUsername } from '../shared/xgift-products.ts'
import { recoverXGift, fulfillXGift, preflightXGift, xgiftCheckoutEnabled, xgiftSnapshot, xgiftSnapshotStatement, xgiftSummary } from './xgift/service.ts'
import { xgiftAdmin } from './xgift/admin.ts'
import { confirmDeliverySupplierNotPurchased, fulfillDeliverySupplier, delivery_supplierAdmin, delivery_supplierCheckoutEnabled, delivery_supplierSnapshot, delivery_supplierSnapshotStatement, retryDeliverySupplierRejectedReceipt } from './delivery_supplier/service.ts'
import { emailProduct } from '../shared/email-products.ts'
import { emailCheckoutEnabled, emailDeliveryRoute, emailDeliverySummary, membershipDeliveryPreview } from './email-delivery.ts'
import { buyerAccess, recoveryRoutes } from './customer-auth.ts'
import { adminRefunds, customerRefunds } from './refunds.ts'
import { change, getOrder, settle, settleDue, type Order, type Status } from './order-state.ts'
import { ApiError, body, cookie, hash, json, randomToken, readCookie, type Env, type Value } from './platform.ts'
import { authRoute, requireAdmin } from './admin-auth.ts'
import { emailValue, mailConfigured, partnerAuth } from './partner-auth.ts'
import { adminPartnerRoutes, partnerCatalog, partnerRoutes, resolvePartner } from './partners.ts'
import { paymentAction, reconcilePayments } from './payments/service.ts'
import { alipayConfigured } from './payments/providers.ts'
import { paymentTesting } from './payments/testing.ts'
import { supportContactsRoute, supportContactsSettings } from './support-contacts.ts'
import { checkoutEnabled as supplierCheckoutEnabled, configured as supplierConfigured, productMap, RechargeError } from './recharge/client.ts'
import { supplierSnapshot, snapshotStatement, syncRechargeOrder, rechargeAction, rechargeSummary, findRechargeOrder, reconcileRecharge, expireRechargeOrder, queryPlatformOrder, platformOrderStatus } from './recharge/service.ts'
import type { SupportContactsSettings } from '../shared/support-contacts.ts'
import { setRedemptionBlocked } from './order-redemption.ts'
import { adminVisitorSummary } from './visitors.ts'
import { isLegacyManualOrder } from './manual-fulfillment.ts'
import { accountingRoutes } from './accounting.ts'
import { customerRoutes } from './customers.ts'
import { invoiceRoutes } from './invoices.ts'
import { publicAnnouncement } from './announcements.ts'
import { rechargeReminderPreview } from './recharge-reminders.ts'
import { publicDirectStore } from './direct-store.ts'
import { adminGmailOrder, confirmGmailNotPurchased, fulfillGmail, gmailCheckoutEnabled, gmailProductsRoute, gmailSnapshot, gmailSnapshotStatement } from './account_supplier/service.ts'

type Plan = { delivery_instructions: string; partner_enabled: number; id: string; product_id: string; name: string; price_cents: number; enabled: number; renewal_only: number; version: number }
type OrderPartnerSource = { id: string; slug: string; name: string; email: string; wechat: string; qq: string }
const statuses: Status[] = ['pending', 'session', 'processing', 'success', 'failed', 'cancelled']
const publicOrder = (o: Order) => ({ purchaseNote: o.purchase_note ?? '', isTest: Boolean(o.is_test), customerEmail: o.customer_email, refundedCents: o.refunded_cents, refundHold: Boolean(o.refund_hold), redemptionBlocked: Boolean(o.redemption_blocked), id: o.id, plan: o.plan, planName: o.plan_name, partnerName: o.partner_name ?? undefined, price: o.price_cents / 100, mode: o.mode, paymentStatus: o.payment_status, status: o.status, createdAt: o.created_at, updatedAt: o.updated_at, startedAt: o.started_at ?? undefined, smsPhone: o.sms_phone ?? undefined, version: o.version })
type AdminOrder = Order & { settlement_status: 'pending' | 'paid' | null }
const adminOrder = async (env: Env, o: AdminOrder) => ({ ...(await customerOrder(env, o)), platformStatus: await platformOrderStatus(env, o), settlementStatus: o.settlement_status })
const plans = async (env: Env) => (await env.INTEREST_DB.prepare('SELECT * FROM catalog_plans ORDER BY rowid').all<Plan>()).results
const customerOrder = async (env: Env, o: Order, contacts = new Map<string, Promise<SupportContactsSettings>>(), syncError = false) => {
  o = await expireRechargeOrder(env, o)
  const owner = o.partner_id ?? 'platform'
  const settings = contacts.get(owner) ?? supportContactsSettings(env, owner)
  contacts.set(owner, settings)
  const [support, fulfillment] = await Promise.all([settings, rechargeSummary(env, o)])
  if (fulfillment) Object.assign(fulfillment, { syncError })
  return { ...publicOrder(o), xgift: await xgiftSummary(env, o), manualFulfillment: isLegacyManualOrder(o, Boolean(fulfillment)) || Boolean(emailProduct(o.plan)), delivery: await emailDeliverySummary(env, o), supportContacts: support.contacts, refundHold: !!o.refund_hold || !!fulfillment?.financialHold, fulfillment }
}
async function orderPartnerSource(env: Env, order: Order): Promise<OrderPartnerSource | null> {
  if (!order.partner_id) return null
  const partner = await env.INTEREST_DB.prepare('SELECT id,slug,name,email FROM partners WHERE id=?').bind(order.partner_id).first<Omit<OrderPartnerSource, 'wechat' | 'qq'>>()
  if (!partner) return null
  const contacts = await supportContactsSettings(env, partner.id)
  return { ...partner, wechat: contacts.contacts.wechat, qq: contacts.contacts.qq }
}
function pageParams(url: URL) {
  const page = Number(url.searchParams.get('page') ?? 1)
  if (!Number.isInteger(page) || page < 1 || page > 10000) throw new ApiError('页码无效。')
  return { page, offset: (page - 1) * 20 }
}
function requiredNote(data: Record<string, unknown>) {
  if (typeof data.note !== 'string' || !data.note.trim() || data.note.trim().length > 500) throw new ApiError('请填写 1–500 字的处理说明。')
  return data.note.trim()
}

export async function commerce(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url); const path = url.pathname; const method = request.method
    const auth = await authRoute(request, env, path)
    if (auth) return auth
    const partnerLogin = await partnerAuth(request, env, path)
    if (partnerLogin) return partnerLogin
    if (path === '/api/partner/invoices' || path.startsWith('/api/partner/invoices/')) return await invoiceRoutes(request, env, url)
    if (path.startsWith('/api/partner/')) return await partnerRoutes(request, env, url)
    if (path.startsWith('/api/admin/')) {
      await requireAdmin(request, env)
      if (path.startsWith('/api/admin/xgift/')) return await xgiftAdmin(request, env, url)
      if (path === '/api/admin/account_supplier' || path.startsWith('/api/admin/account_supplier/')) return await gmailProductsRoute(request, env, url)
      if (path === '/api/admin/recharge-reminders/preview') return await rechargeReminderPreview(request, env)
      if (path === '/api/admin/membership-delivery/preview') return await membershipDeliveryPreview(request, env)
      if (path === '/api/admin/invoices' || path.startsWith('/api/admin/invoices/')) return await invoiceRoutes(request, env, url, true)
      if (path.startsWith('/api/admin/customers')) return await customerRoutes(request,env,url,true)
      if (path.startsWith('/api/admin/accounting')) return await accountingRoutes(request, env, url)
      if (path === '/api/admin/visitors' && method === 'GET') return json(await adminVisitorSummary(env, url))
      if (path === '/api/admin/support-contacts') return await supportContactsRoute(request, env)
      if (path.startsWith('/api/admin/payments/test')) return await paymentTesting(request, env, url)
      if (path.startsWith('/api/admin/refunds')) return await adminRefunds(request, env, url)
      if (path.startsWith('/api/admin/partners') || path.startsWith('/api/admin/partner-payouts')) return await adminPartnerRoutes(request, env, url)
      return await admin(request, env, url)
    }
    if (path === '/api/catalog' && method === 'GET') {
      const started = performance.now()
      const partner = await resolvePartner(env, url.searchParams.get('partner'))
      const live = supplierCheckoutEnabled(env)
      const testing = env.ORDER_TESTING_ENABLED === 'true'
      const email = emailCheckoutEnabled(env), gmail = gmailCheckoutEnabled(env), delivery_supplier = delivery_supplierCheckoutEnabled(env)
      const mapped = live ? productMap(env) : {}
      const [catalog, support, announcement] = await Promise.all([
        partner ? partnerCatalog(env, partner) : plans(env).then(plans => ({ plans })),
        supportContactsSettings(env, partner?.id),
        partner ? publicAnnouncement(env, partner.id) : null,
      ])
      // Storefront prices are configured retail prices, independent of supplier latency.
      const offers = (catalog.plans as Plan[]).map(plan => ({ ...plan, enabled: plan.enabled && (
        isXGiftPlan(plan.id) ? xgiftCheckoutEnabled(env) : plan.id === 'gmail-account' ? gmail : isDeliverySupplierPlan(plan.id) ? delivery_supplier : emailProduct(plan.id) ? email : testing || (live && Boolean(mapped[plan.id]))
      ) ? 1 : 0 }))
      return json({ ...catalog, ...(partner ? {} : await publicDirectStore(env)), supportContacts: support.contacts, announcement, plans: offers, mode: live ? 'live' : 'demo', checkoutEnabled: testing || live || email || xgiftCheckoutEnabled(env), testingEnabled: testing }, 200, { 'Server-Timing': `catalog;dur=${(performance.now() - started).toFixed(1)}` })
    }
    if (path === '/api/orders/verification' && method === 'GET') return json({ enabled: false })
    if (path === '/api/orders/client' && method === 'POST') {
      await body(request)
      const token = readCookie(request, 'buyer') ?? randomToken()
      return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, 'buyer', token, 365 * 86400) })
    }
    if (!path.startsWith('/api/orders')) throw new ApiError('未找到接口。', 404)
    const recovery = await recoveryRoutes(request, env, path)
    if (recovery) return recovery
    const { ownerHash, email: recoveredEmail } = await buyerAccess(request, env)
    if (path === '/api/orders/xgift/eligibility' && method === 'POST') {
      const data = await body(request)
      if (!(await env.INTEREST_LIMITER.limit({ key: 'xgift-check:' + await hash(request.headers.get('CF-Connecting-IP') ?? ownerHash) })).success) throw new ApiError('检测较频繁，请稍后再试。', 429)
      return json(await preflightXGift(env, ownerHash, data))
    }
    if (path === '/api/orders' && method === 'GET') {
      const rows = (await env.INTEREST_DB.prepare('SELECT * FROM orders WHERE is_test=0 AND (owner_hash = ? OR customer_email = ?) ORDER BY created_at DESC LIMIT 100').bind(ownerHash, recoveredEmail).all<Order>()).results
      let synced = 0
      const syncErrors = new Set<string>()
      const settled = await Promise.all(rows.map(async row => {
        let current = await settle(env, row)
        if (isXGiftPlan(row.plan) && synced++ < 5) { await fulfillXGift(env, row.id); current = await getOrder(env, row.id) }
        if (row.mode === 'live' && ['pending','processing'].includes(row.status) && synced++ < 5) {
          try { current = await syncRechargeOrder(env, current) } catch { syncErrors.add(row.id) /* Keep last confirmed state on a provider outage. */ }
        }
        return current
      }))
      const contacts = new Map<string, Promise<SupportContactsSettings>>()
      return json({ orders: await Promise.all(settled.map(o => customerOrder(env, o, contacts, syncErrors.has(o.id)))), recoveryEmail: recoveredEmail })
    }
    if (path === '/api/orders' && method === 'POST') {
      const data = await body(request)
      const rateKey = 'orders:' + await hash(request.headers.get('CF-Connecting-IP') ?? 'local')
      if (!(await env.INTEREST_LIMITER.limit({ key: rateKey })).success) throw new ApiError('创建订单较频繁，请稍后再试。', 429)
      if (typeof data.plan !== 'string' || typeof data.key !== 'string' || !/^[a-f0-9-]{36}$/.test(data.key)) throw new ApiError('商品或请求编号无效。')
      const email = emailValue(data.email)
      const partner = await resolvePartner(env, data.partner)
      const existing = await env.INTEREST_DB.prepare('SELECT * FROM orders WHERE owner_hash=? AND idempotency_key=?').bind(ownerHash, data.key).first<Order>()
      if (existing) {
        if (existing.customer_email !== email || existing.plan !== data.plan || existing.partner_id !== (partner?.id ?? null)) throw new ApiError('请求编号已被另一套餐或商店使用。', 409)
        if (isXGiftPlan(existing.plan) && (await xgiftSummary(env, existing))?.username !== xUsername(data.username)) throw new ApiError('请求编号已绑定其他接收账号。', 409)
        return json({ order: await customerOrder(env, existing) })
      }
      const emailDelivery = Boolean(emailProduct(data.plan))
      const live = isXGiftPlan(data.plan) ? xgiftCheckoutEnabled(env) : data.plan === 'gmail-account' ? gmailCheckoutEnabled(env) : isDeliverySupplierPlan(data.plan) ? delivery_supplierCheckoutEnabled(env) : emailDelivery ? emailCheckoutEnabled(env) : supplierCheckoutEnabled(env)
      if (emailDelivery && !live) throw new ApiError('邮件交付商品暂未开放购买。', 409)
      if (env.ORDER_TESTING_ENABLED !== 'true' && !live) throw new ApiError('该服务暂未开放购买，请稍后再来。', 409)
      const plan = await env.INTEREST_DB.prepare('SELECT * FROM catalog_plans WHERE id=? AND enabled=1').bind(data.plan).first<Plan>()
      if (partner && plan && !plan.partner_enabled) throw new ApiError('该商品暂未开放代理销售。', 409)
      if (!plan) throw new ApiError('该套餐已暂停销售，请选择其他套餐。', 409)
      if (partner && await env.INTEREST_DB.prepare('SELECT 1 FROM partner_product_order p,json_each(p.hidden_product_ids) h WHERE p.partner_id=? AND h.value=?').bind(partner.id, plan.product_id).first()) throw new ApiError('该商品已被商店下架，请选择其他商品。', 409)
      const offer = partner ? await env.INTEREST_DB.prepare('SELECT * FROM partner_prices WHERE partner_id=? AND plan=?').bind(partner.id, plan.id).first<{ price_cents: number; cost_cents: number; version: number }>() : null
      if (partner && !offer) throw new ApiError('该代理尚未开通此套餐。', 409)
      if (data.expectedPrice !== (offer?.price_cents ?? plan.price_cents)) throw new ApiError('套餐价格已更新，请刷新后重新确认。', 409)
      const price = offer?.price_cents ?? plan.price_cents
      const snapshot = live && !emailDelivery && !isXGiftPlan(plan.id) ? await supplierSnapshot(env, plan.id, price, offer?.cost_cents) : null
      const delivery_supplier = isDeliverySupplierPlan(plan.id) ? await delivery_supplierSnapshot(env, plan.id, price, offer?.cost_cents, plan.delivery_instructions) : null
      const gmail = plan.id === 'gmail-account' ? await gmailSnapshot(env, price, offer?.cost_cents, plan.delivery_instructions) : null
      const xgift = isXGiftPlan(plan.id) ? await xgiftSnapshot(env, ownerHash, data) : null
      const id = 'YMX-' + crypto.randomUUID().replaceAll('-', '').toUpperCase(); const eventId = crypto.randomUUID(); const now = Date.now()
      await env.INTEREST_DB.batch([
        partner && offer ? env.INTEREST_DB.prepare("INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,status,created_at,updated_at,last_event_id,customer_email,partner_id,partner_name,cost_cents) SELECT ?,?,?,c.id,c.name,pp.price_cents,'pending',?,?,?,?,p.id,p.name,pp.cost_cents FROM catalog_plans c JOIN partner_prices pp ON pp.plan=c.id JOIN partners p ON p.id=pp.partner_id WHERE c.id=? AND c.enabled=1 AND c.version=? AND pp.version=? AND p.id=? AND p.active=1 AND p.version=? AND c.partner_enabled=1 AND NOT EXISTS(SELECT 1 FROM partner_product_order po,json_each(po.hidden_product_ids) h WHERE po.partner_id=p.id AND h.value=c.product_id) ON CONFLICT(owner_hash,idempotency_key) DO NOTHING")
          .bind(id, ownerHash, data.key, now, now, eventId, email, plan.id, plan.version, offer.version, partner.id, partner.version)
        : env.INTEREST_DB.prepare("INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,status,created_at,updated_at,last_event_id,customer_email) SELECT ?,?,?,id,name,price_cents,'pending',?,?,?,? FROM catalog_plans WHERE id=? AND enabled=1 AND version=? ON CONFLICT(owner_hash,idempotency_key) DO NOTHING")
          .bind(id, ownerHash, data.key, now, now, eventId, email, plan.id, plan.version),
        env.INTEREST_DB.prepare('UPDATE orders SET purchase_note=(SELECT purchase_note FROM catalog_plans WHERE id=orders.plan) WHERE id=?').bind(id),
        ...(live ? [env.INTEREST_DB.prepare("UPDATE orders SET mode='live' WHERE id=? AND payment_status='unpaid'").bind(id)] : []),
        ...(xgift ? [await xgiftSnapshotStatement(env, id, xgift)] : []),
        ...(snapshot ? [snapshotStatement(env, id, snapshot, price)] : []),
        ...(gmail ? [gmailSnapshotStatement(env, id, gmail)] : []),
        ...(delivery_supplier ? [delivery_supplierSnapshotStatement(env, id, delivery_supplier)] : []),
        env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,to_status,note,order_version,created_at) SELECT ?,id,'customer','create','pending',?,0,? FROM orders WHERE id=? ON CONFLICT DO NOTHING").bind(eventId, live ? '创建订单，等待支付' : '创建测试订单', now, id),
      ])
      const created = await env.INTEREST_DB.prepare('SELECT * FROM orders WHERE owner_hash=? AND idempotency_key=?').bind(ownerHash, data.key).first<Order>()
      if (!created || created.customer_email !== email || created.plan !== plan.id || created.partner_id !== (partner?.id ?? null)) throw new ApiError('商品已更新，请刷新后重试。', 409)
      if (xgift && (await xgiftSummary(env, created))?.username !== xgift.username) throw new ApiError('请求编号已绑定其他接收账号。', 409)
      return json({ order: await customerOrder(env, created) }, 201)
    }
    const match = path.match(/^\/api\/orders\/([A-Z0-9-]+)(\/demo-actions|\/refunds|\/payment|\/fulfillment)?$/)
    if (match) {
      let o = await getOrder(env, match[1], ownerHash, recoveredEmail)
      if (match[2] === '/payment') {
        if (o.mode === 'live' && !o.is_test && await findRechargeOrder(env, o.id)) throw new ApiError('请使用订单付款入口和刷新进度。', 409)
        return await paymentAction(request, env, o)
      }
      if (match[2] === '/fulfillment') {
        if (isXGiftPlan(o.plan)) throw new ApiError('此商品付款后自动赠送，请刷新原订单进度。', 409)
        await rechargeAction(request, env, o)
        return json({ order: await customerOrder(env, await getOrder(env, o.id)) })
      }
      if (match[2] === '/refunds') return await customerRefunds(request, env, o)
      if (!match[2] && method === 'GET') {
        o = await settle(env, o)
        if (isXGiftPlan(o.plan)) { await fulfillXGift(env, o.id); o = await getOrder(env, o.id) }
        let syncError = false
        try { o = await syncRechargeOrder(env, o) } catch { syncError = true /* Never replace a confirmed result with a network failure. */ }
        return json({ order: await customerOrder(env, o, undefined, syncError) })
      }
      if (match[2] && method === 'POST') {
        const data = await body(request)
        if (o.redemption_blocked) throw new ApiError('本订单已禁止再次兑换，请联系支持。', 409)
        if (o.refund_hold || o.refunded_cents >= o.price_cents) throw new ApiError('订单正在售后或已全额退款，不能继续履约。', 409)
        if (o.mode !== 'demo') throw new ApiError('该订单不支持此操作。', 403)
        if (env.ORDER_TESTING_ENABLED !== 'true' && data.action !== 'cancel') throw new ApiError('此历史记录不支持继续付款或交付。', 409)
        if (data.version !== o.version) throw new ApiError('订单已更新，请刷新后再操作。', 409)
        const action = data.action
        let patch: Partial<Order> | undefined
        if (action === 'pay' && o.status === 'pending') patch = { status: 'session', payment_status: 'simulated' }
        if (action === 'cancel' && o.status === 'pending') patch = { status: 'cancelled' }
        if (action === 'acquire-phone' && o.plan === 'codex-sms-once' && o.status === 'session' && !o.sms_phone) patch = { sms_phone: '+1 202-555-0147' }
        if ((action === 'submit-success' || action === 'submit-failed') && o.status === 'session' && (o.plan !== 'codex-sms-once' || o.sms_phone)) patch = { status: 'processing', started_at: Date.now(), outcome: action === 'submit-success' ? 'success' : 'failed' }
        if (action === 'retry' && o.status === 'failed') patch = { status: 'session', started_at: null, outcome: null }
        if (!patch) throw new ApiError('当前状态不支持此操作，请刷新订单。', 409)
        const actionNotes: Record<string, string> = { pay: '测试状态已更新（无实际收款）', cancel: '用户关闭未付款订单', 'acquire-phone': '写入测试号码（不提供接码服务）', 'submit-success': '提交内部任务（成功场景）', 'submit-failed': '提交内部任务（失败场景）', retry: '重新开启内部任务' }
        o = await change(env, o, patch, 'customer', String(action), actionNotes[String(action)])
        return json({ order: await customerOrder(env, o) })
      }
    }
    throw new ApiError('未找到接口或请求方法不支持。', 404)
  } catch (e) {
    if (e instanceof RechargeError) return json({ error: e.message, code: e.code, retryable: e.retryable, retryAfter: e.retryAfter }, e.status, e.retryAfter === null ? {} : { 'Retry-After': String(e.retryAfter) })
    return json({ error: e instanceof ApiError ? e.message : '服务暂时不可用，请稍后重试。' }, e instanceof ApiError ? e.status : 503)
  }
}

async function admin(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname; const method = request.method; const db = env.INTEREST_DB
  if (path === '/api/admin/payments/reconcile' && method === 'POST') { await body(request); return json(await reconcilePayments(env)) }
  if (path === '/api/admin/recharge/reconcile' && method === 'POST') { await body(request); return json(await reconcileRecharge(env)) }
  if (path === '/api/admin/overview' && method === 'GET') {
    // Only settle demo work. Production reconciliation needs a verified provider.
    await settleDue(env)
    const stats = await db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending, SUM(CASE WHEN status IN ('session','processing','failed') AND refunded_cents<price_cents THEN 1 ELSE 0 END) active, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) completed, COALESCE(SUM(CASE WHEN mode='demo' AND payment_status='simulated' THEN price_cents ELSE 0 END),0) demo_amount, COALESCE(SUM(CASE WHEN mode='live' AND payment_status='paid' THEN price_cents-MAX(refunded_cents,COALESCE((SELECT t.refunded_cents FROM recharge_orders t WHERE t.order_id=orders.id),0)) ELSE 0 END),0) paid_amount, COALESCE(SUM(CASE WHEN mode='live' THEN MAX(refunded_cents,COALESCE((SELECT t.refunded_cents FROM recharge_orders t WHERE t.order_id=orders.id),0)) ELSE 0 END),0) refund_amount FROM orders WHERE is_test=0").first()
    const interest = await db.prepare('SELECT COUNT(*) total FROM launch_interest').first()
    const recent = (await db.prepare('SELECT orders.*, (SELECT status FROM partner_payouts WHERE id=orders.payout_id) settlement_status FROM orders WHERE is_test=0 ORDER BY created_at DESC LIMIT 6').all<AdminOrder>()).results
    return json({ stats, interest, recent: await Promise.all(recent.map(o => adminOrder(env, o))), integrations: { alipay: alipayConfigured(env), supplier: supplierConfigured(env), supplierCheckout: supplierCheckoutEnabled(env), resend: mailConfigured(env) }, mode: supplierCheckoutEnabled(env) ? 'live' : 'demo' })
  }
  if (path === '/api/admin/orders' && method === 'GET') {
    await settleDue(env)
    const { page, offset } = pageParams(url); const q = url.searchParams.get('q')?.trim() ?? ''; const status = url.searchParams.get('status') ?? ''; const plan = url.searchParams.get('plan') ?? ''
    if (q.length > 320 || (status && !statuses.includes(status as Status))) throw new ApiError('筛选条件无效。')
    const values: Value[] = []; const clauses: string[] = []
    if (q) { clauses.push("(instr(id,?) > 0 OR instr(lower(COALESCE(customer_email,'')),?) > 0 OR EXISTS(SELECT 1 FROM recharge_orders t WHERE t.order_id=orders.id AND instr(lower(t.remote_id),?) > 0))"); values.push(q.toUpperCase(), q.toLowerCase(), q.toLowerCase()) }
    if (status) { clauses.push('status=?'); values.push(status) }
    if (plan) { clauses.push('plan=?'); values.push(plan) }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''
    const count = await db.prepare('SELECT COUNT(*) total FROM orders' + where).bind(...values).first<{ total: number }>()
    const rows = (await db.prepare('SELECT orders.*, (SELECT status FROM partner_payouts WHERE id=orders.payout_id) settlement_status FROM orders' + where + ' ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET ?').bind(...values, offset).all<AdminOrder>()).results
    return json({ orders: await Promise.all(rows.map(o => adminOrder(env, o))), total: count?.total ?? 0, page })
  }
  const orderMatch = path.match(/^\/api\/admin\/orders\/([A-Z0-9-]+)(\/actions|\/platform-status|\/delivery|\/account_supplier|\/delivery_supplier)?$/)
  if (orderMatch) {
    const o = await settle(env, await getOrder(env, orderMatch[1]))
    if (orderMatch[2] === '/delivery') return emailDeliveryRoute(request, env, o)
    if (orderMatch[2] === '/delivery_supplier') {
      if (method === 'POST') {
        const data = await body(request)
        if (data.action === 'confirm-not-purchased') return confirmDeliverySupplierNotPurchased(env, o, data)
        if (data.action === 'retry-rejected-receipt') return retryDeliverySupplierRejectedReceipt(env, o, data)
        if (data.action && data.action !== 'sync') throw new ApiError('采购操作无效。')
        await fulfillDeliverySupplier(env, o.id)
      }
      else if (method !== 'GET') throw new ApiError('请求方式不支持。', 405)
      return delivery_supplierAdmin(env, o.id)
    }
    if (orderMatch[2] === '/account_supplier') {
      if (o.plan !== 'gmail-account') throw new ApiError('该订单不是 Gmail 商品。', 409)
      if (method === 'POST') {
        const data = await body(request)
        if (data.action === 'confirm-not-purchased') return confirmGmailNotPurchased(env, o, data)
        if (data.action && data.action !== 'sync') throw new ApiError('采购操作无效。')
        await fulfillGmail(env, o.id)
      }
      else if (method !== 'GET') throw new ApiError('请求方式不支持。', 405)
      return adminGmailOrder(env, o)
    }
    if (!orderMatch[2] && method === 'GET') {
      const events = (await db.prepare('SELECT id,actor,action,from_status,to_status,note,created_at FROM order_events WHERE order_id=? ORDER BY order_version').bind(o.id).all()).results
      const settlement = await db.prepare('SELECT ps.status settlement_status FROM orders o LEFT JOIN partner_payouts ps ON ps.id=o.payout_id WHERE o.id=?').bind(o.id).first<{ settlement_status: 'pending' | 'paid' | null }>()
      return json({ order: { ...(await customerOrder(env, o)), platformStatus: await platformOrderStatus(env, o), settlementStatus: settlement?.settlement_status ?? null, partnerSource: await orderPartnerSource(env, o) }, events })
    }
    if (orderMatch[2] === '/platform-status' && method === 'POST') {
      await body(request)
      const next = await queryPlatformOrder(env, o)
      const platformStatus = await platformOrderStatus(env, next)
      await db.prepare('INSERT INTO admin_audit(id,action,target_id,note,created_at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(), 'platform-order-query', o.id, `${env.ADMIN_USERNAME}: ${platformStatus?.paymentStatus}; refunded=${platformStatus?.refundedCents}; fulfillment=${next.status}`, Date.now()).run()
      return json({ platformStatus })
    }
    if (orderMatch[2] === '/actions' && method === 'POST') {
      const data = await body(request); const note = requiredNote(data)
      if (data.version !== o.version) throw new ApiError('订单已更新，请刷新详情后重试。', 409)
      if (data.action === 'xgift-recovery') {
        await recoverXGift(env, o, note)
        await fulfillXGift(env, o.id)
        return json({ order: await customerOrder(env, await getOrder(env, o.id)) })
      }
      if (data.action === 'redemption-control') {
        if (typeof data.blocked !== 'boolean') throw new ApiError('请选择有效的兑换权限。')
        return json({ order: await customerOrder(env, await setRedemptionBlocked(env, o, data.blocked, note)) })
      }
      let patch: Partial<Order> | undefined
      if (data.action === 'note') patch = {}
      if (o.payment_status === 'paid' && isLegacyManualOrder(o, Boolean(await findRechargeOrder(env, o.id)))) {
        if (data.action === 'manual-start' && o.status === 'session') patch = { status: 'processing', started_at: Date.now() }
        if (data.action === 'manual-complete' && ['session', 'processing'].includes(o.status)) patch = { status: 'success' }
      }
      if (o.mode === 'demo' && data.action === 'cancel' && o.status === 'pending') patch = { status: 'cancelled' }
      if (o.mode === 'demo' && data.action === 'retry' && o.status === 'failed') patch = { status: 'session', started_at: null, outcome: null }
      if (!patch) throw new ApiError('当前状态不支持此操作。', 409)
      if (data.action !== 'note' && o.redemption_blocked) throw new ApiError('请先解除禁止兑换标记。', 409)
      if (data.action !== 'note' && (o.refund_hold || o.refunded_cents >= o.price_cents)) throw new ApiError('售后中的订单不能执行此操作。', 409)
      const next = await change(env, o, patch, 'admin:' + env.ADMIN_USERNAME, String(data.action), note)
      return json({ order: await customerOrder(env, next) })
    }
  }
  if (path === '/api/admin/plans' && method === 'GET') return json({ plans: await plans(env) })
  const planMatch = path.match(/^\/api\/admin\/plans\/([a-z0-9-]+)$/)
  if (planMatch && method === 'POST') {
    const data = await body(request); const note = requiredNote(data)
    if (!Number.isSafeInteger(data.priceCents) || Number(data.priceCents) < 1 || Number(data.priceCents) > 10000000 || typeof data.enabled !== 'boolean' || !Number.isInteger(data.version)) throw new ApiError('价格或商品状态无效。')
    if (data.partnerEnabled !== undefined && typeof data.partnerEnabled !== 'boolean') throw new ApiError('代理销售设置无效。')
    if ((data.purchaseNote !== undefined && (typeof data.purchaseNote !== 'string' || data.purchaseNote.length > 2000)) || (data.deliveryInstructions !== undefined && (typeof data.deliveryInstructions !== 'string' || data.deliveryInstructions.length > 2000))) throw new ApiError('商品说明最多 2000 字。')
    const plan = await db.prepare('SELECT * FROM catalog_plans WHERE id=?').bind(planMatch[1]).first<Plan>()
    if (!plan) throw new ApiError('套餐不存在。', 404)
    if (plan.version !== data.version) throw new ApiError('套餐已更新，请刷新后重试。', 409)
    const eventId = crypto.randomUUID()
    // Audit insert and update share a transaction and the same version guard.
    await db.batch([
      db.prepare('INSERT INTO admin_audit(id,action,target_id,note,created_at) SELECT ?,?,?,?,? FROM catalog_plans WHERE id=? AND version=?').bind(eventId, 'plan-update', plan.id, `${env.ADMIN_USERNAME}: ${plan.price_cents}→${data.priceCents}; enabled ${plan.enabled}→${Number(data.enabled)}; ${note}`, Date.now(), plan.id, plan.version),
      db.prepare('UPDATE catalog_plans SET price_cents=?,enabled=?,purchase_note=COALESCE(?,purchase_note),delivery_instructions=COALESCE(?,delivery_instructions),partner_enabled=COALESCE(?,partner_enabled),version=version+1,updated_at=? WHERE id=? AND version=?').bind(Number(data.priceCents), Number(data.enabled), typeof data.purchaseNote === 'string' ? data.purchaseNote.trim() : null, typeof data.deliveryInstructions === 'string' ? data.deliveryInstructions.trim() : null, typeof data.partnerEnabled === 'boolean' ? Number(data.partnerEnabled) : null, Date.now(), plan.id, plan.version),
    ])
    if (!await db.prepare('SELECT id FROM admin_audit WHERE id=?').bind(eventId).first()) throw new ApiError('套餐已更新，请刷新后重试。', 409)
    return json({ ok: true })
  }
  if (path === '/api/admin/interest' && method === 'GET') {
    const { page, offset } = pageParams(url)
    const count = await db.prepare('SELECT COUNT(*) total FROM launch_interest').first<{ total: number }>()
    const rows = (await db.prepare('SELECT id,product,email,consent_version,created_at FROM launch_interest ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET ?').bind(offset).all()).results
    return json({ rows, total: count?.total ?? 0, page, deliveryEnabled: false })
  }
  if (path === '/api/admin/audit' && method === 'GET') {
    const rows = (await db.prepare("SELECT * FROM admin_audit WHERE action='plan-update' ORDER BY created_at DESC LIMIT 100").all()).results
    return json({ rows })
  }
  throw new ApiError('未找到管理接口。', 404)
}
