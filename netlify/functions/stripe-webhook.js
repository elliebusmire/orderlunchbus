const Stripe = require('stripe');
const menus = require('../../data/menus.json');
const sheets = require('./lib/sheets');
const { unpack, parseRows } = require('./lib/rows');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const BUSINESS = menus.settings.businessTag || 'lunch-bus';

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  /* Stripe signs the raw request body. Netlify base64-encodes it in some
     configurations, so decode before verifying or every event is rejected. */
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Signature check failed', err.message);
    return { statusCode: 400, body: 'Bad signature' };
  }

  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'Ignored' };
  }

  const session = stripeEvent.data.object;
  const md = session.metadata || {};

  /* Only sessions created by create-checkout carry the business tag. Anything
     else on the account (a payment link, a manual charge) is acknowledged and
     dropped so it never reaches the kitchen sheet. */
  if (md.business !== BUSINESS) {
    return { statusCode: 200, body: 'Not a ' + BUSINESS + ' order, ignored' };
  }

  if (!unpack('rows', md)) {
    console.error('No rows in session', session.id);
    return { statusCode: 200, body: 'Nothing to write' };
  }

  const orderedAt = new Date().toISOString();

  /* One row per meal per student. This is what makes the daily prep list
     a filter rather than a manual untangling job. */
  const rows = parseRows(md).map((r) => ({
    order_id: session.id,
    ordered_at: orderedAt,
    parent_name: md.parent_name || '',
    parent_email: md.parent_email || session.customer_email || '',
    parent_phone: md.parent_phone || '',
    student_name: r.student,
    grade: r.grade,
    allergies: r.allergies,
    service_date: r.date,
    meal: r.meal,
    choice: r.choice,
    leave_off: r.removals.join(', '),
    special_request: r.note,
    portion: r.portion,
    add_ons: r.addOns.join(', '),
    line_total: (r.cents / 100).toFixed(2),
    payment_status: session.payment_status
  }));

  /* Preferred path: write straight to the sheet. One API call per order
     regardless of how many meals it holds, and no per-row task quota. */
  if (sheets.isConfigured()) {
    try {
      if (await sheets.orderAlreadyWritten(session.id)) {
        console.log('Duplicate delivery for', session.id, '- already in the sheet');
        return { statusCode: 200, body: 'Already recorded' };
      }
      const written = await sheets.appendRows(rows);
      return { statusCode: 200, body: `Wrote ${written} rows to the sheet` };
    } catch (err) {
      console.error('Sheets write failed for', session.id, err.message);
      /* The reason goes in the response as well as the log. It is only ever
         seen in the Stripe dashboard, and it turns a silent failure into
         something you can read without digging through function logs.
         500 so Stripe retries rather than losing the order. */
      return { statusCode: 500, body: 'Sheets write failed: ' + String(err.message).slice(0, 400) };
    }
  }

  // Fallback: Zapier catch hook, one request per row.
  const hook = process.env.ZAPIER_WEBHOOK_URL;
  if (!hook) {
    console.error('No sheet credentials and no ZAPIER_WEBHOOK_URL. Rows were not written.', rows.length);
    return { statusCode: 500, body: 'No destination configured' };
  }

  let failures = 0;
  for (const row of rows) {
    try {
      const res = await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(row)
      });
      if (!res.ok) failures++;
    } catch (err) {
      failures++;
      console.error('Row post failed', row.service_date, row.student_name, err.message);
    }
  }

  if (failures > 0) {
    console.error(`${failures} of ${rows.length} rows failed for ${session.id}`);
    return { statusCode: 500, body: 'Partial write' };
  }

  return { statusCode: 200, body: `Wrote ${rows.length} rows` };
};
