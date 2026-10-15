import { telegramWebhook, retryTelegramInvitations } from './telegram.ts'
import { reconcileXGift } from './xgift/service.ts'
import { reconcileDeliverySupplier } from './delivery_supplier/service.ts'
import type { Env } from './platform.ts'
import { commerce } from './commerce.ts'
import { paymentNotification, reconcilePayments } from './payments/service.ts'
import { reconcileRecharge, rechargeWebhook } from './recharge/service.ts'
import { reconcileRechargeRefunds } from './refunds.ts'
import { limitApi } from './rate-limit.ts'
import { ApiError } from './platform.ts'
import { recordVisitor } from './visitors.ts'
import { retryPayoutNotifications } from './payout-notifications.ts'
import { invoiceNotification, reconcileInvoicePayments } from './invoices.ts'
import { sendDueRechargeReminders } from './recharge-reminders.ts'
import { reconcileGmail } from './account_supplier/service.ts'
import { requireSecureTransport, secureResponse } from './security.ts'
const json = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(status === 429 ? { 'Retry-After': '60' } : {}) },
})
const error = (message: string, status: number) => json({ error: message }, status)
async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('')
}

export default {
  async scheduled(event: { scheduledTime?: number }, env: Env) {
    // Telegram's durable queue is independent of supplier reconciliation failures.
    await retryTelegramInvitations(env).catch(() => { console.error('Telegram invitation queue temporarily unavailable') })
    // Reminders run every minute; preserve the existing five-minute reconciliation cadence.
    if (event.scheduledTime === undefined || Math.floor(event.scheduledTime / 60_000) % 5 === 0) {
      await Promise.all([reconcilePayments(env), reconcileRecharge(env), retryPayoutNotifications(env), reconcileInvoicePayments(env)])
      await reconcileRechargeRefunds(env)
    }
    await Promise.all([sendDueRechargeReminders(env), reconcileGmail(env), reconcileDeliverySupplier(env), reconcileXGift(env)])
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const transport = requireSecureTransport(request)
      return secureResponse(request, transport ?? await route(request, env))
    } catch {
      return secureResponse(request, error('服务暂时不可用，请稍后重试。', 503))
    }
  },
}

async function route(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    try {
      const limited = await limitApi(request, env, url.pathname)
      if (limited) return limited
    } catch {
      return error('请求保护服务暂时不可用，请稍后重试。', 503)
    }
    if (url.pathname === '/api/telegram/webhook') return telegramWebhook(request, env)
    if (url.pathname === '/api/recharge/webhook') return rechargeWebhook(request, env)
    if (url.pathname === '/api/invoices/notify/alipay') return invoiceNotification(request, env)
    const notification = url.pathname.match(/^\/api\/payments\/notify\/([a-z0-9-]+)$/)
    if (notification) return paymentNotification(request, env, notification[1])
    if (url.pathname === '/api/visitors') {
      try { return await recordVisitor(request, env) }
      catch (caught) { return error(caught instanceof ApiError ? caught.message : '统计暂不可用。', caught instanceof ApiError ? caught.status : 503) }
    }
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    if (url.pathname.startsWith('/api/admin/') || url.pathname.startsWith('/api/partner/') || url.pathname.startsWith('/api/direct-media/') || url.pathname.startsWith('/api/orders') || url.pathname === '/api/catalog') return commerce(request, env)
    if (!['/api/interest', '/api/interest/cancel'].includes(url.pathname)) return error('未找到接口。', 404)
    if (request.method !== 'POST') return error('请通过登记表单提交。', 405)
    if (request.headers.get('Origin') !== url.origin) return error('请从本站重新打开表单。', 403)
    if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return error('提交格式不正确。', 415)
    try {
      // Anonymous forms have no user identifier; keep this coarse IP guard generous
      // enough for shared networks. It is abuse mitigation, not exact accounting.
      const key = `interest:${await hash(request.headers.get('CF-Connecting-IP') ?? 'local')}`
      if (!(await env.INTEREST_LIMITER.limit({ key })).success) return error('操作较频繁，请一分钟后再试。', 429)
      const reader = request.body?.getReader()
      if (!reader) return error('请填写登记信息。', 400)
      let size = 0
      const chunks: Uint8Array[] = []
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 2048) { await reader.cancel(); return error('提交内容过长。', 413) }
        chunks.push(value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      let body: Record<string, unknown>
      try { body = JSON.parse(new TextDecoder().decode(bytes)) } catch { return error('提交格式不正确。', 400) }
      if (!body || typeof body !== 'object') return error('提交格式不正确。', 400)
      if (typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) return error('登记凭据无效，请重新打开表单。', 400)
      const tokenHash = await hash(body.token)
      if (url.pathname === '/api/interest/cancel') {
        // Capability-based, idempotent deletion; email alone never grants access.
        await env.INTEREST_DB.prepare('DELETE FROM launch_interest WHERE token_hash = ?').bind(tokenHash).run()
        return json({ ok: true })
      }
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return error('请输入有效的邮箱地址。', 400)
      if (body.product !== 'claude' && body.product !== 'grok' && body.product !== 'gmail') return error('该商品暂不支持登记。', 400)
      if (body.consent !== true) return error('请先同意邮箱使用说明。', 400)
      await env.INTEREST_DB.prepare('INSERT INTO launch_interest (id, product, email, token_hash, consent_version) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .bind(crypto.randomUUID(), body.product, email, tokenHash, 'launch-interest-v1').run()
      const own = await env.INTEREST_DB.prepare('SELECT id FROM launch_interest WHERE product = ? AND email = ? AND token_hash = ?').bind(body.product, email, tokenHash).first()
      // Never return an email, row ID, or another registrant's cancellation token.
      return json({ ok: true, manageable: Boolean(own), deliveryEnabled: false })
    } catch {
      // Do not log request bodies, email addresses or cancellation capabilities.
      return error('登记服务暂时不可用，请稍后重试。', 503)
    }
}
