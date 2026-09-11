/* Sends the portal sign-in link through Resend. Plain fetch, no SDK. */

const menus = require('../../../data/menus.json');
const { LINK_MINUTES } = require('./auth');

async function sendSignInLink(to, link) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set');

  const safeLink = link.replace(/"/g, '%22');
  const html = `<!doctype html><html><body style="margin:0;background:#FBF6EA;font-family:Arial,Helvetica,sans-serif;color:#1A462B">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:2px solid #1A462B">
<tr><td style="background:#1A462B;border-bottom:3px solid #D89B2C;padding:16px 24px;font-size:20px;font-weight:bold;letter-spacing:1px;color:#D89B2C">LUNCH <span style="color:#FBF6EA">BUS</span></td></tr>
<tr><td style="padding:24px">
<p style="font-size:18px;font-weight:bold;margin:0 0 10px">Open your Lunch Bus orders</p>
<p style="font-size:15px;line-height:1.5;color:#4E6553;margin:0 0 20px">Use the button below to see your upcoming lunches and receipts. It works for ${LINK_MINUTES} minutes.</p>
<p style="margin:0 0 20px"><a href="${safeLink}" style="display:inline-block;background:#D89B2C;color:#1A462B;border:2px solid #1A462B;font-weight:bold;text-decoration:none;padding:10px 18px">Open my orders</a></p>
<p style="font-size:13px;color:#4E6553;margin:0">Didn't ask for this? You can ignore it.</p>
</td></tr></table></td></tr></table></body></html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || 'Lunch Bus <orders@orderlunchbus.com>',
      reply_to: menus.settings.contactEmail,
      to: [to],
      subject: 'Your Lunch Bus sign-in link',
      html,
      text: `Open your Lunch Bus orders (the link works for ${LINK_MINUTES} minutes):\n${link}\n\nDidn't ask for this? You can ignore it.`
    })
  });

  if (!res.ok) throw new Error(`Resend returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

module.exports = { sendSignInLink };
