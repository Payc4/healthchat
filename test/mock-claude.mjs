// Fake Claude Messages API for tests. Never calls Anthropic. Records every request (GET /requests).
import { createServer } from 'node:http'

const requests = []
const lastText = body => {
  const m = body.messages[body.messages.length - 1]
  return typeof m.content === 'string' ? m.content : m.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
}

export function startMock(port = 0) {
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/requests') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(requests)) }
    if (req.method === 'POST' && req.url === '/reset') { requests.length = 0; res.writeHead(200); return res.end('{}') }
    let raw = ''
    for await (const c of req) raw += c
    const body = JSON.parse(raw)
    requests.push(body)
    const text = lastText(body)

    if (body.tool_choice) {
      // Profile extraction: keyword rules on the latest exchange (USER line only).
      const user = (text.match(/USER[^:]*: ([\s\S]*?)\nCOACH:/) || [])[1] || ''
      const input = {}
      if (/I am 16|I'm 16/i.test(user)) input.under_18 = true
      const name = user.match(/my name is (\w+)/i); if (name) input.display_name = name[1]
      if (/lose weight/i.test(user)) { input.goal_primary = 'Lose some weight'; input.goal_category = 'weight_loss' }
      if (/no conditions/i.test(user)) input.constraints_asked = true
      if (/binge|purge/i.test(user)) { input.eating_disorder_signs = true }
      if (/target/i.test(user)) { input.target_calories = 1900; input.target_protein_g = 140; input.targets_set_by = 'coach' }
      if (/\[sent a photo\]/.test(text)) input.food_log_entry = { summary: 'Chicken salad', est_calories: '450-550', est_protein_g: '35-40' }
      if (/\[sent a PDF\]/.test(text)) input.lab_markers_add = [{ marker: 'Ferritin', value: 22, unit: 'ng/mL', flag: 'low' }]
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ content: [{ type: 'tool_use', id: 'tu_1', name: body.tools[0].name, input }], stop_reason: 'tool_use' }))
    }
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ content: [{ type: 'text', text: 'SUMMARY: the user wants to lose weight and is called Tomas.' }] }))
    }
    if (/FAIL500/.test(text)) {
      res.writeHead(529, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
    }
    // Sonnet 5.5 can spend the whole budget thinking: no text, stop_reason max_tokens.
    const empty = /EMPTYREPLY/.test(text)
    const cut = /CUTREPLY/.test(text)
    const hasImage = body.messages.at(-1).content.some?.(c => c.type === 'image')
    const hasPdf = body.messages.at(-1).content.some?.(c => c.type === 'document')
    const reply = `Got it${hasImage ? ' (I can see your photo)' : ''}${hasPdf ? ' (I read your PDF)' : ''}. **Plan:**\n\n| Meal | Protein |\n|---|---|\n| Breakfast | 30 g |\n\n- one\n- two <script>alert(1)</script>\n\nWhat else?`
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    ev('message_start', { message: { usage: { input_tokens: 1000, cache_read_input_tokens: 2000 } } })
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'hmm…' } })
    if (!empty) for (const piece of reply.match(/[\s\S]{1,12}/g)) { ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: piece } }); await new Promise(r => setTimeout(r, 5)) }
    ev('content_block_stop', { index: 0 })
    ev('message_delta', { delta: { stop_reason: empty || cut ? 'max_tokens' : 'end_turn' }, usage: { output_tokens: 80 } })
    ev('message_stop', {})
    res.end()
  })
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startMock(Number(process.env.MOCK_PORT || 4010))
  console.log('mock claude on', s.address().port)
}
