import { useState, type FormEvent } from 'react'
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, GripVertical, Package, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api, errorMessage } from '@/lib/api'
import { useResource } from '@/lib/use-resource'
import { prepareProductImage } from '@/lib/prepare-product-image'
import { Feedback } from '@/components/workspace-loading'
import { ImageUploadField } from '@/components/image-upload-field'
import { ProductPlans } from './ProductPlans'
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

function ImageInput({ name, url, onUpload, onRemove, busy }: { name: string; url: string | null; onUpload: (file: File) => Promise<void>; onRemove: () => void; busy: boolean }) {
  const [error, setError] = useState('')
  async function changed(file: File) {
    setError('')
    try { await onUpload(file) } catch (cause) { setError(cause instanceof Error ? cause.message : '图片上传失败，请重试。') }
  }
  return <div>
    <ImageUploadField name={name} url={url} busy={busy} onUpload={file => void changed(file)} onRemove={onRemove} />
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
    <label className="direct-field-title">店铺 Logo</label><ImageInput name="店铺 Logo" url={logoUrl} onUpload={addLogo} onRemove={() => { setLogoMediaId(null); setLogoUrl(null) }} busy={busy} />
    <p className="admin-subtle">名称和 Logo 保存后会同步到前台。发件邮箱地址仍由服务器配置。</p>
    <Feedback error={error} />{notice && <p className="admin-success" role="status">{notice}</p>}
    <Button type="submit" disabled={busy || !nameZh.trim()}><Save size={15} />{busy ? '保存中…' : '保存店铺设置'}</Button>
  </form>
}

export function StoreSettingsPage({ revision, onUpdated }: { revision: number; onUpdated: () => void }) {
  const { data, error, loading } = useResource<Site>('/api/admin/direct-store/site', revision)
  return <section className="admin-panel"><div className="admin-panel-title"><h2>店铺名称与 Logo</h2></div><Feedback error={error} loading={loading} data={data} />{data && <SiteForm key={data.version} initial={data} onUpdated={onUpdated} />}</section>
}

function CategoryCreate({ onClose, onUpdated }: { onClose: () => void; onUpdated: () => void }) {
  const [nameZh, setNameZh] = useState('')
  const [nameEn, setNameEn] = useState('')
  const [active, setActive] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try { await api('/api/admin/direct-store/categories', { nameZh, nameEn, active }); onUpdated(); onClose() }
    catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="direct-category-dialog" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>新增分类</DialogTitle><DialogDescription>填写分类名称，并设置是否在前台显示。</DialogDescription></DialogHeader>
      <form className="direct-category-create-form" onSubmit={event => void create(event)}>
        <label>中文名称<Input autoFocus value={nameZh} onChange={event => setNameZh(event.target.value)} maxLength={32} required disabled={busy} /></label>
        <label>英文名称<Input value={nameEn} onChange={event => setNameEn(event.target.value)} maxLength={32} disabled={busy} /></label>
        <div className="direct-category-position"><span>排序位置</span><strong>默认最后一个</strong></div>
        <label className="direct-checkbox"><input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)} disabled={busy} />显示分类</label>
        {error && <p className="admin-error" role="alert">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy || !nameZh.trim()}>{busy ? '保存中…' : '保存'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

function move(ids: readonly string[], index: number, delta: number) {
  const next = [...ids], target = index + delta
  if (target < 0 || target >= next.length) return next
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

type CategoryDraft = Pick<Category, 'nameZh' | 'nameEn' | 'active'>

function SortableCategoryRow({ id, index, total, draft, busy, onEdit, onMove }: { id: string; index: number; total: number; draft: CategoryDraft; busy: boolean; onEdit: (id: string, change: Partial<CategoryDraft>) => void; onMove: (index: number, delta: number) => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: busy })
  return <div ref={setNodeRef} className="direct-admin-row direct-category-row" data-dragging={isDragging || undefined} style={{ transform: CSS.Translate.toString(transform), transition }}>
    <div className="direct-row-heading direct-category-heading">
      <button type="button" ref={setActivatorNodeRef} className="direct-drag-handle" title={`拖动排序 ${draft.nameZh}`} aria-label={`拖动排序 ${draft.nameZh}`} disabled={busy} {...attributes} {...listeners}><GripVertical size={16} /></button>
      <strong>{draft.nameZh || '未命名分类'}</strong>
      <div className="direct-move"><Button type="button" variant="outline" size="icon" aria-label={`上移 ${draft.nameZh}`} disabled={busy || index === 0} onClick={() => onMove(index, -1)}><ArrowUp size={14} /></Button><Button type="button" variant="outline" size="icon" aria-label={`下移 ${draft.nameZh}`} disabled={busy || index === total - 1} onClick={() => onMove(index, 1)}><ArrowDown size={14} /></Button></div>
    </div>
    <div className="direct-row-editor"><label>中文名称<Input value={draft.nameZh} onChange={event => onEdit(id, { nameZh: event.target.value })} maxLength={32} required disabled={busy} /></label><label>英文名称<Input value={draft.nameEn} onChange={event => onEdit(id, { nameEn: event.target.value })} maxLength={32} disabled={busy} /></label><label className="direct-checkbox"><input type="checkbox" checked={draft.active} onChange={event => onEdit(id, { active: event.target.checked })} disabled={busy} />显示分类</label></div>
  </div>
}

function CategoryList({ initial, onUpdated }: { initial: { categories: Category[]; orderVersion: number }; onUpdated: () => void }) {
  const [orderedIds, setOrderedIds] = useState(initial.categories.map(item => item.id))
  const ids = [...orderedIds, ...initial.categories.map(item => item.id).filter(id => !orderedIds.includes(id))]
  const [drafts, setDrafts] = useState<Record<string, Partial<Pick<Category, 'nameZh' | 'nameEn' | 'active'>>>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const draftFor = (id: string) => {
    const original = initial.categories.find(item => item.id === id)!
    return { nameZh: original.nameZh, nameEn: original.nameEn, active: original.active, ...drafts[id] }
  }
  const dirty = ids.some((id, index) => {
    const category = initial.categories[index]
    const original = initial.categories.find(item => item.id === id)!
    const draft = draftFor(id)
    return category?.id !== id || draft.nameZh !== original.nameZh || draft.nameEn !== original.nameEn || draft.active !== original.active
  })
  const valid = ids.every(id => draftFor(id).nameZh.trim())
  function edit(id: string, change: Partial<CategoryDraft>) {
    setDrafts(current => ({ ...current, [id]: { ...current[id], ...change } }))
  }
  function finishDrag({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return
    const from = ids.indexOf(String(active.id)), to = ids.indexOf(String(over.id))
    if (from >= 0 && to >= 0) setOrderedIds(arrayMove(ids, from, to))
  }
  async function save() {
    setBusy(true); setError('')
    try {
      await api('/api/admin/direct-store/categories/batch', { orderVersion: initial.orderVersion, categories: ids.map(id => ({ id, ...draftFor(id), version: initial.categories.find(item => item.id === id)!.version })) })
      onUpdated()
    }
    catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  return <>
    <p className="admin-panel-footnote">关闭“显示分类”后，前台分类筛选会隐藏；其中已上架商品仍显示在“全部商品”。可拖动排序柄或使用上下按钮调整位置，修改完成后统一保存。</p>
    <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragEnd={finishDrag}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="direct-admin-list">{ids.map((id, index) => <SortableCategoryRow key={id} id={id} index={index} total={ids.length} draft={draftFor(id)} busy={busy} onEdit={edit} onMove={(position, delta) => setOrderedIds(move(ids, position, delta))} />)}</div>
      </SortableContext>
    </DndContext>
    <div className="direct-list-actions"><Button type="button" onClick={() => void save()} disabled={busy || !dirty || !valid}>{busy ? '保存中…' : '保存分类'}</Button>{error && <p className="admin-error" role="alert">{error}</p>}</div>
  </>
}

export function CategoryAdminPage({ revision, onUpdated }: { revision: number; onUpdated: () => void }) {
  const { data, error, loading } = useResource<List<Category>>('/api/admin/direct-store/categories', revision)
  const [createOpen, setCreateOpen] = useState(false)
  return <section className="admin-panel"><div className="admin-panel-title"><h2>商品分类</h2><Button type="button" onClick={() => setCreateOpen(true)}>新增分类</Button></div><Feedback error={error} loading={loading} data={data} />{data?.categories && <CategoryList key={`${data.orderVersion}:${data.categories.map(item => item.version).join(':')}`} initial={{ categories: data.categories, orderVersion: data.orderVersion }} onUpdated={onUpdated} />}{createOpen && <CategoryCreate onClose={() => setCreateOpen(false)} onUpdated={onUpdated} />}</section>
}

function ProductEditor({ product, categories, onUpdated, onClose }: { product: Product; categories: Category[]; onUpdated: () => void; onClose: () => void }) {
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
    try { await api(`/api/admin/direct-store/products/${product.id}`, { nameZh, nameEn, descriptionZh, descriptionEn, categoryId, listed, imageMediaId, version: product.version }); onUpdated(); onClose() }
    catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  async function addImage(file: File) {
    setBusy(true)
    try { const result = await upload(file); setImageMediaId(result.id); setImageUrl(result.url) }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="direct-product-dialog" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>编辑商品信息 · {product.nameZh}</DialogTitle><DialogDescription>修改名称、简介、分类、图片和前台上架状态。</DialogDescription></DialogHeader>
      <form className="direct-admin-form direct-product-editor" onSubmit={event => void save(event)}>
        <div className="direct-admin-fields"><label>中文名称<Input value={nameZh} onChange={event => setNameZh(event.target.value)} maxLength={64} required disabled={busy} /></label><label>英文名称<Input value={nameEn} onChange={event => setNameEn(event.target.value)} maxLength={64} disabled={busy} /></label></div>
        <div className="direct-admin-fields"><label>中文简介<Input value={descriptionZh} onChange={event => setDescriptionZh(event.target.value)} maxLength={200} disabled={busy} /></label><label>英文简介<Input value={descriptionEn} onChange={event => setDescriptionEn(event.target.value)} maxLength={200} disabled={busy} /></label></div>
        <div className="direct-admin-fields"><label>所属分类<select value={categoryId} onChange={event => setCategoryId(event.target.value)} disabled={busy}>{categories.map(category => <option key={category.id} value={category.id}>{category.nameZh}{category.active ? '' : '（停用）'}</option>)}</select></label><label className="direct-checkbox"><input type="checkbox" checked={listed} onChange={event => setListed(event.target.checked)} disabled={busy} />前台上架</label></div>
        <label className="direct-field-title">商品图片</label><ImageInput name="商品" url={imageUrl} onUpload={addImage} onRemove={() => { setImageMediaId(null); setImageUrl(null) }} busy={busy} />
        <p className="admin-subtle">不上传图片时继续显示原有商品插画。</p>
        <Feedback error={error} />
        <DialogFooter><Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button><Button type="submit" disabled={busy || !nameZh.trim()}>{busy ? '保存中…' : '保存商品'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

function SortableProductRow({ item, categoryName, expanded, editing, busy, revision, partnerModeEnabled, categories, onExpand, onEdit, onUpdated, onCloseEditor }: { item: Product; categoryName: string; expanded: boolean; editing: boolean; busy: boolean; revision: number; partnerModeEnabled: boolean; categories: Category[]; onExpand: () => void; onEdit: () => void; onUpdated: () => void; onCloseEditor: () => void }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled: busy })
  return <div ref={setNodeRef} className="direct-admin-row direct-product-row" data-dragging={isDragging || undefined} style={{ transform: CSS.Translate.toString(transform), transition }}>
    <div className="direct-row-heading direct-product-heading">
      <button type="button" ref={setActivatorNodeRef} className="direct-drag-handle" title={`拖动排序 ${item.nameZh}`} aria-label={`拖动排序 ${item.nameZh}`} disabled={busy} {...attributes} {...listeners}><GripVertical size={16} /></button>
      <Package className="direct-product-icon" size={17} /><strong className="direct-product-name" title={item.nameZh}>{item.nameZh}</strong>
      <span className={`admin-pill direct-product-status ${item.listed ? 'available' : 'unavailable'}`}>{item.listed ? '已上架' : '已下架'}</span>
      <span className="direct-product-category" title={categoryName}>{categoryName}</span>
      <div className="direct-move">
        <Button variant="outline" size="icon" aria-label={`${expanded ? '收起' : '展开'} ${item.nameZh} 套餐与售价`} aria-expanded={expanded} onClick={onExpand}>{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</Button>
        <Button variant="outline" onClick={onEdit}>编辑</Button>
      </div>
    </div>
    {expanded && <div className="direct-product-details"><ProductPlans productId={item.id} productName={item.nameZh} listed={item.listed} revision={revision} onUpdated={onUpdated} partnerModeEnabled={partnerModeEnabled} /></div>}
    {editing && <ProductEditor key={item.version} product={item} categories={categories} onUpdated={onUpdated} onClose={onCloseEditor} />}
  </div>
}

function ProductList({ initial, categories, revision, onUpdated, partnerModeEnabled }: { initial: { products: Product[]; orderVersion: number }; categories: Category[]; revision: number; onUpdated: () => void; partnerModeEnabled: boolean }) {
  const [ids, setIds] = useState(initial.products.map(item => item.id))
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const dirty = ids.some((id, index) => initial.products[index]?.id !== id)
  function finishDrag({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return
    const from = ids.indexOf(String(active.id)), to = ids.indexOf(String(over.id))
    if (from >= 0 && to >= 0) setIds(arrayMove(ids, from, to))
  }
  async function saveOrder() {
    setBusy(true); setError('')
    try { await api('/api/admin/direct-store/products/order', { ids, version: initial.orderVersion }); onUpdated() }
    catch (cause) { setError(errorMessage(cause)) } finally { setBusy(false) }
  }
  return <>
    <p className="admin-panel-footnote">下架后，前台商品卡片和详情页将隐藏，新的直接购买会被拒绝；已有订单仍可处理。拖动商品左侧的排序柄调整位置后请保存排序。新增商品需先接入套餐、下单与交付流程。</p>
    <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[restrictToVerticalAxis]} onDragEnd={finishDrag}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="direct-admin-list">{ids.map(id => {
          const item = initial.products.find(product => product.id === id)!
          return <SortableProductRow key={id} item={item} categoryName={categories.find(category => category.id === item.categoryId)?.nameZh ?? item.categoryId} expanded={expanded === id} editing={editing === id} busy={busy} revision={revision} partnerModeEnabled={partnerModeEnabled} categories={categories} onExpand={() => setExpanded(expanded === id ? null : id)} onEdit={() => setEditing(id)} onUpdated={onUpdated} onCloseEditor={() => setEditing(null)} />
        })}</div>
      </SortableContext>
    </DndContext>
    <div className="direct-list-actions"><Button onClick={() => void saveOrder()} disabled={busy || !dirty}>保存商品排序</Button>{error && <p className="admin-error" role="alert">{error}</p>}</div>
  </>
}

export function ProductAdminPage({ revision, onUpdated, partnerModeEnabled }: { revision: number; onUpdated: () => void; partnerModeEnabled: boolean }) {
  const products = useResource<List<Product>>('/api/admin/direct-store/products', revision)
  const categories = useResource<List<Category>>('/api/admin/direct-store/categories', revision)
  return <section className="admin-panel"><div className="admin-panel-title"><h2>现有商品</h2><span>当前仅支持编辑已有商品</span></div><Feedback error={products.error || categories.error} loading={products.loading || categories.loading} data={products.data && categories.data} />{products.data?.products && categories.data?.categories && <ProductList key={products.data.orderVersion} initial={{ products: products.data.products, orderVersion: products.data.orderVersion }} categories={categories.data.categories} revision={revision} onUpdated={onUpdated} partnerModeEnabled={partnerModeEnabled} />}</section>
}
