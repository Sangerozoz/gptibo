import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import worker from '../worker/index.ts'
import { retryTelegramInvitations, telegramGroups } from '../worker/telegram.ts'
import { provisionPartner } from '../worker/partner-provision.ts'
import type { Env, Statement, Value } from '../worker/platform.ts'

function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'))
  t.after(() => db.close())
  const statements = new WeakMap<Statement, { sql: string; values: Value[] }>()
  const env: Env = {
    TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_BOT_USERNAME: 'ExampleBot', TELEGRAM_WEBHOOK_SECRET: 'a'.repeat(64), TELEGRAM_ALLOWED_GROUP_IDS: '-10042',
    RESEND_API_KEY: 'test-only', RESEND_FROM: 'test@example.invalid', PUBLIC_SITE_ORIGIN: 'https://shop.example.invalid', PARTNER_AUTH_SECRET: 'b'.repeat(64),
    ASSETS: { fetch: async () => new Response('asset') }, INTEREST_LIMITER: { limit: async () => ({ success: true }) }, API_LIMITER: { limit: async () => ({ success: true }) }, EXPENSIVE_LIMITER: { limit: async () => ({ success: true }) },
    INTEREST_DB: {
      prepare(sql) {
        const state = { sql, values: [] as Value[] }
        const statement: Statement = { bind(...values) { state.values = values; return this }, async first<T>() { return (db.prepare(sql).get(...state.values) ?? null) as T | null }, async all<T>() { return { results: db.prepare(sql).all(...state.values) as T[] } }, async run() { return db.prepare(sql).run(...state.values) } }
        statements.set(statement, state); return statement
      },
      async batch(batch) {
        db.exec('BEGIN')
        try { const results = batch.map(s => { const { sql, values } = statements.get(s)!; return db.prepare(sql).run(...values) }); db.exec('COMMIT'); return results }
        catch (e) { db.exec('ROLLBACK'); throw e }
      },
    },
  }
  const calls: { method: string; data: Record<string, any>; key: string | null }[] = []
  const failures = { mail: false, send: false, member: false, telegram: false, redirect: false, mailCount: 0 }
  const memberships = new Map<number, string>()
  const unavailableGroups = new Set<number>()
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    const url = String(input), method = url.endsWith('/emails') ? 'email' : url.split('/').pop()!
    const data = JSON.parse(String(options?.body ?? '{}'))
    calls.push({ method, data, key: new Headers(options?.headers).get('Idempotency-Key') })
    if (method === 'email') { failures.mailCount++; return Response.json({ id: 'email-test' }, { status: failures.mail ? 503 : 200 }) }
    assert.equal(options?.redirect, 'manual', 'Telegram requests must not follow redirects with credentials or applicant data')
    if (failures.redirect) return new Response(null, { status: 302, headers: { Location: 'https://redirect.example.invalid/' } })
    if (failures.telegram || (method === 'sendMessage' && failures.send) || (method === 'getChatMember' && unavailableGroups.has(data.chat_id))) return Response.json({ ok: false }, { status: 503 })
    return Response.json({ ok: true, result: method === 'getChatMember' ? { status: memberships.get(data.chat_id) ?? (failures.member ? 'left' : 'member') } : { message_id: 1 } })
  })
  let id = 0
  const request = (data: unknown, secret = env.TELEGRAM_WEBHOOK_SECRET!, method = 'POST') => worker.fetch(new Request('https://shop.example.invalid/api/telegram/webhook', { method, headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: method === 'GET' ? undefined : JSON.stringify(data) }), env)
  const message = (text: string, user = 101, chat = user, type = 'private', updateId = ++id) => ({ update_id: updateId, message: { message_id: updateId, from: { id: user, is_bot: false }, chat: { id: chat, type }, text } })
  const send = (text: string, user = 101) => request(message(text, user))
  const confirmData = () => calls.filter(c => c.method === 'sendMessage').at(-1)!.data.reply_markup.inline_keyboard[0][0].callback_data as string
  const callback = (data: string, user = 101, updateId = ++id) => ({ update_id: updateId, callback_query: { id: 'callback-' + updateId, from: { id: user }, message: { message_id: 10, chat: { id: user, type: 'private' } }, data } })
  const fill = async (user = 101, email = 'new@example.test') => {
    for (const text of ['/start apply_-10042', 'Wechat_123', '12345678', email]) assert.equal((await send(text, user)).status, 200)
    return confirmData()
  }
  const lastText = () => calls.filter(c => c.method === 'sendMessage').at(-1)?.data.text as string
  const count = (table: string) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n as number
  return { db, env, calls, failures, memberships, unavailableGroups, request, message, send, callback, fill, lastText, confirmData, count }
}

test('first-time private commands start without a group link', async t => {
  const s = fixture(t)
  for (const [index, command] of ['/apply', '/start', '/restart', '/apply@ExampleBot'].entries()) {
    const user = 101 + index
    assert.equal((await s.send(command, user)).status, 200)
    assert.match(s.lastText(), /第 1\/3 步/)
    const session = s.db.prepare('SELECT step,group_id FROM telegram_partner_sessions WHERE user_id=?').get(user)
    assert.equal(session!.step, 'wechat')
    assert.equal(session!.group_id, -10042)
  }
  assert.equal(s.count('partners'), 0)
  assert.equal(s.failures.mailCount, 0)
})

test('private apply finds an eligible group and uses it again at confirmation', async t => {
  const s = fixture(t)
  s.env.TELEGRAM_ALLOWED_GROUP_IDS = '-10042,-10099'
  s.memberships.set(-10042, 'left')
  for (const text of ['/apply', 'Wechat_123', '12345678', 'direct@example.test']) assert.equal((await s.send(text)).status, 200)
  assert.equal((await s.request(s.callback(s.confirmData()))).status, 200)
  assert.match(s.lastText(), /代理已开通/)
  assert.equal(s.db.prepare('SELECT group_id FROM telegram_partner_applications').get()!.group_id, -10099)
  assert.equal(s.calls.filter(c => c.method === 'getChatMember').at(-1)!.data.chat_id, -10099)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM support_contacts WHERE owner!='platform'").get()!.n, 1)
  assert.equal(s.failures.mailCount, 0)
})

test('private commands reject nonmembers and recover after joining', async t => {
  const s = fixture(t)
  s.failures.member = true
  await s.send('/apply')
  assert.match(s.lastText(), /加入申请群/)
  assert.equal(s.db.prepare('SELECT step,group_id FROM telegram_partner_sessions').get()!.step, 'idle')
  assert.equal(s.count('partners'), 0)
  s.failures.member = false
  await s.send('/apply')
  assert.match(s.lastText(), /第 1\/3 步/)
})

test('membership lookup failure never starts a form but another verified group can qualify', async t => {
  const s = fixture(t)
  s.unavailableGroups.add(-10042)
  await s.send('/start')
  assert.match(s.lastText(), /暂时无法验证/)
  assert.equal(s.db.prepare('SELECT step FROM telegram_partner_sessions').get()!.step, 'idle')
  assert.equal(s.count('partners'), 0)
  s.env.TELEGRAM_ALLOWED_GROUP_IDS = '-10042,-10099'
  await s.send('/apply')
  assert.match(s.lastText(), /第 1\/3 步/)
  assert.equal(s.db.prepare('SELECT group_id FROM telegram_partner_sessions').get()!.group_id, -10099)
})

test('private restart finds another group after leaving the previous one; explicit links stay scoped', async t => {
  const s = fixture(t)
  s.env.TELEGRAM_ALLOWED_GROUP_IDS = '-10042,-10099'
  await s.send('/apply')
  await s.send('Wechat_123')
  s.memberships.set(-10042, 'left')
  await s.send('/restart')
  const session = s.db.prepare('SELECT group_id,step,wechat FROM telegram_partner_sessions').get()!
  assert.equal(session.group_id, -10099)
  assert.equal(session.step, 'wechat')
  assert.equal(session.wechat, '')
  await s.send('/start apply_-10042')
  assert.match(s.lastText(), /加入申请群/)
  await s.send('/start apply_-10077')
  assert.match(s.lastText(), /加入申请群/)
})

test('group discovery checks the final configured group and limits scans before API calls', async t => {
  const s = fixture(t)
  const groups = Array.from({ length: 20 }, (_, index) => -10000 - index)
  s.env.TELEGRAM_ALLOWED_GROUP_IDS = groups.join(',')
  s.failures.member = true
  s.memberships.set(groups[19], 'member')
  await s.send('/apply')
  assert.match(s.lastText(), /第 1\/3 步/)
  assert.equal(s.db.prepare('SELECT group_id FROM telegram_partner_sessions').get()!.group_id, groups[19])
  assert.equal(s.calls.filter(c => c.method === 'getChatMember').length, 20)
  for (let i = 0; i < 9; i++) await s.send('/apply')
  const before = s.calls.filter(c => c.method === 'getChatMember').length
  await s.send('/apply')
  assert.match(s.lastText(), /频繁/)
  assert.equal(s.calls.filter(c => c.method === 'getChatMember').length, before)
})

test('webhook authenticates before database use, validates bodies and fails closed without configuration', async t => {
  const s = fixture(t)
  assert.equal((await s.request({ update_id: 1 }, 'wrong')).status, 403)
  assert.equal(s.count('telegram_partner_updates'), 0)
  assert.equal((await s.request({ update_id: 1 }, undefined, 'GET')).status, 200)
  assert.equal((await s.request(null)).status, 400)
  assert.equal((await s.request({ update_id: -1 })).status, 400)
  assert.equal((await s.request({ update_id: 1, junk: 'x'.repeat(20_000) })).status, 400)
  s.env.TELEGRAM_ALLOWED_GROUP_IDS = ''
  assert.equal((await s.request({ update_id: 1 })).status, 503)
  assert.equal(s.calls.length, 0)
})

test('group entry contains only the deep link; unrelated groups, bots, edits and commands are ignored', async t => {
  const s = fixture(t)
  assert.equal((await s.request(s.message('/apply@ExampleBot', 101, -10042, 'supergroup'))).status, 200)
  assert.equal(s.calls[0].data.reply_markup.inline_keyboard[0][0].url, 'https://t.me/ExampleBot?start=apply_-10042')
  assert.equal(s.count('telegram_partner_sessions'), 0)
  const ignored = [s.message('12345678', 101, -10042, 'supergroup'), s.message('/apply', 101, -10099, 'group'), s.message('/apply@OtherBot', 101, -10042, 'group'), { update_id: 100, edited_message: s.message('/apply').message }, { ...s.message('/start'), message: { ...s.message('/start').message, from: { id: 1, is_bot: true } } }]
  for (const update of ignored) assert.equal((await s.request(update)).status, 200)
  assert.equal(s.calls.length, 1)
  assert.equal(s.count('partners'), 0)
})

test('confirmed application provisions once using current default prices, initializes shop contacts and sends the existing invitation', async t => {
  const s = fixture(t)
  s.db.prepare("INSERT INTO partner_default_prices(plan,cost_cents) VALUES ('plus',10000) ON CONFLICT(plan) DO UPDATE SET cost_cents=excluded.cost_cents").run()
  const data = await s.fill(101, ' New@Example.Test ')
  assert.equal(s.count('partners'), 0)
  assert.equal(s.failures.mailCount, 0)
  const update = s.callback(data)
  assert.equal((await s.request(update)).status, 200)
  const app = s.db.prepare('SELECT * FROM telegram_partner_applications').get()!
  const partner = s.db.prepare('SELECT * FROM partners').get()!
  assert.equal(app.email, 'new@example.test'); assert.equal(app.wechat, 'Wechat_123'); assert.equal(app.qq, '12345678')
  assert.equal(app.partner_id, partner.id); assert.match(String(partner.slug), /^[A-Z0-9]{6}$/)
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM partner_prices').get()!.n, s.db.prepare('SELECT COUNT(*) n FROM catalog_plans').get()!.n)
  assert.equal(s.db.prepare("SELECT cost_cents FROM partner_prices WHERE plan='plus'").get()!.cost_cents, 10000)
  assert.equal(s.db.prepare('SELECT wechat FROM telegram_partner_sessions').get()!.wechat, '')
  const contacts = s.db.prepare('SELECT wechat,qq,email,version FROM support_contacts WHERE partner_id=?').get(partner.id)!
  assert.deepEqual({ ...contacts }, { wechat: 'Wechat_123', qq: '12345678', email: '', version: 1 })
  assert.equal((await s.request(update)).status, 200)
  assert.equal((await s.request(s.callback(data))).status, 200)
  assert.equal(s.count('partners'), 1); assert.equal(s.count('admin_audit'), 2)
  s.db.prepare("UPDATE support_contacts SET wechat='EditedWechat',qq='87654321',version=2 WHERE owner=?").run(partner.id)
  assert.equal((await s.request(s.callback(data))).status, 200)
  assert.deepEqual({ ...s.db.prepare('SELECT wechat,qq,version FROM support_contacts WHERE owner=?').get(partner.id) }, { wechat: 'EditedWechat', qq: '87654321', version: 2 })
  await retryTelegramInvitations(s.env)
  assert.equal(s.failures.mailCount, 1)
  const mail = s.calls.find(c => c.method === 'email')!
  assert.deepEqual(mail.data.to, ['new@example.test']); assert.match(mail.data.text, /shop.example.invalid\/join/)
  assert.match(mail.key!, /^partner-welcome\/telegram-/)
  assert.equal(s.db.prepare('SELECT mail_status FROM telegram_partner_applications').get()!.mail_status, 'sent')
  assert.match(s.lastText(), /邀请邮件已发送/)
  await retryTelegramInvitations(s.env)
  assert.equal(s.failures.mailCount, 1)
})

test('validation, cancellation, expiry and stale confirmation buttons cannot provision accounts', async t => {
  const s = fixture(t)
  await s.send('/start apply_-10042')
  await s.send('bad'); assert.match(s.lastText(), /微信号/)
  await s.send('Wechat_123'); await s.send('01234'); assert.match(s.lastText(), /QQ/)
  await s.send('12345678'); await s.send('wrong'); assert.match(s.lastText(), /邮箱格式/)
  await s.send('new@example.test'); const stale = s.confirmData()
  await s.send('/restart'); await s.send('Wechat_456'); await s.send('87654321'); await s.send('second@example.test')
  const current = s.confirmData()
  await s.request(s.callback(stale)); assert.match(s.lastText(), /按钮已失效/)
  assert.equal(s.count('partners'), 0)
  s.db.prepare('UPDATE telegram_partner_sessions SET expires_at=1').run()
  await s.request(s.callback(current)); assert.match(s.lastText(), /过期/)
  assert.equal(s.db.prepare('SELECT email FROM telegram_partner_sessions').get()!.email, '')
  await s.send('/restart'); await s.send('Wechat_123'); await s.send('/cancel')
  assert.equal(s.db.prepare('SELECT wechat FROM telegram_partner_sessions').get()!.wechat, '')
  assert.equal(s.count('partners'), 0)
})

test('membership is verified at start and confirmation, including removed or unavailable groups', async t => {
  const s = fixture(t)
  await s.send('/start apply_-10099'); assert.match(s.lastText(), /加入申请群/)
  s.failures.member = true
  await s.send('/start apply_-10042'); assert.match(s.lastText(), /加入申请群/)
  s.failures.member = false
  const data = await s.fill()
  s.failures.member = true
  await s.request(s.callback(data)); assert.match(s.lastText(), /已不在申请群/)
  assert.equal(s.count('partners'), 0)
  s.failures.telegram = true
  assert.equal((await s.request(s.callback(data))).status, 503)
  assert.equal(s.count('partners'), 0)
})

test('existing disabled accounts are never reassigned, re-enabled or sent an invitation by an applicant', async t => {
  const s = fixture(t)
  s.db.prepare("INSERT INTO partners(id,slug,name,email,active,created_at,updated_at) VALUES ('existing','EXIST1','existing','old@example.test',0,1,1)").run()
  const data = await s.fill(101, 'old@example.test')
  await s.request(s.callback(data))
  assert.match(s.lastText(), /已有代理账号/)
  assert.equal(s.count('partners'), 1); assert.equal(s.count('telegram_partner_applications'), 0)
  assert.equal(s.db.prepare('SELECT active FROM partners').get()!.active, 0)
  await retryTelegramInvitations(s.env); assert.equal(s.failures.mailCount, 0)
})

test('account, prices, audit and application roll back together on application failure', async t => {
  const s = fixture(t)
  const data = await s.fill()
  s.db.exec("CREATE TRIGGER fail_application BEFORE INSERT ON telegram_partner_applications BEGIN SELECT RAISE(ABORT,'simulated database failure'); END;")
  assert.equal((await s.request(s.callback(data))).status, 503)
  assert.equal(s.count('partners'), 0); assert.equal(s.count('partner_prices'), 0); assert.equal(s.count('admin_audit'), 0)
  assert.equal(s.db.prepare('SELECT step FROM telegram_partner_sessions').get()!.step, 'confirm')
  s.db.exec('DROP TRIGGER fail_application')
  assert.equal((await s.request(s.callback(data))).status, 200)
  assert.equal(s.count('partners'), 1)
})

test('undelivered Telegram replies replay the persisted prompt without advancing the form twice', async t => {
  const s = fixture(t)
  await s.send('/start apply_-10042')
  const update = s.message('Wechat_123')
  s.failures.send = true
  assert.equal((await s.request(update)).status, 503)
  assert.equal(s.db.prepare('SELECT step FROM telegram_partner_sessions').get()!.step, 'qq')
  s.failures.send = false
  assert.equal((await s.request(update)).status, 200)
  assert.match(s.lastText(), /第 2\/3 步/)
  assert.equal(s.db.prepare('SELECT qq FROM telegram_partner_sessions').get()!.qq, '')
})

test('duplicate and competing confirmations cannot create two partners; competing queue runs send one invitation', async t => {
  const s = fixture(t), data = await s.fill(), update = s.callback(data)
  const results = await Promise.all([s.request(update), s.request(s.callback(data))])
  assert.ok(results.some(r => r.status === 200)); assert.equal(s.count('partners'), 1)
  assert.equal(s.count('telegram_partner_applications'), 1)
  await Promise.all([retryTelegramInvitations(s.env), retryTelegramInvitations(s.env)])
  assert.equal(s.failures.mailCount, 1)
})

test('failed invitations retry with the same key; Telegram notification failure never resends email', async t => {
  const s = fixture(t), data = await s.fill()
  await s.request(s.callback(data)); s.failures.mail = true
  await retryTelegramInvitations(s.env)
  assert.equal(s.db.prepare('SELECT mail_status FROM telegram_partner_applications').get()!.mail_status, 'pending')
  s.db.prepare('UPDATE telegram_partner_applications SET next_attempt_at=0').run()
  s.failures.mail = false; s.failures.send = true
  await retryTelegramInvitations(s.env)
  const mails = s.calls.filter(c => c.method === 'email')
  assert.equal(mails.length, 2); assert.equal(mails[0].key, mails[1].key)
  assert.equal(s.db.prepare('SELECT mail_status FROM telegram_partner_applications').get()!.mail_status, 'sent')
  s.db.prepare('UPDATE telegram_partner_applications SET next_attempt_at=0').run(); s.failures.send = false
  await retryTelegramInvitations(s.env)
  assert.equal(s.failures.mailCount, 2)
  assert.equal(s.db.prepare('SELECT notice_sent FROM telegram_partner_applications').get()!.notice_sent, 1)
})

test('retry exhaustion and expired idempotency window stop sending and report the actual mail result', async t => {
  for (const update of ['mail_attempts=10', 'created_at=1']) {
    const s = fixture(t), data = await s.fill()
    await s.request(s.callback(data))
    s.db.exec('UPDATE telegram_partner_applications SET ' + update)
    await retryTelegramInvitations(s.env)
    assert.equal(s.failures.mailCount, 0)
    assert.equal(s.db.prepare('SELECT mail_status FROM telegram_partner_applications').get()!.mail_status, 'failed')
    assert.match(s.lastText(), /暂未确认发送成功/)
  }
})

test('administrator disabling or changing the email prevents stale queued mail', async t => {
  const s = fixture(t), data = await s.fill()
  await s.request(s.callback(data))
  s.db.prepare("UPDATE partners SET email='changed@example.test'").run()
  await retryTelegramInvitations(s.env)
  assert.equal(s.failures.mailCount, 0)
  assert.equal(s.db.prepare('SELECT mail_status FROM telegram_partner_applications').get()!.mail_status, 'failed')
})

test('cron clears expired drafts and old replay data; user message limits leave state unchanged', async t => {
  const s = fixture(t)
  await s.send('/start apply_-10042'); await s.send('Wechat_123')
  s.db.prepare('UPDATE telegram_partner_sessions SET expires_at=1').run()
  s.db.prepare('UPDATE telegram_partner_updates SET created_at=1').run()
  await retryTelegramInvitations(s.env)
  assert.equal(s.count('telegram_partner_updates'), 0)
  assert.equal(s.db.prepare('SELECT wechat FROM telegram_partner_sessions').get()!.wechat, '')
  await s.send('/restart')
  s.db.prepare('UPDATE admin_login_limits SET attempts=30').run()
  await s.send('Wechat_123')
  assert.match(s.lastText(), /过于频繁/)
  assert.equal(s.db.prepare('SELECT step FROM telegram_partner_sessions').get()!.step, 'wechat')
})

test('shared admin provisioning retains existing behavior and refuses missing mail configuration', async t => {
  const s = fixture(t)
  const p = await provisionPartner(s.env, 'admin-created@example.test', 'test-admin')
  assert.equal(p.email, 'admin-created@example.test'); assert.equal(s.count('telegram_partner_applications'), 0)
  assert.equal(s.count('partners'), 1)
  s.env.RESEND_API_KEY = undefined
  await assert.rejects(provisionPartner(s.env, 'another@example.test', 'test-admin'), /邮件服务/)
  assert.equal(s.count('partners'), 1)
  assert.deepEqual(telegramGroups({ ...s.env, TELEGRAM_ALLOWED_GROUP_IDS: '-10042,-10042,-99' }), [-10042, -99])
  assert.deepEqual(telegramGroups({ ...s.env, TELEGRAM_ALLOWED_GROUP_IDS: '-10042,123' }), [])
})

test('Telegram update IDs can reset after a quiet week without disabling private forms', async t => {
  const s = fixture(t)
  await s.send('/start apply_-10042')
  s.db.prepare('UPDATE telegram_partner_sessions SET last_update_id=99999999').run()
  assert.equal((await s.send('Wechat_123')).status, 200)
  assert.match(s.lastText(), /第 2\/3 步/)
  assert.equal(s.db.prepare('SELECT wechat FROM telegram_partner_sessions').get()!.wechat, 'Wechat_123')
})

test('Telegram redirects fail closed without forwarding credentials or creating accounts', async t => {
  const s = fixture(t)
  s.failures.redirect = true
  assert.equal((await s.send('/start apply_-10042')).status, 503)
  assert.equal(s.count('partners'), 0)
  assert.equal(s.calls.length, 1)
  assert.equal(s.calls[0].method, 'getChatMember')
})

test('shop contact initialization failure rolls back the account, pricing, application and audits', async t => {
  const s = fixture(t), data = await s.fill()
  s.db.exec("CREATE TRIGGER fail_initial_contacts BEFORE INSERT ON admin_audit WHEN NEW.action='support-contacts' BEGIN SELECT RAISE(ABORT,'contact audit failure'); END")
  assert.equal((await s.request(s.callback(data))).status, 503)
  assert.equal(s.count('partners'), 0); assert.equal(s.count('partner_prices'), 0)
  assert.equal(s.count('telegram_partner_applications'), 0); assert.equal(s.count('admin_audit'), 0)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM support_contacts WHERE owner!='platform'").get()!.n, 0)
  assert.equal(s.db.prepare('SELECT step FROM telegram_partner_sessions').get()!.step, 'confirm')
})

test('legacy Telegram contact migration fills missing or untouched settings once, preserves edits, email and other shops', t => {
  const s = fixture(t)
  const migration = readFileSync(new URL('../migrations/0041_telegram_partner_contacts.sql', import.meta.url), 'utf8')
  for (let i = 1; i <= 4; i++) {
    s.db.prepare("INSERT INTO partners(id,slug,name,email,created_at,updated_at) VALUES (?,?,'legacy',?,1,1)").run('legacy-' + i, 'LEGACY' + i, `legacy${i}@example.test`)
    if (i < 4) s.db.prepare('INSERT INTO telegram_partner_applications(id,user_id,group_id,partner_id,wechat,qq,email,created_at,next_attempt_at) VALUES (?,?, -10042,?,?,?,?,1,1)').run('app-' + i, i, 'legacy-' + i, 'Wechat_' + i, '12345678', `legacy${i}@example.test`)
  }
  s.db.prepare("INSERT INTO support_contacts(owner,partner_id,wechat,qq,email,version) VALUES ('legacy-2','legacy-2','keptWechat','','public@example.test',0)").run()
  s.db.prepare("INSERT INTO support_contacts(owner,partner_id,wechat,qq,email,version) VALUES ('legacy-3','legacy-3','','87654321','edited@example.test',3)").run()
  s.db.prepare("UPDATE support_contacts SET wechat='platformWechat',qq='99999999' WHERE owner='platform'").run()
  const editedBefore = s.db.prepare("SELECT * FROM support_contacts WHERE owner='legacy-3'").get()
  const platformBefore = s.db.prepare("SELECT * FROM support_contacts WHERE owner='platform'").get()
  s.db.exec(migration)
  assert.deepEqual({ ...s.db.prepare("SELECT wechat,qq,email,version FROM support_contacts WHERE owner='legacy-1'").get() }, { wechat: 'Wechat_1', qq: '12345678', email: '', version: 1 })
  assert.deepEqual({ ...s.db.prepare("SELECT wechat,qq,email,version FROM support_contacts WHERE owner='legacy-2'").get() }, { wechat: 'keptWechat', qq: '12345678', email: 'public@example.test', version: 1 })
  assert.deepEqual(s.db.prepare("SELECT * FROM support_contacts WHERE owner='legacy-3'").get(), editedBefore)
  assert.deepEqual(s.db.prepare("SELECT * FROM support_contacts WHERE owner='platform'").get(), platformBefore)
  assert.equal(s.db.prepare("SELECT * FROM support_contacts WHERE owner='legacy-4'").get(), undefined)
  assert.equal(s.count('admin_audit'), 2)
  const before = s.db.prepare('SELECT * FROM support_contacts ORDER BY owner').all()
  s.db.exec(migration)
  assert.deepEqual(s.db.prepare('SELECT * FROM support_contacts ORDER BY owner').all(), before)
  assert.equal(s.count('admin_audit'), 2)
})
