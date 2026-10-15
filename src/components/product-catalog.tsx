import { useStorefrontI18n } from '@/lib/storefront-i18n'
import { normalizeProductOrder } from '../../shared/product-order'
import { XPremiumScene } from './x-premium'
import { MembershipScene } from './membership-scene'
import { EMAIL_PRODUCTS } from '../../shared/email-products'
import { useState, type MouseEvent, type ReactNode } from 'react'
import { ChevronRight, CircleHelp, Clock3, LayoutGrid, Mail, ReceiptText, Search, Sparkles, Terminal } from 'lucide-react'
import { LaunchInterestDialog, type InterestProduct } from './launch-interest-dialog'
import { ProductMark } from './brand'
import { SubscriptionDeck } from './subscription-deck'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { UPCOMING_PRODUCTS } from '@/lib/products'
import { storefrontHref } from '@/lib/storefront-routing'
import { catalogSubscriptionPlans, catalogStartingPrice, formatCatalogPrice } from '@/lib/catalog-display'
import type { CatalogPlan } from '@/lib/api'
import '@/styles/storefront-home.css'

const categories = [
  { id: 'all', name: '全部商品', icon: LayoutGrid },
  { id: 'ai', name: 'AI 订阅', icon: Sparkles },
  { id: 'learning', name: '语言学习', icon: Sparkles },
  { id: 'mail', name: '邮箱账号', icon: Mail },
  { id: 'tool', name: '工具服务', icon: Terminal },
]

function CatalogSkeleton() {
  return <div className="store-featured store-catalog-skeleton" aria-hidden="true">
    {[0, 1, 2, 3].map(index => <div key={index} className="store-product store-skeleton-card">
      <span className="store-skeleton-title" /><span className="store-skeleton-spec" />
      <div className="store-skeleton-art"><span /></div>
      <div className="store-product-bottom"><span className="store-skeleton-price" /><span className="store-skeleton-action" /></div>
    </div>)}
  </div>
}

export function ProductCatalog({ onHelp, onOrders, onNavigate, offers, catalogReady, error, productOrder = [], hiddenProductIds = [] }: { catalogReady: boolean; error?: string; productOrder?: readonly string[]; hiddenProductIds?: readonly string[]; onHelp: () => void; onOrders: () => void; onNavigate: (page: string) => void; offers: CatalogPlan[] }) {
  const { t } = useStorefrontI18n()
  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  const [interest, setInterest] = useState<InterestProduct>()
  const [interestOpen, setInterestOpen] = useState(false)
  const plans = catalogSubscriptionPlans(offers)
  const startingPrice = catalogStartingPrice(offers)
  const matches = (group: string, text: string) => (category === 'all' || category === group) && text.toLowerCase().includes(query.trim().toLowerCase())
  const chatgpt = matches('ai', 'ChatGPT Plus Pro')
  const gmail = matches('mail', 'Gmail 邮箱账号 email accounts 2FA')
  const upcoming = UPCOMING_PRODUCTS.filter(p => matches('ai', p.name))
  const memberships = Object.entries(EMAIL_PRODUCTS).filter(([, p]) => p.productId !== 'gmail' && matches(p.productId === 'gemini' ? 'ai' : 'learning', p.name + (p.productId === 'duolingo' ? ' Duolingo' : '')))
  const xgift = matches('tool', 'X Premium 推特 Twitter 会员赠送')
  const xOffers = offers.filter(p => p.product_id === 'x-premium')
  const xAvailable = xOffers.some(p => p.enabled)
  const xOffer = [...xOffers].sort((a, b) => Number(Boolean(b.enabled)) - Number(Boolean(a.enabled)) || a.price_cents - b.price_cents)[0]
  const sms = matches('tool', 'Codex 接码 SMS verification')
  const navigate = (event: MouseEvent<HTMLAnchorElement>, page: string) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault(); onNavigate(page)
  }
  const cards: { id: string; compact?: boolean; node: ReactNode }[] = [
    { id: "chatgpt", node: chatgpt && <article className="store-product"><div className="store-product-heading"><h3>ChatGPT</h3>{offers.length > 0 && !plans.some(p => p.enabled) && <span>{t('暂停售卖')}</span>}</div><p className="store-spec">{t('自有账号充值 · Plus / Pro')}</p><SubscriptionDeck plans={plans} /><div className="store-product-bottom"><span className="store-starting-price">{startingPrice === null ? <small>{t(offers.length ? '价格暂不可用' : '价格加载中')}</small> : <>¥{formatCatalogPrice(startingPrice)}<small>{t(' 起')}</small></>}</span><a className="store-action" href={storefrontHref('product/chatgpt')} onClick={e => navigate(e, 'product/chatgpt')}>{t('选择套餐')}</a></div></article> },
    ...memberships.map(([id, product]) => { const offer = offers.find(p => p.id === id); return { id: product.productId, node: <article key={id} className="store-product membership-product"><div className="store-product-heading"><h3>{product.productId === 'gemini' ? 'Gemini Pro' : t('多邻国')}</h3><span>{t(product.duration + '会员')}</span></div><p className="store-spec">{t(product.label)} · {t('邮件交付')}</p><MembershipScene productId={product.productId as 'gemini' | 'duolingo'} /><div className="store-product-bottom"><span className="store-starting-price">{offer ? <>¥{formatCatalogPrice(offer.price_cents / 100)}<small> / {t(product.duration)}</small></> : <small>{t(offers.length ? '暂未开放' : '价格加载中')}</small>}</span><a className="store-action" href={storefrontHref('product/' + product.productId)} onClick={e => navigate(e, 'product/' + product.productId)}>{t(offer?.enabled ? '查看商品' : '查看详情')}</a></div></article> } }),
    { id: "x-premium", node: xgift && <article className="store-product membership-product x-product"><div className="store-product-heading"><h3>X Premium</h3><span>{t(offers.length > 0 && !xAvailable ? '暂停售卖' : '会员订阅')}</span></div><p className="store-spec">{t('3 / 6 个月 · 你的账号，继续精彩')}</p><XPremiumScene /><div className="store-product-bottom"><span className="store-starting-price">{xOffer ? <>¥{formatCatalogPrice(xOffer.price_cents / 100)}<small>{t(' 起')}</small></> : <small>{t('价格加载中')}</small>}</span><a className="store-action" href={storefrontHref('product/x-premium')} onClick={e => navigate(e, 'product/x-premium')}>{t(xAvailable ? '选择套餐' : '查看详情')}</a></div></article> },
    { id: "gmail", node: gmail && <article className="store-product"><div className="store-product-heading"><h3>{t('Gmail 账号')}</h3><span>{t('美国个人白号')}</span></div><p className="store-spec">{t('带 2FA · 账号资料自动邮件交付')}</p><div className="store-mail-art" aria-hidden="true"><div className="store-envelope" /><span className="store-envelope-label"><Mail size={16} />Gmail</span></div><div className="store-product-bottom"><span className="store-starting-price">{offers.find(p => p.id === 'gmail-account') ? <>¥{formatCatalogPrice(offers.find(p => p.id === 'gmail-account')!.price_cents / 100)}<small>{t(' / 个')}</small></> : <small>{t('价格加载中')}</small>}</span><a className="store-action" href={storefrontHref('product/gmail')} onClick={e => navigate(e, 'product/gmail')}>{t(offers.some(p => p.id === 'gmail-account' && p.enabled) ? '查看商品' : '查看详情')}</a></div></article> },
    ...upcoming.map(product => ({ id: product.id, compact: true, node: <Button key={product.id} variant="ghost" className="store-compact" onClick={() => { setInterest(product); setInterestOpen(true) }}><ProductMark small productId={product.id} /><span><strong>{product.name}</strong><small>{t('待上架')}</small></span><ChevronRight size={16} /></Button> })),
    { id: 'codex-sms', compact: true, node: sms && <a className="store-compact" href={storefrontHref('product/codex-sms')} onClick={e => navigate(e, 'product/codex-sms')}><ProductMark small productId="codex-sms" /><span><strong>{t('Codex 接码')}</strong><small>{t(offers.some(o => o.product_id === 'codex-sms' && o.enabled) ? '按次服务' : '暂停售卖')}</small></span><ChevronRight size={16} /></a> },
  ]
  const groups: typeof cards[] = []
  for (const id of normalizeProductOrder(productOrder)) {
    const card = cards.find(item => item.id === id)
    if (!card?.node || hiddenProductIds.includes(id)) continue
    const last = groups.at(-1)
    if (last && Boolean(last[0].compact) === Boolean(card.compact)) last.push(card)
    else groups.push([card])
  }
  const visibleCards = groups.flat()
  return <section id="catalog-products" className="store-home page-width" aria-label={t('商品目录')}>
    <aside className="store-sidebar" aria-label={t('商品分类')}>
      <span className="store-sidebar-label">{t('浏览商品')}</span>
      <div className="store-categories" role="group" aria-label={t('按品类筛选')}>{categories.map(({ id, name, icon: Icon }) => <Button key={id} variant="ghost" aria-pressed={category === id} onClick={() => setCategory(id)}><Icon size={16} />{t(name)}</Button>)}</div>
      <div className="store-sidebar-links"><Button variant="ghost" onClick={onOrders}><Clock3 size={16} />{t('继续我的订单')}</Button><Button variant="ghost" onClick={onHelp}><CircleHelp size={16} />{t('购买帮助')}</Button></div>
    </aside>
    <div className="store-content" aria-busy={!catalogReady && !error}>
      <div className="store-toolbar"><h2>{t(query ? '搜索结果' : category === 'all' ? '全部服务' : categories.find(c => c.id === category)!.name)}</h2><label className="store-search"><Search size={15} /><Input aria-label={t('搜索商品')} placeholder={t('搜索商品')} value={query} onChange={e => setQuery(e.target.value)} /></label></div>
      {!catalogReady ? error ? <p className="store-empty" role="status">{t('商品暂时加载失败，请点击上方重试。')}</p> : <>
        <span className="sr-only" role="status">{t('正在加载商品')}</span><CatalogSkeleton />
      </> : <>
        {groups.map(group => <div key={group[0].id} className={(group[0].compact ? 'store-compact-grid' : 'store-featured') + ' store-product-group'}>
          {group.map(card => <div key={card.id} className="store-card-enter reveal-in" style={{ animationDelay: `${Math.min(visibleCards.indexOf(card), 6) * 40}ms` }}>
            {card.node}
          </div>)}
        </div>)}
        {!groups.length && <p className="store-empty" role="status">{t('没有找到相关商品，试试其他名称。')}</p>}
      </>}
      <p className="store-order-note"><ReceiptText size={15} />{t('付款、交付与售后，都可以在')}<button onClick={onOrders}>{t('「我的订单」')}</button>{t('中继续。')}</p>
    </div>
    {interest && <LaunchInterestDialog key={interest.id} product={interest} open={interestOpen} onOpenChange={setInterestOpen} />}
  </section>
}
