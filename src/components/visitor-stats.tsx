import { useId, useState, type ReactNode } from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { ChartNoAxesCombined, Eye, TrendingUp, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { useResource } from '@/lib/use-resource'
import { Feedback } from '@/components/workspace-loading'
import './visitor-stats.css'

export type VisitorSummary = {
  days: number
  visitors: number
  pageViews: number
  trend: { day: string; visitors: number; pageViews: number }[]
}
export type VisitorPeriod = 7 | 30 | 90

const chartConfig = {
  visitors: {
    label: '独立访客 (UV)',
    color: 'var(--primary)',
  },
  pageViews: {
    label: '页面浏览量 (PV)',
    color: 'var(--muted-foreground)',
  },
} satisfies ChartConfig

function TrendChart({ trend }: { trend: VisitorSummary['trend'] }) {
  const rawId = useId()
  const chartId = rawId.replace(/[^a-zA-Z0-9]/g, '')

  return (
    <>
      <ChartContainer
        config={chartConfig}
        className="visitor-chart"
        aria-label="每日访客数与浏览量趋势"
      >
        <AreaChart
          accessibilityLayer
          data={trend}
          margin={{ top: 14, right: 24, left: -12, bottom: 4 }}
        >
          <defs>
            <linearGradient id={`fill-visitors-${chartId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-visitors)" stopOpacity={0.4} />
              <stop offset="95%" stopColor="var(--color-visitors)" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id={`fill-pageViews-${chartId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--color-pageViews)" stopOpacity={0.25} />
              <stop offset="95%" stopColor="var(--color-pageViews)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 4" />
          <XAxis
            dataKey="day"
            padding={{ left: 12, right: 12 }}
            axisLine={false}
            tickLine={false}
            tickMargin={10}
            minTickGap={24}
            interval="preserveStartEnd"
            tickFormatter={(value) => String(value).slice(5)}
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tickMargin={8}
            allowDecimals={false}
            domain={[0, 'auto']}
            tickCount={4}
          />
          <ChartTooltip
            cursor={{ stroke: 'var(--border)', strokeWidth: 1, strokeDasharray: '3 3' }}
            content={
              <ChartTooltipContent
                indicator="dot"
                labelFormatter={(label) => `${label} (北京时间)`}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Area
            dataKey="pageViews"
            type="monotone"
            stroke="var(--color-pageViews)"
            strokeWidth={2}
            fill={`url(#fill-pageViews-${chartId})`}
            activeDot={{ r: 5, strokeWidth: 1.5, stroke: 'var(--card)' }}
          />
          <Area
            dataKey="visitors"
            type="monotone"
            stroke="var(--color-visitors)"
            strokeWidth={2.5}
            fill={`url(#fill-visitors-${chartId})`}
            activeDot={{ r: 6, strokeWidth: 2, stroke: 'var(--card)' }}
          />
        </AreaChart>
      </ChartContainer>
      <table className="sr-only">
        <caption>每日访客趋势数据</caption>
        <thead>
          <tr>
            <th>日期</th>
            <th>独立访客</th>
            <th>浏览量</th>
          </tr>
        </thead>
        <tbody>
          {trend.map((row) => (
            <tr key={row.day}>
              <td>{row.day}</td>
              <td>{row.visitors}</td>
              <td>{row.pageViews}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

export function VisitorStats({
  endpoint,
  revision = 0,
  title = '访客统计',
  description,
  action,
  className,
  selectedDays,
  onDaysChange,
}: {
  endpoint: string
  revision?: number
  title?: string
  description?: string
  action?: ReactNode
  className?: string
  selectedDays?: VisitorPeriod
  onDaysChange?: (days: VisitorPeriod) => void
}) {
  const [internalDays, setInternalDays] = useState<VisitorPeriod>(7)
  const days = selectedDays ?? internalDays
  const setDays = onDaysChange ?? setInternalDays
  const { data, error, loading } = useResource<VisitorSummary>(`${endpoint}?days=${days}`, revision)

  const avgDailyVisitors = data
    ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(
      data.trend.reduce((sum, day) => sum + day.visitors, 0) / data.days
    )
    : '0'
  const avgDepth = data && data.visitors > 0 ? (data.pageViews / data.visitors).toFixed(1) : '0.0'
  const peakDay = data?.trend?.reduce(
    (max, cur) => (cur.visitors > max.visitors ? cur : max),
    data.trend[0] ?? { day: '', visitors: 0, pageViews: 0 }
  )

  return (
    <Card className={`visitor-stats ${className ?? ''}`.trim()}>
      <CardHeader className="visitor-stats-heading">
        <div className="visitor-stats-title-group">
          <div className="visitor-stats-title-row">
            <ChartNoAxesCombined className="visitor-stats-icon" size={17} aria-hidden="true" />
            <CardTitle>{title}</CardTitle>
          </div>
          <CardDescription>
            {description || `北京时间 · 最近 ${days} 天访问走势与流量分布`}
          </CardDescription>
        </div>
        <div className="visitor-stats-actions">
          {action}
          <div className="visitor-period" role="group" aria-label="统计时间范围">
            <Button
              type="button"
              variant={days === 7 ? 'secondary' : 'ghost'}
              size="sm"
              className="visitor-period-btn"
              aria-pressed={days === 7}
              onClick={() => setDays(7)}
            >
              7 天
            </Button>
            <Button
              type="button"
              variant={days === 30 ? 'secondary' : 'ghost'}
              size="sm"
              className="visitor-period-btn"
              aria-pressed={days === 30}
              onClick={() => setDays(30)}
            >
              30 天
            </Button>
            <Button
              type="button"
              variant={days === 90 ? 'secondary' : 'ghost'}
              size="sm"
              className="visitor-period-btn"
              aria-pressed={days === 90}
              onClick={() => setDays(90)}
            >
              90 天
            </Button>
          </div>
        </div>
      </CardHeader>
      <Feedback error={error} loading={loading} data={data} shape="compact" />
      {data && (
        <CardContent className="visitor-stats-content">
          <div className="visitor-kpi-grid">
            <div className="visitor-kpi-card">
              <div className="visitor-kpi-label">
                <span className="visitor-kpi-dot visitor-kpi-dot-visitors" />
                <Users size={13} className="text-muted-foreground" />
                <span>独立访客 (UV)</span>
              </div>
              <div className="visitor-kpi-val-row">
                <strong className="visitor-kpi-value">{data.visitors.toLocaleString('zh-CN')}</strong>
                <span className="visitor-kpi-sub">日均 {avgDailyVisitors} 人</span>
              </div>
            </div>
            <div className="visitor-kpi-card">
              <div className="visitor-kpi-label">
                <span className="visitor-kpi-dot visitor-kpi-dot-pageviews" />
                <Eye size={13} className="text-muted-foreground" />
                <span>页面浏览量 (PV)</span>
              </div>
              <div className="visitor-kpi-val-row">
                <strong className="visitor-kpi-value">{data.pageViews.toLocaleString('zh-CN')}</strong>
                <span className="visitor-kpi-sub">人均 ~{avgDepth} 页</span>
              </div>
            </div>
            <div className="visitor-kpi-card">
              <div className="visitor-kpi-label">
                <TrendingUp size={13} className="text-muted-foreground" />
                <span>单日最高峰值</span>
              </div>
              <div className="visitor-kpi-val-row">
                <strong className="visitor-kpi-value">
                  {peakDay?.visitors ? peakDay.visitors.toLocaleString('zh-CN') : 0}
                </strong>
                <span className="visitor-kpi-sub">
                  {peakDay?.visitors ? `${peakDay.day.slice(5)} (${peakDay.pageViews} 浏览)` : '暂无'}
                </span>
              </div>
            </div>
          </div>

          <div className="visitor-chart-wrapper">
            {data.pageViews ? (
              <TrendChart trend={data.trend} />
            ) : (
              <div className="visitor-empty">
                <div className="visitor-empty-icon">
                  <ChartNoAxesCombined size={22} aria-hidden="true" />
                </div>
                <strong>暂无访问数据</strong>
                <p>所选时间段内暂无访客访问商店。客户打开商店后，这里将自动呈现流量走势。</p>
              </div>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  )
}
