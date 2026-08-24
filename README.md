# mcp/ — read-only MCP server for Constant Contact

Exposes the Constant Contact account to Claude as MCP tools, so a client can
query lists, campaigns, and reports without depending on a third-party
connector whose OAuth grant expires independently of this project's tokens.

Deploy as its own Railway service with **Root Directory: `/mcp`**, matching the
pattern in the repo README.

## Why this exists

The `Constant_Contact` connector in Claude and this project are separate
integrations that happen to point at the same account. Refreshing one never
fixes the other. This service removes that second, invisible auth chain: it
reads the same `oauth_tokens` row every other agent uses.

## Read-only by construction

`src/lib/api.js` is a copy of the composer's with `createEmailCampaign` and
`sendTest` deleted. There is no code path in this service that can create,
modify, or send anything in Constant Contact. Campaign creation stays in
`composer/`, draft-only. Keep it that way — if you later want write tools, add
them deliberately rather than by restoring the deleted helpers.

## Token handling

`getValidAccessToken()` behaves exactly as the composer's does — same table,
same rotation-aware save — with one addition: the refresh is wrapped in a
Postgres advisory lock and re-reads the row after acquiring it. MCP clients
issue tool calls concurrently, which the once-per-minute poller never does, so
without the lock this service could race itself and break the rotating refresh
chain.

Initial authorization is **not** available here. Only `auth/` can start a
chain, via its `/authorize` route.

## Required variables

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `${{token-store.DATABASE_URL}}` — the same row the other agents use |
| `CC_CLIENT_ID` | same as the other services |
| `CC_CLIENT_SECRET` | same as the other services |
| `MCP_SHARED_SECRET` | new random string, ≥24 chars — `openssl rand -hex 24` |
| `CONSTANT_CONTACT_BASE_URL` | optional; defaults to `https://api.cc.email/v3` |

Do **not** set `CC_ACCESS_TOKEN` here. The database row is the source of truth.

## Connecting from Claude

The endpoint is:

```
https://<this-service>.up.railway.app/mcp/<MCP_SHARED_SECRET>
```

In Claude: **Customize → Connectors → "+" → Add custom connector**, paste that
URL, click Add. Leave the OAuth fields in Advanced settings empty — this server
does not implement an OAuth flow.

### About the secret in the URL

Claude's custom-connector dialog accepts a URL but no static auth header, so the
secret rides in the path. That makes it a *capability URL*: anyone holding it
can read the account. It is stored by the client and can appear in logs and
proxies. Treat it like a password, don't paste it into shared docs, and rotate
it by changing `MCP_SHARED_SECRET` (which invalidates the old URL immediately).

A wrong or missing secret returns `404`, not `401`, so the endpoint does not
advertise itself to scanners.

If this ever needs to be shared with people rather than just you, replace the
path secret with a real OAuth flow and discovery metadata at
`/.well-known/oauth-authorization-server`.

## Tools

| Tool | Purpose |
| --- | --- |
| `cc_account_summary` | Account name, contact email, plan |
| `cc_list_contact_lists` | All lists with membership counts |
| `cc_list_campaigns` | Recent campaigns with ids and status |
| `cc_get_campaign` | One campaign, including its activity ids |
| `cc_get_campaign_activity` | Subject, from/reply-to, HTML content |
| `cc_campaign_stats` | Sends, opens, clicks, bounces, unsubscribes |

## Health

`GET /healthz` → `{"ok":true,"service":"mcp","readOnly":true}`
