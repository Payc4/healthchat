// Health Coach chat page. Talks to server.js: /api/me, /api/gate, /api/chat (SSE), /api/me/delete.

const $ = id => document.getElementById(id)
const screens = ['loading', 'none', 'gate', 'declined']
const MAX_PDF = 10 * 1024 * 1024
const MAX_IMG_SIDE = 1568

let attachment = null // { kind: 'image'|'pdf', media_type, data, name, url }
let busy = false
let lastDay = ''
let limitInfo = { limit: 0, sent: 0 }

// ───────── helpers ─────────

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status })
  return data
}

function show(name) {
  for (const s of screens) $(s).hidden = s !== name
  const chatting = name === 'chat'
  $('chat').hidden = !chatting
  $('composer').hidden = !chatting
  $('menuBtn').hidden = !chatting
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** Small, safe markdown: escapes everything first, then adds bold/italic/code, lists, headings and tables. */
function md(src) {
  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  const lines = String(src).replace(/\r/g, '').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    // table: header row, then a |---| row
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
      const head = cells(line)
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]))
      out.push('<div class="tbl"><table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>')
      continue
    }
    const h = line.match(/^#{1,6}\s+(.*)/)
    if (h) { out.push(`<h4>${inline(h[1])}</h4>`); i++; continue }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line)
      const items = []
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ''))
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag}>` + items.map(it => `<li>${inline(it)}</li>`).join('') + `</${tag}>`)
      continue
    }
    const para = []
    while (i < lines.length && lines[i].trim() && !/^\s*([-*•]|\d+[.)])\s+|^#{1,6}\s|^\s*\|.*\|\s*$/.test(lines[i])) para.push(lines[i++])
    if (!para.length) { para.push(lines[i++]) }
    out.push(`<p>${para.map(inline).join('<br>')}</p>`)
  }
  return out.join('')
}

function dayLabel(ts) {
  const d = new Date(ts)
  const today = new Date()
  const y = new Date(); y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

function scrollDown() {
  const c = $('chat')
  c.scrollTop = c.scrollHeight
}

function nearBottom() {
  const c = $('chat')
  return c.scrollHeight - c.scrollTop - c.clientHeight < 120
}

function addDay(ts) {
  const label = dayLabel(ts || Date.now())
  if (label === lastDay) return
  lastDay = label
  const el = document.createElement('div')
  el.className = 'day'
  el.textContent = label
  $('chat').append(el)
}

function addMessage(role, content, { att, previewUrl, ts } = {}) {
  addDay(ts)
  const el = document.createElement('div')
  el.className = 'msg ' + (role === 'user' ? 'me' : role === 'error' ? 'error' : 'coach')
  if (role === 'user') {
    if (previewUrl) {
      const img = document.createElement('img')
      img.className = 'preview'; img.src = previewUrl; img.alt = 'Your photo'
      el.append(img)
    } else if (att) {
      const tag = document.createElement('div')
      tag.className = 'att'
      tag.textContent = att === 'photo' ? '📷 Photo' : '📄 PDF'
      el.append(tag)
    }
    const shown = content === '(photo)' || content === '(PDF)' ? '' : content
    if (shown) el.append(document.createTextNode(shown))
  } else if (role === 'error') {
    el.textContent = content
  } else {
    el.innerHTML = md(content)
  }
  $('chat').append(el)
  return el
}

// ───────── state ─────────

async function load() {
  let me
  try { me = await api('/api/me') } catch { me = { state: 'none' } }
  if (me.appName) { $('appName').textContent = me.appName; document.title = me.appName }
  if (me.state === 'active') {
    $('chat').textContent = ''
    lastDay = ''
    if (me.summarised) {
      const n = document.createElement('div')
      n.className = 'day'
      n.textContent = 'Older messages are summarised in your coach’s memory'
      $('chat').append(n)
    }
    for (const m of me.log || []) addMessage(m.role, m.content, { att: m.attachment, ts: m.ts })
    setLimit(me.limit, me.sentToday)
    show('chat')
    scrollDown()
    if (matchMedia('(min-width: 700px)').matches) $('msg').focus()
  } else if (me.state === 'gate') {
    $('gateText').textContent = me.gateText || ''
    show('gate')
  } else {
    show('none')
  }
}

function setLimit(limit, sent) {
  limitInfo = { limit, sent }
  const left = Math.max(0, (limit || 0) - (sent || 0))
  $('subtitle').textContent = left <= 10 ? `${left} message${left === 1 ? '' : 's'} left today` : 'Your AI coach · test version'
}

// ───────── age gate ─────────

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-gate]')
  if (!b) return
  for (const x of document.querySelectorAll('[data-gate]')) x.disabled = true
  try {
    const r = await api('/api/gate', { answer: b.dataset.gate })
    if (r.state === 'declined') show('declined')
    else await load()
  } catch (err) {
    alertBox(err.message)
    for (const x of document.querySelectorAll('[data-gate]')) x.disabled = false
  }
})

function alertBox(text) {
  const t = document.createElement('div')
  t.className = 'toast'
  t.setAttribute('role', 'status')
  t.textContent = text
  document.body.append(t)
  setTimeout(() => t.remove(), 4000)
}

// ───────── attachments ─────────

$('attachBtn').addEventListener('click', () => $('file').click())
$('chipRemove').addEventListener('click', clearAttachment)

$('file').addEventListener('change', async () => {
  const f = $('file').files[0]
  $('file').value = ''
  if (!f) return
  try {
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      if (f.size > MAX_PDF) throw new Error('PDFs can be up to 10 MB.')
      const data = await toBase64(f)
      setAttachment({ kind: 'pdf', data, name: f.name })
    } else if (f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp|gif)$/i.test(f.name)) {
      const { data, url } = await shrinkImage(f)
      setAttachment({ kind: 'image', media_type: 'image/jpeg', data, name: f.name || 'Photo', url })
    } else {
      throw new Error('Please choose a photo or a PDF.')
    }
  } catch (err) {
    alertBox(err.message || 'Could not read that file.')
  }
})

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1])
    r.onerror = () => reject(new Error('Could not read that file.'))
    r.readAsDataURL(blob)
  })
}

/** Resizes photos on the phone (max 1568px, JPEG) so uploads are small and fast. */
async function shrinkImage(file) {
  let bitmap
  try { bitmap = await createImageBitmap(file) } catch {
    throw new Error('This photo format isn’t supported by your browser. Try a screenshot or JPEG.')
  }
  const scale = Math.min(1, MAX_IMG_SIDE / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close?.()
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85))
  return { data: await toBase64(blob), url: URL.createObjectURL(blob) }
}

function setAttachment(a) {
  clearAttachment()
  attachment = a
  $('chip').hidden = false
  $('chipName').textContent = a.kind === 'pdf' ? `📄 ${a.name}` : a.name
  $('chipImg').hidden = a.kind !== 'image'
  if (a.url) $('chipImg').src = a.url
  updateSend()
}

function clearAttachment() {
  attachment = null
  $('chip').hidden = true
  $('chipImg').removeAttribute('src')
  updateSend()
}

// ───────── composer ─────────

const input = $('msg')
function grow() {
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight, 160) + 'px'
}
function updateSend() {
  $('sendBtn').disabled = busy || (!input.value.trim() && !attachment)
  $('attachBtn').disabled = busy
}
input.addEventListener('input', () => { grow(); updateSend() })
input.addEventListener('keydown', e => {
  // Enter sends on desktop; on phones Enter makes a new line (the send button is right there).
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(hover: hover) and (pointer: fine)').matches) {
    e.preventDefault()
    $('form').requestSubmit()
  }
})

$('form').addEventListener('submit', e => {
  e.preventDefault()
  send()
})

async function send() {
  const text = input.value.trim()
  if (busy || (!text && !attachment)) return
  busy = true
  const att = attachment
  input.value = ''; grow()
  clearAttachment()
  updateSend()

  addMessage('user', text, { att: att ? (att.kind === 'image' ? 'photo' : 'PDF') : null, previewUrl: att?.url })
  const bubble = addMessage('assistant', '')
  bubble.innerHTML = '<span class="typing" aria-label="Coach is typing"><i></i><i></i><i></i></span>'
  scrollDown()

  const body = { text }
  if (att?.kind === 'image') body.image = { media_type: att.media_type, data: att.data }
  if (att?.kind === 'pdf') body.pdf = { data: att.data }

  let reply = ''
  let failed = null
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
      body: JSON.stringify(body),
    })
    if (!res.ok || !(res.headers.get('content-type') || '').includes('text/event-stream')) {
      const data = await res.json().catch(() => ({}))
      throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status })
    }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let done = false
    while (!done) {
      const chunk = await reader.read()
      if (chunk.done) break
      buf += dec.decode(chunk.value, { stream: true })
      let i
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2)
        const ev = (block.match(/^event: (.*)$/m) || [])[1]
        const raw = (block.match(/^data: (.*)$/m) || [])[1]
        let data = {}
        try { data = JSON.parse(raw || '{}') } catch {}
        if (ev === 'delta') {
          const stick = nearBottom()
          reply += data.text || ''
          bubble.innerHTML = md(reply)
          if (stick) scrollDown()
        } else if (ev === 'error') {
          failed = data.message || 'Something went wrong.'
        } else if (ev === 'done') {
          done = true
        }
      }
    }
    if (!done && !failed) failed = 'The connection dropped. Your message may not have been saved — please send it again.'
  } catch (err) {
    failed = err.message || 'Could not reach the coach. Check your connection.'
    if (err.status === 401) { busy = false; await load(); alertBox(failed); return }
  }

  if (failed) {
    if (!reply) bubble.remove()
    addMessage('error', failed)
    if (text && !input.value) { input.value = text; grow() }
  } else {
    limitInfo.sent++
    setLimit(limitInfo.limit, limitInfo.sent)
  }
  busy = false
  updateSend()
  scrollDown()
}

// ───────── menu ─────────

$('menuBtn').addEventListener('click', e => {
  e.stopPropagation()
  const open = $('menu').hidden
  $('menu').hidden = !open
  $('menuBtn').setAttribute('aria-expanded', String(open))
})
document.addEventListener('click', e => {
  if (!$('menu').hidden && !e.target.closest('#menu')) { $('menu').hidden = true; $('menuBtn').setAttribute('aria-expanded', 'false') }
})
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('menu').hidden = true })

$('deleteBtn').addEventListener('click', async () => {
  $('menu').hidden = true
  if (!confirm('Delete everything your coach knows about you, and all your messages? This can’t be undone.')) return
  try {
    await api('/api/me/delete', {})
    $('chat').textContent = ''
    show('none')
    document.querySelector('#none h2').textContent = 'Your data was deleted'
    document.querySelector('#none p').textContent = 'Everything we stored about you is gone. To start again you’ll need a new invite link.'
  } catch (err) { alertBox(err.message) }
})

load()
