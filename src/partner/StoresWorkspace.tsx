import { DateTimePicker } from '@/components/workspace-controls'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table'
import { prepareLogo } from '@/lib/prepare-logo'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Plus, Store, Ticket, Globe, ArrowUpRight } from 'lucide-react'
import QRCode from 'qrcode'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  WorkspaceTabs,
  WorkspaceSelect,
  WorkspaceDisclosure,
} from './workspace-ui'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { CopyButton } from '@/components/copy-button'
import { ImageUploadField } from '@/components/image-upload-field'
import { api, errorMessage } from '@/lib/api'
import { useResource } from '@/lib/use-resource'
import { money, toCents } from './model'
import { partnerStorefrontPath } from '../../shared/partner-link'
import './stores-workspace.css'

type Settings = {
  brandName?: string
  logo?: string
  pageTitle?: string
  headline?: string
  description?: string
  wechat?: string
  qq?: string
  email?: string
  announcementTitle?: string
  announcementPlacement?: string
  announcement?: string
}
type Shop = {
  id: string
  slot: number
  slug: string
  name: string
  active: boolean
  version: number
  settings: Settings
  order_count: number
  earned_cents: number
  visitors: number
}
type Price = {
  store_id: string
  plan: string
  name: string
  product_id: string
  cost_cents: number
  price_cents: number
  child_cost_cents: number | null
  supply_version: number
  enabled: boolean
  version: number
}
type Target = { storeId: string; plan: string }
type Coupon = {
  id: string
  code: string
  discount_cents: number
  starts_at: string
  ends_at: string
  max_uses: number
  once_per_email: boolean
  active: boolean
  version: number
  targets: Target[]
  uses: number
}
type Charge = {
  id: string
  hostname: string
  amount_cents: number
  source: string
  state: string
  created_at: string
}
type Data = {
  referralOrigin?: string
  stores: Shop[]
  prices: Price[]
  coupons: Coupon[]
  charges: Charge[]
}
type Binding = {
  id: string
  storeId: string
  hostname: string
  free: boolean
  state: string
  message: string
  billingState: string
  expiresAt: string | null
  billingVersion: number
  records: { type: string; name: string; value: string }[]
}
type DomainData = {
  monthlyFeeCents: number
  domains: Binding[]
  enabled: boolean
  eligible: boolean
  completedOrders: number
  requiredOrders: number
}
const timestamp = (value: string) =>
  new Date(value).toLocaleString('zh-CN', { hour12: false })
const localDate = (value: string) => {
  const d = new Date(value)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16)
}
const labels: Record<string, string> = {
  active: '已生效',
  grace: '三天宽限期',
  suspended: '已暂停',
  awaiting_payment: '待付费',
  pending_dns: '等待解析',
  pending_certificate: '证书签发中',
  error: '需检查',
  deleting: '解绑中',
  pending: '待确认',
  paid: '已支付',
  closed: '已关闭',
}

export function StoresWorkspace({
  prefix = '/api/partner',
  readOnly = false,
  adminManagement = false,
  canRecruit = false,
  onSaved,
  active = true,
  revision: parentRevision = 0,
  sortingContent,
}: {
  prefix?: string
  readOnly?: boolean
  adminManagement?: boolean
  canRecruit?: boolean
  active?: boolean
  revision?: number
  sortingContent?: ReactNode
  onSaved?: () => void
}) {
  const [revision, setRevision] = useState(0)
  const resource = useResource<Data>(
    prefix + '/stores',
    revision + parentRevision,
  )
  const domainResource = useResource<DomainData>(
    prefix + '/domain',
    revision + parentRevision,
  )
  const [selected, setSelected] = useState('')
  const [editor, setEditor] = useState<Shop | 'new' | null>(null)
  const [coupon, setCoupon] = useState<Coupon | 'new' | null>(null)
  const [tab, setTab] = useState('overview')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [paymentOpen, setPaymentOpen] = useState(false)
  const mutating = useRef(false)
  const [payment, setPayment] = useState<{
    binding: Binding
    id: string
    state: string
    qr: string | null
    amount_cents: number
  } | null>(null)
  const [qr, setQr] = useState({ source: '', value: '' })
  const [removing, setRemoving] = useState<Binding | null>(null)
  const [adjust, setAdjust] = useState<Binding | null>(null)
  const [months, setMonths] = useState('1')
  const [note, setNote] = useState('')
  const monthlyFee = domainResource.data?.monthlyFeeCents ?? 0
  const data = resource.data
  const shop = data?.stores.find((s) => s.id === selected) ?? data?.stores[0]
  const reload = () => {
    setRevision((v) => v + 1)
    onSaved?.()
  }
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      if (!document.hidden) setRevision((v) => v + 1)
    }, 30000)
    return () => clearInterval(timer)
  }, [active])
  useEffect(() => {
    let cancelled = false
    const source = payment?.qr
    if (source)
      void QRCode.toDataURL(source, { width: 260, margin: 2 })
        .then((value) => {
          if (!cancelled) setQr({ source, value })
        })
        .catch(() => {
          if (!cancelled) setError('付款码生成失败，请重试。')
        })
    return () => {
      cancelled = true
    }
  }, [payment?.qr])
  async function mutate(path: string, payload: unknown) {
    if (mutating.current) return false
    mutating.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await api(path, payload)
      setMessage('修改已保存')
      reload()
      return true
    } catch (e) {
      setError(errorMessage(e))
      return false
    } finally {
      mutating.current = false
      setBusy(false)
    }
  }
  async function pay(binding: Binding, action: string) {
    if (mutating.current) return
    mutating.current = true
    setBusy(true)
    setError('')
    try {
      const r = await api<{
        payment: Omit<NonNullable<typeof payment>, 'binding'> | null
      }>(prefix + '/domains/' + binding.id + '/payment', {
        action,
        version: binding.billingVersion,
      })
      setPayment(r.payment ? { ...r.payment, binding } : null)
      setPaymentOpen(!!r.payment)
      reload()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      mutating.current = false
      setBusy(false)
    }
  }
  if (!data)
    return (
      <div className="stores-workspace">
        <p role={resource.error ? 'alert' : 'status'}>
          {resource.error || '正在读取商店…'}
        </p>
      </div>
    )
  const storeContext = shop && (
    <div className="store-context">
      <WorkspaceSelect
        label="选择商店"
        value={shop.id}
        onValueChange={setSelected}
        disabled={busy}
        options={data.stores.map((s) => ({
          value: s.id,
          label: s.name,
        }))}
      />{' '}
      <div className="store-current">
        <div>
          <strong>{shop.name}</strong>
          <a
            href={
              (data.referralOrigin || location.origin) +
              partnerStorefrontPath(shop.slug)
            }
            target="_blank"
            rel="noreferrer"
          >
            {(data.referralOrigin || location.origin) +
              partnerStorefrontPath(shop.slug)}{' '}
            <ArrowUpRight size={14} />
          </a>
        </div>
        <div>
          <CopyButton
            value={
              (data.referralOrigin || location.origin) +
              partnerStorefrontPath(shop.slug)
            }
            label="复制推广链接"
          />
          {!readOnly && (
            <Button variant="outline" onClick={() => setEditor(shop)}>
              编辑商店
            </Button>
          )}
        </div>
      </div>
    </div>
  )
  return (
    <section className="stores-workspace">
      <div className="stores-heading">
        <div>
          <h2>
            <Store size={21} />
            我的商店 <small>{data.stores.length}/5</small>
          </h2>
          <p>各店独立定价和优惠，收益汇入同一个代理账户。</p>
        </div>
        {!readOnly && (
          <Button
            disabled={busy || data.stores.length >= 5}
            onClick={() => setEditor('new')}
          >
            <Plus size={15} />
            新增商店
          </Button>
        )}
      </div>
      {(error || resource.error || domainResource.error) && (
        <p className="stores-error" role="alert">
          {error || resource.error || domainResource.error}
        </p>
      )}
      {message && (
        <p className="partner-save-status" role="status">
          {message}
        </p>
      )}
      {shop && (
        <WorkspaceTabs
          label="商店管理"
          value={tab}
          onValueChange={setTab}
          items={[
            {
              value: 'overview',
              label: '商店概览',
              content: (
                <div className="store-overview">
                  <div className="store-overview-summary">
                    <div>
                      <span>营业中的商店</span>
                      <strong>
                        {data.stores.filter((s) => s.active).length}
                        <small> / {data.stores.length}</small>
                      </strong>
                    </div>
                    <div>
                      <span>累计订单</span>
                      <strong>
                        {data.stores.reduce((sum, s) => sum + s.order_count, 0)}
                      </strong>
                    </div>
                    <div>
                      <span>累计收益</span>
                      <strong>
                        {money(
                          data.stores.reduce(
                            (sum, s) => sum + s.earned_cents,
                            0,
                          ),
                        )}
                      </strong>
                    </div>
                  </div>
                  {data.stores.map((s) => (
                    <article className="store-overview-row" key={s.id}>
                      <div className="store-overview-icon">
                        <Store size={21} />
                      </div>
                      <div className="store-overview-name">
                        <strong>{s.name}</strong>
                        <small>
                          {s.slot === 1 ? '默认商店' : `商店 ${s.slot}`} ·{' '}
                          {s.active ? '营业中' : '已停用'}
                        </small>
                      </div>
                      <div className="store-overview-stat">
                        <strong>{s.order_count}</strong>
                        <small>累计订单</small>
                      </div>
                      <div className="store-overview-stat">
                        <strong>{money(s.earned_cents)}</strong>
                        <small>累计收益</small>
                      </div>
                      <div className="store-overview-stat">
                        <strong>{s.visitors}</strong>
                        <small>近 30 天访客</small>
                      </div>
                      <div className="store-overview-actions">
                        <CopyButton
                          value={
                            (data.referralOrigin || location.origin) +
                            partnerStorefrontPath(s.slug)
                          }
                          label="复制推广链接"
                        />
                        <Button
                          variant="outline"
                          onClick={() => {
                            setSelected(s.id)
                            setTab('prices')
                          }}
                        >
                          管理商品
                        </Button>
                        {!readOnly && (
                          <Button variant="ghost" onClick={() => setEditor(s)}>
                            编辑
                          </Button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              ),
            },
            {
              value: 'prices',
              label: '商品售价',
              content: (
                <>
                  {storeContext}
                  <>
                    <div className="store-price-list">
                      <p className="stores-help">
                        售价和优惠后价格均不能低于拿货价。关闭套餐后仅影响当前商店的新订单。
                      </p>
                      {data.prices.map((p) => (
                        <div
                          hidden={p.store_id !== shop.id}
                          key={p.store_id + p.plan}
                        >
                          <PriceEditor
                            key={
                              p.store_id +
                              p.plan +
                              ':' +
                              p.version +
                              ':' +
                              p.price_cents
                            }
                            price={p}
                            readOnly={readOnly}
                            busy={busy}
                            onSave={(value) =>
                              mutate(prefix + '/stores/prices', value)
                            }
                          />
                        </div>
                      ))}
                    </div>{' '}
                    {canRecruit && (
                      <WorkspaceDisclosure
                        className="store-supply"
                        title="新二级代理的默认供货报价"
                      >
                        <p>
                          只用于新建二级代理，不跟随任何商店的零售价变化。已有二级代理请在“二级代理”中调整。
                        </p>
                        {data.prices
                          .filter((p) => p.store_id === data.stores[0]?.id)
                          .map((p) => (
                            <SupplyEditor
                              key={p.plan + ':' + p.supply_version}
                              price={p}
                              disabled={busy || readOnly}
                              save={(costCents) =>
                                mutate(prefix + '/supply-quotes', {
                                  plan: p.plan,
                                  costCents,
                                  version: p.supply_version,
                                })
                              }
                            />
                          ))}
                      </WorkspaceDisclosure>
                    )}
                  </>
                </>
              ),
            },
            {
              value: 'coupons',
              label: '优惠码',
              content: (
                <>
                  <>
                    <div className="stores-heading">
                      <div>
                        <h3>
                          <Ticket size={18} />
                          代理优惠码
                        </h3>
                        <p>
                          只在勾选的商店商品生效。邮箱限次在同一码绑定的所有商店之间共用。
                        </p>
                      </div>
                      {!readOnly && (
                        <Button onClick={() => setCoupon('new')}>
                          新增优惠码
                        </Button>
                      )}
                    </div>
                    {data.coupons.length === 0 ? (
                      <p className="stores-empty">
                        还没有优惠码。创建后可选择当前店或多家店的商品。
                      </p>
                    ) : (
                      data.coupons.map((c) => (
                        <article className="store-coupon" key={c.id}>
                          <div>
                            <strong>{c.code}</strong>
                            <span>
                              {c.active ? '启用' : '停用'} · 减{' '}
                              {money(c.discount_cents)}
                            </span>
                            <small>
                              {c.uses}/{c.max_uses} 次（含待付款占用） ·{' '}
                              {c.once_per_email
                                ? '每个邮箱限用一次'
                                : '不限邮箱次数'}
                            </small>
                            <small>
                              {timestamp(c.starts_at)} — {timestamp(c.ends_at)}
                            </small>
                            <small>
                              {c.targets
                                .map(
                                  (t) =>
                                    `${data.stores.find((s) => s.id === t.storeId)?.name ?? '商店'} / ${data.prices.find((p) => p.store_id === t.storeId && p.plan === t.plan)?.name ?? t.plan}`,
                                )
                                .join('；')}
                            </small>
                          </div>
                          {!readOnly && (
                            <Button
                              variant="outline"
                              onClick={() => setCoupon(c)}
                            >
                              编辑
                            </Button>
                          )}
                        </article>
                      ))
                    )}
                  </>
                </>
              ),
            },
            {
              value: 'domains',
              label: '域名与账单',
              content: (
                <>
                  {storeContext}
                  <>
                    <div className="stores-heading">
                      <div>
                        <h3>
                          <Globe size={18} />
                          域名与续费
                        </h3>
                        <p>
                          {monthlyFee === 0
                            ? '额外域名暂时免费（¥0/月），免费开通、自动续期，不扣余额。'
                            : `每个代理一个免费域名，额外域名 ${money(monthlyFee)}/月。到期自动抵扣可提现余额，不足时宽限三天。`}
                        </p>
                      </div>
                    </div>
                    <p className="stores-help">
                      域名暂停不影响主站推广链接、已有订单和售后。登录状态在不同域名独立。
                    </p>
                    {!readOnly &&
                      domainResource.data?.enabled &&
                      domainResource.data.eligible && (
                        <DomainBinder
                          key={shop.id}
                          busy={busy}
                          free={
                            !domainResource.data.domains.some((d) => d.free)
                          }
                          monthlyFee={monthlyFee}
                          onBind={(hostname) =>
                            mutate(prefix + '/domain', {
                              hostname,
                              storeId: shop.id,
                            })
                          }
                        />
                      )}
                    {domainResource.data && !domainResource.data.enabled && (
                      <p>自定义域名服务尚未启用。</p>
                    )}
                    {domainResource.data && !domainResource.data.eligible && (
                      <p>
                        完成 {domainResource.data.requiredOrders}{' '}
                        单后可绑定，目前 {domainResource.data.completedOrders}{' '}
                        单。
                      </p>
                    )}
                    {domainResource.data?.domains
                      .filter((d) => d.storeId === shop.id)
                      .map((d) => (
                        <article className="store-domain" key={d.id}>
                          <div className="stores-heading">
                            <div>
                              <strong>{d.hostname}</strong>
                              <p>
                                {d.free
                                  ? '免费域名'
                                  : `${monthlyFee === 0 ? '暂时免费（¥0/月）' : money(monthlyFee) + '/月'} · ${monthlyFee === 0 && d.billingState === 'awaiting_payment' ? '待开通' : (labels[d.billingState] ?? d.billingState)}`}{' '}
                                · {labels[d.state] ?? d.state}
                              </p>
                              {d.expiresAt && (
                                <small>
                                  到期：{timestamp(d.expiresAt)}
                                  {d.billingState === 'grace' &&
                                    `，宽限至 ${timestamp(new Date(new Date(d.expiresAt).getTime() + 72 * 3600000).toISOString())}`}
                                </small>
                              )}
                            </div>
                            <CopyButton
                              value={
                                'https://' +
                                d.hostname +
                                partnerStorefrontPath(shop.slug)
                              }
                              label="复制域名推广链接"
                            />
                          </div>
                          <p>{d.message}</p>
                          {!d.free && d.expiresAt && (
                            <p>
                              {monthlyFee === 0
                                ? '免费期间到期自动续期，不扣除可提现余额。'
                                : `到期从可提现余额自动扣除 ${money(monthlyFee)}；余额不足宽限三天，补足余额后自动续费。`}
                            </p>
                          )}
                          <WorkspaceDisclosure title="查看 DNS 配置">
                            {d.records.map((r, i) => (
                              <div className="store-dns" key={i}>
                                <strong>{r.type}</strong>
                                <code>{r.name}</code>
                                <CopyButton value={r.name} label="复制名称" />
                                <code>{r.value}</code>
                                <CopyButton value={r.value} label="复制内容" />
                              </div>
                            ))}
                            <p>
                              CNAME 使用「仅 DNS」，TXT 验证记录请长期保留。
                            </p>
                          </WorkspaceDisclosure>
                          <div className="store-actions">
                            {!readOnly && d.state !== 'deleting' && (
                              <>
                                <Button
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() =>
                                    void mutate(prefix + '/domain/check', {
                                      id: d.id,
                                    })
                                  }
                                >
                                  检查解析
                                </Button>
                                {!d.free && (
                                  <>
                                    {!d.expiresAt && (
                                      <>
                                        <Button
                                          disabled={busy}
                                          onClick={() => void pay(d, 'balance')}
                                        >
                                          {monthlyFee === 0
                                            ? '免费开通'
                                            : `余额抵扣首月 ${money(monthlyFee)}`}
                                        </Button>
                                        {monthlyFee > 0 && (
                                          <Button
                                            variant="outline"
                                            disabled={busy}
                                            onClick={() =>
                                              void pay(d, 'create')
                                            }
                                          >
                                            卓付支付首月 {money(monthlyFee)}
                                          </Button>
                                        )}
                                      </>
                                    )}
                                    <Button
                                      variant="ghost"
                                      disabled={busy}
                                      onClick={() => void pay(d, 'query')}
                                    >
                                      查询付款
                                    </Button>
                                  </>
                                )}
                                <Button
                                  variant="ghost"
                                  disabled={busy}
                                  onClick={() => setRemoving(d)}
                                >
                                  解绑
                                </Button>
                              </>
                            )}
                            {adminManagement && !d.free && (
                              <Button
                                variant="outline"
                                onClick={() => {
                                  setAdjust(d)
                                  setMonths('1')
                                  setNote('')
                                }}
                              >
                                减免 / 延期
                              </Button>
                            )}
                          </div>
                        </article>
                      ))}
                    <h3>账号域名账单</h3>
                    {data.charges.length === 0 ? (
                      <p className="stores-empty">暂无收费记录</p>
                    ) : (
                      <div className="store-ledger">
                        {data.charges.map((c) => (
                          <div key={c.id}>
                            <strong>{c.hostname}</strong>
                            <span>
                              {money(c.amount_cents)} ·{' '}
                              {
                                {
                                  balance: '余额抵扣',
                                  gatewayb: '卓付支付',
                                  admin: '后台减免',
                                  promotion: '免费开通 / 续期',
                                }[c.source]
                              }{' '}
                              ·{' '}
                              {c.source === 'promotion'
                                ? '已生效'
                                : (labels[c.state] ?? c.state)}
                            </span>
                            <small>{timestamp(c.created_at)}</small>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                </>
              ),
            },
            {
              value: 'orders',
              label: '商店订单',
              content: (
                <>
                  {storeContext}
                  <StoreOrderList
                    key={shop.id}
                    prefix={prefix}
                    shop={shop.id}
                    revision={revision + parentRevision}
                  />
                </>
              ),
            },
            ...(sortingContent
              ? [
                  {
                    value: 'sorting',
                    label: '默认店排序',
                    content: sortingContent,
                  },
                ]
              : []),
          ]}
        />
      )}
      <Dialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null)
        }}
      >
        <DialogContent className="motion-dialog" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>解绑域名</DialogTitle>
            <DialogDescription>
              解除 {removing?.hostname}{' '}
              后，该域名将无法访问商店。主站推广链接和已有订单不受影响。
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="stores-error">
              {error}
            </p>
          )}
          <div className="store-actions">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setRemoving(null)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (
                  removing &&
                  (await mutate(prefix + '/domain/remove', {
                    hostname: removing.hostname,
                  }))
                )
                  setRemoving(null)
              }}
            >
              {busy ? '正在解绑…' : '确认解绑'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {editor && (
        <StoreEditor
          error={error}
          shop={editor === 'new' ? undefined : editor}
          busy={busy}
          onClose={() => setEditor(null)}
          save={async (value) => {
            if (await mutate(prefix + '/stores', value)) setEditor(null)
          }}
        />
      )}
      {coupon && (
        <CouponEditor
          error={error}
          coupon={coupon === 'new' ? undefined : coupon}
          shops={data.stores}
          prices={data.prices}
          selected={shop?.id ?? ''}
          busy={busy}
          onClose={() => setCoupon(null)}
          save={async (value) => {
            if (await mutate(prefix + '/coupons', value)) setCoupon(null)
          }}
        />
      )}
      <Dialog open={paymentOpen} onOpenChange={setPaymentOpen}>
        <DialogContent className="motion-dialog">
          <DialogHeader>
            <DialogTitle>
              域名费用 · {money(payment?.amount_cents ?? monthlyFee)}
            </DialogTitle>
            <DialogDescription>
              {payment?.binding.hostname} ·{' '}
              {payment?.amount_cents === 0 && payment.state === 'paid'
                ? '已生效'
                : labels[payment?.state ?? 'pending']}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="stores-error" role="alert">
              {error}
            </p>
          )}
          {qr.source === payment?.qr && (
            <img
              className="domain-payment-qr"
              src={qr.value}
              alt="卓付付款二维码"
            />
          )}
          <p>
            {payment?.state === 'paid'
              ? payment.amount_cents === 0
                ? '已免费开通，未扣除余额。请检查域名解析，验证通过后即可访问商店。'
                : '费用已支付，请检查域名解析，验证通过后即可访问商店。'
              : '请使用卓付付款码完成支付。已生成的付款单会持续核对，请勿重复付款；待确认期间不能改用余额重复抵扣。'}
          </p>
          {payment && payment.state !== 'paid' && (
            <Button
              disabled={busy}
              onClick={() => void pay(payment.binding, 'query')}
            >
              我已付款，查询结果
            </Button>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!adjust}
        onOpenChange={(open) => {
          if (!open) setAdjust(null)
        }}
      >
        <DialogContent className="motion-dialog">
          <DialogHeader>
            <DialogTitle>减免域名费用并延期</DialogTitle>
            <DialogDescription>
              {adjust?.hostname} · 操作保留审计记录。
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="stores-error" role="alert">
              {error}
            </p>
          )}
          <label>
            延长月份
            <Input
              type="number"
              min={1}
              max={24}
              value={months}
              onChange={(e) => setMonths(e.target.value)}
            />
          </label>
          <label>
            操作原因
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
            />
          </label>
          <Button
            disabled={busy || !note.trim()}
            onClick={async () => {
              if (
                adjust &&
                (await mutate(prefix + '/domains/' + adjust.id, {
                  version: adjust.billingVersion,
                  months: Number(months),
                  note,
                }))
              )
                setAdjust(null)
            }}
          >
            确认减免并延期
          </Button>
        </DialogContent>
      </Dialog>
    </section>
  )
}
function PriceEditor({
  price: p,
  readOnly,
  busy,
  onSave,
}: {
  price: Price
  readOnly: boolean
  busy: boolean
  onSave: (value: unknown) => Promise<boolean>
}) {
  const [value, setValue] = useState((p.price_cents / 100).toFixed(2))
  const [enabled, setEnabled] = useState(p.enabled)
  return (
    <form
      className="store-price-row"
      onSubmit={(e) => {
        e.preventDefault()
        void onSave({
          storeId: p.store_id,
          plan: p.plan,
          priceCents: toCents(value),
          enabled,
          version: p.version,
        })
      }}
    >
      <div>
        <strong>{p.name}</strong>
        <small>
          {p.product_id} · 拿货 {money(p.cost_cents)}
        </small>
      </div>
      <label>
        售价（元）
        <Input
          aria-label={p.name + '售价'}
          inputMode="decimal"
          value={value}
          disabled={busy || readOnly}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <label className="store-check">
        <Checkbox
          checked={enabled}
          disabled={busy || readOnly}
          onCheckedChange={setEnabled}
        />
        上架
      </label>
      {!readOnly && (
        <Button
          type="submit"
          variant="outline"
          disabled={
            busy ||
            !Number.isFinite(toCents(value)) ||
            toCents(value) < p.cost_cents
          }
        >
          保存
        </Button>
      )}
    </form>
  )
}
function SupplyEditor({
  price,
  disabled,
  save,
}: {
  price: Price
  disabled: boolean
  save: (value: number) => Promise<boolean>
}) {
  const [value, setValue] = useState(
    ((price.child_cost_cents ?? price.cost_cents) / 100).toFixed(2),
  )
  return (
    <form
      className="store-price-row"
      onSubmit={(e) => {
        e.preventDefault()
        void save(toCents(value))
      }}
    >
      <strong>{price.name}</strong>
      <label>
        默认供货价（元）
        <Input
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <Button
        type="submit"
        disabled={
          disabled ||
          !Number.isFinite(toCents(value)) ||
          toCents(value) < price.cost_cents
        }
      >
        保存报价
      </Button>
    </form>
  )
}
function DomainBinder({
  busy,
  free,
  monthlyFee,
  onBind,
}: {
  busy: boolean
  free: boolean
  monthlyFee: number
  onBind: (hostname: string) => Promise<boolean>
}) {
  const [hostname, setHostname] = useState('')
  return (
    <form
      className="store-domain-bind"
      onSubmit={async (e) => {
        e.preventDefault()
        if (await onBind(hostname)) setHostname('')
      }}
    >
      <label>
        为当前商店绑定域名
        <Input
          placeholder="shop.example.com"
          maxLength={253}
          required
          value={hostname}
          onChange={(e) => setHostname(e.target.value)}
          disabled={busy}
        />
      </label>
      <Button type="submit" disabled={busy || !hostname.trim()}>
        绑定 ·{' '}
        {free
          ? '免费'
          : monthlyFee === 0
            ? '暂时免费'
            : `${money(monthlyFee)}/月`}
      </Button>
    </form>
  )
}
function StoreEditor({
  error,
  shop,
  busy,
  onClose,
  save,
}: {
  error: string
  shop?: Shop
  busy: boolean
  onClose: () => void
  save: (value: unknown) => Promise<void>
}) {
  const [name, setName] = useState(shop?.name ?? '')
  const [active, setActive] = useState(shop?.active ?? true)
  const [settings, setSettings] = useState<Settings>(shop?.settings ?? {})
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  async function upload(file: File) {
    setUploading(true)
    setUploadError('')
    try {
      const logo = await prepareLogo(file)
      const result = await api<{ logo: string }>('/api/partner/branding/logo', {
        logo,
      })
      setSettings((v) => ({ ...v, logo: result.logo }))
    } catch (e) {
      setUploadError(errorMessage(e))
    } finally {
      setUploading(false)
    }
  }
  const fields: [keyof Settings, string, number][] = [
    ['brandName', '品牌名称', 32],
    ['pageTitle', '页面标题', 120],
    ['headline', '首页标题', 120],
    ['description', '商店简介', 500],
    ['wechat', '微信', 100],
    ['qq', 'QQ', 100],
    ['email', '联系邮箱', 320],
    ['announcementTitle', '公告标题', 100],
    ['announcement', '商店公告', 2000],
  ]
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose()
      }}
    >
      <DialogContent
        className="store-editor motion-dialog"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>{shop ? '编辑商店' : '新增商店'}</DialogTitle>
          <DialogDescription>
            设置仅属于这家店。推广码创建后保持固定。
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void save({
              id: shop?.id ?? '',
              version: shop?.version ?? 0,
              name,
              active,
              settings,
            })
          }}
        >
          <fieldset
            className="store-editor-fieldset"
            disabled={busy || uploading}
          >
            {(error || uploadError) && (
              <p className="stores-error" role="alert">
                {error || uploadError}
              </p>
            )}
            <div><span>Logo</span><ImageUploadField name="商店 Logo" url={settings.logo} busy={busy || uploading} onUpload={file => void upload(file)} onRemove={() => setSettings({ ...settings, logo: '' })} /></div>
            <label>
              商店名称
              <Input
                required
                maxLength={32}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {(
              [
                [
                  '店铺形象',
                  ['brandName', 'pageTitle', 'headline', 'description'],
                ],
                ['联系方式', ['wechat', 'qq', 'email']],
                ['商店公告', ['announcementTitle', 'announcement']],
              ] as [string, (keyof Settings)[]][]
            ).map(([title, keys]) => (
              <WorkspaceDisclosure
                key={title}
                title={title}
                defaultOpen={title === '店铺形象'}
              >
                <div className="store-editor-fields">
                  {' '}
                  {fields
                    .filter(([key]) => keys.includes(key))
                    .map(([key, title, max]) => (
                      <label key={key}>
                        {title}
                        {key === 'announcement' || key === 'description' ? (
                          <Textarea
                            maxLength={max}
                            value={settings[key] ?? ''}
                            onChange={(e) =>
                              setSettings({
                                ...settings,
                                [key]: e.target.value,
                              })
                            }
                          />
                        ) : (
                          <Input
                            maxLength={max}
                            value={settings[key] ?? ''}
                            onChange={(e) =>
                              setSettings({
                                ...settings,
                                [key]: e.target.value,
                              })
                            }
                          />
                        )}
                      </label>
                    ))}
                </div>
              </WorkspaceDisclosure>
            ))}
            <label>
              公告展示位置
              <WorkspaceSelect
                label="公告展示位置"
                value={settings.announcementPlacement ?? 'both'}
                onValueChange={(value) =>
                  setSettings({ ...settings, announcementPlacement: value })
                }
                options={[
                  { value: 'both', label: '首页和商品页' },
                  { value: 'home', label: '仅首页' },
                  { value: 'product', label: '仅商品页' },
                ]}
              />
            </label>
            <label className="store-check">
              <Checkbox checked={active} onCheckedChange={setActive} />
              商店营业
            </label>
            <Button type="submit" disabled={busy || uploading || !name.trim()}>
              {busy ? '保存中…' : '保存商店'}
            </Button>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  )
}
function CouponEditor({
  error,
  coupon,
  shops,
  prices,
  selected,
  busy,
  onClose,
  save,
}: {
  error: string
  coupon?: Coupon
  shops: Shop[]
  prices: Price[]
  selected: string
  busy: boolean
  onClose: () => void
  save: (value: unknown) => Promise<void>
}) {
  const [code, setCode] = useState(coupon?.code ?? '')
  const [amount, setAmount] = useState(
    coupon ? String(coupon.discount_cents / 100) : '',
  )
  const [start, setStart] = useState(() =>
    localDate(coupon?.starts_at ?? new Date().toISOString()),
  )
  const [end, setEnd] = useState(() =>
    localDate(
      coupon?.ends_at ?? new Date(Date.now() + 30 * 86400000).toISOString(),
    ),
  )
  const [count, setCount] = useState(String(coupon?.max_uses ?? 100))
  const [once, setOnce] = useState(coupon?.once_per_email ?? true)
  const [active, setActive] = useState(coupon?.active ?? true)
  const [targets, setTargets] = useState<Target[]>(coupon?.targets ?? [])
  const validDates =
    Number.isFinite(Date.parse(start)) &&
    Number.isFinite(Date.parse(end)) &&
    Date.parse(end) > Date.parse(start)
  const invalid =
    active &&
    targets.some((t) => {
      const p = prices.find(
        (p) => p.store_id === t.storeId && p.plan === t.plan,
      )
      return !p || p.price_cents - toCents(amount) < p.cost_cents
    })
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v && !busy) onClose()
      }}
    >
      <DialogContent
        className="store-editor motion-dialog"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>{coupon ? '编辑优惠码' : '新增优惠码'}</DialogTitle>
          <DialogDescription>
            固定减金额；未勾选的商店商品不能使用。
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (busy || invalid || !validDates) return
            void save({
              id: coupon?.id ?? '',
              version: coupon?.version ?? 0,
              code,
              discountCents: toCents(amount),
              startsAt: new Date(start).toISOString(),
              endsAt: new Date(end).toISOString(),
              maxUses: Number(count),
              oncePerEmail: once,
              active,
              targets,
            })
          }}
        >
          <fieldset className="store-editor-fieldset" disabled={busy}>
            {error && (
              <p className="stores-error" role="alert">
                {error}
              </p>
            )}
            <label>
              优惠码
              <Input
                required
                maxLength={32}
                pattern="[A-Za-z0-9_-]{3,32}"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
            </label>
            <div className="store-form-grid">
              <label>
                减免金额（元）
                <Input
                  required
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </label>
              <label>
                总使用次数
                <Input
                  type="number"
                  required
                  min={1}
                  max={1000000}
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                />
              </label>
              <DateTimePicker
                id="coupon-start"
                label="生效时间"
                value={start}
                onChange={setStart}
              />
              <DateTimePicker
                id="coupon-end"
                label="失效时间"
                value={end}
                onChange={setEnd}
              />
            </div>
            <label className="store-check">
              <Checkbox checked={once} onCheckedChange={setOnce} />
              每个邮箱限用一次（跨选中商店合计）
            </label>
            <label className="store-check">
              <Checkbox checked={active} onCheckedChange={setActive} />
              启用优惠码
            </label>
            <fieldset>
              <legend>适用商店与套餐 · 已选 {targets.length} 项</legend>
              {shops.map((s) => (
                <WorkspaceDisclosure
                  key={s.id}
                  defaultOpen={s.id === selected}
                  title={s.name}
                >
                  {prices
                    .filter((p) => p.store_id === s.id)
                    .map((p) => {
                      const checked = targets.some(
                        (t) => t.storeId === s.id && t.plan === p.plan,
                      )
                      return (
                        <label
                          className="store-check store-target"
                          key={p.plan}
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(checked) =>
                              setTargets(
                                checked
                                  ? [
                                      ...targets,
                                      { storeId: s.id, plan: p.plan },
                                    ]
                                  : targets.filter(
                                      (t) =>
                                        !(
                                          t.storeId === s.id &&
                                          t.plan === p.plan
                                        ),
                                    ),
                              )
                            }
                          />
                          <span>
                            {p.name}
                            <small>
                              售价 {money(p.price_cents)} · 最多可减{' '}
                              {money(p.price_cents - p.cost_cents)}
                            </small>
                          </span>
                        </label>
                      )
                    })}
                </WorkspaceDisclosure>
              ))}
            </fieldset>
            {!validDates && (
              <p className="stores-error" role="alert">
                请选择生效与失效时间，失效时间需晚于生效时间。
              </p>
            )}
            {invalid && (
              <p className="stores-error">
                所选商品优惠后低于拿货价，请调整金额或选择范围。
              </p>
            )}
            <Button
              type="submit"
              disabled={
                busy ||
                !validDates ||
                invalid ||
                !targets.length ||
                !Number.isFinite(toCents(amount)) ||
                toCents(amount) <= 0
              }
            >
              {busy ? '保存中…' : '保存优惠码'}
            </Button>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function StoreOrderList({
  prefix,
  shop,
  revision,
}: {
  prefix: string
  shop: string
  revision: number
}) {
  const [page, setPage] = useState(1)
  const { data, error, loading } = useResource<{
    rows: {
      id: string
      plan_name: string
      price_cents: number
      discount_cents: number
      coupon_code: string | null
      profit_cents: number | null
      status: string
      created_at: number
    }[]
    total: number
  }>(
    prefix + '/orders?store=' + encodeURIComponent(shop) + '&page=' + page,
    revision,
  )
  return (
    <div>
      {error && <p role="alert">{error}</p>}
      {loading && !data && <p>正在读取订单…</p>}
      {data && (
        <>
          <p>共 {data.total} 笔订单；收益按当前结算与退款状态核算。</p>
          <div className="admin-table-scroll">
            <Table className="admin-table">
              <TableHeader>
                <TableRow>
                  <TableHead>订单</TableHead>
                  <TableHead>套餐</TableHead>
                  <TableHead>成交价</TableHead>
                  <TableHead>优惠</TableHead>
                  <TableHead>差价收益</TableHead>
                  <TableHead>状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell>{o.id}</TableCell>
                    <TableCell>{o.plan_name}</TableCell>
                    <TableCell>{money(o.price_cents)}</TableCell>
                    <TableCell>
                      {o.coupon_code
                        ? `${o.coupon_code} · ${money(o.discount_cents)}`
                        : '—'}
                    </TableCell>
                    <TableCell>
                      {o.profit_cents == null ? '—' : money(o.profit_cents)}
                    </TableCell>
                    <TableCell>
                      {(
                        {
                          pending: '待付款',
                          session: '待提交',
                          processing: '处理中',
                          success: '已完成',
                          failed: '需处理',
                          cancelled: '已关闭',
                        } as Record<string, string>
                      )[o.status] ?? o.status}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="store-actions">
            <Button
              variant="outline"
              disabled={page === 1 || loading}
              onClick={() => setPage((p) => p - 1)}
            >
              上一页
            </Button>
            <span>第 {page} 页</span>
            <Button
              variant="outline"
              disabled={page * 20 >= data.total || loading}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
