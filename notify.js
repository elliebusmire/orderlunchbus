/* Second home for the notify list.
   Netlify Forms already captures these, but only once form detection is on,
   and the free tier caps submissions. Writing them to the spreadsheet too
   means the list survives either of those going wrong, and it lives somewhere
   the business actually controls. */

const sheets = require('./lib/sheets');

const NOTIFY_TAB = process.env.GOOGLE_NOTIFY_TAB || 'Notify';
const MAX_EMAIL = 120;

const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

const clean = (v, max) =>
  String(v == null ? '' : v).replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Use POST.' }) };
  }

  let body;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    body = JSON.parse(raw);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Could not read that.' }) };
  }

  // Honeypot. Real people leave it empty; bots fill everything in.
  if (body['bot-field']) {
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  const email = clean(body.email, MAX_EMAIL).toLowerCase();
  if (!looksLikeEmail(email)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'That email address does not look right.' }) };
  }

  if (!sheets.isConfigured()) {
    // Netlify Forms is still capturing; nothing to do here.
    return { statusCode: 200, body: JSON.stringify({ ok: true, stored: 'netlify-forms-only' }) };
  }

  try {
    // Signing up twice should not create two rows to email twice.
    const existing = await sheets.columnValues(NOTIFY_TAB, 'B');
    if (existing.includes(email)) {
      return { statusCode: 200, body: JSON.stringify({ ok: true, stored: 'already-listed' }) };
    }

    await sheets.appendValues(NOTIFY_TAB, [[
      new Date().toISOString(),
      email,
      'website'
    ]]);

    return { statusCode: 200, body: JSON.stringify({ ok: true, stored: 'sheet' }) };
  } catch (err) {
    console.error('Notify write failed:', err.message);
    // Netlify Forms is the backstop, so do not show the visitor an error.
    return { statusCode: 200, body: JSON.stringify({ ok: true, stored: 'netlify-forms-only' }) };
  }
};
