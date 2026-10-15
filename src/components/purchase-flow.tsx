import type { PaymentMethodOption } from './payment-method-choices'
import { emailProduct, productNameForId } from '../../shared/email-products'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ShieldCheck, X } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { CopyButton } from './copy-button'
import { Checkout, type CheckoutProps } from './checkout'
import { AfterSales, PurchaseEmail, RefundContent } from './order-services'
import { ProductMark } from './brand'
import { PurchaseNotice } from './purchase-notice'
import { OrderSupportButton } from './order-support-button'
import { OrderSupportGuideContext } from '@/lib/order-support-guide'
import { ORDER_PLANS, orderLabel, type PlanId } from '@/lib/demo-orders'
import '@/styles/purchase-flow.css'

// Keep the popup and its focus scope mounted while only the step content changes.
function FlowStage({ stage, children }: { stage: string; children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const previous = useRef(stage)
  useLayoutEffect(() => {
    const box = viewport.current!, inner = content.current!
    // Layout size excludes the popup's opening scale, avoiding a clipped first step.
    box.style.height = `${inner.offsetHeight}px`
    const observer = new ResizeObserver(() => { box.style.height = `${inner.offsetHeight}px` })
    observer.observe(inner)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (previous.current === stage) return
    previous.current = stage
    const popup = content.current?.closest<HTMLElement>('.flow-main')
    if (popup) popup.scrollTop = 0
    // A background order update must not steal focus from the after-sales form.
    if (!content.current?.closest('[data-sales-open="true"]')) content.current?.querySelector<HTMLElement>('[data-stage-title]')?.focus({ preventScroll: true })
    const preference = matchMedia('(prefers-reduced-motion: reduce)')
    if (preference.matches) return
    const animation = content.current?.animate([
      { opacity: 0, transform: 'translateY(8px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 260, easing: 'cubic-bezier(.22,1,.36,1)' })
    const stop = () => { if (preference.matches) animation?.cancel() }
    preference.addEventListener('change', stop)
    return () => { preference.removeEventListener('change', stop); animation?.cancel() }
  }, [stage])
  return <div ref={viewport} className="flow-viewport"><div ref={content} className="flow-stage">{children}</div></div>
}

type Props = CheckoutProps & { couponAvailable?: boolean; shopSlug?: string; onCloseComplete?: () => void; notice?: { supportsWarranty?: boolean; purchaseNote?: string; onContinue: () => void }; emailMode: boolean; paymentMethods?: PaymentMethodOption[]; draft: { plan: PlanId; price: number }; initialEmail?: string | null; onSubmitEmail: (email: string, username?: string, preflightToken?: string, paymentMethod?: string, expectedFeeBps?: number, turnstileToken?: string, couponCode?: string, couponPrice?: number) => Promise<void>; children?: ReactNode | ((refreshTarget: HTMLElement | null) => ReactNode) }
export function PurchaseFlow({ couponAvailable = false, shopSlug, notice, onCloseComplete, emailMode, paymentMethods, draft, initialEmail, onSubmitEmail, children, ...checkout }: Props) {
  const { order, open, onOpenChange, busy, error } = checkout
  const [refreshTarget, setRefreshTarget] = useState<HTMLDivElement | null>(null)
  const [supportReason, setSupportReason] = useState<string | null>(null)
  const [dismissedSupportReason, setDismissedSupportReason] = useState<string | null>(null)
  const showSupportGuide = useCallback((reason: string | null) => {
    setSupportReason(reason)
    if (!reason) setDismissedSupportReason(null)
  }, [])
  const emailRef = useRef<HTMLInputElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const showingNotice = Boolean(notice)
  const previousNotice = useRef(showingNotice)
  useLayoutEffect(() => {
    if (previousNotice.current && !showingNotice && open) {
      if (popupRef.current) popupRef.current.scrollTop = 0
      // Focus the heading, not the input: mobile keyboards must open on the user's tap.
      titleRef.current?.focus({ preventScroll: true })
    }
    previousNotice.current = showingNotice
  }, [showingNotice, open])
  const salesTitleRef = useRef<HTMLHeadingElement>(null)
  const salesTrigger = useRef<HTMLButtonElement | null>(null)
  const [salesHeight, setSalesHeight] = useState<{ orderId: string; height: number } | null>(null)
  const [salesOrder, setSalesOrder] = useState<string | null>(null)
  const [salesOpen, setSalesOpen] = useState(false)
  const [salesBusy, setSalesBusy] = useState(false)
  const [compact, setCompact] = useState(() => matchMedia('(max-width: 959px)').matches)
  const showingSales = salesOpen && salesOrder === order?.id && !emailMode
  useEffect(() => {
    const media = matchMedia('(max-width: 959px)')
    const update = () => setCompact(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (!showingSales) return
    const frame = requestAnimationFrame(() => salesTitleRef.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [showingSales])
  function openSales(trigger: HTMLButtonElement) {
    if (!order || busy) return
    // Preserve the visible order height through submission and returning from after-sales.
    // offsetHeight excludes the popup's opening scale; max-height still fits the viewport.
    if (popupRef.current && salesHeight?.orderId !== order.id) {
      setSalesHeight({ orderId: order.id, height: popupRef.current.offsetHeight })
    }
    salesTrigger.current = trigger
    setSalesOrder(order.id); setSalesOpen(true)
  }
  function closeSales() {
    if (salesBusy) return
    setSalesOpen(false)
    // Wait for React to remove inert from the order pane before restoring focus.
    requestAnimationFrame(() => salesTrigger.current?.focus({ preventScroll: true }))
  }
  const current = emailMode || !order ? draft : order
  const plan = ORDER_PLANS.find(p => p.id === current.plan)!
  const emailProductInfo = emailProduct(current.plan)
  const automaticDelivery = order?.delivery?.automatic || emailMode && ['gemini-pro-18m', 'duolingo-12m'].includes(current.plan)
  const xgift = plan.productId === 'x-premium'
  const sms = plan.productId === 'codex-sms'
  const manual = !emailMode && order?.manualFulfillment === true
  const paused = !emailMode && order && ((order.redemptionBlocked && order.status !== 'success') || order.refundHold || (order.refundedCents ?? 0) >= Math.round(order.price * 100))
  const reconnect = !sms && order?.mode === 'live' && order.fulfillment?.canSubmit
  const step = emailMode ? 0 : order?.status === 'pending' || order?.status === 'cancelled' ? 1 : order?.status === 'session' || (manual || xgift) && order?.status === 'processing' || reconnect || (!sms && order?.status === 'failed' && order.mode === 'demo') ? sms && order.smsPhone ? 3 : 2 : 3
  const completed = !emailMode && order?.status === 'success' && !paused
  const steps = [xgift ? '填写账号' : '下单邮箱', '确认付款', xgift ? '充值处理' : automaticDelivery ? '自动发货' : emailProductInfo ? '邮件发货' : sms ? '获取号码' : manual ? '人工开通' : '连接账号', xgift ? '查看结果' : automaticDelivery ? '领取商品' : emailProductInfo ? '查收邮件' : sms ? '查询结果' : '开通结果']
  const archived = !emailMode && order?.mode !== 'live' && !checkout.testingEnabled
  const result = !emailMode && (archived || !reconnect && ['processing', 'success', 'failed', 'cancelled'].includes(order?.status ?? '') || (sms && step === 2))
  const title = emailMode ? xgift ? '为哪个账号开通？' : '填写下单邮箱' : archived ? '订单已归档' : paused ? orderLabel(order!) : result ? orderLabel(order!) : step === 1 ? '确认本次付款' : step === 2 ? xgift ? '等待充值' : automaticDelivery ? '等待自动发货' : emailProductInfo ? '等待邮件发货' : manual ? '等待人工开通' : '连接你的账号' : '查询接码结果'
  const stage = emailMode ? 'email' : `${order?.id}-${order?.status}-${Boolean(order?.smsPhone)}-${Boolean(paused)}`
  const close = (value: boolean) => { if (busy || salesBusy) return; if (!value && showingSales) closeSales(); else onOpenChange(value) }
  return <OrderSupportGuideContext.Provider value={showSupportGuide}><Dialog open={open} disablePointerDismissal onOpenChange={close} onOpenChangeComplete={value => { if (!value) { setSalesOpen(false); setSalesOrder(null); setSalesHeight(null); setDismissedSupportReason(null); onCloseComplete?.() } }}>
    <DialogContent ref={popupRef} style={{ height: !emailMode && salesHeight?.orderId === order?.id ? salesHeight?.height : undefined }} className={showingNotice ? 'motion-dialog purchase-notice' : `motion-dialog purchase-flow${xgift ? ' x-purchase-flow' : ''}`} data-sales-open={showingSales} showCloseButton={showingNotice} initialFocus={titleRef}>
      {notice ? <PurchaseNotice plan={draft.plan} purchaseNote={notice.purchaseNote} supportsWarranty={notice.supportsWarranty} titleRef={titleRef} onCancel={() => close(false)} onContinue={notice.onContinue} /> : <>
      <header className="flow-ticket">
        <div className="flow-ticket-meta"><span className="flow-ticket-label">{emailMode && xgift ? '确认订单' : '订单编号'}</span>{!emailMode && order ? <span className="flow-order-id" title={order.id}>{order.id}</span> : !(emailMode && xgift) && <span className="flow-ticket-draft">待生成</span>}</div>
        <div className="flow-ticket-actions">{!emailMode && order && <CopyButton key={order.id} iconOnly variant="ghost" value={order.id} label="复制订单号" />}<Button className="flow-close" variant="ghost" size="icon-sm" aria-label={showingSales ? '收起售后，返回订单' : '关闭下单窗口'} disabled={busy || salesBusy} onClick={() => close(false)}><X size={17} /></Button></div>
      </header>
      <div className="flow-layout">
      <div className="flow-main" inert={salesBusy || showingSales && compact} aria-hidden={showingSales && compact || undefined}>
      <header className="flow-header">
        <div className="flow-product"><ProductMark small productId={plan.productId} /><div className="flow-product-main"><strong>{productNameForId(plan.productId)}</strong><p>{!emailMode && order ? order.planName : plan.name}{!xgift && <> · {emailProductInfo ? emailProductInfo.duration + ' · 邮件发货' : sms ? '1 次服务' : plan.renewalOnly ? '按月续费' : '按月订阅'}</>}</p></div><div className="flow-product-meta"><strong className="flow-price"><small>¥</small>{(!emailMode && order?.paymentSummary ? order.paymentSummary.amountCents / 100 : current.price).toFixed(2)}</strong><span className="flow-product-qty">数量 × 1</span></div></div>
        <DialogDescription className="sr-only">{xgift ? '填写用户名与邮箱，验证账号后付款。' : current.plan === 'gmail-account' ? '填写收件邮箱并确认付款，账号资料自动邮件发货。' : emailProductInfo ? '填写收件邮箱并确认付款，自动发货后可在订单页与邮箱领取。' : sms ? '填写邮箱，确认付款后获取手机号，再查询接码结果。' : manual ? '填写邮箱并确认付款，联系支持人工开通后查看结果。' : '填写邮箱并确认付款，连接账号后查看开通结果。'}</DialogDescription>
        <ol className="flow-steps" aria-label="下单进度">{steps.map((label, i) => <li key={label} data-state={i < step || completed ? 'done' : i === step ? 'current' : 'next'} aria-current={!completed && i === step ? 'step' : undefined}><span>{i < step || completed ? <Check size={12} /> : i + 1}</span><span>{label}</span></li>)}</ol>
      </header>
      <FlowStage stage={stage}>
        <DialogTitle ref={titleRef} tabIndex={-1} data-stage-title className={(xgift && !emailMode) || (result && !paused) || step === 1 ? 'sr-only' : 'flow-title'}>{title}</DialogTitle>
        {emailMode ? <PurchaseEmail couponAvailable={couponAvailable} shopSlug={shopSlug} purchasePlan={current.plan} price={current.price} key={`${shopSlug}:${current.plan}:${couponAvailable}`} paymentMethods={!checkout.testingEnabled && (xgift || emailProductInfo) ? paymentMethods ?? [] : undefined} plan={xgift ? current.plan : undefined} initialEmail={initialEmail} busy={Boolean(busy)} error={error ?? ''} inputRef={emailRef} onSubmit={onSubmitEmail} /> : typeof children === 'function' ? children(refreshTarget) : children ?? <Checkout key={order?.id} {...checkout} refreshTarget={refreshTarget} refreshDisabled={Boolean(busy) || salesBusy} />}
        <footer className="flow-footer" data-email-step={emailMode}>
          {emailMode ? <p><ShieldCheck size={14} />{xgift ? '仅用于订单通知与找回' : '用于商品交付、订单找回与服务联系，不订阅营销邮件。'}</p> : <>
            <OrderSupportButton key={order?.id} contacts={order?.supportContacts} name={order?.partnerName ?? '硅基生物'} disabled={busy || salesBusy || !order} guided={open && !showingSales && Boolean(supportReason) && supportReason !== dismissedSupportReason} onGuideDismiss={() => setDismissedSupportReason(supportReason)} />
            <div className="flow-footer-actions">
              <div ref={setRefreshTarget} className="flow-refresh-slot" />
              {order && <AfterSales testingEnabled={checkout.testingEnabled} order={order} onOpen={openSales} disabled={busy || salesBusy} expanded={showingSales} />}
            </div>
          </>}
        </footer>
      </FlowStage>
      </div>
      <aside id="purchase-refund-panel" className="flow-sales" inert={!showingSales} aria-hidden={!showingSales} aria-labelledby="purchase-refund-title" onTransitionEnd={event => { if (event.target === event.currentTarget && event.propertyName === 'opacity' && showingSales && !event.currentTarget.contains(document.activeElement)) salesTitleRef.current?.focus({ preventScroll: true }) }}>
        <div className="flow-sales-shell">
          <header className="flow-sales-header"><h2 id="purchase-refund-title" ref={salesTitleRef} tabIndex={-1}>订单售后</h2></header>
          {salesOrder === order?.id && order && <RefundContent testingEnabled={checkout.testingEnabled} key={order.id} order={order} onUpdated={checkout.onUpdated} onBusyChange={setSalesBusy} onBack={closeSales} />}
        </div>
      </aside>
      </div>
      </>}
    </DialogContent>
  </Dialog></OrderSupportGuideContext.Provider>
}
