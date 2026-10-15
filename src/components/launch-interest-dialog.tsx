import { useStorefrontI18n } from '@/lib/storefront-i18n'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Checkbox } from '@base-ui/react/checkbox'
import { Bell, Check, LoaderCircle, Mail } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { ProductMark } from './brand'

export type InterestProduct = { id: 'claude' | 'grok' | 'gmail'; name: string }
type Receipt = { token: string; confirmed: boolean }
const receiptKey = (product: string) => `ymx-interest-${product}`
function readReceipt(product: string): Receipt | null {
  try {
    const value = JSON.parse(localStorage.getItem(receiptKey(product)) ?? 'null')
    return value && /^[a-f0-9]{64}$/.test(value.token) && typeof value.confirmed === 'boolean' ? value : null
  } catch { return null }
}
async function post(path: string, body: unknown) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) })
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('登记服务暂时不可用，请稍后重试。')
  const data = await response.json()
  if (!response.ok) throw new Error(data.error ?? '操作未完成，请稍后重试。')
  return data as { manageable?: boolean }
}

export function LaunchInterestDialog({ product, open, onOpenChange }: { product: InterestProduct; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useStorefrontI18n()
  const titleRef = useRef<HTMLHeadingElement>(null)
  const [receipt, setReceipt] = useState(() => readReceipt(product.id))
  const [email, setEmail] = useState('')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<'received' | 'cancelled' | null>(null)
  const [storageWarning, setStorageWarning] = useState(false)
  useEffect(() => { if (open && (result || error)) titleRef.current?.focus() }, [open, result, error])
  const save = (next: Receipt | null) => {
    setReceipt(next)
    try {
      if (next) localStorage.setItem(receiptKey(product.id), JSON.stringify(next))
      else localStorage.removeItem(receiptKey(product.id))
    } catch { setStorageWarning(true) }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || !consent) return
    setBusy(true); setError('')
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
    // Save the cancellation capability before the request: a lost response can
    // still be safely cancelled. No email address is persisted in this browser.
    save({ token, confirmed: false })
    try {
      const data = await post('/api/interest', { email, product: product.id, consent, token })
      save(data.manageable ? { token, confirmed: true } : null)
      setResult('received'); setEmail('')
    } catch (cause) { setError(cause instanceof Error && cause.name !== 'TimeoutError' && cause.name !== 'TypeError' ? cause.message : '连接未完成，登记结果尚未确认。请取消本次登记后重试。') }
    finally { setBusy(false) }
  }
  const cancel = async () => {
    if (!receipt || busy) return
    setBusy(true); setError('')
    try {
      await post('/api/interest/cancel', { token: receipt.token })
      save(null); setResult('cancelled'); setConsent(false)
    } catch (cause) { setError(cause instanceof Error && cause.name !== 'TimeoutError' && cause.name !== 'TypeError' ? cause.message : '取消未完成，请检查网络后重试。') }
    finally { setBusy(false) }
  }
  const registered = result === 'received' || receipt?.confirmed
  return <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next) }}>
    <DialogContent className="interest-dialog motion-dialog" initialFocus={titleRef} showCloseButton={!busy} aria-busy={busy}>
      <ProductMark productId={product.id} />
      <DialogHeader>
        <DialogTitle ref={titleRef} tabIndex={-1}>{registered ? t('已记下你的期待') : result === 'cancelled' ? t('登记已取消') : t('{product} 上线提醒', { product: product.name })}</DialogTitle>
        <DialogDescription>{registered ? t('{product} · 登记请求已处理，相同邮箱不会重复登记。', { product: product.name }) : t(result === 'cancelled' ? '本次登记已移除。你可以随时重新登记。' : '留下邮箱，等套餐与价格公布时再决定。')}</DialogDescription>
      </DialogHeader>
      <p className="interest-delivery-note"><Bell size={16} /><span>{t('目前仅登记意向，提醒邮件尚未启用。')}</span></p>
      {registered ? <div className="interest-result" role="status"><span className="interest-check"><Check size={23} /></span><p>{t('无需付款，也不会生成订单。')}</p>{receipt && <p className="interest-hint">{t('保留当前浏览器记录，即可回来取消登记。')}</p>}</div> : receipt ? <p className="interest-hint" role="status">{t(busy ? '正在处理，请稍候…' : '上次提交结果尚未确认。请先取消可能已保存的登记，再重新提交。')}</p> : <form className="interest-form" onSubmit={submit}>
        <label htmlFor="interest-email">{t('邮箱地址')}</label>
        <div className="interest-email-field"><Mail size={17} /><Input id="interest-email" type="email" autoComplete="email" inputMode="email" placeholder="you@example.com" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} disabled={busy} aria-describedby="interest-privacy" /></div>
        <label className="interest-consent"><Checkbox.Root className="interest-checkbox" checked={consent} onCheckedChange={setConsent} required disabled={busy} aria-label={t('同意接收 {product} 上线通知', { product: product.name })}><Checkbox.Indicator><Check size={13} /></Checkbox.Indicator></Checkbox.Root><span id="interest-privacy">{t('同意硅基生物保存我的邮箱，仅用于 {product} 上线通知，不发送其他营销邮件。', { product: product.name })}</span></label>
        <Button type="submit" className="interest-submit" disabled={busy || !consent}>{busy ? <LoaderCircle className="interest-spinner" size={16} /> : <Bell size={16} />}{t(busy ? '正在登记…' : '登记上线提醒')}</Button>
      </form>}
      {error && <p className="interest-error" role="alert">{t(error)}</p>}
      {storageWarning && <p className="interest-error" role="alert">{t('浏览器未能保存取消凭据，请在关闭弹窗前取消本次登记。')}</p>}
      {(registered || receipt) && <div className="interest-result-actions"><Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>{t('知道了')}</Button>{receipt && <Button variant="ghost" onClick={cancel} disabled={busy}>{t(busy ? '处理中…' : '取消登记')}</Button>}</div>}
    </DialogContent>
  </Dialog>
}
