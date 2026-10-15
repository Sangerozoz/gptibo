import { emailProduct, type AdminDelivery, type DeliverySummary } from '../shared/email-products.ts'
import { ApiError, body, json, type Env } from './platform.ts'
import { getOrder, type Order } from './order-state.ts'
import { alipayConfigured } from './payments/providers.ts'
import { directSiteEmail, membershipDeliveryMessage, sendMembershipPreviewEmail, siteEmail } from './email.ts'
import { boundedResponseText } from './bounded-response.ts'
import { adminLoginEmail } from './admin-auth.ts'

type Delivery = { order_id: string; kind: 'link' | 'cdk'; value: string; instructions: string; mail_body: string; request_key: string; status: 'draft' | 'sending' | 'unknown' | 'sent'; version: number; first_attempt_at: number | null; sent_at: number | null; provider_id: string | null; lease_token: string | null; lease_until: number }
const find = (env: Env, id: string) => env.INTEREST_DB.prepare('SELECT * FROM email_deliveries WHERE order_id=?').bind(id).first<Delivery>()
export function emailCheckoutEnabled(env: Env) {
  if (env.ORDER_TESTING_ENABLED === 'true' || env.EMAIL_PRODUCTS_ENABLED !== 'true' || !alipayConfigured(env) || !env.RESEND_API_KEY || !env.RESEND_FROM) return false
  try { const url = new URL(env.PAYMENT_NOTIFY_ORIGIN ?? ''); return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash } catch { return false }
}
export async function emailDeliverySummary(env: Env, order: Order): Promise<DeliverySummary | undefined> {
  const product = emailProduct(order.plan); if (!product) return undefined
  const row = await find(env, order.id)
  const automatic = await env.INTEREST_DB.prepare('SELECT state FROM delivery_supplier_orders WHERE order_id=?').bind(order.id).first<{ state: string }>()
  const visible = automatic?.state === 'purchased' && row && order.mode === 'live' && !order.is_test && order.payment_status === 'paid' && !order.refund_hold && !order.refunded_cents && !order.redemption_blocked
  return { kind: product.kind, status: row?.status ?? 'waiting', sentAt: row?.sent_at ?? null, ...(automatic ? { automatic: true } : {}), ...(visible ? { value: row.value, instructions: row.instructions } : {}) }
}
export function validateValue(kind: 'link' | 'cdk', input: unknown) {
  if (typeof input !== 'string' || !input.trim() || input.length > (kind === 'link' ? 2048 : 512) || Array.from(input).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new ApiError('请填写有效的发货内容。')
  const value = input.trim()
  if (kind === 'link') {
    let url: URL
    try { url = new URL(value) } catch { throw new ApiError('请填写完整的 HTTPS 领取链接。') }
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || /[<>"']/.test(value)) throw new ApiError('请填写无账号密码的 HTTPS 领取链接。')
  }
  return value
}

/** Called only behind requireAdmin; uses a dummy link and the normal delivery template. */
export async function membershipDeliveryPreview(request: Request, env: Env) {
  if (request.method !== 'POST') throw new ApiError('请通过 POST 发送模板预览。', 405)
  const data = await body(request)
  if (data.plan !== 'duolingo-12m' && data.plan !== 'gemini-pro-18m') throw new ApiError('请选择多邻国或 Gemini 邮件模板。')
  if (typeof data.key !== 'string' || !/^[a-f0-9-]{36}$/.test(data.key)) throw new ApiError('模板预览请求编号无效。')
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) throw new ApiError('邮件服务暂不可用。', 503)
  const plan = await env.INTEREST_DB.prepare('SELECT delivery_instructions FROM catalog_plans WHERE id=?').bind(data.plan).first<{ delivery_instructions: string }>()
  if (!plan) throw new ApiError('未找到套餐。', 404)
  const value = data.plan === 'duolingo-12m' ? 'https://www.duolingo.com/claim/super?code=PREVIEW-ONLY-NOT-A-REAL-CODE' : 'https://example.com/claim/gemini-preview'
  const message = membershipDeliveryMessage(emailProduct(data.plan)!.kind, 'YMX-PREVIEW', value, plan.delivery_instructions, data.plan)
  try {
    const providerId = await sendMembershipPreviewEmail(env, adminLoginEmail(env), message, data.key)
    return json({ ok: true, to: adminLoginEmail(env), providerId })
  } catch { throw new ApiError('预览邮件结果尚未确认，请用原请求编号核对。', 503) }
}
function eligible(order: Order) {
  return order.mode === 'live' && !order.is_test && order.payment_status === 'paid' && !order.refund_hold && !order.refunded_cents && !order.redemption_blocked && ['session', 'processing'].includes(order.status)
}
const eligibilitySql = "mode='live' AND is_test=0 AND payment_status='paid' AND refund_hold=0 AND refunded_cents=0 AND redemption_blocked=0 AND status IN ('session','processing')"
async function adminView(env: Env, order: Order) {
  const row = await find(env, order.id); const product = emailProduct(order.plan)!
  const defaults = await env.INTEREST_DB.prepare('SELECT delivery_instructions FROM catalog_plans WHERE id=?').bind(order.plan).first<{ delivery_instructions: string }>()
  const message = row ? JSON.parse(row.mail_body) as { subject: string; html: string; text: string } : null
  const delivery: AdminDelivery = { ...(await emailDeliverySummary(env, order)), kind: product.kind, status: row?.status ?? 'waiting', sentAt: row?.sent_at ?? null, value: row?.value ?? '', instructions: row?.instructions ?? defaults?.delivery_instructions ?? '', version: row?.version ?? -1, firstAttemptAt: row?.first_attempt_at ?? null, providerId: row?.provider_id ?? null, preview: message ? { subject: message.subject, html: message.html, text: message.text } : null }
  return json({ delivery, recipient: order.customer_email, orderVersion: order.version })
}
async function finish(env: Env, row: Delivery, lease: string, providerId: string | null, actor: string, note: string) {
  const now = Date.now(), event = crypto.randomUUID()
  await env.INTEREST_DB.batch([
    env.INTEREST_DB.prepare("UPDATE email_deliveries SET status='sent',provider_id=COALESCE(?,provider_id),sent_at=?,updated_at=?,version=version+1,lease_until=0 WHERE order_id=? AND lease_token=? AND status='sending'").bind(providerId, now, now, row.order_id, lease),
    env.INTEREST_DB.prepare("UPDATE orders SET status='success',updated_at=?,version=version+1,last_event_id=? WHERE id=? AND EXISTS(SELECT 1 FROM email_deliveries WHERE order_id=orders.id AND lease_token=? AND status='sent') AND status<>'success'").bind(now, event, row.order_id, lease),
    env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT ?,id,?,'email-delivery-sent','processing',status,?,version,? FROM orders WHERE id=? AND last_event_id=?").bind(event, actor, note, now, row.order_id, event),
  ])
  if ((await find(env, row.order_id))?.status !== 'sent') throw new ApiError('发货记录正在核对，请刷新详情。', 409)
}
export async function emailDeliveryRoute(request: Request, env: Env, order: Order, actorOverride?: 'system') {
  const product = emailProduct(order.plan)
  if (!product) throw new ApiError('该订单不支持邮件发货。', 409)
  if (request.method === 'GET') return adminView(env, order)
  if (request.method !== 'POST') throw new ApiError('请求方式不支持。', 405)
  const data = await body(request, 8192), now = Date.now(), actor = actorOverride ?? 'admin:' + env.ADMIN_USERNAME
  if (!['save', 'send', 'confirm-sent'].includes(String(data.action))) throw new ApiError('发货操作无效。')
  let row = await find(env, order.id)
  if (data.action !== 'save' && row?.status === 'sent') return adminView(env, order)
  if (!eligible(order)) throw new ApiError('仅已付款、无退款或暂停标记的待发货订单可发货。', 409)
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) throw new ApiError('邮件服务尚未配置。', 503)
  if (data.orderVersion !== order.version || data.version !== (row?.version ?? -1)) throw new ApiError('发货资料或订单已更新，请刷新。', 409)
  if (data.action === 'save') {
    if (await env.INTEREST_DB.prepare('SELECT order_id FROM delivery_supplier_orders WHERE order_id=?').bind(order.id).first()) throw new ApiError('商品由原采购单自动交付，不能替换发货资料。', 409)
    if (order.plan === 'gmail-account') throw new ApiError('Gmail 账号由原采购单自动生成，不能手动替换。', 409)
    if (row && row.status !== 'draft') throw new ApiError('邮件已开始发送，不能替换原发货内容。', 409)
    const value = validateValue(product.kind, data.value)
    if (typeof data.instructions !== 'string' || !data.instructions.trim() || data.instructions.length > 2000) throw new ApiError('请填写 1–2000 字的领取说明。')
    const instructions = data.instructions.trim()
    const deliveryMessage = membershipDeliveryMessage(product.kind, order.id, value, instructions, order.plan)
    const payload = JSON.stringify({ from: env.RESEND_FROM, to: [order.customer_email], ...(order.partner_id ? siteEmail(env, deliveryMessage) : await directSiteEmail(env, deliveryMessage)) })
    const event = crypto.randomUUID()
    await env.INTEREST_DB.batch([
      env.INTEREST_DB.prepare(`UPDATE orders SET version=version+1,updated_at=?,last_event_id=? WHERE id=? AND version=? AND ${eligibilitySql} AND NOT EXISTS(SELECT 1 FROM email_deliveries WHERE order_id=orders.id AND (status<>'draft' OR version<>?))`).bind(now, event, order.id, order.version, row?.version ?? -1),
      env.INTEREST_DB.prepare("INSERT INTO email_deliveries(order_id,kind,value,instructions,mail_body,request_key,created_at,updated_at) SELECT id,?,?,?,?,?,?,? FROM orders WHERE id=? AND last_event_id=? ON CONFLICT(order_id) DO UPDATE SET value=excluded.value,instructions=excluded.instructions,mail_body=excluded.mail_body,request_key=excluded.request_key,updated_at=excluded.updated_at,version=email_deliveries.version+1").bind(product.kind, value, instructions, payload, crypto.randomUUID(), now, now, order.id, event),
      env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT ?,id,?,'email-delivery-draft',status,status,'已保存邮件发货草稿',version,? FROM orders WHERE id=? AND last_event_id=?").bind(event, actor, now, order.id, event),
    ])
    if (!await env.INTEREST_DB.prepare('SELECT id FROM order_events WHERE id=?').bind(event).first()) throw new ApiError('订单已更新，请刷新。', 409)
    return adminView(env, await getOrder(env, order.id))
  }
  if (!row) throw new ApiError('请先保存并预览发货内容。', 409)
  const confirm = data.action === 'confirm-sent'
  if (confirm && (row.first_attempt_at === null || typeof data.note !== 'string' || data.note.trim().length < 4 || data.note.length > 500)) throw new ApiError('请先在邮件服务后台核实原邮件已发送，并填写核查说明。')
  // Resend retains idempotency keys for 24h. Never blindly reissue after that window.
  if (!confirm && row.first_attempt_at !== null && now - row.first_attempt_at >= 23 * 3600000) throw new ApiError('原邮件已超过安全重试时间，请核查邮件服务记录后人工确认，不能重复发送。', 409)
  const lease = crypto.randomUUID(), event = crypto.randomUUID()
  await env.INTEREST_DB.batch([
    env.INTEREST_DB.prepare(`UPDATE email_deliveries SET status='sending',lease_token=?,lease_until=?,first_attempt_at=COALESCE(first_attempt_at,?),updated_at=?,version=version+1 WHERE order_id=? AND version=? AND status<>'sent' AND lease_until<=? AND EXISTS(SELECT 1 FROM orders WHERE id=email_deliveries.order_id AND version=? AND ${eligibilitySql})`).bind(lease, now + 60000, now, now, order.id, row.version, now, order.version),
    env.INTEREST_DB.prepare("UPDATE orders SET status='processing',started_at=COALESCE(started_at,?),updated_at=?,version=version+1,last_event_id=? WHERE id=? AND EXISTS(SELECT 1 FROM email_deliveries WHERE order_id=orders.id AND lease_token=?)").bind(now, now, event, order.id, lease),
    env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT ?,id,?,'email-delivery-send',?,'processing','开始核对邮件发货',version,? FROM orders WHERE id=? AND last_event_id=?").bind(event, actor, order.status, now, order.id, event),
  ])
  row = (await find(env, order.id))!
  if (row.lease_token !== lease) throw new ApiError('邮件正在发送或订单已变化，请刷新。', 409)
  try {
    if (confirm) await finish(env, row, lease, null, actor, '管理员已核实原邮件发送：' + String(data.note).trim())
    else {
      const response = await fetch('https://api.resend.com/emails', { method: 'POST', redirect: 'manual', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json', 'Idempotency-Key': 'membership-delivery/' + row.request_key }, body: row.mail_body, signal: AbortSignal.timeout(10000) })
      if (!response.ok) throw new Error('Mail not confirmed')
      const result = JSON.parse(await boundedResponseText(response, 16384)) as { id?: unknown }
      if (typeof result.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.id)) throw new Error('Mail response invalid')
      await finish(env, row, lease, result.id, actor, '发货邮件已被邮件服务接收，请客户查看收件箱')
    }
  } catch {
    await env.INTEREST_DB.prepare("UPDATE email_deliveries SET status='unknown',lease_until=0,updated_at=?,version=version+1 WHERE order_id=? AND lease_token=? AND status='sending'").bind(Date.now(), order.id, lease).run()
    throw new ApiError('邮件发送结果尚未确认，请刷新后核对原邮件；重试会复用原邮件编号和内容。', 503)
  }
  return adminView(env, await getOrder(env, order.id))
}

// Trusted scheduled/payment jobs use the same eligibility, lease and Resend
// idempotency checks as administrator retries. No recipient/content overrides.
export async function sendSavedDelivery(env: Env, order: Order) {
  const row = await find(env, order.id)
  if (!row || row.status === 'sent' || row.lease_until > Date.now()) return
  await emailDeliveryRoute(new Request('https://internal.invalid/delivery', {
    method: 'POST', headers: { Origin: 'https://internal.invalid', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'send', version: row.version, orderVersion: order.version }),
  }), env, order, 'system')
}
