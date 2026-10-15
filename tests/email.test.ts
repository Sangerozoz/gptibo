import test from 'node:test'
import assert from 'node:assert/strict'
import { partnerInvitationMessage, sendPartnerInvitationEmail, verificationMessage, sendVerificationEmail, siteEmail } from '../worker/email.ts'
import type { Env } from '../worker/platform.ts'
import { customerFixture } from './customer-fixture.ts'

test('direct-store email uses current brand and logo while preserving its links and configured sender', async t => {
  const s = await customerFixture(); t.after(() => s.db.close())
  s.env.RESEND_API_KEY = 'test'
  s.env.RESEND_FROM = 'Sender <noreply@example.test>'
  const id = crypto.randomUUID()
  s.db.prepare("INSERT INTO direct_media(id,mime,base64,created_at) VALUES (?,'image/png','iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/tc8AAAAASUVORK5CYII=',0)").run(id)
  s.db.prepare('UPDATE direct_site SET name_zh=?,logo_media_id=? WHERE id=1').run('MEGHAN & <Co>', id)
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const mail = JSON.parse(String(options.body)) as { from: string; subject: string; html: string; text: string }
    assert.equal(mail.from, 'Sender <noreply@example.test>')
    assert.match(mail.subject, /^MEGHAN & <Co> · 管理后台登录验证码$/)
    assert.match(mail.html, /MEGHAN &amp; &lt;Co&gt;/)
    assert.match(mail.html, new RegExp(`src="https://shop\\.example\\.invalid/api/direct-media/${id}"`))
    assert.match(mail.html, /href="https:\/\/shop\.example\.invalid\/admin"/)
    assert.match(mail.text, /https:\/\/shop\.example\.invalid\/admin/)
    assert.doesNotMatch(mail.html, /__RECHARGE_BRAND_/)
    return Response.json({ id: 'brand-mail' })
  })
  await sendVerificationEmail(s.env, 'admin-login', 'admin@example.test', '001234', 'brand-dynamic')
})

test('admin login email uses the configured site for its logo and both admin links', async t => {
  const env = { RESEND_FROM: '硅基生物 <noreply@meghan.example.test>', RESEND_API_KEY: 'test', PUBLIC_SITE_ORIGIN: 'https://meghan.example.test' } as Env
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    const mail = JSON.parse(String(options.body)) as { subject: string; html: string; text: string }
    assert.match(mail.subject, /^硅基生物 · 管理后台登录验证码$/)
    assert.match(mail.html, /硅基生物/)
    assert.doesNotMatch(mail.html, /MEGHAN/)
    assert.match(mail.html, /src="https:\/\/meghan.example.test\/email-logo.png"/)
    assert.match(mail.html, /href="https:\/\/meghan.example.test\/admin"/)
    assert.match(mail.text, /https:\/\/meghan.example.test\/admin/)
    assert.doesNotMatch(mail.html + mail.text, /shop\.example\.invalid|__RECHARGE_SITE_ORIGIN__/)
    return Response.json({ id: 'admin-mail' })
  })
  await sendVerificationEmail(env, 'admin-login', 'admin@example.test', '001234', 'brand-check')
})

test('live email refuses a loopback site link', () => {
  const env = { PUBLIC_SITE_ORIGIN: 'http://127.0.0.1:8788', ORDER_TESTING_ENABLED: 'false' } as Env
  assert.throws(() => siteEmail(env, verificationMessage('admin-login', '001234')), /HTTPS origin/)
})

test('local preview email renders a text logo instead of a broken localhost image', () => {
  const env = { PUBLIC_SITE_ORIGIN: 'http://127.0.0.1:8788', ORDER_TESTING_ENABLED: 'true' } as Env
  const mail = siteEmail(env, verificationMessage('admin-login', '001234'))
  assert.match(mail.html, /<span style="display:inline-block;width:32px/)
  assert.doesNotMatch(mail.html, /src="http:\/\/127\.0\.0\.1:8788\/email-logo\.png"/)
  assert.match(mail.html, /href="http:\/\/127\.0\.0\.1:8788\/admin"/)
})

test('verification mail preserves leading zeroes, purpose and fallback without exposing a code in the inbox preview', () => {
  for (const kind of ['partner-login', 'order-recovery', 'admin-login'] as const) {
    const mail = verificationMessage(kind, '001234')
    assert.match(mail.html, /001234/)
    const preview = mail.html.match(/data-skip-in-text="true">([^<]*)/)?.[1]
    assert.ok(preview)
    assert.doesNotMatch(preview, /001234/)
    assert.match(mail.text, /001234/)
    assert.doesNotMatch(mail.html + mail.text, /__RECHARGE_VERIFICATION_CODE__/)
    assert.match(mail.html, /lang="zh-CN"/)
    assert.match(mail.html, /prefers-color-scheme: dark/)
    assert.match(mail.html, /__RECHARGE_BRAND_LOGO__/)
    assert.doesNotMatch(mail.html, /<script|<svg|<iframe|onclick=/i)
    assert.ok(mail.html.length < 100000, 'Stay below Gmail clipping threshold')
    assert.ok(mail.text.includes(kind === 'order-recovery' ? '订单' : kind === 'admin-login' ? '管理后台' : '代理工作台'))
    if (kind === 'partner-login') assert.match(mail.text, /__RECHARGE_BRAND_WORKSPACE_URL__/)
    assert.match(mail.text, /10 分钟/)
  }
  assert.throws(() => verificationMessage('partner-login', '<img>'))
  assert.throws(() => verificationMessage('partner-login', '12345'))
})

test('partner invitation contains a durable login link and instructions without an OTP or expiry', async t => {
  const mail = partnerInvitationMessage()
  assert.match(mail.text, /账号已开通/)
  assert.match(mail.text, /__RECHARGE_BRAND_WORKSPACE_URL__/)
  assert.match(mail.text, /获取验证码/)
  assert.match(mail.html, /进入代理工作台/)
  assert.doesNotMatch(mail.html + mail.text, /__RECHARGE_VERIFICATION_CODE__|10 分钟|身份验证/)
  assert.doesNotMatch(mail.text, /\b\d{6}\b/)
  assert.match(mail.html, /prefers-color-scheme: dark/)
  assert.doesNotMatch(mail.html, /<script|<svg|<iframe|onclick=/i)
  const env = { RESEND_FROM: '硅基生物 <noreply@meghan.example.test>', RESEND_API_KEY: 'test', PUBLIC_SITE_ORIGIN: 'https://meghan.example.test' } as Env
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    assert.equal(new Headers(options.headers).get('Idempotency-Key'), 'partner-welcome/invitation')
    const payload = JSON.parse(String(options.body))
    assert.deepEqual(payload.to, ['partner@example.test'])
    assert.equal(payload.html, siteEmail(env, mail).html)
    assert.equal(payload.text, siteEmail(env, mail).text)
    return Response.json({ id: 'invitation-mail' })
  })
  await sendPartnerInvitationEmail(env, 'partner@example.test', 'invitation')
})

test('Resend receives HTML and text together with stable idempotency and delivery errors propagate', async t => {
  const env = { RESEND_FROM: '硅基生物 <noreply@meghan.example.test>', RESEND_API_KEY: 'test', PUBLIC_SITE_ORIGIN: 'https://meghan.example.test' } as Env
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, 'https://api.resend.com/emails')
    assert.equal(new Headers(options.headers).get('Idempotency-Key'), 'order-recovery/challenge')
    const mail = JSON.parse(String(options.body))
    assert.deepEqual(mail.to, ['buyer@example.test'])
    assert.match(mail.html, /001234/)
    assert.match(mail.text, /001234/)
    assert.match(mail.subject, /订单找回/)
    return new Response('{}', { status: 200 })
  })
  await sendVerificationEmail(env, 'order-recovery', 'buyer@example.test', '001234', 'challenge')
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 500 }))
  await assert.rejects(sendVerificationEmail(env, 'partner-login', 'buyer@example.test', '001234', 'challenge'))
})
