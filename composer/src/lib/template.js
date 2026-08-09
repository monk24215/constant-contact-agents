// template.js
// Renders the PT Sans / 600px white-shell Constant Contact template.
// {{BODY}} is injected RAW (Body Copy is authored HTML with its own <p> blocks).
// {{PREHEADER}} sets the hidden inbox-preview line.
//
// No footer or tracking token in the shell — CC handles those on send.

export function renderEmailHtml({ subject, body, preheader }) {
  const pre = preheader || '';
  const bodyHtml = styleParagraphs(body || '');
  const title = subject || 'Defend Survive Prepare';

  return `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en-US"><head>
<title>${escapeAttr(title)}</title>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
</head>
<body style="margin:0;padding:0;min-width:100%;background-color:#ffffff;">
<div id="preheader" style="color:transparent;display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeText(pre)}</div>
<table width="600" align="center" border="0" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;margin-left:auto;margin-right:auto;background-color:#ffffff;">
  <tr>
    <td align="center" style="padding:21px 22px;">
      <table width="600" align="center" border="0" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background-color:#ffffff;">
        <tr>
          <td align="left" style="color:#333333;font-family:'PT Sans',Roboto,Arial,sans-serif;font-size:17px;font-weight:400;line-height:2em;letter-spacing:0;text-align:left;word-wrap:break-word;padding:50px 30px;">${bodyHtml}
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


// styleParagraphs: force every <p> in the body to carry the exact house style.
// Any existing style attribute on a <p> is replaced. Other <p> attributes are dropped
// so the paragraph style is uniform across the email.
const P_STYLE = "margin-bottom:25px;color: #333333;font-family: PT Sans, Roboto, sans-serif;font-size: 17px;font-weight: 400;line-height: 1.9999999999999996;";
// The sign-off paragraph ("Stay Safe...") gets extra space above it (from the CTA)
// and below it (before the P.S.): 41px top (+25% of 25) and 46px bottom (+45% of 25).
const SIGNOFF_STYLE = "margin-top:41px;margin-bottom:36px;color: #333333;font-family: PT Sans, Roboto, sans-serif;font-size: 17px;font-weight: 400;line-height: 1.9999999999999996;";
export function styleParagraphs(html) {
  if (!html) return html;
  // Apply the uniform style to every <p> first...
  html = html.replace(/<p\b[^>]*>/gi, `<p style="${P_STYLE}">`);
  // ...then give the sign-off paragraph (the one containing "Stay Safe") the wider spacing.
  html = html.replace(
    /<p style="[^"]*">((?:(?!<\/p>)[\s\S])*?Stay Safe[\s\S]*?)<\/p>/i,
    `<p style="${SIGNOFF_STYLE}">$1</p>`
  );
  return html;
}

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
