# Notes for Claude / developers

- Read `docs/open_questions.md` and `docs/decisions.md` first. Settled owner decisions are not to be reinterpreted.
- **Do not edit `prompts/system_prompt.md` without owner (MK) sign-off.** Behaviour tweaks go in the code-selected modes in `lib/coach.js` (from `docs/personas.md`), and those also need the owner's OK.
- Never commit, log or screenshot the API key. Standard key only. Build and test with fake users only (`test/`).
- Storage rules live in `applyUpdate()`. Keep them in code: no under-18 data, no eating-disorder details (only the boolean).
- No npm dependencies. Node 22. Run `npm test` and `node test/e2e.mjs` before pushing.
