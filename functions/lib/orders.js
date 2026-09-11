/* Reads Lunch Bus orders back out of Stripe for the confirmation page and
   the parent portal. Stripe is the record; nothing is stored anywhere else. */

const Stripe = require('stripe');
const menus = require('../../../data/menus.json');
const { parseRows } = require('./rows');

const BUSINESS = menus.settings.businessTag || 'lunch-bus';
const SCHOOL_TZ = 'America/Los_Angeles';

let client;
const stripe = () => client || (client = Stripe(process.env.STRIPE_SECRET_KEY));

const addOnLabel = (id) => {
  const found = (menus.settings.addOns || []).find((a) => a.id === id);
  return found ? found.label : id;
};

const dateLabel = (iso) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC'
  });
};

const todayInSchool = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: SCHOOL_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());

function receiptUrl(session) {
  const intent = session.payment_intent;
  const charge = intent && typeof intent === 'object' ? intent.latest_charge : null;
  return charge && typeof charge === 'object' ? charge.receipt_url || null : null;
}

function toOrder(session) {
  const md = session.metadata || {};
  const meals = parseRows(md)
    .map((r) => ({
      date: r.date,
      dateLabel: dateLabel(r.date),
      meal: r.meal,
      choice: r.choice,
      leaveOff: r.removals,
      request: r.note,
      student: r.student,
      grade: r.grade,
      allergies: r.allergies,
      double: r.portion === 'double',
      addOns: r.addOns.map(addOnLabel),
      amount: r.cents
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.student.localeCompare(b.student));

  return {
    id: session.id,
    placedAt: new Date(session.created * 1000).toISOString(),
    email: (session.customer_details && session.customer_details.email) || md.parent_email || '',
    parentName: md.parent_name || '',
    total: session.amount_total,
    paymentStatus: session.payment_status,
    receiptUrl: receiptUrl(session),
    meals
  };
}

async function getOrder(sessionId) {
  const session = await stripe().checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent.latest_charge']
  });
  if (!session.metadata || session.metadata.business !== BUSINESS) return null;
  return toOrder(session);
}

async function completedSessions(email, { expand = [], max = 60 } = {}) {
  const found = [];
  const list = stripe().checkout.sessions.list({
    customer_details: { email },
    status: 'complete',
    limit: 100,
    expand
  });
  for await (const session of list) {
    if (session.metadata && session.metadata.business === BUSINESS) found.push(session);
    if (found.length >= max) break;
  }
  return found;
}

async function hasOrders(email) {
  return (await completedSessions(email, { max: 1 })).length > 0;
}

async function ordersForEmail(email) {
  const sessions = await completedSessions(email, { expand: ['data.payment_intent.latest_charge'] });
  return sessions.map(toOrder);
}

/* Every paid lunch from today on, across all of a family's orders. */
function upcomingMeals(orders) {
  const today = todayInSchool();
  return orders
    .filter((o) => o.paymentStatus === 'paid')
    .flatMap((o) => o.meals)
    .filter((m) => m.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date) || a.student.localeCompare(b.student));
}

module.exports = { getOrder, hasOrders, ordersForEmail, upcomingMeals };
