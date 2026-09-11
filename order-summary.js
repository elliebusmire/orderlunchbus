/* Feeds thanks.html right after Stripe checkout, so the parent sees exactly
   what went through before they leave the page. */

const { getOrder } = require('./lib/orders');

const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

exports.handler = async (event) => {
  const id = (event.queryStringParameters && event.queryStringParameters.session) || '';
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(id)) return reply(400, { error: 'This page needs the link from checkout.' });

  try {
    const order = await getOrder(id);
    if (!order) return reply(404, { error: 'We could not find that order.' });
    return reply(200, { order });
  } catch (err) {
    if (err.code === 'resource_missing') return reply(404, { error: 'We could not find that order.' });
    console.error('Order summary failed', err.message);
    return reply(502, { error: 'Your order details did not load.' });
  }
};
