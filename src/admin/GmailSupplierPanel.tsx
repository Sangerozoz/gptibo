import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Feedback } from '@/components/workspace-loading'
import { api, errorMessage } from '@/lib/api'
import { useResource } from '@/lib/use-resource'

type Config = { configured: boolean; checkoutEnabled: boolean; goodsId: number | null; maxCostCents: number | null }
type Goods = { goodsId: number; name: string; priceCents: number; stock: number; enabled: boolean }
export function GmailSupplierPanel({ revision }: { revision: number }) {
  const config = useResource<Config>('/api/admin/account_supplier', revision)
  return <section className="admin-panel"><div className="admin-panel-title"><h2>Gmail 自动采购</h2><span>付款确认后采购 · 邮件交付</span></div>
    <Feedback error={config.error} loading={config.loading} data={config.data} shape="compact" />
    {config.data && <p className="admin-subtle">接口凭据：{config.data.configured ? '已配置' : '未配置'} · 自动购买：{config.data.checkoutEnabled ? '已启用' : '未启用'} · 成本上限：{config.data.maxCostCents !== null ? `¥${(config.data.maxCostCents / 100).toFixed(2)}` : '未设置'}</p>}
    {config.data?.configured && config.data.goodsId && <SupplierGoods id={config.data.goodsId} revision={revision} />}
    <p className="admin-panel-footnote">售价在商品管理中调整，代理拿货价在代理管理中调整。采购超时只查询原采购单，不重复下单；进价超过成本上限或库存不足时暂停新购买。</p>
  </section>
}
function SupplierGoods({ id, revision }: { id: number; revision: number }) {
  const product = useResource<Goods>(`/api/admin/account_supplier/goods/${id}`, revision)
  return <><Feedback error={product.error} loading={product.loading} data={product.data} shape="compact" />{product.data && <p>{product.data.goodsId} · {product.data.name}<br />当前进价 ¥{(product.data.priceCents / 100).toFixed(2)} · 库存 {product.data.stock} · {product.data.enabled ? '供应商在售' : '供应商已停售'}</p>}</>
}
type Purchase = { state: string; goodsId: number; supplierOrder: string | null; actualCostCents: number | null; maxCostCents: number; updatedAt: number }
export function GmailOrderPanel({ id, revision, orderVersion, onSaved }: { id: string; revision: number; orderVersion: number; onSaved: () => void }) {
  const endpoint = `/api/admin/orders/${id}/account_supplier`, resource = useResource<{ purchase: Purchase | null }>(endpoint, revision)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), lock = useRef(false)
  const [confirmed, setConfirmed] = useState(false), [note, setNote] = useState('')
  async function sync(resolve = false) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await api(endpoint, resolve ? { action: 'confirm-not-purchased', confirmed, note, orderVersion, updatedAt: resource.data?.purchase?.updatedAt } : { action: 'sync' }); onSaved() } catch (e) { setError(errorMessage(e)); onSaved() } finally { lock.current = false; setBusy(false) }
  }
  const labels: Record<string, string> = { prepared: '待确认付款并采购', creating: '采购处理中', unknown: '原采购结果待核对', purchased: '账号采购已核验', rejected: '采购未完成，请核对供应商记录后处理售后' }
  return <section className="email-delivery-panel" aria-label="Gmail 采购记录"><h3>Gmail 采购记录</h3><Feedback error={error || resource.error} loading={resource.loading} data={resource.data} shape="compact" />
    {resource.data?.purchase && <p>{labels[resource.data.purchase.state]}<br />商品编号 {resource.data.purchase.goodsId} · 供应商单号 {resource.data.purchase.supplierOrder ?? '尚未确认'}<br />实际成本 {resource.data.purchase.actualCostCents !== null ? `¥${(resource.data.purchase.actualCostCents / 100).toFixed(2)}` : '待核验'}</p>}
    <Button variant="outline" disabled={busy} onClick={() => void sync()}>{busy ? '正在核对…' : '核对采购与发货进度'}</Button>
    {resource.data?.purchase && ['creating', 'unknown'].includes(resource.data.purchase.state) && <details><summary>已在供应商后台核实原采购未发生</summary><p>仅在核实原订单无扣款、无发货后登记。登记后停止自动采购，可通过售后退款；请勿在说明中填写账号密码。</p><label className="admin-checkbox"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} disabled={busy} />已核实原采购单无扣款、无发货</label><Input aria-label="采购核查说明" value={note} onChange={e => setNote(e.target.value)} maxLength={500} disabled={busy} placeholder="供应商核查记录或处理结果" /><Button variant="outline" disabled={busy || !confirmed || note.trim().length < 6} onClick={() => void sync(true)}>登记采购未发生</Button></details>}
  </section>
}
