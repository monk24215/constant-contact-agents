// template.js
// Renders the PT Sans / 650px white-shell Constant Contact template.
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


<div id="preheader" style="color:transparent;display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;max-height:0; overflow:hidden; mso-hide:all;">${escapeText(pre)}</div>
<table width="650" align="center" border="0" cellpadding="0" cellspacing="0" style="width:100%;max-width:650px;margin-left:auto;margin-right:auto;background-color:#ffffff;border-color:#ffffff;">
<tbody>
<tr>
<td align="center" style="padding:0px 22px;">

<table width="650" align="center" border="0" cellpadding="0" cellspacing="0" style="width:100%;max-width:650px;background-color:#ffffff;display:block; border:none; border-collapse:collapse;padding:1%;overflow:hidden;border-color:#ffffff;">
<tbody>
<tr>
<td align="left" style="color:#333333;font-family:'PT Sans',Roboto,Arial,sans-serif;font-size:17px;font-weight:400;line-height:1.7em;letter-spacing:0;text-align:left;word-wrap:break-word;padding:0px 20px;">${bodyHtml}
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
const FONT = "color: #333333;font-family: PT Sans, Roboto, sans-serif;font-size: 17px;font-weight: 400;line-height: 1.9999999999999996;";
function pStyle(mb, mt) {
  return `${mt ? `margin-top:${mt}px;` : ''}margin-bottom:${mb}px;${FONT}`;
}
// Spacing pattern (from the approved manual edit):
//   body paragraphs        -> 25px
//   paragraph before CTA   -> 45px
//   CTA paragraph          -> 65px
//   sign-off ("Stay Safe") -> 75px
//   P.S.                   -> 25px
export function styleParagraphs(html) {
  if (!html) return html;
  const isPS = (b) => /(^|>)\s*(<[^>]+>\s*)*P\.?\s?S\.?[\s.:]/i.test(b);
  const isSignoff = (b) => /Stay Safe/i.test(b);
  const isCTA = (b) => /sl\.defendsurviveprepare\.com/i.test(b) && !isPS(b) && !isSignoff(b);

  // First pass: index every <p> block and locate the CTA.
  const blocks = html.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || [];
  const ctaIndex = blocks.findIndex(isCTA);

  // Second pass: rewrite each <p> by its ordinal position.
  let i = -1;
  return html.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (m, inner) => {
    i++;
    let mb = 25;
    if (isSignoff(m)) mb = 75;
    else if (isCTA(m)) mb = 65;
    else if (ctaIndex > 0 && i === ctaIndex - 1) mb = 45;
    return `<p style="${pStyle(mb, 0)}">${inner}</p>`;
  });
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
