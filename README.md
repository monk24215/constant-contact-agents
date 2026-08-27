# constant-contact-agents

Three small, compartmentalized agents that manage Constant Contact campaigns
from a Notion content calendar — built so that a human always reviews and
sends the final email. Nothing in this system sends live mail on its own.

Built by [@monk24215](https://github.com/monk24215), in collaboration with
[Claude](https://claude.com) (Anthropic) as build partner. See
[Credits](#credits) below.

## How it fits together

```
Notion (content calendar)
      │
      ▼
┌─────────────┐      shares oauth_tokens row (Postgres)      ┌──────────────┐
│  composer/   │◀────────────────────────────────────────────▶│    auth/     │
│  polls Notion,│                                              │  one-time    │
│  drafts in CC,│                                              │  OAuth setup │
│  DRAFT-ONLY   │                                              │  + refresh   │
└─────────────┘                                              └──────────────┘
      ▲
      │ same token row
┌─────┴───────┐
│    mcp/      │  lets Claude (or any MCP client) query lists,
│  read + a few │  campaigns, and stats — and create/edit DRAFTS
│  guarded writes│  through a capability-URL-protected endpoint
└─────────────┘
```

- **`auth/`** — One-time OAuth authorization against your Constant Contact
  account, plus automatic (rotating) token refresh. Every other service reads
  the same `oauth_tokens` Postgres row this service maintains.
- **`composer/`** — Polls a Notion database on a timer, turns rows marked
  `Status = draft` into **draft** Constant Contact campaigns, and writes the
  campaign ID back to Notion. It has no code path that can send or schedule
  a campaign — that's a deliberate, hard-coded safety wall (`DRAFT_ONLY =
  true` in `composer/src/worker.js`).
- **`mcp/`** — An [MCP](https://modelcontextprotocol.io) server so an MCP
  client (e.g. Claude) can read your Constant Contact account (lists,
  campaigns, stats) and create/edit **drafts**. Its only "live" action is
  `cc_send_test`, which sends to up to 5 explicit test addresses — it can
  never message a real contact list.

Each folder is a **separate deployable service** (three Railway services
sharing one Postgres database for tokens). There is intentionally no
root-level build config.

## Prerequisites

- A [Railway](https://railway.com) account (or any host that can run three
  small Node/Express services + Postgres)
- A [Constant Contact developer app](https://developer.constantcontact.com/)
  (gives you `CC_CLIENT_ID` / `CC_CLIENT_SECRET`)
- A [Notion integration](https://www.notion.so/my-integrations) with access
  to your content-calendar database (gives you `NOTION_TOKEN` /
  `NOTION_DB_ID`) — only needed for `composer/`
- Node.js 18+ if you want to run any service locally

## Quick start

1. **Deploy Postgres** (Railway → New → Database → Postgres). This holds the
   single `oauth_tokens` row every service shares.
2. **Deploy `auth/`** as its own service with **Root Directory: `/auth`**.
   Set its env vars (see `auth/.env.example`), then visit its URL and click
   **Authorize Constant Contact** once. After that you never need to return
   to it unless the refresh chain is revoked.
3. **Deploy `composer/`** with **Root Directory: `/composer`**. Set its env
   vars (see `composer/.env.example`). It will start polling your Notion
   calendar every `POLL_MINUTES` and drafting campaigns for rows with
   `Status = draft`.
4. **(Optional) Deploy `mcp/`** with **Root Directory: `/mcp`** if you want
   an MCP client (like Claude) to read/draft against the account directly.
   See `mcp/README.md` for connecting it.

Each service has its own `.env.example` listing exactly what it needs — copy
it to `.env` for local runs, or paste the same keys into your host's env var
UI for deployment.

## Notion calendar schema

`composer/` expects an "Email Campaign Tracker" database with (at least)
these properties: `Status` (select), `Subject Line` (title), `Preheader`
(rich text), `Body Copy` (rich text), `From` (email), `Category` (select),
`Send Date` (date), `CC Campaign ID` (rich text, written by the agent),
`CC Activity ID` (rich text, written), `CC Link` (url, written), `Agent
Notes` (rich text, written), `Opens` / `Clicks` (number, written by whatever
reports back into the tracker).

## Safety model

- `composer/` can only ever create **drafts**. There is no send/schedule
  function imported or reachable from it.
- `mcp/`'s only path to a real inbox is `cc_send_test`, capped at 5 explicit
  addresses — it cannot write to or message a live contact list.
- Every service that has a status/trigger page you can reach over HTTP —
  `mcp/`'s `/mcp/<secret>`, `auth/`'s `/` and `/verify`, `composer/`'s `/`
  and `/run` — supports a shared-secret capability URL (compared with a
  timing-safe check, 404 on mismatch), so a discovered Railway URL alone
  isn't enough to read the account or trigger anything. `mcp/` requires its
  secret (`MCP_SHARED_SECRET`); `auth/` (`AUTH_SHARED_SECRET`) and
  `composer/` (`COMPOSER_SHARED_SECRET`) treat it as optional and log a
  startup warning if it's unset, so older deployments aren't broken by this
  change. Set all three when you deploy. Rotate any of them by changing the
  env var — that immediately invalidates the old URL.
- `/healthz` on every service is intentionally left ungated — it returns no
  account data and Railway's healthcheck needs to reach it unauthenticated.

## Rights

No open-source license is included, so **all rights are reserved** by the
authors — the code is visible for reference, but nobody has permission to
copy, modify, or redistribute it without asking first. If you'd like to use
it, open an issue or reach out to [@monk24215](https://github.com/monk24215).

## Credits

Built collaboratively by **[@monk24215](https://github.com/monk24215)** and
**Claude** (Anthropic) — architecture, safety guardrails (draft-only writes,
capability-URL auth, rotating-token handling), and documentation were worked
out together across the project's history.
