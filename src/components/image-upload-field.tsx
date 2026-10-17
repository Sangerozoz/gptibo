import { useRef } from 'react'
import { ImagePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import './image-upload-field.css'

export function ImageUploadField({ name, url, busy = false, readOnly = false, onUpload, onRemove }: { name: string; url?: string | null; busy?: boolean; readOnly?: boolean; onUpload: (file: File) => void; onRemove?: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  return <div className="image-upload-field">
    <div className="image-upload-preview">{url ? <img src={url} alt={`${name}预览`} /> : <span><ImagePlus size={20} /><small>未上传图片</small></span>}</div>
    {!readOnly && <div className="image-upload-actions">
      <div className="image-upload-buttons">
        <Button type="button" variant="outline" disabled={busy} onClick={() => input.current?.click()}>{busy ? '上传中…' : '上传图片'}</Button>
        {url && onRemove && <Button type="button" variant="ghost" disabled={busy} onClick={onRemove}>移除</Button>}
      </div>
      <small className="image-upload-hint">上传 PNG/JPG</small>
      <input ref={input} type="file" accept="image/png,image/jpeg" aria-label={`选择${name}图片`} hidden disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onUpload(file) }} />
    </div>}
  </div>
}
