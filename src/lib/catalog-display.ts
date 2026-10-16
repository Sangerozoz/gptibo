import type { CatalogPlan } from './api.ts'

export function catalogPlanDisplayLabel(planId: string, offer?: Pick<CatalogPlan, 'display_label'>): string {
  return offer?.display_label ?? (planId === 'plus' ? '日常之选' : '')
}

const subscriptionTiers = [{ id: 'plus', name: 'Plus' }, { id: 'pro-5x', name: 'Pro 5×' }, { id: 'pro-20x', name: 'Pro 10×' }, { id: 'pro-25x', name: 'Pro 25×' }]
export function catalogSubscriptionPlans(offers: CatalogPlan[]) {
  return subscriptionTiers.map(tier => {
    const offer = offers.find(o => o.product_id === 'chatgpt' && o.id === tier.id)
    return { ...tier, price: offer && Number.isSafeInteger(offer.price_cents) && offer.price_cents >= 0 ? offer.price_cents / 100 : null, enabled: Boolean(offer?.enabled) }
  })
}
export function catalogStartingPrice(offers: CatalogPlan[]) {
  const plans = catalogSubscriptionPlans(offers)
  const available = plans.filter(p => p.enabled && p.price !== null)
  // Keep configured prices visible when the whole shop is paused; status is shown separately.
  const prices = (available.length ? available : plans.filter(p => p.price !== null)).map(p => p.price as number)
  return prices.length ? Math.min(...prices) : null
}
export function formatCatalogPrice(price: number) { return Number.isInteger(price) ? String(price) : price.toFixed(2) }
export type DisplaySubscriptionPlan = ReturnType<typeof catalogSubscriptionPlans>[number]
