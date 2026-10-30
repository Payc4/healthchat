import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as coach from '../lib/coach.js'

const now = '2026-10-30T10:00:00.000Z'
const user = (turns = []) => ({ profile: coach.newProfile(null, now), turns, summary: '' })

test('system prompt is the owner text, verbatim, after the --- line', () => {
  assert.ok(coach.STATIC_PROMPT.length > 2000)
  assert.ok(!coach.STATIC_PROMPT.startsWith('---'))
})

test('under 18 → delete, nothing applied', () => {
  const p = coach.newProfile(null, now)
  assert.equal(coach.applyUpdate(p, { under_18: true, display_name: 'Kid' }, now), 'delete')
  assert.equal(p.profile.display_name, null)
})

test('ED flag is set-only and wipes numeric targets and food logs', () => {
  const p = coach.newProfile(null, now)
  coach.applyUpdate(p, { target_calories: 1800, target_protein_g: 120, food_log_entry: { summary: 'x' } }, now)
  assert.equal(p.nutrition.targets.calories, 1800)
  coach.applyUpdate(p, { eating_disorder_signs: true }, now)
  assert.equal(p.constraints.eating_disorder_flag, true)
  assert.equal(p.nutrition.targets.calories, null)
  assert.deepEqual(p.food_log_summaries, [])
  coach.applyUpdate(p, { eating_disorder_signs: false, target_calories: 1500 }, now)
  assert.equal(p.constraints.eating_disorder_flag, true)
  assert.equal(p.nutrition.targets.calories, null)
  assert.deepEqual(coach.selectModes(p, []), ['ED_SAFE'])
})

test('modes: weight loss + condition, returning after a gap, high frequency', () => {
  const p = coach.newProfile(null, now)
  coach.applyUpdate(p, { goal_primary: 'lose 5 kg', medications_add: ['metformin'] }, now)
  const old = [{ role: 'user', content: 'hi', ts: '2026-10-20T10:00:00Z' }, { role: 'assistant', content: 'hey', ts: '2026-10-20T10:00:05Z' }]
  assert.deepEqual(coach.selectModes(p, old, Date.parse(now)), ['WEIGHT_LOSS', 'CONDITION', 'RETURNING'])
  const many = Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: 'x', ts: `2026-10-30T0${i}:00:00Z` }))
  assert.ok(coach.selectModes(p, many, Date.parse(now)).includes('HIGH_FREQUENCY'))
})

test('request: cached static prompt, onboarding list, history starts with user, image block', () => {
  const u = user([{ role: 'assistant', content: coach.FIRST_QUESTION, ts: now }])
  const { body } = coach.buildRequest(u, { text: 'lunch', image: { media_type: 'image/jpeg', data: 'AAAA' } }, new Date(now))
  assert.equal(body.system[0].cache_control.type, 'ephemeral')
  assert.match(body.system[1].text, /Q2 health constraints/)
  assert.equal(body.messages[0].role, 'user')
  assert.equal(body.messages.at(-1).content[0].type, 'image')
  for (let i = 1; i < body.messages.length; i++) assert.notEqual(body.messages[i].role, body.messages[i - 1].role)
})

test('dangling user turn is merged, roles still alternate', () => {
  const u = user([{ role: 'assistant', content: 'q', ts: now }, { role: 'user', content: 'first try', ts: now }])
  const { body } = coach.buildRequest(u, { text: 'second' }, new Date(now))
  assert.match(body.messages.at(-1).content.at(-1).text, /first try[\s\S]*second/)
  for (let i = 1; i < body.messages.length; i++) assert.notEqual(body.messages[i].role, body.messages[i - 1].role)
})
