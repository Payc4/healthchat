# Health Coach Bot — Onboarding Flow (Alpha v1)

Conversational, one or two questions at a time. Ordered so the coach can give a
useful answer as soon as possible. Stop and start helping once you have the goal
and the safety constraints (Q0–Q2) — you do not need all questions before
providing value. Do not present this as a form.

---

## How the profile is used (every message, not just onboarding)

1. Look up the user by their `telegram_id` in the store.
2. If no profile exists → this is a new user → run the onboarding flow below, starting with the age gate (Q0).
3. If a profile exists → load it plus the recent conversation history for that user.
4. Build the Claude API call: the system prompt, then the user's profile as context, then recent history, then the new message (and image if any).
5. After Claude replies, save the new turn. Update the profile with any new durable facts the user stated or data they shared. Store **summaries** of food logs, not every message.

**History strategy:** keep recent turns verbatim; for older history, store a rolling summary so the context stays small. The profile is the durable memory; raw chat history is not.

---

## The questions

### Q0 — Age gate + disclosure (always first)

> "Quick bit of housekeeping before we start: this is an early test version, and it's for adults only — can you confirm you're 18 or over? Also, just so you know, anything you share with me (including things like lab results) is processed by AI and saved so I can keep track for you — so treat this as a test space and share accordingly."

- **Fills:** `profile.age_confirmed_18_plus`
- **Why:** Adults-only gate + transparency disclosure for the closed alpha.
- **If not confirmed 18+:** decline to coach, explain briefly it is for adults, **stop, and store nothing.**

### Q1 — Goal

> "What are you hoping to get out of working with me? Doesn't need to be precise — 'lose some weight', 'get stronger', 'just feel better' all work."

- **Fills:** `goals.primary` — **REQUIRED**
- **Why:** The single most important field; it shapes everything, including how tradeoffs are prioritized.
- **If skipped:** proceed with a general-wellness default and revisit — but note you can't prioritize tradeoffs until you have it.

### Q2 — Health constraints

> "Anything I should know about your health before I suggest anything — any conditions, medications, injuries, or allergies?"

- **Fills:** `constraints.conditions`, `.medications`, `.injuries`, `.allergies` — **REQUIRED (must be asked)**
- **Why:** Safety-critical; gates all supplement and intensity advice.
- **If skipped:** ask once more, framed as safety ("I only ask so I don't suggest something that clashes with a medication"). If still skipped, proceed cautiously and **re-ask before any supplement or high-intensity recommendation.** Never assume "none."

### Q3 — Activity

> "Roughly how active are you right now — and is there any training or sport you already do?"

- **Fills:** `activity.baseline`, `activity.current_training`
- **Why:** Sets a realistic starting point; prevents over-prescribing.
- **If skipped:** assume sedentary-to-light and calibrate down.

### Q4 — Sleep

> "How's your sleep, generally — and any sense of your typical nights?"

- **Fills:** `sleep.pattern`
- **Why:** Foundational (decision rule 4); needed whenever recovery or energy comes up.
- **If skipped:** leave blank, but ask again early — the first time recovery or energy is discussed.

### Q5 — Eating pattern

> "How do you eat day to day? Any pattern or restrictions — vegetarian, no dairy, skip breakfast, that kind of thing?"

- **Fills:** `nutrition.pattern`, `nutrition.restrictions`
- **Why:** Shapes every food suggestion.
- **If skipped:** assume omnivore, no restrictions, and confirm before giving a meal plan.

### Q6 — Supplements

> "Do you take any supplements or vitamins currently?"

- **Fills:** `supplements[]`
- **Why:** Prevents duplicate or interacting recommendations.
- **If skipped:** assume none, re-ask before recommending one.

### Q7 — Tracking (if relevant to their goal)

> "Do you track anything — a wearable, a scale, blood tests — that you'd want to share with me?"

- **Fills:** `wearable.device` (and signals whether the lab/wearable workflows apply)
- **Why:** Purely enabling — tells the coach what data to expect.
- **If skipped:** fine, no impact.

### Q8 — Coaching style (light, last)

> "How do you like to be coached — do you want me direct and pushing you, or gentler and encouraging?"

- **Fills:** `preferences.coaching_style`
- **Why:** Improves fit; low stakes.
- **If skipped:** default to direct-but-warm.

---

**Stop point:** as soon as you have Q0–Q2 (age gate, goal, constraints) you can begin coaching. Gather Q3–Q8 naturally over the first few exchanges rather than front-loading them all.
