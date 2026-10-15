import { useState, type ChangeEvent, type FormEvent } from 'react'
import { ArrowDown, ArrowUp, GripVertical, ImagePlus, Package, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, errorMessage } from '@/lib/api'
import { useResource } from '@/lib/use-resource'
import { prepareProductImage } from '@/lib/prepare-product-image'
import { Feedback } from '@/components/workspace-loading'
import type { DirectCategory, DirectProduct, DirectSite } from '../../shared/direct-store'
import './direct-store.css'

type Site = DirectSite & { logoMediaId: string | null; version: number }
type Category = DirectCategory & { version: number }
type Product = DirectProduct & { imageMediaId: string | null; version: number }
type List<T> = { orderVersion: number; categories?: T[]; products?: T[] }

async function upload(file: File) {
  const image = await prepareProductImage(file)
  return api<{ id: string; url: string }>('/api/admin/direct-store/media', { image })
}

function ImageInput({ url, onUpload, onRemove, busy }: { url: string | null; onUpload: (file: File) => Promise<void>; onRemove: () => void; busy: boolean }) {
  const [error, setError] = useState('')
  async function changed(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError('')
    try { await onUpload(file) } catch (cause) { setError(cause instanceof Error ? cause.message : '图片上传失败，请重试。') }
  }
  return <div className="direct-image-input">
    {url ? <img src={url} alt="当前图片" /> : <span className="direct-image-placeholder"><ImagePlus size={20} />未设置图片</span>}
    <label className="direct-upload-button">{busy ? '上传中…' : '上传 PNG / JPG'}<input type="file" accept="image/png,image/jpeg" disabled={busy} onChange={event => void changed(event)} /></label>
    {url && <Button type="button" variant="ghost" disabled={busy} onClick={onRemove}>移除图片</Button>}
    {error && <p className="admin-error" role="alert">{error}</p>}
  </div>
}

function SiteForm({ initial, onUpdated }: { initial: Site; onUpdated: () => void }) {
  const [nameZh, setNameZh] = useState(initial.nameZh)
  const [nameEn, setNameEn] = useState(initial.nameEn)
  const [logoMediaId, setLogoMediaId] = useState(initial.logoMediaId)
  const [logoUrl, setLogoUrl] = useState(initial.logoUrl)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('')
    try { await api('/api/admin/direct-store/site', { nameZh, nameEn, logoMediaId, version: initial.version }); setNotice('店铺形象已保存。'); onUpdated() }
    catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  async function addLogo(file: File) {
    setBusy(true)
    try { const result = await upload(file); setLogoMediaId(result.id); setLogoUrl(result.url) }
    finally { setBusy(false) }
  }
  return <form className="direct-admin-form" onSubmit={event => void save(event)}>
    <p className="admin-subtle">中文站显示中文名称，英文站显示英文名称。英文留空时显示中文名称。</p>
    <div className="direct-admin-fields"><label>中文店名<Input value={nameZh} onChange={event => setNameZh(event.target.value)} maxLength={32} required disabled={busy} /></label><label>英文店名<Input value={nameEn} onChange={event => setNameEn(event.target.value)} maxLength={32} disabled={busy} /></label></div>
    <label className="direct-field-title">店铺 Logo</label><ImageInput url={logoUrl} onUpload={addLogo} onRemove={() => { setLogoMediaId(null); setLogoUrl(null) }} busy={busy} />
    <p className="admin-subtle">名称和 Logo 保存后会同步到前台。发件邮箱地址仍由服务器配置。</p>
    <Feedback error={error} />{notice && <p className="admin-success" role="status">{notice}</p>}
    <Button type="submit" disabled={busy || !nameZh.trim()}><Save size={15} />{busy ? '保存中…' : '保存店铺设置'}</Button>
  </form>
}

export function StoreSettingsPage({ revision, onUpdated }: { revision: number; onUpdated: () => void }) {
  const { data, error, loading } = useResource<Site>('/api/admin/direct-store/site', revision)
  return <section className="admin-panel"><div className="admin-panel-title"><h2>店铺名称与 Logo</h2></div><Feedback error={error} loading={loading} data={data} />{data && <SiteForm key={data.version} initial={data} onUpdated={onUpdated} />}</section>
}

function CategoryEditor({ category, onUpdated }: { category: Category; onUpdated: () => void }) {
  const [nameZh, setNameZh] = useState(category.nameZh)
  const [nameEn, setNameEn] = useState(category.nameEn)
  const [active, setActive] = useState(category.active)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try { await api(`/api/admin/direct-store/categories/${category.id}`, { nameZh, nameEn, active, version: category.version }); onUpdated() }
    catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  return <form className="direct-row-editor" onSubmit={event => void save(event)}><label>中文名称<Input value={nameZh} onChange={event => setNameZh(event.target.value)} maxLength={32} required disabled={busy} /></label><label>英文名称<Input value={nameEn} onChange={event => setNameEn(event.target.value)} maxLength={32} disabled={busy} /></label><label className="direct-checkbox"><input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)} disabled={busy} />显示分类</label><Button type="submit" disabled={busy || !nameZh.trim()}>保存</Button>{error && <p className="admin-error" role="alert">{error}</p>}</form>
}

function CategoryCreate({ onUpdated }: { onUpdated: () => void }) {
  const [nameZh, setNameZh] = useState('')
  const [nameEn, setNameEn] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try { await api('/api/admin/direct-store/categories', { nameZh, nameEn }); setNameZh(''); setNameEn(''); onUpdated() }
    catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  return <form className="direct-row-editor direct-create" onSubmit={event => void create(event)}><label>新分类中文名<Input value={nameZh} onChange={event => setNameZh(event.target.value)} maxLength={32} required disabled={busy} /></label><label>英文名<Input value={nameEn} onChange={event => setNameEn(event.target.value)} maxLength={32} disabled={busy} /></label><Button type="submit" disabled={busy || !nameZh.trim()}>新增分类</Button>{error && <p className="admin-error" role="alert">{error}</p>}</form>
}

function move(ids: readonly string[], index: number, delta: number) {
  const next = [...ids], target = index + delta
  if (target < 0 || target >= next.length) return next
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

function reposition(ids: readonly string[], from: string, to: string) {
  const next = [...ids], oldIndex = next.indexOf(from), newIndex = next.indexOf(to)
  if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return next
  next.splice(oldIndex, 1)
  next.splice(newIndex, 0, from)
  return next
}

function CategoryList({ initial, products, onUpdated }: { initial: { categories: Category[]; orderVersion: number }; products: Product[]; onUpdated: () => void }) {
  const [ids, setIds] = useState(initial.categories.map(item => item.id))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dirty = ids.some((id, index) => initial.categories[index]?.id !== id)
  async function saveOrder() {
    setBusy(true); setError('')
    try { await api('/api/admin/direct-store/categories/order', { ids, version: initial.orderVersion }); onUpdated() }
    catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  return <><p className="admin-panel-footnote">停用分类后，分类筛选会隐藏；其中已上架商品仍显示在“全部商品”。拖动排序柄或使用上下按钮调整位置后请保存排序。</p><div className="direct-admin-list">{ids.map((id, index) => { const item = initial.categories.find(category => category.id === id)!; return <div className="direct-admin-row" key={id} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); setIds(reposition(ids, event.dataTransfer.getData('text/plain'), id)) }}><div className="direct-row-heading"><span className="direct-drag-handle" draggable={!busy} title={`拖动排序 ${item.nameZh}`} onDragStart={event => event.dataTransfer.setData('text/plain', id)}><GripVertical size={16} /></span><strong>{item.nameZh}</strong><span>{item.active ? '显示中' : '已停用'} · {products.filter(product => product.categoryId === id).length} 件商品</span><div className="direct-move"><Button variant="outline" size="icon" aria-label={`上移 ${item.nameZh}`} disabled={busy || index === 0} onClick={() => setIds(move(ids, index, -1))}><ArrowUp size={14} /></Button><Button variant="outline" size="icon" aria-label={`下移 ${item.nameZh}`} disabled={busy || index === ids.length - 1} onClick={() => setIds(move(ids, index, 1))}><ArrowDown size={14} /></Button></div></div><CategoryEditor key={item.version} category={item} onUpdated={onUpdated} /></div> })}</div><div className="direct-list-actions"><Button onClick={() => void saveOrder()} disabled={busy || !dirty}>保存分类排序</Button>{error && <p className="admin-error" role="alert">{error}</p>}</div><CategoryCreate onUpdated={onUpdated} /></>
}

export function CategoryAdminPage({ revision, onUpdated }: { revision: number; onUpdated: () => void }) {
  const { data, error, loading } = useResource<List<Category>>('/api/admin/direct-store/categories', revision)
  const products = useResource<List<Product>>('/api/admin/direct-store/products', revision)
  return <section className="admin-panel"><div className="admin-panel-title"><h2>商品分类</h2></div><Feedback error={error || products.error} loading={loading || products.loading} data={data && products.data} />{data?.categories && products.data?.products && <CategoryList key={`${data.orderVersion}:${data.categories.map(item => item.version).join(':')}`} initial={{ categories: data.categories, orderVersion: data.orderVersion }} products={products.data.products} onUpdated={onUpdated} />}</section>
}

function ProductEditor({ product, categories, onUpdated, onPlans }: { product: Product; categories: Category[]; onUpdated: () => void; onPlans: () => void }) {
  const [nameZh, setNameZh] = useState(product.nameZh)
  const [nameEn, setNameEn] = useState(product.nameEn)
  const [descriptionZh, setDescriptionZh] = useState(product.descriptionZh)
  const [descriptionEn, setDescriptionEn] = useState(product.descriptionEn)
  const [categoryId, setCategoryId] = useState(product.categoryId)
  const [listed, setListed] = useState(product.listed)
  const [imageMediaId, setImageMediaId] = useState(product.imageMediaId)
  const [imageUrl, setImageUrl] = useState(product.imageUrl)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try { await api(`/api/admin/direct-store/products/${product.id}`, { nameZh, nameEn, descriptionZh, descriptionEn, categoryId, listed, imageMediaId, version: product.version }); onUpdated() }
    catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  async function addImage(file: File) {
    setBusy(true)
    try { const result = await upload(file); setImageMediaId(result.id); setImageUrl(result.url) }
    finally { setBusy(false) }
  }
  return <form className="direct-admin-form direct-product-editor" onSubmit={event => void save(event)}>
    <div className="direct-admin-fields"><label>中文名称<Input value={nameZh} onChange={event => setNameZh(event.target.value)} maxLength={64} required disabled={busy} /></label><label>英文名称<Input value={nameEn} onChange={event => setNameEn(event.target.value)} maxLength={64} disabled={busy} /></label></div>
    <div className="direct-admin-fields"><label>中文简介<Input value={descriptionZh} onChange={event => setDescriptionZh(event.target.value)} maxLength={200} disabled={busy} /></label><label>英文简介<Input value={descriptionEn} onChange={event => setDescriptionEn(event.target.value)} maxLength={200} disabled={busy} /></label></div>
    <div className="direct-admin-fields"><label>所属分类<select value={categoryId} onChange={event => setCategoryId(event.target.value)} disabled={busy}>{categories.map(category => <option key={category.id} value={category.id}>{category.nameZh}{category.active ? '' : '（停用）'}</option>)}</select></label><label className="direct-checkbox"><input type="checkbox" checked={listed} onChange={event => setListed(event.target.checked)} disabled={busy} />前台上架</label></div>
    <label className="direct-field-title">商品图片</label><ImageInput url={imageUrl} onUpload={addImage} onRemove={() => { setImageMediaId(null); setImageUrl(null) }} busy={busy} />
    <p className="admin-subtle">不上传图片时继续显示原有商品插画。套餐价格在“套餐与定价”中调整。</p>
    <Feedback error={error} /><div className="direct-product-actions"><Button type="submit" disabled={busy || !nameZh.trim()}><Save size={14} />{busy ? '保存中…' : '保存商品'}</Button><Button type="button" variant="outline" onClick={onPlans}>编辑套餐售价</Button></div>
  </form>
}

function ProductList({ initial, categories, onUpdated, onPlans }: { initial: { products: Product[]; orderVersion: number }; categories: Category[]; onUpdated: () => void; onPlans: () => void }) {
  const [ids, setIds] = useState(initial.products.map(item => item.id))
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dirty = ids.some((id, index) => initial.products[index]?.id !== id)
  async function saveOrder() {
    setBusy(true); setError('')
    try { await api('/api/admin/direct-store/products/order', { ids, version: initial.orderVersion }); onUpdated() }
    catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  return <><p className="admin-panel-footnote">下架后，前台商品卡片和详情页将隐藏，新的直接购买会被拒绝；已有订单仍可处理。拖动排序柄或使用上下按钮调整位置后请保存排序。新增商品需先接入套餐、下单与交付流程。</p><div className="direct-admin-list">{ids.map((id, index) => { const item = initial.products.find(product => product.id === id)!; return <div className="direct-admin-row" key={id} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); setIds(reposition(ids, event.dataTransfer.getData('text/plain'), id)) }}><div className="direct-row-heading"><span className="direct-drag-handle" draggable={!busy} title={`拖动排序 ${item.nameZh}`} onDragStart={event => event.dataTransfer.setData('text/plain', id)}><GripVertical size={16} /></span><Package size={17} /><strong>{item.nameZh}</strong><span>{item.listed ? '已上架' : '已下架'} · {categories.find(category => category.id === item.categoryId)?.nameZh ?? item.categoryId}</span><div className="direct-move"><Button variant="outline" size="icon" aria-label={`上移 ${item.nameZh}`} disabled={busy || index === 0} onClick={() => setIds(move(ids, index, -1))}><ArrowUp size={14} /></Button><Button variant="outline" size="icon" aria-label={`下移 ${item.nameZh}`} disabled={busy || index === ids.length - 1} onClick={() => setIds(move(ids, index, 1))}><ArrowDown size={14} /></Button><Button variant="outline" onClick={() => setEditing(editing === id ? null : id)}>{editing === id ? '收起' : '编辑'}</Button></div></div>{editing === id && <ProductEditor key={item.version} product={item} categories={categories} onUpdated={onUpdated} onPlans={onPlans} />}</div> })}</div><div className="direct-list-actions"><Button onClick={() => void saveOrder()} disabled={busy || !dirty}>保存商品排序</Button>{error && <p className="admin-error" role="alert">{error}</p>}</div></>
}

export function ProductAdminPage({ revision, onUpdated, onPlans }: { revision: number; onUpdated: () => void; onPlans: () => void }) {
  const products = useResource<List<Product>>('/api/admin/direct-store/products', revision)
  const categories = useResource<List<Category>>('/api/admin/direct-store/categories', revision)
  return <section className="admin-panel"><div className="admin-panel-title"><h2>现有商品</h2><span>当前仅支持编辑已有商品</span></div><Feedback error={products.error || categories.error} loading={products.loading || categories.loading} data={products.data && categories.data} />{products.data?.products && categories.data?.categories && <ProductList key={`${products.data.orderVersion}:${products.data.products.map(item => item.version).join(':')}`} initial={{ products: products.data.products, orderVersion: products.data.orderVersion }} categories={categories.data.categories} onUpdated={onUpdated} onPlans={onPlans} />}</section>
}
