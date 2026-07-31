// template.js
// Cleaned Constant Contact template skeleton for Defend Survive Prepare.
// Redundant nested tables/tbody/duplicate attrs removed; all inline styles that
// email clients require are kept. Body Copy is injected RAW (DS Copywriter
// writes full HTML). Footer + [[trackingImage]] tokens are CC-native.

export function renderEmailHtml({ subject, body, preheader }) {
  const pre = preheader || '';
  const bodyHtml = body || '';
  const title = subject || 'Defend Survive Prepare';

  return `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en-US"><head>
<title>${escapeAttr(title)}</title>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
</head>
<body style="margin:0;padding:0;min-width:100%;background-color:#474747;">
<div id="preheader" style="color:transparent;display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeText(pre)}</div>
[[trackingImage]]
<table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color:#474747;">
  <tr>
    <td align="center" style="padding:15px 18px;">
      <table width="650" align="center" border="0" cellpadding="0" cellspacing="0" style="width:650px;max-width:650px;background-color:#ffffff;">
        <tr>
          <td align="left" style="font-family:Roboto,Arial,sans-serif;color:#3E3E3E;font-size:17px;line-height:2em;word-wrap:break-word;padding:50px 30px;">${bodyHtml}
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:10px 40px 4px;">
            <p style="margin:0;font-family:Roboto,Arial,sans-serif;color:#525252;font-size:10px;line-height:1.4;">Defend Survive Prepare | 760 Farm to Market 1626 | Manchaca, TX 78652 US</p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:0 40px 20px;">
            <p style="margin:0;font-family:Roboto,Arial,sans-serif;color:#525252;font-size:11px;line-height:1.4;"> <a href="[[unsubscribe]]" data-track="false">Unsubscribe<span data-is-bsl="true" data-token="&zwnj;" data-bracket-syntax="[[IF partner.optout IS &quot;T&quot;]] from [[account.organizationName]][[ENDIF]]">&zwnj;</span></a><span> | </span><span data-is-bsl="true" data-token="&zwnj;" data-bracket-syntax="[[IF partner.optout IS &quot;T&quot;]]Unsubscribe from all [[partner.companyName]][[ENDIF]]">&zwnj;</span><span><a href="[[updateLink]]" data-track="false">Update Profile</a></span><span> | </span><span><span data-is-bsl="true" data-token="&zwnj;" data-bracket-syntax="[[IF customPrivacyPolicyUrl]]Our Privacy Policy | [[ENDIF]]">&zwnj;</span><a href="[[aboutCtctLink]]" data-track="false">Constant Contact Data Notice</a></span> </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body></html>`;
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function escapeText(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// addTracking: append channel + UTM params to every sl.defendsurviveprepare.com
// link. Idempotent (skips links already carrying tid=).
export function addTracking(html, { vendor } = {}) {
  if (!html) return html;
  const campaign = (vendor || 'unknown').toString().trim();
  const params =
    `tid=ccm&utm_source=constantcontact&utm_medium=email&utm_campaign=${encodeURIComponent(campaign)}`;
  return html.replace(
    /(href=["'])(https?:\/\/sl\.defendsurviveprepare\.com\/[^"']*?)(["'])/gi,
    (m, pre, url, post) => {
      if (/[?&]tid=/.test(url)) return m;
      const sep = url.includes('?') ? '&' : '?';
      return `${pre}${url}${sep}${params}${post}`;
    }
  );
}
