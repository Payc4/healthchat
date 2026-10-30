# Build decisions (alpha v1)

Decisions made while building, on top of the owner's settled decisions in `open_questions.md`.

| Topic | Decision | Why |
|---|---|---|
| Channel | **Website** (mobile-first, installable) instead of Telegram + n8n | Requested by the team. One small service on Coolify, no workflow tool to host. |
| Model | `claude-sonnet-5-5` for replies, profile updates and summaries | Requested. Override with `CLAUDE_MODEL`. |
| System prompt | Owner's v1 `system_prompt.md` used **verbatim** | Signed off. Not the later Poe "v2" rewrite. |
| Personas | Chosen by code from the profile and appended as "MODE" blocks | Matches `personas.md`. ED-safe is exclusive and overrides everything. |
| Q0 age gate | **Buttons** (18+ / under 18) with the disclosure text, before any data is stored | Reliable, no AI judgement needed. Under 18 → nothing stored. |
| Onboarding Q1–Q8 | Asked conversationally; the code tells the coach which questions are still open | Follows `onboarding_flow.md`; Q1 + Q2 required before coaching. |
| Photos / PDFs | Sent to Claude, **not stored** | Less sensitive data held. Only extracted values (lab markers, meal estimates) are kept. |
| Access | One-time invite links, then a 1-year login cookie; admin can issue login links | Closed alpha, trusted circle only. |
| Cost control | Daily message limit per tester (default 60) + prompt caching of the system prompt | Plus the monthly spend limit on the Anthropic workspace. |
| Data rights | Tester can download and delete their data from the menu | Basic GDPR hygiene for the alpha. |

## Still needs the owner

- **Data retention**: how long to keep inactive testers (nothing is auto-deleted now).
- **Monitoring**: who may read conversations. The admin page shows usage only; there's no transcript viewer, on purpose.
- **Languages**: the coach answers in the user's language (LT/EN). Confirm this is wanted.
- **Crisis lines**: still the placeholder plus findahelpline.com. Fill in Lithuanian numbers before a wider release.
- **Consent / DPA**: required before anyone outside the trusted circle joins.
