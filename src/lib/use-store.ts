import type { PaymentMethodOption } from '@/components/payment-method-choices'
import type { StorefrontProductId } from '../../shared/product-order'
import type { DeliverySummary } from '../../shared/email-products'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorMessage, RequestError, type CatalogPlan } from './api'
import type { DemoOrder, OrderAction, PlanId } from './demo-orders'
import { storefrontShopSlug } from './storefront-routing'
import type { SupportContacts } from '../../shared/support-contacts'
import type { AnnouncementSettings } from '../../shared/announcements'
import { readStoreResources } from './store-reads'
import type { DirectStore } from '../../shared/direct-store'

export type ServerOrder = DemoOrder & { supportsWarranty?: boolean; paymentSummary?: { amountCents: number; feeCents: number; feeBps: number; refundedFeeCents: number } | null; xgift?: { username: string; state: string; receipt: string | null; failureCode: string | null; message: string } | null; delivery?: DeliverySummary; purchaseNote?: string; manualFulfillment?: boolean; isTest?: boolean; version: number; mode: 'demo' | 'live'; paymentStatus: string; planName: string; partnerName?: string; settlementStatus?: 'pending' | 'paid' | null; partnerSource?: { id: string; slug: string; name: string; email: string; wechat: string; qq: string } | null; supportContacts?: SupportContacts; updatedAt: number; fulfillment?: { precheckRequired?: boolean; syncError?: boolean; financialHold?: boolean; paymentUrl: string | null; paymentQr?: string | null; paymentKind?: 'qr' | 'link' | null; expiresAt: number | null; paymentExpired?: boolean; rechargeStatus: string | null; failureCode?: string | null; errorCategory?: string | null; resultCode?: string | null; progressStage?: string | null; progressVersion?: number; progressUpdatedAt?: number | null; attemptNo?: number | null; retryKey: string | null; retryMode: 'session' | 'access_token' | null; canSubmit: boolean; message: string | null; accountEmailMasked: string | null; finishedAt: number | null } }
const shopSlug = storefrontShopSlug(location.pathname)
let clientReady: Promise<unknown> | undefined
function initializeClient() {
  return clientReady ??= api('/api/orders/client', {}).catch(e => { clientReady = undefined; throw e })
}
export function useStore(page: string) {
  const [orders, setOrders] = useState<ServerOrder[]>([])
  const [recoveryEmail, setRecoveryEmail] = useState<string | null>(null)
  const [hiddenProductIds, setHiddenProductIds] = useState<StorefrontProductId[]>([])
  const [productOrder, setProductOrder] = useState<StorefrontProductId[]>([])
  const [completedOrdersByProduct, setCompletedOrdersByProduct] = useState<Record<string, number>>({})
  const [catalog, setCatalog] = useState<CatalogPlan[]>([])
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodOption[]>([])
  const [checkoutEnabled, setCheckoutEnabled] = useState(false)
  const [testingEnabled, setTestingEnabled] = useState(false)
  const [partner, setPartner] = useState<{ name: string; slug: string; brandName?: string; logo?: string; pageTitle?: string; headline?: string; description?: string }>()
  const [directStore, setDirectStore] = useState<DirectStore>()
  const [catalogReady, setCatalogReady] = useState(false)
  const [supportContacts, setSupportContacts] = useState<SupportContacts>()
  const [announcement, setAnnouncement] = useState<AnnouncementSettings | null>(null)
  const [shopUnavailable, setShopUnavailable] = useState(false)
  const [ready, setReady] = useState(false)
  const [pollingClock, setPollingClock] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [pendingAction, setPendingAction] = useState<{ id: string; action: OrderAction }>()
  const [error, setError] = useState('')
  const mutation = useRef(false)
  const fetching = useRef<number | undefined>(undefined)
  const generation = useRef(0)
  const retryCreate = useRef<{ plan: PlanId; price: number; email: string; username?: string; couponCode?: string; key: string } | undefined>(undefined)
  const pollingPeriod = orders.some(o => o.mode === 'live' && ['pending','processing'].includes(o.status)) ? orders.some(o => o.mode === 'live' && ['pending','processing'].includes(o.status) && pollingClock - (o.startedAt ?? o.createdAt) < 120000) ? 5000 : 15000 : orders.some(o => o.status === 'processing') ? 1500 : page === 'orders' ? 15000 : 30000
  const refresh = useCallback(async (force = false) => {
    if (mutation.current || (fetching.current !== undefined && !force)) return
    if (force) generation.current++
    const current = generation.current; fetching.current = current
    try {
      const [list, offers] = await readStoreResources({
        initialize: initializeClient,
        orders: () => api<{ orders: ServerOrder[]; recoveryEmail: string | null }>('/api/orders'),
        catalog: () => api<{ completedOrdersByProduct?: Record<string, number>; plans: CatalogPlan[]; paymentMethods?: PaymentMethodOption[]; productOrder?: StorefrontProductId[]; hiddenProductIds?: StorefrontProductId[]; supportContacts: SupportContacts; announcement?: AnnouncementSettings | null; checkoutEnabled?: boolean; testingEnabled?: boolean; partner?: { name: string; slug: string; brandName?: string; logo?: string; pageTitle?: string; headline?: string; description?: string }; site?: DirectStore['site']; categories?: DirectStore['categories']; products?: DirectStore['products'] }>('/api/catalog' + (shopSlug ? '?partner=' + encodeURIComponent(shopSlug) : '')),
        onOrders: value => { if (generation.current === current) { setOrders(value.orders); setRecoveryEmail(value.recoveryEmail) } },
        onCatalog: value => { if (generation.current === current) { setCatalog(value.plans); setCompletedOrdersByProduct(value.completedOrdersByProduct ?? {}); setPaymentMethods(value.paymentMethods ?? []); setDirectStore(value.site && value.categories && value.products ? { site: value.site, categories: value.categories, products: value.products } : undefined); setProductOrder(value.products ? value.products.map(product => product.id as StorefrontProductId) : value.productOrder ?? []); setHiddenProductIds(value.products ? value.products.filter(product => !product.listed).map(product => product.id as StorefrontProductId) : value.hiddenProductIds ?? []); setSupportContacts(value.supportContacts); setAnnouncement(value.announcement ?? null); setCheckoutEnabled(value.checkoutEnabled === true); setTestingEnabled(value.testingEnabled === true); setPartner(value.partner); setCatalogReady(true); setShopUnavailable(false) } },
        onReady: () => { if (generation.current === current) setReady(true) },
      })
      if (generation.current === current) {
        setPollingClock(Date.now())
        if (offers.status === 'rejected') { setCompletedOrdersByProduct({}); setCheckoutEnabled(false); setReady(false); if (shopSlug && offers.reason instanceof RequestError && offers.reason.status === 404) setShopUnavailable(true) }
        if (list.status === 'fulfilled' && offers.status === 'fulfilled') { setReady(true); setError('') }
        else setError(errorMessage(list.status === 'rejected' ? list.reason : offers.status === 'rejected' ? offers.reason : undefined))
      }
    } catch (e) { if (generation.current === current) { setError(errorMessage(e)); if (shopSlug && e instanceof RequestError && e.status === 404) { setShopUnavailable(true); setReady(false) } } }
    finally { if (fetching.current === current) fetching.current = undefined }
  }, [])
  useEffect(() => {
    // Initial synchronization with the server; later refreshes follow visibility and polling.
    // eslint-disable-next-line react/set-state-in-effect
    void refresh()
    const timer = window.setInterval(() => { if (!document.hidden) void refresh() }, pollingPeriod)
    const visible = () => { if (!document.hidden) void refresh() }
    document.addEventListener('visibilitychange', visible)
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [refresh, pollingPeriod])
  const mutate = async (run: () => Promise<{ order: ServerOrder }>, operation?: { id: string; action: OrderAction }) => {
    if (mutation.current) return undefined
    mutation.current = true; generation.current++; setBusy(true); setPendingAction(operation); setError('')
    try {
      const { order } = await run()
      setOrders(previous => [order, ...previous.filter(item => item.id !== order.id)].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100))
      return order
    } catch (e) { setError(errorMessage(e)); return undefined }
    finally { mutation.current = false; setBusy(false); setPendingAction(undefined) }
  }
  const create = async (plan: PlanId, price: number, email: string, username?: string, preflightToken?: string, paymentMethod?: string, expectedFeeBps?: number, turnstileToken?: string, expectedSupportsWarranty = true, couponCode?: string) => {
    if (!ready) { setError('订单服务尚未就绪，请稍后重试。'); return }
    if (!checkoutEnabled) { setError('该服务暂未开放购买，请稍后再来。'); return }
    if (!retryCreate.current || retryCreate.current.plan !== plan || retryCreate.current.price !== price || retryCreate.current.email !== email || retryCreate.current.username !== username || retryCreate.current.couponCode !== couponCode) retryCreate.current = { plan, price, email, username, couponCode, key: crypto.randomUUID() }
    const attempt = retryCreate.current
    const result = await mutate(() => api('/api/orders', { couponCode, email, plan, username, preflightToken, paymentMethod, expectedFeeBps, turnstileToken, expectedSupportsWarranty, expectedPrice: Math.round(price * 100), key: attempt.key, partner: shopSlug }))
    if (result) retryCreate.current = undefined
    return result
  }
  const action = async (id: string, action: OrderAction) => {
    const order = orders.find(item => item.id === id)
    if (!order) return
    return mutate(() => api(`/api/orders/${id}/demo-actions`, { action, version: order.version }), { id, action })
  }
  const acceptOrder = (order: ServerOrder) => {
    generation.current++
    setOrders(previous => {
      const old = previous.find(item => item.id === order.id)
      return old && old.version > order.version ? previous : [order, ...previous.filter(item => item.id !== order.id)].sort((a,b) => b.createdAt-a.createdAt).slice(0,100)
    })
  }
  return { orders, recoveryEmail, catalog, completedOrdersByProduct, paymentMethods, productOrder, hiddenProductIds, checkoutEnabled, testingEnabled, partner, directStore, catalogReady, supportContacts, announcement, shopUnavailable, ready, busy, pendingAction, error, refresh, create, action, acceptOrder }
}
