// server.js
// A read-only MCP server over the Constant Contact account, so Claude can query
// lists, campaigns, and reports directly instead of going through a connector
// whose OAuth grant expires independently of this project's tokens.
//
// Transport: Streamable HTTP, stateless (a fresh transport per request). No
// session store, so Railway can restart or scale this service freely.
//
// Relationship to the other agents:
//   - auth/     owns initial authorization and the oauth_tokens table.
//   - composer/ owns campaign creation (draft-only).
//   - mcp/      (this) reads, plus a small set of reversible writes (draft
//               edits, empty-list creation, test sends, and — as of the
//               daily-opens automation — explicit-id list membership changes
//               used by the daily-opens-cron service).
//
// NOTE: cc_clear_list_start/cc_clear_list_status run a background job in
// this process (see startClearList in lib/api.js) — job state is in-memory
// only and does not survive a redeploy/restart of this service. Same for
// cc_delete_contacts_by_list_start/status (real deletion — see below).
//
// NOTE (2026-09-01): the MCP client's tool list can lag a redeploy (its
// tools/list cache doesn't always refresh promptly), so cc_update_list_membership
// also accepts magic single-element contactIds sentinels that route to the
// same jobs without needing a new tool schema to be discovered:
//   contactIds: ["__cc_clear_list_start__"]    -> startClearList(listId)
//   contactIds: ["__cc_clear_list_status__"]   -> getClearJobStatus(listId)
//   contactIds: ["__cc_delete_list_start__"]   -> startDeleteContactsByList(listId)
//   contactIds: ["__cc_delete_list_status__"]  -> getDeleteJobStatus(listId)
// (action is ignored for all four; pass 'remove_list' by convention.)
//
// IMPORTANT: list-membership removal (clear-list) does NOT reduce the
// account's billable contact count. Contact deletion (delete-list) does.
// They are different operations — don't conflate them.

import express from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import {
  getContactLists,
  listCampaigns,
  getCampaign,
  getCampaignActivity,
  getCampaignStats,
  createEmailCampaign,
  updateCampaignActivity,
  renameCampaign,
  createContactList,
  sendTest,
  getActivityOpenBreakdown,
  getContactsInList,
  updateListMembership,
  startClearList,
  getClearJobStatus,
  startDeleteContactsByList,
  getDeleteJobStatus,
} from './lib/api.js';

const CLEAR_START_SENTINEL = '__cc_clear_list_start__';
const CLEAR_STATUS_SENTINEL = '__cc_clear_list_status__';
const DELETE_START_SENTINEL = '__cc_delete_list_start__';
const DELETE_STATUS_SENTINEL = '__cc_delete_list_status__';

// Footer address is legally required on every CC campaign. Read from the same
// CC_ADDR_* variables the composer uses.
function physicalAddress() {
  return {
    address_line1: process.env.CC_ADDR_LINE1,
    city: process.env.CC_ADDR_CITY,
    state_code: process.env.CC_ADDR_STATE,
    postal_code: process.env.CC_ADDR_POSTAL,
    country_code: process.env.CC_ADDR_COUNTRY || 'US',
    organization_name: process.env.CC_ADDR_ORG,
  };
}

const PORT = process.env.PORT || 3000;

// The MCP endpoint lives at /mcp/<MCP_SHARED_SECRET>. Claude's custom-connector
// dialog takes a URL but no static header, so the secret rides in the path.
// This is a capability URL: treat it like a password. It is stored by the
// client and may appear in logs, so rotate it by changing the env var.
const SHARED_SECRET = process.env.MCP_SHARED_SECRET;
if (!SHARED_SECRET || SHARED_SECRET.length < 24) {
  throw new Error(
    'MCP_SHARED_SECRET must be set to a random string of at least 24 chars. ' +
      'Generate one with: openssl rand -hex 24'
  );
}

function secretMatches(candidate) {
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(SHARED_SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// --- Tool wiring ------------------------------------------------------------

function asJson(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function asError(err) {
  return {
    isError: true,
    content: [{ type: 'text', text: `Constant Contact error: ${err.message}` }],
  };
}

async function run(fn) {
  try {
    return asJson(await fn());
  } catch (err) {
    return asError(err);
  }
}

function buildServer() {
  const server = new McpServer({ name: 'constant-contact', version: '1.0.0' });

  server.registerTool(
    'cc_list_contact_lists',
    {
      title: 'List contact lists',
      description:
        'All contact lists with membership counts. Use to find a list id.',
      inputSchema: {},
    },
    () => run(() => getContactLists())
  );

  server.registerTool(
    'cc_list_campaigns',
    {
      title: 'List email campaigns',
      description: 'Recent email campaigns with their ids, names, and status.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Max campaigns to return (default 50).'),
      },
    },
    ({ limit }) => run(() => listCampaigns({ limit: limit ?? 50 }))
  );

  server.registerTool(
    'cc_get_campaign',
    {
      title: 'Get campaign',
      description:
        'One email campaign by id, including its activity ids. Activity ids are what stats and previews key off.',
      inputSchema: {
        campaignId: z.string().describe('The campaign id (UUID).'),
      },
    },
    ({ campaignId }) => run(() => getCampaign(campaignId))
  );

  server.registerTool(
    'cc_get_campaign_activity',
    {
      title: 'Get campaign activity',
      description:
        'One campaign activity by id: subject, from/reply-to, and HTML content.',
      inputSchema: {
        activityId: z.string().describe('The campaign activity id (UUID).'),
      },
    },
    ({ activityId }) => run(() => getCampaignActivity(activityId))
  );

  server.registerTool(
    'cc_campaign_stats',
    {
      title: 'Campaign stats',
      description:
        'Summary report for a campaign activity: sends, opens, clicks, bounces, unsubscribes.',
      inputSchema: {
        campaignActivityId: z
          .string()
          .describe('The campaign activity id (UUID).'),
      },
    },
    ({ campaignActivityId }) => run(() => getCampaignStats(campaignActivityId))
  );

  server.registerTool(
    'cc_get_activity_opens',
    {
      title: 'Get per-contact opens/unopens',
      description:
        'Per-contact opens and unopens for a campaign activity (not just aggregate counts). Splits the send list into opened vs. unopened contact ids.',
      inputSchema: {
        activityId: z.string().describe('The campaign activity id (UUID).'),
      },
    },
    ({ activityId }) => run(() => getActivityOpenBreakdown(activityId))
  );

  server.registerTool(
    'cc_get_list_members',
    {
      title: 'Get list members',
      description:
        'Contact ids currently in a given list. Pages through the full list synchronously — for very large lists (tens of thousands+) this can exceed a single tool call\'s time budget; use cc_clear_list_start (membership only) or cc_delete_contacts_by_list_start (actual deletion) instead if the goal is to empty the list.',
      inputSchema: {
        listId: z.string().describe('The contact list id.'),
      },
    },
    ({ listId }) => run(() => getContactsInList(listId))
  );

  // --- Writes ---------------------------------------------------------------

  server.registerTool(
    'cc_create_campaign',
    {
      title: 'Create campaign (draft)',
      description:
        'Create a new email campaign as a DRAFT. Never sends. Returns the campaign id and its activity id, which is what editing and test sends key off.',
      inputSchema: {
        name: z
          .string()
          .describe('Internal campaign name. Must be unique in the account.'),
        subject: z.string().describe('Subject line.'),
        htmlContent: z
          .string()
          .describe('Full HTML body. CC custom-code format.'),
        fromName: z.string().optional().describe('Defaults to CC_FROM_NAME.'),
        fromEmail: z
          .string()
          .optional()
          .describe('Must be a verified sender. Defaults to CC_FROM_EMAIL.'),
        replyToEmail: z.string().optional().describe('Defaults to CC_REPLY_TO.'),
        preheader: z.string().optional().describe('Preview text.'),
      },
    },
    (a) =>
      run(() =>
        createEmailCampaign({
          name: a.name,
          subject: a.subject,
          htmlContent: a.htmlContent,
          preheader: a.preheader,
          fromName: a.fromName || process.env.CC_FROM_NAME,
          fromEmail: a.fromEmail || process.env.CC_FROM_EMAIL,
          replyToEmail:
            a.replyToEmail || process.env.CC_REPLY_TO || process.env.CC_FROM_EMAIL,
          physicalAddress: physicalAddress(),
        })
      )
  );

  server.registerTool(
    'cc_update_campaign_activity',
    {
      title: 'Edit campaign content',
      description:
        'Edit subject, HTML, sender, or preheader on an existing campaign activity. Only works while the campaign is a draft. Unspecified fields are preserved.',
      inputSchema: {
        activityId: z.string().describe('The campaign activity id (UUID).'),
        subject: z.string().optional(),
        htmlContent: z.string().optional(),
        preheader: z.string().optional(),
        fromName: z.string().optional(),
        fromEmail: z.string().optional(),
        replyToEmail: z.string().optional(),
      },
    },
    ({ activityId, ...changes }) =>
      run(() => updateCampaignActivity(activityId, changes))
  );

  server.registerTool(
    'cc_rename_campaign',
    {
      title: 'Rename campaign',
      description: 'Change a campaign internal name.',
      inputSchema: {
        campaignId: z.string().describe('The campaign id (UUID).'),
        name: z.string().describe('New name. Must be unique in the account.'),
      },
    },
    ({ campaignId, name }) => run(() => renameCampaign(campaignId, name))
  );

  server.registerTool(
    'cc_create_list',
    {
      title: 'Create contact list',
      description: 'Create a new, empty contact list.',
      inputSchema: {
        name: z.string().describe('List name.'),
        description: z.string().optional(),
        favorite: z.boolean().optional(),
      },
    },
    (a) => run(() => createContactList(a))
  );

  server.registerTool(
    'cc_send_test',
    {
      title: 'Send test email',
      description:
        'Send a test of a campaign activity to explicit addresses. Does NOT touch live contact lists.',
      inputSchema: {
        activityId: z.string().describe('The campaign activity id (UUID).'),
        emailAddresses: z
          .array(z.string())
          .min(1)
          .max(5)
          .describe('Recipient addresses for the test.'),
      },
    },
    ({ activityId, emailAddresses }) =>
      run(() => sendTest(activityId, emailAddresses))
  );

  server.registerTool(
    'cc_update_list_membership',
    {
      title: 'Add/remove contacts from a list',
      description:
        "Add or remove specific contacts from a list, by explicit contact id. Never pass 'all contacts', always an explicit id array. Used by the daily-opens-cron service, but callable directly too. This does NOT delete contacts or reduce billable contact count — it only changes which list(s) a contact is on. For that, or to clear/delete an entire large list without fetching every id yourself, pass one of these single-element sentinel values as contactIds: [\"__cc_clear_list_start__\"] / [\"__cc_clear_list_status__\"] (membership removal only) or [\"__cc_delete_list_start__\"] / [\"__cc_delete_list_status__\"] (actual deletion — reduces billable count). action is ignored for sentinel calls.",
      inputSchema: {
        contactIds: z
          .array(z.string())
          .min(1)
          .describe('Contact ids to add or remove.'),
        listId: z.string().describe('The contact list id.'),
        action: z.enum(['add_list', 'remove_list']),
      },
    },
    ({ contactIds, listId, action }) => {
      if (contactIds.length === 1 && contactIds[0] === CLEAR_START_SENTINEL) {
        return run(() => startClearList(listId));
      }
      if (contactIds.length === 1 && contactIds[0] === CLEAR_STATUS_SENTINEL) {
        return run(() => getClearJobStatus(listId));
      }
      if (contactIds.length === 1 && contactIds[0] === DELETE_START_SENTINEL) {
        return run(() => startDeleteContactsByList(listId));
      }
      if (contactIds.length === 1 && contactIds[0] === DELETE_STATUS_SENTINEL) {
        return run(() => getDeleteJobStatus(listId));
      }
      return run(() => updateListMembership(contactIds, listId, action));
    }
  );

  server.registerTool(
    'cc_clear_list_start',
    {
      title: 'Clear a list (background job, membership only)',
      description:
        'Removes ALL current members from a list — list membership only. Contacts are NOT deleted from the account, stay on any other lists they belong to, and continue counting against the account\'s billable contact total. For actually reducing contact count, use cc_delete_contacts_by_list_start instead. Built for lists too large to fetch-and-remove within one tool call. Starts a background job and returns immediately; poll with cc_clear_list_status using the same listId. Job state is in-memory only — lost if this service redeploys or restarts mid-job.',
      inputSchema: {
        listId: z.string().describe('The contact list id to clear.'),
      },
    },
    ({ listId }) => run(() => startClearList(listId))
  );

  server.registerTool(
    'cc_clear_list_status',
    {
      title: 'Check clear-list (membership) job status',
      description:
        'Status of a background cc_clear_list_start job: phase (fetching_members/removing/complete), totalMembers, removed so far, batch progress, and any error. Returns {status: "not_found"} if no job has been started for this listId (or the service restarted since).',
      inputSchema: {
        listId: z.string().describe('The contact list id.'),
      },
    },
    ({ listId }) => run(() => getClearJobStatus(listId))
  );

  server.registerTool(
    'cc_delete_contacts_by_list_start',
    {
      title: 'Delete every contact on a list (reduces billable count)',
      description:
        'Permanently deletes every contact on a list from the account entirely — not just list membership. This is what actually reduces the number of contacts you\'re billed for. Per Constant Contact, deleted contacts do not count against the active-contact total and are recoverable only by re-adding them to a list — treat as irreversible in practice. Submits CC\'s bulk contact_delete activity by list id (no need to fetch member ids yourself) and returns immediately with an activity id; CC processes it asynchronously. Poll with cc_delete_contacts_by_list_status using the same listId.',
      inputSchema: {
        listId: z.string().describe('The contact list id whose members should be permanently deleted.'),
      },
    },
    ({ listId }) => run(() => startDeleteContactsByList(listId))
  );

  server.registerTool(
    'cc_delete_contacts_by_list_status',
    {
      title: 'Check bulk contact-deletion status',
      description:
        'Status of a cc_delete_contacts_by_list_start job for a list, including Constant Contact\'s own activity status for the submitted delete. Returns {status: "not_found"} if no delete has been started for this listId (or the service restarted since).',
      inputSchema: {
        listId: z.string().describe('The contact list id.'),
      },
    },
    ({ listId }) => run(() => getDeleteJobStatus(listId))
  );

  return server;
}

// --- HTTP -------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'mcp', writes: 'draft-only + explicit-id list membership + background list-clear + bulk contact deletion' });
});

app.post('/mcp/:secret', async (req, res) => {
  if (!secretMatches(req.params.secret)) {
    return res.status(404).json({ error: 'not found' });
  }

  // Stateless: one server + transport per request, torn down on close.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// Stateless mode has no server-initiated stream and nothing to delete.
app.all('/mcp/:secret', (_req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Use POST.' },
    id: null,
  });
});

app.listen(PORT, () => {
  console.log(`[mcp] Constant Contact MCP server on :${PORT}`);
});
