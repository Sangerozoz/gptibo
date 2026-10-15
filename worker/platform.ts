export type Value = string | number | null
// Fixed lifetime from successful login, shared by D1 sessions and browser cookies.
export const LOGIN_SESSION_SECONDS = 3 * 24 * 60 * 60
export interface Statement {
  bind(...values: Value[]): Statement
  first<T>(): Promise<T | null>
  all<T>(): Promise<{ results: T[] }>
  run(): Promise<unknown>
}
export interface Database {
  prepare(sql: string): Statement
  batch(statements: Statement[]): Promise<unknown[]>
}
export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  INTEREST_DB: Database
  INTEREST_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> }
  API_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> }
  EXPENSIVE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> }
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_BOT_USERNAME?: string
  TELEGRAM_WEBHOOK_SECRET?: string
  TELEGRAM_ALLOWED_GROUP_IDS?: string
  ADMIN_EMAIL?: string
  ADMIN_USERNAME?: string
  ADMIN_TOTP_SECRET?: string
  RESEND_API_KEY?: string
  RESEND_FROM?: string
  PUBLIC_SITE_ORIGIN?: string
  /** Shared Feishu alert bot, the same app used for SMS restock alerts. */
  FEISHU_APP_ID?: string
  FEISHU_APP_SECRET?: string
  FEISHU_PAYOUT_RECIPIENT?: string
  FEISHU_STOCK_RECIPIENT?: string
  PARTNER_AUTH_SECRET?: string
  EMAIL_PRODUCTS_ENABLED?: string
  DELIVERY_SUPPLIER_API_KEY?: string
  DELIVERY_SUPPLIER_CHECKOUT_ENABLED?: string
  DELIVERY_SUPPLIER_CNY_PER_USD?: string
  ACCOUNT_SUPPLIER_API_BASE?: string
  ACCOUNT_SUPPLIER_APP_ID?: string
  ACCOUNT_SUPPLIER_APP_SECRET?: string
  ACCOUNT_SUPPLIER_GOODS_ID?: string
  ACCOUNT_SUPPLIER_MAX_COST_CENTS?: string
  ACCOUNT_SUPPLIER_CHECKOUT_ENABLED?: string
  PAYMENT_PROVIDER?: string
  PAYMENT_CHECKOUT_ENABLED?: string
  PAYMENT_TEST_ENABLED?: string
  /** Opens nonfinancial purchase testing. Disable before enabling real storefront collection. */
  ORDER_TESTING_ENABLED?: string
  PAYMENT_NOTIFY_ORIGIN?: string
  ALIPAY_APP_ID?: string
  ALIPAY_SELLER_ID?: string
  ALIPAY_APP_PRIVATE_KEY?: string
  ALIPAY_PUBLIC_KEY?: string
  ALIPAY_GATEWAY?: string
  RECHARGE_API_BASE?: string
  RECHARGE_PARTNER_ID?: string
  RECHARGE_KEY_ID?: string
  RECHARGE_CLIENT_SECRET?: string
  RECHARGE_WEBHOOK_SECRET?: string
  RECHARGE_NOTIFY_URL?: string
  RECHARGE_PRODUCT_MAP?: string
  RECHARGE_COLLECTION_MODE?: string
  RECHARGE_CHECKOUT_ENABLED?: string
  XGIFT_API_BASE?: string
  XGIFT_USER_ID?: string
  XGIFT_KEY_ID?: string
  XGIFT_CLIENT_SECRET?: string
  XGIFT_CHECKOUT_ENABLED?: string
  XGIFT_BACKEND?: string
  XGIFT_PLATFORM_API_BASE?: string
  XGIFT_PLATFORM_KEY_ID?: string
  XGIFT_PLATFORM_CLIENT_SECRET?: string
}
export class ApiError extends Error {
  status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}
export function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } })
}
export async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('')
}
export function randomToken() { return crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '') }
export async function body(request: Request, maxBytes = 4096): Promise<Record<string, unknown>> {
  if (request.headers.get('Origin') !== new URL(request.url).origin) throw new ApiError('请从本站重新打开页面。', 403)
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new ApiError('提交格式不正确。', 415)
  const reader = request.body?.getReader()
  if (!reader) throw new ApiError('缺少提交内容。')
  let text = ''; let size = 0
  const decoder = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) { await reader.cancel(); throw new ApiError('提交内容过长。', 413) }
    text += decoder.decode(value, { stream: true })
  }
  try {
    const parsed = JSON.parse(text + decoder.decode())
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed
  } catch { throw new ApiError('提交格式不正确。') }
}
function cookieName(request: Request, kind: string) {
  const url = new URL(request.url)
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
  return { name: local ? `ymx_${kind}_dev` : `__Host-ymx_${kind}`, secure: !local }
}
export function readCookie(request: Request, kind: string) {
  const { name } = cookieName(request, kind)
  const value = (request.headers.get('Cookie') ?? '').split(';').map(item => item.trim()).find(item => item.startsWith(name + '='))?.slice(name.length + 1)
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined
}
export function cookie(request: Request, kind: string, value: string, age: number) {
  const { name, secure } = cookieName(request, kind)
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`
}
export async function owner(request: Request) {
  const token = readCookie(request, 'buyer')
  if (!token) throw new ApiError('订单访问凭据已失效，请刷新页面重试。', 401)
  return hash(token)
}
