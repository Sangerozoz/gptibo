export function selectProductPlanDetails<TPlan extends { id: string; product_id: string }, TAudit extends { target_id: string }>(
  productId: string,
  allPlans: readonly TPlan[],
  allAudit: readonly TAudit[],
): { plans: TPlan[]; audit: TAudit[] } {
  const plans = allPlans.filter(plan => plan.product_id === productId)
  const ids = new Set(plans.map(plan => plan.id))
  return { plans, audit: allAudit.filter(row => ids.has(row.target_id)) }
}
