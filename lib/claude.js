// Minimal Claude Messages API client (no SDK): one streaming call and one forced tool call.
// Configure with ANTHROPIC_API_KEY; optional CLAUDE_MODEL (default claude-sonnet-5-5)
// and ANTHROPIC_API_BASE (tests point it at a local mock).

const API = (process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages'
export const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5'

export const configured = () => Boolean(process.env.ANTHROPIC_API_KEY)

export class ClaudeError extends Error {
  constructor(message, status, type) { super(message); this.status = status; this.type = type }
}

function headers() {
  return {
    'x-api-key': process.env.ANTHROPIC_API_KEY || '',
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  }
}

async function fail(res) {
  const body = await res.text().catch(() => '')
  let data = null
  try { data = JSON.parse(body) } catch {}
  throw new ClaudeError(data?.error?.message || `HTTP ${res.status}`, res.status, data?.error?.type)
}

/**
 * Streams a reply. Calls onText(delta) as text arrives; resolves with the full text and usage.
 * @returns {Promise<{ text: string, usage: { input: number, output: number }, stop_reason: string|null }>}
 */
export async function stream(body, onText, signal) {
  const res = await fetch(API, { method: 'POST', headers: headers(), body: JSON.stringify({ ...body, model: body.model || MODEL, stream: true }), signal })
  if (!res.ok) await fail(res)

  let text = ''
  let stop = null
  const usage = { input: 0, output: 0 }
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2)
      const line = block.split('\n').find(l => l.startsWith('data: '))
      if (!line) continue
      let ev
      try { ev = JSON.parse(line.slice(6)) } catch { continue }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        text += ev.delta.text
        onText(ev.delta.text)
      } else if (ev.type === 'message_start') {
        usage.input += ev.message?.usage?.input_tokens || 0
        usage.input += ev.message?.usage?.cache_read_input_tokens || 0
      } else if (ev.type === 'message_delta') {
        usage.output += ev.usage?.output_tokens || 0
        stop = ev.delta?.stop_reason ?? stop
      } else if (ev.type === 'error') {
        throw new ClaudeError(ev.error?.message || 'Stream error', 500, ev.error?.type)
      }
    }
  }
  return { text, usage, stop_reason: stop }
}

/** One non-streaming call that must answer by calling `tool`. Returns the tool input. */
export async function callTool(body, tool) {
  const res = await fetch(API, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ ...body, model: body.model || MODEL, tools: [tool], tool_choice: { type: 'tool', name: tool.name } }),
  })
  if (!res.ok) await fail(res)
  const data = await res.json()
  const use = (data.content || []).find(c => c.type === 'tool_use')
  return use?.input || {}
}

/** One non-streaming text call. */
export async function complete(body) {
  const res = await fetch(API, { method: 'POST', headers: headers(), body: JSON.stringify({ ...body, model: body.model || MODEL }) })
  if (!res.ok) await fail(res)
  const data = await res.json()
  return (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim()
}

export function friendlyError(e) {
  if (e instanceof ClaudeError) {
    if (e.status === 401) return 'The AI key was rejected. The owner needs to check ANTHROPIC_API_KEY.'
    if (e.status === 404) return 'The AI model name was not recognised. The owner needs to check CLAUDE_MODEL.'
    if (e.status === 429) return 'The coach is busy or the monthly spend limit was reached. Please try again in a minute.'
    if (e.status === 400 && /credit/i.test(e.message)) return 'The AI account is out of credit. The owner needs to top it up.'
    if (e.status >= 500) return 'The AI service is temporarily unavailable. Please try again in a moment.'
    return 'The coach could not answer that. Please try again.'
  }
  return 'Something went wrong. Please try again.'
}
