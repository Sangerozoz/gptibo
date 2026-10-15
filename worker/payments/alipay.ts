// Adapted from ../tl/sms-platform-worker/src/alipay.js. No embedded credentials.
import type { PaymentOrder, PaymentProvider, PaymentResult, RefundRequest } from './types.ts'
import { amountCents, amountText } from './types.ts'

export type AlipayConfig = { ALIPAY_APP_ID: string; ALIPAY_SELLER_ID: string; ALIPAY_APP_PRIVATE_KEY: string; ALIPAY_PUBLIC_KEY: string; ALIPAY_GATEWAY?: string }
const encoder = new TextEncoder()
const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
function bytes(value: string) {
  const raw = value.replace(/-----[^-]+-----/g, '').replace(/\\n/g, '').replace(/\s/g, '')
  return Uint8Array.from(atob(raw), c => c.charCodeAt(0))
}
export function canonical(params: Record<string, unknown>, excluded = ['sign']) {
  return Object.keys(params).filter(k => !excluded.includes(k) && params[k] !== undefined && params[k] !== null && params[k] !== '').sort().map(k => `${k}=${params[k]}`).join('&')
}
async function signature(text: string, config: AlipayConfig) {
  const key = await crypto.subtle.importKey('pkcs8', bytes(config.ALIPAY_APP_PRIVATE_KEY), algorithm, false, ['sign'])
  const result = await crypto.subtle.sign(algorithm, key, encoder.encode(text))
  return btoa(String.fromCharCode(...new Uint8Array(result)))
}
async function verify(text: string, sign: string, config: AlipayConfig) {
  try {
    const key = await crypto.subtle.importKey('spki', bytes(config.ALIPAY_PUBLIC_KEY), algorithm, false, ['verify'])
    return await crypto.subtle.verify(algorithm, key, bytes(sign), encoder.encode(text))
  } catch { return false }
}
export async function boundedText(request: Request | Response, limit: number) {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('Missing gateway body')
  let size = 0; let text = ''; const decoder = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    size += value.byteLength
    if (size > limit) { await reader.cancel(); throw new Error('Gateway body too large') }
    text += decoder.decode(value, { stream: true })
  }
}
// Preserve original JSON bytes: reserializing may change escaping and invalidate RSA2.
export function responseObjectText(raw: string, name: string) {
  const match = new RegExp(`"${name}"\\s*:\\s*\\{`).exec(raw)
  if (!match) throw new Error('Alipay response object missing')
  const start = raw.indexOf('{', match.index)
  let depth = 0; let quoted = false; let escaped = false
  for (let i = start; i < raw.length; i++) {
    const c = raw[i]
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false }
    else if (c === '"') quoted = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return raw.slice(start, i + 1)
  }
  throw new Error('Alipay response object incomplete')
}
function timestamp() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ') }
export async function gateway(config: AlipayConfig, method: string, biz: Record<string, unknown>, extras: Record<string, string> = {}) {
  const url = config.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do'
  if (!['https://openapi.alipay.com/gateway.do', 'https://openapi-sandbox.dl.alipaydev.com/gateway.do'].includes(url)) throw new Error('Unsupported Alipay gateway')
  const params: Record<string, string> = { app_id: config.ALIPAY_APP_ID, method, format: 'JSON', charset: 'utf-8', sign_type: 'RSA2', timestamp: timestamp(), version: '1.0', biz_content: JSON.stringify(biz), ...extras }
  params.sign = await signature(canonical(params), config)
  // Workers supports manual/follow, but rejects redirect:error. Manual plus
  // the status check below rejects redirects without forwarding signed data.
  const response = await fetch(url, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw new Error('Alipay gateway unavailable')
  const raw = await boundedText(response, 100000); const data = JSON.parse(raw)
  const name = method.replaceAll('.', '_') + '_response'; const item = data[name]
  if (!item || typeof item !== 'object' || typeof data.sign !== 'string') throw new Error('Alipay response malformed')
  const signed = responseObjectText(raw, name)
  if (JSON.stringify(JSON.parse(signed)) !== JSON.stringify(item)) throw new Error('Alipay response object mismatch')
  if (!await verify(signed, data.sign, config)) throw new Error('Alipay response signature invalid')
  return item as Record<string, unknown>
}
function tradeNo(raw: unknown) {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(raw)) throw new Error('Invalid Alipay trade number')
  return raw
}
function paymentResult(data: Record<string, unknown>, order?: PaymentOrder): PaymentResult {
  if (typeof data.out_trade_no !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(data.out_trade_no)) throw new Error('Invalid Alipay order')
  const amount = amountCents(data.total_amount)
  if (order && (data.out_trade_no !== order.id || amount !== order.amountCents)) throw new Error('Alipay payment identity or amount mismatch')
  const states: Record<string, PaymentResult['status']> = { WAIT_BUYER_PAY: 'pending', TRADE_SUCCESS: 'paid', TRADE_FINISHED: 'paid', TRADE_CLOSED: 'closed' }
  const status = states[String(data.trade_status)]
  if (!status) throw new Error('Unknown Alipay trade status')
  return { orderId: data.out_trade_no, amountCents: amount, status, tradeNo: tradeNo(data.trade_no) }
}
function refundValid(order: PaymentOrder, refund: RefundRequest) {
  amountText(refund.amountCents)
  if (refund.amountCents > order.amountCents || !/^[A-Za-z0-9_-]{1,64}$/.test(refund.id)) throw new Error('Invalid refund request')
}
export function alipay(config: AlipayConfig): PaymentProvider {
  return {
    id: 'alipay', account: `${config.ALIPAY_APP_ID}:${config.ALIPAY_SELLER_ID}:${config.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do'}`,
    async create(order, notifyUrl) {
      if (order.expiresAt <= Date.now()) throw new Error('Payment expired')
      const timeout = `${Math.max(1, Math.ceil((order.expiresAt - Date.now()) / 60000))}m`
      const result = await gateway(config, 'alipay.trade.precreate', { out_trade_no: order.id, seller_id: config.ALIPAY_SELLER_ID, total_amount: amountText(order.amountCents), subject: order.subject, timeout_express: timeout, qr_code_timeout_express: timeout }, { notify_url: notifyUrl })
      if (result.code !== '10000' || result.out_trade_no !== order.id || typeof result.qr_code !== 'string') throw new Error('Alipay precreate rejected')
      const qr = new URL(result.qr_code)
      if (qr.protocol !== 'https:' || qr.hostname !== 'qr.alipay.com' || qr.username || qr.password || qr.port) throw new Error('Invalid Alipay QR URL')
      return { qr: qr.href }
    },
    async query(order) {
      const result = await gateway(config, 'alipay.trade.query', { out_trade_no: order.id })
      if (result.code !== '10000') {
        if (result.sub_code === 'ACQ.TRADE_NOT_EXIST') return { orderId: order.id, amountCents: order.amountCents, status: 'not_found' }
        throw new Error('Alipay query rejected')
      }
      // Standard trade.query responses do not contain seller_id. This signed
      // query is scoped to the original app credentials (no app_auth_token).
      // Precreate pins seller_id; asynchronous notifications must include it.
      if (result.seller_id !== undefined && result.seller_id !== config.ALIPAY_SELLER_ID) throw new Error('Alipay seller mismatch')
      return paymentResult(result, order)
    },
    async close(order) {
      const result = await gateway(config, 'alipay.trade.close', { out_trade_no: order.id })
      if (result.code !== '10000') return false // Not-found/timeout never means safely closed.
      if (result.out_trade_no !== order.id) throw new Error('Alipay close identity mismatch')
      return true
    },
    async refund(order, refund) {
      refundValid(order, refund)
      const result = await gateway(config, 'alipay.trade.refund', { out_trade_no: order.id, refund_amount: amountText(refund.amountCents), out_request_no: refund.id, refund_reason: '硅基生物 订单售后退款' })
      if (result.code !== '10000' || result.out_trade_no !== order.id) throw new Error('Alipay refund rejected')
      if (result.fund_change !== 'Y') return { refunded: false }
      if (amountCents(result.refund_fee) !== refund.amountCents) throw new Error('Alipay refund amount mismatch')
      return { refunded: true, tradeNo: tradeNo(result.trade_no) }
    },
    async queryRefund(order, refund) {
      refundValid(order, refund)
      const result = await gateway(config, 'alipay.trade.fastpay.refund.query', { out_trade_no: order.id, out_request_no: refund.id })
      if (result.code !== '10000') {
        if (['ACQ.TRADE_NOT_EXIST', 'ACQ.REFUND_NOT_EXIST'].includes(String(result.sub_code))) return { refunded: false }
        throw new Error('Alipay refund query rejected')
      }
      if (result.refund_status !== 'REFUND_SUCCESS') return { refunded: false }
      if (result.out_trade_no !== order.id || result.out_request_no !== refund.id || amountCents(result.total_amount) !== order.amountCents || amountCents(result.refund_amount) !== refund.amountCents) throw new Error('Alipay refund identity or amount mismatch')
      return { refunded: true, tradeNo: tradeNo(result.trade_no) }
    },
    async notification(request) {
      if (request.method !== 'POST' || !request.headers.get('Content-Type')?.toLowerCase().startsWith('application/x-www-form-urlencoded')) throw new Error('Invalid notification format')
      const form = new URLSearchParams(await boundedText(request, 16384)); const params: Record<string, string> = Object.create(null)
      form.forEach((value, key) => { if (Object.hasOwn(params, key)) throw new Error('Duplicate notification field'); params[key] = value })
      if (params.app_id !== config.ALIPAY_APP_ID || params.seller_id !== config.ALIPAY_SELLER_ID || params.sign_type !== 'RSA2' || !params.sign || !await verify(canonical(params, ['sign', 'sign_type']), params.sign, config)) throw new Error('Invalid Alipay notification')
      return paymentResult(params)
    },
    acknowledge(accepted) { return new Response(accepted ? 'success' : 'failure', { status: accepted ? 200 : 400, headers: { 'Cache-Control': 'no-store' } }) },
  }
}
