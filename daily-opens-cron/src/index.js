// daily-opens-cron/src/index.js
//
// Scheduled job (Railway cron, every 5 minutes, UTC) that snapshots and
// clears two scratch lists based on the most recently SENT campaign:
//
//   18:25 America/Chicago  -> snapshot: split contacts into
//                             dailyOpensDaily / dailyUnopensDaily
//   05:00 America/Chicago  -> clear: empty both lists back out
//
// Runs as a short-lived process: check the local time first, act only if it
// matches one of the two targets, then exit. This avoids the CST/CDT cron-
// drift bug a fixed UTC cron expression would have (America/Chicago's UTC
// offset changes twice a year; Railway's cron field is UTC-only).
//
// This is new ground for this repo — the contact-tracking and list-membership
// endpoints it depends on were never exercised by the original 10 tools.
// Smoke-test before trusting it unattended; see README.md in this folder.

import { DateTime } from 'luxon';
import {
  listCampaigns,
  getCampaign,
  getContactLists,
  createContactList,
  getActivityOpenBreakdown,
  getContactsInList,
  updateListMembership,
} from './lib/api.js';

const SNAPSHOT_TIME = '18:25';
const CLEAR_TIME = '05:00';
const OPENS_LIST_NAME = process.env.OPENS_LIST_NAME || 'dailyOpensDaily';
const UNOPENS_LIST_NAME = process.env.UNOPENS_LIST_NAME || 'dailyUnopensDaily';

async function getOrCreateList(name) {
  const { lists } = await getContactLists();
  const existing = (lists || []).find((l) => l.name === name);
  if (existing) return existing;
  return createContactList({
    name,
    description: 'Daily open/unopen check log — auto-managed by daily-opens-cron.',
  });
}

// Newest campaign with a "sent" status. NOTE: verify the exact status field
// name/value ("current_status" vs "status", "SENT" vs "DONE") against a real
// cc_list_campaigns response for this account and adjust the filter below if
// it differs.
async function getLastSentCampaign() {
  const { campaigns } = await listCampaigns({ limit: 50 });
  const sent = (campaigns || [])
    .filter((c) => {
      const status = c.current_status || c.status;
      return status === 'SENT' || status === 'DONE';
    })
    .sort(
      (a, b) =>
        new Date(b.updated_at || b.sent_date || 0) -
        new Date(a.updated_at || a.sent_date || 0)
    );
  if (!sent.length) throw new Error('No sent campaigns found.');
  return sent[0];
}

async function resolveActivityId(campaign) {
  const inline = campaign.campaign_activities?.[0]?.campaign_activity_id;
  if (inline) return inline;
  const full = await getCampaign(campaign.campaign_id);
  const id = full.campaign_activities?.[0]?.campaign_activity_id;
  if (!id) throw new Error(`Could not resolve activity id for campaign ${campaign.campaign_id}`);
  return id;
}

async function runSnapshot() {
  const campaign = await getLastSentCampaign();
  const activityId = await resolveActivityId(campaign);

  const { opened, unopened, sentCount } = await getActivityOpenBreakdown(activityId);
  const opensList = await getOrCreateList(OPENS_LIST_NAME);
  const unopensList = await getOrCreateList(UNOPENS_LIST_NAME);

  if (opened.length) await updateListMembership(opened, opensList.list_id, 'add_list');
  if (unopened.length) await updateListMembership(unopened, unopensList.list_id, 'add_list');

  console.log(
    `[daily-opens] snapshot: campaign="${campaign.name}" sent=${sentCount} ` +
      `opened=${opened.length} unopened=${unopened.length}`
  );
}

async function runClear() {
  const opensList = await getOrCreateList(OPENS_LIST_NAME);
  const unopensList = await getOrCreateList(UNOPENS_LIST_NAME);

  const opensMembers = await getContactsInList(opensList.list_id);
  const unopensMembers = await getContactsInList(unopensList.list_id);

  if (opensMembers.length) await updateListMembership(opensMembers, opensList.list_id, 'remove_list');
  if (unopensMembers.length) await updateListMembership(unopensMembers, unopensList.list_id, 'remove_list');

  console.log(
    `[daily-opens] clear: removed ${opensMembers.length} from opens, ` +
      `${unopensMembers.length} from unopens`
  );
}

async function main() {
  const now = DateTime.now().setZone('America/Chicago');
  const hm = now.toFormat('HH:mm');

  if (hm === SNAPSHOT_TIME) {
    await runSnapshot();
  } else if (hm === CLEAR_TIME) {
    await runClear();
  } else {
    console.log(`[daily-opens] ${hm} America/Chicago — no action scheduled, exiting.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[daily-opens] job failed:', err);
    process.exit(1);
  });
