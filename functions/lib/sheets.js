/* Appends rows to a Google Sheet using a service account.
   Deliberately dependency-free: signs its own JWT with node's crypto rather
   than pulling in googleapis, which is large and slow to cold-start in a
   Netlify function. */

const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

const b64url = (input) =>
  Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* The key file is stored base64-encoded in one env var. Pasting raw JSON with
   its multi-line private key into a dashboard field mangles the newlines. */
function credentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;

  const text = raw.trim().startsWith('{')
    ? raw
    : Buffer.from(raw, 'base64').toString('utf8');

  const parsed = JSON.parse(text);
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('Service account JSON is missing client_email or private_key');
  }
  return parsed;
}

async function accessToken(creds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: creds.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  }));

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = b64url(signer.sign(creds.private_key.replace(/\\n/g, '\n')));

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signature}`
    })
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error('Google token request failed: ' + (data.error_description || data.error || res.status));
  }
  return data.access_token;
}

/* Column order here IS the sheet's column order. It must match row 1. */
const COLUMNS = [
  'order_id', 'ordered_at', 'parent_name', 'parent_email', 'parent_phone',
  'student_name', 'grade', 'allergies', 'service_date', 'meal', 'choice',
  'leave_off', 'special_request', 'portion', 'add_ons', 'line_total',
  'payment_status'
];

function isConfigured() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_SHEET_ID);
}

/* Generic append. One API call however many rows are passed. */
async function appendValues(tab, values) {
  const creds = credentials();
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const token = await accessToken(creds);

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values/${encodeURIComponent(tab + '!A1')}:append` +
    `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values })
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Sheets append failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const out = await res.json();
  return out.updates ? out.updates.updatedRows : values.length;
}

/* Order rows, in the fixed column order above. */
async function appendRows(rows) {
  const tab = process.env.GOOGLE_SHEET_TAB || 'Sheet1';
  const values = rows.map((row) => COLUMNS.map((c) => (row[c] === undefined ? '' : String(row[c]))));
  return appendValues(tab, values);
}

/* Read one column, used for duplicate checks. */
async function columnValues(tab, column) {
  const creds = credentials();
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const token = await accessToken(creds);

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}` +
    `/values/${encodeURIComponent(`${tab}!${column}:${column}`)}`;

  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.values || []).map((r) => (r[0] || '').trim().toLowerCase());
}

/* Stripe retries a webhook until it gets a 2xx, so the same order can arrive
   twice. Checking the order_id column first means a retry cannot double-book
   a child's meals. */
async function orderAlreadyWritten(orderId) {
  const tab = process.env.GOOGLE_SHEET_TAB || 'Sheet1';
  const seen = await columnValues(tab, 'A');
  return seen.includes(String(orderId).trim().toLowerCase());
}

module.exports = {
  isConfigured, appendRows, appendValues, columnValues, orderAlreadyWritten, COLUMNS
};
