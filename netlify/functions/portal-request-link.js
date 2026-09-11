const { normalizeEmail, looksLikeEmail, linkToken } = require('./lib/auth');
const { hasOrders } = require('./lib/orders');
const { sendSignInLink } = require('./lib/email');

const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Use POST.' });

  let body = {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body;
    body = JSON.parse(raw || '{}');
  } catch {
    return reply(400, { error: 'Could not read that.' });
  }

  const email = normalizeEmail(body.email);
  if (!looksLikeEmail(email)) return reply(400, { error: 'Enter the email address you used at checkout.' });

  /* The answer is the same whether or not the address has orders, so the
     form cannot be used to find out whether a family ordered. */
  try {
    if (await hasOrders(email)) {
      const site = process.env.URL || 'http://localhost:8888';
      await sendSignInLink(email, `${site}/.netlify/functions/portal-verify?token=${encodeURIComponent(linkToken(email))}`);
    }
  } catch (err) {
    /* A missing SESSION_SECRET or RESEND_API_KEY is a setup problem, not
       something the parent did wrong. Say so plainly rather than sending them
       off to wait for an email that will never arrive. */
    console.error('Sign-in link failed', err.message);
    if (/SESSION_SECRET|RESEND_API_KEY/.test(err.message)) {
      return reply(503, { error: 'Sign-in is temporarily unavailable. Email orderlunchbus@gmail.com and we will send your order details.' });
    }
    return reply(502, { error: 'The link did not send. Try again in a minute, or email orderlunchbus@gmail.com.' });
  }
  return reply(200, { ok: true });
};
