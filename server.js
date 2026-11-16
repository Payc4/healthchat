// Health Coach — closed-alpha web app. No dependencies; Node 22+.
//
// Env: ANTHROPIC_API_KEY (required for replies), ADMIN_PASSWORD (required for /admin),
//      SESSION_SECRET (long random string; keeps people logged in across restarts),
//      CLAUDE_MODEL (default claude-sonnet-5-5), DAILY_MESSAGE_LIMIT (default 60),
//      APP_NAME (default "Health Coach"), DATA_DIR (default ./data), PORT (default 3000),
//      COACH_EFFORT (default medium), ADMIN_READ_CHATS (set to off to hide testers' chats from admin).

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { extname, join } from 'node:path'
import * as store from './lib/store.js'
import * as claude from './lib/claude.js'
import * as coach from './lib/coach.js'
import * as auth from './lib/auth.js'

const PORT = Number(process.env.PORT || 3000)
const APP_NAME = process.env.APP_NAME || 'Health Coach'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''
const DAILY_LIMIT = Number(process.env.DAILY_MESSAGE_LIMIT || 60)
// Landing page "For partners" button opens an email to this address; no button while it's unset.
const PARTNER_EMAIL = (process.env.PARTNER_EMAIL || '').trim()
const SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex')
const PUBLIC = new URL('./public/', import.meta.url).pathname
const MAX_CHAT_BYTES = 16 * 1024 * 1024
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const LOG_LIMIT = 400

if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET is not set: everyone is logged out on every restart. Set it in Coolify.')
if (!ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD is not set: /admin is disabled.')
const CAN_READ_CHATS = process.env.ADMIN_READ_CHATS !== 'off'
if (!claude.configured()) console.warn('ANTHROPIC_API_KEY is not set: the coach cannot reply.')

await store.init()

// ───────────── helpers ─────────────

const sign = v => v + '.' + createHmac('sha256', SECRET).update(v).digest('base64url')
function unsign(s) {
  const i = String(s || '').lastIndexOf('.')
  if (i < 1) return null
  const v = s.slice(0, i)
  const a = Buffer.from(sign(v)), b = Buffer.from(s)
  return a.length === b.length && timingSafeEqual(a, b) ? v : null
}
const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]))
const isHttps = req => req.headers['x-forwarded-proto'] === 'https'
function cookie(req, name, value, maxAgeDays, sameSite = 'Lax') {
  return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${Math.round(maxAgeDays * 86400)}${isHttps(req) ? '; Secure' : ''}`
}
// Session cookie = signed "<userId>:<version>". Bumping account.sv (password change, "log out
// everywhere") ends every other session. Old cookies without a version count as version 0.
const sessionValue = user => sign(`${user.id}:${user.account?.sv || 0}`)
async function sessionUser(req) {
  const v = unsign(cookies(req).hc_session)
  if (!v) return null
  const [id, sv = '0'] = v.split(':')
  const user = await store.getUser(id)
  return user && String(user.account?.sv || 0) === sv ? user : null
}
/** Set by a login link from the admin page: lets that person choose a new password without the old one. */
function resetAllowed(req, user) {
  const v = unsign(cookies(req).hc_reset)
  if (!v) return false
  const [id, until] = v.split(':')
  return id === user.id && Number(until) > Date.now()
}
const loginLimit = auth.limiter(8, 15)
const pendingInvite = req => unsign(cookies(req).hc_invite)
const isAdmin = req => Boolean(ADMIN_PASSWORD) && unsign(cookies(req).hc_admin) === 'admin'

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string'
  res.writeHead(status, { 'content-type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(isJson ? JSON.stringify(body) : body)
}

async function readJson(req, max = 64 * 1024) {
  let size = 0
  const chunks = []
  for await (const c of req) {
    size += c.length
    if (size > max) throw Object.assign(new Error('That file is too large.'), { status: 413 })
    chunks.push(c)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw Object.assign(new Error('Bad request.'), { status: 400 }) }
}

/** Requests that change things must come from our own pages (blocks cross-site form posts). */
const sameOrigin = req => req.headers['x-requested-with'] === 'fetch'

function sameSecret(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' }
async function sendFile(res, name) {
  try {
    const body = await readFile(join(PUBLIC, name))
    res.writeHead(200, { 'content-type': TYPES[extname(name)] || 'application/octet-stream', 'cache-control': name.endsWith('.html') ? 'no-store' : 'public, max-age=300', 'x-content-type-options': 'nosniff' })
    res.end(body)
  } catch { send(res, 404, 'Not found') }
}

/** Display log for the chat page: text only, no images or files are kept. */
const logView = u => (u.log || []).map(t => ({ role: t.role, content: t.content, attachment: t.attachment || null, ts: t.ts }))
const today = () => new Date().toISOString().slice(0, 10)
const sentToday = u => (u.log || []).filter(t => t.role === 'user' && t.ts.startsWith(today())).length

// ───────────── routes ─────────────

async function handle(req, res) {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname

  if (path === '/health') return send(res, 200, { ok: true })

  // Invite link: /join/<token>
  const join_ = path.match(/^\/join\/([A-Za-z0-9_-]{8,64})$/)
  if (join_ && req.method === 'GET') {
    const inv = await store.findInvite(join_[1])
    if (!inv || inv.used_at) return send(res, 410, page('This invite link has already been used or is no longer valid. Ask for a new one.'))
    if (inv.user_id && (await store.getUser(inv.user_id))) {
      // Login link for an existing tester (new phone, cleared cookies).
      // It also opens a 1-hour window to set a new password (there's no reset email).
      await store.useInvite(inv.token)
      const user = await store.getUser(inv.user_id)
      res.writeHead(303, { location: '/app', 'set-cookie': [cookie(req, 'hc_session', sessionValue(user), 365), cookie(req, 'hc_invite', '', 0), cookie(req, 'hc_reset', sign(`${user.id}:${Date.now() + 3600e3}`), 1 / 24)] })
      return res.end()
    }
    res.writeHead(303, { location: '/app', 'set-cookie': cookie(req, 'hc_invite', sign(inv.token), 7) })
    return res.end()
  }

  // Pages. Logged-in people skip the landing and login pages.
  if (path === '/' || path === '/login') {
    if (await sessionUser(req)) return redirect(res, '/app')
    if (path === '/login') return sendFile(res, 'login.html')
    const html = (await readFile(join(PUBLIC, 'landing.html'), 'utf8')).replace('<!--PARTNER_CTA-->', PARTNER_EMAIL
      ? `<a class="btn" href="mailto:${encodeURIComponent(PARTNER_EMAIL).replace('%40', '@')}?subject=${encodeURIComponent('Tailored AI coach for our customers')}">Book a demo</a>`
      : '')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(html)
  }
  if (path === '/app' || path === '/index.html') return sendFile(res, 'index.html')
  if (path === '/profile') {
    if (!(await sessionUser(req))) return redirect(res, '/login')
    return sendFile(res, 'profile.html')
  }
  if (path === '/admin') return sendFile(res, 'admin.html')
  if (['/app.js', '/admin.js', '/login.js', '/profile.js', '/styles.css', '/favicon.svg', '/manifest.webmanifest'].includes(path)) return sendFile(res, path.slice(1))

  if (!path.startsWith('/api/')) return send(res, 404, page('Page not found.'))
  if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, { error: 'Forbidden.' })

  // ── user ──
  if (path === '/api/me' && req.method === 'GET') {
    const user = await sessionUser(req)
    if (user && !user.account?.email) return send(res, 200, { state: 'claim', appName: APP_NAME, name: user.profile.profile.display_name })
    if (user && resetAllowed(req, user)) return send(res, 200, { state: 'reset', appName: APP_NAME, email: user.account.email })
    if (user) return send(res, 200, { state: 'active', appName: APP_NAME, name: user.account.name || user.profile.profile.display_name, log: logView(user), summarised: Boolean(user.summary), limit: DAILY_LIMIT, sentToday: sentToday(user) })
    const token = pendingInvite(req)
    const inv = token && (await store.findInvite(token))
    if (inv && !inv.used_at) return send(res, 200, { state: 'gate', appName: APP_NAME, gateText: coach.AGE_GATE_TEXT })
    return send(res, 200, { state: 'none', appName: APP_NAME })
  }

  if (path === '/api/gate' && req.method === 'POST') {
    const token = pendingInvite(req)
    const inv = token && (await store.findInvite(token))
    if (!inv || inv.used_at) return send(res, 410, { error: 'This invite is no longer valid. Ask for a new link.' })
    const { answer } = await readJson(req)
    if (answer === 'minor') {
      // Hard rule: store nothing about someone under 18 — just retire the link.
      await store.useInvite(inv.token)
      return send(res, 200, { state: 'declined' }, { 'set-cookie': cookie(req, 'hc_invite', '', 0) })
    }
    if (answer !== 'adult') return send(res, 400, { error: 'Please choose one of the buttons.' })
    // Nothing is stored yet: the account is created on the next step.
    return send(res, 200, { state: 'signup' })
  }

  // ── accounts ──
  if (path === '/api/signup' && req.method === 'POST') {
    const token = pendingInvite(req)
    const inv = token && (await store.findInvite(token))
    if (!inv || inv.used_at) return send(res, 410, { error: 'This invite is no longer valid. Ask for a new link.' })
    const body = await readJson(req)
    if (body.adult !== true) return send(res, 400, { error: 'Please confirm you are 18 or over.' })
    const name = String(body.name || '').trim().slice(0, 60)
    const email = auth.normalizeEmail(body.email)
    if (!name) return send(res, 400, { error: 'Please add your first name.' })
    if (!auth.validEmail(email)) return send(res, 400, { error: 'Please enter a valid email address.' })
    const bad = auth.passwordProblem(body.password)
    if (bad) return send(res, 400, { error: bad })
    const hash = await auth.hashPassword(body.password)
    return store.withLock('emails', async () => {
      if (await store.findUserByEmail(email)) return send(res, 409, { error: 'There is already an account with this email. Log in instead.' })
      const id = store.newId()
      if (!(await store.useInvite(inv.token, id))) return send(res, 410, { error: 'This invite was just used. Ask for a new link.' })
      const now = new Date().toISOString()
      const first = { role: 'assistant', content: coach.FIRST_QUESTION.replace(/^Thanks!/, `Thanks, ${name}!`), ts: now }
      const user = { id, label: inv.label, created_at: now, account: { email, name, password_hash: hash, sv: 0 }, profile: coach.newProfile(name, now), turns: [first], log: [first], summary: '', stats: { messages: 0, input_tokens: 0, output_tokens: 0 } }
      await store.saveUser(user)
      return send(res, 200, { ok: true }, { 'set-cookie': [cookie(req, 'hc_session', sessionValue(user), 365), cookie(req, 'hc_invite', '', 0)] })
    })
  }

  if (path === '/api/login' && req.method === 'POST') {
    const body = await readJson(req)
    const email = auth.normalizeEmail(body.email)
    const key = `${req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress}|${email}`
    if (loginLimit.blocked(key)) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes, or ask for a login link.' })
    const user = await store.findUserByEmail(email)
    const ok = user ? await auth.verifyPassword(body.password || '', user.account.password_hash) : await auth.burnTime(body.password || '')
    if (!ok) { loginLimit.fail(key); return send(res, 401, { error: 'That email and password don’t match. Check them and try again.' }) }
    loginLimit.clear(key)
    return send(res, 200, { ok: true }, { 'set-cookie': [cookie(req, 'hc_session', sessionValue(user), 365), cookie(req, 'hc_invite', '', 0)] })
  }

  if (path === '/api/logout' && req.method === 'POST') {
    return send(res, 200, { ok: true }, { 'set-cookie': [cookie(req, 'hc_session', '', 0), cookie(req, 'hc_reset', '', 0)] })
  }

  if (path.startsWith('/api/account/') || path === '/api/dashboard' || path.startsWith('/api/profile/')) {
    const user = await sessionUser(req)
    if (!user) return send(res, 401, { error: 'Please log in again.' })
    return store.withLock(user.id, async () => account(req, res, path, await store.getUser(user.id)))
  }

  if (path === '/api/chat' && req.method === 'POST') return chat(req, res)

  if (path === '/api/me/export' && req.method === 'GET') {
    const user = await sessionUser(req)
    if (!user) return send(res, 401, { error: 'Not signed in.' })
    const { id, account: acc, ...data } = user
    data.account = { email: acc?.email || null, name: acc?.name || null }
    return send(res, 200, data, { 'content-disposition': 'attachment; filename="my-health-coach-data.json"' })
  }

  if (path === '/api/me/delete' && req.method === 'POST') {
    const user = await sessionUser(req)
    if (user) await store.withLock(user.id, async () => { await store.deleteUser(user.id); await store.forgetUserInInvites(user.id) })
    return send(res, 200, { ok: true }, { 'set-cookie': [cookie(req, 'hc_session', '', 0), cookie(req, 'hc_reset', '', 0)] })
  }

  // ── admin ──
  if (path === '/api/admin/login' && req.method === 'POST') {
    const { password } = await readJson(req)
    if (!ADMIN_PASSWORD) return send(res, 503, { error: 'Admin is off: set ADMIN_PASSWORD in Coolify and redeploy.' })
    if (!sameSecret(password || '', ADMIN_PASSWORD)) { await new Promise(r => setTimeout(r, 600)); return send(res, 401, { error: 'Wrong password.' }) }
    return send(res, 200, { ok: true }, { 'set-cookie': cookie(req, 'hc_admin', sign('admin'), 7, 'Strict') })
  }
  if (path === '/api/admin/logout' && req.method === 'POST') return send(res, 200, { ok: true }, { 'set-cookie': cookie(req, 'hc_admin', '', 0, 'Strict') })
  if (path.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return send(res, 401, { error: ADMIN_PASSWORD ? 'Please log in.' : 'Admin is off: set ADMIN_PASSWORD.' })
    return admin(req, res, path.slice('/api/admin/'.length))
  }

  return send(res, 404, { error: 'Not found.' })
}

async function admin(req, res, action) {
  const base = `${isHttps(req) ? 'https' : 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`
  if (action === 'state' && req.method === 'GET') {
    const users = (await store.listUsers()).map(u => ({
      id: u.id,
      label: u.label,
      name: u.account?.name || u.profile.profile.display_name,
      email: u.account?.email || null,
      created_at: u.created_at,
      last_active: (u.log || []).filter(t => t.role === 'user').pop()?.ts || null,
      messages: u.stats?.messages || 0,
      tokens: (u.stats?.input_tokens || 0) + (u.stats?.output_tokens || 0),
      onboarded: Boolean(u.profile.goals.primary && u.profile.meta.constraints_asked),
    }))
    const invites = (await store.listInvites()).slice().reverse().map(i => ({ ...i, url: `${base}/join/${i.token}` }))
    return send(res, 200, { users, invites, model: claude.MODEL, aiReady: claude.configured(), limit: DAILY_LIMIT, persistentSessions: Boolean(process.env.SESSION_SECRET), canReadChats: CAN_READ_CHATS })
  }
  // Read one tester's chat and what the coach remembers (for debugging). Off with ADMIN_READ_CHATS=off.
  if (action === 'chat' && req.method === 'GET') {
    if (!CAN_READ_CHATS) return send(res, 403, { error: 'Reading chats is turned off (ADMIN_READ_CHATS=off).' })
    const user = await store.getUser(new URL(req.url, 'http://x').searchParams.get('user_id'))
    if (!user) return send(res, 404, { error: 'Tester not found.' })
    console.log(`Admin viewed chat of tester ${user.id}`)
    return send(res, 200, {
      id: user.id,
      label: user.label,
      name: user.profile.profile.display_name,
      created_at: user.created_at,
      log: user.log || [],
      memory: { recent_messages: user.turns.length, summary: user.summary || '', profile: user.profile },
      stats: user.stats,
    })
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' })
  const body = await readJson(req)
  if (action === 'invite') {
    const inv = await store.createInvite(body.label || 'Tester')
    return send(res, 200, { url: `${base}/join/${inv.token}` })
  }
  if (action === 'relink') {
    const user = await store.getUser(body.user_id)
    if (!user) return send(res, 404, { error: 'User not found.' })
    const inv = await store.createInvite(`${user.label || 'Tester'} (login link)`, user.id)
    return send(res, 200, { url: `${base}/join/${inv.token}` })
  }
  if (action === 'delete-user') {
    await store.withLock(body.user_id, async () => { await store.deleteUser(body.user_id); await store.forgetUserInInvites(body.user_id) })
    return send(res, 200, { ok: true })
  }
  if (action === 'delete-invite') {
    await store.deleteInvite(body.token)
    return send(res, 200, { ok: true })
  }
  return send(res, 404, { error: 'Unknown action.' })
}

// ───────────── account + dashboard ─────────────

// Lists in the profile that a person may remove items from, from their dashboard.
const REMOVABLE = ['goals.secondary', 'constraints.conditions', 'constraints.medications', 'constraints.injuries', 'constraints.allergies',
  'constraints.therapies', 'nutrition.restrictions', 'activity.current_training', 'supplements', 'lab_markers', 'wearable.metrics',
  'food_log_summaries', 'coach_notes']
// Single values they may change.
const EDITABLE = {
  'goals.primary': v => (v === null || v === '' ? null : String(v).trim().slice(0, 200) || null),
  'profile.preferences.coaching_style': v => (['direct', 'gentle'].includes(v) ? v : null),
  'profile.preferences.response_length': v => (['brief', 'detailed'].includes(v) ? v : null),
}
const at = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj)
function put(obj, path, value) {
  const keys = path.split('.'); const last = keys.pop()
  keys.reduce((o, k) => o[k], obj)[last] = value
}

/** What the dashboard shows. The eating-disorder flag is never sent (it's only used by the coach). */
function dashboard(user) {
  const days = new Map()
  let photos = 0, pdfs = 0
  for (const t of user.log || []) {
    if (t.role !== 'user') continue
    const d = t.ts.slice(0, 10)
    days.set(d, (days.get(d) || 0) + 1)
    if (t.attachment === 'photo') photos++
    if (t.attachment === 'PDF') pdfs++
  }
  const day = n => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10)
  let streak = 0
  for (let n = days.has(day(0)) ? 0 : 1; days.has(day(n)); n++) streak++
  const { meta, ...profile } = structuredClone(user.profile)
  delete profile.constraints.eating_disorder_flag
  delete profile.profile.age_confirmed_18_plus
  return {
    account: { name: user.account?.name || user.profile.profile.display_name || '', email: user.account?.email || '', created_at: user.created_at },
    stats: {
      messages: user.stats?.messages || 0,
      days_active: days.size,
      streak,
      photos,
      pdfs,
      last14: Array.from({ length: 14 }, (_, i) => { const d = day(13 - i); return { date: d, count: days.get(d) || 0 } }),
    },
    profile,
    memory: { summarised: Boolean(user.summary) },
  }
}

async function account(req, res, path, user) {
  if (path === '/api/dashboard' && req.method === 'GET') return send(res, 200, dashboard(user))
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' })
  const body = await readJson(req)
  const save = async (extraCookies = []) => { await store.saveUser(user); return send(res, 200, { ok: true, ...dashboard(user) }, extraCookies.length ? { 'set-cookie': extraCookies } : {}) }
  const checkPassword = async () => user.account?.password_hash && (await auth.verifyPassword(body.password || '', user.account.password_hash))
  const takeEmail = email => store.withLock('emails', async () => {
    const other = await store.findUserByEmail(email)
    return !other || other.id === user.id
  })

  // Testers from before accounts existed: add email + password once.
  if (path === '/api/account/claim') {
    if (user.account?.email) return send(res, 400, { error: 'Your login is already set up.' })
    const name = String(body.name || '').trim().slice(0, 60)
    const email = auth.normalizeEmail(body.email)
    if (!name) return send(res, 400, { error: 'Please add your first name.' })
    if (!auth.validEmail(email)) return send(res, 400, { error: 'Please enter a valid email address.' })
    const bad = auth.passwordProblem(body.password)
    if (bad) return send(res, 400, { error: bad })
    if (!(await takeEmail(email))) return send(res, 409, { error: 'That email is already used by another account.' })
    user.account = { email, name, password_hash: await auth.hashPassword(body.password), sv: user.account?.sv || 0 }
    if (!user.profile.profile.display_name) user.profile.profile.display_name = name
    return save([cookie(req, 'hc_session', sessionValue(user), 365)])
  }
  if (!user.account?.email) return send(res, 403, { error: 'Please set up your login first.' })
  if (path === '/api/account/name') {
    const name = String(body.name || '').trim().slice(0, 60)
    if (!name) return send(res, 400, { error: 'Please enter a name.' })
    user.account.name = name
    user.profile.profile.display_name = name
    return save()
  }
  if (path === '/api/account/email') {
    const email = auth.normalizeEmail(body.email)
    if (!auth.validEmail(email)) return send(res, 400, { error: 'Please enter a valid email address.' })
    if (!(await checkPassword())) return send(res, 403, { error: 'Your current password isn’t right.' })
    if (!(await takeEmail(email))) return send(res, 409, { error: 'That email is already used by another account.' })
    user.account.email = email
    return save()
  }
  if (path === '/api/account/password') {
    const resetting = resetAllowed(req, user)
    if (!resetting && !(await checkPassword())) return send(res, 403, { error: 'Your current password isn’t right.' })
    const bad = auth.passwordProblem(body.new_password)
    if (bad) return send(res, 400, { error: bad })
    user.account.password_hash = await auth.hashPassword(body.new_password)
    user.account.sv = (user.account.sv || 0) + 1 // logs out every other device
    return save([cookie(req, 'hc_session', sessionValue(user), 365), cookie(req, 'hc_reset', '', 0)])
  }
  if (path === '/api/account/skip-reset') return send(res, 200, { ok: true }, { 'set-cookie': cookie(req, 'hc_reset', '', 0) })
  if (path === '/api/account/logout-others') {
    user.account.sv = (user.account.sv || 0) + 1
    return save([cookie(req, 'hc_session', sessionValue(user), 365)])
  }

  // Corrections to what the coach saved.
  if (path === '/api/profile/remove') {
    if (!REMOVABLE.includes(body.list)) return send(res, 400, { error: 'That can’t be removed here.' })
    const list = at(user.profile, body.list)
    const i = Number(body.index)
    // `item` must still match, so a stale page can't remove the wrong thing.
    if (!Array.isArray(list) || !(i >= 0 && i < list.length) || JSON.stringify(list[i]) !== JSON.stringify(body.item)) return send(res, 409, { error: 'This changed in the meantime. Reload the page and try again.' })
    list.splice(i, 1)
    return save()
  }
  if (path === '/api/profile/set') {
    const clean = EDITABLE[body.field]
    if (!clean) return send(res, 400, { error: 'That can’t be changed here.' })
    put(user.profile, body.field, clean(body.value))
    return save()
  }
  return send(res, 404, { error: 'Not found.' })
}

// ───────────── chat ─────────────

async function chat(req, res) {
  const me = await sessionUser(req)
  if (!me) return send(res, 401, { error: 'Your session ended. Please log in again.' })
  if (!me.account?.email) return send(res, 403, { error: 'Please set up your login first.' })
  const id = me.id
  let msg
  try { msg = await readJson(req, MAX_CHAT_BYTES) } catch (e) { return send(res, e.status || 400, { error: e.message }) }
  const text = String(msg.text || '').trim().slice(0, 4000)
  let image = null, pdf = null
  if (msg.image) {
    if (!IMAGE_TYPES.includes(msg.image.media_type) || typeof msg.image.data !== 'string') return send(res, 400, { error: 'Please send a JPEG, PNG or WebP photo.' })
    image = { media_type: msg.image.media_type, data: msg.image.data }
  }
  if (msg.pdf) {
    if (typeof msg.pdf.data !== 'string' || msg.pdf.data.length > 14 * 1024 * 1024) return send(res, 400, { error: 'PDFs can be up to 10 MB.' })
    pdf = { data: msg.pdf.data }
  }
  if (!text && !image && !pdf) return send(res, 400, { error: 'Type a message first.' })
  if (!claude.configured()) return send(res, 503, { error: 'The coach is not connected yet (ANTHROPIC_API_KEY missing).' })

  return store.withLock(id, async () => {
    const user = await store.getUser(id)
    if (!user) return send(res, 401, { error: 'Your account was deleted.' })
    if (sentToday(user) >= DAILY_LIMIT) return send(res, 429, { error: `You've reached today's limit of ${DAILY_LIMIT} messages. It resets at midnight (UTC).` })

    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive' })
    let open = true
    req.on('close', () => { open = false })
    const emit = (event, data) => { if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
    const attachment = image ? 'photo' : pdf ? 'PDF' : null

    let result
    try {
      const { body } = coach.buildRequest(user, { text, image, pdf })
      // Keep going if the tab closes: the reply is still saved for next time.
      result = await claude.stream(body, delta => emit('delta', { text: delta }))
    } catch (e) {
      console.error('Coach reply failed:', e.message)
      emit('error', { message: claude.friendlyError(e) })
      return res.end()
    }
    const stop = result.stop_reason
    if (stop !== 'end_turn') console.warn(`Coach reply stop_reason=${stop} text=${result.text.length} chars, output=${result.usage.output} tokens`)
    let reply = result.text.trim()
    if (!reply) {
      // Nothing to show: don't save anything, so the message can simply be sent again.
      emit('error', {
        message: stop === 'refusal'
          ? "I can't help with that one. Try asking it a different way."
          : stop === 'max_tokens'
            ? 'That needed more room than I had. Try asking for it in smaller parts (e.g. one part of the day at a time).'
            : 'Sorry — I couldn’t put a reply together just now. Please send that again.',
      })
      return res.end()
    }
    if (stop === 'max_tokens') {
      const note = '\n\n_(I ran out of room there — say "continue" and I\'ll finish.)_'
      emit('delta', { text: note })
      reply += note
    }
    const now = new Date().toISOString()
    const userTurn = { role: 'user', content: text || (image ? '(photo)' : '(PDF)'), attachment, ts: now }
    const coachTurn = { role: 'assistant', content: reply, ts: new Date().toISOString() }
    user.turns.push(userTurn, coachTurn)
    user.log = [...(user.log || []), userTurn, coachTurn].slice(-LOG_LIMIT)
    user.stats.messages++
    user.stats.input_tokens += result.usage.input
    user.stats.output_tokens += result.usage.output
    await store.saveUser(user)
    emit('done', {})
    res.end()

    // After the reply: update the profile, and fold old history into the summary.
    try {
      // Profiles that were never updated catch up from the whole conversation, once.
      const update = !user.profile.meta.extracted_at && user.turns.length > 2
        ? await coach.extractHistory(user.profile, user.turns)
        : await coach.extract(user.profile, text, attachment, reply)
      if (coach.applyUpdate(user.profile, update, now) === 'delete') {
        await store.deleteUser(user.id)
        await store.forgetUserInInvites(user.id)
        return
      }
    } catch (e) { console.error('Profile update failed:', e.message) }
    try { await coach.foldHistory(user) } catch (e) { console.error('Summary failed:', e.message) }
    await store.saveUser(user)
  })
}

const redirect = (res, location) => { res.writeHead(303, { location, 'cache-control': 'no-store' }); res.end() }

function page(message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${APP_NAME}</title><link rel="stylesheet" href="/styles.css"></head>
<body class="plain"><main class="note"><h1>${APP_NAME}</h1><p>${message}</p></main></body></html>`
}

createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error(e)
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong.' })
    else res.end()
  })
}).listen(PORT, () => console.log(`${APP_NAME} on http://localhost:${PORT} · model ${claude.MODEL}`))
