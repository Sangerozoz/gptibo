export type AdminNavigationItem = { id: string; label: string }
export type AdminNavigationGroup = { id: string; label: string; items: AdminNavigationItem[] }

const groups: AdminNavigationGroup[] = [
  { id: 'overview', label: '概览', items: [{ id: 'overview', label: '运营概览' }] },
  { id: 'store', label: '店铺与商品', items: [
    { id: 'store-settings', label: '店铺设置' },
    { id: 'contacts', label: '联系方式' },
    { id: 'categories', label: '分类管理' },
    { id: 'products', label: '商品管理' },
    { id: 'interest', label: '上线提醒' },
  ] },
  { id: 'orders', label: '订单与客户', items: [
    { id: 'orders', label: '订单管理' },
    { id: 'refunds', label: '退款与售后' },
    { id: 'customers', label: '客户管理' },
  ] },
  { id: 'data', label: '数据与财务', items: [
    { id: 'visitors', label: '访客统计' },
    { id: 'accounting', label: '清账统计' },
  ] },
  { id: 'partners', label: '代理业务', items: [
    { id: 'partners', label: '代理管理' },
    { id: 'tickets', label: '代理工单' },
    { id: 'invoices', label: '开票管理' },
  ] },
  { id: 'system', label: '系统设置', items: [
    { id: 'integrations', label: '服务接入' },
    { id: 'security', label: '安全审计' },
  ] },
]

export function getAdminNavigation(partnerModeEnabled: boolean): AdminNavigationGroup[] {
  return groups.filter(group => partnerModeEnabled || group.id !== 'partners')
}
