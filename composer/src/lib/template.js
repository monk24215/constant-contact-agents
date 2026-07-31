// template.js
// Renders emails using the REAL "claudeTempEmail" Constant Contact house style
// for Defend Survive Prepare: Roboto, 650px white shell on dark ground, left-
// aligned 17px body, blue (#2C74FF) bold CTA links, SG&T signoff conventions.
//
// The CC v3 API cannot instantiate a saved template by name, so we reproduce
// the template's HTML skeleton here and inject the subject + body copy. Output
// is a CUSTOM (format_type 5) campaign that matches the house template exactly.
//
// The footer compliance block (address + unsubscribe/profile links) uses CC's
// [[trackingImage]] and Constant Contact auto-inserts the required unsubscribe
// + physical address for CUSTOM campaigns via the physical_address_in_footer
// passed on the campaign. We still include a visible address line to match the
// house style.

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Convert plain-text body (with blank-line paragraphs and single newlines)
// into the template's paragraph style. If the body already contains HTML tags,
// it is passed through untouched (lets you hand-author rich copy in Notion).
function bodyToHtml(body) {
  const looksHtml = /<[a-z][\s\S]*>/i.test(body);
  if (looksHtml) return body;
  const P = 'text-align: left; margin: 0;';
  const SPAN = 'font-size: 17px; font-family: Roboto, sans-serif;';
  return body
    .split(/\n/)
    .map((line) => {
      if (line.trim() === '') {
        return `<p style="${P}" align="left"><br></p>`;
      }
      return `<p style="${P}" align="left"><span style="${SPAN}">${escapeHtml(line)}</span></p>`;
    })
    .join('\n');
}

export function renderEmailHtml({ subject, body, preheader }) {
  const org = process.env.CC_ADDR_ORG || 'Defend Survive Prepare';
  const line1 = process.env.CC_ADDR_LINE1 || '760 Farm to Market 1626';
  const city = process.env.CC_ADDR_CITY || 'Manchaca';
  const state = process.env.CC_ADDR_STATE || 'TX';
  const postal = process.env.CC_ADDR_POSTAL || '78652';
  const pre = preheader || '';
  const inner = bodyToHtml(body || '');

  return `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en-US"><head>
<title>${escapeHtml(subject || org)}</title>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
</head>
<body style="margin:0;padding:0;min-width:100%;width:100%;background-color:#474747;">
<div id="preheader" style="color:transparent;display:none;font-size:1px;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${escapeHtml(pre)}</div>
[[trackingImage]]
<table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color:#474747;"><tbody>
<tr><td align="center" valign="top" style="background-color:#ffffff;" bgcolor="#ffffff">
  <table align="center" border="0" cellpadding="0" cellspacing="0" style="width:650px;"><tbody>
  <tr><td align="center" valign="top" style="padding:15px 18px;">
    <table width="100%" align="center" border="0" cellpadding="0" cellspacing="0"><tbody>
    <tr><td align="center" valign="top" style="background-color:#FFFFFF;padding:0;">
      <table width="100%" border="0" cellpadding="0" cellspacing="0"><tbody>
      <tr><td align="center" valign="top" style="width:100%;">
        <div style="height:30px;line-height:30px;">&hairsp;</div>
        <table width="100%" border="0" cellpadding="0" cellspacing="0"><tbody><tr><td style="padding:4px;">
          <table width="100%" border="0" cellpadding="0" cellspacing="0" style="table-layout:fixed;"><tbody>
          <tr><td align="center" valign="top" style="line-height:2;text-align:center;font-family:Roboto,sans-serif;color:#3E3E3E;font-size:17px;display:block;word-wrap:break-word;padding:20px 30px 50px;">
${inner}
          </td></tr></tbody></table>
        </td></tr></tbody></table>
        <div style="height:30px;line-height:30px;">&hairsp;</div>
      </td></tr></tbody></table>
    </td></tr></tbody></table>
  </td></tr></tbody></table>
</td></tr>
<tr><td align="center" valign="top" style="background-color:#FFFFFF;" bgcolor="#FFFFFF">
  <table align="center" border="0" cellpadding="0" cellspacing="0" style="width:700px;"><tbody>
  <tr><td align="center" valign="top" style="padding:0px 10px;">
    <table width="100%" align="center" border="0" cellpadding="0" cellspacing="0"><tbody>
    <tr><td align="center" style="color:#595959;font-family:Verdana,Geneva,sans-serif;font-size:11px;line-height:1.2;padding:10px 40px;">
      <p style="margin:0;">${escapeHtml(org)} | ${escapeHtml(line1)} | ${escapeHtml(city)}, ${escapeHtml(state)} ${escapeHtml(postal)} US</p>
    </td></tr>
    <tr><td align="center" style="color:#595959;font-family:Verdana,Geneva,sans-serif;font-size:11px;line-height:1.2;padding:10px 40px;">
      <p style="margin:0;"> <a href="[[unsubscribe]]" data-track="false">Unsubscribe<span data-is-bsl="true" data-token="&zwnj;" data-bracket-syntax="[[IF partner.optout IS &quot;T&quot;]] from [[account.organizationName]][[ENDIF]]">&zwnj;</span></a><span> | </span><span data-is-bsl="true" data-token="&zwnj;" data-bracket-syntax="[[IF partner.optout IS &quot;T&quot;]]Unsubscribe from all [[partner.companyName]][[ENDIF]]">&zwnj;</span><span><a href="[[updateLink]]" data-track="false">Update Profile</a></span><span> | </span><span><span data-is-bsl="true" data-token="&zwnj;" data-bracket-syntax="[[IF customPrivacyPolicyUrl]]Our Privacy Policy | [[ENDIF]]">&zwnj;</span><a href="[[aboutCtctLink]]" data-track="false">Constant Contact Data Notice</a></span> </p>
    </td></tr>
    </tbody></table>
  </td></tr></tbody></table>
</td></tr>
</tbody></table>
</body></html>`;
}

// addTracking: append channel + UTM params to every sl.defendsurviveprepare.com
// link in the HTML. Idempotent-ish: skips links that already have a query string
// containing tid= so we don't double-append.
//
//   tid=ccm                         -> Constant Contact email channel (internal)
//   utm_source=constantcontact
//   utm_medium=email
//   utm_campaign=<vendor id>        -> groups by product/vendor
//
// Note: this only tags the branded short-link domain. Whether the params survive
// to the destination depends on the sl. redirect preserving query strings.
export function addTracking(html, { vendor } = {}) {
  if (!html) return html;
  const campaign = (vendor || 'unknown').toString().trim();
  const params =
    `tid=ccm&utm_source=constantcontact&utm_medium=email&utm_campaign=${encodeURIComponent(campaign)}`;

  // Match href="...sl.defendsurviveprepare.com/xxx" (single or double quotes).
  return html.replace(
    /(href=["'])(https?:\/\/sl\.defendsurviveprepare\.com\/[^"']*?)(["'])/gi,
    (m, pre, url, post) => {
      if (/[?&]tid=/.test(url)) return m; // already tagged
      const sep = url.includes('?') ? '&' : '?';
      return `${pre}${url}${sep}${params}${post}`;
    }
  );
}
