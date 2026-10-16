import { storefrontScopeHeaders } from './storefront-routing.ts'
export class RequestError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}
export async function api<T>(path: string, data?: unknown, signal?: AbortSignal): Promise<T> {
  const admin = path.startsWith('/api/admin/')
  const supplierOperation = data !== undefined && (path === '/api/orders' || /^\/api\/partner\/domains\/[^/]+\/payment$/.test(path) || /^\/api\/admin\/orders\/[^/]+\/(platform-status|recharge-retry)$/.test(path) || /^\/api\/orders\/[^/]+\/fulfillment$/.test(path) || /^\/api\/admin\/refunds\/[^/]+$/.test(path))
  const timeout = AbortSignal.timeout(/\/session-precheck$/.test(path) || /\/recharge-retry$/.test(path) ? 65000 : supplierOperation ? 50000 : path === '/api/orders/xgift/eligibility' ? 35000 : 15000)
  const headers: Record<string, string> = data === undefined ? {} : { 'Content-Type': 'application/json' }
  if (typeof location !== 'undefined' && (path.startsWith('/api/orders') || path.startsWith('/api/catalog'))) Object.assign(headers, storefrontScopeHeaders())
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: admin ? 'manual' : 'follow', headers, body: data === undefined ? undefined : JSON.stringify(data), signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  // Access may redirect before the Worker runs. Do not follow that cross-origin
  // redirect with fetch: browsers hide it as a CORS error instead of showing login.
  if (admin && (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400))) {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('ymx-admin-access-required'))
    throw new RequestError('管理员安全验证已失效，请重新进行安全验证。', 403)
  }
  const result = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 403 && result?.code === 'admin_access_required' && admin && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('ymx-admin-access-required'))
    }
    const scope = path.startsWith('/api/admin/') && !/^\/api\/admin\/(login|logout|session)$/.test(path) ? 'admin'
      : path.startsWith('/api/partner/') && !path.startsWith('/api/partner/auth/') ? 'partner' : null
    if (response.status === 401 && scope && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('ymx-session-expired', { detail: scope }))
    }
    throw new RequestError(result?.error ?? '请求失败，请稍后重试。', response.status)
  }
  if (!result) throw new RequestError('服务返回异常，请稍后重试。', 503)
  return result as T
}
export const errorMessage = (e: unknown) => e instanceof RequestError ? e.message : '网络暂时不可用，请稍后重试。'
export type CatalogPlan = { has_coupons?: boolean; supports_warranty?: boolean; partner_enabled?: number; purchase_note?: string; delivery_instructions?: string; display_label?: string; id: string; product_id: string; name: string; price_cents: number; enabled: number; renewal_only: number; version: number }
