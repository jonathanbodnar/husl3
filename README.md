# Vibe Distribution — the app

A conversational distribution audit for SaaS founders. Enter your site; the guide reads it, places you on the journey (first users → activation → monetization → retention → acquisition → scale), asks what it cannot infer, and keeps a **what-to-do** list in a side panel. Connect your **Postgres/Supabase** database and **GitHub** repository and it measures instead of guessing: what the data says, what you already shipped that the data cannot show yet, and what to instrument. One click writes a **coding-agent prompt** per item.

No accounts. Session state lives in the browser; credentials travel only inside the requests that need them and are never stored server-side.

The evidence is the **Vibe Distribution brain** (`server/brain/brain.json`): 20 principles, 31 measured effects with confidence labels, 45 laws, 22 measurement traps, 45 killed ideas, 25 audits, 40 metric recipes and a 7-stage journey, distilled from one AI SaaS's first 97 days. It is built in the [vibe-distribution](../vibe-distribution) repo and copied here with `npm run sync-brain`. Never edit it here.

## Models and cost

| Role | Default | Why |
|---|---|---|
| Conversation (every turn) | `deepseek-v4-pro` via `https://api.deepseek.com/v1` | The whole brain (~50k tokens) sits first in the system prompt, byte-identical for every visitor, so nearly all of it is a **cache hit** on every turn. Cached input is the price that matters. |
| Prompt writer (one call per audit) | `qwen3.8-max-0902` via Alibaba Cloud Model Studio (US endpoint) | Post-trained for coding and agentic work; writes the prompts a coding agent will execute. |

Both endpoints are OpenAI-compatible, so any provider works by changing `*_BASE_URL`, `*_MODEL` and the key (OpenRouter ids: `deepseek/deepseek-v4-pro`, `qwen/qwen3.8-max-0902`; Kimi K3 or a Claude proxy fit the same slot). Prices are configurable and only feed the cost meter. Design target: **≈15–20¢ per audit** for the pair.

Measured live (Sep 2026, one sample site): a DeepSeek opening turn with a tool round costs about 7¢ when the brain prefix is cold and well under 1¢ once cached; one Qwen prompt costs 0.9¢ with thinking off, 1.2¢ with `PROMPT_THINKING_BUDGET=3000` (31 s), and 6.6¢ uncapped (243 s). Keep the budget set.

## Run

```bash
cp .env.example .env      # add DEEPSEEK_API_KEY and DASHSCOPE_API_KEY
npm install
npm run dev               # API on :8787, web on :5173 (proxied)
```

Production: `npm run build && npm start` (serves the built client and the API on `PORT`, default 8787). The `Dockerfile` and `railway.json` deploy as-is on Railway (`railway up`), or anywhere that runs a container. Set the same variables there.

## The scoreboard: the plan through the founder's data

The brain is not there to tell a founder what to do; it supplies metric recipes and readiness checks, and the founder's data decides which apply and what they say. Once a database is connected the guide's first job is the scoreboard:

1. It names the money event, the activation definition and the core request for this product, and the reporting timezone.
2. It binds the brain's recipes (`metrics[].id`, e.g. `activation_day0`) to the founder's real tables with the `update_scoreboard` tool. Each stat has a kind with a strict SQL contract: `number` (one row, `value`), `rate` (`numerator`, `denominator`), `series` (`day`, `value`), `funnel` (`step`, `count`), `breakdown` (`label`, `value`), or `assert` (a value the founder stated, shown as stated).
3. The server runs every stat on one read-only connection, applies the honesty rules itself (today dropped in the reporting timezone; a share with a numerator under 5 or a denominator under 100 shown as counts, never a percentage), and grades the journey's readiness checks (`journey[].readiness[].check`) deterministically. **Stage by the numbers** is the earliest stage with a check the data does not clear; unmeasured checks are listed as gaps rather than pinning a founder with paying accounts at "before users".
4. With a repository connected, the funnel is rebuilt from the code path: the files behind signup, the core action, the limit, checkout and tracking, and the event names they actually emit.

The scoreboard lives in a tab beside the to-dos (stat tiles, sparkline, funnel and breakdown bars, graded readiness rows, every stat's why and SQL, refresh), is rendered into the model's context every turn, and feeds the prompt writer so prompts cite real numbers. Verified with the real conversation model on a seeded Postgres: it explored the schema, bound ten stats with correct contracts, fixed two failing ones in the same turn, and placed the founder from the graded numbers.

## Connecting data: OAuth first

With the two OAuth apps registered (see `.env.example`), the connect dialog offers **Connect Supabase** and **Connect GitHub** buttons: a popup, an authorization, then a picker for the project or repository. The server only brokers the code-for-token exchange (it holds the client secrets); tokens are handed to the browser through a relay page and travel back inside the requests that need them. Supabase queries run through the Management API with `read_only: true` on top of the app's own SQL gate; Supabase tokens are refreshed by the client shortly before they expire. Without the OAuth apps configured, the dialog falls back to a Postgres connection string and a GitHub personal access token, and both remain available under "use … instead" for edge cases (any Postgres, a token for a single repo).

Register the apps once per domain:

- **GitHub** — Settings → Developer settings → OAuth Apps → New OAuth App; callback `https://<domain>/api/auth/github/callback`; copy the client id and generate a secret into `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.
- **Supabase** — Organization settings → OAuth Apps → Add application; redirect `https://<domain>/api/auth/supabase/callback`; scopes Organizations read, Projects read, Database write (required by the query endpoint); copy the client id and secret into `SUPABASE_OAUTH_CLIENT_ID` / `SUPABASE_OAUTH_CLIENT_SECRET`.

## Protecting your keys

There are no accounts, so the operator's model keys are what to protect:

- `ACCESS_CODE` — optional shared code; the client asks once and sends it with every request.
- `DAILY_BUDGET_USD` — hard stop per UTC day across all visitors (in-memory).
- `RATE_*_PER_HOUR` — per-IP limits for chat turns, scans and prompt calls.
- Server-side fetches refuse private and link-local addresses; SQL runs only as a single `SELECT`/`WITH`/`EXPLAIN` inside a read-only transaction with a 20-second timeout and a 200-row cap.

## Layout

```
server/           Hono API (Node 22)
  brain/          brain.json snapshot, renderer (brain → cached prefix), system prompt
  llm/            OpenAI-compatible streaming client (tools, usage, per-vendor thinking switch)
  tools/          update_todos, run_sql, db_describe_table, fetch_page, github_*
  site/           site scanner (home + pricing/signup/login/features/docs, CTAs, prices, forms, stack)
  db/             read-only Postgres introspection and queries
  github/         repo digest, commits, files
  prompts/        one-call prompt writer
  chat.ts         the turn loop (stream → tools → stream …)
web/              Vite + React client (chat, what-to-do panel, connect dialog, cost meter)
shared/types.ts   contract between the two
```

## Brain updates

```bash
npm run sync-brain    # copies ../vibe-distribution/brain/brain.json
```

The renderer turns the JSON into a compact text prefix (`server/brain/render.ts`); the version prints on startup and in `/api/health`.
