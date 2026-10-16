import { useResource } from '@/lib/use-resource'
import { Feedback } from '@/components/workspace-loading'
import { ArrowUpRight } from 'lucide-react'
type Connection = {
  configured: boolean
  consoleUrl?: string
  balance?: { available: number; frozen: number }
  products?: Array<{
    code: string
    name: string
    points: number
    enabled: number
  }>
}
export function XGiftPanel({ revision }: { revision: number }) {
  const { data, loading, error } = useResource<Connection>(
    '/api/admin/xgift/status',
    revision,
  )
  const platform = data?.consoleUrl === 'https://api.shop.example.invalid'
  const consoleUrl = platform ? 'https://api.shop.example.invalid' : 'https://x-api.shop.example.invalid'
  const amount = (value: number) => platform ? `¥${(value / 100).toFixed(2)}` : `${value} 点`
  return (
    <section className="integration-service-section">
      <div className="integration-section-title">
        <div><h2>X Premium</h2><p>供应商余额与套餐采购价格。</p></div>
        <a className="integration-console-link" href={consoleUrl} target="_blank" rel="noreferrer">独立后台 <ArrowUpRight size={14} /></a>
      </div>
      <Feedback data={data} loading={loading} error={error} shape="compact" />
      {data &&
        (data.configured ? (
          <>
            <div className="integration-balance"><div><span>可用余额</span><strong>{data.balance ? amount(data.balance.available) : '暂不可用'}</strong></div><div><span>冻结金额</span><strong>{data.balance ? amount(data.balance.frozen) : '暂不可用'}</strong></div></div>
            <div className="integration-service-rows integration-product-rows">
              {data.products?.map((p) => (
                <div key={p.code}>
                  <div>
                    <h3>{p.name}</h3>
                    <p>{amount(p.points)} / 单</p>
                  </div>
                  <span
                    className={`connection-state ${p.enabled ? 'is-ready' : ''}`}
                  >
                    {p.enabled ? '可供货' : '暂不可供货'}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="admin-subtle">
            尚未配置供应商账户。
          </p>
        ))}
      <p className="integration-footnote">
        商品销售开关在「商品管理」的套餐与售价中管理。
      </p>
    </section>
  )
}
