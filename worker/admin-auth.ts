import { ApiError, body, cookie, hash, json, LOGIN_SESSION_SECONDS, randomToken, readCookie, type Env } from './platform.ts'
import { validTotpSecret, verifyTotp } from './totp.ts'
import { sendVerificationEmail } from './email.ts'

// Server-owned destination; request parameters cannot override it.
export function adminLoginEmail(env: Env) {
  const value = env.ADMIN_EMAIL?.trim() ?? ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new ApiError('管理员邮箱尚未配置。', 503)
  return value
}

export function configured(env: Env) {
  try { return Boolean(adminLoginEmail(env) && env.ADMIN_USERNAME && validTotpSecret(env.ADMIN_TOTP_SECRET)) } catch { return false }
}
const mailReady = (env: Env) => Boolean(env.RESEND_API_KEY && env.RESEND_FROM)
const credentialVersion = (env: Env) => hash('admin-email-totp-v1:' + adminLoginEmail(env) + ':' + env.ADMIN_USERNAME + ':' + env.ADMIN_TOTP_SECRET)
const codeHash = (env: Env, version: string, id: string, code: string) => hash('admin-email:' + env.ADMIN_TOTP_SECRET + ':' + version + ':' + id + ':' + code)
const invalidLogin = () => new ApiError('用户名、邮箱验证码或 2FA 验证码不正确，或验证码已失效。', 401)
export async function requireAdmin(request: Request, env: Env) {
  if (!configured(env)) throw new ApiError('管理员验证器尚未配置，请先完成服务器初始化。', 503)
  const token = readCookie(request, 'admin')
  if (!token) throw new ApiError('请先登录管理后台。', 401)
  const session = await env.INTEREST_DB.prepare('SELECT expires_at, credential_version FROM admin_sessions WHERE token_hash = ?').bind(await hash(token)).first<{ expires_at: number; credential_version: string }>()
  if (!session || session.expires_at <= Date.now() || session.credential_version !== await credentialVersion(env)) throw new ApiError('登录已过期，请重新登录。', 401)
}
async function reserveAttempt(env: Env, key: string, now: number, maximum: number, duration = 15 * 60000) {
  const limit = await env.INTEREST_DB.prepare('INSERT INTO admin_login_limits(key,attempts,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts = CASE WHEN reset_at <= ? THEN 1 ELSE attempts + 1 END, reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END RETURNING attempts').bind(key, now + duration, now, now).first<{ attempts: number }>()
  if (!limit || limit.attempts > maximum) throw new ApiError('操作过于频繁，请稍后重试。', 429)
}
export async function authRoute(request: Request, env: Env, path: string) {
  if (path === '/api/admin/session' && request.method === 'GET') {
    if (!configured(env)) return json({ configured: false, authenticated: false, mailReady: mailReady(env), partnerModeEnabled: env.PARTNER_MODE_ENABLED !== 'false' })
    try { await requireAdmin(request, env); return json({ configured: true, authenticated: true, mailReady: mailReady(env), username: env.ADMIN_USERNAME, partnerModeEnabled: env.PARTNER_MODE_ENABLED !== 'false' }) }
    catch (e) { if (e instanceof ApiError && e.status === 401) return json({ configured: true, authenticated: false, mailReady: mailReady(env), partnerModeEnabled: env.PARTNER_MODE_ENABLED !== 'false' }); throw e }
  }
  if (path === '/api/admin/login/email-code' && request.method === 'POST') {
    const data = await body(request), db = env.INTEREST_DB
    if (!configured(env) || !mailReady(env)) throw new ApiError('管理员邮箱验证尚未配置，请联系管理员。', 503)
    if (typeof data.username !== 'string' || !data.username.trim() || data.username.length > 80) throw new ApiError('请填写管理员用户名。')
    const now = Date.now(), ip = request.headers.get('CF-Connecting-IP') ?? 'local'
    await reserveAttempt(env, await hash('admin-email-send-ip:' + ip), now, 10, 3600000)
    const id = crypto.randomUUID()
    const result = { challenge: id, message: '若用户名正确，验证码已发送至预设管理员邮箱，10 分钟内有效。', retryAfter: 60 }
    // Unknown usernames get the same response, without sending any email.
    if (data.username !== env.ADMIN_USERNAME) return json(result)
    const version = await credentialVersion(env)
    await reserveAttempt(env, await hash('admin-email-send-minute:' + version), now, 1, 60000)
    await reserveAttempt(env, await hash('admin-email-send-hour:' + version), now, 5, 3600000)
    let value: number
    do { value = crypto.getRandomValues(new Uint32Array(1))[0] } while (value >= 4294000000)
    const code = String(value % 1000000).padStart(6, '0')
    await db.batch([
      db.prepare('DELETE FROM admin_email_login_codes WHERE credential_version=? OR expires_at<=?').bind(version, now),
      db.prepare('INSERT INTO admin_email_login_codes(id,code_hash,credential_version,expires_at) VALUES (?,?,?,?)').bind(id, await codeHash(env, version, id, code), version, now + 600000),
    ])
    try {
      await sendVerificationEmail(env, 'admin-login', adminLoginEmail(env), code, id)
      await db.prepare('UPDATE admin_email_login_codes SET ready=1 WHERE id=?').bind(id).run()
    } catch {
      await db.prepare('DELETE FROM admin_email_login_codes WHERE id=?').bind(id).run()
      throw new ApiError('邮箱验证码发送失败，请稍后重试。', 503)
    }
    return json(result)
  }
  if (path === '/api/admin/login' && request.method === 'POST') {
    const data = await body(request)
    if (!configured(env)) throw new ApiError('管理员验证器尚未配置。', 503)
    const key = await hash('login:' + (request.headers.get('CF-Connecting-IP') ?? 'local'))
    const accountKey = await hash('totp-account:' + env.ADMIN_USERNAME)
    const now = Date.now()
    await reserveAttempt(env, key, now, 8)
    // A shared account limit also bounds distributed guesses of the six-digit code.
    await reserveAttempt(env, accountKey, now, 30)
    const db = env.INTEREST_DB
    if (typeof data.challenge !== 'string' || !/^[a-f0-9-]{36}$/.test(data.challenge) || typeof data.emailCode !== 'string' || !/^\d{6}$/.test(data.emailCode)) throw invalidLogin()
    const version = await credentialVersion(env)
    const challenge = await db.prepare('UPDATE admin_email_login_codes SET attempts=attempts+1 WHERE id=? AND credential_version=? AND ready=1 AND consumed_by IS NULL AND attempts<5 AND expires_at>? RETURNING code_hash').bind(data.challenge, version, now).first<{code_hash:string}>()
    if (!challenge || data.username !== env.ADMIN_USERNAME || challenge.code_hash !== await codeHash(env, version, data.challenge, data.emailCode)) throw invalidLogin()
    const step = await verifyTotp(env.ADMIN_TOTP_SECRET!, data.code, now)
    if (step === null) throw invalidLogin()
    const token = randomToken(), tokenHash = await hash(token)
    // Claim email, TOTP and session together; a losing concurrent request cannot
    // reuse another request's TOTP claim or consume an email code.
    await db.batch([
      db.prepare('DELETE FROM admin_sessions WHERE expires_at<=?').bind(now),
      db.prepare('INSERT INTO admin_totp_usage(credential_version,last_step,login_token) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM admin_email_login_codes WHERE id=? AND credential_version=? AND code_hash=? AND ready=1 AND consumed_by IS NULL AND attempts<=5 AND expires_at>?) ON CONFLICT(credential_version) DO UPDATE SET last_step=excluded.last_step,login_token=excluded.login_token WHERE admin_totp_usage.last_step<excluded.last_step').bind(version, step, tokenHash, data.challenge, version, challenge.code_hash, now),
      db.prepare('UPDATE admin_email_login_codes SET consumed_by=? WHERE id=? AND credential_version=? AND code_hash=? AND ready=1 AND consumed_by IS NULL AND attempts<=5 AND expires_at>? AND EXISTS(SELECT 1 FROM admin_totp_usage WHERE credential_version=? AND last_step=? AND login_token=?)').bind(tokenHash, data.challenge, version, challenge.code_hash, now, version, step, tokenHash),
      db.prepare('INSERT INTO admin_sessions(token_hash,credential_version,expires_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM admin_email_login_codes WHERE id=? AND consumed_by=?)').bind(tokenHash, version, now + LOGIN_SESSION_SECONDS * 1000, data.challenge, tokenHash),
      db.prepare('DELETE FROM admin_login_limits WHERE (key=? OR key=? OR reset_at<=?) AND EXISTS(SELECT 1 FROM admin_sessions WHERE token_hash=?)').bind(key, accountKey, now, tokenHash),
    ])
    if (!await db.prepare('SELECT token_hash FROM admin_sessions WHERE token_hash=?').bind(tokenHash).first()) throw invalidLogin()
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, 'admin', token, LOGIN_SESSION_SECONDS) })
  }
  if (path === '/api/admin/logout' && request.method === 'POST') {
    await body(request)
    const token = readCookie(request, 'admin')
    if (token) await env.INTEREST_DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(await hash(token)).run()
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, 'admin', '', 0) })
  }
  return null
}
