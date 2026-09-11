const { clearedCookie } = require('./lib/auth');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: '' };
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearedCookie(), 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ok: true })
  };
};
