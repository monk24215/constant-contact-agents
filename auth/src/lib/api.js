// api.js
// Thin wrapper over the Constant Contact v3 REST API. Every call goes through
// getValidAccessToken(), so callers never think about token lifecycle.
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

  // 204 / empty body
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new Error(
      `CC API ${method} ${path} failed (${res.status}): ${JSON.stringify(data)}`
    );
  }
  return data;
}

// --- Account / sanity check -------------------------------------------------
export function getAccountSummary() {
  return ccFetch('/account/summary');
}

// --- Contact lists ----------------------------------------------------------
export function getContactLists() {
  return ccFetch('/contact_lists', { query: { include_count: 'true' } });
}

// --- Email campaigns --------------------------------------------------------
// Create a campaign. Returns campaign + its primary_email activity id.
export function createEmailCampaign({ name, subject, fromName, fromEmail, replyToEmail, htmlContent, physicalAddress }) {
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
          html_content: htmlContent,
          physical_address_in_footer: physicalAddress,
        },
      ],
    },
  });
}

export function getCampaign(campaignId) {
  return ccFetch(`/emails/${campaignId}`);
}

export function getCampaignActivity(activityId) {
  return ccFetch(`/emails/activities/${activityId}`);
}

// Test send to specific addresses (does NOT touch live lists).
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

export { ccFetch };
