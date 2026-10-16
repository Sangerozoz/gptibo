import { useState } from 'react'
import { Checkbox } from '@base-ui/react/checkbox'
import { Check, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Feedback } from '@/components/workspace-loading'
import { api, errorMessage, type CatalogPlan } from '@/lib/api'
import { useResource } from '@/lib/use-resource'
import { emailProduct } from '../../shared/email-products'
import { isXGiftPlan } from '../../shared/xgift-products'
import { parsePlanPrice, planUpdateNote, selectProductPlanDetails } from './product-plans'

type PlanAudit = { id: string; target_id: string; note: string; created_at: number }
const time = (value: number) => new Date(value).toLocaleString('zh-CN', { hour12: false })

function PlanEditor({ plan, onClose, onUpdated, partnerModeEnabled }: { plan: CatalogPlan; onClose: () => void; onUpdated: () => void; partnerModeEnabled: boolean }) {
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [partnerEnabled, setPartnerEnabled] = useState(plan.partner_enabled !== 0)
  const [supportsWarranty, setSupportsWarranty] = useState(plan.supports_warranty !== false)
  const [purchaseNote, setPurchaseNote] = useState(plan.purchase_note ?? '')
  const [deliveryInstructions, setDeliveryInstructions] = useState(plan.delivery_instructions ?? '')

  async function save() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await api(`/api/admin/plans/${plan.id}`, {
        priceCents: plan.price_cents, enabled: Boolean(plan.enabled), note, purchaseNote,
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
      <DialogHeader><DialogTitle>其他设置 · {plan.name}</DialogTitle><DialogDescription>套餐售价与上架状态在表格中修改。售后质保设置对该商品的所有订单立即生效，包含历史订单。</DialogDescription></DialogHeader>
      <form className="admin-edit-form" onSubmit={event => { event.preventDefault(); void save() }}>
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

function PlanRow({ plan, onUpdated, onSettings }: { plan: CatalogPlan; onUpdated: () => void; onSettings: () => void }) {
  const [price, setPrice] = useState(String(plan.price_cents / 100))
  const [label, setLabel] = useState(plan.display_label ?? '')
  const [enabled, setEnabled] = useState(Boolean(plan.enabled))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const priceCents = parsePlanPrice(price)
  const dirty = priceCents !== plan.price_cents || enabled !== Boolean(plan.enabled) || label.trim() !== (plan.display_label ?? '')

  async function save() {
    if (busy || !dirty) return
    if (priceCents === null) {
      setError('请输入 0.01–100000 元的价格，最多两位小数。')
      return
    }
    if (Array.from(label.trim()).length > 20) {
      setError('套餐标签最多 20 个字符。')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api(`/api/admin/plans/${plan.id}`, {
        priceCents, enabled, displayLabel: label.trim(), version: plan.version,
        note: planUpdateNote(plan, { priceCents, enabled, displayLabel: label.trim() }),
      })
      onUpdated()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return <tr>
    <td>{plan.name}</td>
    <td className="direct-plan-label"><label><span className="sr-only">{plan.name} 标签</span><Input value={label} onChange={event => { setLabel(event.target.value); setError('') }} placeholder="无标签" maxLength={20} disabled={busy} /></label></td>
    <td className="direct-plan-price"><label><span className="sr-only">{plan.name} 售价（元）</span><span>¥</span><Input value={price} onChange={event => { setPrice(event.target.value); setError('') }} inputMode="decimal" disabled={busy} aria-invalid={Boolean(error && priceCents === null)} /><small>/ {emailProduct(plan.id)?.duration ?? (plan.product_id === 'chatgpt' ? '月' : '次')}</small></label></td>
    <td><label className="direct-plan-availability"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={busy} aria-label={`${plan.name} 套餐上架`} /><span>{enabled ? '已上架' : '已下架'}</span></label></td>
    <td><div className="direct-plan-actions"><Button type="button" variant="outline" aria-label={`保存 ${plan.name} 套餐`} disabled={busy || !dirty} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</Button><Button type="button" variant="ghost" size="icon" title={`编辑 ${plan.name} 其他设置`} aria-label={`编辑 ${plan.name} 其他设置`} disabled={busy || dirty} onClick={onSettings}><Pencil size={15} /></Button></div>{error && <p className="admin-error" role="alert">{error}</p>}</td>
  </tr>
}

export function ProductPlans({ productId, productName, listed, revision, onUpdated, partnerModeEnabled }: { productId: string; productName: string; listed: boolean; revision: number; onUpdated: () => void; partnerModeEnabled: boolean }) {
  const { data, error, loading } = useResource<{ plans: CatalogPlan[] }>('/api/admin/plans', revision)
  const audit = useResource<{ rows: PlanAudit[] }>('/api/admin/audit', revision)
  const [edit, setEdit] = useState<CatalogPlan>()
  const [createOpen, setCreateOpen] = useState(false)
  const selection = selectProductPlanDetails(productId, data?.plans ?? [], audit.data?.rows ?? [])

  return <div className="direct-product-plans">
    <div className="direct-product-plan-heading"><h3>套餐与售价</h3><Button type="button" onClick={() => setCreateOpen(true)}>新增</Button></div>
    <p className="admin-subtle">只有商品已上架且套餐允许创建新订单时，客户才可购买。{listed ? '' : '当前商品已下架。'}</p>
    <Feedback error={error} loading={loading} data={data} />
    {data && (selection.plans.length ? <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>套餐</th><th>标签</th><th>售价（元）</th><th>上架状态</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{selection.plans.map(plan => <PlanRow key={`${plan.id}:${plan.version}`} plan={plan} onUpdated={onUpdated} onSettings={() => setEdit(plan)} />)}</tbody></table></div> : <p className="direct-product-empty">该商品暂无套餐。新增套餐需先接入下单与交付流程。</p>)}
    {selection.plans.length > 0 && <div className="direct-product-plan-audit">
      <h3>套餐修改记录</h3>
      <Feedback error={audit.error} loading={audit.loading} data={audit.data} shape="compact" />
      {audit.data && (selection.audit.length ? <div className="admin-audit-list">{selection.audit.map(row => <div key={row.id}><strong>{row.target_id}</strong><span>{row.note}</span><time>{time(row.created_at)}</time></div>)}</div> : <p className="direct-product-empty">暂无修改记录。</p>)}
    </div>}
    {edit && <PlanEditor plan={edit} onClose={() => setEdit(undefined)} onUpdated={onUpdated} partnerModeEnabled={partnerModeEnabled} />}
    <Dialog open={createOpen} onOpenChange={setCreateOpen}>
      <DialogContent className="direct-category-dialog">
        <DialogHeader><DialogTitle>新增 {productName} 套餐</DialogTitle><DialogDescription>当前暂不能从后台直接创建可售套餐。</DialogDescription></DialogHeader>
        <p className="admin-subtle">新套餐还需要接入前台展示、付款与交付规则。完成对应业务流程后，才能开放创建。现有套餐可以在此修改售价和上架状态。</p>
        <DialogFooter><Button type="button" onClick={() => setCreateOpen(false)}>知道了</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}
