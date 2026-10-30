# Health Coach Bot — Open Questions & Owner Decisions

Product-owner decisions that shape coach behavior. The eight below were **settled
for alpha v1** by the owner (MK) and are already baked into `system_prompt.md`,
`profile_schema.json`, and `personas.md`. They are recorded here so the reasoning
isn't lost, and so the ones marked **REVISIT** get picked up at the next
iteration. **Do not reinterpret the settled decisions when implementing** — if
something seems wrong, ask the owner.

---

## Settled for alpha v1

| # | Decision | Setting for v1 | Revisit later? |
|---|----------|----------------|----------------|
| 1 | **Deficit aggressiveness** | Conservative. Max ~500 kcal/day, ~0.5–1% bodyweight/week. Encoded as `max_deficit_kcal: 500`. | Make configurable in a later version, not now. |
| 2 | **Supplement brands** | Generic only. No brand names in v1 — avoids affiliate/liability mess. | Possible later, with disclosure + liability review. |
| 3 | **Under 18** | Hard age gate at onboarding: 18+ confirmation required, decline otherwise. Store no data for rejected users. | Firm policy; unlikely to change. |
| 4 | **Crisis resources** | Placeholder kept in prompt; `findahelpline.com` as the single global pointer. **Model must NOT invent numbers.** | **REVISIT:** owner fills in region-specific (e.g. Lithuanian) crisis lines before any wider/public release. |
| 5 | **Lab interpretation depth** | Context, not diagnosis. Defer anything abnormal to a physician. | Holds unless legal advises otherwise. |
| 6 | **Medical deferral scope** | General lifestyle guidance is in scope. Anything touching medication or a diagnosed condition → "discuss with your doctor." | **REVISIT:** get a lawyer's read on the lifestyle/medical line before public launch (not before test users). |
| 7 | **Proactive check-ins** | Out of scope for MVP. Respond-only — the bot never messages first. | **REVISIT:** proactive outreach is a known-good coaching behavior; consider for a later version (needs scheduling infra + consent). |
| 8 | **Health-data consent flow** | None in v1. Closed alpha, team + immediate connections only, all adults told it's a test. A one-line disclosure is shown at onboarding (Q0). | **REVISIT — IMPORTANT:** the moment real users beyond the trusted circle join, this needs a proper consent flow + Anthropic DPA. Special-category health data under GDPR. Do not skip at the next level. |

---

## Still genuinely open (not yet decided)

These weren't resolved and will need an answer before or during the next iteration:

- **History summarization threshold.** At what point does verbatim chat history roll into a summary? (Implementation detail for the intern to propose; owner to confirm cost/behavior tradeoff.)
- **Model choice + cost ceiling.** Which Claude model, and what monthly spend cap per the closed alpha's expected volume? (Owner sets the workspace spend cap; confirm model with owner — coaching quality vs. cost.)
- **Data retention & deletion.** How long is a user's profile kept, and how does a user request deletion? (Deferred with #8, but will be required alongside the consent flow at the next level.)
- **Who operates / monitors the alpha.** Is anyone reviewing conversations for quality or safety during the alpha, or is it fully autonomous? (Affects whether a human is in the loop for escalations.)
- **Multi-language policy.** The prompt says "match the user's language." Confirm which languages are actually supported/expected for the alpha cohort (likely LT + EN).
