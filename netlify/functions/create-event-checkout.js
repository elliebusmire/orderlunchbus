/* Checkout for event orders, such as TAZ swim meets.

   Deliberately separate from create-checkout.js so the school lunch flow is
   untouched. Everything downstream is shared: the same Stripe account, the
   same business tag, the same row encoding (lib/rows.js), the same webhook
   into the same sheet, the same thanks.html and the same My orders portal.

   Prices are recalculated here from data/menus.json. The browser's numbers
   are only used to check that the parent saw the price they will pay. */

const Stripe = require('stripe');
const menus = require('../../data/menus.json');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const CHUNK = 450;          // Stripe metadata values cap at 500 characters
const MAX_LINES = 20;       // distinct cart lines per order
const MAX_QTY_PER_LINE = 20;
const SCHOOL_TZ = 'America/Los_Angeles';

const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

const nowAtSchool = () => {
  const parts = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: SCHOOL_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', hourCycle: 'h23'
  }).formatToParts(new Date()).forEach((p) => { parts[p.type] = p.value; });
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
};

/* Same rule as the school flow: ordering closes at closesHour on closesOn,
   school time. */
function eventClosed(ev) {
  const now = nowAtSchool();
  const hour = ev.closesHour == null ? 12 : ev.closesHour;
  return now.date > ev.closesOn || (now.date === ev.closesOn && now.hour >= hour);
}

/* Row values are joined with ~ and rows with ;. The + sign separates
   removals, so it goes too. Applied to every piece of user text. */
const clean = (value, max) =>
  String(value == null ? '' : value)
    .replace(/[~;+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

/* Sales tax in basis points (725 is 7.25%), charged on the taxable subtotal
   and rounded to the cent once per order. taz.js does the same sum. */
const taxOn = (cents, rate) => Math.round((cents * (rate || 0)) / 10000);

function pack(prefix, text, into) {
  for (let i = 0, n = 0; i < text.length; i += CHUNK, n++) {
    into[`${prefix}_${n}`] = text.slice(i, i + CHUNK);
  }
}

/* Checks the picks for one cart line against the menu and returns them in
   menu order, so the same plate always reads the same way on the sheet. */
function validPicks(item, picks) {
  const groups = item.options || [];
  if (!groups.length) return { ok: true, text: '' };
  if (!Array.isArray(picks) || picks.length !== groups.length) {
    return { ok: false, error: `Choose the sides for the ${item.name}.` };
  }

  const out = [];
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    const need = group.pick || 1;
    const chosen = Array.isArray(picks[g]) ? picks[g] : [];
    const unique = [...new Set(chosen)];
    if (unique.length !== need || !unique.every((c) => group.choices.includes(c))) {
      return { ok: false, error: `${item.name}: ${group.label.toLowerCase()}.` };
    }
    out.push(group.choices.filter((c) => unique.includes(c)).join(' & '));
  }
  return { ok: true, text: out.join(' / ') };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Use POST.' });

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return reply(400, { error: 'Order could not be read.' });
  }

  const { eventId, customer, lines, expectedTotal } = body || {};

  const ev = (menus.events || []).find((e) => e.id === eventId);
  if (!ev || !ev.published) return reply(400, { error: 'That event is not taking orders.' });
  if (ev.orderingOpen === false) {
    return reply(503, { error: 'Pre-orders for this event are not open yet. Nothing has been charged.' });
  }
  if (eventClosed(ev)) {
    return reply(400, { error: 'Pre-orders for this event have closed. Nothing has been charged. You can still order at the trailer.' });
  }

  if (!customer || typeof customer !== 'object') return reply(400, { error: 'Name and email are required.' });
  const name = clean(customer.name, 60);
  const email = clean(customer.email, 120).toLowerCase();
  const phone = clean(customer.phone, 30);
  const allergies = clean(customer.allergies, 120);

  if (!name) return reply(400, { error: 'Add the name we should call out at pickup.' });

  // When the event lists pickup times, one of them must come back exactly.
  const times = ev.pickupTimes || [];
  const pickup = times.length ? String(customer.pickup || '') : '';
  if (times.length && !times.includes(pickup)) {
    return reply(400, { error: 'Choose a pickup time.' });
  }
  if (!looksLikeEmail(email)) return reply(400, { error: 'That email address does not look right.' });

  if (!Array.isArray(lines) || lines.length === 0) return reply(400, { error: 'Your order is empty.' });
  if (lines.length > MAX_LINES) return reply(400, { error: 'That order has too many lines. Split it into two orders.' });

  const lineItems = [];
  const rows = [];
  let units = 0;
  let taxable = 0;

  const when = new Date(ev.date + 'T12:00:00Z').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC'
  });

  for (const line of lines) {
    const item = (ev.items || []).find((i) => i.id === (line && line.itemId));
    if (!item) return reply(400, { error: 'One of the items is no longer on the menu. Refresh the page.' });

    const qty = Number(line.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) {
      return reply(400, { error: `Quantities run from 1 to ${MAX_QTY_PER_LINE} per line.` });
    }
    units += qty;

    const picks = validPicks(item, line.picks);
    if (!picks.ok) return reply(400, { error: picks.error });

    const choice = clean(picks.text, 120);

    // Only toppings the menu lists can be left off, returned in menu order.
    const asked = Array.isArray(line.removals) ? line.removals : [];
    const removals = (item.removals || []).filter((r) => asked.includes(r));
    const leaveOff = removals.map((r) => 'no ' + r.toLowerCase()).join(', ');

    lineItems.push({
      quantity: qty,
      price_data: {
        currency: 'usd',
        unit_amount: item.price,
        product_data: {
          name: `${ev.name}, ${when}: ${item.name}`,
          description: `Pickup: ${name}${pickup ? ' at ' + pickup : ''}${choice ? '. ' + choice : ''}${leaveOff ? '. ' + leaveOff.charAt(0).toUpperCase() + leaveOff.slice(1) : ''}`
        }
      }
    });

    /* One row per item so the sheet count is the prep count. Same eleven
       fields, same order, as lib/rows.js. Grade and note stay empty. */
    const row = [
      ev.date, item.name, choice, removals.map((r) => clean(r, 40)).join('+'), '', name, '', allergies, 'regular', '', item.price, pickup
    ].join('~');
    if (item.taxable !== false) taxable += item.price * qty;
    for (let q = 0; q < qty; q++) rows.push(row);
  }

  const max = ev.maxPerOrder || 40;
  if (units > max) return reply(400, { error: `Pre-orders are limited to ${max} items. Email us for anything larger.` });

  const tax = taxOn(taxable, ev.taxRate);
  const taxLabel = clean(ev.taxLabel || 'Sales tax', 40);
  if (tax > 0) {
    lineItems.push({
      quantity: 1,
      price_data: { currency: 'usd', unit_amount: tax, product_data: { name: taxLabel } }
    });
  }

  const serverTotal = lineItems.reduce((s, li) => s + li.price_data.unit_amount * li.quantity, 0);
  if (typeof expectedTotal === 'number' && expectedTotal !== serverTotal) {
    return reply(409, { error: 'Prices changed while you were ordering. Refresh the page to see current prices before paying.' });
  }

  const metadata = {
    business: menus.settings.businessTag || 'lunch-bus',
    kind: 'event',
    event_id: ev.id,
    event_name: clean(ev.name, 80),
    pickup_time: pickup,
    tax_cents: String(tax),
    tax_label: tax > 0 ? taxLabel : '',
    parent_name: name,
    parent_email: email,
    parent_phone: phone,
    meal_count: String(rows.length)
  };
  pack('rows', rows.join(';'), metadata);

  if (Object.keys(metadata).length > 45) {
    return reply(400, { error: 'That order is too large to process at once. Split it into two orders.' });
  }

  const site = process.env.URL || 'http://localhost:8888';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      customer_email: email,
      metadata,
      payment_intent_data: { metadata },
      // for=event lets thanks.html show pickup wording before the order loads.
      success_url: `${site}/thanks.html?session={CHECKOUT_SESSION_ID}&for=event&event=${encodeURIComponent(ev.id)}`,
      cancel_url: `${site}/taz.html`
    });
    return reply(200, { url: session.url });
  } catch (err) {
    console.error('Stripe event session failed', err);
    return reply(502, { error: 'Payment could not start.' });
  }
};
