import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('admin setup creates a private Worker config that can enable admin and mail login', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gptibo-admin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, '.dev.vars')
  const { configureAdminVars } = await import('../scripts/admin-setup.mjs')
  const result = await configureAdminVars(file, {
    username: 'owner', email: 'owner@example.com', resendKey: 're_test_only', resendFrom: 'Store <mail@example.com>',
  })
  const contents = await readFile(file, 'utf8')
  assert.match(result.totpSecret, /^[A-Z2-7]{32}$/)
  assert.equal(result.generatedTotpSecret, true)
  assert.match(contents, /^ADMIN_USERNAME="owner"$/m)
  assert.match(contents, /^ADMIN_EMAIL="owner@example.com"$/m)
  assert.match(contents, new RegExp(`^ADMIN_TOTP_SECRET="${result.totpSecret}"$`, 'm'))
  assert.match(contents, /^RESEND_API_KEY="re_test_only"$/m)
  assert.match(contents, /^RESEND_FROM="Store <mail@example.com>"$/m)
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
})

test('admin setup preserves unrelated Worker settings and the enrolled TOTP secret', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gptibo-admin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, '.dev.vars')
  const enrolled = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  await writeFile(file, `ORDER_TESTING_ENABLED="false"\nADMIN_USERNAME=old\nADMIN_EMAIL=old@example.com\nADMIN_TOTP_SECRET=${enrolled}\nRESEND_API_KEY=old-key\nRESEND_FROM=old@example.com\n`)
  const { configureAdminVars } = await import('../scripts/admin-setup.mjs')
  const result = await configureAdminVars(file, { username: 'new-owner', email: 'new@example.com', resendKey: 'new-key', resendFrom: 'new@example.com' })
  const contents = await readFile(file, 'utf8')
  assert.equal(result.totpSecret, enrolled)
  assert.equal(result.generatedTotpSecret, false)
  assert.match(contents, /^ORDER_TESTING_ENABLED="false"$/m)
  assert.equal(contents.match(/^ADMIN_USERNAME=/gm)?.length, 1)
  assert.match(contents, /^ADMIN_USERNAME="new-owner"$/m)
})

test('invalid admin setup leaves an existing config untouched', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gptibo-admin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, '.dev.vars')
  const original = 'ORDER_TESTING_ENABLED="false"\n'
  await writeFile(file, original)
  const { configureAdminVars } = await import('../scripts/admin-setup.mjs')
  await assert.rejects(configureAdminVars(file, { username: 'owner', email: 'bad', resendKey: 'key', resendFrom: 'mail@example.com' }), /邮箱/)
  assert.equal(await readFile(file, 'utf8'), original)
})

test('admin setup reuses quoted existing credentials with inline comments', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gptibo-admin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, '.dev.vars')
  await writeFile(file, 'ADMIN_USERNAME="owner" # local owner\nADMIN_EMAIL="owner@example.com"\nRESEND_API_KEY="re_existing" # private\nRESEND_FROM="Store <mail@example.com>"\n')
  const { configureAdminVars } = await import('../scripts/admin-setup.mjs')
  await configureAdminVars(file, {})
  const contents = await readFile(file, 'utf8')
  assert.match(contents, /^ADMIN_USERNAME="owner"$/m)
  assert.match(contents, /^RESEND_API_KEY="re_existing"$/m)
})
