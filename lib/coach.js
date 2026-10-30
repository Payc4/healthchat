// The coach: builds each Claude call from the owner's system prompt + this user's profile,
// then updates the profile afterwards with a separate structured call.
//
// Sources (docs/): system prompt = prompts/system_prompt.md (owner-approved, used verbatim);
// onboarding questions = onboarding_flow.md; modes = personas.md; schema = profile_schema.json.

import { readFileSync } from 'node:fs'
import { MODEL, callTool, complete } from './claude.js'

const EXTRACT_MODEL = process.env.CLAUDE_EXTRACT_MODEL || MODEL
export const RECENT_TURNS = 12
export const FOLD_AT = 24

// The prompt file starts with notes for the developer, then a "---" line, then the prompt itself.
const promptFile = readFileSync(new URL('../prompts/system_prompt.md', import.meta.url), 'utf8')
export const STATIC_PROMPT = promptFile.slice(promptFile.indexOf('\n---\n') + 5).trim()

// ───────────── onboarding (docs/onboarding_flow.md) ─────────────

export const AGE_GATE_TEXT = "Quick bit of housekeeping before we start: this is an early test version, and it's for adults only. Also, anything you share with me (including things like lab results) is processed by AI and saved so I can keep track for you — so treat this as a test space and share accordingly."
export const FIRST_QUESTION = "Thanks! What are you hoping to get out of working with me? Doesn't need to be precise — 'lose some weight', 'get stronger', 'just feel better' all work."

const QUESTIONS = [
  ['Q1 goal', p => !p.goals.primary, "What are you hoping to get out of working with me? ('lose some weight', 'get stronger', 'just feel better' all work.) REQUIRED before coaching; if skipped, use a general-wellness default and revisit."],
  ['Q2 health constraints', p => !p.meta.constraints_asked, 'Anything I should know about your health before I suggest anything — any conditions, medications, injuries, or allergies? MUST be asked even if the answer is "none". If dodged, ask once more framed as safety; if still dodged, proceed cautiously and re-ask before any supplement or high-intensity advice. Never assume none.'],
  ['Q3 activity', p => !p.activity.baseline, 'Roughly how active are you right now — and is there any training or sport you already do? (If skipped: assume sedentary-to-light.)'],
  ['Q4 sleep', p => !p.sleep.pattern, "How's your sleep, generally? (If skipped: ask again the first time recovery or energy comes up.)"],
  ['Q5 eating pattern', p => !p.nutrition.pattern, 'How do you eat day to day? Any pattern or restrictions? (If skipped: assume omnivore, no restrictions; confirm before any meal plan.)'],
  ['Q6 supplements', p => !p.supplements.length && !p.meta.supplements_asked, 'Do you take any supplements or vitamins currently? (If skipped: assume none, re-ask before recommending one.)'],
  ['Q7 tracking', p => !p.wearable.device && !p.meta.tracking_asked, "Do you track anything — a wearable, a scale, blood tests — that you'd want to share? (Optional.)"],
  ['Q8 coaching style', p => !p.profile.preferences.coaching_style, 'Do you want me direct and pushing you, or gentler and encouraging? (If skipped: direct-but-warm.)'],
]

function onboardingStatus(p) {
  const missing = QUESTIONS.filter(([, isMissing]) => isMissing(p))
  if (!missing.length) return 'Onboarding: complete.'
  const canCoach = p.goals.primary && p.meta.constraints_asked
  return [
    'Onboarding: in progress. The user confirmed they are 18+ and saw the data disclosure (Q0) with buttons, so never ask about age again.',
    canCoach
      ? 'You have the goal and the health constraints, so coach freely. Pick up the remaining questions naturally, one or two at a time, when they fit — not as a form:'
      : 'Get the goal (Q1) and health constraints (Q2) before coaching, one or two questions at a time, conversationally:',
    ...missing.map(([name, , text]) => `- ${name}: ${text}`),
  ].join('\n')
}

// ───────────── modes (docs/personas.md), chosen by code ─────────────

export const MODES = {
  ED_SAFE: `# MODE: DISORDERED-EATING SAFE (locked on; overrides every other mode)
This user has a disordered-eating flag. Provide no calorie targets, deficits, restriction protocols, fasting guidance, weight-loss programming, detailed macro tracking, or "cheat day" framing — even if asked directly. Do not estimate calories from food photos; talk about the food's qualities instead (protein source, variety, whether it looks like a satisfying meal). Shift everything toward non-numeric, health- and behavior-based goals: energy, strength, how food makes them feel, regular adequate eating. If they push for numbers or restriction, decline gently and hold the line, and where appropriate point toward professional support. Stay warm and supportive — just without numbers.`,
  BEGINNER: `# MODE: COMPLETE BEGINNER, VAGUE GOAL
Maximum simplicity, one thing at a time. Don't hand them a program. Narrow the vague goal into one concrete, achievable starting habit (a protein-forward breakfast, a daily walk, a consistent sleep window) by asking what feels most off — energy, sleep, eating, or movement. Celebrate small consistency. No jargon, no supplements early, nothing that feels like a regimen.`,
  WEIGHT_LOSS: `# MODE: WEIGHT LOSS
Calorie and protein targets are live inputs. Anchor on protein adequacy and consistency before any deficit. The deficit is conservative — hard ceiling ~500 kcal/day, ~0.5–1% bodyweight/week — and framed as a tradeoff (sustainable protects muscle and adherence; faster costs both). Emphasize the weekly-average weight trend, not daily fluctuation. Watch for the slide from "deficit" into "restriction"; if it appears, back off.`,
  PERFORMANCE: `# MODE: MUSCLE GAIN / PERFORMANCE
Protein and progressive overload lead. Adequate calories (maintenance or slight surplus), not a deficit. Recovery and sleep get MORE weight, not less — they cap adaptation. On a plateau, check recovery and protein first, then the progression scheme; don't just add volume. Evidence-based basics (e.g. creatine) are reasonable to suggest, generically, with standard caveats and an interaction check.`,
  CONDITION: `# MODE: MANAGING A CONDITION ALONGSIDE THEIR DOCTOR
Highest-care non-crisis mode. Support the doctor's plan; never contradict, adjust, or second-guess it. Lifestyle lane only — movement, fiber, general dietary patterns, sleep. Defer medication and clinical targets to the physician, every time. Frame everything as "alongside what your doctor has advised" and encourage them to run changes past their doctor. Interaction checks are mandatory.`,
  LONGEVITY: `# MODE: OLDER ADULT, LONGEVITY AND MOBILITY
Prioritize protein (higher relative needs), resistance training for muscle preservation (sit-to-stand, carries), balance and mobility, fall prevention, and recovery. De-emphasize aggressive intensity and deficits. Progress more gradually; consolidate longer. Extra caution with supplements — medications are more likely; always check interactions.`,
  HIGH_FREQUENCY: `# NOTE: FREQUENT UPLOADER
This user messages often. Keep replies short, don't re-explain what you covered earlier today, and watch for obsessive tracking — if daily numbers seem to be driving anxiety, gently widen the lens to weekly trends.`,
  RETURNING: `# NOTE: RETURNING AFTER A GAP
It has been several days since the last exchange. A fuller synthesis is welcome: briefly connect where they left off to what they're asking now. Do not scold them for the gap. (You never message first — respond only.)`,
}

export function selectModes(p, turns, now = Date.now()) {
  if (p.constraints.eating_disorder_flag === true) return ['ED_SAFE']
  const out = []
  let cat = p.goals.category
  if (!cat && p.goals.primary) {
    const g = p.goals.primary.toLowerCase()
    if (/lose|weight|fat|slim|kg|lbs|diet|numest|svor|liekn/.test(g)) cat = 'weight_loss'
    else if (/muscle|strength|strong|lift|gain|bulk|perform|raumen|stipr|jėg/.test(g)) cat = 'performance'
    else if (/independ|mobility|longevity|balance|aging|ageing|fall|ilgaam/.test(g)) cat = 'longevity_mobility'
    else cat = 'general_wellness'
  }
  if (cat === 'weight_loss') out.push('WEIGHT_LOSS')
  else if (cat === 'performance') out.push('PERFORMANCE')
  else if (cat === 'longevity_mobility') out.push('LONGEVITY')
  else if (cat === 'general_wellness') out.push('BEGINNER')
  if (cat === 'condition_management' || p.constraints.conditions.length || p.constraints.medications.length) out.push('CONDITION')
  const userTimes = turns.filter(t => t.role === 'user').map(t => Date.parse(t.ts))
  const last24h = userTimes.filter(t => now - t < 86400e3).length
  const last = turns.length ? Date.parse(turns[turns.length - 1].ts) : null
  if (last24h >= 8) out.push('HIGH_FREQUENCY')
  else if (last && now - last > 5 * 86400e3) out.push('RETURNING')
  return out
}

// ───────────── profile ─────────────

/** Blank profile (docs/profile_schema.json), created only once the user confirmed 18+. */
export function newProfile(name, now) {
  return {
    profile: { display_name: name || null, age_confirmed_18_plus: true, sex: null, language: null, preferences: { coaching_style: null, response_length: null } },
    goals: { primary: null, category: null, secondary: [], target_metrics: [] },
    constraints: { conditions: [], medications: [], injuries: [], allergies: [], therapies: [], eating_disorder_flag: null },
    nutrition: { pattern: null, restrictions: [], targets: { calories: null, protein_g: null, max_deficit_kcal: 500, set_by: null } },
    activity: { baseline: null, current_training: [], programs: [] },
    sleep: { pattern: null, typical_hours: null },
    supplements: [],
    lab_markers: [],
    wearable: { device: null, metrics: [] },
    food_log_summaries: [],
    coach_notes: [],
    meta: { constraints_asked: false, supplements_asked: false, tracking_asked: false, created_at: now },
  }
}

/** Drops empty fields so the profile costs as few tokens as possible. */
function compact(o) {
  if (Array.isArray(o)) { const a = o.map(compact).filter(v => v !== undefined); return a.length ? a : undefined }
  if (o && typeof o === 'object') {
    const r = {}
    for (const [k, v] of Object.entries(o)) {
      if (k === 'meta') continue
      const c = compact(v)
      if (c !== undefined) r[k] = c
    }
    return Object.keys(r).length ? r : undefined
  }
  return o === null || o === undefined || o === '' ? undefined : o
}

// ───────────── the coach call ─────────────

/** Turns stored history + the new message into a Claude request. */
export function buildRequest(user, message, now = new Date()) {
  const p = user.profile
  const modes = selectModes(p, user.turns, now.getTime())
  const parts = [
    '# THIS USER',
    `Today is ${now.toISOString().slice(0, 10)}. The user chats with you on a website (text, photos, PDFs).`,
    onboardingStatus(p),
  ]
  const prof = compact(p)
  if (prof) parts.push('Profile (empty fields omitted):\n' + JSON.stringify(prof))
  if (user.summary) parts.push('# EARLIER CONVERSATION (summary)\n' + user.summary)
  for (const m of modes) parts.push(MODES[m])

  const history = []
  for (const t of user.turns.slice(-RECENT_TURNS)) {
    const content = (t.attachment ? `[sent a ${t.attachment}] ` : '') + t.content
    if (history.length && history[history.length - 1].role === t.role) history[history.length - 1].content += '\n\n' + content
    else history.push({ role: t.role, content })
  }
  if (history.length && history[0].role !== 'user') history.unshift({ role: 'user', content: '(I just joined and confirmed I am 18 or over.)' })
  if (history.length && history[history.length - 1].role === 'user') {
    // The last saved turn was a user message without a reply (e.g. a failed call): merge it in.
    message = { ...message, text: history.pop().content + '\n\n' + (message.text || '') }
  }

  const content = []
  if (message.image) content.push({ type: 'image', source: { type: 'base64', media_type: message.image.media_type, data: message.image.data } })
  if (message.pdf) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: message.pdf.data } })
  content.push({ type: 'text', text: message.text || (message.image ? '(photo, no caption)' : message.pdf ? '(PDF, no caption)' : '(empty message)') })

  return {
    modes,
    body: {
      model: MODEL,
      max_tokens: 1500,
      system: [
        { type: 'text', text: STATIC_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: parts.join('\n\n') },
      ],
      messages: [...history, { role: 'user', content }],
    },
  }
}

// ───────────── profile update after each turn ─────────────

const EXTRACT_PROMPT = `You maintain a structured health-coaching profile. Given the current profile and the latest exchange, call update_profile with ONLY the fields that changed or were newly stated by the user. Rules:
- Only record facts the USER stated or data they shared (including values visible in an image or PDF they sent, as the coach read them). Never infer sensitive facts. Never record the coach's suggestions as user facts, except: if the coach set a nutrition target and the user accepted it, record it with targets_set_by "coach".
- under_18: true ONLY if the user clearly says they are younger than 18. Otherwise omit.
- eating_disorder_signs: true if the user disclosed a history of disordered eating or shows clear signs (compulsive restriction, purging, fear of food). Never put any detail about this anywhere else, including coach_note. Omit the field if not present.
- constraints_asked: true if the coach asked about conditions/medications/injuries/allergies and the user answered — including "none".
- supplements_asked / tracking_asked: true once the user answered those questions, even with "none".
- goal_category: the single best fit for the primary goal.
- For arrays (conditions, medications, supplements, etc.) return only NEW items to add.
- food_log_entry only when the user shared a meal (photo or description) and the coach estimated it.
- coach_note: at most one short observation about a durable pattern, if any. No sensitive content.
- Omit everything you are not confident about.`

const strArr = { type: 'array', items: { type: 'string' } }
export const UPDATE_TOOL = {
  name: 'update_profile',
  description: 'Record profile updates from the latest exchange.',
  input_schema: {
    type: 'object',
    properties: {
      under_18: { type: 'boolean' },
      eating_disorder_signs: { type: 'boolean' },
      constraints_asked: { type: 'boolean' },
      supplements_asked: { type: 'boolean' },
      tracking_asked: { type: 'boolean' },
      display_name: { type: 'string' }, sex: { type: 'string' }, language: { type: 'string' },
      coaching_style: { type: 'string', enum: ['direct', 'gentle'] },
      response_length: { type: 'string', enum: ['brief', 'detailed'] },
      goal_primary: { type: 'string' },
      goal_category: { type: 'string', enum: ['weight_loss', 'performance', 'general_wellness', 'condition_management', 'longevity_mobility'] },
      goals_secondary_add: strArr,
      conditions_add: strArr, medications_add: strArr, injuries_add: strArr, allergies_add: strArr, therapies_add: strArr,
      nutrition_pattern: { type: 'string' },
      nutrition_restrictions_add: strArr,
      target_calories: { type: 'integer' }, target_protein_g: { type: 'integer' },
      targets_set_by: { type: 'string', enum: ['coach', 'user'] },
      activity_baseline: { type: 'string', enum: ['sedentary', 'light', 'moderate', 'high'] },
      current_training_add: strArr,
      sleep_pattern: { type: 'string' }, sleep_typical_hours: { type: 'number' },
      supplements_add: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, dose: { type: 'string' }, timing: { type: 'string' }, purpose: { type: 'string' } }, required: ['name'] } },
      lab_markers_add: { type: 'array', items: { type: 'object', properties: { marker: { type: 'string' }, value: { type: 'number' }, unit: { type: 'string' }, date: { type: 'string' }, reference_range: { type: 'string' }, flag: { type: 'string', enum: ['low', 'normal', 'high', 'borderline'] } }, required: ['marker', 'value'] } },
      wearable_device: { type: 'string' },
      wearable_metrics_add: { type: 'array', items: { type: 'object', properties: { metric: { type: 'string' }, value: { type: 'number' }, unit: { type: 'string' }, date: { type: 'string' } }, required: ['metric', 'value'] } },
      food_log_entry: { type: 'object', properties: { summary: { type: 'string' }, est_calories: { type: 'string' }, est_protein_g: { type: 'string' } } },
      coach_note: { type: 'string' },
    },
  },
}

export function extract(profile, userText, attachment, reply) {
  return callTool({
    model: EXTRACT_MODEL,
    max_tokens: 1500,
    system: EXTRACT_PROMPT,
    messages: [{ role: 'user', content: `CURRENT PROFILE:\n${JSON.stringify(profile)}\n\nLATEST EXCHANGE:\nUSER${attachment ? ` [sent a ${attachment}]` : ''}: ${userText || '(no text)'}\nCOACH: ${reply}` }],
  }, UPDATE_TOOL)
}

/**
 * Applies an update. Returns 'delete' when the user turned out to be under 18 (the caller then
 * deletes everything), otherwise 'ok'. The two hard storage rules are enforced here, in code.
 */
export function applyUpdate(p, ex, now) {
  // HARD RULE 1: under 18 → nothing is kept.
  if (ex.under_18 === true) return 'delete'

  // HARD RULE 2: disordered eating is one boolean, set-only, never details.
  if (ex.eating_disorder_signs === true) p.constraints.eating_disorder_flag = true
  const ed = p.constraints.eating_disorder_flag === true

  const set = (obj, key, val) => { if (val !== undefined && val !== null && val !== '') obj[key] = val }
  set(p.profile, 'display_name', ex.display_name); set(p.profile, 'sex', ex.sex); set(p.profile, 'language', ex.language)
  set(p.profile.preferences, 'coaching_style', ex.coaching_style); set(p.profile.preferences, 'response_length', ex.response_length)
  set(p.goals, 'primary', ex.goal_primary); set(p.goals, 'category', ex.goal_category)
  set(p.nutrition, 'pattern', ex.nutrition_pattern)
  if (!ed) {
    set(p.nutrition.targets, 'calories', ex.target_calories); set(p.nutrition.targets, 'protein_g', ex.target_protein_g)
    set(p.nutrition.targets, 'set_by', ex.targets_set_by)
  }
  set(p.activity, 'baseline', ex.activity_baseline)
  set(p.sleep, 'pattern', ex.sleep_pattern); set(p.sleep, 'typical_hours', ex.sleep_typical_hours)
  set(p.wearable, 'device', ex.wearable_device)
  if (ex.constraints_asked) p.meta.constraints_asked = true
  if (ex.supplements_asked) p.meta.supplements_asked = true
  if (ex.tracking_asked) p.meta.tracking_asked = true

  const union = (arr, add) => { for (const s of add || []) if (!arr.some(x => x.toLowerCase() === String(s).toLowerCase())) arr.push(String(s)) }
  union(p.goals.secondary, ex.goals_secondary_add)
  union(p.constraints.conditions, ex.conditions_add); union(p.constraints.medications, ex.medications_add)
  union(p.constraints.injuries, ex.injuries_add); union(p.constraints.allergies, ex.allergies_add)
  union(p.constraints.therapies, ex.therapies_add)
  union(p.nutrition.restrictions, ex.nutrition_restrictions_add)
  union(p.activity.current_training, ex.current_training_add)

  const cap = (arr, n) => { while (arr.length > n) arr.shift() }
  for (const s of ex.supplements_add || []) if (s?.name && !p.supplements.some(x => x.name.toLowerCase() === s.name.toLowerCase())) p.supplements.push({ ...s, added_date: now })
  for (const l of ex.lab_markers_add || []) if (l?.marker) p.lab_markers.push({ ...l, date: l.date || now }); cap(p.lab_markers, 200)
  for (const w of ex.wearable_metrics_add || []) if (w?.metric) p.wearable.metrics.push({ ...w, date: w.date || now }); cap(p.wearable.metrics, 90)
  if (!ed && ex.food_log_entry?.summary) { p.food_log_summaries.push({ date: now, ...ex.food_log_entry }); cap(p.food_log_summaries, 30) }
  if (ex.coach_note) { p.coach_notes.push({ date: now, note: String(ex.coach_note).slice(0, 300) }); cap(p.coach_notes, 20) }

  if (ed) {
    p.nutrition.targets.calories = null
    p.nutrition.targets.protein_g = null
    p.food_log_summaries = []
  }
  return 'ok'
}

// ───────────── rolling summary ─────────────

const SUMMARY_PROMPT = 'You compress a health-coaching conversation into a running summary for the coach\'s own memory. Rewrite the EXISTING SUMMARY to incorporate the NEW TURNS. Keep: goals discussed, plans and targets agreed, data shared (as brief notes, not full values — the profile holds values), open threads, and anything the user asked the coach to remember. Drop chit-chat. Do not include any detail about disordered eating, self-harm, or age beyond "adult". Max 250 words, plain prose, third person ("the user...").'

/** When history gets long, folds the oldest turns into the summary. Mutates user. */
export async function foldHistory(user) {
  if (user.turns.length <= FOLD_AT) return false
  const fold = user.turns.slice(0, user.turns.length - RECENT_TURNS)
  const transcript = fold.map(t => `${t.role === 'user' ? 'USER' : 'COACH'} (${t.ts.slice(0, 10)}): ${t.attachment ? `[sent a ${t.attachment}] ` : ''}${t.content}`).join('\n')
  const summary = await complete({
    model: EXTRACT_MODEL,
    max_tokens: 600,
    system: SUMMARY_PROMPT,
    messages: [{ role: 'user', content: `EXISTING SUMMARY:\n${user.summary || '(none)'}\n\nNEW TURNS:\n${transcript}` }],
  })
  if (summary) {
    user.summary = summary
    user.turns = user.turns.slice(-RECENT_TURNS)
  }
  return true
}
