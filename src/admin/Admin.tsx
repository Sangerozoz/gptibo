import TicketWorkspace from '@/components/ticket-workspace'
import { StoreSettingsPage, CategoryAdminPage, ProductAdminPage } from './DirectStorePages'
import { getAdminNavigation } from './navigation'
import type { DirectSite } from '../../shared/direct-store'
import { TicketAlerts } from './TicketAlerts'
import { RechargeRecoveryPanel, type RechargeCredential } from './RechargeRecoveryPanel'
import SecurityPage from './SecurityPage'
import { restartAdminAccess } from '@/lib/admin-access'
import { useAuthVerification } from '@/components/use-auth-verification'
import { PaymentChannelsPanel } from './PaymentChannelsPanel'
import { EmailDeliveryPanel } from './EmailDeliveryPanel'
import { XGiftPanel } from './XGiftPanel'
import { GmailOrderPanel, GmailSupplierPanel } from './GmailSupplierPanel'
import { productNameForPlan, productNameForId, emailProduct } from '../../shared/email-products'
import { activityCopy } from '@/lib/activity-copy'
import { platformPaymentLabel, type PlatformOrderStatus } from '../../shared/platform-order-status'
import { applyAppearance } from '@/lib/appearance'
import { useResource } from '@/lib/use-resource'
import { Feedback, WorkspaceBoot } from '@/components/workspace-loading'
import { useSession } from '@/lib/use-session'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowUpRight, Check, ClipboardList, FileText, LayoutDashboard, LogOut, Mail, Package, Plug, RefreshCw, Search, ShieldCheck, Sun, Moon, MessageCircle, ChartNoAxesCombined, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/copy-button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import RefundsPage from './RefundsPage'
import PartnersPage from './PartnersPage'
import AdminVisitorsPage from './VisitorsPage'
import AccountingPage from './AccountingPage'
import InvoiceWorkspace from '@/components/invoice-workspace'
import CustomerManagement from '@/components/customer-management'
import PartnerRankingChart from './PartnerRankingChart'
import { VisitorStats } from '@/components/visitor-stats'
import { OrderActionForm } from './OrderActionForm'
import { Users } from 'lucide-react'
import { BrandMark } from '@/components/brand'
import { SupportContactsPanel } from '@/components/support-contacts'
import { api, errorMessage } from '@/lib/api'
import { orderLabel, ORDER_LABELS } from '@/lib/demo-orders'
import type { ServerOrder } from '@/lib/use-store'
import '../App.css'
import '../styles/motion.css'
import './admin.css'

const money = (cents: number) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(cents / 100)
const time = (value: number | string) => new Date(typeof value === 'string' && !value.includes('T') ? value.replace(' ', 'T') + 'Z' : value).toLocaleString('zh-CN', { hour12: false })
const productName = (plan: string) => emailProduct(plan) ? productNameForId(emailProduct(plan)!.productId) : productNameForPlan(plan)
const viewIcons: Record<string, LucideIcon> = {
  overview: LayoutDashboard, 'store-settings': Package, contacts: MessageCircle,
  categories: LayoutDashboard, products: Package, interest: Mail,
  orders: ClipboardList, refunds: ShieldCheck, customers: Users,
  visitors: ChartNoAxesCombined, accounting: ChartNoAxesCombined,
  partners: Users, tickets: MessageCircle, invoices: FileText,
  integrations: Plug, security: ShieldCheck,
}
type Session = { authenticated: boolean; configured: boolean; mailReady: boolean; username?: string; partnerModeEnabled?: boolean }
type Overview = { stats: { total: number; pending: number; active: number; completed: number; refund_amount: number; paid_amount: number }; interest: { total: number }; recent: ServerOrder[] }
type Detail = { order: ServerOrder & { platformStatus: PlatformOrderStatus | null; rechargeCredential?: RechargeCredential }; events: { id: string; actor: string; action: string; note: string; to_status: string; created_at: number }[] }
function SettlementBadge({ status }: { status?: 'pending' | 'paid' | null }) {
  if (!status) return null
  return <Badge variant="outline" className="admin-settlement-badge" data-state={status}>{status === 'paid' ? '已结算' : '结算处理中'}</Badge>
}
function OrderTable({ orders, onSelect }: { orders: ServerOrder[]; onSelect: (id: string) => void }) {
  if (!orders.length) return <div className="admin-empty"><ClipboardList size={28} /><h3>还没有订单</h3><p>前台创建的订单会显示在这里。</p><a href="/" target="_blank" rel="noreferrer">打开商店 <ArrowUpRight size={14} /></a></div>
  return <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>订单 / 创建时间</th><th>商品套餐</th><th>订单金额</th><th>状态</th><th>类型</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{orders.map(o => <tr key={o.id}><td><button className="admin-order-id" onClick={() => onSelect(o.id)} title={o.id}>{o.id}</button><small>{time(o.createdAt)}</small></td><td>{o.isTest ? '支付联调测试' : productName(o.plan)}<small>{o.planName}{o.partnerName && ` · ${o.partnerName}`}</small></td><td className="admin-numeric">{money(o.paymentSummary?.amountCents ?? Math.round(o.price * 100))}<small>{o.paymentStatus === 'simulated' ? '无实际收款' : o.paymentStatus === 'paid' ? '已到账' : '未付款'}</small></td><td><span className={`status-pill status-${o.status}`}><span />{orderLabel(o)}</span><SettlementBadge status={o.settlementStatus} /></td><td><span className="admin-mode">{o.isTest ? '实付测试' : o.mode === 'demo' ? '历史测试记录' : '正式'}</span></td><td><Button variant="ghost" onClick={() => onSelect(o.id)}>查看 <ArrowUpRight size={14} /></Button></td></tr>)}</tbody></table></div>
}
function Pagination({ page, total, onChange }: { page: number; total: number; onChange: (p: number) => void }) {
  return <div className="admin-pagination"><span>共 {total} 条 · 第 {page} / {Math.max(1, Math.ceil(total / 20))} 页</span><div><Button variant="outline" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</Button><Button variant="outline" disabled={page * 20 >= total} onClick={() => onChange(page + 1)}>下一页</Button></div></div>
}
function OverviewPage({ revision, onSelect, onOrders, onVisitors, partnerModeEnabled }: { revision: number; onSelect: (id: string) => void; onOrders: () => void; onVisitors?: () => void; partnerModeEnabled: boolean }) {
  const { data, error, loading } = useResource<Overview>('/api/admin/overview', revision)
  return <><Feedback error={error} loading={loading} data={data} shape="overview" />{data && <><div className="admin-metrics">{[['全部订单', data.stats.total], ['待付款', data.stats.pending ?? 0], ['处理中 / 需处理', data.stats.active ?? 0], ['已完成', data.stats.completed ?? 0]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><div className="admin-summary"><div><span>净收款（扣退款）</span><strong>{money(data.stats.paid_amount)}</strong></div><div><span>累计退款</span><strong>{money(data.stats.refund_amount ?? 0)}</strong></div><div><span>上线提醒登记</span><strong>{data.interest.total}<small>条</small></strong></div></div><div className="admin-overview-charts"><VisitorStats endpoint="/api/admin/visitors" revision={revision} title="全站访客与流量趋势" description="全站各渠道与直营商店的独立访客走势" action={onVisitors && <Button variant="ghost" size="sm" onClick={onVisitors}>{partnerModeEnabled ? '各商店分布' : '访客详情'} <ArrowUpRight size={14} /></Button>} />{partnerModeEnabled && <PartnerRankingChart revision={revision} />}</div><section className="admin-panel"><div className="admin-panel-title"><h2>最近订单</h2><Button variant="ghost" onClick={onOrders}>全部订单 <ArrowUpRight size={15} /></Button></div><OrderTable orders={data.recent} onSelect={onSelect} /></section></>}</>
}
function OrdersPage({ revision, onSelect }: { revision: number; onSelect: (id: string) => void }) {
  const [search, setSearch] = useState(''); const [q, setQ] = useState(''); const [status, setStatus] = useState(''); const [plan, setPlan] = useState(''); const [page, setPage] = useState(1)
  const params = new URLSearchParams({ q, status, plan, page: String(page) })
  const { data, error, loading } = useResource<{ orders: ServerOrder[]; total: number }>(`/api/admin/orders?${params}`, revision)
  return <section className="admin-panel"><form className="admin-filters" onSubmit={e => { e.preventDefault(); setQ(search); setPage(1) }}><div className="admin-search"><Search size={16} /><Input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索本站 / 上游单号或客户邮箱" aria-label="搜索本站 / 上游单号或客户邮箱" /></div><select aria-label="订单状态" value={status} onChange={e => { setStatus(e.target.value); setPage(1) }}><option value="">全部状态</option>{Object.entries(ORDER_LABELS).map(([value, label]) => <option key={value} value={value}>{value === 'session' ? '待交付 / 待提交资料' : value === 'processing' ? '处理中' : label}</option>)}</select><select aria-label="商品套餐" value={plan} onChange={e => { setPlan(e.target.value); setPage(1) }}><option value="">全部套餐</option><option value="plus">Plus</option><option value="pro-5x">Pro 5×</option><option value="pro-20x">Pro 10×</option><option value="pro-25x">Pro 25×</option><option value="gemini-pro-18m">Gemini Pro 18 个月</option><option value="duolingo-12m">多邻国 1 年</option><option value="codex-sms-once">Codex 接码</option></select><Button type="submit" variant="outline">查询</Button></form><Feedback error={error} loading={loading} data={data} />{data && <>{data.orders.length ? <OrderTable orders={data.orders} onSelect={onSelect} /> : <div className="admin-empty"><Search size={25} /><h3>没有符合条件的订单</h3><p>试试其他订单号或筛选条件。</p></div>}<Pagination page={page} total={data.total} onChange={setPage} /></>}</section>
}
function OrderDetail({ id, onClose, onUpdated }: { id: string; onClose: () => void; onUpdated: () => void }) {
  const [revision, setRevision] = useState(0)
  const { data, error, loading } = useResource<Detail>(`/api/admin/orders/${id}`, revision)
  const [message, setMessage] = useState('')
  const [querying, setQuerying] = useState(false)
  const [queryError, setQueryError] = useState('')
  async function queryPlatform() {
    if (querying) return
    setQuerying(true); setQueryError(''); setMessage('')
    try {
      await api(`/api/admin/orders/${id}/platform-status`, {})
      setMessage('平台付款、充值与退款状态已同步，代理端刷新即可查看。'); setRevision(v => v + 1); onUpdated()
    } catch (e) { setQueryError(errorMessage(e)) }
    finally { setQuerying(false) }
  }
  const title = useRef<HTMLHeadingElement>(null)
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="admin-detail motion-dialog" initialFocus={title}>
      <DialogHeader><DialogTitle ref={title} tabIndex={-1}>订单详情</DialogTitle><DialogDescription className="admin-full-id">{id}</DialogDescription></DialogHeader>
      <Feedback error={error} loading={loading} data={data} shape="detail" />
      {data && <>
        {Boolean(data.order.paymentSummary?.feeCents) && <p className="admin-subtle">商品金额 {money(Math.round(data.order.price * 100))} + 平台手续费 {money(data.order.paymentSummary!.feeCents)}（{data.order.paymentSummary!.feeBps / 100}%）</p>}
        <div className="admin-detail-summary"><div><strong>{productName(data.order.plan)} · {data.order.planName}</strong><span>{time(data.order.createdAt)}</span></div><strong>{money(data.order.paymentSummary?.amountCents ?? Math.round(data.order.price * 100))}</strong></div>
        <div className="admin-detail-flags"><span className={`status-pill status-${data.order.status}`}>{orderLabel(data.order)}</span><span className="admin-mode">{data.order.mode === 'demo' ? '历史测试记录 · 不计入收入' : '正式订单'}</span><SettlementBadge status={data.order.settlementStatus} /></div>
          <div className="admin-order-source" aria-label="订单来源"><div><span>代理名称</span><strong>{data.order.partnerSource?.name ?? '平台订单'}</strong></div>{data.order.partnerSource ? <><div><span>专属链接标识</span><strong>{data.order.partnerSource.slug}</strong></div><div><span>代理邮箱</span><strong><a href={`mailto:${data.order.partnerSource.email}`}>{data.order.partnerSource.email}</a></strong></div>{data.order.partnerSource.wechat && <div><span>微信</span><strong>{data.order.partnerSource.wechat}</strong></div>}{data.order.partnerSource.qq && <div><span>QQ</span><strong>{data.order.partnerSource.qq}</strong></div>}</> : <div><span>来源类型</span><strong>平台直营</strong></div>}</div>
        <p className="admin-subtle">客户下单邮箱：{data.order.customerEmail || '旧订单未留邮箱'} · 本站已记账退款 {money(data.order.refundedCents ?? 0)}{data.order.refundHold && ' · 售后处理中，请前往退款与售后处理'}</p>
        {data.order.platformStatus && <section className="admin-platform-status" aria-label="平台付款、充值与退款状态">
          <div className="admin-platform-status-heading"><h3>平台订单状态</h3><Button variant="outline" size="sm" disabled={querying || loading} onClick={() => void queryPlatform()}><RefreshCw size={14} />{querying ? '同步中…' : '同步平台状态'}</Button></div>
          {data.order.platformStatus.remoteId && <div className="admin-upstream-order"><span>上游单号</span><code>{data.order.platformStatus.remoteId}</code><CopyButton value={data.order.platformStatus.remoteId} label="复制上游单号" variant="outline" size="sm" /></div>}
          <dl><div><dt>付款状态</dt><dd>{platformPaymentLabel(data.order.platformStatus.paymentStatus)}</dd></div><div><dt>平台已退金额</dt><dd>{money(data.order.platformStatus.refundedCents)}</dd></div><div><dt>最近核验</dt><dd>{data.order.platformStatus.checkedAt ? time(data.order.platformStatus.checkedAt) : '尚未核验'}</dd></div></dl>
          {data.order.platformStatus.financialHold && <p className="admin-subtle">平台退款与本站账务待核对，充值和代理收益已冻结。</p>}
          <Feedback error={queryError} />
        </section>}
        {data.order.platformStatus && <RechargeRecoveryPanel order={data.order} upstreamOrderId={data.order.platformStatus.remoteId} credential={data.order.rechargeCredential} onUpdated={() => { setRevision(v => v + 1); onUpdated() }} />}
        {data.order.plan === 'gmail-account' && <GmailOrderPanel id={data.order.id} revision={revision} orderVersion={data.order.version} onSaved={() => { setRevision(v => v + 1); onUpdated() }} />}
        {emailProduct(data.order.plan) && <EmailDeliveryPanel key={`delivery-${data.order.version}`} order={data.order} onSaved={() => { setRevision(v => v + 1); onUpdated() }} />}
        <h3>处理记录</h3>
        <ol className="admin-timeline">{data.events.map(event => <li key={event.id}><div><strong>{activityCopy(event.note || event.action)}</strong><time>{time(event.created_at)}</time></div><span>{event.actor === 'customer' ? '用户' : event.actor === 'system' ? '系统' : '管理员'} · {orderLabel({ ...data.order, status: event.to_status as keyof typeof ORDER_LABELS, fulfillment: undefined, refundedCents: 0, platformStatus: null, refundHold: false, redemptionBlocked: false })}</span></li>)}</ol>
        {message && <p className="admin-success" role="status">{message}</p>}
        <OrderActionForm key={`actions-${data.order.version}`} order={data.order} loading={loading} onRefresh={() => { setMessage(''); setRevision(v => v + 1) }} onSaved={result => { setMessage(result); setRevision(v => v + 1); onUpdated() }} />
      </>}
    </DialogContent>
  </Dialog>
}
function InterestPage({ revision }: { revision: number }) {
  const [page, setPage] = useState(1)
  const { data, error, loading } = useResource<{ rows: { id: string; product: string; email: string; consent_version: string; created_at: string }[]; total: number }>(`/api/admin/interest?page=${page}`, revision)
  return <section className="admin-panel"><div className="admin-panel-title"><h2>上线提醒登记</h2><span>上线通知尚未启用 · 仅保存登记</span></div><Feedback error={error} loading={loading} data={data} />{data && <><div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>邮箱</th><th>关注商品</th><th>登记时间</th><th>邮箱状态</th></tr></thead><tbody>{data.rows.map(row => <tr key={row.id}><td>{row.email}</td><td>{row.product === 'claude' ? 'Claude' : 'Grok'}</td><td>{time(row.created_at)}</td><td><span className="admin-pill">未验证</span></td></tr>)}</tbody></table>{!data.rows.length && <div className="admin-empty"><Mail size={25} /><h3>暂无登记</h3><p>用户提交的上线提醒会保存在这里。</p></div>}</div><Pagination page={page} total={data.total} onChange={setPage} /></>}<p className="admin-panel-footnote">邮箱仅用于用户同意的商品上线通知。用户取消后，登记会从此处移除。</p></section>
}
function IntegrationsPage({ revision }: { revision: number }) {
  return <div className="integration-workspace"><PaymentChannelsPanel revision={revision} /><div className="integration-services"><RechargeIntegrationsPage revision={revision} /><XGiftPanel revision={revision} /><GmailSupplierPanel revision={revision} /></div></div>
}
function RechargeIntegrationsPage({ revision }: { revision: number }) {
  const { data, error, loading } = useResource<{ integrations: { resend: boolean; alipay: boolean; supplier: boolean; supplierCheckout: boolean; fivesim: boolean } }>('/api/admin/overview', revision)
  const [reconciling, setReconciling] = useState(false); const [result, setResult] = useState(''); const [syncError, setSyncError] = useState('')
  const [checkingFiveSim, setCheckingFiveSim] = useState(false); const [fiveSimResult, setFiveSimResult] = useState(''); const [fiveSimError, setFiveSimError] = useState('')
  const running = useRef(false)
  const reconcile = async () => {
    if (running.current) return
    running.current = true; setReconciling(true); setResult(''); setSyncError('')
    try { const response = await api<{ checked: number; failed: number }>('/api/admin/recharge/reconcile', {}); setResult(`已核对 ${response.checked} 笔订单，${response.failed} 笔等待重试。`) }
    catch (e) { setSyncError(errorMessage(e)) }
    finally { running.current = false; setReconciling(false) }
  }
  const checkFiveSim = async () => {
    if (checkingFiveSim) return
    setCheckingFiveSim(true); setFiveSimResult(''); setFiveSimError('')
    try {
      const status = await api<{ configured: boolean; connected: boolean; balance?: number }>('/api/admin/fivesim/status')
      setFiveSimResult(status.connected ? `5SIM 连接正常，账户余额 ${status.balance}。` : '5SIM 密钥待配置。')
    } catch (e) { setFiveSimError(errorMessage(e)) }
    finally { setCheckingFiveSim(false) }
  }
  const status = (ready: boolean | undefined) => !data ? error ? '暂不可用' : '读取中' : ready ? '已配置' : '待配置'
  const services = [
    { name: 'Recharge 平台代收 / 充值', detail: 'ChatGPT 收款与自动充值', state: data?.integrations.supplierCheckout ? '已开放' : status(data?.integrations.supplier), icon: Package },
    { name: 'Resend 邮件', detail: '登录验证码与订单邮件', state: status(data?.integrations.resend), icon: Mail },
    { name: 'Codex 接码 · 5SIM', detail: data?.integrations.fivesim ? '接口密钥已配置；商品尚未上架' : '接口已准备；密钥待配置，商品尚未上架', state: status(data?.integrations.fivesim), icon: MessageCircle },
  ]
  return <section className="integration-service-section">
    <div className="integration-section-title"><div><h2>业务服务</h2><p>充值、交付与通知服务的接入状态。</p></div><Button variant="outline" disabled={reconciling || !data?.integrations.supplier} onClick={() => void reconcile()}><RefreshCw size={14} className={reconciling ? 'integration-spinning' : undefined} />{reconciling ? '核对中…' : '核对充值订单'}</Button></div>
    <Feedback error={error || syncError} loading={loading} data={data} shape="compact" />
    {result && <p className="admin-success" role="status">{result}</p>}
    <div className="integration-service-rows">{services.map(({name, detail, state, icon: Icon}) => <div key={name}><div className="integration-service-icon"><Icon size={19} /></div><div><h3>{name}</h3><p>{detail}</p></div><span className={`connection-state ${['已配置', '已开放'].includes(state) ? 'is-ready' : ''}`}>{state}</span></div>)}</div>
    <Button variant="outline" disabled={checkingFiveSim || !data?.integrations.fivesim} onClick={() => void checkFiveSim()}>{checkingFiveSim ? '检测中…' : '检测 5SIM 连接'}</Button>
    {fiveSimResult && <p className="admin-success" role="status">{fiveSimResult}</p>}
    {fiveSimError && <p className="admin-error" role="alert">{fiveSimError}</p>}
  </section>
}
export default function Admin() {
  const [accessRequired, setAccessRequired] = useState(false)
  const [restartingAccess, setRestartingAccess] = useState(false)
  const [accessError, setAccessError] = useState('')
  const accessRestartPending = useRef(false)
  async function reauthenticate() {
    if (accessRestartPending.current) return
    accessRestartPending.current = true
    setRestartingAccess(true); setAccessError('')
    try { await restartAdminAccess() }
    catch {
      accessRestartPending.current = false
      setRestartingAccess(false)
      setAccessError('未能重置安全验证，请重试；也可以先手动退出安全验证，再重新打开后台。')
    }
  }
  useEffect(() => {
    const requireAccess = () => setAccessRequired(true)
    window.addEventListener('ymx-admin-access-required', requireAccess)
    return () => window.removeEventListener('ymx-admin-access-required', requireAccess)
  }, [])
  const sendHuman = useAuthVerification('admin_send')
  const loginHuman = useAuthVerification('admin_verify')
  const { session, error: sessionError, setError: setSessionError, check: checkSession, clear: clearSession } = useSession<Session>('/api/admin/session', 'admin', !accessRequired)
  const [username, setUsername] = useState(''); const [code, setCode] = useState(''); const [busy, setBusy] = useState(false)
  const [emailCode, setEmailCode] = useState(''); const [challenge, setChallenge] = useState<{ id: string; username: string }>(); const [sending, setSending] = useState(false); const [cooldown, setCooldown] = useState(0); const [mailNotice, setMailNotice] = useState('')
  const [selectedView, setView] = useState('overview'); const [revision, setRevision] = useState(0); const [detail, setDetail] = useState<string>()
  const view = !session?.partnerModeEnabled && ['tickets', 'invoices', 'partners'].includes(selectedView) ? 'overview' : selectedView
  const publicCatalog = useResource<{ site?: DirectSite }>('/api/catalog', revision)
  const ownerName = publicCatalog.data?.site?.nameZh ?? '硅基生物'
  const ownerLogo = publicCatalog.data?.site?.logoUrl
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [view])
  useEffect(() => applyAppearance(dark), [dark])
  useEffect(() => { if (cooldown <= 0) return; const timer = setTimeout(() => setCooldown(v => v - 1), 1000); return () => clearTimeout(timer) }, [cooldown])
  async function sendCode() {
    if (!sendHuman.ready || busy || sending || cooldown || !username.trim()) return
    setSending(true); setSessionError(''); setMailNotice(''); setEmailCode(''); setChallenge(undefined)
    const requestedUsername = username.trim()
    try {
      const result = await api<{ challenge: string; message: string; retryAfter: number }>('/api/admin/login/email-code', { username: requestedUsername, ...sendHuman.consume() })
      setChallenge({ id: result.challenge, username: requestedUsername }); setMailNotice(result.message); setCooldown(result.retryAfter)
    } catch (e) { setSessionError(errorMessage(e)) } finally { setSending(false) }
  }
  async function login() {
    if (!loginHuman.ready || busy || sending || !challenge || challenge.username !== username.trim()) return
    setBusy(true); setSessionError('')
    try { await api('/api/admin/login', { username: username.trim(), code, emailCode, challenge: challenge.id, ...loginHuman.consume() }); setCode(''); setEmailCode(''); setChallenge(undefined); setMailNotice(''); await checkSession() } catch (e) { setSessionError(errorMessage(e)) } finally { setBusy(false) }
  }
  async function logout() { setBusy(true); try { await api('/api/admin/logout', {}); clearSession(); setUsername(''); setCode(''); setEmailCode(''); setChallenge(undefined); setMailNotice(''); setDetail(undefined) } catch (e) { setSessionError(errorMessage(e)) } finally { setBusy(false) } }
  if (accessRequired) return <main className="admin-login"><div className="admin-login-box"><div className="admin-brand">{ownerLogo ? <img src={ownerLogo} alt="" width="26" height="26" /> : <BrandMark />}<strong>{ownerName}</strong><span>管理后台</span></div><ShieldCheck className="admin-login-icon" size={30} /><h1>重新进行安全验证</h1><p>点击下方按钮，先退出旧的 Cloudflare 安全验证会话，再使用授权管理员邮箱重新验证。</p><Button onClick={() => void reauthenticate()} disabled={restartingAccess}>{restartingAccess ? '正在重置安全验证…' : '前往安全验证'}</Button>{accessError && <><p role="alert">{accessError}</p><a href="/cdn-cgi/access/logout">手动退出安全验证</a></>}<small>完成验证前，已暂停后台请求。</small></div></main>
  if (!session && !sessionError) return <WorkspaceBoot />
  if (!session?.authenticated) return <main className="admin-login"><a className="admin-back" href="/"><ArrowLeft size={15} />返回商店</a><div className="admin-login-box"><div className="admin-brand">{ownerLogo ? <img src={ownerLogo} alt="" width="26" height="26" /> : <BrandMark />}<strong>{ownerName}</strong><span>管理后台</span></div><ShieldCheck className="admin-login-icon" size={30} /><h1>登录工作台</h1><p>管理商品、查看订单，跟进每一次服务。</p><Feedback error={sessionError} />{!session ? sessionError ? <Button variant="outline" onClick={() => void checkSession()}>重新连接</Button> : <Feedback loading /> : !session.configured ? <div className="admin-setup"><h2>等待管理员初始化</h2><p>后台已部署，尚未设置登录身份。请在项目终端运行 <code>npm run admin:setup</code> 配置管理员账号与验证器。</p><Button variant="outline" onClick={() => void checkSession()}>已配置，重新检查</Button></div> : <form onSubmit={e => { e.preventDefault(); void login() }}>
      <label htmlFor="admin-username">用户名</label>
      <Input id="admin-username" autoComplete="username" placeholder="请输入管理员用户名" value={username} onChange={e => { setUsername(e.target.value); setChallenge(undefined); setEmailCode(''); setMailNotice('') }} disabled={busy || sending} required maxLength={80} />
      {sendHuman.widget}
      <label htmlFor="admin-email-code">邮箱验证码</label>
      <div className="admin-email-code-row"><Input id="admin-email-code" inputMode="numeric" autoComplete="one-time-code" placeholder="6 位邮箱验证码" value={emailCode} onChange={e => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))} disabled={busy || sending} required pattern="[0-9]{6}" minLength={6} maxLength={6} aria-describedby="admin-email-help" /><Button type="button" variant="outline" onClick={() => void sendCode()} disabled={!sendHuman.ready || busy || sending || cooldown > 0 || !username.trim() || !session.mailReady}>{sending ? '发送中…' : cooldown > 0 ? cooldown + ' 秒后重发' : '获取验证码'}</Button></div>
      <p id="admin-email-help" className="admin-code-help">验证码发送至预设管理员邮箱，10 分钟内有效。</p>
      {mailNotice && <p role="status" className="admin-code-help">{mailNotice}</p>}
      {!session.mailReady && <p role="alert" className="admin-code-help">邮箱验证服务尚未启用，暂时无法登录。</p>}
      <label htmlFor="admin-code">2FA 验证码</label>
      <Input id="admin-code" inputMode="numeric" autoComplete="off" placeholder="6 位验证器验证码" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} disabled={busy || sending} required pattern="[0-9]{6}" minLength={6} maxLength={6} aria-describedby="admin-code-help" />
      <p id="admin-code-help" className="admin-code-help">打开已绑定的验证器，输入当前验证码。</p>
      {challenge && loginHuman.widget}
      <Button type="submit" disabled={!loginHuman.ready || busy || sending || !session.mailReady || !username.trim() || !challenge || challenge.username !== username.trim() || emailCode.length !== 6 || code.length !== 6}>{busy ? '正在登录…' : '登录后台'}</Button>
    </form>}<small>仅授权管理员可访问</small></div></main>
  const visibleGroups = getAdminNavigation(Boolean(session.partnerModeEnabled))
  const visibleViews = visibleGroups.flatMap(group => group.items)
  const current = visibleViews.find(v => v.id === view) ?? visibleViews[0]
  return <div className="admin-shell"><aside className="admin-sidebar"><a className="admin-brand" href="/admin">{ownerLogo ? <img src={ownerLogo} alt="" width="26" height="26" /> : <BrandMark />}<strong>{ownerName}</strong></a><nav aria-label="后台导航">{visibleGroups.map(group => <div className="admin-nav-group" role="group" aria-labelledby={'admin-nav-' + group.id} key={group.id}><span className="admin-nav-group-label" id={'admin-nav-' + group.id}>{group.label}</span><div className="admin-nav-group-items">{group.items.map(item => { const Icon = viewIcons[item.id]; return <Button variant="ghost" key={item.id} aria-current={view === item.id ? 'page' : undefined} onClick={() => setView(item.id)}><Icon size={17} />{item.label}</Button> })}</div></div>)}</nav><div className="admin-sidebar-bottom"><span><ShieldCheck size={15} />{session.username}</span><Button variant="ghost" onClick={() => void logout()} disabled={busy}><LogOut size={15} />退出登录</Button></div></aside><div className="admin-workspace"><header className="admin-topbar"><span>{ownerName} / {current.label}</span><div><a href="/" target="_blank" rel="noreferrer">查看前台 <ArrowUpRight size={14} /></a><Button variant="ghost" size="icon" aria-label={dark ? '切换亮色模式' : '切换暗色模式'} onClick={() => setDark(v => !v)}>{dark ? <Sun size={17} /> : <Moon size={17} />}</Button></div></header><main className="admin-main"><div className="admin-page-heading"><div><span>WORKSPACE</span><h1 ref={heading} tabIndex={-1}>{current.label}</h1><p>{view === 'orders' ? '从创建到完成，查看订单与处理记录。' : view === 'store-settings' ? '维护前台显示的店铺名称和 Logo。' : view === 'categories' ? '新增、排序、改名和停用前台分类。' : view === 'products' ? '编辑商品信息、上下架、套餐与售价。' : view === 'accounting' ? '筛选订单查看净利润，按清账周期保存统计。' : view === 'invoices' ? '管理代理开票申请与手续费收款，登记平台提交进度。' : view === 'customers' ? '查看全部客户的会员账号、到期时间与续费记录。' : view === 'contacts' ? '设置平台商店向客户展示的联系方式。' : view === 'integrations' ? '管理收款方式、平台手续费与业务服务。' : '基于服务器记录，了解服务与订单进展。'}</p></div><Button variant="outline" onClick={() => { setRevision(v => v + 1); void checkSession() }}><RefreshCw size={15} />刷新</Button></div>{session.partnerModeEnabled && <TicketAlerts onOpen={() => setView('tickets')} onRefunds={() => { setView('refunds'); setRevision(v => v + 1) }} />}<Feedback error={sessionError} />{view === 'tickets' && <TicketWorkspace admin revision={revision} onOrder={setDetail} />}{view === 'security' && <SecurityPage revision={revision} />}{view === 'overview' && <OverviewPage revision={revision} partnerModeEnabled={session.partnerModeEnabled !== false} onSelect={setDetail} onOrders={() => setView('orders')} onVisitors={() => setView('visitors')} />}{view === 'orders' && <OrdersPage revision={revision} onSelect={setDetail} />}{view === 'refunds' && <RefundsPage revision={revision} />}{view === 'store-settings' && <StoreSettingsPage revision={revision} onUpdated={() => setRevision(v => v + 1)} />}{view === 'categories' && <CategoryAdminPage revision={revision} onUpdated={() => setRevision(v => v + 1)} />}{view === 'products' && <ProductAdminPage revision={revision} onUpdated={() => setRevision(v => v + 1)} partnerModeEnabled={session.partnerModeEnabled !== false} />}{view === 'interest' && <InterestPage revision={revision} />}{view === 'contacts' && <SupportContactsPanel endpoint="/api/admin/support-contacts" revision={revision} />}{view === 'integrations' && <IntegrationsPage revision={revision} />}{view === 'partners' && <PartnersPage revision={revision} />}{view === 'visitors' && <AdminVisitorsPage revision={revision} />}{view === 'accounting' && <AccountingPage revision={revision} />}{view === 'invoices' && <InvoiceWorkspace admin revision={revision} />}{view === 'customers' && <CustomerManagement admin revision={revision} />}<footer className="admin-footer"><Check size={13} />订单与操作记录可追溯</footer></main></div>{detail && <OrderDetail key={detail} id={detail} onClose={() => setDetail(undefined)} onUpdated={() => setRevision(v => v + 1)} />}</div>
}
