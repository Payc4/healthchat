// End-to-end test with a fake Claude and a fake user. Run: node test/e2e.mjs
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright') // global install is fine
import { startMock } from './mock-claude.mjs'

const PORT = 3999
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = process.env.SHOTS || join(tmpdir(), 'hc-shots')
const dataDir = await mkdtemp(join(tmpdir(), 'hc-data-'))
const mock = await startMock(0)
const MOCK = `http://127.0.0.1:${mock.address().port}`

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ANTHROPIC_API_KEY: 'test-not-real', ANTHROPIC_API_BASE: MOCK, ADMIN_PASSWORD: 'pw-test', SESSION_SECRET: 'x'.repeat(40), DAILY_MESSAGE_LIMIT: '40' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
server.stdout.on('data', d => { serverLog += d }); server.stderr.on('data', d => { serverLog += d })
for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/health')).ok) break } catch {} await new Promise(r => setTimeout(r, 100)) }

const users = async () => (await readdir(join(dataDir, 'users')).catch(() => [])).filter(f => f.endsWith('.json'))
const userFile = async () => { const f = await users(); return JSON.parse(await readFile(join(dataDir, 'users', f.at(-1)), 'utf8')) }
const requests = async () => (await fetch(MOCK + '/requests')).json()
const settle = () => new Promise(r => setTimeout(r, 400))
const errors = []
const browser = await chromium.launch()
const step = name => console.log('✓', name)

try {
  // ── admin: login + invites ──
  const admin = await (await browser.newContext()).newPage()
  admin.on('pageerror', e => errors.push('admin: ' + e.message))
  await admin.goto(BASE + '/admin')
  await admin.fill('#pw', 'wrong'); await admin.click('#loginForm button')
  await admin.waitForSelector('.toast')
  await admin.fill('#pw', 'pw-test'); await admin.click('#loginForm button')
  await admin.waitForSelector('#main:not([hidden])')
  async function invite(label) {
    await admin.fill('#label', label); await admin.click('#inviteForm button')
    await admin.waitForFunction(l => document.querySelector('#newlink span')?.textContent.includes('/join/') && document.querySelector('#invites').textContent.includes(l), label)
    return admin.textContent('#newlink span')
  }
  const link1 = await invite('Fake tester A')
  step('admin login + invite link')

  // ── no invite: invite-only screen ──
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
  page.on('dialog', d => d.accept())
  await page.goto(BASE + '/')
  await page.waitForSelector('#none:not([hidden])')
  step('invite-only screen without a link')

  // ── gate ──
  await page.goto(link1)
  await page.waitForSelector('#gate:not([hidden])')
  assert.match(await page.textContent('#gateText'), /adults only/)
  await page.screenshot({ path: join(SHOTS, '1-gate.png') })
  await page.click('[data-gate=adult]')
  await page.waitForSelector('#chat:not([hidden]) .msg.coach')
  assert.match(await page.textContent('#chat'), /What are you hoping to get out of working with me/)
  assert.equal((await users()).length, 1)
  // invite can't be reused
  const reuse = await fetch(link1, { redirect: 'manual' })
  assert.equal(reuse.status, 410)
  step('age gate → profile created, first question shown, invite single-use')

  // ── chat + streaming + markdown safety ──
  async function say(text) {
    const before = await page.locator('.msg.coach').count()
    await page.fill('#msg', text)
    await page.click('#sendBtn')
    await page.waitForFunction(n => document.querySelectorAll('.msg.coach').length > n && !document.querySelector('.typing') && !document.querySelector('#sendBtn').disabled || document.querySelector('.msg.error'), before, { timeout: 10000 }).catch(() => {})
    await page.waitForFunction(() => !document.querySelector('#msg').disabled && !document.querySelector('.typing'))
    await settle()
  }
  await say('Hi, my name is Tomas and I want to lose weight')
  const last = page.locator('.msg.coach').last()
  assert.equal(await last.locator('table').count(), 1)
  assert.equal(await page.locator('.msg script').count(), 0)
  assert.match(await last.textContent(), /<script>/) // shown as text, not run
  let u = await userFile()
  assert.equal(u.profile.profile.display_name, 'Tomas')
  assert.equal(u.profile.goals.category, 'weight_loss')
  step('streamed reply, table rendered, HTML escaped, profile updated (name + goal)')

  await say('no conditions, no meds')
  let reqs = await requests()
  let coachReq = reqs.filter(r => r.stream).at(-1)
  assert.match(coachReq.system[1].text, /Tomas/)
  assert.match(coachReq.system[1].text, /MODE: WEIGHT LOSS/)
  assert.equal(coachReq.model, 'claude-sonnet-5-5')
  assert.ok(!JSON.stringify(coachReq).includes('test-not-real'))
  step('profile + persona mode in the system prompt, model claude-sonnet-5-5')

  // ── photo ──
  // a real 2400x1600 PNG made in the browser, so the resize path is exercised
  const png = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 2400; c.height = 1600; const x = c.getContext('2d'); x.fillStyle = '#c84'; x.fillRect(0, 0, 2400, 1600); return c.toDataURL('image/png').split(',')[1] }), 'base64')
  await page.setInputFiles('#file', { name: 'lunch.png', mimeType: 'image/png', buffer: png })
  await page.waitForSelector('#chip:not([hidden])')
  await page.screenshot({ path: join(SHOTS, '2-attach.png') })
  await say('my lunch')
  const sent = (await requests()).filter(r => r.stream).at(-1).messages.at(-1).content[0]
  assert.equal(sent.source.media_type, 'image/jpeg')
  assert.ok(sent.source.data.length < 400000, 'image was resized')
  assert.match(await page.locator('.msg.coach').last().textContent(), /I can see your photo/)
  assert.equal(await page.locator('.msg.me img.preview').count(), 1)
  u = await userFile()
  assert.equal(u.profile.food_log_summaries.length, 1)
  assert.ok(!JSON.stringify(u).includes('iVBOR') && !JSON.stringify(u).includes('/9j/'), 'image must not be stored')
  step('photo resized + sent, food log saved, image not stored')

  // ── PDF ──
  await page.setInputFiles('#file', { name: 'bloods.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%fake\n') })
  await say('')
  assert.match(await page.locator('.msg.coach').last().textContent(), /I read your PDF/)
  u = await userFile()
  assert.equal(u.profile.lab_markers[0].marker, 'Ferritin')
  assert.ok(!JSON.stringify(u).includes('JVBERi0'), 'PDF must not be stored')
  step('PDF sent alone, lab marker saved, PDF not stored')

  // ── error path ──
  await page.fill('#msg', 'FAIL500 please'); await page.click('#sendBtn')
  await page.waitForSelector('.msg.error')
  assert.equal(await page.inputValue('#msg'), 'FAIL500 please')
  u = await userFile()
  assert.ok(!u.turns.some(t => t.content.includes('FAIL500')))
  await page.fill('#msg', '')
  step('API error → friendly message, text kept, nothing saved')

  // ── memory across sessions ──
  await page.reload()
  await page.waitForSelector('#chat:not([hidden]) .msg.coach')
  assert.match(await page.textContent('#chat'), /my name is Tomas/)
  assert.ok(await page.locator('.msg.me .att').count() >= 2)
  step('reload: history restored (photo/PDF shown as labels)')

  // ── summary fold ──
  for (let i = 0; i < 9; i++) await say(`message number ${i}`)
  u = await userFile()
  assert.ok(u.summary.startsWith('SUMMARY'), 'summary written')
  assert.ok(u.turns.length <= 14, 'old turns folded, got ' + u.turns.length)
  await say('what do you remember?')
  coachReq = (await requests()).filter(r => r.stream).at(-1)
  assert.match(coachReq.system[1].text, /EARLIER CONVERSATION/)
  step(`summary fold (turns kept: ${u.turns.length}) and summary in later prompts`)
  await page.screenshot({ path: join(SHOTS, '3-chat.png') })

  // ── export ──
  const exp = await page.evaluate(async () => (await fetch('/api/me/export')).json())
  assert.equal(exp.profile.profile.display_name, 'Tomas')
  step('download my data')

  // ── admin sees the tester; relink ──
  await admin.reload(); await admin.waitForSelector('#users tr td strong')
  assert.match(await admin.textContent('#users'), /Tomas/)
  await admin.click('[data-relink]')
  await admin.waitForFunction(() => document.querySelector('#newlink').textContent.includes('Login link'))
  const relink = await admin.textContent('#newlink span')
  const phone2 = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage()
  await phone2.goto(relink)
  await phone2.waitForSelector('#chat:not([hidden]) .msg.coach')
  assert.match(await phone2.textContent('#chat'), /my name is Tomas/)
  step('admin list + login link logs the same tester in on a new device')

  // ── delete my data ──
  await page.click('#menuBtn'); await page.click('#deleteBtn')
  await page.waitForSelector('#none:not([hidden])')
  assert.equal((await users()).length, 0)
  step('delete my data removes the file')

  // ── ED flag ──
  const ed = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage()
  ed.on('pageerror', e => errors.push('ed: ' + e.message)); ed.on('dialog', d => d.accept())
  await ed.goto(await invite('Fake tester B')); await ed.click('[data-gate=adult]'); await ed.waitForSelector('.msg.coach')
  const sayOn = async (p, text) => { await p.fill('#msg', text); await p.click('#sendBtn'); await p.waitForFunction(() => !document.querySelector('.typing') && document.querySelector('#msg').value === ''); await settle() }
  await sayOn(ed, 'I want to lose weight and set a target')
  u = await userFile(); assert.equal(u.profile.nutrition.targets.calories, 1900)
  await sayOn(ed, 'honestly I binge and then purge sometimes')
  u = await userFile()
  assert.equal(u.profile.constraints.eating_disorder_flag, true)
  assert.equal(u.profile.nutrition.targets.calories, null)
  assert.ok(!JSON.stringify(u.profile).includes('purge'), 'no ED details in the profile')
  await sayOn(ed, 'ok')
  coachReq = (await requests()).filter(r => r.stream).at(-1)
  assert.match(coachReq.system[1].text, /DISORDERED-EATING SAFE/)
  assert.doesNotMatch(coachReq.system[1].text, /MODE: WEIGHT LOSS/)
  step('ED flag set, numeric targets wiped, ED-safe mode only, no details stored')

  // ── under 18 at the gate ──
  const kid = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage()
  const before = (await users()).length
  await kid.goto(await invite('Fake tester C')); await kid.click('[data-gate=minor]')
  await kid.waitForSelector('#declined:not([hidden])')
  assert.equal((await users()).length, before)
  await kid.reload(); await kid.waitForSelector('#none:not([hidden])')
  step('under 18 at gate → nothing stored, invite retired')

  // ── under 18 later in chat ──
  const kid2 = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage()
  await kid2.goto(await invite('Fake tester D')); await kid2.click('[data-gate=adult]'); await kid2.waitForSelector('.msg.coach')
  assert.equal((await users()).length, before + 1)
  await sayOn(kid2, 'actually I am 16')
  await settle()
  assert.equal((await users()).length, before, 'under-18 user deleted')
  await kid2.reload(); await kid2.waitForSelector('#none:not([hidden])')
  step('says under 18 in chat → everything deleted')

  // ── layout: no horizontal scroll at 390px ──
  for (const p of [ed, admin]) {
    const over = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    assert.equal(over, false, 'horizontal scroll')
  }
  await ed.screenshot({ path: join(SHOTS, '4-ed.png') })
  await admin.setViewportSize({ width: 390, height: 844 }); await admin.screenshot({ path: join(SHOTS, '5-admin-phone.png'), fullPage: true })
  await admin.setViewportSize({ width: 1280, height: 800 }); await admin.screenshot({ path: join(SHOTS, '6-admin.png'), fullPage: true })

  assert.deepEqual(errors, [])
  step('no JavaScript errors')
  console.log('\nALL PASSED')
} catch (e) {
  console.error('\nFAILED:', e)
  console.error('server log:\n' + serverLog.slice(-3000))
  process.exitCode = 1
} finally {
  await browser.close()
  server.kill()
  mock.close()
  await rm(dataDir, { recursive: true, force: true })
}
