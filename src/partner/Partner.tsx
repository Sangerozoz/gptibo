import TicketWorkspace, { TicketCreator, TicketDetail } from '@/components/ticket-workspace'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { StoresWorkspace } from './StoresWorkspace'
import { useAuthVerification } from '@/components/use-auth-verification'
import { RECHARGE_STAGES, rechargeStage } from '../../shared/recharge-progress'
import { ProductManagement } from './ProductManagement'
import { OrderSummary } from './OrderSummary'
import { OrderHistory, type PartnerOrderEvent } from './OrderHistory'
import { emailProduct, productNameForPlan } from '../../shared/email-products'
import { isXGiftPlan } from '../../shared/xgift-products'
import InvoiceWorkspace from '@/components/invoice-workspace'
import { confirmedRefundLabel, platformPaymentLabel } from '../../shared/platform-order-status'
import CustomerManagement from '@/components/customer-management'
import { applyAppearance } from '@/lib/appearance'
import { WorkspaceBoot } from '@/components/workspace-loading'
import { useSession } from '@/lib/use-session'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowUpRight, Calendar, ChartNoAxesCombined, Check, CircleHelp, Contact, FileText, LogOut, Mail, Moon, ReceiptText, RefreshCw, Settings2, Sun, Tags, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { WorkspaceTabs, WorkspaceSelect, WorkspaceDisclosure } from './workspace-ui'
import { Switch } from '@/components/ui/switch'
import { NotificationSettings } from './NotificationSettings'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { BrandMark, ProductMark } from '@/components/brand'
import { VisitorStats } from '@/components/visitor-stats'
import { CopyButton } from '@/components/copy-button'
import { Children, ChildOrders } from './Children'
import { api, errorMessage, RequestError } from '@/lib/api'
import { Feedback, Pagination } from './shared'
import { profitLabel } from './order-labels'
import { date, money, payoutLabel, usePartnerData, type Dashboard, type PayoutAccount } from './model'
import { PayoutAccountDialog } from './PayoutAccountDialog'
import { partnerStorefrontPath } from '../../shared/partner-link.ts'
import '../App.css'
import '../admin/admin.css'
import '../styles/motion.css'
import './partner.css'
import './workspace.css'

type Session = { authenticated: boolean; mailReady: boolean }
type PartnerFulfillment = { rechargeStatus?: string | null; failureCode?: string | null; errorCategory?: string | null; progressStage?: string | null; progressUpdatedAt?: number | null; attemptNo?: number | null; canSubmit?: boolean; message?: string | null; failureReason?: string | null; accountEmailMasked?: string | null; finishedAt?: number | null; recoveryAction?: string | null }
type PartnerOrder = { fulfillment?: PartnerFulfillment | null; updated_at?: number; serviceMessage?: string; delivery?: { status: string; sentAt?: number | null }; rechargeReference?: { order_id?: string; redemption_id?: string }; id: string; customer_email: string | null; plan: string; plan_name: string; price_cents: number; cost_cents: number; profit_cents: number; refunded_cents: number; platform_payment_status?: string | null; platform_refunded_cents?: number | null; platform_checked_at?: number | null; refund_hold: number; mode: string; status: string; recharge_status?: string | null; payment_status: string; payout_status: string | null; created_at: number }
const orderProductName = (o: PartnerOrder) => emailProduct(o.plan) || o.plan === 'codex-sms-once'
  ? productNameForPlan(o.plan)
  : (isXGiftPlan(o.plan) ? 'X ' : 'ChatGPT ') + o.plan_name
const refundedAmount = (o: PartnerOrder) => Math.max(o.refunded_cents ?? 0, o.platform_refunded_cents ?? 0)
const refundOrderLabel = (o: PartnerOrder) => confirmedRefundLabel(refundedAmount(o), o.price_cents) ?? (o.refund_hold ? '售后处理中' : null)

function getPayoutExplanation(o: PartnerOrder) {
  if (o.refund_hold) return refundedAmount(o) > 0 ? '平台已确认退款，账务待核对，本单收益暂时冻结。' : '售后申请处理中，本单收益暂时冻结。'
  if (o.mode === 'live' && o.plan === 'duolingo-12m' && o.refunded_cents > 0) return o.payout_status === 'paid' ? '多邻国发生退款，整单收益扣回并通过后续提现抵扣，同一订单不重复扣回。' : '多邻国发生退款，整单收益已扣回，不再计入可提现金额。'
  if (o.payout_status === 'paid' && refundedAmount(o) >= o.price_cents) return '本单曾结算，后续全额退款将按售后规则抵扣。'
  if (refundedAmount(o) >= o.price_cents) return '订单已全额退款，无提现收益。'
  if (o.mode === 'demo') return '历史测试记录，不计入可提现金额。'
  if (o.payout_status === 'paid') return '收益已打款完成，已结算至收款账户。'
  if (o.payout_status === 'pending') return '已提交提现申请，等待平台审核打款。'
  if (o.payment_status !== 'paid') return '客户尚未实际付款，不计入收益。'
  if (o.status === 'cancelled') return '订单已关闭，不计入收益。'
  if (o.status !== 'success') return '待订单交付完成后自动计入可结算金额。'
  if (o.profit_cents > 0) return '订单已完成，收益已计入可结算金额（满 ¥10 可申请提现，每 1 天一次）。'
  return '售价与供货价一致，本单无差价收益。'
}

function SettlementBadge({ status }: { status: string | null }) {
  if (status !== 'pending' && status !== 'paid') return null
  return <Badge variant="outline" className="partner-settlement-badge" data-state={status}>{status === 'paid' ? '已结算' : '结算处理中'}</Badge>
}

export function PartnerOrderDetailDialog({
  order,
  events,
  onClose,
  labels,
  loading = false,
  detailError = '',
  onRefresh,
}: {
  order: PartnerOrder | null
  events?: PartnerOrderEvent[]
  onClose: () => void
  labels: Record<string, string>
  loading?: boolean
  detailError?: string
  onRefresh?: () => void
}) {
  if (!order) return null

  const isHold = Boolean(order.refund_hold)
  const refunded = refundedAmount(order)
  const isRefunded = refunded >= order.price_cents
  const isFailed = order.status === 'failed' && !isHold
  const isSuccess = order.status === 'success' && !isHold && !isRefunded
  const statusText = refundOrderLabel(order) ?? (order.status !== 'success' && order.recharge_status === 'unknown' ? '提交待确认' : null) ?? labels[order.status] ?? order.status
  const isCodex = order.plan === 'codex-sms-once'
  const isX = isXGiftPlan(order.plan)
  const productName = orderProductName(order)
  const productDesc = emailProduct(order.plan) ? '人工处理 · 邮件交付' : isCodex
    ? '单次短信接码验证'
    : isX ? 'X Premium 订阅 · 无需账号密码'
    : order.plan_name.includes('20')
      ? '仅限已有订阅续费'
      : '按月代充订阅服务'
  const fulfillment = order.fulfillment
  const stage = rechargeStage(fulfillment?.progressStage)
  const nextStep = isRefunded ? '退款已确认，可核对客户退款与本单收益。' : isHold ? '售后或账务正在核对，暂不能重新提交充值。' : fulfillment?.recoveryAction === 'refund' ? '平台正在处理退款，尚不代表客户已收到退款。' : order.status === 'success' ? '服务已完成。' : fulfillment?.canSubmit && ['failed', 'cancelled', 'rejected'].includes(fulfillment.rechargeStatus ?? '') ? '可请客户在原订单修正资料并重新提交，无需重复付款。' : ['queued', 'running', 'unknown'].includes(fulfillment?.rechargeStatus ?? '') ? '继续查询原任务，勿重复下单或付款。' : order.status === 'failed' ? '请联系平台核对原订单；未开放重新提交时，请勿重复充值。' : order.status === 'session' ? '请客户在原订单按指引继续办理。' : order.status === 'pending' ? '等待客户付款，已付款但状态未更新时请核对原订单。' : '可在原订单查看进度或联系平台。'
  const marginAdjusted = order.profit_cents !== Math.max(0, order.price_cents - order.cost_cents)

  return (
    <Dialog open={Boolean(order)} onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent className="motion-dialog partner-dialog partner-order-dialog">
        <DialogHeader>
          <DialogTitle>订单详情</DialogTitle>
          <DialogDescription>查看客户订单状态、处理原因和本单收益。</DialogDescription>
        </DialogHeader>

        <div className="partner-order-ticket">
          <div className="partner-order-ticket-id">
            <div className="partner-order-ticket-meta">
              <span className="partner-order-ticket-label">订单号</span>
              {order.mode === 'demo' ? (
                <Badge variant="outline" className="partner-order-mode-badge">历史测试记录</Badge>
              ) : (
                <Badge variant="secondary" className="partner-order-mode-badge">正式订单</Badge>
              )}
            </div>
            <strong className="partner-order-id-value" title={order.id}>{order.id}</strong>
          </div>
          <div className="partner-order-ticket-actions">
            <CopyButton value={order.id} label="复制编号" size="sm" variant="ghost" />
          </div>
        </div>

        <div className="partner-order-product-card">
          <div className="partner-order-product-left">
            <ProductMark small productId={emailProduct(order.plan)?.productId ?? (isCodex ? 'codex-sms' : isX ? 'x-premium' : 'chatgpt')} />
            <div>
              <h3 className="partner-order-product-title">{productName}</h3>
              <p className="partner-order-product-desc">{productDesc}</p>
            </div>
          </div>
          <div className="partner-order-product-badges">
            <Badge
              variant={isFailed || isHold ? 'destructive' : isSuccess ? 'secondary' : 'outline'}
              className="partner-order-status-badge"
              data-state={isSuccess ? 'success' : undefined}
            >
              {statusText}
            </Badge>
            <Badge
              variant="outline"
              className="partner-order-payment-badge"
            >
              {order.platform_payment_status ? platformPaymentLabel(order.platform_payment_status) : order.payment_status === 'paid' ? '已到账' : order.payment_status === 'simulated' ? '无实际收款' : '未付款'}
            </Badge>
            <SettlementBadge status={order.payout_status} />
          </div>
        </div>

        <section className="partner-order-progress" aria-label="订单处理进度" aria-busy={loading}>
          <div><h3>处理进度</h3>{onRefresh && <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading}><RefreshCw size={14} />{loading ? '刷新中…' : '刷新进度'}</Button>}</div>
          {detailError && <p role="alert">{detailError} 当前显示最近读取的记录，请刷新核对。</p>}
          {fulfillment ? <><strong>{order.status === 'success' ? '充值已完成' : stage ? RECHARGE_STAGES[stage].title : ({ queued: '排队处理中', running: '充值处理中', unknown: '提交待确认', failed: '充值未完成', cancelled: '充值已取消', rejected: '提交未受理', succeeded: '充值已完成' } as Record<string, string>)[fulfillment.rechargeStatus ?? ''] ?? statusText}</strong>{fulfillment.message && <p>{fulfillment.message}</p>}{fulfillment.failureReason && fulfillment.failureReason !== fulfillment.message && <p>失败原因：{fulfillment.failureReason}</p>}<dl>{fulfillment.failureCode && <div><dt>失败码</dt><dd>{fulfillment.failureCode}</dd></div>}{fulfillment.accountEmailMasked && <div><dt>充值账号</dt><dd>{fulfillment.accountEmailMasked}</dd></div>}{fulfillment.attemptNo != null && <div><dt>充值尝试</dt><dd>第 {fulfillment.attemptNo} 次</dd></div>}{fulfillment.progressUpdatedAt && <div><dt>进度更新</dt><dd>{date(fulfillment.progressUpdatedAt)}</dd></div>}{fulfillment.finishedAt && <div><dt>结束时间</dt><dd>{date(fulfillment.finishedAt)}</dd></div>}</dl></> : <p>{order.serviceMessage || (order.delivery ? ({ sent: '交付邮件已发送。', failed: '交付邮件发送失败，请联系平台核对。', pending: '等待邮件交付。', waiting: '等待邮件交付。' } as Record<string, string>)[order.delivery.status] || '邮件交付正在处理。' : statusText)}</p>}
          <p className="partner-order-next-step">{nextStep}</p>
          {order.rechargeReference?.order_id && <WorkspaceDisclosure title="充值查询编号"><p>平台订单：{order.rechargeReference.order_id}</p>{order.rechargeReference.redemption_id && <p>充值任务：{order.rechargeReference.redemption_id}</p>}</WorkspaceDisclosure>}
          {order.updated_at && <small>订单更新于 {date(order.updated_at)}</small>}
        </section>

        <OrderHistory events={events} labels={labels} loading={loading} error={detailError} />

        <div className="partner-order-finances">
          <div className="partner-order-finances-head">
            <span>收益核算</span>
            <Badge variant="outline" className="partner-profit-badge">
              {profitLabel(order)}
            </Badge>
          </div>
          <div className="partner-order-finances-grid">
            <div className="partner-finance-item">
              <span className="partner-finance-label">订单售价</span>
              <strong className="partner-finance-value">{money(order.price_cents)}</strong>
              <small className="partner-finance-hint">客户付款金额</small>
            </div>
            <span className="partner-finance-sign" aria-hidden="true">−</span>
            <div className="partner-finance-item">
              <span className="partner-finance-label">供货成本</span>
              <strong className="partner-finance-value">{money(order.cost_cents)}</strong>
              <small className="partner-finance-hint">平台供货扣减</small>
            </div>
            <span className="partner-finance-sign" aria-hidden="true">{marginAdjusted ? '→' : '='}</span>
            <div className="partner-finance-item highlight">
              <span className="partner-finance-label">本单收益</span>
              <strong className={`partner-finance-value ${order.profit_cents > 0 ? 'partner-profit' : ''}`}>
                {money(order.profit_cents)}
              </strong>
              <small className="partner-finance-hint">{profitLabel(order)}</small>
            </div>
          </div>
          {isHold ? (
            <p className="partner-finance-notice warning">
              {refunded > 0 ? `平台已退 ${money(refunded)} · 账务待核对，本单收益暂时冻结。` : '售后申请处理中，本单收益暂时冻结。'}
            </p>
          ) : refunded > 0 ? (
            <p className="partner-finance-notice">
              已发生退款 {money(refunded)} · 收益随退款核减
            </p>
          ) : marginAdjusted ? (
            <p className="partner-finance-notice">本单收益已按供应商实际结算金额核算。</p>
          ) : null}
        </div>

        <dl className="partner-order-meta-card">
          {order.platform_payment_status && <>
            <div className="partner-order-meta-item"><dt>平台付款状态</dt><dd>{platformPaymentLabel(order.platform_payment_status)}</dd></div>
            <div className="partner-order-meta-item"><dt>平台已退金额</dt><dd>{money(order.platform_refunded_cents ?? 0)}</dd></div>
            <div className="partner-order-meta-item"><dt>最近核验</dt><dd>{order.platform_checked_at ? date(order.platform_checked_at) : '尚未核验'}</dd></div>
          </>}
          <div className="partner-order-meta-item partner-order-meta-customer">
            <dt>客户下单邮箱</dt>
            <dd>
              {order.customer_email ? (
                <div className="partner-order-email-row">
                  <a href={`mailto:${order.customer_email}`} className="partner-order-email-link" title="发送邮件">
                    <Mail size={13} />
                    <span>{order.customer_email}</span>
                  </a>
                  <CopyButton value={order.customer_email} label="复制邮箱" iconOnly size="icon-sm" variant="ghost" />
                </div>
              ) : (
                <span className="admin-subtle">旧订单未留邮箱</span>
              )}
            </dd>
          </div>
          <div className="partner-order-meta-item">
            <dt>下单时间</dt>
            <dd>
              <div className="partner-order-time-row">
                <Calendar size={13} />
                <span>{date(order.created_at)}</span>
              </div>
            </dd>
          </div>
          <div className="partner-order-meta-item">
            <dt>订单类型</dt>
            <dd>{order.mode === 'demo' ? '演示环境测试记录' : '正式线上交易'}</dd>
          </div>
          <div className="partner-order-meta-item partner-order-meta-payout">
            <dt>结算说明</dt>
            <dd>{getPayoutExplanation(order)}</dd>
          </div>
        </dl>

        <DialogFooter className="partner-order-dialog-footer">
          <Button variant="outline" size="sm" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PartnerOrderDetail({ order, path, revision, labels, onClose }: { order: PartnerOrder; path: string; revision: number; labels: Record<string, string>; onClose: () => void }) {
  const [refresh, setRefresh] = useState(0)
  const resource = usePartnerData<{ order: PartnerOrder; events: PartnerOrderEvent[] }>(path + '/' + encodeURIComponent(order.id), revision + refresh, { retainOnError: true })
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) setRefresh(value => value + 1) }, 15000)
    return () => window.clearInterval(timer)
  }, [])
  return <PartnerOrderDetailDialog order={resource.data?.order ?? order} events={resource.data?.events} onClose={onClose} labels={labels} loading={resource.loading} detailError={resource.error} onRefresh={() => setRefresh(value => value + 1)} />
}

export function PartnerOrders({ path, revision }: { path: string; revision: number }) {
  const [ticketOrder, setTicketOrder] = useState<string>()
  const [ticket, setTicket] = useState<string>()
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<PartnerOrder | null>(null)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const { data, error, loading } = usePartnerData<{ rows: PartnerOrder[]; total: number }>(path + '?page=' + page + '&q=' + encodeURIComponent(query) + '&status=' + encodeURIComponent(status), revision)
  const labels: Record<string, string> = { pending: '待付款', session: '待提交', processing: '处理中', success: '已完成', failed: '需处理', cancelled: '已关闭' }
  return <section className="admin-panel partner-orders-panel">
    <div className="admin-panel-title partner-ledger-heading"><div><h2>推广订单</h2><p>{data ? `共 ${data.total} 笔订单 · ` : ''}收益随退款核算</p></div><span>价格按下单时记录</span></div>
    <form className="partner-orders-search" onSubmit={event => { event.preventDefault(); setQuery(draft.trim()); setPage(1) }}><Input aria-label="搜索代理订单" placeholder="订单号、客户邮箱或商品套餐" value={draft} onChange={event => setDraft(event.target.value)} maxLength={320} /><WorkspaceSelect label="筛选订单状态" value={status} onValueChange={value => { setStatus(value); setPage(1) }} options={[{ value: '', label: '全部状态' }, ...Object.entries(labels).map(([value, label]) => ({ value, label }))]} /><Button type="submit" variant="outline">搜索</Button>{(query || status || draft) && <Button type="button" variant="ghost" onClick={() => { setDraft(''); setQuery(''); setStatus(''); setPage(1) }}>清除</Button>}</form>
    <Feedback error={error} loading={loading} data={data} />
    {data && <>{data.rows.length ? <div className="admin-table-scroll"><Table className="admin-table partner-orders-table">
      <TableHeader><TableRow><TableHead>订单</TableHead><TableHead>商品套餐</TableHead><TableHead>订单金额</TableHead><TableHead>收益</TableHead><TableHead>订单状态</TableHead><TableHead><span className="sr-only">操作</span></TableHead></TableRow></TableHeader>
      <TableBody>{data.rows.map(o => {
        const status = refundOrderLabel(o) ?? (o.status !== 'success' && o.recharge_status === 'unknown' ? '提交待确认' : null) ?? (emailProduct(o.plan) ? ({ session: '待邮件发货', processing: '发货处理中', success: '已发货', failed: '发货待核对' } as Record<string,string>)[o.status] : undefined) ?? labels[o.status] ?? o.status
        return <TableRow key={o.id}>
          <TableCell className="partner-order-identity"><span className="partner-order-id" title={o.id}>{o.id}</span><small>{date(o.created_at)} · {o.mode === 'demo' ? '历史测试记录' : '正式订单'}</small><small className="partner-order-customer" title={o.customer_email ?? undefined}>{o.customer_email || '旧订单未留邮箱'}</small></TableCell>
          <TableCell className="partner-order-product" data-label="商品套餐"><strong>{orderProductName(o)}</strong><small>{o.payment_status === 'paid' ? '已到账' : o.payment_status === 'simulated' ? '无实际收款' : '未付款'}</small></TableCell>
          <TableCell className="partner-order-money" data-label="订单金额"><strong>{money(o.price_cents)}</strong><small>供货价 {money(o.cost_cents)}</small></TableCell>
          <TableCell className="partner-order-money" data-label="收益"><strong className={o.profit_cents > 0 ? 'partner-profit' : ''}>{money(o.profit_cents)}</strong><small>{profitLabel(o)}</small></TableCell>
          <TableCell className="partner-order-state" data-label="订单状态"><div className="partner-order-state-badges"><Badge variant={o.status === 'failed' && !o.refund_hold ? 'destructive' : 'secondary'} className="partner-order-status" data-state={status === '已完成' ? 'success' : undefined}>{status}</Badge><SettlementBadge status={o.payout_status} /></div></TableCell>
          <TableCell className="partner-order-action" data-label="订单详情"><Button variant="outline" size="sm" onClick={() => setSelected(o)}>查看详情</Button>{path === '/api/partner/orders' && <Button variant="ghost" size="sm" onClick={() => setTicketOrder(o.id)}>提交工单</Button>}</TableCell>
        </TableRow>
      })}</TableBody>
    </Table></div> : <div className="admin-empty"><h3>{query || status ? '没有符合条件的订单' : '还没有推广订单'}</h3><p>{query || status ? '试试其他订单号、邮箱或状态。' : '客户通过你的链接下单后，订单会显示在这里。'}</p></div>}<Pagination page={page} total={data.total} onPage={setPage} /></>}
    {ticketOrder && <TicketCreator orderId={ticketOrder} onClose={() => setTicketOrder(undefined)} onCreated={id => { setTicketOrder(undefined); setTicket(id) }} />}{ticket && <TicketDetail key={ticket} id={ticket} onClose={() => setTicket(undefined)} />}
    {selected && <PartnerOrderDetail key={path + selected.id} order={selected} path={path} revision={revision} onClose={() => setSelected(null)} labels={labels} />}
  </section>
}

function PayoutAccountDetails({ account }: { account: PayoutAccount }) {
  return <dl className="partner-payout-account-details"><div><dt>支付宝手机号</dt><dd>{account.phone}</dd></div><div><dt>收款人姓名</dt><dd>{account.name}</dd></div></dl>
}

function PartnerEarnings({ data, readOnly, disabled, onPayout, onBind }: { data: Dashboard; readOnly: boolean; disabled: boolean; onPayout: () => void; onBind: () => void }) {
  return <section className="partner-earnings" aria-label="收益概览">
    <div className="partner-earnings-primary"><div><span>可结算收益</span><strong>{money(data.stats.available)}</strong></div><div className="partner-withdrawal"><Button disabled={readOnly || disabled || data.stats.available < data.stats.minimum || data.stats.withdrawalHeld || data.stats.payoutCoolingDown || data.totals.pending > 0} onClick={onPayout}>申请提现</Button><p>满 {money(data.stats.minimum)} 可提现 · 每 1 天一次</p>{data.stats.payoutCoolingDown && data.stats.nextPayoutAt !== null && <p>冷却中，下次可申请：{date(data.stats.nextPayoutAt)}</p>}</div></div>
    <div className="partner-payout-account"><div><strong>支付宝收款信息</strong>{data.payoutAccount?.phone ? <PayoutAccountDetails account={data.payoutAccount} /> : <p className="admin-subtle">尚未绑定，请先填写支付宝手机号和收款人姓名。</p>}</div>{!readOnly && <Button variant="outline" disabled={disabled} onClick={onBind}>{data.payoutAccount?.phone ? '修改收款信息' : '绑定支付宝'}</Button>}</div>
    <dl className="partner-earnings-totals"><div><dt>待处理结算</dt><dd>{money(data.totals.pending)}</dd></div><div><dt>累计已结算</dt><dd>{money(data.totals.paid)}</dd></div></dl>
    <p className="partner-earnings-note">已完成且到账的订单计入收益，提现审核后转账至支付宝。{data.stats.debt > 0 && ` 待抵扣退款及域名费用 ${money(data.stats.debt)}，已从可提现余额中扣除。`}{data.stats.withdrawalHeld && ' 已提现订单正在售后，核算完成前暂停新提现。'}</p>
  </section>
}

function PayoutHistory({ payouts }: { payouts: Dashboard['payouts'] }) {
  return <section className="admin-panel partner-settlements"><div className="admin-panel-title"><h2>结算记录</h2><span>最近 20 条</span></div>{payouts.length ? <div className="admin-table-scroll"><Table className="admin-table partner-settlements-table"><TableHeader><TableRow><TableHead>申请时间</TableHead><TableHead>金额</TableHead><TableHead>状态</TableHead><TableHead>处理说明</TableHead></TableRow></TableHeader><TableBody>{payouts.map(p => <TableRow key={p.id}><TableCell data-label="申请时间">{date(p.created_at)}</TableCell><TableCell data-label="金额"><strong>{money(p.amount_cents)}</strong></TableCell><TableCell data-label="状态"><Badge variant={p.status === 'rejected' ? 'destructive' : 'secondary'}>{payoutLabel(p.status, p.reviewed_at)}</Badge></TableCell><TableCell data-label="处理说明">{p.note || '等待平台处理'}{p.deduction_cents > 0 && <small>含账务抵扣 {money(p.deduction_cents)}</small>}{p.reference && <small>转账流水 {p.reference}</small>}</TableCell></TableRow>)}</TableBody></Table></div> : <div className="admin-empty"><h3>暂无结算记录</h3><p>提交提现申请后，可在这里查看处理进度。</p></div>}</section>
}
function PayoutDialog({ amount, account, onClose, onSaved }: { amount: number; account: PayoutAccount; onClose: () => void; onSaved: () => void }) {
  const [snapshot] = useState(account); const [key] = useState(() => crypto.randomUUID()); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const submitting = useRef(false)
  async function submit() { if (submitting.current) return; submitting.current = true; setBusy(true); setError(''); try { await api('/api/partner/payouts', { accountVersion: snapshot.version, key }); onSaved(); onClose() } catch (e) { setError(errorMessage(e)) } finally { submitting.current = false; setBusy(false) } }
  return <Dialog open onOpenChange={v => { if (!v && !submitting.current) onClose() }}><DialogContent className="motion-dialog partner-dialog" showCloseButton={!busy}><DialogHeader><DialogTitle>申请提现</DialogTitle><DialogDescription>满 ¥10 可提交，审核通过后由平台手动转账。</DialogDescription></DialogHeader><div className="partner-payout-amount"><span>当前可结算</span><strong>{money(amount)}</strong></div><div className="partner-payout-account"><div><strong>提现至已绑定支付宝</strong><PayoutAccountDetails account={snapshot} /></div></div><form className="partner-form" onSubmit={e => { e.preventDefault(); void submit() }}><p className="admin-subtle">请确认以上收款信息，如需修改，请关闭窗口后修改绑定。申请包含当前全部可提现收益，并扣除退款及域名费用抵扣；金额以提交时核算为准，最低 ¥10。每次成功提交后需冷却 24 小时（1 天），退回申请也不重置冷却期；待审核或待转账时不能重复申请。</p><Feedback error={error} /><Button type="submit" disabled={busy}>{busy ? '提交中…' : '提交结算申请'}</Button></form></DialogContent></Dialog>
}
function Workspace({
  preview,
  onLogout,
}: {
  preview?: string
  onLogout: () => void
}) {
  const [binding, setBinding] = useState(false)
  const [revision, setRevision] = useState(0)
  const [tab, setTab] = useState(
    () => new URLSearchParams(window.location.search).get('tab') || 'stores',
  )
  const [payout, setPayout] = useState(false)
  const [message, setMessage] = useState('')
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains('dark'),
  )
  const prefix = preview
    ? '/api/admin/partners/' + encodeURIComponent(preview)
    : '/api/partner'
  const { data, error, loading } = usePartnerData<Dashboard>(
    preview ? prefix + '/preview' : prefix + '/dashboard',
    revision,
  )
  useEffect(() => applyAppearance(dark), [dark])
  useEffect(() => {
    if (!data?.stats.payoutCoolingDown || data.stats.nextPayoutAt === null)
      return
    const timer = setTimeout(
      () => setRevision((v) => v + 1),
      Math.max(1000, data.stats.nextPayoutAt - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [data?.stats.payoutCoolingDown, data?.stats.nextPayoutAt])
  const refresh = () => setRevision((v) => v + 1)
  const saved = () => {
    refresh()
    setMessage('修改已保存')
  }
  const url = data
    ? data.partner.storefront_url ||
      (data.partner.referralOrigin || location.origin) +
        partnerStorefrontPath(data.partner.slug)
    : ''
  const [visited, setVisited] = useState<string[]>([tab])
  const [motion, setMotion] = useState(() => {
    try {
      return localStorage.getItem('partner-motion') !== 'off'
    } catch {
      return true
    }
  })
  const [solid, setSolid] = useState(() => {
    try {
      return localStorage.getItem('partner-solid') === 'on'
    } catch {
      return false
    }
  })
  useEffect(() => {
    document.body.classList.add('partner-workspace-active')
    document.body.dataset.partnerMotion = motion ? 'on' : 'off'
    document.body.dataset.partnerSolid = solid ? 'on' : 'off'
    try {
      localStorage.setItem('partner-motion', motion ? 'on' : 'off')
      localStorage.setItem('partner-solid', solid ? 'on' : 'off')
    } catch {
      /* Private browsers may disable storage. */
    }
    return () => {
      document.body.classList.remove('partner-workspace-active')
      delete document.body.dataset.partnerMotion
      delete document.body.dataset.partnerSolid
    }
  }, [motion, solid])
  const modules = [
    {
      id: 'stores',
      title: '我的商店',
      description: '管理商店、商品价格与推广链接',
      icon: Tags,
    },
    {
      id: 'orders',
      title: '订单收益',
      description: '查看交付进度、收益与结算记录',
      icon: ReceiptText,
    },
    ...(!preview
      ? [
          { id: 'tickets', title: '我的工单', description: '提交订单问题、查看平台回复与处理进度', icon: CircleHelp },
          {
            id: 'customers',
            title: '我的客户',
            description: '客户资料、服务账号与续费跟进',
            icon: Contact,
          },
          {
            id: 'invoices',
            title: '开票申请',
            description: '申请开票、支付手续费与查询进度',
            icon: FileText,
          },
          ...(!data?.partner.parent_id &&
          (data?.partner.can_recruit || data?.partner.has_children)
            ? [
                {
                  id: 'children',
                  title: '二级代理',
                  description: '管理代理、供货报价与差价收益',
                  icon: Users,
                },
              ]
            : []),
        ]
      : []),
    {
      id: 'visitors',
      title: '访客统计',
      description: '查看专属商店的访问与浏览走势',
      icon: ChartNoAxesCombined,
    },
    {
      id: 'settings',
      title: '账号设置',
      description: '订单通知与工作台显示偏好',
      icon: Settings2,
    },
  ]
  const current = modules.find((item) => item.id === tab) ?? modules[0]
  if (!visited.includes(current.id)) setVisited([...visited, current.id])
  const navigate = (next: string) => {
    setTab(next)
    setVisited((previous) =>
      previous.includes(next) ? previous : [...previous, next],
    )
    setMessage('')
    const nextUrl = new URL(window.location.href)
    nextUrl.searchParams.set('tab', next)
    window.history.replaceState(null, '', nextUrl)
  }
  const content: Record<string, ReactNode> = data
    ? {
        tickets: <TicketWorkspace revision={revision} active={current.id === 'tickets'} />,
        stores: (
          <StoresWorkspace
            prefix={prefix}
            revision={revision}
            active={current.id === 'stores'}
            readOnly={Boolean(preview)}
            canRecruit={
              !data.partner.parent_id && Boolean(data.partner.can_recruit)
            }
            onSaved={refresh}
            sortingContent={
              <ProductManagement
                endpoint={prefix + '/product-order'}
                plans={data.plans}
                readOnly={Boolean(preview)}
                disabled={loading || Boolean(error)}
                onSaved={saved}
                storeUrl={url}
              />
            }
          />
        ),
        orders: (
          <>
            {data.partner.has_children && (
              <p className="partner-notice">
                余额和收益汇总包含直属二级订单差价；自营订单在下方查看，二级订单请到“二级代理”查看。
              </p>
            )}
            <WorkspaceTabs
              label="订单与收益"
              items={[
                {
                  value: 'orders',
                  label: '订单明细',
                  content: (
                    <PartnerOrders
                      path={prefix + '/orders'}
                      revision={revision}
                    />
                  ),
                },
                {
                  value: 'summary',
                  label: '商品统计',
                  content: (
                    <OrderSummary
                      endpoint={prefix + '/order-summary'}
                      revision={revision}
                    />
                  ),
                },
                {
                  value: 'payouts',
                  label: '提现与结算',
                  content: (
                    <>
                      <PartnerEarnings
                        data={data}
                        readOnly={Boolean(preview)}
                        disabled={loading || Boolean(error)}
                        onBind={() => setBinding(true)}
                        onPayout={() => {
                          if (data.payoutAccount?.phone) setPayout(true)
                          else setBinding(true)
                        }}
                      />
                      <PayoutHistory payouts={data.payouts} />
                    </>
                  ),
                },
                ...(!preview && data.partner.has_upstream_earnings
                  ? [
                      {
                        value: 'upstream',
                        label: '二级差价',
                        content: (
                          <section className="admin-panel child-upstream-panel">
                            <h2>二级订单差价明细</h2>
                            <p className="child-help">
                              按下单时的上下级关系保留收益，包含已调整归属的历史订单。
                            </p>
                            <ChildOrders revision={revision} />
                          </section>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          </>
        ),
        customers: !preview && <CustomerManagement revision={revision} />,
        invoices: !preview && <InvoiceWorkspace revision={revision} />,
        children: !preview &&
          !data.partner.parent_id &&
          (data.partner.can_recruit || data.partner.has_children) && (
            <Children
              canRecruit={Boolean(data.partner.can_recruit)}
              revision={revision}
              onSaved={refresh}
            />
          ),
        visitors: (
          <>
            <div className="partner-section-heading">
              <p>统计你的专属链接及对应商品页面的访客。</p>
              <a href={url} target="_blank" rel="noreferrer">
                预览商店 <ArrowUpRight size={14} />
              </a>
            </div>
            <VisitorStats
              endpoint={prefix + '/visitors'}
              revision={revision}
              title="专属商店访问趋势"
              description="仅统计访问该专属链接及对应商品页面的访客与浏览量"
            />
          </>
        ),
        settings: (
          <WorkspaceTabs
            label="账号设置"
            items={[
              {
                value: 'notifications',
                label: '订单通知',
                content: (
                  <NotificationSettings
                    endpoint={prefix + '/notification-settings'}
                    revision={revision}
                    readOnly={Boolean(preview)}
                  />
                ),
              },
              {
                value: 'appearance',
                label: '外观与动效',
                content: (
                  <section className="partner-preferences admin-panel">
                    <h2>工作台外观</h2>
                    <div className="partner-preference-row">
                      <div>
                        <strong>深色模式</strong>
                        <p>与主站共用黑白外观设置。</p>
                      </div>
                      <Switch
                        checked={dark}
                        onCheckedChange={setDark}
                        aria-label="深色模式"
                      />
                    </div>
                    <div className="partner-preference-row">
                      <div>
                        <strong>减少透明效果</strong>
                        <p>使用实色导航背景，增强阅读清晰度。</p>
                      </div>
                      <Switch
                        checked={solid}
                        onCheckedChange={setSolid}
                        aria-label="减少透明效果"
                      />
                    </div>
                    <div className="partner-preference-row">
                      <div>
                        <strong>界面动效</strong>
                        <p>
                          导航与操作平滑过渡，同时尊重系统减少动态效果设置。
                        </p>
                      </div>
                      <Switch
                        checked={motion}
                        onCheckedChange={setMotion}
                        aria-label="界面动效"
                      />
                    </div>
                    <p className="admin-subtle">
                      显示偏好自动保存在当前浏览器。
                    </p>
                  </section>
                ),
              },
            ]}
          />
        ),
      }
    : {}
  return (
    <div className="partner-shell partner-workspace">
      <a className="partner-skip-link" href="#partner-content">
        跳到工作区
      </a>
      <aside
        className="partner-sidebar partner-glass"
        aria-label="代理后台侧栏"
      >
        <a className="admin-brand" href={preview ? '/admin' : '/join'}>
          <BrandMark />
          <strong>硅基生物</strong>
        </a>
        <span className="partner-sidebar-caption">代理工作台</span>
        <nav className="partner-side-nav" aria-label="代理工作台导航">
          {modules.map(({ id, title, icon: Icon }) => (
            <Button
              key={id}
              variant="ghost"
              aria-current={current.id === id ? 'page' : undefined}
              onClick={() => navigate(id)}
            >
              <Icon size={17} aria-hidden="true" />
              <span>{title}</span>
            </Button>
          ))}
        </nav>
        <div className="partner-sidebar-account">
          <span>{data?.partner.name ?? '正在读取账号'}</span>
          <small>{data?.partner.email}</small>
          {preview ? (
            <a href="/admin">
              返回管理后台 <ArrowUpRight size={14} />
            </a>
          ) : (
            <Button variant="ghost" onClick={onLogout}>
              <LogOut size={15} />
              退出登录
            </Button>
          )}
        </div>
      </aside>
      <main id="partner-content" className="partner-main">
        <div className="partner-topbar">
          <span>工作台 / {current.title}</span>
          <Button
            variant="ghost"
            className="partner-glass partner-theme-control"
            aria-label={dark ? '切换亮色模式' : '切换暗色模式'}
            onClick={() => setDark(!dark)}
          >
            {dark ? <Sun size={15} /> : <Moon size={15} />}
            {dark ? '浅色' : '深色'}
          </Button>
        </div>
        <header className="partner-heading">
          <div>
            <h1>{current.title}</h1>
            <p>{current.description}</p>
          </div>
          <Button variant="outline" onClick={refresh} disabled={loading}>
            <RefreshCw
              size={15}
              className={loading ? 'processing-spinner' : undefined}
            />
            刷新
          </Button>
        </header>
        {preview && (
          <div className="partner-notice">
            <CircleHelp size={15} />
            平台只读预览 · 代理登录后可以调整售价、申请提现
          </div>
        )}
        <Feedback error={error} loading={loading} data={data} />
        {message && (
          <p role="status" className="partner-save-status">
            {message}
          </p>
        )}
        {data &&
          modules.map(
            (item) =>
              (visited.includes(item.id) || current.id === item.id) && (
                <section
                  className="partner-module"
                  key={item.id}
                  hidden={current.id !== item.id}
                  aria-label={item.title}
                >
                  {content[item.id]}
                </section>
              ),
          )}
        <footer className="admin-footer">
          <Check size={13} />
          价格、订单与结算记录均保存到服务器
        </footer>
      </main>
      {payout && data && (
        <PayoutDialog
          amount={data.stats.available}
          account={data.payoutAccount}
          onClose={() => setPayout(false)}
          onSaved={saved}
        />
      )}
      {binding && data && !preview && (
        <PayoutAccountDialog
          account={data.payoutAccount ?? { phone: '', name: '', version: 0 }}
          onClose={() => setBinding(false)}
          onSaved={saved}
        />
      )}
    </div>
  )
}
export default function PartnerApp() {
  const sendHuman = useAuthVerification('partner_send')
  const loginHuman = useAuthVerification('partner_verify')
  const preview = new URLSearchParams(location.search).get('preview') ?? undefined
  const { session, error, setError, check, clear: clearSession } = useSession<Session>('/api/partner/auth/session', 'partner', !preview); const [email, setEmail] = useState(''); const [sent, setSent] = useState(false); const [code, setCode] = useState(''); const [busy, setBusy] = useState(false); const [cooldown, setCooldown] = useState(0)
  const [invalidCode, setInvalidCode] = useState(false)
  useEffect(() => { if (cooldown <= 0) return; const timer = setTimeout(() => setCooldown(v => v - 1), 1000); return () => clearTimeout(timer) }, [cooldown])
  async function send() { if (!sendHuman.ready || busy || cooldown) return; setBusy(true); setError(''); setInvalidCode(false); try { await api('/api/partner/auth/send', { email, ...sendHuman.consume() }); setSent(true); setCode(''); setCooldown(60) } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) } }
  async function verify() { if (!loginHuman.ready || busy) return; setBusy(true); setError(''); setInvalidCode(false); try { await api('/api/partner/auth/verify', { email, code, ...loginHuman.consume() }); setCode(''); await check() } catch (e) { setError(errorMessage(e)); setInvalidCode(e instanceof RequestError && e.status === 401) } finally { setBusy(false) } }
  async function logout() { try { await api('/api/partner/auth/logout', {}); clearSession(); setSent(false); setCode('') } catch (e) { setError(errorMessage(e)) } }
  if (!preview && !session && !error) return <WorkspaceBoot />
  if (preview || session?.authenticated) return <><Feedback error={error} /><Workspace preview={preview} onLogout={() => void logout()} /></>
  return <main className="partner-login"><a className="partner-login-back" href="/"><ArrowLeft size={15} />返回商店</a><section className="partner-login-panel" aria-labelledby="partner-login-title">
    <a className="partner-login-brand" href="/" aria-label="硅基生物 首页"><BrandMark /><strong>硅基生物</strong></a>
    <header className="partner-login-heading"><h1 id="partner-login-title">登录代理工作台</h1><p>使用开通邮箱和邮件验证码登录。</p></header>
    {!session ? <><Feedback error={error} />{error ? <Button onClick={() => void check()} variant="outline">重新连接</Button> : <Feedback loading />}</> : !session.mailReady ? <div className="admin-setup"><h2>邮件服务待启用</h2><p>请联系平台管理员启用邮箱验证码。</p><Button variant="outline" onClick={() => void check()}>重新检查</Button></div> : <form className="partner-login-form" onSubmit={e => { e.preventDefault(); void verify() }}>
      <FieldGroup>
        <Field><FieldLabel htmlFor="partner-email">登录邮箱</FieldLabel><Input id="partner-email" type="email" autoComplete="email" placeholder="输入开通邮箱" value={email} onChange={e => { setEmail(e.target.value); setSent(false); setCode(''); setError(''); setInvalidCode(false) }} required maxLength={254} disabled={busy} /></Field>
        {sendHuman.widget}
        <Field data-invalid={invalidCode || undefined}><FieldLabel htmlFor="partner-code">邮箱验证码</FieldLabel><div className="partner-login-code"><Input id="partner-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(''); setInvalidCode(false) }} maxLength={6} pattern="[0-9]{6}" required disabled={busy} placeholder="6 位验证码" aria-invalid={invalidCode} aria-describedby={error ? 'partner-code-help partner-login-error' : 'partner-code-help'} /><Button type="button" variant="outline" onClick={() => void send()} disabled={!sendHuman.ready || busy || cooldown > 0 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())}>{cooldown ? `${cooldown} 秒后重发` : '获取验证码'}</Button></div><FieldDescription id="partner-code-help" role="status">{sent ? '若邮箱已开通，验证码将发送至邮箱，10 分钟内有效。' : '开通邮件中的验证码可直接使用，过期后重新获取。'}</FieldDescription></Field>
      </FieldGroup>
      {error && <div id="partner-login-error" className="state-enter"><Feedback error={error} /></div>}
      {(sent || code.length > 0) && loginHuman.widget}
      <Button className="partner-login-submit" type="submit" disabled={!loginHuman.ready || busy || !email || code.length !== 6}>{busy ? '请稍候…' : '登录工作台'}</Button>
    </form>}
    <p className="partner-login-footer">仅限已开通代理 · 无需密码</p>
  </section></main>
}
