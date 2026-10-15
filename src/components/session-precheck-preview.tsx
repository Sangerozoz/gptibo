import { useState } from 'react'
import { ArrowUpRight, Check, Moon, RotateCcw, ShieldCheck, Sun } from 'lucide-react'
import { LiveCheckout } from './live-checkout'
import { BrandMark } from './brand'
import type { ServerOrder } from '@/lib/use-store'
import type { PlanId } from '@/lib/demo-orders'
import type { api } from '@/lib/api'
import type { SessionPrecheck } from './session-precheck'
import '@/App.css'
import '@/styles/motion.css'
import '@/styles/session-precheck-preview.css'

const cases: { id: string; label: string; note: string; state: SessionPrecheck['state']; code: string }[] = [
  { id: 'pass', label: '检测通过', note: 'PHP 网页 Plus 升级 Pro', state: 'eligible', code: 'php_web_plus_upgrade' },
  { id: 'store', label: '商店订阅等待期', note: '到期后还未满 72 小时', state: 'wait', code: 'store_wait_72h' },
  { id: 'web', label: '网页订阅未到期', note: '普通续费需要等待', state: 'wait', code: 'web_wait_expiry' },
  { id: 'expired', label: 'Session 已过期', note: '引导重新获取登录资料', state: 'expired', code: 'locally_expired' },
  { id: 'invalid', label: '校验无效', note: '官方 401／403', state: 'invalid', code: 'upstream_blocked' },
  { id: 'currency', label: '升级条件不符', note: '原订阅账单为非 PHP', state: 'ineligible', code: 'upgrade_requires_php' },
  { id: 'limited', label: '请求限流', note: '自动提交，由上游继续判断', state: 'deferred', code: 'rate_limited' },
  { id: 'timeout', label: '检测超时', note: '等待 10 秒后自动提交', state: 'deferred', code: 'query_timeout' },
  { id: 'unknown', label: '信息不足', note: '资料不全，提交上游判断', state: 'deferred', code: 'business_evidence_missing' },
]
const sample = JSON.stringify({ user: { email: 'demo@example.com' }, accessToken: 'demo-local-synthetic-only', expires: '2099-01-01T00:00:00Z' }, null, 2)
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(new DOMException('cancelled', 'AbortError')); return }
  const finish = () => { signal?.removeEventListener('abort', abort); resolve() }
  const timer = setTimeout(finish, ms)
  const abort = () => { clearTimeout(timer); reject(new DOMException('cancelled', 'AbortError')) }
  signal?.addEventListener('abort', abort, { once: true })
})
function PreviewOrder({ selected }: { selected: typeof cases[number] }) {
  const plan: PlanId = selected.id === 'web' || selected.id === 'store' ? 'plus' : 'pro-20x'
  const [submitted, setSubmitted] = useState(false)
  const [order, setOrder] = useState<ServerOrder>(() => ({ id: 'LOCAL-PREVIEW', plan, planName: plan === 'plus' ? 'Plus' : 'Pro 10×', price: 100, createdAt: Date.now(), updatedAt: Date.now(), version: 1, mode: 'live', status: 'session', paymentStatus: 'paid', fulfillment: { precheckRequired: true, paymentUrl: null, expiresAt: null, rechargeStatus: null, retryKey: null, retryMode: null, canSubmit: true, message: null, accountEmailMasked: null, finishedAt: null } }))
  const transport: typeof api = async <T,>(path: string, data?: unknown, signal?: AbortSignal): Promise<T> => {
    if (path.endsWith('/session-precheck')) {
      await sleep(selected.id === 'timeout' ? 10000 : 1800, signal)
      return { precheck: { state: selected.state, code: selected.code, target: plan, eligibleAt: selected.state === 'wait' ? new Date(Date.now() + (selected.id === 'store' ? 24 : 12) * 3600000).toISOString() : null, receipt: ['eligible', 'deferred'].includes(selected.state) ? 'local-preview-no-authority' : undefined } } as T
    }
    if ((data as { action?: string })?.action === 'submit') {
      await sleep(1600, signal); setSubmitted(true)
      return { order: { ...order, status: 'processing', fulfillment: { ...order.fulfillment, canSubmit: false, rechargeStatus: 'queued', progressStage: 'queued' } } } as T
    }
    return { order } as T
  }
  return <div className="precheck-preview-order"><div className="precheck-preview-receipt"><span>完成付款 · 连接账号</span><strong>ChatGPT {order.planName}<ArrowUpRight size={16} /></strong></div>
    <LiveCheckout order={order} open onOrderUpdated={setOrder} onOrders={() => {}} transport={transport} initialSession={sample} />
    <div className="precheck-preview-proof"><ShieldCheck size={14} /><span>{submitted ? '演示：已进入充值流程。未创建真实充值。' : '演示账号已填入。勾选确认后，点击按钮体验完整流程。'}</span></div>
  </div>
}
export default function SessionPrecheckPreview() {
  const [selected, setSelected] = useState(cases[1])
  const [revision, setRevision] = useState(0)
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'))
  return <main className="precheck-preview"><header><div><BrandMark /><span>硅基生物 <small>本地体验</small></span></div><button type="button" onClick={() => { document.documentElement.classList.toggle('dark'); setDark(!dark) }} aria-label="切换深浅色">{dark ? <Sun size={18} /> : <Moon size={18} />}</button></header>
    <div className="precheck-preview-intro"><span>ACCOUNT CHECK · LOCAL PREVIEW</span><h1>先确认账号，<br />再安心充值。</h1><p>新的 Session 提交体验。请选择一种情况，查看客户会收到的提示。</p></div>
    <div className="precheck-preview-grid"><aside><div className="precheck-preview-label">体验不同结果 <span>{cases.length} 种情况</span></div>{cases.map(item => <button type="button" key={item.id} className="precheck-preview-case" aria-pressed={selected.id === item.id} onClick={() => { setSelected(item); setRevision(v => v + 1) }}><span><strong>{item.label}</strong><small>{item.note}</small></span>{selected.id === item.id && <Check size={16} />}</button>)}<button type="button" className="precheck-preview-reset" onClick={() => setRevision(v => v + 1)}><RotateCcw size={14} />重新体验当前情况</button><p className="precheck-preview-note">仅本地模拟，不读取真实账号，不发起支付或充值。线上程序尚未部署。</p></aside><PreviewOrder key={`${selected.id}:${revision}`} selected={selected} /></div>
  </main>
}
