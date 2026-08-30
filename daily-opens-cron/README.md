# daily-opens-cron

Scheduled companion to the `mcp` service. Every 5 minutes (Railway cron, UTC),
checks the current time in `America/Chicago` and, if it matches a target,
acts:

- **18:25** — finds the last-sent campaign, splits its contacts into opened /
  unopened, and adds them to the `dailyOpensDaily` / `dailyUnopensDaily`
  contact lists (created automatically on first run if missing).
- **05:00** — reads current membership of both lists and removes everyone,
  resetting them for the next day.

Any other 5-minute tick is a silent no-op — this keeps the cron schedule
fixed year-round (`*/5 * * * *`) instead of a UTC cron expression that would
drift an hour during the CST/CDT changeover.

## Required environment variables

| Var | Source |
|---|---|
| `DATABASE_URL` | `${{token-store.DATABASE_URL}}` — same OAuth token row as every other agent |
| `CC_CLIENT_ID` | `${{mcp.CC_CLIENT_ID}}` |
| `CC_CLIENT_SECRET` | `${{mcp.CC_CLIENT_SECRET}}` |
| `OPENS_LIST_NAME` | optional, defaults to `dailyOpensDaily` |
| `UNOPENS_LIST_NAME` | optional, defaults to `dailyUnopensDaily` |

## Before trusting this unattended

This is the first thing in the repo to call Constant Contact's contact-
tracking (`/reports/contact_tracking/activities/{id}`) and list-membership
(`/activities/contacts_list_membership`) endpoints. The original 10 tools
never touched them, so the field names and pagination shape assumed in
`src/lib/api.js` are based on CC's public v3 docs, not a verified live
response from this account. Before letting it run unattended:

1. Call `cc_get_activity_opens` (now on the `mcp` server) against a real,
   already-sent campaign activity and confirm the response looks sane
   (`opened`/`unopened` counts should roughly match `cc_campaign_stats`'
   aggregate open count).
2. Call `cc_get_list_members` on a test list to confirm `getContactsInList`
   pagination works.
3. Try one `cc_update_list_membership` call with a single contact id against
   a throwaway list before the cron does it at scale.
4. Check the `current_status`/`status` field name assumption in
   `getLastSentCampaign` (src/index.js) against an actual `cc_list_campaigns`
   response — adjust if the real field/value differs.

## Manual run

```bash
DATABASE_URL=... CC_CLIENT_ID=... CC_CLIENT_SECRET=... node src/index.js
```

Outside the two target minutes this just logs and exits — safe to run
anytime to sanity-check deploy/env wiring.
