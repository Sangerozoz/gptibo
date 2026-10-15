import { ApiError, body, json, type Env, type Value } from './platform.ts'
import { requirePartner, partnerLimit } from './partner-auth.ts'
import { paymentProvider } from './payments/providers.ts'
import type { PaymentProvider, PaymentResult } from './payments/types.ts'
import { INVOICE_STATUSES, invoiceAmounts, type Invoice, type InvoicePaymentView } from '../shared/invoices.ts'
import { invoicePlatformPayload } from './invoice-platform.ts'

type StoredInvoice = Invoice & { lease_token: string | null; lease_until: number }
type Payment = {
  id: string; invoice_id: string; provider: string; account: string; amount_cents: number
  state: 'pending' | 'paid' | 'closed'; qr: string | null; trade_no: string | null; expires_at: number
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
const getInvoice = (env: Env, id: string) => env.INTEREST_DB.prepare('SELECT * FROM partner_invoices WHERE id=?').bind(id).first<StoredInvoice>()
const currentPayment = (env: Env, id: string) => env.INTEREST_DB.prepare("SELECT * FROM invoice_payments WHERE invoice_id=? ORDER BY CASE state WHEN 'paid' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,created_at DESC LIMIT 1").bind(id).first<Payment>()
function publicInvoice(row: StoredInvoice) {
  const { lease_token: _token, lease_until: _until, ...invoice } = row
  return invoice
}
function text(value: unknown, max: number, required = false) {
  if (value !== undefined && typeof value !== 'string') throw new ApiError('填写信息格式不正确。')
  const result = (value as string | undefined)?.trim() ?? ''
  if (result.length > max || (required && !result)) throw new ApiError(`请完整填写开票信息，单项最多 ${max} 字。`)
  return result
}
function notifyUrl(env: Env) {
  let url: URL
  try { url = new URL(env.PAYMENT_NOTIFY_ORIGIN ?? '') } catch { throw new ApiError('尚未配置支付宝回调域名。', 503) }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new ApiError('支付宝回调域名配置无效。', 503)
  return `${url.origin}/api/invoices/notify/alipay`
}
function providerFor(env: Env, p: Payment) {
  const provider = paymentProvider(env, p.provider)
  if (provider.account !== p.account) throw new ApiError('请恢复原支付商户配置后再处理该申请。', 503)
  return provider
}
const paymentOrder = (p: Payment) => ({ id: p.id, amountCents: p.amount_cents, subject: '硅基生物 · 开票手续费', expiresAt: p.expires_at })
function paymentView(p: Payment | null, invoice: Invoice): InvoicePaymentView | null {
  return p ? { status: p.state, amountCents: p.amount_cents, expiresAt: p.expires_at, qr: invoice.status === 'awaiting_payment' && p.state === 'pending' && p.expires_at > Date.now() ? p.qr : null } : null
}

export async function applyInvoicePayment(env: Env, p: Payment, result: PaymentResult) {
  if (result.orderId !== p.id || result.amountCents !== p.amount_cents || (p.trade_no && result.tradeNo && p.trade_no !== result.tradeNo)) throw new ApiError('支付结果与开票申请不匹配。', 409)
  if (result.status === 'pending' || result.status === 'not_found') return
  if (result.status === 'paid' && !result.tradeNo) throw new ApiError('支付流水缺失。', 409)
  const invoice = await getInvoice(env, p.invoice_id)
  if (!invoice || invoice.fee_cents !== p.amount_cents) throw new ApiError('手续费金额不匹配。', 409)
  const now = Date.now(); const paid = result.status === 'paid'
  // Receipt, business state and history commit together. Verified late receipts
  // may advance a closed attempt, but a close can never undo paid/submitted state.
  await env.INTEREST_DB.batch([
    env.INTEREST_DB.prepare("UPDATE invoice_payments SET state=?,trade_no=COALESCE(trade_no,?),qr=NULL,updated_at=? WHERE id=? AND provider=? AND account=? AND amount_cents=? AND state<>'paid' AND (trade_no IS NULL OR trade_no=?)")
      .bind(result.status, result.tradeNo ?? null, now, p.id, p.provider, p.account, p.amount_cents, result.tradeNo ?? null),
    env.INTEREST_DB.prepare("INSERT INTO invoice_events(id,invoice_id,actor,action,note,created_at) SELECT ?,id,'payment','paid','支付宝已确认手续费到账',? FROM partner_invoices WHERE id=? AND status='awaiting_payment' AND ?=1 AND EXISTS(SELECT 1 FROM invoice_payments WHERE id=? AND state='paid' AND trade_no=?)")
      .bind(crypto.randomUUID(), now, p.invoice_id, Number(paid), p.id, result.tradeNo ?? null),
    env.INTEREST_DB.prepare("UPDATE partner_invoices SET status='awaiting_submission',paid_at=?,updated_at=?,version=version+1 WHERE id=? AND status='awaiting_payment' AND ?=1 AND EXISTS(SELECT 1 FROM invoice_payments WHERE id=? AND state='paid' AND trade_no=?)")
      .bind(now, now, p.invoice_id, Number(paid), p.id, result.tradeNo ?? null),
  ])
  const saved = await env.INTEREST_DB.prepare('SELECT trade_no FROM invoice_payments WHERE id=?').bind(p.id).first<{ trade_no: string | null }>()
  if (result.tradeNo && saved?.trade_no && result.tradeNo !== saved.trade_no) throw new ApiError('支付流水冲突。', 409)
}

async function locked<T>(env: Env, id: string, work: () => Promise<T>) {
  const token = crypto.randomUUID(); const now = Date.now()
  await env.INTEREST_DB.prepare('UPDATE partner_invoices SET lease_token=?,lease_until=? WHERE id=? AND lease_until<=?').bind(token, now + 60000, id, now).run()
  if ((await getInvoice(env, id))?.lease_token !== token) throw new ApiError('支付正在确认，请稍后重试。', 409)
  try { return await work() }
  catch (e) { if (e instanceof ApiError) throw e; throw new ApiError('支付宝暂时不可用，请稍后重新确认。', 503) }
  finally { await env.INTEREST_DB.prepare('UPDATE partner_invoices SET lease_token=NULL,lease_until=0 WHERE id=? AND lease_token=?').bind(id, token).run() }
}
async function syncPayment(env: Env, p: Payment) {
  const provider = providerFor(env, p); const order = paymentOrder(p)
  const result = await provider.query(order)
  await applyInvoicePayment(env, p, result)
  const invoice = await getInvoice(env, p.invoice_id)
  if (result.status !== 'paid' && result.status !== 'closed' && (p.expires_at <= Date.now() || invoice?.paid_at)) {
    if (await provider.close(order)) await applyInvoicePayment(env, p, { orderId: p.id, amountCents: p.amount_cents, status: 'closed' })
    else {
      const again = await provider.query(order)
      await applyInvoicePayment(env, p, again)
      if (again.status === 'not_found' && Date.now() > p.expires_at + 120000) await applyInvoicePayment(env, p, { orderId: p.id, amountCents: p.amount_cents, status: 'closed' })
    }
  }
  await env.INTEREST_DB.prepare('UPDATE invoice_payments SET updated_at=? WHERE id=?').bind(Date.now(), p.id).run()
}
async function paymentAction(env: Env, invoice: Invoice, action: unknown, admin: boolean) {
  if (!['create', 'query'].includes(String(action)) || (admin && action !== 'query')) throw new ApiError('支付操作无效。')
  await locked(env, invoice.id, async () => {
    if ((await getInvoice(env, invoice.id))!.status !== 'awaiting_payment') return
    let p = await currentPayment(env, invoice.id)
    if (p?.state === 'pending' && (action === 'query' || p.expires_at <= Date.now())) { await syncPayment(env, p); p = await currentPayment(env, invoice.id) }
    if (action !== 'create' || (await getInvoice(env, invoice.id))!.status !== 'awaiting_payment') return
    const provider = paymentProvider(env, 'alipay'); const callback = notifyUrl(env)
    if (!p || p.state === 'closed') {
      const now = Date.now(); const id = 'INV' + crypto.randomUUID().replaceAll('-', '')
      await env.INTEREST_DB.prepare("INSERT INTO invoice_payments(id,invoice_id,provider,account,amount_cents,expires_at,created_at,updated_at) SELECT ?,id,?,?,?,?,?,? FROM partner_invoices WHERE id=? AND status='awaiting_payment'")
        .bind(id, provider.id, provider.account, invoice.fee_cents, now + 900000, now, now, invoice.id).run()
      p = await currentPayment(env, invoice.id)
    }
    if (p?.state === 'pending' && !p.qr && p.expires_at > Date.now()) {
      const qr = await providerFor(env, p).create(paymentOrder(p), callback)
      await env.INTEREST_DB.prepare("UPDATE invoice_payments SET qr=?,updated_at=? WHERE id=? AND state='pending'").bind(qr.qr, Date.now(), p.id).run()
    }
  })
  const fresh = (await getInvoice(env, invoice.id))!
  return json({ invoice: publicInvoice(fresh), payment: paymentView(await currentPayment(env, invoice.id), fresh) })
}

export async function invoiceRoutes(request: Request, env: Env, url: URL, admin = false) {
  const partner = admin ? null : await requirePartner(request, env)
  const root = admin ? '/api/admin/invoices' : '/api/partner/invoices'
  const path = url.pathname.slice(root.length); const db = env.INTEREST_DB
  if (!path && request.method === 'GET') {
    const page = Number(url.searchParams.get('page') ?? 1); const status = url.searchParams.get('status') ?? ''; const q = (url.searchParams.get('q') ?? '').trim()
    if (!Number.isInteger(page) || page < 1 || page > 10000 || q.length > 100 || (status && !INVOICE_STATUSES.includes(status as Invoice['status']))) throw new ApiError('筛选条件无效。')
    const clauses = ['1=1']; const values: Value[] = []
    if (partner) { clauses.push('i.partner_id=?'); values.push(partner.id) }
    if (status) { clauses.push('i.status=?'); values.push(status) }
    if (q) { clauses.push('(instr(i.title,?)>0 OR instr(i.id,?)>0 OR instr(p.email,?)>0)'); values.push(q, q, q) }
    const from = `FROM partner_invoices i JOIN partners p ON p.id=i.partner_id WHERE ${clauses.join(' AND ')}`
    const total = await db.prepare(`SELECT COUNT(*) total ${from}`).bind(...values).first<{ total: number }>()
    const rows = (await db.prepare(`SELECT i.*,p.name partner_name,p.email partner_email ${from} ORDER BY i.created_at DESC,i.id DESC LIMIT 20 OFFSET ?`).bind(...values, (page - 1) * 20).all<StoredInvoice>()).results
    return json({ rows: rows.map(publicInvoice), total: total?.total ?? 0, page })
  }
  if (!path && request.method === 'POST' && partner) {
    const data = await body(request, 16384)
    if (!uuid(data.key) || typeof data.includeFee !== 'boolean') throw new ApiError('申请参数无效。')
    let amounts: ReturnType<typeof invoiceAmounts>
    try { amounts = invoiceAmounts(data.baseCents as number, data.includeFee) } catch (e) { throw new ApiError((e as Error).message) }
    const title = text(data.title, 200, true); const tax = text(data.taxNumber, 100);
    if (!tax) throw new ApiError('请填写税号。')
    const email = text(data.email, 254, true)
    if (data.invoiceType !== 'ordinary') throw new ApiError('目前仅支持增值税普通发票。')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError('请核对发票类型与接收邮箱。')
    const address = text(data.address, 300); const phone = text(data.phone, 50); const bank = text(data.bankName, 200); const account = text(data.bankAccount, 100); const note = text(data.note, 1000)
    const snapshot = { title, tax_number: tax, invoice_type: String(data.invoiceType), email, address, phone, bank_name: bank, bank_account: account, note, base_cents: amounts.baseCents, fee_cents: amounts.feeCents, include_fee: Number(data.includeFee), invoice_cents: amounts.invoiceCents }
    const previous = await getInvoice(env, data.key)
    if (!previous) {
      await partnerLimit(env, 'invoice-create:' + partner.id, 20, 3600000)
      const now = Date.now()
      await db.batch([
        db.prepare('INSERT INTO partner_invoices(id,partner_id,title,tax_number,invoice_type,email,address,phone,bank_name,bank_account,note,base_cents,fee_cents,include_fee,invoice_cents,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING')
          .bind(data.key, partner.id, title, tax, String(data.invoiceType), email, address, phone, bank, account, note, amounts.baseCents, amounts.feeCents, Number(data.includeFee), amounts.invoiceCents, now, now),
        db.prepare("INSERT INTO invoice_events(id,invoice_id,actor,action,note,created_at) SELECT id,id,'partner','created','代理提交开票信息',created_at FROM partner_invoices WHERE id=? AND partner_id=? ON CONFLICT(id) DO NOTHING").bind(data.key, partner.id),
      ])
    }
    const row = (await getInvoice(env, data.key))!
    if (row.partner_id !== partner.id || Object.entries(snapshot).some(([key, value]) => row[key as keyof Invoice] !== value)) throw new ApiError('申请编号已使用，请重新打开申请表。', 409)
    return json({ invoice: publicInvoice(row) }, 201)
  }
  const match = path.match(/^\/([a-f0-9-]{36})(\/payment|\/submit|\/complete)?$/)
  if (!match) throw new ApiError('未找到开票接口。', 404)
  const row = await db.prepare('SELECT i.*,p.name partner_name,p.email partner_email FROM partner_invoices i JOIN partners p ON p.id=i.partner_id WHERE i.id=?' + (partner ? ' AND i.partner_id=?' : '')).bind(match[1], ...(partner ? [partner.id] : [])).first<StoredInvoice>()
  if (!row) throw new ApiError('开票申请不存在。', 404)
  if (!match[2] && request.method === 'GET') {
    const events = (await db.prepare('SELECT * FROM invoice_events WHERE invoice_id=? ORDER BY created_at,id').bind(row.id).all()).results
    return json({ invoice: publicInvoice(row), events, payment: paymentView(await currentPayment(env, row.id), row), submission: admin ? invoicePlatformPayload(row) : undefined })
  }
  if (match[2] === '/payment' && request.method === 'POST') {
    const data = await body(request)
    await partnerLimit(env, 'invoice-payment:' + row.partner_id, 30, 60000)
    return paymentAction(env, row, data.action, admin)
  }
  if (admin && request.method === 'POST' && ['/submit', '/complete'].includes(match[2])) {
    const data = await body(request); const submit = match[2] === '/submit'
    const expected = submit ? 'awaiting_submission' : 'submitted'; const next = submit ? 'submitted' : 'completed'
    if (!Number.isSafeInteger(data.version) || row.version !== data.version || row.status !== expected || !row.paid_at) throw new ApiError('申请状态已变化，请刷新后重试。', 409)
    const reference = text(data.reference, 200); const note = text(data.note, 500)
    const event = crypto.randomUUID(); const now = Date.now()
    await db.batch([
      db.prepare("INSERT INTO invoice_events(id,invoice_id,actor,action,note,created_at) SELECT ?,id,'admin',?,?,? FROM partner_invoices WHERE id=? AND version=? AND status=? AND paid_at IS NOT NULL")
        .bind(event, submit ? 'submitted' : 'completed', note || (submit ? '已人工提交开票平台' : '平台已完成开票'), now, row.id, row.version, expected),
      db.prepare(`UPDATE partner_invoices SET status=?,${submit ? 'submitted_at' : 'completed_at'}=?,platform_reference=?,admin_note=?,updated_at=?,version=version+1 WHERE id=? AND EXISTS(SELECT 1 FROM invoice_events WHERE id=?)`)
        .bind(next, now, reference || row.platform_reference, note, now, row.id, event),
    ])
    if (!await db.prepare('SELECT id FROM invoice_events WHERE id=?').bind(event).first()) throw new ApiError('申请已更新，请刷新后重试。', 409)
    return json({ ok: true })
  }
  throw new ApiError('开票操作无效。', 405)
}

export async function invoiceNotification(request: Request, env: Env) {
  let provider: PaymentProvider | undefined
  try {
    provider = paymentProvider(env, 'alipay')
    const result = await provider.notification(request)
    const p = await env.INTEREST_DB.prepare('SELECT * FROM invoice_payments WHERE id=?').bind(result.orderId).first<Payment>()
    if (!p || p.provider !== provider.id || p.account !== provider.account) throw new Error('Unknown invoice payment')
    await applyInvoicePayment(env, p, result)
    if (result.status === 'paid') await env.INTEREST_DB.prepare("UPDATE invoice_payments SET notified_at=COALESCE(notified_at,?) WHERE id=? AND state='paid'").bind(Date.now(), p.id).run()
    return provider.acknowledge(true)
  } catch { return provider?.acknowledge(false) ?? new Response('failure', { status: 400 }) }
}
export async function reconcileInvoicePayments(env: Env) {
  const rows = (await env.INTEREST_DB.prepare("SELECT p.* FROM invoice_payments p JOIN partner_invoices i ON i.id=p.invoice_id WHERE p.state='pending' AND i.lease_until<=? ORDER BY p.updated_at LIMIT 10").bind(Date.now()).all<Payment>()).results
  let failed = 0
  for (const row of rows) {
    try { await locked(env, row.invoice_id, async () => { const fresh = await env.INTEREST_DB.prepare('SELECT * FROM invoice_payments WHERE id=?').bind(row.id).first<Payment>(); if (fresh?.state === 'pending') await syncPayment(env, fresh) }) }
    catch { failed++; await env.INTEREST_DB.prepare('UPDATE invoice_payments SET updated_at=? WHERE id=?').bind(Date.now(), row.id).run() }
  }
  return { checked: rows.length, failed }
}
