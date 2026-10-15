import { isXGiftPlan } from '../../shared/xgift-products.ts'
import { fulfillXGift, xgiftCheckoutEnabled } from '../xgift/service.ts'
import { isDeliverySupplierPlan } from '../delivery_supplier/client.ts'
import { fulfillDeliverySupplier, delivery_supplierCheckoutEnabled } from '../delivery_supplier/service.ts'
import { emailProduct } from '../../shared/email-products.ts'
import { emailCheckoutEnabled } from '../email-delivery.ts'
import { fulfillGmail, gmailCheckoutEnabled } from '../account_supplier/service.ts'
import { ApiError, body, json, type Env } from '../platform.ts'
import { getOrder, type Order } from '../order-state.ts'
import { paymentProvider } from './providers.ts'
import type { PaymentOrder, PaymentResult, PaymentProvider } from './types.ts'

export type Payment = { order_id: string; provider: string; account: string; amount_cents: number; state: 'pending' | 'paid' | 'closed'; trade_no: string | null; qr: string | null; expires_at: number; lease_token: string | null; lease_until: number; notified_at: number | null }
export const findPayment = (env: Env, id: string) => env.INTEREST_DB.prepare('SELECT * FROM payments WHERE order_id=?').bind(id).first<Payment>()
const details = (p: Payment, o: Order): PaymentOrder => ({ id: p.order_id, amountCents: p.amount_cents, subject: o.is_test ? '硅基生物 · 支付联调测试（不交付商品）' : `硅基生物 · ${emailProduct(o.plan)?.name ?? (isXGiftPlan(o.plan) ? o.plan_name : o.plan === 'codex-sms-once' ? 'Codex 接码' : 'ChatGPT ' + o.plan_name)}`, expiresAt: p.expires_at })
function providerFor(env: Env, p: Payment) {
  const provider = paymentProvider(env, p.provider)
  if (provider.account !== p.account) throw new ApiError('支付商户配置已变化，请恢复该订单原渠道配置后处理。', 503)
  return provider
}
function notifyUrl(env: Env, provider: string) {
  let url: URL
  try { url = new URL(env.PAYMENT_NOTIFY_ORIGIN ?? '') } catch { throw new ApiError('尚未配置支付回调域名。', 503) }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new ApiError('支付回调域名配置无效。', 503)
  return `${url.origin}/api/payments/notify/${encodeURIComponent(provider)}`
}
export async function applyPaymentResult(env: Env, p: Payment, result: PaymentResult) {
  if (result.orderId !== p.order_id || result.amountCents !== p.amount_cents || (p.trade_no && result.tradeNo && p.trade_no !== result.tradeNo)) throw new ApiError('支付结果与订单不匹配。', 409)
  if (result.status === 'pending' || result.status === 'not_found') return
  if (result.status === 'paid' && !result.tradeNo) throw new ApiError('支付流水缺失。', 409)
  const order = await getOrder(env, p.order_id)
  if (order.mode !== 'live' || order.price_cents !== p.amount_cents) throw new ApiError('支付订单不匹配。', 409)
  const paid = result.status === 'paid'; const event = crypto.randomUUID(); const now = Date.now()
  // Payment receipt + order transition + audit are one D1 transaction. A later
  // close notification must never undo paid/refunded/fulfilled state.
  await env.INTEREST_DB.batch([
    env.INTEREST_DB.prepare("UPDATE payments SET state=?,trade_no=COALESCE(trade_no,?),qr=NULL,updated_at=?,last_event_id=? WHERE order_id=? AND provider=? AND account=? AND amount_cents=? AND state<>'paid' AND (state<>? OR ?='paid') AND (trade_no IS NULL OR trade_no=?)")
      .bind(result.status, result.tradeNo ?? null, now, event, p.order_id, p.provider, p.account, p.amount_cents, result.status, result.status, result.tradeNo ?? null),
    env.INTEREST_DB.prepare("UPDATE orders SET payment_status=CASE WHEN ?=1 THEN 'paid' ELSE payment_status END,status=CASE WHEN ?=1 AND status IN ('pending','cancelled') THEN 'session' WHEN ?=0 AND status='pending' THEN 'cancelled' ELSE status END,updated_at=?,version=version+1,last_event_id=? WHERE id=? AND mode='live' AND payment_status='unpaid' AND EXISTS(SELECT 1 FROM payments WHERE order_id=orders.id AND last_event_id=?)")
      .bind(Number(paid), Number(paid), Number(paid), now, event, order.id, event),
    env.INTEREST_DB.prepare("INSERT INTO order_events(id,order_id,actor,action,from_status,to_status,note,order_version,created_at) SELECT ?,id,'payment',?,?,status,?,version,? FROM orders WHERE id=? AND last_event_id=?")
      .bind(event, paid ? 'payment-confirmed' : 'payment-closed', order.status, paid ? '支付渠道已核验收款，等待交付' : '支付渠道已确认关闭交易', now, order.id, event),
  ])
  const current = await findPayment(env, p.order_id)
  if (result.tradeNo && current?.trade_no && result.tradeNo !== current.trade_no) throw new ApiError('支付流水冲突。', 409)
  if (paid && isXGiftPlan(order.plan)) {
    try { await fulfillXGift(env, order.id) } catch { /* Keep confirmed payment; cron reconciles the original gift. */ }
  }
  if (paid && isDeliverySupplierPlan(order.plan)) {
    try { await fulfillDeliverySupplier(env, order.id) } catch { /* Cron recovers the original receipt. */ }
  }
  if (paid && order.plan === 'gmail-account') {
    try { await fulfillGmail(env, order.id) } catch { /* Payment stays confirmed; cron reconciles the original purchase. */ }
  }
}
async function locked<T>(env: Env, p: Payment, work: () => Promise<T>) {
  const token = crypto.randomUUID(); const now = Date.now()
  await env.INTEREST_DB.prepare('UPDATE payments SET lease_token=?,lease_until=? WHERE order_id=? AND lease_until<=?').bind(token, now + 45000, p.order_id, now).run()
  if ((await findPayment(env, p.order_id))?.lease_token !== token) throw new ApiError('支付状态正在确认，请稍后重试。', 409)
  try { return await work() }
  catch (e) {
    // Adapter messages are fixed strings. Never log requests, gateway bodies,
    // credentials, QR values, database errors or arbitrary exception messages.
    const allowed = ['Alipay gateway unavailable', 'Alipay response malformed', 'Alipay response signature invalid', 'Alipay response object mismatch', 'Alipay precreate rejected', 'Invalid Alipay QR URL', 'Alipay query rejected', 'Alipay refund rejected', 'Alipay refund query rejected']
    console.warn('payment-operation-failed', e instanceof Error && allowed.includes(e.message) ? e.message : 'internal')
    throw e
  }
  finally { await env.INTEREST_DB.prepare('UPDATE payments SET lease_token=NULL,lease_until=0 WHERE order_id=? AND lease_token=?').bind(p.order_id, token).run() }
}
async function sync(env: Env, p: Payment, o: Order, close: boolean) {
  const provider = providerFor(env, p); const d = details(p, o)
  let result = await provider.query(d)
  await applyPaymentResult(env, p, result)
  if (result.status !== 'paid' && result.status !== 'closed' && close) {
    if (await provider.close(d)) await applyPaymentResult(env, p, { orderId: p.order_id, amountCents: p.amount_cents, status: 'closed' })
    else {
      // The buyer may pay between query and close. Do not assume failed close
      // or a temporary not-found means the buyer has not paid.
      result = await provider.query(d)
      await applyPaymentResult(env, p, result)
      // Precreated QR codes may not appear in trade.query until the buyer scans.
      // Only retire a missing trade after the code's maximum validity plus a
      // two-minute allowance for minute rounding and gateway request latency.
      if (result.status === 'not_found' && Date.now() > p.expires_at + 120000) await applyPaymentResult(env, p, { orderId: p.order_id, amountCents: p.amount_cents, status: 'closed' })
    }
  }
  await env.INTEREST_DB.prepare('UPDATE payments SET updated_at=? WHERE order_id=?').bind(Date.now(), p.order_id).run()
}
export async function paymentAction(request: Request, env: Env, order: Order, adminTest = false) {
  if (request.method !== 'POST') throw new ApiError('请通过订单发起支付操作。', 405)
  const data = await body(request)
  if (!['create', 'query', 'close'].includes(String(data.action))) throw new ApiError('支付操作无效。')
  if (order.redemption_blocked && data.action === 'create') throw new ApiError('本订单已禁止再次兑换，请联系支持。', 409)
  if (order.mode !== 'live') throw new ApiError('历史测试记录不能发起收款。', 409)
  const canCreate = (isXGiftPlan(order.plan) ? xgiftCheckoutEnabled(env) : order.plan === 'gmail-account' ? gmailCheckoutEnabled(env) : isDeliverySupplierPlan(order.plan) ? delivery_supplierCheckoutEnabled(env) : emailProduct(order.plan) ? emailCheckoutEnabled(env) : env.PAYMENT_CHECKOUT_ENABLED === 'true') || (adminTest && order.is_test === 1 && order.price_cents === 1 && !order.partner_id && env.PAYMENT_TEST_ENABLED === 'true')
  if (!(await env.INTEREST_LIMITER.limit({ key: 'payment:' + order.owner_hash })).success) throw new ApiError('操作较频繁，请稍后再试。', 429)
  let payment = await findPayment(env, order.id)
  if (!payment && data.action === 'create') {
    if (!canCreate) throw new ApiError('真实收款尚未开放。', 503)
    const provider = paymentProvider(env, emailProduct(order.plan) || isXGiftPlan(order.plan) ? 'alipay' : env.PAYMENT_PROVIDER ?? '')
    notifyUrl(env, provider.id)
    const now = Date.now()
    await env.INTEREST_DB.prepare("INSERT INTO payments(order_id,provider,account,amount_cents,expires_at,created_at,updated_at) SELECT id,?,?,price_cents,?,?,? FROM orders WHERE id=? AND mode='live' AND payment_status='unpaid' AND status='pending' AND redemption_blocked=0 AND refund_hold=0 AND refunded_cents=0 ON CONFLICT(order_id) DO NOTHING")
      .bind(provider.id, provider.account, now + 15 * 60000, now, now, order.id).run()
    payment = await findPayment(env, order.id)
  }
  if (!payment) throw new ApiError('该订单没有可用的支付记录。', 409)
  const p = payment
  await locked(env, p, async () => {
    const fresh = (await findPayment(env, order.id))!
    if (fresh.state !== 'pending') return
    if (data.action === 'create' && fresh.expires_at > Date.now()) {
      if (!canCreate) throw new ApiError('真实收款尚未开放。', 503)
      const currentOrder = await getOrder(env, order.id)
      if (currentOrder.redemption_blocked) throw new ApiError('本订单已禁止再次兑换，请联系支持。', 409)
      if (!fresh.qr) {
        if (currentOrder.payment_status !== 'unpaid' || currentOrder.status !== 'pending' || currentOrder.refund_hold) throw new ApiError('当前订单不能继续付款。', 409)
        const qr = await providerFor(env, fresh).create(details(fresh, currentOrder), notifyUrl(env, fresh.provider))
        await env.INTEREST_DB.prepare("UPDATE payments SET qr=?,updated_at=? WHERE order_id=? AND state='pending'").bind(qr.qr, Date.now(), fresh.order_id).run()
      }
    } else await sync(env, fresh, order, data.action === 'close' || fresh.expires_at <= Date.now())
  })
  const current = (await findPayment(env, order.id))!
  const currentOrder = await getOrder(env, order.id)
  return json({ payment: { provider: current.provider, status: current.state, qr: !currentOrder.redemption_blocked && current.state === 'pending' && current.expires_at > Date.now() ? current.qr : null, expiresAt: current.expires_at } })
}
export async function paymentNotification(request: Request, env: Env, providerId: string) {
  let provider: PaymentProvider | undefined
  try {
    provider = paymentProvider(env, providerId)
    const result = await provider.notification(request)
    const payment = await findPayment(env, result.orderId)
    if (!payment || payment.provider !== providerId || payment.account !== provider.account) throw new Error('Unknown payment')
    await applyPaymentResult(env, payment, result)
    if (result.status === 'paid') await env.INTEREST_DB.prepare('UPDATE payments SET notified_at=COALESCE(notified_at,?) WHERE order_id=? AND state=\'paid\'').bind(Date.now(), payment.order_id).run()
    return provider.acknowledge(true)
  } catch {
    // Non-success requests a gateway retry; no form data, signatures or PII in logs.
    return provider?.acknowledge(false) ?? new Response('failure', { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
}
// Can be run by an administrator or a scheduled Worker event. Each failure is
// isolated, and uncertain orders remain pending for subsequent reconciliation.
export async function reconcilePayments(env: Env) {
  const rows = (await env.INTEREST_DB.prepare("SELECT * FROM payments WHERE state='pending' AND lease_until<=? ORDER BY updated_at LIMIT 10").bind(Date.now()).all<Payment>()).results
  let confirmed = 0; let failed = 0
  for (const row of rows) {
    try { await locked(env, row, async () => { const p = (await findPayment(env, row.order_id))!; if (p.state === 'pending') await sync(env, p, await getOrder(env, row.order_id), p.expires_at <= Date.now()) }); confirmed++ }
    catch { failed++; await env.INTEREST_DB.prepare('UPDATE payments SET updated_at=? WHERE order_id=?').bind(Date.now(), row.order_id).run() }
  }
  return { checked: rows.length, confirmed, failed }
}
// Called only after admin review. Reuse the case ID even after a network timeout
// or a failed local transaction so retries cannot issue a second refund.
export async function refundThroughProvider(env: Env, order: Order, caseId: string, amount: number) {
  const p = await findPayment(env, order.id)
  if (!p) return null // Legacy/manual orders keep their existing recorded-transfer workflow.
  if (p.state !== 'paid' || order.payment_status !== 'paid' || !order.refund_hold) throw new ApiError('订单付款或售后状态不正确。', 409)
  const provider = providerFor(env, p); const d = details(p, order); const refund = { id: caseId, amountCents: amount }
  return locked(env, p, async () => {
    let result = await provider.queryRefund(d, refund)
    if (!result.refunded) result = await provider.refund(d, refund)
    if (!result.refunded) result = await provider.queryRefund(d, refund)
    if (!result.refunded || !result.tradeNo || result.tradeNo !== p.trade_no) throw new ApiError('退款结果尚未确认，请稍后重试核对。', 503)
    return `${p.provider}:${caseId}`
  })
}
