import { Popover } from '@base-ui/react/popover'
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { ArrowRight, Headset, Info, Mail, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CopyButton } from './copy-button'
import type { SupportContacts } from '../../shared/support-contacts'
import './order-support-button.css'

function WeChatIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z" />
    </svg>
  )
}

function QQIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673" />
    </svg>
  )
}

export function OrderSupportButton({
  contacts,
  name,
  disabled,
  guided = false,
  onGuideDismiss,
}: {
  contacts?: SupportContacts
  name: string
  disabled?: boolean
  guided?: boolean
  onGuideDismiss?: () => void
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const guideId = useId()
  const [contactOpen, setContactOpen] = useState(false)
  const [compact, setCompact] = useState(() => matchMedia('(max-width: 1099px)').matches)
  useEffect(() => {
    const media = matchMedia('(max-width: 1099px)')
    const update = () => setCompact(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const guideAnchor = useCallback(() => ({
    contextElement: trigger.current ?? undefined,
    getBoundingClientRect: () => {
      const button = trigger.current?.getBoundingClientRect()
      const dialog = trigger.current?.closest('.purchase-flow')?.getBoundingClientRect()
      return new DOMRect(dialog?.left ?? button?.left ?? 0, button?.top ?? 0, 0, button?.height ?? 44)
    },
  }), [])
  useEffect(() => {
    if (!guided || disabled) return
    let frame = 0
    const reveal = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => trigger.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }))
    }
    // The checkout height animates after an error; reveal the footer as it settles.
    const observer = new ResizeObserver(reveal)
    for (const selector of ['.flow-viewport', '.flow-main']) {
      const container = trigger.current?.closest(selector)
      if (container) observer.observe(container)
    }
    window.addEventListener('resize', reveal)
    reveal()
    return () => { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('resize', reveal) }
  }, [guided, disabled])
  const channels = contacts ? [
    { key: 'wechat', label: '微信', value: contacts.wechat, qrUrl: contacts.wechatQrUrl, icon: WeChatIcon, isLink: false },
    { key: 'qq', label: 'QQ', value: contacts.qq, qrUrl: contacts.qqQrUrl, icon: QQIcon, isLink: false },
    { key: 'email', label: '邮箱', value: contacts.email, qrUrl: undefined, icon: Mail, isLink: true },
  ].filter(channel => channel.value || channel.qrUrl) : []

  return (
    <div className="order-support-anchor" data-guided={guided && !disabled || undefined}>
    <Popover.Root open={guided && !disabled} onOpenChange={value => { if (!value) onGuideDismiss?.() }}>
      <Popover.Portal>
        <Popover.Positioner anchor={guideAnchor} side="left" align="end" sideOffset={18} collisionPadding={16} className="order-support-guide-positioner" data-compact={compact}>
          <Popover.Popup className="order-support-guide" id={guideId} initialFocus={false} finalFocus={false}>
            <span className="order-support-guide-icon" aria-hidden="true"><Headset size={20} /></span>
            <div className="order-support-guide-copy">
              <Popover.Title>客服可以帮你处理</Popover.Title>
              <Popover.Description>{compact ? '遇到充值问题，先让客服帮你核对。' : '点击右侧的「联系客服」，帮你核对充值问题。'}</Popover.Description>
              {compact && <button type="button" className="order-support-guide-action" onClick={() => { setContactOpen(true); onGuideDismiss?.() }}>查看客服 <ArrowRight size={14} /></button>}
            </div>
            <Popover.Close className="order-support-guide-close" aria-label="关闭客服引导"><X size={14} /></Popover.Close>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
    <Popover.Root open={contactOpen} onOpenChange={value => { setContactOpen(value); if (value) onGuideDismiss?.() }}>
      <Popover.Trigger
        ref={trigger}
        aria-describedby={guided && !disabled ? guideId : undefined}
        openOnHover
        delay={150}
        closeDelay={200}
        disabled={disabled}
        render={<Button variant="ghost" className="order-support-trigger" />}
      >
        <Headset size={15} aria-hidden="true" />
        <span>联系客服</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align="start"
          sideOffset={10}
          collisionPadding={16}
          className="order-support-positioner"
        >
          <Popover.Popup
            className="order-support-popup"
            initialFocus={interaction => interaction === 'keyboard'}
            finalFocus={interaction => interaction === 'keyboard'}
          >
            <header className="order-support-heading">
              <div className="order-support-avatar">
                <Headset size={18} />
              </div>
              <div className="order-support-meta">
                <div className="order-support-meta-top">
                  <Popover.Title className="order-support-title">联系客户服务</Popover.Title>
                  <span className="order-support-badge">联系方式</span>
                </div>
                <Popover.Description className="order-support-desc">
                  {name || '硅基生物'}
                </Popover.Description>
              </div>
            </header>

            {channels.length ? (
              <div className="order-support-channels" role="list">
                {channels.map((channel, index) => {
                  const Icon = channel.icon
                  return (
                    <div
                      className="order-support-channel-card"
                      key={channel.key}
                      style={{ '--item-index': index } as CSSProperties}
                      role="listitem"
                    >
                      <div className={`order-support-channel-badge order-support-channel-badge--${channel.key}`}>
                        <Icon size={16} />
                      </div>
                      <div className="order-support-channel-info">
                        <span className="order-support-channel-label">{channel.label}</span>
                        {channel.value && (channel.isLink ? (
                          <a
                            href={'mailto:' + encodeURIComponent(channel.value)}
                            className="order-support-channel-value order-support-channel-link"
                            title={channel.value}
                          >
                            {channel.value}
                          </a>
                        ) : (
                          <span className="order-support-channel-value" title={channel.value}>
                            {channel.value}
                          </span>
                        ))}
                      </div>
                      {channel.value && <CopyButton
                        variant="ghost"
                        size="icon-sm"
                        iconOnly
                        label={'复制' + channel.label}
                        title={'复制' + channel.label}
                        value={channel.value}
                      />}
                      {channel.qrUrl && <a className="order-support-channel-qr" href={channel.qrUrl} target="_blank" rel="noopener noreferrer" aria-label={'打开' + channel.label + '二维码'}><img src={channel.qrUrl} alt={channel.label + '二维码'} width="152" height="152" /></a>}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="order-support-empty">
                <Info size={15} className="order-support-empty-icon" />
                <p>
                  {contacts
                    ? '该商店暂未提供联系方式，可在原订单查看进度或申请售后。'
                    : '正在读取本订单的联系方式…'}
                </p>
              </div>
            )}

            <footer className="order-support-footer">
              <div className="order-support-tip">
                <Info size={13} className="order-support-tip-icon" aria-hidden="true" />
                <span>咨询时请提供订单号，客服处理更快捷</span>
              </div>
            </footer>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
    </div>
  )
}
