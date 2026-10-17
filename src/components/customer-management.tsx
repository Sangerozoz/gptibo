import { useState } from 'react'
import {
  Users,
  Clock,
  AlertCircle,
  Wallet,
  Layers,
  Search,
  Plus,
  Download,
  RotateCcw,
  Pencil,
  RefreshCw,
  ArrowUpRight,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  MessageCircle,
  Mail,
  X,
  Building2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { DateTimePicker } from '@/components/workspace-controls'
import { CopyButton } from '@/components/copy-button'
import { Feedback } from '@/components/workspace-loading'
import { api, errorMessage } from '@/lib/api'
import { useResource } from '@/lib/use-resource'
import {
  monthAfter,
  MEMBERSHIP_PLANS,
  type Customer,
  type CustomerAccount,
  type CustomerDetail,
  type CustomerList,
  type CustomerExport,
} from '../../shared/customers.ts'
import './customer-management.css'

/* =========================================================================
   Formatting & Visual Helpers
   ========================================================================= */

const money = (cents: number) =>
  new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY' }).format(cents / 100)

const formatDateTime = (value: number | null) =>
  value === null
    ? '未录入'
    : new Date(value).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })

const formatDateOnly = (value: number | null) =>
  value === null
    ? '—'
    : new Date(value).toLocaleDateString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })

const inputTime = (ms: number) =>
  new Date(ms + 8 * 3600000).toISOString().slice(0, 19)

const contacts = [
  { key: 'wechat', label: '微信', icon: MessageSquare, color: 'text-emerald-600 dark:text-emerald-400' },
  { key: 'qq', label: 'QQ', icon: MessageCircle, color: 'text-blue-500 dark:text-blue-400' },
  { key: 'email', label: '邮箱', icon: Mail, color: 'text-indigo-500 dark:text-indigo-400' },
] as const

const kindLabels: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  open: { label: '首次开通', variant: 'default' },
  renew: { label: '到期续费', variant: 'secondary' },
  upgrade: { label: '套餐升级', variant: 'outline' },
}

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #3b82f6, #1d4ed8)',
  'linear-gradient(135deg, #10b981, #047857)',
  'linear-gradient(135deg, #8b5cf6, #6d28d9)',
  'linear-gradient(135deg, #f59e0b, #b45309)',
  'linear-gradient(135deg, #06b6d4, #0e7490)',
  'linear-gradient(135deg, #ec4899, #be185d)',
]

function getAvatarBg(name: string) {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  const index = Math.abs(hash) % AVATAR_GRADIENTS.length
  return AVATAR_GRADIENTS[index]
}

/* =========================================================================
   Interactive Micro-Components
   ========================================================================= */

function InlineCopy({ value, label }: { value: string; label?: string }) {
  return (
    <CopyButton value={value} label={`复制${label || '内容'}`} iconOnly type="button" variant="ghost" size="icon-xs" className="crm-copy-btn text-muted-foreground hover:text-foreground" />
  )
}

function AccountExpiryBadge({ value, now }: { value: number | null; now: number }) {
  if (value === null) {
    return <Badge variant="outline" className="text-muted-foreground">未开通</Badge>
  }
  if (value <= now) {
    const overdueDays = Math.max(1, Math.floor((now - value) / 86400000))
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertCircle className="size-3" />
        已到期 · 逾期 {overdueDays} 天
      </Badge>
    )
  }
  const days = Math.ceil((value - now) / 86400000)
  if (days <= 7) {
    return (
      <Badge variant="secondary" className="gap-1 border-amber-500/30 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
        <Clock className="size-3 text-amber-500" />
        即将到期 · 剩余 {days} 天
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
      生效中 · 剩余 {days} 天
    </Badge>
  )
}

/* =========================================================================
   Sub-Dialog 1: CustomerFormDialog (Add or Edit)
   ========================================================================= */

function CustomerFormDialog({
  endpoint,
  customer,
  partners,
  open,
  onClose,
  onSaved,
}: {
  endpoint: string
  customer?: Customer
  partners?: CustomerList['partners']
  open: boolean
  onClose: () => void
  onSaved: (id: string) => void
}) {
  const [name, setName] = useState(customer?.name ?? '')
  const [source, setSource] = useState(customer?.source ?? '')
  const [note, setNote] = useState(customer?.note ?? '')
  const [values, setValues] = useState({
    wechat: customer?.wechat ?? '',
    qq: customer?.qq ?? '',
    email: customer?.email ?? '',
  })
  const [chosen, setChosen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(contacts.map(c => [c.key, customer ? Boolean(customer[c.key]) : c.key === 'wechat']))
  )
  const [owner, setOwner] = useState('direct')
  const [key] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const isEdit = Boolean(customer)

  async function handleSave() {
    if (busy) return
    const selected = Object.fromEntries(
      contacts.map(c => [c.key, chosen[c.key] ? values[c.key].trim() : ''])
    )
    if (!contacts.some(c => selected[c.key])) {
      setError('请至少填写一种联系方式（微信、QQ 或邮箱）。')
      return
    }
    if (contacts.some(c => chosen[c.key] && !selected[c.key])) {
      setError('请填写已勾选的联系方式，或取消勾选。')
      return
    }
    if (selected.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(selected.email)) {
      setError('联系邮箱格式无效，请检查。')
      return
    }

    setBusy(true)
    setError('')
    try {
      await api(endpoint + (customer ? `/${customer.id}/edit` : ''), {
        key,
        version: customer?.version,
        name: name.trim(),
        source: source.trim(),
        note: note.trim(),
        ...selected,
        ...(partners && !customer ? { partnerId: owner } : {}),
      })
      onSaved(customer?.id ?? key)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !busy) onClose() }}>
      <DialogContent className="crm-sub-dialog motion-dialog">
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑客户资料' : '添加新客户'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? '修改客户称呼、联系方式和跟进备注，保存后即时生效。'
              : '录入新客户基本资料与联系方式，添加后可立即绑定会员账号。'}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={e => {
            e.preventDefault()
            void handleSave()
          }}
          className="crm-form-body"
        >
          <fieldset disabled={busy} className="flex flex-col gap-4">
            <div className="crm-form-grid-2">
              <div className="crm-control-group">
                <Label htmlFor="crm-input-name" className="required">
                  客户姓名 / 称呼 <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="crm-input-name"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="例如：张总、李先生"
                  required
                  maxLength={100}
                />
              </div>

              <div className="crm-control-group">
                <Label htmlFor="crm-input-source">客户来源</Label>
                <Input
                  id="crm-input-source"
                  value={source}
                  onChange={e => setSource(e.target.value)}
                  placeholder="例如：微信好友、朋友介绍、社群"
                  maxLength={100}
                />
              </div>
            </div>

            {partners && !customer && (
              <div className="crm-control-group">
                <Label>所属渠道 / 代理</Label>
                <Select
                  value={owner}
                  onValueChange={v => { if (v !== null) setOwner(String(v)) }}
                  items={[
                    { value: 'direct', label: '平台直营' },
                    ...partners.map(p => ({ value: p.id, label: `代理 · ${p.name}` })),
                  ]}
                  disabled={busy}
                >
                  <SelectTrigger className="w-full" aria-label="所属渠道 / 代理">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="motion-popover" alignItemWithTrigger={false}>
                    <SelectItem value="direct">平台直营</SelectItem>
                    {partners.map(p => (
                      <SelectItem value={p.id} key={p.id}>
                        代理 · {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="crm-control-group">
              <div className="flex items-center justify-between">
                <Label className="required">
                  联系方式（至少填写一种） <span className="text-destructive">*</span>
                </Label>
                <span className="text-xs text-muted-foreground">勾选后填写对应账号</span>
              </div>

              <div className="crm-contact-checkboxes">
                {contacts.map(c => {
                  const Icon = c.icon
                  return (
                    <Label key={c.key} className="flex items-center gap-2 cursor-pointer text-sm font-medium">
                      <Checkbox
                        id={`crm-chk-${c.key}`}
                        checked={chosen[c.key]}
                        onCheckedChange={checked => setChosen(v => ({ ...v, [c.key]: Boolean(checked) }))}
                      />
                      <Icon className={`size-4 ${c.color}`} />
                      <span>{c.label}</span>
                    </Label>
                  )
                })}
              </div>

              <div className="flex flex-col gap-2.5 pt-1">
                {contacts
                  .filter(c => chosen[c.key])
                  .map(c => {
                    const Icon = c.icon
                    return (
                      <div key={c.key} className="relative flex items-center">
                        <Icon className={`absolute left-3 size-4 ${c.color} pointer-events-none`} />
                        <Input
                          id={`crm-val-${c.key}`}
                          aria-label={c.label}
                          className="pl-9"
                          value={values[c.key]}
                          onChange={e => setValues(old => ({ ...old, [c.key]: e.target.value }))}
                          placeholder={`请输入客户${c.label}账号`}
                          required
                          maxLength={c.key === 'email' ? 254 : c.key === 'qq' ? 30 : 100}
                        />
                      </div>
                    )
                  })}
              </div>
            </div>

            <div className="crm-control-group">
              <div className="flex items-center justify-between">
                <Label htmlFor="crm-input-note">客户备注与偏好</Label>
                <span className="text-xs text-muted-foreground">{note.length} / 2000</span>
              </div>
              <Textarea
                id="crm-input-note"
                value={note}
                onChange={e => setNote(e.target.value)}
                maxLength={2000}
                rows={3}
                placeholder="记录客户沟通情况、套餐偏好、公司抬头或特殊诉求等..."
              />
            </div>
          </fieldset>

          <Feedback error={error} />

          <DialogFooter className="mt-2">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? '正在保存…' : isEdit ? '保存修改' : '确认添加客户'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* =========================================================================
   Sub-Dialog 2: AccountFormDialog (Add or Edit Account)
   ========================================================================= */

function AccountFormDialog({
  endpoint,
  customerId,
  account,
  open,
  onClose,
  onSaved,
}: {
  endpoint: string
  customerId: string
  account?: CustomerAccount
  open: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [value, setValue] = useState(account?.account ?? '')
  const [note, setNote] = useState(account?.note ?? '')
  const [key] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const isEdit = Boolean(account)

  async function handleSave() {
    if (busy || !value.trim()) return
    setBusy(true)
    setError('')
    try {
      await api(account ? `${endpoint}/accounts/${account.id}/edit` : `${endpoint}/${customerId}/accounts`, {
        key,
        version: account?.version,
        account: value.trim(),
        note: note.trim(),
      })
      onSaved()
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !busy) onClose() }}>
      <DialogContent className="crm-sub-dialog motion-dialog">
        <DialogHeader>
          <DialogTitle>{isEdit ? '修改会员账号' : '添加会员账号'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? '修改账号标识或账号独立备注，已有会员开通历史不受影响。'
              : '为该客户绑定一个使用账号（如 OpenAI 注册邮箱），保存后可录入套餐。'}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={e => {
            e.preventDefault()
            void handleSave()
          }}
          className="crm-form-body"
        >
          <fieldset disabled={busy} className="flex flex-col gap-4">
            <div className="crm-control-group">
              <Label htmlFor="crm-acc-val">
                账号标识 / 邮箱 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="crm-acc-val"
                value={value}
                onChange={e => setValue(e.target.value)}
                required
                maxLength={254}
                placeholder="例如：user@openai.com（可与客户联系邮箱不同）"
              />
              <span className="text-xs text-muted-foreground">
                同一客户下的账号标识不能重复。
              </span>
            </div>

            <div className="crm-control-group">
              <Label htmlFor="crm-acc-note">账号专属备注</Label>
              <Textarea
                id="crm-acc-note"
                value={note}
                onChange={e => setNote(e.target.value)}
                maxLength={2000}
                rows={3}
                placeholder="例如：开发部团队使用、主号、备用账号等..."
              />
            </div>
          </fieldset>

          <Feedback error={error} />

          <DialogFooter className="mt-2">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={busy || !value.trim()}>
              {busy ? '正在保存…' : isEdit ? '保存修改' : '确认添加'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* =========================================================================
   Sub-Dialog 3: SubscriptionFormDialog (Open / Renew / Upgrade)
   ========================================================================= */

function SubscriptionFormDialog({
  endpoint,
  account,
  kind,
  plans,
  open,
  onClose,
  onSaved,
}: {
  endpoint: string
  account: CustomerAccount
  kind: 'open' | 'renew' | 'upgrade'
  plans: CustomerList['plans']
  open: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const options = plans
    .filter(
      p =>
        kind !== 'upgrade' ||
        MEMBERSHIP_PLANS.indexOf(p.id as (typeof MEMBERSHIP_PLANS)[number]) >
          MEMBERSHIP_PLANS.indexOf(account.plan as (typeof MEMBERSHIP_PLANS)[number])
    )
    .map(p => ({ value: p.id, label: p.name }))

  const [plan, setPlan] = useState(
    kind === 'renew' ? account.plan ?? options[0]?.value ?? '' : options[0]?.value ?? ''
  )
  const [opened, setOpened] = useState(() => inputTime(Date.now()))
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [key] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const openedAt = Date.parse(opened + '+08:00')
  const calculatedExpiry = Number.isFinite(openedAt) ? monthAfter(openedAt) : null

  async function handleSave() {
    if (busy) return
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) > 100000 || !Number.isFinite(openedAt)) {
      setError('请输入开通时间，实付金额应为 0–100,000 元（最多两位小数）。')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api(`${endpoint}/accounts/${account.id}/subscriptions`, {
        key,
        version: account.version,
        kind,
        plan,
        openedAt,
        paidCents: Math.round(Number(amount) * 100),
        note: note.trim(),
      })
      onSaved()
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const kindInfo = kindLabels[kind]

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !busy) onClose() }}>
      <DialogContent className="crm-sub-dialog motion-dialog">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle>录入{kindInfo.label}记录</DialogTitle>
            <Badge variant={kindInfo.variant}>{kindInfo.label}</Badge>
          </div>
          <DialogDescription>
            {kind === 'open' && '录入首次开通的会员套餐、收款金额及开通时间。'}
            {kind === 'renew' && '为到期账号续费一个自然月，续费后到期时间将自动顺延。'}
            {kind === 'upgrade' && '升级至更高规格套餐。旧套餐历史将完整保留，新套餐自本次开通时间起算。'}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={e => {
            e.preventDefault()
            void handleSave()
          }}
          className="crm-form-body"
        >
          {/* Target Account Summary Banner */}
          <div className="rounded-lg border bg-muted/30 p-3 text-xs flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">当前账号：</span>
              <strong className="font-mono text-foreground">{account.account}</strong>
            </div>
            {account.plan_name && (
              <Badge variant="outline" className="text-xs">
                当前: {account.plan_name}
              </Badge>
            )}
          </div>

          <fieldset disabled={busy} className="flex flex-col gap-4">
            <div className="crm-form-grid-2">
              <div className="crm-control-group">
                <Label>选择会员套餐</Label>
                <Select
                  value={plan}
                  onValueChange={v => { if (v !== null) setPlan(String(v)) }}
                  items={options}
                  disabled={busy}
                >
                  <SelectTrigger className="w-full" aria-label="选择会员套餐">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="motion-popover" alignItemWithTrigger={false}>
                    {options.map(o => (
                      <SelectItem value={o.value} key={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="crm-control-group">
                <Label htmlFor="crm-sub-amount">
                  本次实收金额（元） <span className="text-destructive">*</span>
                </Label>
                <div className="relative flex items-center">
                  <span className="absolute left-3 text-muted-foreground text-sm font-semibold">¥</span>
                  <Input
                    id="crm-sub-amount"
                    className="pl-7"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                    required
                    maxLength={12}
                    placeholder="0.00"
                    inputMode="decimal"
                  />
                </div>
              </div>
            </div>

            <div className="crm-form-grid-2">
              <div className="crm-control-group">
                <div className="flex items-center justify-between">
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="ml-auto text-xs p-0 h-auto"
                    onClick={() => setOpened(inputTime(Date.now()))}
                  >
                    设为当前时间
                  </Button>
                </div>
                <DateTimePicker
                  id="crm-sub-time"
                  label="开通时间（北京时间）"
                  value={opened}
                  onChange={setOpened}
                />
              </div>

              {/* Automatic Expiry Preview Card */}
              <div className="crm-control-group">
                <Label>自动计算到期时间</Label>
                <div className="flex h-9 w-full items-center rounded-md border bg-muted/20 px-3 text-xs font-mono text-foreground">
                  {calculatedExpiry ? formatDateTime(calculatedExpiry) : '—'}
                </div>
              </div>
            </div>

            <div className="crm-calculated-card">
              <div className="flex items-center gap-2">
                <Clock className="size-4 text-primary" />
                <div className="text-xs">
                  <span className="font-medium text-foreground">计费周期说明：</span>
                  <span className="text-muted-foreground">
                    每次开通为 1 个自然月。
                    {kind === 'upgrade'
                      ? '升级后自本次开通时间起重新计算到期日。'
                      : '系统不支持提前续费，到期后续费从开通时间顺延。'}
                  </span>
                </div>
              </div>
            </div>

            <div className="crm-control-group">
              <Label htmlFor="crm-sub-note">开通备注（选填）</Label>
              <Textarea
                id="crm-sub-note"
                value={note}
                onChange={e => setNote(e.target.value)}
                maxLength={2000}
                rows={2}
                placeholder="例如：微信转账付款、首月优惠、续费赠送等..."
              />
            </div>
          </fieldset>

          <Feedback error={error} />

          <DialogFooter className="mt-2">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={busy || !plan}>
              {busy ? '正在保存…' : `确认保存${kindInfo.label}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* =========================================================================
   Component 4: CustomerInspector (Modal View with Tabs & Full Controls)
   ========================================================================= */

function CustomerInspector({
  endpoint,
  id,
  plans,
  onClose,
  onUpdated,
}: {
  endpoint: string
  id: string
  plans: CustomerList['plans']
  onClose: () => void
  onUpdated: () => void
}) {
  const [revision, setRevision] = useState(0)
  const { data, error, loading } = useResource<CustomerDetail>(`${endpoint}/${id}`, revision)

  // Sub-dialog states
  const [customerEditOpen, setCustomerEditOpen] = useState(false)
  const [accountDialogState, setAccountDialogState] = useState<{ open: boolean; account?: CustomerAccount }>({
    open: false,
  })
  const [subscriptionDialogState, setSubscriptionDialogState] = useState<{
    open: boolean
    account?: CustomerAccount
    kind: 'open' | 'renew' | 'upgrade'
  }>({ open: false, kind: 'open' })

  const handleSavedRefresh = () => {
    setRevision(v => v + 1)
    onUpdated()
  }

  const c = data?.customer

  return (
    <TooltipProvider>
      <Dialog open onOpenChange={open => { if (!open) onClose() }}>
        <DialogContent className="crm-inspector-dialog motion-dialog">
          {/* Header */}
          <div className="crm-dialog-header">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                {c && (
                  <div className="crm-avatar" style={{ background: getAvatarBg(c.name) }}>
                    {c.name.slice(0, 1)}
                  </div>
                )}
                <div>
                  <div className="flex items-center gap-2">
                    <DialogTitle className="text-lg font-bold">{c?.name || '客户详情'}</DialogTitle>
                    {c && (
                      <Badge variant="secondary" className="gap-1 font-normal">
                        <Building2 className="size-3" />
                        {c.partner_name || '平台直营'}
                      </Badge>
                    )}
                    {c?.source && (
                      <Badge variant="outline" className="text-xs font-normal">
                        来源: {c.source}
                      </Badge>
                    )}
                  </div>
                  <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                    客户编号: {id}
                  </DialogDescription>
                </div>
              </div>

              {c && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => setCustomerEditOpen(true)}
                  >
                    <Pencil className="size-3.5" />
                    修改客户资料
                  </Button>
                </div>
              )}
            </div>
          </div>

          <div className="crm-dialog-scrollable">
            <Feedback error={error} loading={loading} data={data} />

            {data && c && (
              <>
                {/* Contact & Overview Quick Card */}
                <div className="crm-info-banner">
                  <div className="crm-contacts-cluster">
                    {contacts.map(item => {
                      const val = c[item.key]
                      if (!val) return null
                      const Icon = item.icon
                      return (
                        <div key={item.key} className="crm-contact-chip">
                          <Icon className={`size-3.5 ${item.color}`} />
                          <span className="font-medium">{item.label}：</span>
                          <span className="font-mono">{val}</span>
                          <InlineCopy value={val} label={item.label} />
                        </div>
                      )
                    })}
                  </div>

                  <div className="flex items-center gap-4 text-xs font-medium">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Layers className="size-4" />
                      <span>{data.accounts.length} 个账号</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                      <Wallet className="size-4" />
                      <span>累计实付 {money(data.subscriptions.reduce((total, s) => total + s.paid_cents, 0))}</span>
                    </div>
                  </div>
                </div>

                {/* Customer Note if present */}
                {c.note && (
                  <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs leading-relaxed text-foreground">
                    <strong className="text-amber-600 dark:text-amber-400">客户备注：</strong>
                    <span className="whitespace-pre-wrap">{c.note}</span>
                  </div>
                )}

                {/* Tabs: Accounts & History */}
                <Tabs defaultValue="accounts" className="w-full">
                  <div className="crm-inspector-toolbar flex items-center justify-between pb-2 border-b">
                    <TabsList variant="line" className="h-9" aria-label="客户详情导航">
                      <TabsTrigger value="accounts" className="gap-1.5">
                        <Users className="size-3.5" />
                        会员账号与订阅
                        <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[10px]">
                          {data.accounts.length}
                        </Badge>
                      </TabsTrigger>
                      <TabsTrigger value="history" className="gap-1.5">
                        <Clock className="size-3.5" />
                        开通与续费明细
                        <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-[10px]">
                          {data.subscriptions.length}
                        </Badge>
                      </TabsTrigger>
                    </TabsList>

                    <Button
                      size="sm"
                      className="gap-1.5 h-8"
                      onClick={() => setAccountDialogState({ open: true })}
                    >
                      <Plus className="size-3.5" />
                      添加会员账号
                    </Button>
                  </div>

                  {/* Tab 1: Accounts List */}
                  <TabsContent value="accounts" className="pt-4 flex flex-col gap-3">
                    {!data.accounts.length ? (
                      <div className="text-center py-12 border rounded-xl border-dashed bg-muted/10">
                        <Layers className="size-8 mx-auto text-muted-foreground mb-3 opacity-60" />
                        <h4 className="font-semibold text-sm mb-1">尚未添加会员账号</h4>
                        <p className="text-xs text-muted-foreground mb-4">
                          添加客户实际使用的账号邮箱或标识后，即可为其录入首次开通。
                        </p>
                        <Button
                          size="sm"
                          onClick={() => setAccountDialogState({ open: true })}
                          className="gap-1.5"
                        >
                          <Plus className="size-3.5" />
                          立即添加第一个账号
                        </Button>
                      </div>
                    ) : (
                      <div className="crm-accounts-list">
                        {data.accounts.map(acc => {
                          const isExpired = acc.expires_at !== null && acc.expires_at <= data.asOf
                          const canRenew = acc.current_subscription_id && isExpired
                          const canUpgrade = acc.current_subscription_id && acc.plan !== 'pro-25x'

                          return (
                            <div key={acc.id} className="crm-account-card">
                              {/* Account Header */}
                              <div className="crm-account-header">
                                <div className="flex items-center gap-2">
                                  <div className="flex items-center gap-1.5 font-mono font-semibold text-sm">
                                    <span>{acc.account}</span>
                                    <InlineCopy value={acc.account} label="账号" />
                                  </div>
                                  <Badge variant="secondary" className="font-medium">
                                    {acc.plan_name || '未开通会员'}
                                  </Badge>
                                </div>

                                <AccountExpiryBadge value={acc.expires_at} now={data.asOf} />
                              </div>

                              {/* Account Metrics Grid */}
                              <div className="crm-account-metrics-grid">
                                <div className="crm-account-metric-item">
                                  <span className="crm-account-metric-label">本期开通时间</span>
                                  <span className="crm-account-metric-val">{formatDateTime(acc.opened_at)}</span>
                                </div>
                                <div className="crm-account-metric-item">
                                  <span className="crm-account-metric-label">会员到期时间</span>
                                  <span className="crm-account-metric-val">{formatDateTime(acc.expires_at)}</span>
                                </div>
                                <div className="crm-account-metric-item">
                                  <span className="crm-account-metric-label">本期付款金额</span>
                                  <span className="crm-account-metric-val font-semibold text-foreground">
                                    {acc.paid_cents === null ? '—' : money(acc.paid_cents)}
                                  </span>
                                </div>
                              </div>

                              {/* Account Note if present */}
                              {acc.note && (
                                <div className="px-5 pb-3 text-xs text-muted-foreground flex items-start gap-1.5">
                                  <span className="font-medium text-foreground">账号备注:</span>
                                  <span>{acc.note}</span>
                                </div>
                              )}

                              {/* Account Actions Bar */}
                              <div className="crm-account-actions-bar">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 gap-1 text-xs"
                                  onClick={() => setAccountDialogState({ open: true, account: acc })}
                                >
                                  <Pencil className="size-3" />
                                  修改账号
                                </Button>

                                {!acc.current_subscription_id ? (
                                  <Button
                                    size="sm"
                                    className="h-8 gap-1.5 text-xs bg-primary text-primary-foreground hover:bg-primary/90"
                                    onClick={() =>
                                      setSubscriptionDialogState({
                                        open: true,
                                        account: acc,
                                        kind: 'open',
                                      })
                                    }
                                  >
                                    <Sparkles className="size-3.5" />
                                    录入首次开通
                                  </Button>
                                ) : (
                                  <>
                                    <Tooltip>
                                      <TooltipTrigger
                                        render={
                                          <span>
                                            <Button
                                              variant="outline"
                                              size="sm"
                                              className="h-8 gap-1 text-xs"
                                              disabled={!canRenew}
                                              onClick={() =>
                                                setSubscriptionDialogState({
                                                  open: true,
                                                  account: acc,
                                                  kind: 'renew',
                                                })
                                              }
                                            >
                                              <RefreshCw className="size-3" />
                                              续费
                                            </Button>
                                          </span>
                                        }
                                      />
                                      {!canRenew && (
                                        <TooltipContent className="crm-motion-tooltip">
                                          会员尚未到期，系统不支持提前续费；到期后即可办理续费。
                                        </TooltipContent>
                                      )}
                                    </Tooltip>

                                    <Tooltip>
                                      <TooltipTrigger
                                        render={
                                          <span>
                                            <Button
                                              variant="outline"
                                              size="sm"
                                              className="h-8 gap-1 text-xs"
                                              disabled={!canUpgrade}
                                              onClick={() =>
                                                setSubscriptionDialogState({
                                                  open: true,
                                                  account: acc,
                                                  kind: 'upgrade',
                                                })
                                              }
                                            >
                                              <ArrowUpRight className="size-3" />
                                              升级套餐
                                            </Button>
                                          </span>
                                        }
                                      />
                                      {!canUpgrade && (
                                        <TooltipContent className="crm-motion-tooltip">
                                          当前账号已是最高规格套餐 Pro 25×
                                        </TooltipContent>
                                      )}
                                    </Tooltip>
                                  </>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </TabsContent>

                  {/* Tab 2: Subscriptions History Table */}
                  <TabsContent value="history" className="pt-4">
                    {!data.subscriptions.length ? (
                      <div className="text-center py-10 border rounded-xl border-dashed bg-muted/10">
                        <Clock className="size-8 mx-auto text-muted-foreground mb-2 opacity-50" />
                        <p className="text-xs text-muted-foreground">尚未录入开通、续费或升级记录。</p>
                      </div>
                    ) : (
                      <div className="rounded-lg border overflow-hidden">
                        <Table>
                          <TableHeader>
                            <TableRow className="bg-muted/40">
                              <TableHead>关联账号</TableHead>
                              <TableHead>记录类型</TableHead>
                              <TableHead>开通套餐</TableHead>
                              <TableHead>服务周期（北京时间）</TableHead>
                              <TableHead className="text-right">实付金额</TableHead>
                              <TableHead>开通备注</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {data.subscriptions.map(s => {
                              const accName = data.accounts.find(a => a.id === s.account_id)?.account
                              const kindObj = kindLabels[s.kind]
                              return (
                                <TableRow key={s.id}>
                                  <TableCell className="font-mono text-xs font-medium">
                                    {accName || '—'}
                                  </TableCell>
                                  <TableCell>
                                    <Badge variant={kindObj.variant} className="text-[11px]">
                                      {kindObj.label}
                                    </Badge>
                                  </TableCell>
                                  <TableCell className="font-medium">{s.plan_name}</TableCell>
                                  <TableCell className="text-xs">
                                    <div>{formatDateTime(s.opened_at)}</div>
                                    <div className="text-muted-foreground">
                                      至 {formatDateTime(s.expires_at)}
                                    </div>
                                  </TableCell>
                                  <TableCell className="text-right font-mono font-semibold text-foreground">
                                    {money(s.paid_cents)}
                                  </TableCell>
                                  <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                                    {s.note || '—'}
                                  </TableCell>
                                </TableRow>
                              )
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </TabsContent>
                </Tabs>
              </>
            )}
          </div>
        </DialogContent>
      {/* Embedded Sub-Dialogs for seamless in-place editing */}
      {c && customerEditOpen && (
        <CustomerFormDialog
          endpoint={endpoint}
          customer={c}
          open={customerEditOpen}
          onClose={() => setCustomerEditOpen(false)}
          onSaved={handleSavedRefresh}
        />
      )}

      {accountDialogState.open && (
        <AccountFormDialog
          endpoint={endpoint}
          customerId={id}
          account={accountDialogState.account}
          open={accountDialogState.open}
          onClose={() => setAccountDialogState({ open: false })}
          onSaved={handleSavedRefresh}
        />
      )}

      {subscriptionDialogState.open && subscriptionDialogState.account && (
        <SubscriptionFormDialog
          endpoint={endpoint}
          account={subscriptionDialogState.account}
          kind={subscriptionDialogState.kind}
          plans={plans}
          open={subscriptionDialogState.open}
          onClose={() => setSubscriptionDialogState({ open: false, kind: 'open' })}
          onSaved={handleSavedRefresh}
        />
      )}
      </Dialog>
    </TooltipProvider>
  )
}

/* =========================================================================
   Component 5: Main CustomerManagement Component
   ========================================================================= */

export default function CustomerManagement({
  admin = false,
  revision,
}: {
  admin?: boolean
  revision: number
}) {
  const endpoint = admin ? '/api/admin/customers' : '/api/partner/customers'

  // Filter states
  const [filters, setFilters] = useState({
    q: '',
    plan: 'all',
    expiry: 'all',
    partner: 'all',
  })
  const [applied, setApplied] = useState('')
  const [page, setPage] = useState(1)
  const [localRevision, setLocalRevision] = useState(0)

  // Data resource
  const { data, error, loading } = useResource<CustomerList>(
    `${endpoint}?${applied}&page=${page}`,
    revision + localRevision
  )

  // Modals & export
  const [createOpen, setCreateOpen] = useState(false)
  const [detailId, setDetailId] = useState<string>()
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')

  const updated = () => setLocalRevision(v => v + 1)

  // Execute Search
  const applyFilters = (customFilters = filters) => {
    const params = new URLSearchParams()
    if (customFilters.q.trim()) params.set('q', customFilters.q.trim())
    if (customFilters.plan !== 'all') params.set('plan', customFilters.plan)
    if (customFilters.expiry !== 'all') params.set('expiry', customFilters.expiry)
    if (admin && customFilters.partner !== 'all') params.set('partner', customFilters.partner)

    setApplied(params.toString())
    setPage(1)
    updated()
  }

  // Quick Expiry Status Click
  const handleQuickStatus = (statusKey: string) => {
    const nextFilters = { ...filters, expiry: statusKey }
    setFilters(nextFilters)
    applyFilters(nextFilters)
  }

  // Reset Filters
  const handleResetFilters = () => {
    const reset = { q: '', plan: 'all', expiry: 'all', partner: 'all' }
    setFilters(reset)
    setApplied('')
    setPage(1)
    updated()
  }

  // Export Excel
  async function exportExcel() {
    if (exporting) return
    setExporting(true)
    setExportError('')
    try {
      const records = await api<CustomerExport>(`${endpoint}/export?${applied}`)
      const { downloadCustomers } = await import('@/lib/customer-export')
      await downloadCustomers(records)
    } catch (e) {
      setExportError(errorMessage(e))
    } finally {
      setExporting(false)
    }
  }

  const isFiltersDirty = filters.q || filters.plan !== 'all' || filters.expiry !== 'all' || (admin && filters.partner !== 'all')
  const totalPages = data ? Math.max(1, Math.ceil(data.total / 20)) : 1

  return (
    <div className="crm-container state-enter">
      {/* Top Banner & Main Actions */}
      <Card className="crm-header-panel">
        <CardHeader className="crm-header-row">
          <div>
            <CardTitle className="text-xl font-bold flex items-center gap-2">
              <Users className="size-5 text-primary" />
              {admin ? '客户管理中心' : '我的客户管理'}
            </CardTitle>
            {!admin && <CardDescription className="mt-1">自主管理所属客户的会员账号、开通续费记录与到期提醒，全流程清晰可查。</CardDescription>}
          </div>

          <div className="crm-header-actions">
            <Button
              variant="outline"
              disabled={exporting || loading || !data?.total}
              onClick={() => void exportExcel()}
              className="gap-1.5"
              aria-label={exporting ? '正在生成 Excel' : '导出 Excel'}
            >
              <Download className="size-4" />
              <span className="crm-action-label">{exporting ? '正在生成 Excel…' : '导出 Excel'}</span>
            </Button>

            <Button
              onClick={() => setCreateOpen(true)}
              disabled={!data}
              className="gap-1.5"
              aria-label="添加客户"
            >
              <Plus className="size-4" />
              <span className="crm-action-label">添加客户</span>
            </Button>
          </div>
        </CardHeader>
      </Card>

      <Feedback error={error || exportError} loading={loading} data={data} />

      {data && (
        <>
          {/* KPI Metrics Interactive Grid */}
          <div className="crm-metrics-grid">
            <Card
              className="crm-metric-card"
              data-active={filters.expiry === 'all' && !filters.q && filters.plan === 'all'}
              title="点击查看全部到期状态"
            >
              <Button type="button" variant="ghost" className="crm-metric-action" aria-label="查看全部到期状态" aria-pressed={filters.expiry === 'all'} onClick={() => handleQuickStatus('all')} />
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <span className="text-xs text-muted-foreground block mb-1">客户总数</span>
                  <strong className="text-2xl font-bold tracking-tight text-foreground font-mono">
                    {data.stats.customers}
                  </strong>
                </div>
                <div className="crm-metric-icon-wrap bg-blue-500/10 text-blue-600 dark:text-blue-400">
                  <Users className="size-5" />
                </div>
              </CardContent>
            </Card>

            <Card className="crm-metric-card">
              <Button type="button" variant="ghost" className="crm-metric-action" aria-label="查看管理账号所属客户" onClick={() => handleQuickStatus('all')} />
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <span className="text-xs text-muted-foreground block mb-1">管理账号</span>
                  <strong className="text-2xl font-bold tracking-tight text-foreground font-mono">
                    {data.stats.accounts}
                  </strong>
                </div>
                <div className="crm-metric-icon-wrap bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                  <Layers className="size-5" />
                </div>
              </CardContent>
            </Card>

            <Card
              className={`crm-metric-card ${data.stats.soon > 0 ? 'border-amber-500/40 bg-amber-500/5' : ''}`}
              data-active={filters.expiry === 'soon'}
              title="点击筛选 7 天内即将到期账号"
            >
              <Button type="button" variant="ghost" className="crm-metric-action" aria-label="查看 7 天内到期客户" aria-pressed={filters.expiry === 'soon'} onClick={() => handleQuickStatus('soon')} />
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <span className="text-xs text-muted-foreground block mb-1 flex items-center gap-1">
                    7 天内到期
                    {data.stats.soon > 0 && (
                      <span className="size-2 rounded-full bg-amber-500" />
                    )}
                  </span>
                  <strong className="text-2xl font-bold tracking-tight text-amber-600 dark:text-amber-400 font-mono">
                    {data.stats.soon}
                  </strong>
                </div>
                <div className="crm-metric-icon-wrap bg-amber-500/10 text-amber-600 dark:text-amber-400">
                  <Clock className="size-5" />
                </div>
              </CardContent>
            </Card>

            <Card
              className={`crm-metric-card ${data.stats.expired > 0 ? 'border-destructive/40 bg-destructive/5' : ''}`}
              data-active={filters.expiry === 'expired'}
              title="点击筛选已到期待续费账号"
            >
              <Button type="button" variant="ghost" className="crm-metric-action" aria-label="查看已到期客户" aria-pressed={filters.expiry === 'expired'} onClick={() => handleQuickStatus('expired')} />
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <span className="text-xs text-muted-foreground block mb-1 flex items-center gap-1">
                    已到期待续费
                    {data.stats.expired > 0 && (
                      <span className="size-2 rounded-full bg-destructive" />
                    )}
                  </span>
                  <strong className="text-2xl font-bold tracking-tight text-destructive font-mono">
                    {data.stats.expired}
                  </strong>
                </div>
                <div className="crm-metric-icon-wrap bg-destructive/10 text-destructive">
                  <AlertCircle className="size-5" />
                </div>
              </CardContent>
            </Card>

            <Card className="crm-metric-card crm-metric-static">
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <span className="text-xs text-muted-foreground block mb-1">累计实付收款</span>
                  <strong className="text-xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400 font-mono">
                    {money(data.stats.paid_cents)}
                  </strong>
                </div>
                <div className="crm-metric-icon-wrap bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                  <Wallet className="size-5" />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Search & Filter Panel */}
          <Card className="crm-filter-card">
            <CardContent className="p-4">
              <form
                onSubmit={e => {
                  e.preventDefault()
                  applyFilters()
                }}
                className="crm-filters-form"
              >
                {/* Status Quick Filter Tabs */}
                <div className="crm-quick-pills">
                  <span className="text-xs text-muted-foreground mr-1">快捷筛选:</span>
                  {[
                    { id: 'all', label: '全部客户' },
                    { id: 'soon', label: '7 天内到期', count: data.stats.soon, alert: 'amber' },
                    { id: 'expired', label: '已到期', count: data.stats.expired, alert: 'red' },
                    { id: 'active', label: '正常生效中' },
                    { id: 'none', label: '未录入会员' },
                  ].map(tab => (
                    <Button
                      key={tab.id}
                      type="button"
                      variant={filters.expiry === tab.id ? 'default' : 'outline'}
                      size="sm"
                      className="h-7 text-xs rounded-full gap-1 px-3"
                      onClick={() => handleQuickStatus(tab.id)}
                    >
                      <span>{tab.label}</span>
                      {tab.count !== undefined && tab.count > 0 && (
                        <span
                          className={`ml-0.5 rounded-full px-1.5 py-0.2 text-[10px] font-bold ${
                            filters.expiry === tab.id
                              ? 'bg-primary-foreground text-primary'
                              : tab.alert === 'red'
                              ? 'bg-destructive/15 text-destructive'
                              : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                          }`}
                        >
                          {tab.count}
                        </span>
                      )}
                    </Button>
                  ))}
                </div>

                {/* Filter Controls Grid */}
                <div className={`crm-filter-controls-row ${admin ? 'crm-filter-controls-admin' : ''}`}>
                  <div className="crm-control-group">
                    <Label htmlFor="crm-search-input">搜索关键词</Label>
                    <div className="relative flex items-center">
                      <Search className="absolute left-3 size-4 text-muted-foreground pointer-events-none" />
                      <Input
                        id="crm-search-input"
                        className="pl-9 pr-8 h-9"
                        value={filters.q}
                        onChange={e => setFilters(v => ({ ...v, q: e.target.value }))}
                        placeholder="姓名、微信号、QQ、邮箱、账号或备注"
                        maxLength={100}
                      />
                      {filters.q && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label="清除搜索关键词"
                          className="absolute right-2.5 text-muted-foreground hover:text-foreground cursor-pointer"
                          onClick={() => {
                            const next = { ...filters, q: '' }
                            setFilters(next)
                            applyFilters(next)
                          }}
                        >
                          <X className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="crm-control-group">
                    <Label>套餐种类</Label>
                    <Select
                      value={filters.plan}
                      onValueChange={v => { if (v !== null) setFilters(old => ({ ...old, plan: String(v) })) }}
                      items={[
                        { value: 'all', label: '全部套餐' },
                        ...data.plans.map(p => ({ value: p.id, label: p.name })),
                      ]}
                    >
                      <SelectTrigger className="w-full h-9" aria-label="套餐种类">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="motion-popover" alignItemWithTrigger={false}>
                        <SelectItem value="all">全部套餐</SelectItem>
                        {data.plans.map(p => (
                          <SelectItem value={p.id} key={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {admin && (
                    <div className="crm-control-group">
                      <Label>所属渠道 / 代理</Label>
                      <Select
                        value={filters.partner}
                        onValueChange={v => { if (v !== null) setFilters(old => ({ ...old, partner: String(v) })) }}
                        items={[
                          { value: 'all', label: '全部渠道' },
                          { value: 'direct', label: '平台直营' },
                          ...data.partners.map(p => ({ value: p.id, label: p.name })),
                        ]}
                      >
                        <SelectTrigger className="w-full h-9" aria-label="所属渠道 / 代理">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="motion-popover" alignItemWithTrigger={false}>
                          <SelectItem value="all">全部渠道</SelectItem>
                          <SelectItem value="direct">平台直营</SelectItem>
                          {data.partners.map(p => (
                            <SelectItem value={p.id} key={p.id}>
                              代理 · {p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <Button type="submit" disabled={loading} className="gap-1.5 h-9">
                      <Search className="size-4" />
                      查询
                    </Button>
                    {isFiltersDirty && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={handleResetFilters}
                        className="gap-1.5 h-9 text-muted-foreground hover:text-foreground"
                      >
                        <RotateCcw className="size-4" />
                        重置
                      </Button>
                    )}
                  </div>
                </div>
              </form>
            </CardContent>
          </Card>

          {/* Customer Table */}
          <Card className="crm-table-card">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead className="w-[200px]">客户资料</TableHead>
                  <TableHead className="min-w-[190px]">联系方式</TableHead>
                  {admin && <TableHead className="w-[120px]">所属渠道</TableHead>}
                  <TableHead className="min-w-[170px]">绑定账号与套餐</TableHead>
                  <TableHead className="min-w-[180px]">到期状态与提醒</TableHead>
                  <TableHead className="text-right w-[110px]">累计实付</TableHead>
                  <TableHead className="w-[110px]">客户来源</TableHead>
                  <TableHead className="text-right w-[100px]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.customers.map(c => {
                  return (
                    <TableRow key={c.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setDetailId(c.id)}>
                      {/* Customer Info */}
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <div className="crm-avatar" style={{ background: getAvatarBg(c.name) }}>
                            {c.name.slice(0, 1)}
                          </div>
                          <div className="min-w-0">
                            <div className="font-semibold text-foreground flex items-center gap-1.5">
                              <span>{c.name}</span>
                            </div>
                            {c.note && (
                              <p className="text-xs text-muted-foreground truncate max-w-[160px] mt-0.5" title={c.note}>
                                {c.note}
                              </p>
                            )}
                          </div>
                        </div>
                      </TableCell>

                      {/* Contact Info */}
                      <TableCell onClick={e => e.stopPropagation()}>
                        <div className="flex flex-col gap-1.5">
                          {contacts
                            .filter(v => c[v.key])
                            .map(v => {
                              const Icon = v.icon
                              return (
                                <div key={v.key} className="flex items-center gap-1.5 text-xs">
                                  <Icon className={`size-3.5 ${v.color} shrink-0`} />
                                  <span className="font-mono text-foreground">{c[v.key]}</span>
                                  <InlineCopy value={c[v.key]} label={v.label} />
                                </div>
                              )
                            })}
                        </div>
                      </TableCell>

                      {/* Channel (Admin only) */}
                      {admin && (
                        <TableCell>
                          <Badge variant="secondary" className="font-normal text-xs">
                            {c.partner_name || '平台直营'}
                          </Badge>
                        </TableCell>
                      )}

                      {/* Accounts & Plans */}
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <div className="font-medium text-xs text-foreground flex items-center gap-1.5">
                            <Badge variant="outline" className="px-1.5 py-0 text-[11px]">
                              {c.account_count} 个账号
                            </Badge>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {c.plan_names || '未开通会员'}
                          </div>
                        </div>
                      </TableCell>

                      {/* Expiry Health */}
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <div>
                            {c.expired_count > 0 ? (
                              <Badge variant="destructive" className="text-[11px] gap-1">
                                <AlertCircle className="size-3" />
                                {c.expired_count} 个已到期
                              </Badge>
                            ) : null}
                            {c.soon_count > 0 ? (
                              <Badge variant="secondary" className="text-[11px] gap-1 border-amber-500/30 bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                                <Clock className="size-3 text-amber-500" />
                                {c.soon_count} 个 7天内到期
                              </Badge>
                            ) : null}
                            {!c.expired_count && !c.soon_count && (c.next_expiry ? (
                              <Badge variant="outline" className="text-[11px] border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
                                正常生效中
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-[11px] text-muted-foreground">
                                未录入会员
                              </Badge>
                            ))}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {c.next_expiry ? `最近到期: ${formatDateOnly(c.next_expiry)}` : '添加账号后录入'}
                          </div>
                        </div>
                      </TableCell>

                      {/* Total Paid */}
                      <TableCell className="text-right font-mono font-semibold text-foreground">
                        {money(c.paid_cents)}
                      </TableCell>

                      {/* Source */}
                      <TableCell className="text-xs text-muted-foreground">
                        {c.source || '—'}
                      </TableCell>

                      {/* Action */}
                      <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1 text-xs"
                          onClick={() => setDetailId(c.id)}
                        >
                          管理详情
                          <ChevronRight className="size-3" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>

            {/* Empty State */}
            {!data.total && (
              <div className="text-center py-16 px-4">
                <Users className="size-12 mx-auto text-muted-foreground/50 mb-3" />
                <h3 className="font-semibold text-base mb-1">
                  {applied ? '没有找到匹配的客户档案' : '还没有录入客户记录'}
                </h3>
                <p className="text-xs text-muted-foreground max-w-sm mx-auto mb-4">
                  {applied
                    ? '试试调整搜索关键词、套餐分类或清空到期状态筛选。'
                    : '点击右上角“添加客户”，录入客户联系方式并绑定其会员账号。'}
                </p>
                {applied ? (
                  <Button variant="outline" size="sm" onClick={handleResetFilters} className="gap-1.5">
                    <RotateCcw className="size-3.5" />
                    清空筛选条件
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
                    <Plus className="size-3.5" />
                    立即添加客户
                  </Button>
                )}
              </div>
            )}

            {/* Pagination & Footer Bar */}
            {data.total > 0 && (
              <div className="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground flex-wrap gap-3">
                <div className="flex items-center gap-1.5">
                  <span>共 <strong className="text-foreground font-mono">{data.total}</strong> 位客户</span>
                  <span>·</span>
                  <span>
                    第 <strong className="text-foreground font-mono">{page}</strong> / {totalPages} 页
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs gap-1"
                    disabled={page <= 1 || loading}
                    onClick={() => setPage(p => p - 1)}
                  >
                    <ChevronLeft className="size-3.5" />
                    上一页
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs gap-1"
                    disabled={page >= totalPages || loading}
                    onClick={() => setPage(p => p + 1)}
                  >
                    下一页
                    <ChevronRight className="size-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </Card>

        </>
      )}

      {/* Main Creation Dialog */}
      {createOpen && data && (
        <CustomerFormDialog
          endpoint={endpoint}
          partners={admin ? data.partners : undefined}
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onSaved={id => {
            setCreateOpen(false)
            updated()
            setDetailId(id)
          }}
        />
      )}

      {/* Customer Full-Featured Inspector Drawer/Dialog */}
      {detailId && data && (
        <CustomerInspector
          key={detailId}
          endpoint={endpoint}
          id={detailId}
          plans={data.plans}
          onClose={() => setDetailId(undefined)}
          onUpdated={updated}
        />
      )}
    </div>
  )
}
