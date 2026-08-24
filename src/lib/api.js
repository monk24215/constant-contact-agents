// api.js
// Thin wrapper over the Constant Contact v3 REST API. Every call goes through
// getValidAccessToken(), so callers never think about token lifecycle.
//
// Copy of composer/src/lib/api.js, with the write helpers (createEmailCampaign,
// sendTest) REMOVED on purpose. This service is read-only by construction:
// there is no code path here that can create, modify, or send a campaign, so a
// misbehaving MCP client cannot touch the live account. Campaign creation stays
// where the README puts it — in composer/, draft-only.
//
// Base URL: https://api.cc.email/v3

import { getValidAccessToken } from './oauth.js';

const API_BASE =
  process.env.CONSTANT_CONTACT_BASE_URL || 'https://api.cc.email/v3';

async function ccFetch(path, { query } = {}) {
  const token = await getValidAccessToken();
  let url = `${API_BASE}${path}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    url += `?${qs}`;
  }

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new Error(
      `CC API GET ${path} failed (${res.status}): ${JSON.stringify(data)}`
    );
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

// --- Reporting --------------------------------------------------------------
export function getCampaignStats(campaignActivityId) {
  return ccFetch('/reports/summary_reports/email_campaign_summaries', {
    query: { campaign_activity_id: campaignActivityId },
  });
}

export { ccFetch };
