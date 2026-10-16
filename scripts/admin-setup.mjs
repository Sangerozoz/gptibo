import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { writePrivateFile } from './private-files.mjs'

const configFile = fileURLToPath(new URL('../.dev.vars', import.meta.url))
const names = {
  username: 'ADMIN_USERNAME', email: 'ADMIN_EMAIL', totpSecret: 'ADMIN_TOTP_SECRET',
  resendKey: 'RESEND_API_KEY', resendFrom: 'RESEND_FROM',
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

async function readConfig(file) {
  try { return await readFile(file, 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error }
}

function configValues(content) {
  const values = {}
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match || !Object.values(names).includes(match[1])) continue
    const raw = match[2].trim()
    if (raw.startsWith('"')) {
      const quoted = /^"(?:\\.|[^"\\])*"/.exec(raw)?.[0]
      if (!quoted || !/^(?:\s+#.*)?$/.test(raw.slice(quoted.length))) throw new Error(`${match[1]} 的引号格式无效，请检查 .dev.vars。`)
      try { values[match[1]] = JSON.parse(quoted) }
      catch { throw new Error(`${match[1]} 的引号格式无效，请检查 .dev.vars。`) }
    } else values[match[1]] = raw.split(/\s+#/)[0].trim()
  }
  return values
}

function updateConfig(content, values) {
  const seen = new Set()
  const lines = content.split(/\r?\n/).filter((line, index, array) => index < array.length - 1 || line !== '')
  const updated = lines.flatMap(line => {
    const name = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1]
    if (!(name in values)) return [line]
    if (seen.has(name)) return []
    seen.add(name)
    return [`${name}=${JSON.stringify(values[name])}`]
  })
  for (const [name, value] of Object.entries(values)) if (!seen.has(name)) updated.push(`${name}=${JSON.stringify(value)}`)
  return updated.join('\n') + '\n'
}

export async function configureAdminVars(file, input) {
  const content = await readConfig(file)
  const previous = configValues(content)
  const username = (input.username ?? previous.ADMIN_USERNAME ?? '').trim()
  const email = (input.email ?? previous.ADMIN_EMAIL ?? '').trim()
  const resendKey = (input.resendKey ?? previous.RESEND_API_KEY ?? '').trim()
  const resendFrom = (input.resendFrom ?? previous.RESEND_FROM ?? '').trim()
  const existingSecret = input.totpSecret ?? previous.ADMIN_TOTP_SECRET ?? ''
  if (!username || username.length > 80) throw new Error('管理员用户名须为 1–80 个字符。')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('请输入有效的管理员邮箱。')
  if (!resendKey) throw new Error('需要 Resend API Key 才能发送登录邮箱验证码。')
  if (!/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/.test(resendFrom)) throw new Error('请输入有效的 Resend 发件地址。')
  if (existingSecret && !/^[A-Z2-7]{32}$/.test(existingSecret)) throw new Error('现有验证器密钥格式无效；请先检查 .dev.vars。')
  const generatedTotpSecret = !existingSecret
  const totpSecret = existingSecret || Array.from(randomBytes(32), byte => alphabet[byte & 31]).join('')
  const next = {
    ADMIN_USERNAME: username, ADMIN_EMAIL: email, ADMIN_TOTP_SECRET: totpSecret,
    RESEND_API_KEY: resendKey, RESEND_FROM: resendFrom,
  }
  await writePrivateFile(file, updateConfig(content, next))
  return { totpSecret, generatedTotpSecret, username }
}

async function hiddenQuestion(label) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') throw new Error('请在交互式终端中输入 Resend API Key。')
  process.stdout.write(label)
  return new Promise((resolveAnswer, reject) => {
    const input = process.stdin
    const wasRaw = input.isRaw
    const bytes = []
    const cleanup = () => { input.off('data', onData); input.setRawMode(Boolean(wasRaw)); input.pause() }
    const onData = chunk => {
      for (const byte of chunk) {
        if (byte === 3) { cleanup(); process.stdout.write('\n'); reject(new Error('已取消初始化。')); return }
        if (byte === 13 || byte === 10) { cleanup(); process.stdout.write('\n'); resolveAnswer(Buffer.from(bytes).toString('utf8')); return }
        if (byte === 127 || byte === 8) bytes.pop()
        else if (byte >= 32) bytes.push(byte)
      }
    }
    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write('在仓库根目录运行 npm run admin:setup，配置本地 Worker 管理员和 Resend 邮件。配置仅保存到被 Git 忽略的 .dev.vars。\n')
    return
  }
  if (!process.stdin.isTTY) throw new Error('请在交互式终端运行 npm run admin:setup。')
  const previous = configValues(await readConfig(configFile))
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let username, email, resendFrom
  try {
    username = (await rl.question(`管理员用户名${previous.ADMIN_USERNAME ? ` [${previous.ADMIN_USERNAME}]` : ''}: `)).trim() || previous.ADMIN_USERNAME
    email = (await rl.question(`管理员邮箱${previous.ADMIN_EMAIL ? ` [${previous.ADMIN_EMAIL}]` : ''}: `)).trim() || previous.ADMIN_EMAIL
    resendFrom = (await rl.question(`Resend 发件地址${previous.RESEND_FROM ? ` [${previous.RESEND_FROM}]` : ''}: `)).trim() || previous.RESEND_FROM
  } finally { rl.close() }
  const resendKey = previous.RESEND_API_KEY || await hiddenQuestion('Resend API Key（输入时不显示）: ')
  const result = await configureAdminVars(configFile, { username, email, resendFrom, resendKey })
  process.stdout.write('已写入本机 .dev.vars；该文件不会上传到 Git。\n')
  if (result.generatedTotpSecret) {
    const label = encodeURIComponent(`GPTibo:${result.username}`)
    const uri = `otpauth://totp/${label}?secret=${result.totpSecret}&issuer=GPTibo&algorithm=SHA1&digits=6&period=30`
    process.stdout.write(`请将以下地址导入验证器并妥善保存，仅显示这一次：\n${uri}\n`)
  } else process.stdout.write('已保留现有验证器密钥，请继续使用原验证器。\n')
  process.stdout.write('请确认 Resend 发件地址已验证，然后重启本地 Worker（8787）；Vite（5173）会继续代理到它。\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`管理员初始化失败：${error.message}\n`); process.exitCode = 1 })
}
