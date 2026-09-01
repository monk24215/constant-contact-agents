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
// ADDITION (2026-09-01): background clear-list job (list-membership removal
// only — see caveat below). getContactsInList() pages sequentially through
// /contacts (500/page) and updateListMembership() posts the full id array in
// one call — fine up to the ~30k scale daily-opens-cron exercises, but a
// 271k-member list takes minutes just to page through, which blows the MCP
// client's 60s per-tool-call timeout. startClearList() runs the same
// fetch-then-remove sequence in the background (fire-and-forget from the
// request handler) so the MCP tool call returns immediately; progress is
// tracked in-memory and polled via cc_clear_list_status. In-memory job state
// does not survive a redeploy or restart of this service — don't redeploy
// mid-job. ccFetch/ccFetchNext also got a per-request timeout + one retry
// here, plus page-level progress tracking, after a run stalled silently for
// 10+ minutes with no error and no visible progress.
//
// CAVEAT: list-membership removal (the above) does NOT reduce an account's
// billable/active contact count — CC bills on contacts existing in the
// account, not on list membership. Removing someone from every list they're
// on still leaves them counted. See contact deletion below for what
// actually reduces the bill.
//
// ADDITION (2026-09-01, later same day): bulk contact deletion. CC's
// /activities/contact_delete endpoint accepts a `list_ids` array directly
// (up to 50 lists) and deletes every contact on those lists server-side —
// no need to enumerate contact ids ourselves at all, unlike list-membership
// removal. Per CC's docs, deleted contacts do not count against the
// account's active-contact total, and are recoverable only by re-adding
// them to a list (not a permanent hard-delete, but not a casual one
// either — treat as irreversible for practical purposes). Processes
// asynchronously on CC's side; submitting returns an activity id, polled
// via GET /activities/{activity_id}.
//
// Base URL: https://api.cc.email/v3

import { getValidAccessToken } from './oauth.js';

const API_BASE =
  process.env.CONSTANT_CONTACT_BASE_URL || 'https://api.cc.email/v3';

const REQUEST_TIMEOUT_MS = 20_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// One retry on timeout/network error only (not on a real HTTP error response,
// which is handled by the caller). Keeps a single hung/dropped connection
// from stalling a multi-hundred-page pagination loop indefinitely.
async function fetchWithRetry(url, options) {
  try {
    return await fetchWithTimeout(url, options);
  } catch (err) {
    console.warn(`[cc-api] request failed (${err.message}), retrying once: ${url}`);
    await sleep(1000);
    return fetchWithTimeout(url, options);
  }
}

async function ccFetch(path, { method = 'GET', body, query } = {}) {
  const token = await getValidAccessToken();
  let url = `${API_BASE}${path}`;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    url += `?${qs}`;
  }

  const res = await fetchWithRetry(url, {
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

  const res = await fetchWithRetry(url, {
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
// removing membership. onPage(fetchedSoFar, pageCount), if given, fires after
// each page so a caller can surface progress.
export async function getContactsInList(listId, onPage) {
  const ids = [];
  let page = await ccFetch('/contacts', { query: { lists: listId, limit: '500' } });
  let pageCount = 0;

  while (page) {
    for (const c of page.contacts || []) {
      if (c.contact_id) ids.push(c.contact_id);
    }
    pageCount += 1;
    if (onPage) onPage(ids.length, pageCount);
    const next = page._links?.next?.href;
    page = next ? await ccFetchNext(next) : null;
  }
  return ids;
}

// Add or remove specific contacts from a list. The one write here that
// touches list membership directly — always pass explicit contact ids,
// never "all contacts." action: 'add_list' | 'remove_list'. NOTE: removing
// a contact from every list they're on does NOT reduce the account's
// billable contact count — see deleteContactsByList below for that.
export function updateListMembership(contactIds, listId, action) {
  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return Promise.resolve({ updated: 0, note: 'no contact ids provided' });
  }
  return ccFetch('/activities/contacts_list_membership', {
    method: 'POST',
    body: { source: { contact_ids: contactIds }, lists: [listId], action },
  });
}

// --- Background clear-list job (list-membership removal) ---------------------
//
// Removes ALL current members of a list from that list (membership only —
// contacts themselves are not deleted from the account, and this does NOT
// reduce billable contact count). Built for lists too large to fetch-and-
// remove inside a single 60s MCP tool call. Runs fire-and-forget in this
// process; state lives in memory only (lost on redeploy/restart) and is
// keyed by listId, so only one job per list runs at a time.

const CLEAR_BATCH_SIZE = 5000;
const clearJobs = new Map(); // listId -> job state

export function getClearJobStatus(listId) {
  return clearJobs.get(listId) || { status: 'not_found' };
}

export function startClearList(listId) {
  const existing = clearJobs.get(listId);
  if (existing && existing.status === 'running') {
    return { alreadyRunning: true, ...existing };
  }

  const job = {
    status: 'running',
    phase: 'fetching_members',
    fetchedSoFar: 0,
    pagesSoFar: 0,
    totalMembers: null,
    removed: 0,
    batches: null,
    batchesDone: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  };
  clearJobs.set(listId, job);

  (async () => {
    try {
      console.log(`[clear-list] ${listId}: fetching member ids...`);
      const ids = await getContactsInList(listId, (fetchedSoFar, pagesSoFar) => {
        job.fetchedSoFar = fetchedSoFar;
        job.pagesSoFar = pagesSoFar;
        job.updatedAt = new Date().toISOString();
        if (pagesSoFar % 10 === 0) {
          console.log(`[clear-list] ${listId}: fetch progress — page ${pagesSoFar}, ${fetchedSoFar} ids so far`);
        }
      });
      job.totalMembers = ids.length;
      job.batches = Math.ceil(ids.length / CLEAR_BATCH_SIZE) || 0;
      job.phase = 'removing';
      job.updatedAt = new Date().toISOString();
      console.log(`[clear-list] ${listId}: fetched ${ids.length} member ids across ${job.pagesSoFar} pages, removing in ${job.batches} batch(es) of ${CLEAR_BATCH_SIZE}`);

      for (let i = 0; i < ids.length; i += CLEAR_BATCH_SIZE) {
        const batch = ids.slice(i, i + CLEAR_BATCH_SIZE);
        await updateListMembership(batch, listId, 'remove_list');
        job.removed += batch.length;
        job.batchesDone += 1;
        job.updatedAt = new Date().toISOString();
        console.log(`[clear-list] ${listId}: batch ${job.batchesDone}/${job.batches} done, removed ${job.removed}/${job.totalMembers}`);
      }

      job.status = 'done';
      job.phase = 'complete';
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      console.log(`[clear-list] ${listId}: DONE. removed ${job.removed} of ${job.totalMembers}`);
    } catch (err) {
      job.status = 'error';
      job.error = err.message;
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      console.error(`[clear-list] ${listId}: FAILED after removing ${job.removed}`, err);
    }
  })();

  return { started: true, ...job };
}

// --- Bulk contact deletion (actually reduces billable contact count) --------
//
// CC's /activities/contact_delete accepts list_ids directly (up to 50 lists)
// — it deletes every contact on those lists server-side, so unlike the
// clear-list job above, we don't enumerate contact ids ourselves at all.
// Processes asynchronously on CC's side: submitting returns an activity id,
// which is polled via GET /activities/{activity_id}. Per CC's docs, deleted
// contacts don't count against the account's active-contact total, and are
// recoverable only by re-adding them to a list — not a hard permanent
// purge, but treat as irreversible for practical purposes.

const deleteJobs = new Map(); // listId -> job state

function extractActivityId(res) {
  if (res?.activity_id) return res.activity_id;
  const href = res?._links?.self?.href;
  if (href) return href.split('/').filter(Boolean).pop();
  return null;
}

export async function startDeleteContactsByList(listId) {
  const res = await ccFetch('/activities/contact_delete', {
    method: 'POST',
    body: { list_ids: [listId] },
  });
  const activityId = extractActivityId(res);
  const job = {
    listId,
    activityId,
    submittedAt: new Date().toISOString(),
    lastStatus: null,
    lastCheckedAt: null,
    lastRaw: res,
  };
  deleteJobs.set(listId, job);
  console.log(`[delete-list] ${listId}: submitted bulk delete, activity_id=${activityId}`);
  return { submitted: true, ...job };
}

export async function getDeleteJobStatus(listId) {
  const job = deleteJobs.get(listId);
  if (!job) return { status: 'not_found' };
  if (!job.activityId) return { status: 'unknown_activity_id', ...job };
  const activity = await ccFetch(`/activities/${job.activityId}`);
  job.lastStatus = activity?.status || activity?.state || JSON.stringify(activity);
  job.lastCheckedAt = new Date().toISOString();
  job.lastRaw = activity;
  console.log(`[delete-list] ${listId}: activity ${job.activityId} status=${job.lastStatus}`);
  return { ...job, activity };
}

export { ccFetch };
