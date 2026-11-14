// Profile dashboard: progress, what the coach knows (with corrections), account settings.

const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const day = d => d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''
let data = null

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
    body: JSON.stringify(body),
  })
  const out = await res.json().catch(() => ({}))
  if (res.status === 401) { location.href = '/login'; throw new Error('Please log in again.') }
  if (!res.ok) throw new Error(out.error || 'Something went wrong. Please try again.')
  return out
}

function toast(text) {
  const t = document.createElement('div')
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = text
  document.body.append(t)
  setTimeout(() => t.remove(), 3000)
}
function showError(msg) { $('err').textContent = msg; $('err').hidden = !msg }

// ───────── tabs ─────────
const TABS = ['progress', 'knows', 'account']
function openTab(name) {
  for (const t of TABS) {
    $(t).hidden = t !== name
    $('tab-' + t).setAttribute('aria-selected', String(t === name))
  }
  try { history.replaceState(null, '', '#' + name) } catch {}
}
for (const t of TABS) $('tab-' + t).addEventListener('click', () => openTab(t))
openTab(TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'progress')

// ───────── render ─────────
function render(d) {
  data = d
  const { account, stats, profile: p } = d
  $('sub').textContent = account.name ? `${account.name} · ${account.email}` : account.email
  $('since').textContent = `Member since ${day(account.created_at)}`

  // Progress
  $('sDays').textContent = stats.days_active
  $('sStreak').textContent = stats.streak
  $('sMsgs').textContent = stats.messages
  $('sFiles').textContent = stats.photos + stats.pdfs
  const max = Math.max(1, ...stats.last14.map(x => x.count))
  $('bars').innerHTML = stats.last14.map(x => `<div class="${x.count ? '' : 'zero'}" style="height:${Math.max(3, (x.count / max) * 100)}%" title="${esc(day(x.date))}: ${x.count} message${x.count === 1 ? '' : 's'}"></div>`).join('')
  $('barLabels').innerHTML = stats.last14.map((x, i) => `<span>${i % 2 === 1 ? new Date(x.date).getDate() : ''}</span>`).join('')
  $('pGoal').textContent = p.goals.primary || 'Not set yet. Your coach asks about this in your first chat.'
  $('pGoal').className = p.goals.primary ? '' : 'empty'

  const nums = []
  const t = p.nutrition.targets
  if (t.calories) nums.push(['Daily calories target', `${t.calories} kcal`, t.set_by === 'user' ? 'set by you' : 'suggested by your coach'])
  if (t.protein_g) nums.push(['Daily protein target', `${t.protein_g} g`, ''])
  if (p.sleep.typical_hours) nums.push(['Typical sleep', `${p.sleep.typical_hours} h`, ''])
  const latest = (list, key) => Object.values(list.reduce((m, x) => ((!m[x[key]] || (x.date || '') >= (m[x[key]].date || '')) && (m[x[key]] = x), m), {}))
  for (const m of latest(p.wearable.metrics, 'metric').slice(-8)) nums.push([m.metric, `${m.value}${m.unit ? ' ' + m.unit : ''}`, day(m.date)])
  for (const l of latest(p.lab_markers, 'marker').slice(-8)) nums.push([l.marker, `${l.value}${l.unit ? ' ' + l.unit : ''}${l.flag && l.flag !== 'normal' ? ` <span class="flag ${esc(l.flag)}">${esc(l.flag)}</span>` : ''}`, day(l.date), true])
  $('pNumbers').innerHTML = nums.length
    ? `<div class="rows">${nums.map(([k, v, s, html]) => `<div class="r"><div>${esc(k)}${s ? `<small>${esc(s)}</small>` : ''}</div><strong>${html ? v : esc(v)}</strong></div>`).join('')}</div>`
    : '<p class="empty">Nothing yet. Share a wearable screenshot or a blood test with your coach and the numbers show up here.</p>'

  // What your coach knows
  $('knowsBody').innerHTML = [
    panel('About you', `
      <dl class="kv">
        <dt>Name</dt><dd>${esc(account.name || p.profile.display_name || '–')}</dd>
        ${p.profile.language ? `<dt>Language</dt><dd>${esc(p.profile.language)}</dd>` : ''}
        <dt>Coaching style</dt><dd>${select('profile.preferences.coaching_style', p.profile.preferences.coaching_style, [['', 'Not chosen (direct but warm)'], ['direct', 'Direct, push me'], ['gentle', 'Gentle, encouraging']])}</dd>
        <dt>Reply length</dt><dd>${select('profile.preferences.response_length', p.profile.preferences.response_length, [['', 'Not chosen'], ['brief', 'Short and to the point'], ['detailed', 'Detailed']])}</dd>
      </dl>`),
    panel('Goals', `
      <form class="inline-edit" data-set="goals.primary"><label class="sr-only" for="goalIn">Main goal</label><input id="goalIn" maxlength="200" placeholder="Your main goal" value="${esc(p.goals.primary || '')}"><button class="btn btn-small" type="submit">Save</button></form>
      ${chips('Other goals', 'goals.secondary', p.goals.secondary)}`),
    panel('Health', [
      chips('Conditions', 'constraints.conditions', p.constraints.conditions),
      chips('Medications', 'constraints.medications', p.constraints.medications),
      chips('Injuries', 'constraints.injuries', p.constraints.injuries),
      chips('Allergies', 'constraints.allergies', p.constraints.allergies),
      chips('Therapies', 'constraints.therapies', p.constraints.therapies),
    ].join(''), 'Your coach takes these into account and sends medical questions to your doctor.'),
    panel('Eating', `
      ${p.nutrition.pattern ? `<dl class="kv"><dt>How you eat</dt><dd>${esc(p.nutrition.pattern)}</dd></dl>` : ''}
      ${chips('Restrictions', 'nutrition.restrictions', p.nutrition.restrictions)}
      ${rows('Recent meals', 'food_log_summaries', p.food_log_summaries.slice().reverse(), f => [f.summary, [f.est_calories && `~${f.est_calories} kcal`, f.est_protein_g && `~${f.est_protein_g} g protein`, day(f.date)].filter(Boolean).join(' · ')], true)}`),
    panel('Activity and sleep', `
      <dl class="kv">
        ${p.activity.baseline ? `<dt>Activity level</dt><dd>${esc(p.activity.baseline)}</dd>` : ''}
        ${p.sleep.pattern ? `<dt>Sleep</dt><dd>${esc(p.sleep.pattern)}</dd>` : ''}
        ${p.sleep.typical_hours ? `<dt>Typical sleep</dt><dd>${esc(p.sleep.typical_hours)} h</dd>` : ''}
        ${p.wearable.device ? `<dt>Wearable</dt><dd>${esc(p.wearable.device)}</dd>` : ''}
      </dl>
      ${chips('Training', 'activity.current_training', p.activity.current_training)}
      ${rows('Wearable numbers', 'wearable.metrics', p.wearable.metrics.slice().reverse(), m => [`${m.metric}: ${m.value}${m.unit ? ' ' + m.unit : ''}`, day(m.date)], true)}`),
    panel('Supplements', rows(null, 'supplements', p.supplements, s => [s.name, [s.dose, s.timing, s.purpose].filter(Boolean).join(' · ')])),
    panel('Lab results', rows(null, 'lab_markers', p.lab_markers.slice().reverse(), l => [`${l.marker}: ${l.value}${l.unit ? ' ' + l.unit : ''}${l.flag && l.flag !== 'normal' ? ` (${l.flag})` : ''}`, [l.reference_range && `range ${l.reference_range}`, day(l.date)].filter(Boolean).join(' · ')], true),
      'Explained by your coach as context, never as a diagnosis.'),
    panel('Notes your coach made', rows(null, 'coach_notes', p.coach_notes.slice().reverse(), n => [n.note, day(n.date)], true)),
  ].join('')

  // Account
  if (document.activeElement !== $('aName')) $('aName').value = account.name
  if (document.activeElement !== $('aEmail')) $('aEmail').value = account.email
}

function panel(title, body, sub) {
  return `<div class="panel2"><h2>${esc(title)}</h2>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}${body || ''}</div>`
}
function select(field, value, options) {
  return `<select data-field="${esc(field)}" aria-label="${esc(field)}" style="min-height:38px;border:0;border-radius:10px;padding:4px 8px;background:var(--bg);box-shadow:inset 0 0 0 1px var(--line)">${options.map(([v, l]) => `<option value="${esc(v)}"${(value || '') === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`
}
// Items keep their real index in the saved list (so `reversed` views still remove the right one).
function chips(label, list, items) {
  return `<div style="margin-top:12px"><div style="font-size:13px;color:var(--muted);margin-bottom:6px">${esc(label)}</div>${items.length
    ? `<div class="chips">${items.map((x, i) => `<span class="chip2">${esc(x)}<button class="x" data-remove="${esc(list)}" data-index="${i}" aria-label="Remove ${esc(x)}">✕</button></span>`).join('')}</div>`
    : '<p class="empty">None</p>'}</div>`
}
function rows(label, list, items, fmt, reversed) {
  const total = items.length
  const body = total
    ? `<div class="rows">${items.map((x, i) => { const [a, b] = fmt(x); const idx = reversed ? total - 1 - i : i; return `<div class="r"><div>${esc(a)}${b ? `<small>${esc(b)}</small>` : ''}</div><button class="x" data-remove="${esc(list)}" data-index="${idx}" aria-label="Remove ${esc(a)}">✕</button></div>` }).join('')}</div>`
    : '<p class="empty">Nothing yet.</p>'
  return label ? `<div style="margin-top:12px"><div style="font-size:13px;color:var(--muted);margin-bottom:6px">${esc(label)}</div>${body}</div>` : body
}

// ───────── actions ─────────
async function act(path, body, ok) {
  showError('')
  try {
    const d = await api(path, body)
    if (d.profile) render(d)
    if (ok) toast(ok)
    return true
  } catch (e) { showError(e.message); window.scrollTo({ top: 0, behavior: 'smooth' }); return false }
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-remove]')
  if (!b) return
  const list = b.dataset.remove, index = Number(b.dataset.index)
  const item = list.split('.').reduce((o, k) => o?.[k], data.profile)?.[index]
  act('/api/profile/remove', { list, index, item }, 'Removed')
})
document.addEventListener('change', e => {
  const s = e.target.closest('select[data-field]')
  if (s) act('/api/profile/set', { field: s.dataset.field, value: s.value || null }, 'Saved')
})
document.addEventListener('submit', e => {
  const f = e.target.closest('form[data-set]')
  if (!f) return
  e.preventDefault()
  act('/api/profile/set', { field: f.dataset.set, value: f.querySelector('input').value }, 'Saved')
})

$('nameForm').addEventListener('submit', e => { e.preventDefault(); act('/api/account/name', { name: $('aName').value }, 'Name saved') })
$('emailForm').addEventListener('submit', async e => {
  e.preventDefault()
  if (await act('/api/account/email', { email: $('aEmail').value, password: $('aEmailPass').value }, 'Email changed')) $('aEmailPass').value = ''
})
$('passForm').addEventListener('submit', async e => {
  e.preventDefault()
  if (await act('/api/account/password', { password: $('aCur').value, new_password: $('aNew').value }, 'Password changed')) { $('aCur').value = ''; $('aNew').value = '' }
})
$('logoutOthers').addEventListener('click', () => act('/api/account/logout-others', {}, 'Other devices are logged out'))
$('logout').addEventListener('click', async () => { await api('/api/logout', {}).catch(() => {}); location.href = '/' })
$('deleteAcct').addEventListener('click', async () => {
  if (!confirm('Delete your account, your chats and everything your coach saved? This can’t be undone.')) return
  try { await api('/api/me/delete', {}); location.href = '/' } catch (e) { showError(e.message) }
})

// ───────── load ─────────
api('/api/dashboard').then(d => {
  if (!d.account.email) { location.replace('/app'); return }
  render(d)
}).catch(e => showError(e.message))
