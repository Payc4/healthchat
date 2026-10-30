const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const when = ts => ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'

async function api(path, body) {
  const res = await fetch('/api/admin/' + path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status })
  return data
}

function toast(text) {
  const t = document.createElement('div')
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = text
  document.body.append(t)
  setTimeout(() => t.remove(), 3000)
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Link copied') } catch { prompt('Copy this link:', text) }
}

function showLink(url, note) {
  const box = $('newlink')
  box.hidden = false
  box.innerHTML = `<strong>${esc(note)}</strong><br><span>${esc(url)}</span><br><button class="btn btn-small" style="margin-top:8px" id="copyNew">Copy link</button>`
  $('copyNew').onclick = () => copy(url)
}

async function refresh() {
  let s
  try { s = await api('state') } catch (e) {
    if (e.status === 401 || e.status === 503) { $('main').hidden = true; $('login').hidden = false; if (e.status === 503) toast(e.message); return }
    toast(e.message); return
  }
  $('login').hidden = true
  $('main').hidden = false
  const warn = []
  if (!s.aiReady) warn.push('<span class="pill off">ANTHROPIC_API_KEY missing</span>')
  if (!s.persistentSessions) warn.push('<span class="pill off">SESSION_SECRET missing — testers get logged out on restart</span>')
  $('status').innerHTML = `Model <code>${esc(s.model)}</code> · ${s.limit} messages per tester per day ${warn.join(' ')}`

  $('users').innerHTML = s.users.length ? s.users.map(u => `
    <tr>
      <td><strong>${esc(u.name || u.label || 'Tester')}</strong>${u.name && u.label ? `<br><span class="status">${esc(u.label)}</span>` : ''}</td>
      <td>${when(u.created_at)}</td>
      <td>${when(u.last_active)}</td>
      <td>${u.messages}</td>
      <td>${u.tokens.toLocaleString()}</td>
      <td>${u.onboarded ? '<span class="pill">Yes</span>' : '<span class="pill off">Not yet</span>'}</td>
      <td><div class="acts">
        <button class="btn btn-ghost btn-small" data-relink="${esc(u.id)}" title="New one-time link that logs this tester back in (new phone, cleared browser)">Login link</button>
        <button class="btn btn-danger btn-small" data-deluser="${esc(u.id)}" data-name="${esc(u.name || u.label || 'this tester')}">Delete</button>
      </div></td>
    </tr>`).join('') : '<tr><td colspan="7" class="status">No testers yet. Create an invite link above.</td></tr>'

  $('invites').innerHTML = s.invites.length ? s.invites.map(i => `
    <tr>
      <td>${esc(i.label)}</td>
      <td>${when(i.created_at)}</td>
      <td>${i.used_at ? `<span class="pill">Used ${when(i.used_at)}</span>` : '<span class="pill off">Not used yet</span>'}</td>
      <td><div class="acts">
        ${i.used_at ? '' : `<button class="btn btn-ghost btn-small" data-copy="${esc(i.url)}">Copy</button>`}
        <button class="btn btn-ghost btn-small" data-delinv="${esc(i.token)}">Remove</button>
      </div></td>
    </tr>`).join('') : '<tr><td colspan="4" class="status">No invite links.</td></tr>'
}

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault()
  try { await api('login', { password: $('pw').value }); $('pw').value = ''; refresh() } catch (err) { toast(err.message) }
})
$('logout').addEventListener('click', async () => { await api('logout', {}).catch(() => {}); location.reload() })
$('inviteForm').addEventListener('submit', async e => {
  e.preventDefault()
  try {
    const r = await api('invite', { label: $('label').value.trim() || 'Tester' })
    $('label').value = ''
    showLink(r.url, 'New invite link (works once):')
    refresh()
  } catch (err) { toast(err.message) }
})

document.addEventListener('click', async e => {
  const b = e.target.closest('button')
  if (!b) return
  try {
    if (b.dataset.copy) return copy(b.dataset.copy)
    if (b.dataset.relink) {
      const r = await api('relink', { user_id: b.dataset.relink })
      showLink(r.url, 'Login link for this tester (works once):')
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return refresh()
    }
    if (b.dataset.deluser) {
      if (!confirm(`Delete ${b.dataset.name} and everything stored about them? This can’t be undone.`)) return
      await api('delete-user', { user_id: b.dataset.deluser })
      toast('Tester deleted'); return refresh()
    }
    if (b.dataset.delinv) {
      await api('delete-invite', { token: b.dataset.delinv })
      return refresh()
    }
  } catch (err) { toast(err.message) }
})

refresh()
