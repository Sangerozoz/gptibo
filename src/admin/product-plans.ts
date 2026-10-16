export function selectProductPlanDetails<TPlan extends { id: string; product_id: string }, TAudit extends { target_id: string }>(
  productId: string,
  allPlans: readonly TPlan[],
  allAudit: readonly TAudit[],
): { plans: TPlan[]; audit: TAudit[] } {
  const plans = allPlans.filter(plan => plan.product_id === productId)
  const ids = new Set(plans.map(plan => plan.id))
  return { plans, audit: allAudit.filter(row => ids.has(row.target_id)) }
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
