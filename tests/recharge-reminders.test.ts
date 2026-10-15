import test from 'node:test'
import assert from 'node:assert/strict'
import { customerFixture } from './customer-fixture.ts'
import { sendDueRechargeReminders } from '../worker/recharge-reminders.ts'
import { rechargeReminderMessage } from '../worker/email.ts'

const NOW = 1_800_000_000_000
async function setup(t: Parameters<Parameters<typeof test>[1]>[0]) {
  const s = await customerFixture(); t.after(() => s.db.close())
  t.mock.method(Date, 'now', () => NOW)
  Object.assign(s.env, { RESEND_API_KEY:'test', RESEND_FROM:'硅基生物 <noreply@shop.example.invalid>' })
  s.db.prepare("UPDATE support_contacts SET wechat='platform_support',email='support@example.test' WHERE owner='platform'").run()
  function order(id = 'o1', paidAt = NOW - 900_000, plan = 'plus') {
    s.db.prepare(`INSERT INTO orders(id,owner_hash,idempotency_key,plan,plan_name,price_cents,mode,payment_status,status,customer_email,created_at,updated_at,last_event_id)
      VALUES (?,?,?,?,'ChatGPT Plus',13900,'live','unpaid','pending','buyer@example.test',?,?,?)`).run(id,'owner',id,plan,NOW-3600_000,paidAt,id)
    s.db.prepare("UPDATE orders SET payment_status='paid',status='session',updated_at=? WHERE id=?").run(paidAt,id)
  }
  const mails: {body:Record<string,unknown>; key:string|null}[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url,'https://api.resend.com/emails')
    mails.push({ body:JSON.parse(String(init.body)), key:new Headers(init.headers).get('Idempotency-Key') })
    return Response.json({ id:'test-mail' })
  })
  return {...s,order,mails}
}

test('15 minutes uses first payment confirmation, not creation or later updates; sends only once', async t => {
  const s = await setup(t); s.order('early',NOW-899_999); s.order('due')
  s.db.prepare("UPDATE orders SET updated_at=? WHERE id='due'").run(NOW)
  s.db.prepare("UPDATE orders SET payment_status='paid' WHERE id='due'").run()
  assert.equal(s.db.prepare("SELECT paid_at FROM recharge_reminders WHERE order_id='due'").get()!.paid_at,NOW-900_000)
  assert.equal((await sendDueRechargeReminders(s.env)).sent,1)
  assert.equal(s.mails[0].key,'recharge-reminder/due')
  assert.deepEqual(s.mails[0].body.to,['buyer@example.test'])
  assert.match(String(s.mails[0].body.text),/Session|无需再次付款/)
  assert.match(String(s.mails[0].body.text),/platform_support/)
  await sendDueRechargeReminders(s.env); assert.equal(s.mails.length,1)
})

test('submitted, rejected submissions, refunds, holds, blocked, test, demo and SMS orders do not receive reminders', async t => {
  const s = await setup(t)
  for(const id of ['submitted','rejected','refund','hold','blocked','test','demo','failed','supplier-hold']) s.order(id)
  s.order('sms',NOW-900_000,'codex-sms-once')
  s.db.prepare("UPDATE orders SET status='processing',started_at=? WHERE id='submitted'").run(NOW)
  s.db.prepare("UPDATE orders SET refunded_cents=1 WHERE id='refund'").run()
  s.db.prepare("UPDATE orders SET refund_hold=1 WHERE id='hold'").run()
  s.db.prepare("UPDATE orders SET redemption_blocked=1 WHERE id='blocked'").run()
  s.db.prepare("UPDATE orders SET is_test=1 WHERE id='test'").run()
  s.db.prepare("UPDATE orders SET mode='demo',payment_status='simulated' WHERE id='demo'").run()
  s.db.prepare("UPDATE orders SET status='failed' WHERE id='failed'").run()
  for(const id of ['rejected','supplier-hold']) s.db.prepare("INSERT INTO recharge_orders(order_id,account,product_code,collection_mode,create_body,updated_at,financial_hold) VALUES (?,'account','plus','platform_collect','{}',?,?)").run(id,NOW,Number(id==='supplier-hold'))
  s.db.prepare("INSERT INTO recharge_redemptions(id,order_id,attempt_no,request_hash,credential_mode,status,created_at) VALUES ('r','rejected',1,'hash','session','rejected',?)").run(NOW)
  assert.equal((await sendDueRechargeReminders(s.env)).sent,0)
  assert.equal(s.mails.length,0)
  assert.equal(s.db.prepare("SELECT COUNT(*) count FROM recharge_reminders WHERE cancelled_at IS NULL").get()!.count,0)
})

test('uses the order agent contacts, with platform fallback when absent', async t => {
  const s = await setup(t); const agent = await s.agent('代理 A')
  s.db.prepare("INSERT INTO support_contacts(owner,partner_id,wechat,qq,email) VALUES (?,?,'agent_wechat','12345678','agent@example.test')").run(agent.id,agent.id)
  s.order(); s.db.prepare("UPDATE orders SET partner_id=?,partner_name='代理 A' WHERE id='o1'").run(agent.id)
  await sendDueRechargeReminders(s.env)
  const text = String(s.mails[0].body.text)
  assert.match(text,/如需帮助，请联系客服/); assert.doesNotMatch(text,/您的代理|非品牌官方网站/)
  assert.match(text,/agent_wechat/); assert.match(text,/12345678/); assert.match(text,/agent@example.test/)
  assert.doesNotMatch(text,/platform_support/)
  s.db.prepare('DELETE FROM support_contacts WHERE owner=?').run(agent.id)
  s.order('fallback'); s.db.prepare("UPDATE orders SET partner_id=? WHERE id='fallback'").run(agent.id)
  await sendDueRechargeReminders(s.env)
  assert.match(String(s.mails[1].body.text),/platform_support/)
})

test('failures back off and retry the exact recipient and body; ambiguous retries expire before 24h', async t => {
  const s = await setup(t); s.order()
  const bodies: string[] = []
  t.mock.method(globalThis,'fetch',async (_url:string,init:RequestInit)=>{bodies.push(String(init.body));return new Response('',{status:bodies.length===1?500:200})})
  assert.equal((await sendDueRechargeReminders(s.env)).failed,1)
  await sendDueRechargeReminders(s.env); assert.equal(bodies.length,1)
  s.db.prepare("UPDATE support_contacts SET wechat='new-contact' WHERE owner='platform'").run()
  s.db.prepare("UPDATE orders SET customer_email='changed@example.test' WHERE id='o1'").run()
  t.mock.method(Date,'now',()=>NOW+60_000)
  assert.equal((await sendDueRechargeReminders(s.env)).sent,1)
  assert.equal(bodies[0],bodies[1])
  s.order('expired'); s.db.prepare("UPDATE recharge_reminders SET first_attempt_at=? WHERE order_id='expired'").run(NOW-23*3600_000)
  await sendDueRechargeReminders(s.env); assert.equal(bodies.length,2)
})

test('overlapping schedulers claim a reminder only once and skip submission during preparation', async t => {
  const s = await setup(t); s.order()
  await Promise.all([sendDueRechargeReminders(s.env),sendDueRechargeReminders(s.env)])
  assert.equal(s.mails.length,1)
  s.order('race')
  const original = s.env.INTEREST_DB.prepare.bind(s.env.INTEREST_DB)
  t.mock.method(s.env.INTEREST_DB,'prepare',(sql:string)=>{
    if(sql.startsWith('SELECT wechat,qq,email,version')) s.db.prepare("UPDATE orders SET status='processing',started_at=? WHERE id='race'").run(NOW)
    return original(sql)
  })
  await sendDueRechargeReminders(s.env); assert.equal(s.mails.length,1)
})

test('reminder safely escapes dynamic HTML while preserving readable text and multiline contacts', () => {
  const mail = rechargeReminderMessage({orderId:'order',planName:'<img src=x onerror=alert(1)>',contacts:'微信：test\nQQ：12345678'})
  assert.doesNotMatch(mail.html,/<img src=x|<script/)
  assert.match(mail.html,/&lt;img/); assert.match(mail.html,/微信：test<br \/>QQ/)
  assert.match(mail.text,/微信：test\nQQ/)
  assert.ok(mail.html.length<100_000)
})

test('preview requires administrator auth and always sends to the server-owned review mailbox', async t => {
  const s = await setup(t)
  assert.equal((await s.request('/api/admin/recharge-reminders/preview',{})).status,401)
  assert.equal((await s.request('/api/admin/recharge-reminders/preview',{to:'attacker@example.test'},s.admin)).status,200)
  assert.deepEqual(s.mails[0].body.to,['admin@example.invalid'])
  assert.match(String(s.mails[0].body.text),/非真实订单/)
})
