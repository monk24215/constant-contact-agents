// worker.js
// The composer's one job: find campaigns with Status="draft" (no CC id yet), create a
// draft email campaign in Constant Contact, write the campaign id + link back
// to Notion, and advance the row to "Drafted in CC".
//
// Idempotent: only acts on rows with no CC Campaign ID yet, and writes the id back
// stage immediately, so re-runs don't double-create.

import { getRowsByStage, updateRow } from './lib/notion.js';
import { createEmailCampaign, getValidAccessToken } from './lib/index.js';
import { renderEmailHtml } from './lib/template.js';

function physicalAddress() {
  // CAN-SPAM: CC requires a footer address. Pull from env.
  return {
    address_line1: process.env.CC_ADDR_LINE1 || '',
    city: process.env.CC_ADDR_CITY || '',
    state_code: process.env.CC_ADDR_STATE || '',
    postal_code: process.env.CC_ADDR_POSTAL || '',
    country_code: process.env.CC_ADDR_COUNTRY || 'US',
    organization_name: process.env.BRAND_NAME || process.env.CC_ADDR_ORG || '',
  };
}

function senderConfig() {
  const fromEmail = process.env.CC_FROM_EMAIL;
  const fromName = process.env.CC_FROM_NAME || process.env.BRAND_NAME || 'Newsletter';
  if (!fromEmail) {
    throw new Error(
      'CC_FROM_EMAIL is not set. Set it to a VERIFIED sender email in your ' +
        'Constant Contact account, or CC will reject the draft.'
    );
  }
  return { fromEmail, fromName, replyTo: process.env.CC_REPLY_TO || fromEmail };
}

// Process a single row.
async function composeOne(row) {
  const { fromEmail, fromName, replyTo } = senderConfig();
  // FIX #5: don't create empty drafts. A row needs actual body copy.
  if (!row.body || !row.body.trim()) {
    await updateRow(row.id, {
      notes: 'Skipped: Body Copy is empty. Content agent must fill Body Copy.',
    });
    return { rowId: row.id, skipped: 'empty body' };
  }
  const subject = row.subject || 'Newsletter';
  const html = renderEmailHtml({ subject, body: row.body || '', preheader: row.preheader || '' });

  // CC campaign names must be unique; suffix with a timestamp.
  const uniqueName = `${subject} [${new Date().toISOString().slice(0, 16)}]`;

  const created = await createEmailCampaign({
    name: uniqueName,
    subject,
    fromName,
    fromEmail,
    replyToEmail: replyTo,
    htmlContent: html,
    physicalAddress: physicalAddress(),
  });

  // Extract ids from the CC response shape.
  // FIX #1: CC always returns campaign_id on create (never .id).
  const campaignId = created.campaign_id || null;
  // Per CC v3 docs, create returns campaign_activities[] with role primary_email.
  const activity =
    (created.campaign_activities || []).find((a) => a.role === 'primary_email') ||
    (created.campaign_activities || [])[0];
  const activityId = activity ? activity.campaign_activity_id : null;
  // FIX #2: do not fabricate a dashboard URL (not a stable/documented link).
  // Store the campaign_id; the draft is findable in the CC dashboard by name/id.
  const ccLink = campaignId
    ? `https://app.constantcontact.com/pages/dashboard/home/#/campaigns`
    : null;

  await updateRow(row.id, {
    ccCampaignId: campaignId || '',
    ccActivityId: activityId || '',
    ccLink,
    notes: `Draft created in Constant Contact ${new Date().toISOString()}. Review and send from CC.`,
  });

  return { rowId: row.id, campaignId, activityId };
}

// HARD SAFETY WALL: this service creates DRAFTS ONLY. It imports no send or
// schedule function, and this guard enforces that intent. Sending/scheduling
// lives in a separate, human-gated service that does not exist yet.
const DRAFT_ONLY = true;

export async function runComposer() {
  if (!DRAFT_ONLY) {
    throw new Error('Composer is draft-only and must never send or schedule.');
  }
  // Fail fast with a clear message if config is missing.
  senderConfig();
  await getValidAccessToken(); // verifies token chain is alive

  const rows = await getRowsByStage();
  const results = { processed: 0, errors: [], drafts: [] };

  for (const row of rows) {
    try {
      const r = await composeOne(row);
      if (r.skipped) {
        console.log(`[composer] skipped "${row.subject}": ${r.skipped}`);
      } else {
        results.processed++;
        results.drafts.push(r);
        console.log(`[composer] drafted "${row.subject}" -> campaign ${r.campaignId}`);
      }
    } catch (e) {
      console.error(`[composer] failed on "${row.subject}": ${e.message}`);
      results.errors.push({ row: row.subject, error: e.message });
      // Park the row with an error note so it doesn't silently retry forever.
      try {
        await updateRow(row.id, { notes: `Compose error: ${e.message}`.slice(0, 1900) });
      } catch (_) {}
    }
  }

  return results;
}
