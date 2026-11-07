/* What may be written to function logs.

   Stripe and Google put request bodies, account emails, and sometimes the
   request URL on the error object. err.message is included only when it is a
   short diagnostic with none of those. Callers must not log the error object
   itself, a student name, or a parent's email. */

function safeMessage(err) {
  const msg = String(err && err.message || '');
  if (!msg || msg.length > 180) return '';
  if (/[@\r\n]|sk_|api[_-]?key|bearer|private[_-]?key|client_email|hooks\.zapier|googleapis|sheet/i.test(msg)) return '';
  return msg;
}

function logFields(err) {
  if (!err || typeof err !== 'object') return ['Error'];
  const bits = [];
  if (err.name && err.name !== 'Error') bits.push(String(err.name));
  const status = err.statusCode || err.status;
  if (status) bits.push(String(status));
  if (typeof err.reason === 'string' && err.reason) bits.push(err.reason);
  else if (typeof err.code === 'string' && err.code) bits.push(err.code);
  else if (typeof err.type === 'string' && err.type) bits.push(err.type);
  if (typeof err.requestId === 'string' && err.requestId) bits.push(err.requestId);
  const msg = safeMessage(err);
  if (msg) bits.push(msg);
  return bits.length ? bits : ['Error'];
}

module.exports = { logFields, safeMessage };
