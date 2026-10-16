import { useStorefrontI18n } from '@/lib/storefront-i18n'
import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { Check, Copy, LoaderCircle, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import '@/styles/interaction-polish.css'

type Props = Omit<ComponentProps<typeof Button>, 'onClick' | 'children'> & { value: string; label: string; iconOnly?: boolean; textOnly?: boolean }
export function CopyButton({ value, label, iconOnly, textOnly, size, ...props }: Props) {
  const { t } = useStorefrontI18n()
  const [result, setResult] = useState<{ value: string; status: 'pending' | 'copied' | 'error' }>()
  const locked = useRef(false)
  const status = result?.value === value ? result.status : undefined
  useEffect(() => {
    if (!result || result.status === 'pending') return
    const timer = setTimeout(() => setResult(undefined), 2200)
    return () => clearTimeout(timer)
  }, [result])
  async function copy() {
    if (locked.current) return
    locked.current = true
    setResult({ value, status: 'pending' })
    try { await navigator.clipboard.writeText(value); setResult({ value, status: 'copied' }) }
    catch { setResult({ value, status: 'error' }) }
    finally { locked.current = false }
  }
  const Icon = status === 'copied' ? Check : status === 'error' ? TriangleAlert : status === 'pending' ? LoaderCircle : Copy
  return <span className="copy-control" data-state={status}>
    <Button {...props} size={size ?? (iconOnly ? 'icon' : 'sm')} aria-label={iconOnly || textOnly ? status === 'copied' ? t('已复制') : label : undefined} disabled={props.disabled || status === 'pending'} onClick={() => void copy()}>
      {!textOnly && <Icon size={15} className={status === 'pending' ? 'processing-spinner' : undefined} />}
      {textOnly ? value : !iconOnly && <span className="copy-label"><span data-hidden={status === 'copied'} aria-hidden={status === 'copied'}>{label}</span><span data-hidden={status !== 'copied'} aria-hidden={status !== 'copied'}>{t('已复制')}</span></span>}
    </Button>
    <span className={status === 'error' || ((iconOnly || textOnly) && status === 'copied') ? 'copy-feedback' : 'sr-only'} role={status === 'error' ? 'alert' : 'status'}>{status === 'copied' ? t('已复制') : status === 'error' ? t('复制失败，请手动选取') : ''}</span>
  </span>
}
