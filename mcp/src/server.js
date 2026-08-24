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
//   - mcp/      (this) reads. It shares the token row and can refresh it, but
//               has no code path that writes to Constant Contact.

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
} from './lib/api.js';

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

  return server;
}

// --- HTTP -------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'mcp', writes: 'draft-only' });
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
  console.log(`[mcp] read-only Constant Contact MCP server on :${PORT}`);
});
