import { hash, json, type Env } from './platform.ts'

export async function limitApi(request: Request, env: Env, path: string): Promise<Response | null> {
  if (!path.startsWith('/api/')) return null

  // A single source cannot evade the edge guard by changing paths or query strings.
  const source = await hash(request.headers.get('CF-Connecting-IP') ?? 'local')
  const callback = path === '/api/telegram/webhook' || path === '/api/recharge/webhook' || path === '/api/invoices/notify/alipay' || /^\/api\/payments\/notify\/[^/]+$/.test(path)
  const generalKey = `${callback ? 'callback' : 'api'}:${source}`
  const general = await env.API_LIMITER.limit({ key: generalKey })
  if (!general.success) return json({ error: '请求过于频繁，请一分钟后重试。' }, 429, { 'Retry-After': '60' })

  // These reads can issue multiple D1 queries or a supplier API request.
  const expensive = (request.method === 'GET' && (path === '/api/catalog' || path === '/api/orders' || /^\/api\/orders\/[^/]+$/.test(path)))
    || (request.method === 'POST' && /^\/api\/orders\/[^/]+\/(payment|fulfillment)$/.test(path))
    || (request.method === 'POST' && /^\/api\/(partner|admin)\/invoices\/[^/]+\/payment$/.test(path))
    || (request.method === 'POST' && /^\/api\/admin\/orders\/[^/]+\/(platform-status|delivery|account_supplier)$/.test(path))
    || path.startsWith('/api/admin/account_supplier')
    || (request.method === 'GET' && path === '/api/admin/fivesim/status')
  if (expensive && !(await env.EXPENSIVE_LIMITER.limit({ key: source })).success) {
    return json({ error: '刷新过于频繁，请一分钟后重试。' }, 429, { 'Retry-After': '60' })
  }
  return null
}
