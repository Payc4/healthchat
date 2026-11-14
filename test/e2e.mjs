// End-to-end test with a fake Claude and a fake user. Run: node test/e2e.mjs
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright') // global install is fine
import { startMock } from './mock-claude.mjs'

const coach_FOLD = 24 // lib/coach.js FOLD_AT
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
const userBy = async email => { for (const f of await users()) { const u = JSON.parse(await readFile(join(dataDir, 'users', f), 'utf8')); if (u.account?.email === email) return u } return null }
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
  page.on('console', m => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push('console: ' + m.text()) }) // HTTP errors the test triggers on purpose are fine
  page.on('dialog', d => d.accept())
  await page.goto(BASE + '/')
  assert.match(await page.textContent('h1'), /gets to know you/)
  await page.screenshot({ path: join(SHOTS, '0-landing.png'), fullPage: true })
  await page.goto(BASE + '/app')
  await page.waitForSelector('#loginForm')
  assert.equal(new URL(page.url()).pathname, '/login')
  await page.goto(BASE + '/profile'); assert.equal(new URL(page.url()).pathname, '/login')
  step('landing page; /app and /profile send logged-out visitors to /login')

  // Sign-up after the 18+ buttons.
  async function signUp(p, name, email, password = 'correct horse') {
    await p.click('[data-gate=adult]')
    await p.waitForSelector('#signup:not([hidden])')
    await p.fill('#suName', name); await p.fill('#suEmail', email); await p.fill('#suPass', password)
    await p.click('#signupForm button[type=submit]')
    await p.waitForSelector('#chat:not([hidden]) .msg.coach')
  }

  // ── gate ──
  await page.goto(link1)
  await page.waitForSelector('#gate:not([hidden])')
  assert.match(await page.textContent('#gateText'), /adults only/)
  await page.screenshot({ path: join(SHOTS, '1-gate.png') })
  await page.click('[data-gate=adult]')
  await page.waitForSelector('#signup:not([hidden])')
  assert.equal((await users()).length, 0, 'nothing stored before the account form')
  await page.fill('#suName', 'Tomas'); await page.fill('#suEmail', 'not-an-email'); await page.fill('#suPass', 'short')
  await page.click('#signupForm button[type=submit]')
  await page.waitForSelector('#signupErr:not([hidden])')
  await page.fill('#suEmail', 'Tomas@Example.com'); await page.fill('#suPass', 'correct horse')
  await page.screenshot({ path: join(SHOTS, '1a-signup.png') })
  await page.click('#signupForm button[type=submit]')
  await page.waitForSelector('#chat:not([hidden]) .msg.coach')
  assert.match(await page.textContent('#chat'), /Thanks, Tomas! What are you hoping to get out of working with me/)
  assert.equal((await users()).length, 1)
  let acct = (await userFile()).account
  assert.equal(acct.email, 'tomas@example.com')
  assert.match(acct.password_hash, /^scrypt\$/)
  assert.ok(!JSON.stringify(await userFile()).includes('correct horse'), 'password not stored in plain text')
  // invite can't be reused
  const reuse = await fetch(link1, { redirect: 'manual' })
  assert.equal(reuse.status, 410)
  step('age gate → account form → account created (hashed password), first question, invite single-use')

  // ── first-time tip ──
  await page.waitForSelector('#tip:not([hidden])')
  await page.screenshot({ path: join(SHOTS, '1b-tip.png') })
  await page.click('#tipClose')
  assert.equal(await page.isHidden('#tip'), true)
  await page.reload(); await page.waitForSelector('#chat:not([hidden]) .msg.coach')
  assert.equal(await page.isHidden('#tip'), true, 'tip stays closed after reload')
  await page.click('#menuBtn'); await page.click('#helpBtn')
  await page.waitForSelector('#tip:not([hidden])')
  await page.click('#tipClose')
  step('how-it-works tip: shown once, closes, reopens from the menu')

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

  // ── empty reply (all thinking, no text) and cut-off reply ──
  await page.fill('#msg', 'EMPTYREPLY make me a schedule'); await page.click('#sendBtn')
  await page.waitForFunction(() => document.querySelectorAll('.msg.error').length >= 2)
  assert.match(await page.locator('.msg.error').last().textContent(), /more room/)
  u = await userFile()
  assert.ok(!u.turns.some(t => /EMPTYREPLY|couldn/.test(t.content)), 'empty reply not saved')
  await page.fill('#msg', '')
  await say('CUTREPLY long plan please')
  assert.match(await page.locator('.msg.coach').last().textContent(), /say "continue"/)
  const chatReq = (await requests()).filter(r => r.stream).at(-1)
  assert.equal(chatReq.max_tokens, 16000)
  assert.equal(chatReq.output_config.effort, 'medium')
  const toolReq = (await requests()).filter(r => r.tools).at(-1)
  assert.equal(toolReq.tool_choice.type, 'auto')
  assert.equal(toolReq.thinking.type, 'between_tools')
  step('empty reply → clear message, nothing saved; cut-off reply → "continue" note; token room + effort set')

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
  assert.ok(u.turns.length <= coach_FOLD, 'old turns folded, got ' + u.turns.length)
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
  await phone2.waitForSelector('#reset:not([hidden])')
  await phone2.click('#resetSkip')
  await phone2.waitForSelector('#chat:not([hidden]) .msg.coach')
  assert.match(await phone2.textContent('#chat'), /my name is Tomas/)
  step('admin list + login link logs the same tester in on a new device')

  // ── admin can read the chat (debugging) ──
  await admin.click('#users [data-chat]')
  await admin.waitForSelector('#chatView:not([hidden]) .cv-log .msg')
  assert.match(await admin.textContent('#cvLog'), /my name is Tomas/)
  assert.equal(await admin.locator('#cvLog script').count(), 0)
  assert.match(await admin.textContent('#cvProfile'), /"display_name": "Tomas"/)
  assert.ok(await admin.locator('#invites [data-chat]').count() >= 1, 'View chat on the used invite too')
  const noAdmin = await phone2.evaluate(async id => (await fetch('/api/admin/chat?user_id=' + id)).status, u.id)
  assert.equal(noAdmin, 401)
  await admin.setViewportSize({ width: 390, height: 844 }); await admin.screenshot({ path: join(SHOTS, '7-admin-chat.png'), fullPage: true })
  await admin.setViewportSize({ width: 1280, height: 800 })
  step('admin: View chat shows messages + profile; testers can\'t call it')

  // ── log out + log in ──
  await page.click('#menuBtn'); await page.click('#logoutBtn')
  await page.waitForURL(BASE + '/')
  await page.goto(BASE + '/login')
  await page.fill('#email', 'tomas@example.com'); await page.fill('#password', 'wrong password')
  await page.click('#go'); await page.waitForSelector('#err:not([hidden])')
  assert.match(await page.textContent('#err'), /don’t match/)
  await page.fill('#email', ' TOMAS@example.com '); await page.fill('#password', 'correct horse')
  await page.screenshot({ path: join(SHOTS, '8-login.png') })
  await page.click('#go'); await page.waitForURL(BASE + '/app')
  await page.waitForSelector('#chat:not([hidden]) .msg.coach')
  await page.goto(BASE + '/'); assert.equal(new URL(page.url()).pathname, '/app', 'logged-in visitors skip the landing page')
  step('log out; wrong password refused; log in with email (any case/spaces) + password')

  // ── dashboard ──
  await page.goto(BASE + '/profile')
  await page.waitForFunction(() => document.querySelector('#sMsgs').textContent !== '–')
  assert.ok(Number(await page.textContent('#sMsgs')) >= 10)
  assert.equal(await page.textContent('#sDays'), '1')
  assert.equal(await page.textContent('#sStreak'), '1')
  assert.match(await page.textContent('#pGoal'), /Lose some weight/)
  assert.match(await page.textContent('#pNumbers'), /Ferritin/)
  await page.screenshot({ path: join(SHOTS, '9-progress.png'), fullPage: true })
  await page.click('#tab-knows')
  assert.match(await page.textContent('#knowsBody'), /Ferritin/)
  await page.screenshot({ path: join(SHOTS, '10-knows.png'), fullPage: true })
  await page.click('#knowsBody [data-remove="lab_markers"]')
  await page.waitForSelector('.toast')
  u = await userFile(); assert.equal(u.profile.lab_markers.length, 0, 'lab marker removed')
  await page.selectOption('select[data-field="profile.preferences.coaching_style"]', 'gentle')
  await page.waitForFunction(async () => true); await settle()
  u = await userFile(); assert.equal(u.profile.profile.preferences.coaching_style, 'gentle')
  await page.fill('#goalIn', 'Lose 5 kg by summer'); await page.click('form[data-set="goals.primary"] button')
  await settle(); u = await userFile(); assert.equal(u.profile.goals.primary, 'Lose 5 kg by summer')
  // stale removal is refused
  const stale = await page.evaluate(async () => (await fetch('/api/profile/remove', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ list: 'supplements', index: 0, item: { name: 'nope' } }) })).status)
  assert.equal(stale, 409)
  const notAllowed = await page.evaluate(async () => (await fetch('/api/profile/set', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ field: 'constraints.eating_disorder_flag', value: false }) })).status)
  assert.equal(notAllowed, 400)
  step('dashboard: stats, goal, numbers; remove a lab result; change style + goal; stale/forbidden edits refused')

  // ── account settings ──
  await page.click('#tab-account')
  await page.fill('#aName', 'Tomas K'); await page.click('#nameForm button'); await settle()
  u = await userFile(); assert.equal(u.account.name, 'Tomas K'); assert.equal(u.profile.profile.display_name, 'Tomas K')
  await page.fill('#aCur', 'wrong'); await page.fill('#aNew', 'new password 1'); await page.click('#passForm button')
  await page.waitForSelector('#err:not([hidden])')
  await page.fill('#aCur', 'correct horse'); await page.fill('#aNew', 'new password 1'); await page.click('#passForm button')
  await page.waitForFunction(() => document.querySelector('#err').hidden); await settle()
  await page.screenshot({ path: join(SHOTS, '11-account.png'), fullPage: true })
  // the other device (phone2) is logged out by the password change
  await phone2.goto(BASE + '/app'); await phone2.waitForSelector('#loginForm')
  // this device stays logged in
  await page.goto(BASE + '/app'); await page.waitForSelector('#chat:not([hidden])')
  step('change name; wrong current password refused; new password logs out other devices, keeps this one')

  // ── forgotten password: login link → choose a new one ──
  await admin.reload(); await admin.waitForSelector('#users [data-relink]')
  await admin.click('#users [data-relink]')
  await admin.waitForFunction(() => document.querySelector('#newlink').textContent.includes('Login link'))
  const resetLink = await admin.textContent('#newlink span')
  await phone2.goto(resetLink)
  await phone2.waitForSelector('#reset:not([hidden])')
  await phone2.fill('#rsPass', 'brand new pass'); await phone2.click('#resetForm button[type=submit]')
  await phone2.waitForSelector('#chat:not([hidden]) .msg.coach')
  const login2 = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ email: 'tomas@example.com', password: 'brand new pass' }) })
  assert.equal(login2.status, 200)
  step('forgot password: admin login link → set a new password without the old one')

  // ── legacy tester (from before accounts) sets up a login ──
  const { createHmac } = await import('node:crypto')
  const legacyId = 'legacyTester0001'
  const now = new Date().toISOString()
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(dataDir, 'users', legacyId + '.json'), JSON.stringify({ id: legacyId, label: 'Old tester', created_at: now, profile: { ...(await userFile()).profile, profile: { display_name: 'Rasa', preferences: {} } }, turns: [], log: [{ role: 'assistant', content: 'Old chat', ts: now }], summary: '', stats: { messages: 3 } }))
  const legacy = await browser.newContext({ viewport: { width: 390, height: 844 } })
  await legacy.addCookies([{ name: 'hc_session', value: legacyId + '.' + createHmac('sha256', 'x'.repeat(40)).update(legacyId).digest('base64url'), url: BASE }])
  const lp = await legacy.newPage()
  await lp.goto(BASE + '/app'); await lp.waitForSelector('#claim:not([hidden])')
  assert.equal(await lp.inputValue('#clName'), 'Rasa')
  await lp.fill('#clEmail', 'tomas@example.com'); await lp.fill('#clPass', 'rasa password')
  await lp.click('#claimForm button[type=submit]'); await lp.waitForSelector('#claimErr:not([hidden])')
  assert.match(await lp.textContent('#claimErr'), /already used/)
  await lp.fill('#clEmail', 'rasa@example.com'); await lp.click('#claimForm button[type=submit]')
  await lp.waitForSelector('#chat:not([hidden]) .msg.coach')
  assert.match(await lp.textContent('#chat'), /Old chat/)
  step('tester from before accounts: asked once for email + password, chat kept; duplicate email refused')

  // ── delete account from the dashboard ──
  const countBefore = (await users()).length
  // the first device was logged out when the password was reset on phone2
  await page.goto(BASE + '/profile'); assert.equal(new URL(page.url()).pathname, '/login')
  phone2.on('dialog', d => d.accept())
  await phone2.goto(BASE + '/profile#account'); await phone2.waitForSelector('#account:not([hidden])')
  await phone2.click('#deleteAcct'); await phone2.waitForURL(BASE + '/')
  assert.equal((await users()).length, countBefore - 1)
  step('delete account from the dashboard removes the file')

  // ── ED flag ──
  const ed = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage()
  ed.on('pageerror', e => errors.push('ed: ' + e.message)); ed.on('dialog', d => d.accept())
  await ed.goto(await invite('Fake tester B')); await signUp(ed, 'Bea', 'bea@example.com')
  const sayOn = async (p, text) => { await p.fill('#msg', text); await p.click('#sendBtn'); await p.waitForFunction(() => !document.querySelector('.typing') && document.querySelector('#msg').value === ''); await settle() }
  await sayOn(ed, 'I want to lose weight and set a target')
  u = await userBy('bea@example.com'); assert.equal(u.profile.nutrition.targets.calories, 1900)
  await sayOn(ed, 'honestly I binge and then purge sometimes')
  u = await userBy('bea@example.com')
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
  await kid.reload(); await kid.waitForSelector('#loginForm')
  step('under 18 at gate → nothing stored, invite retired')

  // ── under 18 later in chat ──
  const kid2 = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage()
  await kid2.goto(await invite('Fake tester D')); await signUp(kid2, 'Dan', 'dan@example.com')
  assert.equal((await users()).length, before + 1)
  await sayOn(kid2, 'actually I am 16')
  await settle()
  assert.equal((await users()).length, before, 'under-18 user deleted')
  await kid2.reload(); await kid2.waitForSelector('#loginForm')
  step('says under 18 in chat → everything deleted')

  // ── layout: no horizontal scroll at 390px ──
  const land = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage()
  await land.goto(BASE + '/')
  await page.goto(BASE + '/login')
  for (const p of [ed, admin, land]) {
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
