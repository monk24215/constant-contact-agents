// notion.js
// Minimal Notion API client for the composer. Reads the Email Campaign
// Calendar, and writes back campaign IDs / pipeline stage / notes.
//
// Uses the raw Notion REST API (v1) with the integration token in NOTION_TOKEN.
// We keep this dependency-free (global fetch) to stay simple to deploy.

const NOTION_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function token() {
  const t = process.env.NOTION_TOKEN;
  if (!t) throw new Error('NOTION_TOKEN is not set');
  return t;
}

function dbId() {
  const id = process.env.NOTION_DB_ID;
  if (!id) throw new Error('NOTION_DB_ID is not set');
  return id;
}

async function notionFetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(
      `Notion ${method} ${path} failed (${res.status}): ${JSON.stringify(data)}`
    );
  }
  return data;
}

// Read plain text out of a Notion rich_text / title property array.
function plain(prop) {
  if (!prop) return '';
  const arr = prop.title || prop.rich_text || [];
  return arr.map((t) => t.plain_text).join('');
}

function selectName(prop) {
  return prop && prop.select ? prop.select.name : null;
}

// Query campaigns ready to be drafted. Trigger: Status = "draft" AND a CC
// Campaign ID has not yet been written (so we don't re-draft the same row).
// Schema is the real "Email Campaign Tracker".
export async function getReadyRows() {
  const data = await notionFetch(`/databases/${dbId()}/query`, {
    method: 'POST',
    body: {
      filter: {
        and: [
          { property: 'Status', select: { equals: 'draft' } },
          { property: 'CC Campaign ID', rich_text: { is_empty: true } },
        ],
      },
    },
  });
  return (data.results || []).map((page) => ({
    id: page.id,
    url: page.url,
    subject: plain(page.properties['Subject Line']),   // title
    preheader: plain(page.properties['Preheader']),
    body: plain(page.properties['Body Copy']),
    from: page.properties['From'] ? page.properties['From'].email : null,
    category: selectName(page.properties['Category']),
    sendDate:
      page.properties['Send Date'] && page.properties['Send Date'].date
        ? page.properties['Send Date'].date.start
        : null,
  }));
}

// Backward-compat alias so worker.js keeps working.
export async function getRowsByStage() {
  return getReadyRows();
}

// Update a calendar row's properties.
export async function updateRow(pageId, props) {
  const properties = {};
  // Real tracker has no "Pipeline"; the composer records progress via CC IDs +
  // Agent Notes. Status stays "draft" (a draft now exists in CC) until the
  // human sends it and the reporter flips it to "sent".
  if (props.pipeline) {
    // no-op mapping retained for compatibility
  }
  if (props.ccCampaignId !== undefined)
    properties['CC Campaign ID'] = {
      rich_text: [{ text: { content: String(props.ccCampaignId) } }],
    };
  if (props.ccActivityId !== undefined)
    properties['CC Activity ID'] = {
      rich_text: [{ text: { content: String(props.ccActivityId) } }],
    };
  if (props.ccLink !== undefined)
    properties['CC Link'] = { url: props.ccLink || null };
  if (props.notes !== undefined)
    properties['Agent Notes'] = {
      rich_text: [{ text: { content: String(props.notes).slice(0, 1900) } }],
    };
  if (props.opens !== undefined) properties['Opens'] = { number: props.opens };
  if (props.clicks !== undefined) properties['Clicks'] = { number: props.clicks };

  return notionFetch(`/pages/${pageId}`, {
    method: 'PATCH',
    body: { properties },
  });
}
