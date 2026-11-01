# Health Coach (closed alpha)

Invite-only AI health coach website. Claude Sonnet 5.5 (`claude-sonnet-5-5`), Node 22 with no npm dependencies, data stored as JSON files in one volume.

Testers open a one-time invite link, confirm they are 18+ (buttons), then chat. Text, photos (meals, wearable screenshots, supplement labels) and PDFs (blood tests) are supported. The coach remembers each person through a structured profile, their last 12 messages and a rolling summary of older ones.

## Deploy on Coolify

1. **New resource → Public/Private repository** → this repo, branch `main`, build pack **Dockerfile**.
2. **Port**: `3000`. Set the domain (e.g. `https://coach.example.com`).
3. **Persistent storage**: add a volume mounted at **`/app/data`**. Without it, every redeploy wipes all testers.
4. **Environment variables**: all of them runtime-only. Untick "Available at buildtime".

| Variable | Required | What it is |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | A **standard** API key from console.anthropic.com (never an admin key). Set a monthly spend limit on the workspace. |
| `ADMIN_PASSWORD` | yes | Password for `/admin`. |
| `SESSION_SECRET` | yes | Long random string (`openssl rand -hex 32`). Keeps testers logged in across redeploys. |
| `CLAUDE_MODEL` | no | Default `claude-sonnet-5-5`. |
| `DAILY_MESSAGE_LIMIT` | no | Messages per tester per day, default `60`. |
| `COACH_EFFORT` | no | How hard the coach thinks before replying: `low`, `medium` (default), `high`. Higher is slower and costs more. |
| `APP_NAME` | no | Shown in the header, default `Health Coach`. |

5. Deploy, open `https://<domain>/admin`, log in, create an invite link, and send it to a tester.

Health check: `GET /health`.

## Using it

- **/admin**: create one-time invite links; see testers, messages and token use; create a **login link** for an existing tester (new phone or cleared browser); delete a tester.
- **Tester menu (⋮)**: *Download my data* (JSON) and *Delete my data* (everything, immediately).
- Photos are resized in the browser (max 1568 px, JPEG). PDFs can be up to 10 MB. Photos and PDFs are sent to Claude once and **never saved**; only what the coach extracted from them is kept (e.g. a lab marker or a meal estimate).

## How it works

```
server.js        HTTP server: invite/gate/session cookies, chat (SSE streaming), admin API
lib/coach.js     builds each Claude call: owner's system prompt (cached) + THIS USER block
                 (onboarding status, profile, summary, persona modes) + last 12 turns;
                 after each reply a forced tool call updates the profile; old turns are folded
                 into a ≤250-word summary
lib/claude.js    Messages API over fetch (streaming, tool call, plain call)
lib/store.js     JSON files: data/users/<id>.json, data/invites.json (atomic writes, per-user lock)
public/          chat page, admin page
prompts/         system_prompt.md: the owner-approved prompt, used verbatim (after the --- line)
docs/            owner's spec files + decisions.md
```

Hard rules are enforced in code (`applyUpdate` in `lib/coach.js`), not only in the prompt:
- Under 18 at the gate → nothing is stored. Under 18 said later in chat → the whole user is deleted.
- Disordered eating → only `eating_disorder_flag: true` is stored (it can never be unset); calorie/protein targets and food logs are wiped, and the coach switches to ED-safe mode only.

## Develop and test

```
node server.js                 # needs the env vars above (ANTHROPIC_API_KEY for real replies)
npm test                       # unit tests (no network)
node test/e2e.mjs              # browser test with a fake Claude and fake users (needs Playwright)
```

The tests never call Anthropic: `test/mock-claude.mjs` stands in for the API via `ANTHROPIC_API_BASE`.
