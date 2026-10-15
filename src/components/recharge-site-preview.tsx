import { useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, LifeBuoy, Moon, MousePointer2, RefreshCw, Sun } from 'lucide-react'
import { BrandMark } from './brand'
import { Button } from './ui/button'
import { PurchaseWorkspace } from './purchase-workspace'
import { PurchaseFlow } from './purchase-flow'
import { PaymentCard } from './payment-card'
import { PaymentConfirmed, RequestNotice } from './payment-feedback'
import { LiveSessionForm, LiveRechargeProcessing, LiveRechargeSuccess } from './live-recharge-content'
import { guideSession } from './recharge-guide-session'
import { toString as qrToString } from 'qrcode'
import type { ServerOrder } from '@/lib/use-store'
import { PRODUCTS, productPlans } from '@/lib/products'
import type { CatalogPlan } from '@/lib/api'
import '@/App.css'
import '@/styles/motion.css'
import '@/styles/catalog-conversion.css'
import '@/styles/recharge-guide.css'

const noop = () => {}

// This isolated, inert animation frame renders the same components as the shop.
// It never initializes a customer session or calls order/payment APIs.
export function RechargeSitePreview() {
  const [scene, setScene] = useState<{ offers: CatalogPlan[]; phase: number; dark: boolean; reduced: boolean; view: 'package' | 'payment' | 'session' | 'result'; running: boolean }>({ offers: [], phase: 0, dark: false, reduced: false, view: 'package', running: false })
  const [cursor, setCursor] = useState({ x: 0, y: 0 })
  const [qrImage, setQrImage] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    // This code contains plain walkthrough text, never a payment destination.
    void qrToString('RECHARGE-RECHARGE-GUIDE', { type: 'svg', width: 156, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#171719', light: '#ffffff' } }).then(svg => {
      if (active) setQrImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
    })
    return () => { active = false }
  }, [])
  useEffect(() => {
    const sceneOrigin = window.parent.location.origin
    const receive = (event: MessageEvent) => {
      if (event.origin !== sceneOrigin || event.source !== window.parent || event.data?.type !== 'recharge-guide/site-scene') return
      const data = event.data
      if (!Array.isArray(data.offers) || !Number.isInteger(data.phase) || data.phase < 0 || data.phase > 4) return
      if (!['package', 'payment', 'session', 'result'].includes(data.view)) return
      setScene({ offers: data.offers, phase: data.phase, dark: data.dark === true, reduced: data.reduced === true, view: data.view, running: data.running === true })
    }
    window.addEventListener('message', receive)
    window.parent.postMessage({ type: 'recharge-guide/site-ready' }, sceneOrigin)
    return () => window.removeEventListener('message', receive)
  }, [])
  const product = PRODUCTS[0]
  const plans = productPlans('chatgpt').map(plan => ({ ...plan, price: (scene.offers.find(offer => offer.id === plan.id)?.price_cents ?? plan.price * 100) / 100, enabled: Boolean(scene.offers.find(offer => offer.id === plan.id)?.enabled ?? true) }))
  const selected = scene.view === 'package' && scene.phase < 2 && !scene.reduced ? 'pro-5x' : 'plus'
  const plan = plans.find(plan => plan.id === selected)!
  const payment = scene.view === 'payment'
  const connecting = scene.view === 'session' || payment && scene.phase >= 3
  const result = scene.view === 'result'
  const success = result && scene.phase >= 1
  const submitting = scene.view === 'session' && scene.phase >= 3
  const session = scene.view === 'session' && scene.phase >= 1 && !submitting ? guideSession : ''
  const confirmed = scene.view === 'session' && scene.phase === 2
  const emailMode = scene.view === 'package' || payment && scene.phase === 0
  const order: ServerOrder = {
    id: 'YMX-00000000', plan: 'plus', planName: 'Plus', price: plans[0].price, createdAt: 1790726400000, updatedAt: 1790726400000, version: 0, mode: 'live',
    status: success ? 'success' : result ? 'processing' : connecting ? 'session' : 'pending', paymentStatus: connecting || result ? 'paid' : 'unpaid',
    fulfillment: { paymentUrl: null, expiresAt: null, rechargeStatus: success ? 'success' : result ? 'processing' : null, retryKey: null, retryMode: null, canSubmit: connecting, message: null, accountEmailMasked: connecting || result ? 'a***@example.com' : null, finishedAt: success ? 1790726520000 : null },
  }
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', scene.dark)
    document.documentElement.style.colorScheme = scene.dark ? 'dark' : 'light'
  }, [scene.dark])
  useLayoutEffect(() => { document.documentElement.dataset.guideRunning = String(scene.running) }, [scene.running])
  useEffect(() => {
    if (scene.view !== 'package') {
      if (scene.view !== 'session') return
      const frame = requestAnimationFrame(() => {
        const target = document.querySelector(scene.phase >= 2 ? '.live-session-form .primary-action' : '#live-session')
        target?.scrollIntoView({ block: 'nearest', behavior: scene.reduced ? 'instant' : 'smooth' })
      })
      return () => cancelAnimationFrame(frame)
    }
    const frame = requestAnimationFrame(() => {
      const target = scene.phase >= 3 ? document.querySelector('.summary-cta') : scene.phase >= 1 || scene.reduced ? document.querySelector('.plan-options') : null
      if (target) target.scrollIntoView({ block: 'center', behavior: scene.reduced ? 'instant' : 'smooth' })
      else window.scrollTo({ top: 0, behavior: 'instant' })
    })
    return () => cancelAnimationFrame(frame)
  }, [scene.phase, scene.reduced, scene.view])
  useEffect(() => {
    const position = () => {
      const target = document.querySelector(scene.view === 'session' ? scene.phase >= 3 ? '.live-session-form .primary-action' : scene.phase === 2 ? '.live-account-confirmation [data-slot="checkbox"]' : '#live-session' : payment ? '.purchase-email-form .primary-action' : scene.phase === 4 ? '#purchase-email' : scene.phase >= 3 ? '.summary-cta' : '.plan-option')
      if (!target) return
      const rect = target.getBoundingClientRect()
      setCursor({ x: rect.left + rect.width * (scene.view === 'session' && scene.phase === 2 ? .5 : .7), y: rect.top + rect.height * .5 })
    }
    position()
    const timer = window.setTimeout(position, 500)
    window.addEventListener('scroll', position, { passive: true, capture: true })
    return () => { window.clearTimeout(timer); window.removeEventListener('scroll', position, true) }
  }, [scene.phase, scene.view, payment])
  return <>
    <header className="site-header"><div className="header-inner"><button className="brand" aria-label="硅基生物 首页"><BrandMark /><span>硅基生物</span></button><nav aria-label="主导航"><button className="nav-link selected">全部商品</button><button className="nav-link">我的订单</button><button className="nav-link help-nav">帮助中心</button></nav><div className="header-actions"><Button variant="ghost" size="icon" className="theme-button">{scene.dark ? <Sun size={18} /> : <Moon size={18} />}</Button><span className="header-divider" /><Button variant="ghost" className="support-button"><LifeBuoy /><span>联系支持</span></Button></div></div></header>
    <main><section className="detail-intro page-width"><nav className="product-breadcrumb"><a href="/">全部商品</a><ChevronRight size={13} /><span>ChatGPT</span></nav><h1>ChatGPT</h1><p>{product.tagline}</p></section>
      <PurchaseWorkspace product={product} plans={plans} plan={plan} selected={selected} store={{ ready: true, busy: false, checkoutEnabled: true }} setSelected={noop} beginPurchase={noop} help={noop} onGuide={noop} />
    </main>
    <PurchaseFlow emailMode={emailMode} draft={{ plan: 'plus', price: plans[0].price }} initialEmail="you@example.com" onSubmitEmail={async () => {}} order={!emailMode ? order : undefined} open={scene.view !== 'package' || scene.phase === 4} onOpenChange={noop} onAction={noop} onOrders={noop} testingEnabled={false}>
      {refreshTarget => <div className="checkout-body live-checkout" aria-busy={submitting}>
        {connecting ? <><PaymentConfirmed>付款已确认，请连接要充值的账号。</PaymentConfirmed><LiveSessionForm session={session} confirmed={confirmed} touched={false} busy={submitting ? 'submit' : ''} onSessionChange={noop} onConfirmChange={noop} onTouch={noop} onSubmit={noop} /></>
          : result ? success ? <LiveRechargeSuccess accountEmailMasked={order.fulfillment!.accountEmailMasked} finishedAt={order.fulfillment!.finishedAt} onOrders={noop} /> : <LiveRechargeProcessing />
          : <div className="live-payment rg-payment-body" data-phase={scene.phase} data-reduced={scene.reduced}><PaymentCard qr="#" image={qrImage} remaining={14 * 60 + 58} price={plans[0].price} quantity={product.quantity} /><div className="rg-payment-status">{scene.phase === 2 && <RequestNotice label="正在核对付款结果，完成后自动继续。" />}</div></div>}
        {!success && refreshTarget && createPortal(<Button variant="ghost" className="flow-refresh-action" disabled={submitting}><RefreshCw size={13} />刷新进度</Button>, refreshTarget)}
      </div>}
    </PurchaseFlow>
    {!scene.reduced && (scene.view === 'session' || payment && scene.phase === 0 || scene.view === 'package' && scene.phase > 0 && scene.phase < 4) && <MousePointer2 key={`${scene.view}-${scene.phase}`} className={`rg-cursor rg-site-cursor${scene.view === 'session' && scene.phase >= 2 ? ' rg-site-click' : ''}`} size={25} style={{ left: cursor.x, top: cursor.y }} />}
    <div style={{ height: 32 }} />
  </>
}
