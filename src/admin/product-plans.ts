export function selectProductPlans<TPlan extends { product_id: string }>(
  productId: string,
  allPlans: readonly TPlan[],
): TPlan[] {
  return allPlans.filter(plan => plan.product_id === productId)
}

export function parsePlanPrice(value: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null
  const cents = Math.round(Number(value) * 100)
  return Number.isSafeInteger(cents) && cents >= 1 && cents <= 10000000 ? cents : null
}

export function planUpdateNote(original: { price_cents: number; enabled: number | boolean; display_label?: string }, next: { priceCents: number; enabled: boolean; displayLabel: string }): string {
  const changes: string[] = []
  if (original.price_cents !== next.priceCents) changes.push('调整售价')
  if (Boolean(original.enabled) !== next.enabled) changes.push(next.enabled ? '套餐上架' : '套餐下架')
  if ((original.display_label ?? '') !== next.displayLabel) changes.push(next.displayLabel ? '修改标签' : '清除标签')
  return changes.join('，')
}
