const { readSession } = require('./lib/auth');
const { ordersForEmail, upcomingMeals } = require('./lib/orders');

const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

exports.handler = async (event) => {
  const session = readSession(event);
  if (!session) return reply(401, { error: 'signed_out' });

  try {
    const orders = await ordersForEmail(session.em);
    return reply(200, { email: session.em, upcoming: upcomingMeals(orders), orders });
  } catch (err) {
    console.error('Portal lookup failed', err.message);
    return reply(502, { error: 'Your orders did not load. Refresh the page in a moment.' });
  }
};
