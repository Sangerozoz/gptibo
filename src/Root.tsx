import { StorefrontI18nProvider } from './lib/storefront-i18n-provider'
import { WorkspaceBoot } from './components/workspace-loading'
import { lazy, Suspense, useEffect, useState } from 'react'
import App from './App'

const Admin = lazy(() => import('./admin/Admin'))
const Partner = lazy(() => import('./partner/Partner'))
function PartnerGate() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/partner/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) setEnabled(response.status !== 404) })
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [])
  if (error) return <main className="empty-orders page-width"><h1>暂时无法连接服务</h1><button onClick={() => location.reload()}>重试</button></main>
  if (enabled === null) return <WorkspaceBoot />
  if (!enabled) return <main className="empty-orders page-width"><h1>代理服务暂未开放</h1><p>当前商店由平台直接经营。</p><a href="/">返回商店</a></main>
  return <Suspense fallback={<WorkspaceBoot />}><Partner /></Suspense>
}
export default function Root() {
  return location.pathname === '/admin' || location.pathname.startsWith('/admin/')
    ? <Suspense fallback={<WorkspaceBoot />}><Admin /></Suspense>
    : ['/join', '/join/', '/partner'].includes(location.pathname)
      ? <PartnerGate />
      : <StorefrontI18nProvider><App /></StorefrontI18nProvider>
}
