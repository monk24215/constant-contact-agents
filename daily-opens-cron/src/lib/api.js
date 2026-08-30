// api.js — trimmed Constant Contact v3 wrapper for the daily-opens-cron
// service. Only the calls this job actually needs; see mcp/src/lib/api.js
// for the full read+write surface used interactively.

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

export function listCampaigns({ limit = 50 } = {}) {
  return ccFetch('/emails', { query: { limit: String(limit) } });
}

export function getCampaign(campaignId) {
  return ccFetch(`/emails/${campaignId}`);
}

export function getContactLists() {
  return ccFetch('/contact_lists', { query: { include_count: 'true' } });
}

export function createContactList({ name, description, favorite = false }) {
  return ccFetch('/contact_lists', {
    method: 'POST',
    body: { name, description: description || '', favorite },
  });
}

// NOTE: not previously exercised by this repo — verify field names and the
// pagination link shape against a real response before trusting this
// unattended.
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

export async function getActivityOpenBreakdown(activityId) {
  const [sent, opened] = await Promise.all([
    getTrackingContactIds(activityId, 'sends'),
    getTrackingContactIds(activityId, 'opens'),
  ]);
  const unopened = [...sent].filter((id) => !opened.has(id));
  return { opened: [...opened], unopened, sentCount: sent.size };
}

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

export function updateListMembership(contactIds, listId, action) {
  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return Promise.resolve({ updated: 0, note: 'no contact ids provided' });
  }
  return ccFetch('/activities/contacts_list_membership', {
    method: 'POST',
    body: { source: { contact_ids: contactIds }, lists: [listId], action },
  });
}
