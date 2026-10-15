import { useStorefrontI18n } from '@/lib/storefront-i18n'
import { useEffect, useState } from 'react'
import { ArrowRight, Check, ChevronRight, Clock3, CreditCard, FileKey2, LifeBuoy, Monitor, Moon, Search, ShieldCheck, Sparkles, Sun, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ProductMark } from '@/components/brand'
import { translateStorefront } from '@/lib/storefront-locale'
import { ShopBrand } from '@/components/shop-brand'
import { RecoveryDialog } from '@/components/order-services'
import { SupportContactsDialog } from '@/components/support-contacts'
import { StoreAnnouncement } from '@/components/announcement-dialog'
import { PurchaseFlow } from '@/components/purchase-flow'
import { ProductCatalog } from '@/components/product-catalog'
import { PurchaseWorkspace } from '@/components/purchase-workspace'
import { RechargeGuide } from '@/components/recharge-guide'
import { PRODUCTS, SMS_STEPS, productPlans, productForPlan, readPage } from '@/lib/products'
import { orderLabel, ORDER_PLANS, type OrderAction, type PlanId } from '@/lib/demo-orders'
import { applyAppearance } from '@/lib/appearance'
import { useScrollReveal } from '@/lib/use-scroll-reveal'
import { useStore } from '@/lib/use-store'
import { canonicalStorefrontUrl, storefrontHref } from '@/lib/storefront-routing'
import { trackVisitor } from '@/lib/visitor-tracking'
import { isClosedHomepage } from '@/components/site-closed'
import './App.css'
import './styles/motion.css'
import './styles/catalog-conversion.css'
import './styles/storefront-i18n.css'

const faq = [
  ['Pro 10× 可以新开吗？', '可以。Pro 10× 支持新开与续费，Pro 25× 也支持新开和自动充值。'],
  ['如何完成充值？', '选择套餐，填写下单邮箱并完成支付宝付款，再按订单指引连接账号。开通进度和结果可在「我的订单」查看。'],
  ['会更换我的 ChatGPT 账号吗？', '使用自己的账号开通或续费，无需购买共享账号。购买前请确认套餐适用范围。'],
  ['Session 是什么？', 'Session 是账号登录凭据。仅在订单的账号连接步骤按指引提交，请勿写入售后备注或发送给其他人。'],
  ['充值没有成功，该怎么办？', '先在「我的订单」查看进度，按提示处理或申请售后。请求超时不代表充值失败，请勿重复下单。'],
  ['套餐价格是多少？', 'Plus ¥139／月，Pro 5× ¥699／月，Pro 10× ¥1400／月，Pro 25× ¥4500／月。下单以所选商店的套餐价格和订单确认金额为准。'],
]
const smsFaq = [
  ['Codex 接码怎么购买？', '选择单次接码并完成付款，然后在订单中获取手机号、查询短信接收结果。平台售价为 ¥10／次，以订单确认金额为准。'],
  ['需要提交 Session 吗？', '不需要。接码与 ChatGPT 订阅是两种独立服务。'],
  ['没收到验证码怎么办？', '在原订单查询进度，避免重复付款。仍未收到时可申请售后，退款金额以审核结果为准。'],
  ['在哪里查看手机号和结果？', '手机号与接收结果均在原订单中查看。换设备后，可通过下单邮箱验证找回订单。'],
]
const generalFaq = [
  ['如何购买？', '选择服务，再进入详情页选择套餐。下单需填写可接收邮件的邮箱，服务开放情况以商品详情为准。'],
  ['目前有哪些商品？', 'ChatGPT 提供 Plus、Pro 5×、Pro 10×、Pro 25× 四档订阅，Gemini Pro 提供 18 个月会员，多邻国提供 1 年会员，两者通过邮件发货；Gmail 提供美国个人白号，付款后自动邮件发货；Codex 提供按次接码。Claude 与 Grok 待上架，可登记上线提醒。'],
  ['在哪里查看结果？', '通过「我的订单」查看进度或继续服务。订单保存在服务器，也可通过下单邮箱验证找回。'],
  ['退款如何处理？', '在原订单申请售后，平台审核后安排退款。未交付或交付失败可申请全额退款，已完成订单按实际情况审核。'],
]
function initialTheme() { try { return localStorage.getItem('ymx-theme') === 'dark' } catch { return false } }
function App() {
  const { locale, setLocale, t } = useStorefrontI18n()
  const [dark, setDark] = useState(initialTheme)
  const [page, setPage] = useState(readPage)
  const [emailOpen, setEmailOpen] = useState(false)
  const [purchaseNoticeOpen, setPurchaseNoticeOpen] = useState(false)
  const [acceptedPlan, setAcceptedPlan] = useState<PlanId | null>(null)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [selected, setSelected] = useState<PlanId>('plus')
  const store = useStore(page)
  const partnerSlug = store.partner?.slug
  const platformBrand = store.catalogReady && !store.partner
  const brandName = store.partner?.brandName || (platformBrand ? locale === 'en' ? 'MEGHAN' : '硅基生物' : t('商店'))
  const brandLogo = store.partner?.logo || ''
  const pageTitle = store.partner?.pageTitle
  const description = store.partner?.description || (platformBrand ? t('浏览 AI 订阅、学习会员、邮箱账号与工具服务。查看套餐、价格和交付方式，再决定是否下单。') : t('AI 订阅、语言学习与工具服务，在这里按需选择。'))
  useEffect(() => {
    document.querySelector('meta[name="description"]')?.setAttribute('content', description)
    document.title = pageTitle || (platformBrand ? translateStorefront(locale, '硅基生物 · 会员订阅与工具服务') : brandName)
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (icon) { icon.href = brandLogo || (platformBrand ? '/favicon.svg' : '/brands/shop.svg'); icon.type = brandLogo ? 'image/png' : 'image/svg+xml' }
  }, [brandName, platformBrand, brandLogo, locale, pageTitle, description])
  const { orders } = store
  const [activeId, setActiveId] = useState<string>()
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [supportOpen, setSupportOpen] = useState(false)
  const [noticeOpen, setNoticeOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const product = PRODUCTS.find(p => page === 'product/' + p.id) ?? PRODUCTS[0]
  const productHidden = store.hiddenProductIds.includes(product.id)
  const isDetail = page === 'product/' + product.id
  const plans = productPlans(product.id).map(p => { const offer = store.catalog.find(item => item.id === p.id); return { ...p, price: offer ? offer.price_cents / 100 : p.price, enabled: Boolean(offer?.enabled) } })
  const plan = plans.find(p => p.id === selected) ?? plans.find(p => p.id === product.defaultPlan)!
  const [purchaseDraft, setPurchaseDraft] = useState<{ plan: PlanId; price: number; purchaseNote?: string; supportsWarranty?: boolean }>(() => ({ plan: plan.id, price: plan.price }))
  const isGmail = product.id === 'gmail'
  const isEmailProduct = product.id === 'gemini' || product.id === 'duolingo' || isGmail
  const isXGift = product.id === 'x-premium'
  const isSms = product.id === 'codex-sms'
  const subscriptionFaq = faq.map(([question, answer]) => [question, question === '套餐价格是多少？' ? productPlans('chatgpt').map(p => `${p.name} ¥${(store.catalog.find(offer => offer.id === p.id)?.price_cents ?? p.price * 100) / 100}／月`).join('，') + '。下单以所选商店的套餐价格和订单确认金额为准。' : answer])
  const activeOrder = orders.find(o => o.id === activeId)
  useEffect(() => applyAppearance(dark), [dark])
  useScrollReveal(page)
  useEffect(() => {
    const normalize = () => {
      const canonical = canonicalStorefrontUrl()
      if (canonical !== null) history.replaceState(history.state, '', canonical)
    }
    normalize()
    const listener = () => { normalize(); setPage(readPage()) }
    window.addEventListener('hashchange', listener)
    window.addEventListener('popstate', listener)
    return () => { window.removeEventListener('hashchange', listener); window.removeEventListener('popstate', listener) }
  }, [])
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); if (!document.querySelector('[data-slot=dialog-content]')) document.getElementById('main-content')?.focus({ preventScroll: true }) }, [page])
  useEffect(() => {
    if (store.ready && !store.shopUnavailable && (!location.pathname.startsWith('/r/') && !location.pathname.startsWith('/s/') || partnerSlug)) trackVisitor(location.pathname)
  }, [page, store.ready, store.shopUnavailable, partnerSlug])
  const navigate = (next: string) => {
    const href = storefrontHref(next)
    if (isClosedHomepage(new URL(href, location.href))) { location.assign(href); return }
    if (location.pathname + location.search + location.hash !== href) history.pushState(history.state, '', href)
    setPage(next)
  }
  const help = () => { if (isDetail) document.getElementById('help')?.scrollIntoView({ behavior: 'auto' }); else setHelpOpen(true) }
  const openSupport = () => { setSupportOpen(true); void store.refresh(true) }
  const beginPurchase = () => { if (productHidden) return; setPurchaseDraft({ plan: plan.id, price: plan.price, purchaseNote: store.catalog.find(item => item.id === plan.id)?.purchase_note, supportsWarranty: store.catalog.find(item => item.id === plan.id)?.supports_warranty !== false }); setAcceptedPlan(null); setEmailOpen(true); setPurchaseNoticeOpen(true); setCheckoutOpen(true) }
  // Preserve the current step until the popup finishes its exit transition.
  const changeCheckoutOpen = (open: boolean) => { setCheckoutOpen(open) }
  const create = async (email: string, username?: string, preflightToken?: string, paymentMethod?: string, expectedFeeBps?: number, turnstileToken?: string, couponCode?: string, couponPrice?: number) => { if (acceptedPlan !== purchaseDraft.plan) { setPurchaseNoticeOpen(true); return } const order = await store.create(purchaseDraft.plan, couponPrice ?? purchaseDraft.price, email, username, preflightToken, paymentMethod, expectedFeeBps, turnstileToken, purchaseDraft.supportsWarranty, couponCode); if (order) { setEmailOpen(false); setActiveId(order.id); setCheckoutOpen(true) } }
  const onAction = (id: string, action: OrderAction) => { void store.action(id, action) }
  const filtered = orders.filter(o => o.id.toLowerCase().includes(query.toLowerCase().trim()) && (filter === 'all' || (filter === 'refund' ? Boolean(o.refundHold || o.refundedCents) : filter === 'active' ? ['pending', 'session', 'processing', 'failed'].includes(o.status) && (o.refundedCents ?? 0) < Math.round(o.price * 100) : o.status === 'success' && (o.refundedCents ?? 0) < Math.round(o.price * 100))))
  if (store.shopUnavailable) return <main className="empty-orders page-width"><div className="brand footer-brand"><ShopBrand name={t('商店')} /></div><h1>{t('这间商店暂不可用')}</h1><p>{t('推广链接可能有误，或代理已暂停服务。已有订单仍可在平台查询。')}</p><div className="unavailable-shop-links"><a href="/">{t('返回平台商店')}<ArrowRight size={15} /></a><a href="/orders">{t('查询已有订单')}<ArrowRight size={15} /></a></div></main>
  return <div className="store-layout">
    <a href="#main-content" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>{t('跳转至内容')}</a>
    <header className="site-header"><div className="header-inner">
      <button className="brand" onClick={() => navigate('store')} aria-label={brandName + (locale === 'en' ? ' home' : ' 首页')}><ShopBrand name={brandName} logo={brandLogo} platform={platformBrand} pending={!store.catalogReady && !store.error} /></button>
      <nav aria-label={t('主导航')}><button aria-current={page === 'store' || isDetail ? 'page' : undefined} className={page === 'store' || isDetail ? 'nav-link selected' : 'nav-link'} onClick={() => navigate('store')}>{t('全部商品')}</button><button aria-current={page === 'orders' ? 'page' : undefined} className={page === 'orders' ? 'nav-link selected' : 'nav-link'} onClick={() => navigate('orders')}>{t('我的订单')}{orders.length > 0 && <span className="nav-count">{orders.length}</span>}</button><button className="nav-link help-nav" onClick={help}>{t('帮助中心')}</button></nav>
      <div className="header-actions"><Button variant="ghost" className="language-button" lang={locale === 'en' ? 'zh-CN' : 'en'} aria-label={locale === 'en' ? '切换为简体中文' : 'Switch to English'} onClick={() => setLocale(locale === 'en' ? 'zh-CN' : 'en')}>{locale === 'en' ? '中文' : 'EN'}</Button><Button variant="ghost" size="icon" className="theme-button" aria-label={t(dark ? '切换亮色模式' : '切换暗色模式')} onClick={() => setDark(v => !v)}>{dark ? <Sun size={18} /> : <Moon size={18} />}</Button><span className="header-divider" /><Button variant="ghost" className="support-button" aria-label={t('联系支持')} aria-haspopup="dialog" aria-expanded={supportOpen} onClick={openSupport}><LifeBuoy data-icon="inline-start" /><span>{t('联系支持')}</span></Button></div>
    </div></header>
    <main id="main-content" tabIndex={-1}>
      {store.error && <div className="storage-warning" role="alert">{t(store.error)} <Button variant="ghost" onClick={() => void store.refresh()}>{t('重试')}</Button></div>}
      {page === 'store' ? <><section className={`store-intro page-width reveal-in${platformBrand ? ' store-intro-platform' : ''}`}>
        {platformBrand ? <>
          <div className="store-intro-main">
            <span className="store-intro-kicker">{t('数字服务商店')}</span>
            <h1>{t('数字服务，')}{locale === 'en' ? ' ' : null}<span>{t('选得明白。')}</span></h1>
            <p>{description}</p>
            <div className="store-intro-actions"><a className="store-intro-primary" href="#catalog-products">{t('浏览商品')}<ArrowRight size={16} /></a><Button variant="ghost" onClick={help}>{t('购买帮助')}<ChevronRight size={16} /></Button></div>
          </div>
        </> : <>
          <div><h1>{store.partner?.headline || <>{t('商店。')}<span>{t('找到适合你的服务。')}</span></>}</h1><p>{description}</p></div>
          <div className="store-intro-support"><span>{t('选购遇到问题？')}</span><Button variant="ghost" onClick={openSupport}>{t('联系支持')}<ArrowRight size={14} /></Button></div>
        </>}
        </section><ProductCatalog catalogReady={store.catalogReady} error={store.error} hiddenProductIds={store.hiddenProductIds} productOrder={store.productOrder} offers={store.catalog} onHelp={help} onOrders={() => navigate('orders')} onNavigate={navigate} /></> : isDetail && productHidden ? <section className="empty-orders page-width"><h1>{t('该商品已下架')}</h1><p>{t('商店暂不销售此商品，已有订单可在「我的订单」中继续处理。')}</p><Button onClick={() => navigate('store')}>{t('返回商店')}</Button></section> : isDetail ? <>
        <section className="detail-intro page-width reveal-in"><nav className="product-breadcrumb" aria-label="当前位置"><a href={storefrontHref('store')} onClick={event => { if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate('store') }}>全部商品</a><ChevronRight size={13} /><span aria-current="page">{product.name}</span></nav><h1>{product.name}</h1><p>{product.tagline}</p></section>
        <PurchaseWorkspace product={product} plans={plans} plan={plan} selected={selected} store={store} setSelected={setSelected} beginPurchase={beginPurchase} help={help} onGuide={() => document.getElementById('how-it-works')?.scrollIntoView({ behavior: 'auto' })} />
        {isXGift ? <section className="delivery-guide page-width" id="how-it-works" aria-label="充值流程">{[['01', '填写用户名', '输入 @ 用户名，验证账号。'], ['02', '确认账号并付款', '确认账号，通过支付宝付款。'], ['03', '等待到账', '自动处理，进度随时可查。']].map(([n, title, text]) => <article key={n}><small>{n} / 账号充值</small><h3>{title}</h3><p>{text}</p></article>)}</section> : isEmailProduct ? <section className="delivery-guide page-width" id="how-it-works" aria-label="邮件交付流程">{[['01', isGmail ? '选择账号并付款' : '选择会员并付款', '填写能够正常接收邮件的邮箱，核对购买说明后完成支付。'], ['02', isGmail ? '付款后自动发货' : '等待工作人员发货', product.method + '，发货状态会同步到原订单。'], ['03', isGmail ? '查收资料，登录账号' : '查看邮件，完成领取', isGmail ? '在购买当天按邮件说明首次登录，遇到问题及时通过原订单联系支持。' : '按邮件中的说明领取或兑换，遇到问题可通过原订单联系支持。']].map(([n, title, text]) => <article key={n}><small>{n} / 邮件交付</small><h3>{title}</h3><p>{text}</p></article>)}</section> : isSms ? <section data-scroll-reveal className="how-section page-width" id="how-it-works"><div className="section-heading"><span className="section-kicker">简单三步</span><h2>从选择，到开始。</h2><p>每一步都清楚，每个结果都可查。</p></div><div className="how-grid">{[
          { n: '01', icon: CreditCard, title: isSms ? SMS_STEPS[0] : '选择并付款', text: '选好适合自己的计划，通过支付宝完成订单付款。' },
          { n: '02', icon: FileKey2, title: isSms ? SMS_STEPS[1] : '连接你的账号', text: isSms ? '付款确认后，在订单中获取手机号，无需提交 Session。' : '付款确认后，按指引提交账号凭据，进入开通流程。' },
          { n: '03', icon: Sparkles, title: isSms ? SMS_STEPS[2] : '等待开通结果', text: isSms ? '获取手机号后点击查询结果，查看短信状态与验证码。' : '随时在订单页查看进度，开通后继续使用原来的账号。' },
        ].map(({ n, icon: Icon, title, text }) => <div className="how-step" key={n}><div className="how-step-top"><Icon size={22} strokeWidth={1.4} /><span>{n}</span></div><h3>{title}</h3><p>{text}</p></div>)}</div></section> : <RechargeGuide offers={store.catalog} />}
        <section data-scroll-reveal className="faq-section page-width" id="help"><div className="faq-heading"><span className="section-kicker">你可能想知道</span><h2>一些问题，<br />提前说清楚。</h2><button className="text-button" onClick={openSupport}>还有疑问？联系支持 <ArrowRight size={15} /></button></div><Accordion className="faq-list">{(isXGift ? [['需要提供密码吗？', '只需接收账号的 X 用户名，不需要密码或 Cookie。'], ['我的账号可以用吗？', '下单前会验证账号，以检测结果为准。'], ['付款后怎么查看结果？', '在原订单查看进度，处理完成后前往 X 核对到账；有疑问可联系支持。']] : isEmailProduct ? [['如何发货？', isGmail ? '付款确认后，账号资料与使用说明自动发送到下单邮箱，可在原订单查看发货进度。' : '付款后由工作人员处理，发货内容与领取说明发送到下单邮箱。发货进度可在原订单查看。'], ['需要提交账号密码吗？', isGmail ? '不需要提供账号密码或 Session。收到邮件后按资料登录，勿将账号或验证密钥转发给他人。' : '下单不需要提供账号密码或 Session。收到邮件后，按领取链接或兑换说明操作。'], ['没有收到邮件怎么办？', '请先确认订单是否已发货，再检查收件箱和垃圾邮件；仍未找到可通过原订单联系支持。']] : isSms ? smsFaq : subscriptionFaq).map(([q, a], i) => <AccordionItem key={q} value={`faq-${i}`}><AccordionTrigger>{q}</AccordionTrigger><AccordionContent>{a}</AccordionContent></AccordionItem>)}</Accordion></section>
      </> : page === 'orders' ? <section className="orders-page page-width reveal-in"><div className="orders-heading"><div><span className="section-kicker">YOUR ORDERS</span><h1>我的订单<span>每一步，都有记录。</span></h1></div><div className="orders-heading-actions"><Button variant="outline" onClick={() => setRecoveryOpen(true)}>邮箱找回订单</Button><Button variant="ghost" onClick={() => navigate('store')}>浏览商品 <ArrowRight size={15} /></Button></div></div><div className="orders-toolbar"><div className="order-filters" role="group" aria-label="筛选订单">{[['all', '全部订单'], ['active', '进行中'], ['success', '已完成'], ['refund', '退款 / 售后']].map(([value, label]) => <button key={value} aria-pressed={filter === value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div><div className="order-search"><Search size={16} /><Input aria-label="搜索订单号" placeholder="搜索订单号" value={query} onChange={e => setQuery(e.target.value)} />{query && <button onClick={() => setQuery('')} aria-label="清除搜索"><X size={14} /></button>}</div></div><div className="local-notice"><Monitor size={14} />{store.recoveryEmail ? `已验证 ${store.recoveryEmail} · 同时展示此浏览器与邮箱的最近 100 笔订单。` : '展示此浏览器最近 100 笔订单。换设备后，可通过下单邮箱验证找回。'}</div>{!store.ready ? <div className="empty-orders" role="status"><h2>正在连接订单服务</h2><p>读取服务器记录后显示订单。</p></div> : filtered.length ? <div className="order-list">{filtered.map(o => <button className="order-row" key={o.id} onClick={() => { setEmailOpen(false); setActiveId(o.id); setCheckoutOpen(true) }}><ProductMark small productId={productForPlan(o.plan).id} /><div className="order-row-main"><strong>{productForPlan(o.plan).name} {o.planName ?? ORDER_PLANS.find(p => p.id === o.plan)!.name}{ORDER_PLANS.find(p => p.id === o.plan)!.renewalOnly && ' · 续费'}<span>{productForPlan(o.plan).quantity}</span></strong><span>{o.id} <span className="order-date">· {new Date(o.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span></span></div><span className={`status-pill status-${o.status}`}><span />{o.mode === 'live' || store.testingEnabled ? orderLabel(o) : '已归档'}</span><strong className="order-row-price">¥{(o.paymentSummary ? o.paymentSummary.amountCents / 100 : o.price).toFixed(2)}</strong><ChevronRight size={17} /></button>)}</div> : <div className="empty-orders"><div className="empty-icon"><Search size={30} strokeWidth={1.2} /></div><h2>{orders.length ? '没有找到匹配的订单' : '还没有购买记录。'}</h2><p>{orders.length ? '试试其他订单号，或切换订单状态。' : '下单后，可在这里查看进度与服务结果。'}</p><Button onClick={() => { if (orders.length) { setQuery(''); setFilter('all') } else navigate('store') }}>{orders.length ? '查看全部订单' : '去看看商品'}<ArrowRight size={15} /></Button></div>}<div className="order-help"><Clock3 size={15} /><span>新订单可通过下单邮箱找回；未留邮箱的旧订单仍需保留原浏览器 Cookie。</span></div></section> : <section className="empty-orders page-width"><h1>未找到这个商品</h1><p>返回商品列表，查看当前可用的服务。</p><Button onClick={() => navigate('store')}>查看全部商品</Button></section>}
    </main>
    <footer className="site-footer page-width"><div className="footer-top"><div className="brand footer-brand"><ShopBrand name={brandName} logo={brandLogo} platform={platformBrand} pending={!store.catalogReady && !store.error} /></div><span>{t('让工具回归简单，让灵感自由生长。')}</span><button className="text-button" onClick={() => setDark(v => !v)}>{dark ? <Moon size={14} /> : <Sun size={14} />}{t(dark ? '深色外观' : '浅色外观')}</button></div><div className="footer-bottom"><span>© {new Date().getFullYear()} {brandName} · {t('独立服务商')}</span><div><button onClick={() => setNoticeOpen(true)}>{t('服务须知')}</button><button onClick={openSupport}>{t('联系支持')}</button><button className="footer-language" lang={locale === 'en' ? 'zh-CN' : 'en'} aria-label={locale === 'en' ? '切换为简体中文' : 'Switch to English'} onClick={() => setLocale(locale === 'en' ? 'zh-CN' : 'en')}>{locale === 'en' ? '简体中文' : 'English'}</button></div></div></footer>
    {isDetail && <div className="mobile-purchase-bar"><div><strong>¥{Math.floor(plan.price)}<small>.{plan.price.toFixed(2).split('.')[1]}</small></strong><span>{product.name} {plan.name} · {plan.renewalOnly ? '仅续费' : isEmailProduct ? '一次购买' : isSms ? '按次购买' : isXGift ? '一次购买' : '按月订阅'}</span></div><Button disabled={store.busy || !store.ready || !plan.enabled || !store.checkoutEnabled} onClick={beginPurchase}>{!store.ready ? '读取中' : !plan.enabled ? '暂停售卖' : !store.checkoutEnabled ? '暂未开放' : plan.renewalOnly ? '立即续费' : '立即购买'} <ArrowRight size={15} /></Button></div>}
    <Dialog open={helpOpen} onOpenChange={setHelpOpen}><DialogContent className="info-dialog catalog-help motion-dialog"><DialogHeader><DialogTitle>{t('购买帮助')}</DialogTitle><DialogDescription>{t('先选择商品，再查看对应套餐和服务流程。')}</DialogDescription></DialogHeader><Accordion className="faq-list">{generalFaq.map(([q, a], i) => <AccordionItem key={t(q)} value={`general-${i}`}><AccordionTrigger>{t(q)}</AccordionTrigger><AccordionContent>{t(a)}</AccordionContent></AccordionItem>)}</Accordion></DialogContent></Dialog>
    <RecoveryDialog open={recoveryOpen} onClose={() => setRecoveryOpen(false)} onUpdated={() => void store.refresh(true)} />
    <PurchaseFlow couponAvailable={store.catalog.find(item => item.id === purchaseDraft.plan)?.has_coupons === true} shopSlug={store.partner?.slug} notice={purchaseNoticeOpen ? { purchaseNote: purchaseDraft.purchaseNote, supportsWarranty: purchaseDraft.supportsWarranty, onContinue: () => { setAcceptedPlan(purchaseDraft.plan); setPurchaseNoticeOpen(false) } } : undefined} paymentMethods={store.paymentMethods} onOrderUpdated={store.acceptOrder} testingEnabled={store.testingEnabled} emailMode={emailOpen} draft={purchaseDraft} initialEmail={store.recoveryEmail} onSubmitEmail={create} pendingAction={store.pendingAction?.id === activeId ? store.pendingAction?.action : undefined} onUpdated={() => void store.refresh(true)} busy={store.busy} error={store.error} order={activeOrder} open={checkoutOpen} onOpenChange={changeCheckoutOpen} onCloseComplete={() => setPurchaseNoticeOpen(false)} onAction={onAction} onOrders={() => { changeCheckoutOpen(false); navigate('orders') }} />
    <SupportContactsDialog open={supportOpen} onOpenChange={setSupportOpen} contacts={store.supportContacts} name={brandName} error={store.error} onHelp={help} onRetry={() => void store.refresh(true)} />
    <StoreAnnouncement announcement={store.announcement} shop={partnerSlug} page={isDetail ? page : page === 'store' ? 'store' : 'orders'} blocked={store.shopUnavailable || purchaseNoticeOpen || checkoutOpen || recoveryOpen || helpOpen || supportOpen || noticeOpen} />
    <Dialog open={noticeOpen} onOpenChange={setNoticeOpen}><DialogContent className="info-dialog motion-dialog"><DialogHeader><DialogTitle>{t('购买前，先了解。')}</DialogTitle><DialogDescription>{brandName} · {t('服务须知')}</DialogDescription></DialogHeader><ul className="notice-list"><li><Check />{t('选择所需服务，确认套餐、金额与适用范围。Pro 10× 支持新开与续费，Pro 25× 支持新开与自动充值。')}</li><li><ShieldCheck />{t('下单需填写可接收邮件的邮箱，付款与服务进度以订单记录为准。')}</li><li><Monitor />{t('订单可通过邮箱验证跨设备找回。遇到问题，请在原订单申请售后。')}</li></ul><Button onClick={() => setNoticeOpen(false)}>{t('了解了')}</Button></DialogContent></Dialog>
  </div>
}
export default App
