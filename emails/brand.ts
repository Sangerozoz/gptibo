// Explicit markers keep brand identity separate from product names and customer text.
export const emailBrand = {
  name: '__RECHARGE_BRAND_NAME__',
  logo: '__RECHARGE_BRAND_LOGO__',
  orders: '__RECHARGE_BRAND_ORDERS_URL__',
  workspace: '__RECHARGE_BRAND_WORKSPACE_URL__',
  admin: '__RECHARGE_BRAND_ADMIN_URL__',
}
export const platformEmailFields: Record<string, string> = {
  BRAND_NAME: '硅基生物',
  BRAND_LOGO: '__RECHARGE_SITE_ORIGIN__/email-logo.png',
  BRAND_ORDERS_URL: '__RECHARGE_SITE_ORIGIN__/orders',
  BRAND_WORKSPACE_URL: '__RECHARGE_SITE_ORIGIN__/join',
  BRAND_ADMIN_URL: '__RECHARGE_SITE_ORIGIN__/admin',
}
export function platformEmail(value: string) {
  return value.replace(/__RECHARGE_(BRAND_[A-Z_]+)__/g, (marker, key: string) => platformEmailFields[key] ?? marker)
}
