/* Passwordless sign-in for the parent portal. A parent asks for a link, the
   link carries a short-lived signed token, and following it sets a signed
   cookie. No accounts, no passwords, nothing stored. */

const crypto = require('crypto');

const COOKIE = 'lb_portal';
const LINK_MINUTES = 30;
const SESSION_DAYS = 14;

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) throw new Error('SESSION_SECRET must be set to at least 32 characters');
  return value;
}

const normalizeEmail = (v) => String(v == null ? '' : v).trim().toLowerCase();
const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 120;

const mac = (body) => crypto.createHmac('sha256', secret()).update(body).digest('base64url');

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(body)}`;
}

function verify(token, type) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  const given = Buffer.from(signature || '');
  const expected = Buffer.from(mac(body));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.typ !== type || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

const linkToken = (email) => sign({ typ: 'link', em: email, exp: Date.now() + LINK_MINUTES * 60e3 });
const sessionToken = (email) => sign({ typ: 'session', em: email, exp: Date.now() + SESSION_DAYS * 864e5 });

const sessionCookie = (token) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
const clearedCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function readSession(event) {
  const header = (event.headers && (event.headers.cookie || event.headers.Cookie)) || '';
  const found = header.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  return found ? verify(found.slice(COOKIE.length + 1), 'session') : null;
}

module.exports = {
  normalizeEmail, looksLikeEmail, verify, linkToken, sessionToken,
  sessionCookie, clearedCookie, readSession, LINK_MINUTES
};
