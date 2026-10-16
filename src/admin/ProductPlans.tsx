import { useState } from 'react'
import { Checkbox } from '@base-ui/react/checkbox'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Feedback } from '@/components/workspace-loading'
import { api, errorMessage, type CatalogPlan } from '@/lib/api'
import { useResource } from '@/lib/use-resource'
import { emailProduct } from '../../shared/email-products'
import { isXGiftPlan } from '../../shared/xgift-products'
import { selectProductPlanDetails } from './product-plans'

type PlanAudit = { id: string; target_id: string; note: string; created_at: number }
const money = (cents: number) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(cents / 100)
const time = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })

function PlanEditor({ plan, onClose, onUpdated, partnerModeEnabled }: { plan: CatalogPlan; onClose: () => void; onUpdated: () => void; partnerModeEnabled: boolean }) {
  const [price, setPrice] = useState(String(plan.price_cents / 100))
  const [enabled, setEnabled] = useState(Boolean(plan.enabled))
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [partnerEnabled, setPartnerEnabled] = useState(plan.partner_enabled !== 0)
  const [supportsWarranty, setSupportsWarranty] = useState(plan.supports_warranty !== false)
  const [purchaseNote, setPurchaseNote] = useState(plan.purchase_note ?? '')
  const [deliveryInstructions, setDeliveryInstructions] = useState(plan.delivery_instructions ?? '')

  async function save() {
    if (busy) return
    if (!/^\d+(\.\d{1,2})?$/.test(price) || Number(price) <= 0 || Number(price) > 100000) {
      setError('请输入 0.01–100000 元的价格，最多两位小数。')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api(`/api/admin/plans/${plan.id}`, {
        priceCents: Math.round(Number(price) * 100), enabled, note, purchaseNote,
        deliveryInstructions, partnerEnabled, supportsWarranty, version: plan.version,
      })
      onUpdated()
      onClose()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent className="admin-edit motion-dialog">
      <DialogHeader><DialogTitle>编辑 {plan.name}</DialogTitle><DialogDescription>售后质保设置对该商品的所有订单立即生效，包含历史订单。</DialogDescription></DialogHeader>
      <form className="admin-edit-form" onSubmit={event => { event.preventDefault(); void save() }}>
        <label htmlFor="admin-plan-price">售价（元）</label>
        <Input id="admin-plan-price" value={price} onChange={event => setPrice(event.target.value)} inputMode="decimal" disabled={busy} />
        <label className="admin-checkbox"><Checkbox.Root className="admin-check-control" checked={enabled} onCheckedChange={value => setEnabled(Boolean(value))} disabled={busy}><Checkbox.Indicator><Check size={13} /></Checkbox.Indicator></Checkbox.Root>允许创建新订单</label>
        <label className="admin-checkbox"><Checkbox.Root className="admin-check-control" checked={supportsWarranty} onCheckedChange={value => setSupportsWarranty(Boolean(value))} disabled={busy}><Checkbox.Indicator><Check size={13} /></Checkbox.Indicator></Checkbox.Root>支持售后质保</label>
        <p className="admin-subtle">关闭后，购买前会明确提示不支持售后质保，该商品的所有订单均无法提交新的售后申请。重新开启后，所有订单同步恢复售后申请入口。</p>
        {Boolean(plan.renewal_only) && <p className="admin-subtle">该套餐仅支持已有订阅续费。</p>}
        {partnerModeEnabled && (emailProduct(plan.id) || isXGiftPlan(plan.id)) && <label className="admin-checkbox"><input type="checkbox" checked={partnerEnabled} onChange={event => setPartnerEnabled(event.target.checked)} disabled={busy} />开放代理销售（请先核对代理供货价）</label>}
        {emailProduct(plan.id) && <>
          <label htmlFor="admin-purchase-note">购买说明（客户下单前可见）</label>
          <textarea id="admin-purchase-note" rows={4} value={purchaseNote} onChange={event => setPurchaseNote(event.target.value)} maxLength={2000} disabled={busy} placeholder="账号要求、适用地区、领取限制及预计人工处理时间" />
          <label htmlFor="admin-delivery-instructions">默认领取说明（发货时可再修改）</label>
          <textarea id="admin-delivery-instructions" rows={4} value={deliveryInstructions} onChange={event => setDeliveryInstructions(event.target.value)} maxLength={2000} disabled={busy} placeholder="兑换步骤、领取页面与注意事项。不要在此填写客户专属 CDK。" />
        </>}
        <label htmlFor="admin-plan-note">修改说明</label>
        <Input id="admin-plan-note" value={note} onChange={event => setNote(event.target.value)} maxLength={500} placeholder="例如：调整售价或暂停销售" disabled={busy} />
        <Feedback error={error} />
        <Button type="submit" disabled={busy || !note.trim()}>{busy ? '保存中…' : '保存修改'}</Button>
      </form>
    </DialogContent>
  </Dialog>
}

export function ProductPlans({ productId, listed, revision, onUpdated, partnerModeEnabled }: { productId: string; listed: boolean; revision: number; onUpdated: () => void; partnerModeEnabled: boolean }) {
  const { data, error, loading } = useResource<{ plans: CatalogPlan[] }>('/api/admin/plans', revision)
  const audit = useResource<{ rows: PlanAudit[] }>('/api/admin/audit', revision)
  const [edit, setEdit] = useState<CatalogPlan>()
  const selection = selectProductPlanDetails(productId, data?.plans ?? [], audit.data?.rows ?? [])

  return <div className="direct-product-plans">
    <p className="admin-subtle">只有商品已上架且套餐允许创建新订单时，客户才可购买。{listed ? '' : '当前商品已下架。'}</p>
    <Feedback error={error} loading={loading} data={data} />
    {data && (selection.plans.length ? <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>套餐</th><th>售价</th><th>销售状态</th><th>适用范围</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{selection.plans.map(plan => <tr key={plan.id}><td>{plan.name}</td><td className="admin-numeric">{money(plan.price_cents)}<small>/ {emailProduct(plan.id)?.duration ?? (plan.product_id === 'chatgpt' ? '月' : '次')}</small></td><td><span className={`admin-pill ${plan.enabled ? 'available' : ''}`}>{plan.enabled ? '可购买' : '已暂停'}</span></td><td>{plan.renewal_only ? '仅续费' : '常规服务'}</td><td><Button type="button" variant="outline" onClick={() => setEdit(plan)}>编辑</Button></td></tr>)}</tbody></table></div> : <p className="direct-product-empty">该商品暂无套餐。新增套餐需先接入下单与交付流程。</p>)}
    {selection.plans.length > 0 && <div className="direct-product-plan-audit">
      <h3>套餐修改记录</h3>
      <Feedback error={audit.error} loading={audit.loading} data={audit.data} shape="compact" />
      {audit.data && (selection.audit.length ? <div className="admin-audit-list">{selection.audit.map(row => <div key={row.id}><strong>{row.target_id}</strong><span>{row.note}</span><time>{time(row.created_at)}</time></div>)}</div> : <p className="direct-product-empty">暂无修改记录。</p>)}
    </div>}
    {edit && <PlanEditor plan={edit} onClose={() => setEdit(undefined)} onUpdated={onUpdated} partnerModeEnabled={partnerModeEnabled} />}
  </div>
}
