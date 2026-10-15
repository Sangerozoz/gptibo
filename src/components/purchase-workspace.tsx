import { MembershipScene } from './membership-scene'
import { ArrowDown, ArrowRight, Check, ChevronRight, CircleHelp, LockKeyhole, ShieldCheck, UserRound, Wallet } from 'lucide-react'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { RadioGroup, RadioGroupItem } from './ui/radio-group'
import { ProductMark } from './brand'
import type { PRODUCTS, productPlans } from '@/lib/products'
import type { PlanId } from '@/lib/demo-orders'
import type { useStore } from '@/lib/use-store'

export type PurchasePlan = Omit<ReturnType<typeof productPlans>[number], 'price'> & { price: number; enabled: boolean }
type Props = {
  product: Pick<typeof PRODUCTS[number], 'id'> & { name: string; tagline: string; badge: string; pitch: string; quantity: string; unit: string; method: string }; plans: PurchasePlan[]; plan: PurchasePlan; selected: PlanId
  store: Pick<ReturnType<typeof useStore>, 'busy' | 'ready' | 'checkoutEnabled'> & Partial<Pick<ReturnType<typeof useStore>, 'catalog'>>
  setSelected: (id: PlanId) => void; beginPurchase: () => void; help: () => void; onGuide: () => void
}

export function PurchaseWorkspace({ product, plans, plan, selected, store, setSelected, beginPurchase, help, onGuide }: Props) {
  const isXGift = product.id === 'x-premium'
  const isGmail = product.id === 'gmail'
  const isEmail = product.id === 'gemini' || product.id === 'duolingo' || isGmail
  const purchaseNote = store.catalog?.find(p => p.id === plan.id)?.purchase_note
  const isSms = product.id === 'codex-sms'
  return (<section className="purchase-workspace page-width reveal-in delay-1" aria-label={product.name + ' 套餐选择'} id="subscriptions">
          <div className="product-area">
            <div className="product-topline"><span className="section-kicker">01 / 选择套餐</span><span className="availability"><span />{store.checkoutEnabled && plan.enabled ? '可购买' : '待开放'}</span></div>
            <div className="product-heading"><ProductMark productId={product.id} /><div><h2>{product.name}</h2><p>{product.tagline}</p></div><Badge variant="outline" className="personal-badge"><UserRound size={12} />{product.badge}</Badge></div>
            <div className="product-pitch"><h3 key={selected} className="state-enter">{plan.subtitle}</h3><p>{plan.renewalOnly ? '本套餐仅支持已有订阅续费，暂不支持新开。' : product.pitch}</p></div>
            {isEmail && !isGmail && <MembershipScene productId={product.id as 'gemini' | 'duolingo'} />}
            <div className="plan-label"><span>选择适合你的计划</span><span>{isXGift ? '一次购买' : isEmail ? '一次购买 · ' + product.quantity : isSms ? '按次购买' : '按月订阅'}</span></div>
            <RadioGroup value={plan.id} onValueChange={v => setSelected(v as PlanId)} className={`plan-options ${plans.length === 1 ? 'single-plan' : 'subscription-plans'}`} aria-label="商品套餐">
              {plans.map(p => <label key={p.id} className={`plan-option ${plan.id === p.id ? 'is-selected' : ''}`}><div className="plan-option-top"><RadioGroupItem value={p.id} disabled={!p.enabled} id={`plan-${p.id}`} aria-label={`${product.name} ${p.name}${p.renewalOnly ? '，仅续费' : ''}`} /><span>{p.name}</span>{p.renewalOnly ? <Badge variant="outline" className="renewal-badge">仅续费</Badge> : p.id === 'plus' && <span className="recommend-label">日常之选</span>}</div><p>{p.enabled ? p.description : '暂停售卖'}</p><div className="plan-price"><span>¥</span><strong>{p.price}</strong><span>/ {product.unit}</span></div></label>)}
            </RadioGroup>
            <div className="plan-features" key={`features-${selected}`}>{plan.features.map(text => <span key={text}><Check size={14} />{text}</span>)}</div>
            {isEmail && purchaseNote && <p className="membership-purchase-note">{purchaseNote}</p>}{isXGift && <p className="membership-purchase-note">通过 X 官方赠送方式开通，付款前请核对用户名。</p>}<div className="product-bottom"><ShieldCheck size={15} /><span>{isXGift ? '无需提供密码' : isGmail ? '付款后自动邮件发货' : isEmail ? '人工处理 · 邮件发货' : isSms ? '单次短信接码' : plan.renewalOnly ? '仅限已有订阅续费' : '自有账号开通'}</span><span className="dot-separator">·</span><span>订单进度可查</span><button className="text-button" onClick={help}>购买须知 <ChevronRight size={13} /></button></div>
          </div>
          <aside className="order-summary" aria-label="订单摘要"><div className="summary-title"><h2>你的订单</h2><Wallet size={18} /></div><div className="summary-product"><ProductMark small productId={product.id} /><div><strong>{product.name} <span key={selected} className="state-enter inline-block">{plan.name}</span></strong><p>{isXGift ? product.method : isEmail ? product.method : isSms ? '在订单中接收验证码' : plan.renewalOnly ? '仅续费 · 不支持新开' : '为自己的账号开通'}</p></div></div><dl className="summary-details"><div><dt>{isGmail ? '账号数量' : isSms ? '服务次数' : '订阅周期'}</dt><dd>{isXGift ? plan.id === 'x-premium-3m' ? '3 个月' : '6 个月' : product.quantity}</dd></div><div><dt>服务方式</dt><dd>{plan.renewalOnly ? '订阅续费' : product.method}</dd></div><div><dt>支付方式</dt><dd>{product.id === 'chatgpt' ? '支付宝' : '在线支付'}</dd></div></dl><div className="summary-total"><div><span>合计</span><span className="price-caption">{isXGift ? '一次购买' : isEmail ? '一次购买 · ' + product.quantity : isSms ? '按次购买' : '按月订阅'}</span></div><div className="total-price" key={selected}><small>¥</small>{Math.floor(plan.price)}<span>.{plan.price.toFixed(2).split('.')[1]}</span></div></div><Button className="primary-action summary-cta" disabled={store.busy || !store.ready || !plan.enabled || !store.checkoutEnabled} onClick={beginPurchase}>{!store.ready ? '正在读取商品' : !plan.enabled ? '暂停售卖' : !store.checkoutEnabled ? '暂未开放购买' : plan.renewalOnly ? '立即续费' : '立即购买'} <ArrowRight size={17} /></Button><p className="summary-note"><LockKeyhole size={12} />{store.checkoutEnabled ? '在线付款 · 订单进度可查' : '开放购买后可在线付款'}</p>
            {isXGift ? <div className="summary-footnote"><CircleHelp size={15} /><p>核对账号后再付款，<button onClick={onGuide}>查看充值步骤</button></p></div> : isEmail ? <div className="summary-footnote"><CircleHelp size={15} /><p>付款后请留意收件箱与垃圾邮件，<button onClick={onGuide}>查看交付步骤</button></p></div> : isSms ? <div className="summary-footnote"><CircleHelp size={15} /><p>第一次使用？<button onClick={onGuide}>看看如何接码</button></p><ArrowDown size={14} /></div>
              : <button type="button" className="summary-footnote summary-guide-entry" onClick={onGuide}><span className="summary-guide-signal" aria-hidden="true"><CircleHelp size={15} /></span><span className="summary-guide-copy"><span>第一次使用？</span><strong>观看充值流程动画</strong></span><ArrowDown size={14} aria-hidden="true" /></button>}
          </aside>
        </section>
  )
}
