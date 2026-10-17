import { prepareLogo } from '@/lib/prepare-logo'
import { useEffect, useState } from 'react'
import { Check, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, errorMessage } from '@/lib/api'
import { useResource } from '@/lib/use-resource'
import { ShopBrand } from '@/components/shop-brand'
import { ImageUploadField } from '@/components/image-upload-field'
import './branding-settings.css'

type Branding = { name: string; logo: string; version: number; pageTitle?: string; headline?: string; description?: string }


function BrandingForm({ value, endpoint, readOnly, loading, onSaved }: { value: Branding; endpoint: string; readOnly: boolean; loading: boolean; onSaved: () => void }) {
  const [name, setName] = useState(value.name)
  const [copy, setCopy] = useState({ pageTitle: value.pageTitle ?? '', headline: value.headline ?? '', description: value.description ?? '' })
  const [logo, setLogo] = useState(value.logo)
  const [busy, setBusy] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState('')
  const locked = busy || processing || loading || readOnly
  const dirty = name !== value.name || logo !== value.logo || Object.entries(copy).some(([key, text]) => text !== (value[key as keyof typeof copy] ?? ''))
  const invalidCopy = Array.from(copy.pageTitle.trim()).length > 80 || Array.from(copy.headline.trim()).length > 80 || Array.from(copy.description.trim()).length > 200
  async function upload(file: File) {
    setProcessing(true); setError('')
    try {
      const prepared = await prepareLogo(file)
      const uploaded = await api<{ logo: string }>(endpoint + '/logo', { logo: prepared })
      setLogo(uploaded.logo)
    } catch (e) { setError(e instanceof Error ? e.message : '无法读取图片，请重新选择。') } finally { setProcessing(false) }
  }
  async function save() {
    if (locked || !dirty || invalidCopy) return
    setBusy(true); setError('')
    try { await api(endpoint, { name, logo, ...copy, version: value.version }); onSaved() } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  return <form className="branding-form" onSubmit={event => { event.preventDefault(); void save() }}>
    <div className="branding-fields">
      <label htmlFor="shop-brand-name">店铺名称 <span>{Array.from(name).length}/32</span></label>
      <Input id="shop-brand-name" value={name} onChange={event => setName(event.target.value)} placeholder="例如：星辰商店" maxLength={64} disabled={locked} aria-describedby="shop-name-help" />
      <p id="shop-name-help">显示在商店页头、页脚，未单独设置网页标题时也用于浏览器标签。留空显示“商店”。</p>
      {([{ key: 'pageTitle', label: '网页标题', max: 80, placeholder: name.trim() || '商店', help: '显示在浏览器标签和 HTML title，留空使用店铺名称。' }, { key: 'headline', label: '首页标题', max: 80, placeholder: '商店。找到适合你的服务。', help: '替换首页的“商店。找到适合你的服务。”，留空使用默认文案。' }, { key: 'description', label: '首页简介 / 网页描述', max: 200, placeholder: 'AI 订阅、语言学习与工具服务，在这里按需选择。', help: '同时用于首页简介和 HTML description，留空使用不含平台品牌的默认描述。' }] as const).map(field => <div className="branding-copy-field" key={field.key}><label htmlFor={'shop-' + field.key}>{field.label}<span>{Array.from(copy[field.key]).length}/{field.max}</span></label><Input id={'shop-' + field.key} value={copy[field.key]} onChange={event => setCopy(previous => ({ ...previous, [field.key]: event.target.value }))} placeholder={field.placeholder} maxLength={field.max * 2} disabled={locked} aria-describedby={'shop-' + field.key + '-help'} /><p id={'shop-' + field.key + '-help'}>{field.help}</p></div>)}
      <div className="branding-logo-label">店铺 Logo</div>
      <ImageUploadField name="店铺 Logo" url={logo} busy={locked} readOnly={readOnly} onUpload={file => void upload(file)} onRemove={() => setLogo('')} />
      {error && <p className="branding-error" role="alert">{error}</p>}
      {!readOnly && <div className="branding-save"><Button type="submit" disabled={locked || !dirty || invalidCopy || Array.from(name.trim()).length > 32}>{busy ? '保存中…' : '保存店铺形象'}</Button><span>{dirty ? '有未保存的更改' : '当前设置已保存'}</span></div>}
    </div>
    <aside className="branding-preview" aria-label="店铺形象预览"><span className="branding-preview-label">效果预览</span><div className="branding-preview-browser"><i /><i /><i /><span>{copy.pageTitle.trim() || name.trim() || '商店'}</span></div><div className="branding-preview-header brand"><ShopBrand name={name.trim()} logo={logo} /><span className="branding-preview-nav">全部商品</span></div><div className="branding-preview-body"><span>{copy.headline.trim() || '商店。找到适合你的服务。'}</span><p>{copy.description.trim() || 'AI 订阅、语言学习与工具服务，在这里按需选择。'}</p><div /><div /></div><p className="branding-preview-note">保存后，专属链接与自定义域名同步生效。</p></aside>
  </form>
}

export function BrandingSettings({ endpoint, revision, readOnly, onSummaryChange }: { endpoint: string; revision: number; readOnly: boolean; onSummaryChange?: (summary: string) => void }) {
  const [localRevision, setLocalRevision] = useState(0)
  const [saved, setSaved] = useState(false)
  const { data, error, loading } = useResource<Branding>(endpoint, revision + localRevision)
  useEffect(() => { onSummaryChange?.(error ? '读取失败，展开后重试' : data ? `${data.name || '商店'} · ${data.logo ? '已设置 Logo' : '默认 Logo'}` : '正在读取…') }, [data, error, onSummaryChange])
  return <section className="branding-settings"><div className="branding-heading"><div><h3>店铺形象</h3><p>用自己的名称和 Logo，让客户认出你的商店。</p></div><Button type="button" variant="ghost" size="icon" aria-label="刷新店铺形象" disabled={loading} onClick={() => { setSaved(false); setLocalRevision(v => v + 1) }}><RefreshCw size={15} /></Button></div>
    {error && <p className="branding-error" role="alert">{error}</p>}{!data && loading && <p role="status">正在读取店铺形象…</p>}
    {data && <BrandingForm key={endpoint + ':' + data.version} value={data} endpoint={endpoint} readOnly={readOnly} loading={loading} onSaved={() => { setSaved(true); setLocalRevision(v => v + 1) }} />}
    {saved && !loading && !error && <p className="branding-success" role="status"><Check size={14} />店铺形象已更新</p>}
  </section>
}
