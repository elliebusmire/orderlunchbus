/* Security regressions. Fake clock, fake Stripe, fake Google, fake Zapier.
   No network, no live charges, and no customer records. */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const STUDENT = 'Casey Example';
const PARENT_EMAIL = 'parent@example.com';
const SHEET_EMAIL = 'sheets-user@example.com';
const ZAPIER_TOKEN = 'secret-token';
const SENSITIVE = [STUDENT, PARENT_EMAIL, SHEET_EMAIL, ZAPIER_TOKEN, 'peanuts', 'sk_live_not_real'];

const savedEnv = {
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID,
  ZAPIER_WEBHOOK_URL: process.env.ZAPIER_WEBHOOK_URL
};

process.env.STRIPE_SECRET_KEY = 'sk_test_mock_not_used';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock_not_used';
delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
delete process.env.GOOGLE_SHEET_ID;
delete process.env.ZAPIER_WEBHOOK_URL;

const logs = [];
const originalError = console.error;
console.error = (...args) => {
  logs.push(args.map((part) => String(part)).join(' '));
};

let signatureError = null;
let nextEvent = null;
let failCheckout = null;
const checkoutPayloads = [];
const fetchCalls = [];

const Module = require('node:module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'stripe') {
    return function Stripe() {
      return {
        webhooks: {
          constructEvent() {
            if (signatureError) throw signatureError;
            return nextEvent;
          }
        },
        checkout: {
          sessions: {
            async create(payload) {
              if (failCheckout) {
                const err = failCheckout;
                failCheckout = null;
                throw err;
              }
              checkoutPayloads.push(payload);
              return { id: 'cs_test_mock', url: 'https://checkout.stripe.test/c/session_mock' };
            }
          }
        }
      };
    };
  }
  return originalRequire.apply(this, arguments);
};

function jsonResponse(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return text; },
    async json() { return JSON.parse(text); }
  };
}

let fetchHandler = async () => {
  throw new Error('network disabled');
};
global.fetch = async (url, opts) => {
  fetchCalls.push(String(url));
  return fetchHandler(String(url), opts || {});
};

const { handler: webhook } = require('../netlify/functions/stripe-webhook');
const { handler: checkout } = require('../netlify/functions/create-checkout');
const { logFields } = require('../netlify/functions/lib/log');
const { parseRows } = require('../netlify/functions/lib/rows');

const menus = JSON.parse(fs.readFileSync(path.join(root, 'data/menus.json'), 'utf8'));

function pemKey() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' });
}

function orderSession() {
  return {
    id: 'cs_test_security',
    payment_status: 'paid',
    customer_email: PARENT_EMAIL,
    metadata: {
      business: 'lunch-bus',
      parent_name: 'Test Parent',
      parent_email: PARENT_EMAIL,
      parent_phone: '555-0100',
      meal_count: '1',
      rows_0: `2026-11-10~Corn Dogs and Fries~~~~${STUDENT}~3rd~peanuts~regular~~1000`
    }
  };
}

function webhookEvent(session) {
  return {
    httpMethod: 'POST',
    headers: { 'stripe-signature': 't=1,v1=mock' },
    body: '{}',
    isBase64Encoded: false,
    _session: session
  };
}

async function postWebhook(session) {
  nextEvent = { type: 'checkout.session.completed', data: { object: session } };
  signatureError = null;
  return webhook(webhookEvent(session));
}

function assertNoSensitive(text) {
  for (const secret of SENSITIVE) {
    assert.equal(text.includes(secret), false, 'output contained a sensitive value');
  }
}

function withNow(utcIso, fn) {
  const RealDate = Date;
  const fixed = new RealDate(utcIso).getTime();
  function FakeDate(...args) {
    if (!new.target) return args.length ? RealDate(...args) : RealDate(fixed);
    return args.length ? new RealDate(...args) : new RealDate(fixed);
  }
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  FakeDate.now = () => fixed;
  FakeDate.prototype = RealDate.prototype;
  global.Date = FakeDate;
  try {
    return fn();
  } finally {
    global.Date = RealDate;
  }
}

before(() => {
  logs.length = 0;
});

after(() => {
  console.error = originalError;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('log fields drop emails, webhook URLs, and raw secrets', () => {
  const fields = logFields({
    name: 'TypeError',
    message: `connect failed https://hooks.zapier.com/hooks/catch/${ZAPIER_TOKEN} ${STUDENT} ${PARENT_EMAIL}`
  });
  assertNoSensitive(fields.join(' '));
  assert.equal(fields[0], 'TypeError');

  const stripeFields = logFields({
    name: 'Error',
    type: 'StripeAPIError',
    statusCode: 401,
    requestId: 'req_test_123',
    message: `Invalid API Key provided: sk_live_not_real for ${PARENT_EMAIL}`
  });
  assert.deepEqual(stripeFields.slice().sort(), ['401', 'StripeAPIError', 'req_test_123']);
});

test('a Sheets failure tells Stripe to retry without Google details or names', async () => {
  logs.length = 0;
  fetchCalls.length = 0;
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: SHEET_EMAIL,
    private_key: pemKey()
  });
  process.env.GOOGLE_SHEET_ID = 'test-sheet-id';
  delete process.env.ZAPIER_WEBHOOK_URL;

  const googleBody = JSON.stringify({
    error: {
      status: 'PERMISSION_DENIED',
      message: `caller ${SHEET_EMAIL} for student ${STUDENT}`
    }
  });
  fetchHandler = async (url, opts) => {
    if (url.includes('oauth2.googleapis.com')) return jsonResponse(200, { access_token: 'fake-token' });
    if (url.includes('spreadsheets') && opts.method !== 'POST') return jsonResponse(200, { values: [] });
    if (url.includes('spreadsheets')) return jsonResponse(403, googleBody);
    throw new Error('unexpected host');
  };

  const res = await postWebhook(orderSession());
  assert.equal(res.statusCode, 500);
  assert.equal(res.body, 'Sheets write failed');
  const written = logs.join('\n');
  assert.match(written, /Sheets write failed/);
  assert.match(written, /403/);
  assert.match(written, /PERMISSION_DENIED/);
  assert.match(written, /cs_test_security/);
  assertNoSensitive(res.body);
  assertNoSensitive(written);
  assert.equal(fetchCalls.some((url) => url.includes('zapier')), false);
});

test('a token failure does not keep Google account text on the error', async () => {
  logs.length = 0;
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: SHEET_EMAIL,
    private_key: pemKey()
  });
  process.env.GOOGLE_SHEET_ID = 'test-sheet-id';
  fetchHandler = async (url) => {
    if (url.includes('oauth2.googleapis.com')) {
      return jsonResponse(400, {
        error: 'invalid_grant',
        error_description: `account ${SHEET_EMAIL} student ${STUDENT}`
      });
    }
    throw new Error('unexpected host');
  };
  const res = await postWebhook(orderSession());
  assert.equal(res.statusCode, 500);
  assert.equal(res.body, 'Sheets write failed');
  assert.match(logs.join('\n'), /invalid_grant/);
  assertNoSensitive(res.body + '\n' + logs.join('\n'));
});

test('a failed Zapier post logs the date and status, not the child or the hook', async () => {
  logs.length = 0;
  fetchCalls.length = 0;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_SHEET_ID;
  process.env.ZAPIER_WEBHOOK_URL = `https://hooks.zapier.com/hooks/catch/${ZAPIER_TOKEN}`;

  fetchHandler = async () => jsonResponse(502, `echo ${STUDENT} ${PARENT_EMAIL}`);
  const rejected = await postWebhook(orderSession());
  assert.equal(rejected.statusCode, 500);
  assert.equal(rejected.body, 'Partial write');
  assert.match(logs.join('\n'), /HTTP 502/);
  assert.match(logs.join('\n'), /service_date 2026-11-10/);
  assertNoSensitive(rejected.body + '\n' + logs.join('\n'));

  logs.length = 0;
  fetchHandler = async () => {
    throw new Error(`connect ECONNREFUSED https://hooks.zapier.com/hooks/catch/${ZAPIER_TOKEN} ${STUDENT}`);
  };
  const thrown = await postWebhook(orderSession());
  assert.equal(thrown.statusCode, 500);
  assert.equal(thrown.body, 'Partial write');
  assertNoSensitive(thrown.body + '\n' + logs.join('\n'));
  assert.match(logs.join('\n'), /service_date 2026-11-10/);
});

test('a successful sheet write still returns 200 and does not log the child', async () => {
  logs.length = 0;
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: SHEET_EMAIL,
    private_key: pemKey()
  });
  process.env.GOOGLE_SHEET_ID = 'test-sheet-id';
  delete process.env.ZAPIER_WEBHOOK_URL;
  fetchHandler = async (url, opts) => {
    if (url.includes('oauth2.googleapis.com')) return jsonResponse(200, { access_token: 'fake-token' });
    if (url.includes('spreadsheets') && opts.method !== 'POST') return jsonResponse(200, { values: [] });
    if (url.includes('spreadsheets')) return jsonResponse(200, { updates: { updatedRows: 1 } });
    throw new Error('unexpected host');
  };
  const res = await postWebhook(orderSession());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'Wrote 1 rows to the sheet');
  assertNoSensitive(res.body + '\n' + logs.join('\n'));
});

test('a bad signature is rejected without echoing the verifier message', async () => {
  logs.length = 0;
  signatureError = new Error(`No signatures found for ${PARENT_EMAIL}`);
  const res = await webhook(webhookEvent(orderSession()));
  signatureError = null;
  assert.equal(res.statusCode, 400);
  assert.equal(res.body, 'Bad signature');
  assertNoSensitive(res.body + '\n' + logs.join('\n'));
});

test('checkout keeps menu price and meal, and logs Stripe failures without the order', async () => {
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_SHEET_ID;
  delete process.env.ZAPIER_WEBHOOK_URL;
  const nov = menus.months.find((m) => m.id === '2026-11');
  assert.equal(nov.ordersCloseOn, '2026-10-31');
  assert.deepEqual(nov.days.map((d) => d.date), [
    '2026-11-03', '2026-11-05', '2026-11-10', '2026-11-12', '2026-11-17', '2026-11-19'
  ]);
  const corn = nov.days.find((d) => d.meal === 'Corn Dogs and Fries');
  assert.equal(corn.date, '2026-11-10');
  assert.equal(menus.settings.mealPrice, 800);
  assert.equal(menus.settings.latePrice, 1000);

  const bodyFor = (expectedTotal) => ({
    httpMethod: 'POST',
    body: JSON.stringify({
      parent: { name: 'Test Parent', email: PARENT_EMAIL, phone: '555-0100' },
      students: [{ name: STUDENT, grade: '3rd', allergies: 'peanuts' }],
      items: [{
        monthId: '2026-11',
        date: corn.date,
        studentIndex: 0,
        meal: 'TAMPERED MEAL <script>',
        choice: '',
        removals: [],
        note: '',
        double: false,
        addOns: []
      }],
      expectedTotal
    })
  });

  const early = await withNow('2026-10-30T19:00:00.000Z', () => checkout(bodyFor(800)));
  assert.equal(early.statusCode, 200);
  const earlySession = checkoutPayloads.at(-1);
  const earlyRows = parseRows(earlySession.metadata);
  assert.equal(earlyRows[0].date, corn.date);
  assert.equal(earlyRows[0].meal, 'Corn Dogs and Fries');
  assert.equal(earlyRows[0].cents, 800);
  assert.equal(JSON.stringify(earlySession).includes('TAMPERED'), false);
  assert.equal(earlySession.line_items[0].price_data.unit_amount, 800);

  const late = await withNow('2026-11-07T20:00:00.000Z', () => checkout(bodyFor(1000)));
  assert.equal(late.statusCode, 200);
  assert.equal(parseRows(checkoutPayloads.at(-1).metadata)[0].cents, 1000);

  const stale = await withNow('2026-11-07T20:00:00.000Z', () => checkout(bodyFor(800)));
  assert.equal(stale.statusCode, 409);
  assert.equal(checkoutPayloads.length, 2);

  logs.length = 0;
  failCheckout = Object.assign(new Error(`No such customer ${PARENT_EMAIL} ${STUDENT} sk_live_not_real`), {
    type: 'StripeAPIError',
    statusCode: 500,
    requestId: 'req_test_123'
  });
  const failed = await withNow('2026-11-07T20:00:00.000Z', () => checkout(bodyFor(1000)));
  assert.equal(failed.statusCode, 502);
  assert.match(failed.body, /Payment could not start/);
  assert.match(logs.join('\n'), /req_test_123/);
  assertNoSensitive(failed.body + '\n' + logs.join('\n'));
});

function fakeDocument() {
  function Node(tag) {
    this.tagName = tag;
    this.children = [];
    this.className = '';
    this.style = {};
    this.id = '';
    this.href = '';
    this.textContent = '';
    this._html = '';
    this.classList = { add() {} };
  }
  Node.prototype.showModal = function () {};
  Node.prototype.close = function () {};
  Node.prototype.appendChild = function (child) {
    this.children.push(child);
    return child;
  };
  Node.prototype.append = function (...children) {
    this.children.push(...children.flat());
  };
  Node.prototype.replaceChildren = function (...children) {
    this.children = children.flat();
  };
  Node.prototype.querySelector = function () {
    return new Node('div');
  };
  Node.prototype.querySelectorAll = function () {
    return [];
  };
  Object.defineProperty(Node.prototype, 'innerHTML', {
    set(value) { this._html = String(value); },
    get() { return this._html; }
  });
  const nodes = {};
  return {
    nodes,
    createElement: (tag) => new Node(tag),
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    getElementById(id) {
      if (!nodes[id]) nodes[id] = new Node(id);
      return nodes[id];
    }
  };
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

test('menu text is escaped on the order card and the menus page', async () => {
  const attack = '<img src=x onerror=alert(1)>';
  const src = fs.readFileSync(path.join(root, 'assets/app.js'), 'utf8');
  const cut = src.indexOf("document.getElementById('cartJump')");
  assert.ok(cut > 0);
  const document = fakeDocument();
  const sandbox = {
    console,
    Intl,
    URL,
    URLSearchParams,
    document,
    get Date() { return global.Date; }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src.slice(0, cut) + `
    globalThis.__api = { state, ticket, openDialog, esc };
  `, sandbox, { filename: 'assets/app.js' });
  const api = sandbox.__api;
  api.state.data = {
    settings: {
      orderingOpen: true,
      mealPrice: 800,
      latePrice: 1000,
      orderCutoffDaysBefore: 0,
      orderCutoffHour: 9,
      doublePortionPrice: 200,
      noteMaxLength: 80,
      notePrompt: attack,
      addOns: [{ id: 'milk', label: attack, price: 200 }],
      grades: ['3rd']
    },
    months: []
  };
  api.state.students = [{ name: 'Test Student', grade: '3rd', allergies: '' }];
  api.state.cart = [];
  api.state.monthId = '2026-11';
  const month = { id: '2026-11', published: true, ordersCloseOn: '2026-10-31', days: [] };
  const day = {
    date: '2026-11-12',
    meal: attack,
    description: attack,
    tags: [attack, 'vegetarian'],
    choiceLabel: attack,
    choices: [attack],
    removals: [attack]
  };

  const card = withNow('2026-11-07T20:00:00.000Z', () => api.ticket(day, month));
  assert.match(card.innerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(card.innerHTML.includes('<img'), false);
  assert.match(card.innerHTML, /tag veg/);

  withNow('2026-11-07T20:00:00.000Z', () => api.openDialog(day));
  const markup = [];
  walk(document.nodes.dlgOptions, (node) => {
    if (node._html) markup.push(node._html);
  });
  const joined = markup.join('\n');
  assert.match(joined, /&lt;img/);
  assert.equal(joined.includes('<img'), false);
  assert.match(joined, /value="&lt;img src=x onerror=alert\(1\)&gt;"/);

  const page = fs.readFileSync(path.join(root, 'menus.html'), 'utf8');
  const script = page.slice(page.indexOf('<script>') + 8, page.indexOf('</script>'));
  const menusDoc = fakeDocument();
  const menusSandbox = {
    console,
    Intl,
    document: menusDoc,
    fetch: async () => ({
      json: async () => ({
        settings: menus.settings,
        months: [{
          id: '2026-11',
          label: attack,
          published: true,
          ordersCloseOn: '2026-10-31',
          days: [{ date: '2026-11-12', meal: attack, choices: [attack] }]
        }]
      })
    }),
    get Date() { return Date; }
  };
  menusSandbox.globalThis = menusSandbox;
  vm.runInNewContext(script, menusSandbox, { filename: 'menus.html' });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const months = menusDoc.nodes.months;
  const texts = [];
  const html = [];
  walk(months, (node) => {
    if (node.textContent) texts.push(node.textContent);
    if (node._html) html.push(node._html);
  });
  assert.equal(html.length, 0);
  assert.ok(texts.includes(attack));
});

test('the published folder is the website, not the function source', () => {
  const toml = fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8');
  assert.match(toml, /command = "node scripts\/assemble-site\.js"/);
  assert.match(toml, /publish = "public"/);
  assert.match(toml, /functions = "netlify\/functions"/);
  assert.match(toml, /from = "\/netlify\/\*"/);
  assert.match(toml, /force = true/);
  assert.equal(toml.includes('from = "/*.js"'), false);

  const res = spawnSync(process.execPath, ['scripts/assemble-site.js'], { cwd: root, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const pub = path.join(root, 'public');
  const rels = [];
  (function walkDir(dir) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(pub, full);
      if (fs.statSync(full).isDirectory()) walkDir(full);
      else rels.push(rel.split(path.sep).join('/'));
    }
  })(pub);

  for (const required of ['index.html', 'holy-trinity.html', 'menus.html', '404.html', 'assets/app.js', 'assets/styles.css', 'data/menus.json']) {
    assert.ok(rels.includes(required), required);
  }
  for (const banned of rels) {
    assert.equal(banned.startsWith('netlify/'), false, banned);
    assert.equal(banned.startsWith('functions/'), false, banned);
    assert.equal(banned.startsWith('lib/'), false, banned);
    assert.equal(/^(create-checkout|stripe-webhook|notify|app|orders)\.js$/.test(banned), false, banned);
    assert.equal(banned === 'menus.json' || banned === 'package.json' || banned === 'README.md', false, banned);
  }
  const publishedMenu = fs.readFileSync(path.join(pub, 'data/menus.json'), 'utf8');
  assert.equal(publishedMenu, fs.readFileSync(path.join(root, 'data/menus.json'), 'utf8'));
  fs.rmSync(pub, { recursive: true, force: true });
});
