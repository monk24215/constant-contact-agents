// api.js
// Thin wrapper over the Constant Contact v3 REST API. Every call goes through
// getValidAccessToken(), so callers never think about token lifecycle.
//
// Copy of composer/src/lib/api.js, extended with the write helpers this service
// needs to create and edit campaigns from an MCP client.
//
// Deliberately NOT included: any call that sends to a live list or schedules a
// send. Creating and editing is reversible; sending 28,000 emails is not. Test
// sends to explicit addresses are allowed.
//
// ADDITION (daily-opens automation): per-contact tracking (opens/sends) and
// list-membership add/remove. These endpoints were not previously exercised
// by this service — verify field names/pagination shape against a real
// response before relying on them unattended.
//
// Base URL: https://api.cc.email/v3

import { getValidAccessToken } from './oauth.js';

const API_BASE =
  process.env.CONSTANT_CONTACT_BASE_URL || 'https://api.cc.email/v3';

async function ccFetch(path, { method = 'GET', body, query } = {}) {
  const token = await getValidAccessToken();
  let url = `${API_BASE}${path}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    url += `?${qs}`;
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new Error(
      `CC API ${method} ${path} failed (${res.status}): ${JSON.stringify(data)}`
    );
  }
  return data;
}

// Follow a Constant Contact "_links.next.href" pagination link. CC returns
// these as a path (e.g. "/v3/reports/...&cursor=..."), not a full URL, so
// this doesn't go through ccFetch's API_BASE-prepending logic.
async function ccFetchNext(nextHref) {
  const token = await getValidAccessToken();
  const url = nextHref.startsWith('http')
    ? nextHref
    : `https://api.cc.email${nextHref}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new Error(`CC API GET ${url} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// --- Account ----------------------------------------------------------------
export function getAccountSummary() {
  return ccFetch('/account/summary');
}

// --- Contact lists ----------------------------------------------------------
export function getContactLists() {
  return ccFetch('/contact_lists', { query: { include_count: 'true' } });
}

// --- Email campaigns --------------------------------------------------------
export function listCampaigns({ limit = 50 } = {}) {
  return ccFetch('/emails', { query: { limit: String(limit) } });
}

export function getCampaign(campaignId) {
  return ccFetch(`/emails/${campaignId}`);
}

export function getCampaignActivity(activityId) {
  return ccFetch(`/emails/activities/${activityId}`);
}

// --- Writes -----------------------------------------------------------------

// Create a campaign as a DRAFT. Returns the campaign plus its activity ids.
export function createEmailCampaign({
  name,
  subject,
  fromName,
  fromEmail,
  replyToEmail,
  htmlContent,
  physicalAddress,
  preheader,
}) {
  return ccFetch('/emails', {
    method: 'POST',
    body: {
      name,
      email_campaign_activities: [
        {
          format_type: 5, // v3 custom-code HTML format
          from_name: fromName,
          from_email: fromEmail,
          reply_to_email: replyToEmail || fromEmail,
          subject,
          ...(preheader ? { preheader } : {}),
          html_content: htmlContent,
          physical_address_in_footer: physicalAddress,
        },
      ],
    },
  });
}

// Update an existing activity. CC requires the FULL activity object on PUT, so
// this reads the current one and merges the provided fields over it — otherwise
// unspecified fields are silently wiped.
export async function updateCampaignActivity(activityId, changes) {
  const current = await getCampaignActivity(activityId);

  const merged = {
    format_type: current.format_type,
    from_name: changes.fromName ?? current.from_name,
    from_email: changes.fromEmail ?? current.from_email,
    reply_to_email: changes.replyToEmail ?? current.reply_to_email,
    subject: changes.subject ?? current.subject,
    html_content: changes.htmlContent ?? current.html_content,
    physical_address_in_footer: current.physical_address_in_footer,
    ...(current.preheader || changes.preheader
      ? { preheader: changes.preheader ?? current.preheader }
      : {}),
    ...(current.contact_list_ids
      ? { contact_list_ids: current.contact_list_ids }
      : {}),
  };

  return ccFetch(`/emails/activities/${activityId}`, {
    method: 'PUT',
    body: merged,
  });
}

export function renameCampaign(campaignId, name) {
  return ccFetch(`/emails/${campaignId}`, {
    method: 'PATCH',
    body: { name },
  });
}

export function createContactList({ name, description, favorite = false }) {
  return ccFetch('/contact_lists', {
    method: 'POST',
    body: { name, description: description || '', favorite },
  });
}

// Test send to explicit addresses. Does NOT touch live lists.
export function sendTest(activityId, emailAddresses) {
  return ccFetch(`/emails/activities/${activityId}/tests`, {
    method: 'POST',
    body: { email_addresses: emailAddresses },
  });
}

// --- Reporting --------------------------------------------------------------
export function getCampaignStats(campaignActivityId) {
  return ccFetch('/reports/summary_reports/email_campaign_summaries', {
    query: { campaign_activity_id: campaignActivityId },
  });
}

// --- Contact tracking (per-contact opens/sends) ------------------------------
//
// NOTE: not previously exercised by this service. Verify tracking_activities[]
// field names and the pagination link shape against a real response — adjust
// below if CC's actual payload differs from what's assumed here.

async function getTrackingContactIds(activityId, trackingActivityType) {
  const ids = new Set();
  let page = await ccFetch(`/reports/contact_tracking/activities/${activityId}`, {
    query: { tracking_activity_type: trackingActivityType, limit: '500' },
  });

  while (page) {
    for (const record of page.tracking_activities || []) {
      if (record.contact_id) ids.add(record.contact_id);
    }
    const next = page._links?.next?.href;
    page = next ? await ccFetchNext(next) : null;
  }
  return ids;
}

// Per-contact opens vs. sends for one campaign activity, resolved to unopens
// by set subtraction (sent minus opened).
export async function getActivityOpenBreakdown(activityId) {
  const [sent, opened] = await Promise.all([
    getTrackingContactIds(activityId, 'sends'),
    getTrackingContactIds(activityId, 'opens'),
  ]);
  const unopened = [...sent].filter((id) => !opened.has(id));
  return { opened: [...opened], unopened, sentCount: sent.size };
}

// --- List membership ---------------------------------------------------------

// Contacts currently in a list, by id. cc_list_contact_lists only returns a
// count, not member ids — this is what the daily clear step reads before
// removing membership.
export async function getContactsInList(listId) {
  const ids = [];
  let page = await ccFetch('/contacts', { query: { lists: listId, limit: '500' } });

  while (page) {
    for (const c of page.contacts || []) {
      if (c.contact_id) ids.push(c.contact_id);
    }
    const next = page._links?.next?.href;
    page = next ? await ccFetchNext(next) : null;
  }
  return ids;
}

// Add or remove specific contacts from a list. The one write here that
// touches list membership directly — always pass explicit contact ids,
// never "all contacts." action: 'add_list' | 'remove_list'.
export function updateListMembership(contactIds, listId, action) {
  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return Promise.resolve({ updated: 0, note: 'no contact ids provided' });
  }
  return ccFetch('/activities/contacts_list_membership', {
    method: 'POST',
    body: { source: { contact_ids: contactIds }, lists: [listId], action },
  });
}

export { ccFetch };
