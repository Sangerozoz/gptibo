import { eligibleSql, profitSql, MIN_PAYOUT_CENTS, PAYOUT_COOLDOWN_MS } from './finance.ts'
import { settleDue, type Order } from './order-state.ts'
import { syncRechargeOrder } from './recharge/service.ts'
import { ApiError, body, json, type Env } from './platform.ts'
import { emailValue, mailConfigured, partnerLimit, requirePartner, sendPartnerInvitation, type Partner } from './partner-auth.ts'
import { referralCodePattern } from '../shared/partner-link.ts'
import { provisionPartner } from './partner-provision.ts'
import { supportContactsRoute, supportContactsSettings } from './support-contacts.ts'
import { uploadDirectMedia } from './direct-store.ts'
import { announcementRoute, announcementSettings } from './announcements.ts'
import { defaultSupplyRoute } from './partner-default-prices.ts'
import { visitorSummary } from './visitors.ts'
import { notifyPayout } from './payout-notifications.ts'
import { partnerRanking } from './partner-ranking.ts'
import { customerRoutes } from './customers.ts'
import { resetPayoutCooldown } from './payout-cooldown.ts'
import { productOrderRoute, productOrderSettings } from './product-order.ts'
import { partnerOrderSummary } from './partner-order-summary.ts'

export async function resolvePartner(env: Env, slug: unknown) {
  if (slug === undefined || slug === null || slug === '') return null
  if (env.PARTNER_MODE_ENABLED === 'false') throw new ApiError('代理商店暂未开放。', 404)
  if (typeof slug !== 'string' || (!referralCodePattern.test(slug) && !/^[a-z0-9][a-z0-9-]{2,31}$/.test(slug))) throw new ApiError('推广链接无效。', 404)
  const p = await env.INTEREST_DB.prepare('SELECT * FROM partners WHERE slug=? AND active=1').bind(slug).first<Partner>()
  if (!p) throw new ApiError('该代理商店暂不可用，请联系平台支持。', 404)
  return p
}
export async function partnerCatalog(env: Env, p: Partner) {
  const rows = (await env.INTEREST_DB.prepare('SELECT c.id,c.product_id,c.name,c.purchase_note,pp.price_cents,CASE WHEN c.partner_enabled=1 THEN c.enabled ELSE 0 END enabled,c.renewal_only,pp.version FROM catalog_plans c JOIN partner_prices pp ON pp.plan=c.id WHERE pp.partner_id=? ORDER BY c.rowid').bind(p.id).all<{ product_id: string }>()).results
  const { productIds, hiddenProductIds = [] } = await productOrderSettings(env, p.id)
  return { plans: rows.filter(row => !hiddenProductIds.some(id => id === row.product_id)), productOrder: productIds, hiddenProductIds, partner: { name: p.name, slug: p.slug }, mode: 'demo' }
}
const eligible = eligibleSql()
const profit = profitSql()
const debitSql = 'COALESCE((SELECT SUM(d.amount_cents) FROM partner_debits d WHERE d.partner_id=orders.partner_id AND d.payout_id IS NULL),0)'
// Only already-paid commissions can create debt that blocks unrelated earnings.
// Unsettled refunds remain excluded by eligibleSql; pending payout items are
// independently revalidated before approval.
const paidRefundHoldSql = (partnerId: string) => `EXISTS(SELECT 1 FROM orders h JOIN partner_payouts hp ON hp.id=h.payout_id LEFT JOIN recharge_orders t ON t.order_id=h.id WHERE h.partner_id=${partnerId} AND hp.status='paid' AND (h.refund_hold=1 OR (h.payment_status='paid' AND t.financial_hold=1)))`
const paidRefundHold = paidRefundHoldSql('orders.partner_id')
const priceText = (value: number) => '¥' + (value / 100).toFixed(2)
const planText = (id: string) => ({ plus: 'ChatGPT Plus', 'pro-5x': 'ChatGPT Pro 5×', 'pro-20x': 'ChatGPT Pro 10×', 'pro-25x': 'ChatGPT Pro 25×', 'codex-sms-once': 'Codex 接码' })[id] ?? id
function page(url: URL) { const n = Number(url.searchParams.get('page') ?? 1); if (!Number.isInteger(n) || n < 1 || n > 10000) throw new ApiError('页码无效。'); return n }
function cents(v: unknown) { if (!Number.isSafeInteger(v) || Number(v) < 1 || Number(v) > 10000000) throw new ApiError('价格需为 0.01–100000 元，最多两位小数。'); return Number(v) }
function text(v: unknown, max: number, label: string) { if (typeof v !== 'string' || !v.trim() || v.trim().length > max) throw new ApiError(`请填写有效的${label}。`); return v.trim() }
const audit = (env: Env, id: string, target: string, action: string, note: string) => env.INTEREST_DB.prepare('INSERT INTO admin_audit(id,target_id,action,note,created_at) VALUES (?,?,?,?,?)').bind(id, target, action, note, Date.now())
async function verifySupplierPayout(env: Env, partnerId: string, payoutId?: string) {
  const where = payoutId ? 'o.payout_id=?' : "o.partner_id=? AND o.payout_id IS NULL AND o.payment_status='paid' AND o.status='success' AND o.refund_hold=0 AND t.financial_hold=0"
  const rows = (await env.INTEREST_DB.prepare(`SELECT o.* FROM orders o JOIN recharge_orders t ON t.order_id=o.id WHERE ${where}`).bind(payoutId ?? partnerId).all<Order>()).results
  // Financial mutations must query the original supplier order, including delivered orders.
  // A failed/uncertain query aborts this payout operation without reserving or approving it.
  for (let i=0;i<rows.length;i+=5) await Promise.all(rows.slice(i,i+5).map(o => syncRechargeOrder(env,o,true)))
}
export async function partnerDashboard(env: Env, p: Partner) {
  await settleDue(env, p.id)
  const plans = (await env.INTEREST_DB.prepare('SELECT c.id,c.product_id,c.name,CASE WHEN c.partner_enabled=1 THEN c.enabled ELSE 0 END enabled,c.renewal_only,pp.cost_cents,pp.price_cents,pp.version FROM catalog_plans c JOIN partner_prices pp ON pp.plan=c.id WHERE pp.partner_id=? ORDER BY c.rowid').bind(p.id).all()).results
  const stats = await env.INTEREST_DB.prepare(`SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN mode='demo' AND status='success' THEN ${profit} ELSE 0 END),0) demo_profit, COALESCE(SUM(CASE WHEN ${eligible} AND payout_id IS NULL THEN ${profit} ELSE 0 END),0) available FROM orders WHERE partner_id=?`).bind(p.id).first<{total:number;demo_profit:number;available:number}>()
  const debts = await env.INTEREST_DB.prepare('SELECT COALESCE(SUM(amount_cents),0) amount FROM partner_debits WHERE partner_id=? AND payout_id IS NULL').bind(p.id).first<{amount:number}>()
  const held = await env.INTEREST_DB.prepare(`SELECT ${paidRefundHoldSql('?')} n`).bind(p.id).first<{n:number}>()
  const payouts = (await env.INTEREST_DB.prepare('SELECT * FROM partner_payouts WHERE partner_id=? ORDER BY created_at DESC LIMIT 20').bind(p.id).all()).results
  const totals = await env.INTEREST_DB.prepare("SELECT COALESCE(SUM(CASE WHEN status='pending' THEN amount_cents ELSE 0 END),0) pending,COALESCE(SUM(CASE WHEN status='paid' THEN amount_cents ELSE 0 END),0) paid FROM partner_payouts WHERE partner_id=?").bind(p.id).first()
  const lastPayout = await env.INTEREST_DB.prepare('SELECT MAX(created_at) created_at FROM partner_payouts WHERE partner_id=? AND cooldown_exempt=0').bind(p.id).first<{created_at:number|null}>()
  const nextPayoutAt = lastPayout?.created_at == null ? null : lastPayout.created_at + PAYOUT_COOLDOWN_MS
  return { partner: p, plans, stats: { ...stats, available: Math.max(0,(stats?.available ?? 0)-(debts?.amount ?? 0)), debt: debts?.amount ?? 0, withdrawalHeld: Boolean(held?.n), minimum: MIN_PAYOUT_CENTS, nextPayoutAt, payoutCoolingDown: nextPayoutAt !== null && Date.now() < nextPayoutAt }, payouts, totals, mailReady: mailConfigured(env) }
}
async function orders(env: Env, id: string, url: URL) {
  await settleDue(env, id)
  const n = page(url)
  const rows = (await env.INTEREST_DB.prepare(`SELECT o.id,o.customer_email,o.plan,o.plan_name,o.price_cents,o.cost_cents,o.refunded_cents,t.payment_status platform_payment_status,t.refunded_cents platform_refunded_cents,t.verified_at platform_checked_at,MAX(o.refund_hold,CASE WHEN o.payment_status='paid' THEN COALESCE(t.financial_hold,0) ELSE 0 END) refund_hold,${profitSql('o')} profit_cents,o.mode,o.payment_status,o.status,o.created_at,ps.status payout_status,ps.reviewed_at FROM orders o LEFT JOIN partner_payouts ps ON ps.id=o.payout_id LEFT JOIN recharge_orders t ON t.order_id=o.id WHERE o.partner_id=? ORDER BY o.created_at DESC,o.id DESC LIMIT 20 OFFSET ?`).bind(id, (n - 1) * 20).all()).results
  const count = await env.INTEREST_DB.prepare('SELECT COUNT(*) total FROM orders WHERE partner_id=?').bind(id).first<{ total: number }>()
  return json({ rows, total: count?.total ?? 0, page: n })
}
export async function partnerRoutes(request: Request, env: Env, url: URL) {
  if (url.pathname.startsWith('/api/partner/customers')) return customerRoutes(request,env,url)
  const p = await requirePartner(request, env); const path = url.pathname; const db = env.INTEREST_DB
  if (path === '/api/partner/visitors' && request.method === 'GET') return json(await visitorSummary(env, url, p.id))
  if (path === '/api/partner/support-contacts') return supportContactsRoute(request, env, p)
  if (path === '/api/partner/support-contacts/media') return uploadDirectMedia(request, env)
  if (path === '/api/partner/announcement') return announcementRoute(request, env, p)
  if (path === '/api/partner/product-order') return productOrderRoute(request, env, p)
  if (path === '/api/partner/dashboard' && request.method === 'GET') return json(await partnerDashboard(env, p))
  if (path === '/api/partner/orders' && request.method === 'GET') return orders(env, p.id, url)
  if (path === '/api/partner/order-summary' && request.method === 'GET') {
    await settleDue(env, p.id)
    return json(await partnerOrderSummary(env, p.id, url))
  }
  const match = path.match(/^\/api\/partner\/prices\/([a-z0-9-]+)$/)
  if (match && request.method === 'POST') {
    const data = await body(request); const price = cents(data.priceCents)
    const row = await db.prepare('SELECT * FROM partner_prices WHERE partner_id=? AND plan=?').bind(p.id, match[1]).first<{ cost_cents: number; price_cents: number; version: number }>()
    if (!row) throw new ApiError('该套餐尚未开通。', 404)
    if (data.version !== row.version) throw new ApiError('价格已更新，请刷新后再修改。', 409)
    if (price < row.cost_cents) throw new ApiError('售价不能低于供货价。')
    const id = crypto.randomUUID()
    await db.batch([
      db.prepare("INSERT INTO admin_audit(id,target_id,action,note,created_at) SELECT ?,partner_id,'partner-price',?,? FROM partner_prices WHERE partner_id=? AND plan=? AND version=? AND EXISTS(SELECT 1 FROM partners WHERE id=? AND active=1 AND auth_version=?)").bind(id, `代理调整 ${planText(match[1])} 售价：${priceText(row.price_cents)} → ${priceText(price)}`, Date.now(), p.id, match[1], row.version, p.id, p.auth_version),
      db.prepare('UPDATE partner_prices SET price_cents=?,version=version+1 WHERE partner_id=? AND plan=? AND version=? AND EXISTS(SELECT 1 FROM admin_audit WHERE id=?)').bind(price, p.id, match[1], row.version, id),
    ])
    if (!await db.prepare('SELECT id FROM admin_audit WHERE id=?').bind(id).first()) throw new ApiError('账号或价格已更新，请刷新后重试。', 409)
    return json({ ok: true })
  }
  if (path === '/api/partner/payouts' && request.method === 'POST') {
    const data = await body(request); const recipient = text(data.recipient, 200, '支付宝收款账号与姓名')
    if (typeof data.key !== 'string' || !/^[a-f0-9-]{36}$/.test(data.key)) throw new ApiError('请求编号无效。')
    const existing = await db.prepare('SELECT id FROM partner_payouts WHERE partner_id=? AND request_key=?').bind(p.id, data.key).first()
    if (existing) return json({ ok: true })
    await verifySupplierPayout(env,p.id)
    const id = crypto.randomUUID(); const auditId = crypto.randomUUID(); const now = Date.now()
    // Reserve all currently eligible orders in the same transaction as the request.
    await db.batch([
      db.prepare(`INSERT INTO partner_payouts(id,partner_id,amount_cents,gross_cents,deduction_cents,recipient,created_at,request_key) SELECT ?,?,SUM(${profit})-${debitSql},SUM(${profit}),${debitSql},?,?,? FROM orders WHERE partner_id=? AND ${eligible} AND payout_id IS NULL AND NOT ${paidRefundHold} AND EXISTS(SELECT 1 FROM partners WHERE id=? AND active=1 AND auth_version=?) AND NOT EXISTS(SELECT 1 FROM partner_payouts recent WHERE recent.partner_id=? AND recent.cooldown_exempt=0 AND recent.created_at>?) HAVING SUM(${profit})-${debitSql}>=${MIN_PAYOUT_CENTS} ON CONFLICT DO NOTHING`).bind(id, p.id, recipient, now, data.key, p.id, p.id, p.auth_version, p.id, now-PAYOUT_COOLDOWN_MS),
      db.prepare(`UPDATE orders SET payout_id=? WHERE partner_id=? AND ${eligible} AND payout_id IS NULL AND EXISTS(SELECT 1 FROM partner_payouts WHERE id=?)`).bind(id, p.id, id),
      db.prepare(`INSERT INTO partner_payout_items(payout_id,order_id,profit_cents) SELECT ?,id,${profit} FROM orders WHERE payout_id=?`).bind(id, id),
      db.prepare('UPDATE partner_debits SET payout_id=? WHERE partner_id=? AND payout_id IS NULL AND EXISTS(SELECT 1 FROM partner_payouts WHERE id=?)').bind(id,p.id,id),
      db.prepare('INSERT INTO partner_payout_debit_items(payout_id,debit_id,amount_cents) SELECT payout_id,id,amount_cents FROM partner_debits WHERE payout_id=?').bind(id),
      db.prepare("INSERT INTO admin_audit(id,target_id,action,note,created_at) SELECT ?,partner_id,'payout-request',id,? FROM partner_payouts WHERE id=?").bind(auditId, Date.now(), id),
      db.prepare('INSERT INTO payout_notifications(payout_id,created_at) SELECT id,created_at FROM partner_payouts WHERE id=?').bind(id),
    ])
    if (!await db.prepare('SELECT id FROM partner_payouts WHERE partner_id=? AND request_key=?').bind(p.id, data.key).first()) throw new ApiError('可提现余额需满 ¥10，两次申请需间隔 24 小时，且没有待处理提现或已结算订单的未完成售后。请刷新查看下次可申请时间。', 409)
    await notifyPayout(env, id)
    return json({ ok: true }, 201)
  }
  throw new ApiError('未找到代理接口。', 404)
}
export async function adminPartnerRoutes(request: Request, env: Env, url: URL) {
  const path = url.pathname; const db = env.INTEREST_DB; const method = request.method
  if (path === '/api/admin/partners/payout-cooldown/reset') return resetPayoutCooldown(request, env)
  const cooldownMatch = path.match(/^\/api\/admin\/partners\/([a-f0-9-]{36})\/payout-cooldown\/reset$/)
  if (cooldownMatch) return resetPayoutCooldown(request, env, cooldownMatch[1])
  if (path === '/api/admin/partners/ranking' && method === 'GET') return json(await partnerRanking(env, url))
  if (path === '/api/admin/partners/default-prices') return defaultSupplyRoute(request, env)
  const visitorMatch = path.match(/^\/api\/admin\/partners\/([a-f0-9-]{36})\/visitors$/)
  if (visitorMatch && method === 'GET') {
    if (!await db.prepare('SELECT id FROM partners WHERE id=?').bind(visitorMatch[1]).first()) throw new ApiError('代理不存在。', 404)
    return json(await visitorSummary(env, url, visitorMatch[1]))
  }
  if (path === '/api/admin/partners' && method === 'GET') {
    const n = page(url); const q = (url.searchParams.get('q') ?? '').trim(); if (q.length > 100) throw new ApiError('搜索内容过长。')
    const clause = ' WHERE instr(p.name,?)>0 OR instr(p.email,?)>0 OR instr(p.slug,?)>0'
    const rows = (await db.prepare("SELECT p.*,COALESCE(sc.wechat,'') wechat,COALESCE(sc.qq,'') qq FROM partners p LEFT JOIN support_contacts sc ON sc.partner_id=p.id" + clause + ' ORDER BY p.created_at DESC,p.id DESC LIMIT 20 OFFSET ?').bind(q, q, q, (n - 1) * 20).all()).results
    const count = await db.prepare('SELECT COUNT(*) total FROM partners p' + clause).bind(q, q, q).first<{ total: number }>()
    return json({ rows, total: count?.total ?? 0, page: n, mailReady: mailConfigured(env) })
  }
  if (path === '/api/admin/partners' && method === 'POST') {
    const data = await body(request); const email = emailValue(data.email)
    const p = await provisionPartner(env, email, env.ADMIN_USERNAME ?? '管理员')
    const { id, slug } = p
    let invitationSent = false
    try { await sendPartnerInvitation(env, p!); invitationSent = true } catch { /* Keep the account and link; the administrator can resend the invitation. */ }
    return json({ ok: true, id, slug, invitationSent, message: invitationSent ? '代理已开通，邀请邮件已发送。代理可通过邮件中的工作台入口自行获取登录验证码。' : '代理已开通，但邀请邮件发送失败。请在代理详情中重发。' }, 201)
  }
  const match = path.match(/^\/api\/admin\/partners\/([a-f0-9-]{36})(?:\/(prices\/([a-z0-9-]+)|orders|order-summary|preview|invitation|support-contacts|announcement|product-order))?$/)
  if (match) {
    const p = await db.prepare('SELECT * FROM partners WHERE id=?').bind(match[1]).first<Partner>()
    if (!p) throw new ApiError('代理不存在。', 404)
    if (match[2] === 'product-order') {
      if (method !== 'GET') throw new ApiError('请由代理在工作台调整商品排序。', 405)
      return json(await productOrderSettings(env, p.id))
    }
    if (match[2] === 'announcement') {
      if (method !== 'GET') throw new ApiError('请由代理在工作台修改公告。', 405)
      return json(await announcementSettings(env, p.id))
    }
    if (match[2] === 'support-contacts') {
      if (method !== 'GET') throw new ApiError('请由代理在工作台修改联系方式。', 405)
      return json(await supportContactsSettings(env, p.id))
    }
    if (match[2] === 'invitation') {
      if (method !== 'POST') throw new ApiError('请通过重发按钮发送邮件。', 405)
      await body(request)
      if (!p.active) throw new ApiError('请先启用代理再发送登录邮件。', 409)
      await partnerLimit(env, 'partner-invitation:' + p.id, 1, 60000)
      const telegramApplication = await db.prepare('SELECT id,email,mail_status FROM telegram_partner_applications WHERE partner_id=?').bind(p.id).first<{ id: string; email: string; mail_status: string }>()
      const sameApplication = telegramApplication?.email === p.email
      await sendPartnerInvitation(env, p, sameApplication && telegramApplication.mail_status === 'pending' ? 'telegram-' + telegramApplication.id : undefined)
      if (sameApplication) await db.prepare("UPDATE telegram_partner_applications SET mail_status='sent',notice_sent=0,next_attempt_at=? WHERE id=?").bind(Date.now(), telegramApplication.id).run()
      await audit(env, crypto.randomUUID(), p.id, 'partner-invitation', env.ADMIN_USERNAME + '：重发代理邀请邮件').run()
      return json({ ok: true, message: '邀请邮件已发送。代理可打开工作台自行获取登录验证码。' })
    }
    if (method === 'GET') {
      if (match[2] === 'orders') return orders(env, p.id, url)
      if (match[2] === 'order-summary') {
        await settleDue(env, p.id)
        return json(await partnerOrderSummary(env, p.id, url))
      }
      const auditRows = (await db.prepare('SELECT id,note,created_at FROM admin_audit WHERE target_id=? ORDER BY created_at DESC LIMIT 20').bind(p.id).all()).results
      const telegramApplication = await db.prepare('SELECT user_id,group_id,wechat,qq,email,created_at,mail_status FROM telegram_partner_applications WHERE partner_id=?').bind(p.id).first()
      return json({ ...await partnerDashboard(env, p), audit: auditRows, telegramApplication })
    }
    const data = await body(request); const id = crypto.randomUUID()
    if (!match[2] && method === 'POST') {
      const name = text(data.name, 40, '代理名称'); const email = emailValue(data.email)
      if (typeof data.active !== 'boolean' || data.version !== p.version) throw new ApiError('代理已更新，请刷新后重试。', 409)
      if (await db.prepare('SELECT id FROM partners WHERE email=? AND id<>?').bind(email, p.id).first()) throw new ApiError('邮箱已被使用。', 409)
      await db.batch([
        db.prepare("INSERT INTO admin_audit(id,target_id,action,note,created_at) SELECT ?,id,'partner-update',?,? FROM partners WHERE id=? AND version=?").bind(id, `${env.ADMIN_USERNAME}：${p.name} → ${name}；${data.active ? '启用' : '停用'}；${email !== p.email ? '登录邮箱已变更' : '邮箱不变'}`, Date.now(), p.id, p.version),
        db.prepare('UPDATE partners SET name=?,email=?,active=?,version=version+1,auth_version=auth_version+?,updated_at=? WHERE id=? AND version=?').bind(name, email, Number(data.active), email !== p.email || Number(data.active) !== p.active ? 1 : 0, Date.now(), p.id, p.version),
      ])
    } else if (match[3] && method === 'POST') {
      const cost = cents(data.costCents)
      const row = await db.prepare('SELECT * FROM partner_prices WHERE partner_id=? AND plan=?').bind(p.id, match[3]).first<{ price_cents: number; cost_cents: number; version: number }>()
      if (!row || data.version !== row.version) throw new ApiError('价格已更新，请刷新后重试。', 409)
      if (cost > row.price_cents) throw new ApiError('供货价不能高于当前代理售价，请先联系代理调整售价。')
      await db.batch([
        db.prepare("INSERT INTO admin_audit(id,target_id,action,note,created_at) SELECT ?,partner_id,'partner-cost',?,? FROM partner_prices WHERE partner_id=? AND plan=? AND version=?").bind(id, `${env.ADMIN_USERNAME} 调整 ${planText(match[3])} 供货价：${priceText(row.cost_cents)} → ${priceText(cost)}`, Date.now(), p.id, match[3], row.version),
        db.prepare('UPDATE partner_prices SET cost_cents=?,version=version+1 WHERE partner_id=? AND plan=? AND version=?').bind(cost, p.id, match[3], row.version),
      ])
    } else throw new ApiError('未找到操作。', 404)
    if (!await db.prepare('SELECT id FROM admin_audit WHERE id=?').bind(id).first()) throw new ApiError('数据已更新，请刷新后重试。', 409)
    return json({ ok: true })
  }
  if (path === '/api/admin/partner-payouts' && method === 'GET') {
    const n = page(url)
    const rows = (await db.prepare('SELECT ps.*,p.name partner_name FROM partner_payouts ps JOIN partners p ON p.id=ps.partner_id ORDER BY CASE WHEN ps.status=\'pending\' THEN 0 ELSE 1 END,ps.created_at DESC LIMIT 20 OFFSET ?').bind((n - 1) * 20).all()).results
    const count = await db.prepare('SELECT COUNT(*) total FROM partner_payouts').first<{ total: number }>()
    return json({ rows, total: count?.total ?? 0, page: n })
  }
  const payout = path.match(/^\/api\/admin\/partner-payouts\/([a-f0-9-]{36})$/)
  if (payout && method === 'GET') {
    const n = page(url)
    const items = (await db.prepare('SELECT i.order_id,i.profit_cents,o.plan_name FROM partner_payout_items i JOIN orders o ON o.id=i.order_id WHERE i.payout_id=? ORDER BY o.created_at LIMIT 20 OFFSET ?').bind(payout[1], (n - 1) * 20).all()).results
    const count = await db.prepare('SELECT COUNT(*) total FROM partner_payout_items WHERE payout_id=?').bind(payout[1]).first<{ total: number }>()
    const payoutRow = await db.prepare('SELECT * FROM partner_payouts WHERE id=?').bind(payout[1]).first()
    if (!payoutRow) throw new ApiError('提现不存在。',404)
    const deductions = (await db.prepare('SELECT i.amount_cents,r.order_id FROM partner_payout_debit_items i JOIN partner_debits d ON d.id=i.debit_id JOIN refund_cases r ON r.id=d.refund_id WHERE i.payout_id=?').bind(payout[1]).all()).results
    return json({ items, deductions, payout: payoutRow, total: count?.total ?? 0, page: n })
  }
  if (payout && method === 'POST') {
    const data = await body(request); const note = text(data.note, 300, '处理说明')
    if (!['approve', 'paid', 'rejected'].includes(String(data.action))) throw new ApiError('处理方式无效。')
    const reference = data.action === 'paid' ? text(data.reference, 100, '线下付款流水号') : ''
    const ps = await db.prepare('SELECT * FROM partner_payouts WHERE id=?').bind(payout[1]).first<{ id: string; version: number; status: string; reviewed_at: number | null }>()
    if (!ps || ps.status !== 'pending' || ps.version !== data.version) throw new ApiError('结算申请已处理，请刷新。', 409)
    if (data.action === 'paid' && !ps.reviewed_at) throw new ApiError('请先审核通过，再登记转账结果。', 409)
    if (data.action === 'approve') {
      await verifySupplierPayout(env,'',ps.id)
      const event = crypto.randomUUID()
      await db.batch([
        db.prepare(`UPDATE partner_payouts SET review_token=?,reviewed_at=?,note=?,version=version+1 WHERE id=? AND status='pending' AND reviewed_at IS NULL AND version=? AND NOT EXISTS(SELECT 1 FROM orders o JOIN partner_payout_items i ON i.order_id=o.id AND i.payout_id=partner_payouts.id WHERE NOT (${eligibleSql('o')}) OR i.profit_cents<>${profitSql('o')}) AND NOT EXISTS(SELECT 1 FROM partner_debits WHERE partner_id=partner_payouts.partner_id AND payout_id IS NULL) AND NOT ${paidRefundHoldSql('partner_payouts.partner_id')}`).bind(event,Date.now(),note,ps.id,ps.version),
        db.prepare("INSERT INTO admin_audit(id,target_id,action,note,created_at) SELECT ?,id,'payout-review',?,? FROM partner_payouts WHERE id=? AND status='pending' AND version=? AND review_token=?").bind(event,note,Date.now(),ps.id,ps.version+1,event),
      ])
      if (!await db.prepare('SELECT id FROM admin_audit WHERE id=?').bind(event).first()) throw new ApiError('申请已更新或发生退款抵扣，请先退回申请并重新核算。',409)
      return json({ok:true})
    }
    const event = crypto.randomUUID()
    await db.batch([
      db.prepare("INSERT INTO admin_audit(id,target_id,action,note,created_at) SELECT ?,id,'payout-handle',?,? FROM partner_payouts WHERE id=? AND status='pending' AND version=?").bind(event, `${env.ADMIN_USERNAME}: ${data.action}; ${note}`, Date.now(), ps.id, ps.version),
      db.prepare('UPDATE partner_payouts SET status=?,note=?,reference=?,handled_at=?,version=version+1 WHERE id=? AND status=\'pending\' AND version=?').bind(String(data.action), note, reference, Date.now(), ps.id, ps.version),
      db.prepare("UPDATE partner_debits SET payout_id=NULL WHERE payout_id=? AND EXISTS(SELECT 1 FROM admin_audit WHERE id=?) AND EXISTS(SELECT 1 FROM partner_payouts WHERE id=? AND status='rejected')").bind(ps.id,event,ps.id),
      db.prepare("UPDATE orders SET payout_id=NULL WHERE payout_id=? AND EXISTS(SELECT 1 FROM admin_audit WHERE id=?) AND EXISTS(SELECT 1 FROM partner_payouts WHERE id=? AND status='rejected')").bind(ps.id, event, ps.id),
    ])
    if (!await db.prepare('SELECT id FROM admin_audit WHERE id=?').bind(event).first()) throw new ApiError('结算申请已处理，请刷新。', 409)
    return json({ ok: true })
  }
  throw new ApiError('未找到代理管理接口。', 404)
}
