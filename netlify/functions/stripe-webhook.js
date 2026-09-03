const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

/* Reassemble the chunked rows metadata written by create-checkout. */
function unpack(prefix, metadata) {
  let out = '';
  for (let n = 0; metadata[`${prefix}_${n}`] !== undefined; n++) {
    out += metadata[`${prefix}_${n}`];
  }
  return out;
}

exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
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
  const packed = unpack('rows', md);

  if (!packed) {
    console.error('No rows in session', session.id);
    return { statusCode: 200, body: 'Nothing to write' };
  }

  const orderedAt = new Date().toISOString();

  /* One row per meal per student. This is what makes the daily prep list
     a filter rather than a manual untangling job. */
  const rows = packed.split(';').map((chunk) => {
    const [date, meal, choice, removals, note, student, grade, allergies, portion, addOns, cents] = chunk.split('~');
    return {
      order_id: session.id,
      ordered_at: orderedAt,
      parent_name: md.parent_name || '',
      parent_email: md.parent_email || session.customer_email || '',
      parent_phone: md.parent_phone || '',
      student_name: student,
      grade,
      allergies,
      service_date: date,
      meal,
      choice,
      leave_off: (removals || '').split('+').filter(Boolean).join(', '),
      special_request: note || '',
      portion,
      add_ons: (addOns || '').split('+').filter(Boolean).join(', '),
      line_total: (Number(cents) / 100).toFixed(2),
      payment_status: session.payment_status
    };
  });

  const hook = process.env.ZAPIER_WEBHOOK_URL;
  if (!hook) {
    console.error('ZAPIER_WEBHOOK_URL is not set. Rows were not written.', rows.length);
    return { statusCode: 200, body: 'No webhook configured' };
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
    // Return 500 so Stripe retries the whole event rather than silently losing meals.
    console.error(`${failures} of ${rows.length} rows failed for ${session.id}`);
    return { statusCode: 500, body: 'Partial write' };
  }

  return { statusCode: 200, body: `Wrote ${rows.length} rows` };
};
