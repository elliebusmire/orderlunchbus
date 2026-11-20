/* December 2026 menu tests.

   The month is published from data/menus.json. These tests pin that block
   and check the order page, archive list, price deadline, and checkout
   accept it. They do not call Stripe, Google Sheets, Zapier, or the network,
   and they do not read or write existing orders. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before } = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const menuPath = path.join(root, 'data', 'menus.json');

const stripeCalls = [];

const Module = require('node:module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'stripe') {
    return function Stripe() {
      return {
        checkout: {
          sessions: {
            async create(payload) {
              stripeCalls.push(payload);
              return { id: 'cs_test_mock', url: 'https://checkout.stripe.test/c/session_mock' };
            }
          }
        }
      };
    };
  }
  return originalRequire.apply(this, arguments);
};

process.env.STRIPE_SECRET_KEY = 'sk_test_mock_not_used';
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
delete process.env.GOOGLE_SHEET_ID;
delete process.env.ZAPIER_WEBHOOK_URL;
delete process.env.RESEND_API_KEY;

global.fetch = async () => {
  throw new Error('network is disabled in menu tests');
};

const { handler } = require('../netlify/functions/create-checkout');
const { parseRows } = require('../netlify/functions/lib/rows');

function loadClient() {
  const src = fs.readFileSync(path.join(root, 'assets', 'app.js'), 'utf8');
  const cut = src.indexOf("document.getElementById('cartJump')");
  assert.ok(cut > 0, 'order page script no longer ends in the expected wiring');
  const sandbox = {
    console,
    Intl,
    URL,
    URLSearchParams,
    get Date() { return global.Date; }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(
    src.slice(0, cut) + `
      globalThis.__api = {
        state, cutoffPassed, weekStartOf, parseDate, todayISO,
        dayLabel, canOrder, pickableMonths, priceFor, isLate, monthStatus
      };
    `,
    sandbox,
    { filename: 'assets/app.js' }
  );
  sandbox.__api.state.data = JSON.parse(fs.readFileSync(menuPath, 'utf8'));
  return sandbox.__api;
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

let client;
let menus;

before(() => {
  menus = JSON.parse(fs.readFileSync(menuPath, 'utf8'));
  client = loadClient();
});

function december() {
  return menus.months.find((m) => m.id === '2026-12');
}

function day(iso) {
  return december().days.find((d) => d.date === iso);
}

test('December is published after November and the earlier menus stay put', () => {
  assert.deepEqual(menus.months.map((m) => m.id), ['2026-10', '2026-11', '2026-12']);
  assert.deepEqual(december(), {
    id: '2026-12',
    label: 'December 2026',
    published: true,
    ordersCloseOn: '2026-11-30',
    days: [
      {
        date: '2026-12-01',
        meal: 'Hard Shell Tacos',
        description: 'Hard shell tacos with rice and fresh fruit.',
        tags: ['contains dairy']
      },
      {
        date: '2026-12-03',
        meal: 'Spaghetti and Meatballs',
        description: 'Spaghetti and meatballs with breadsticks.',
        tags: ['contains wheat', 'contains dairy'],
        removals: ['Breadsticks']
      },
      {
        date: '2026-12-08',
        meal: 'Personal Pita Pizza',
        description: 'Pita crust pizza with fresh fruit.',
        choiceLabel: 'Pick a topping',
        choices: ['Cheese', 'Pepperoni'],
        tags: ['contains wheat', 'contains dairy']
      },
      {
        date: '2026-12-10',
        meal: 'Corn Dogs and Chips',
        description: 'Corn dogs with chips and fresh fruit.',
        tags: ['contains wheat']
      },
      {
        date: '2026-12-15',
        meal: 'Hot Dogs and Fries',
        description: 'Hot dog with French fries and fresh fruit.',
        tags: ['contains wheat']
      },
      {
        date: '2026-12-17',
        meal: 'Chicken Nuggets and Fries',
        description: 'Chicken nuggets with French fries and fresh fruit.',
        tags: ['contains wheat']
      }
    ]
  });

  const november = menus.months.find((m) => m.id === '2026-11');
  assert.equal(november.ordersCloseOn, '2026-10-31');
  assert.deepEqual(november.days.map((d) => d.date), [
    '2026-11-03', '2026-11-05', '2026-11-09', '2026-11-12', '2026-11-17', '2026-11-18'
  ]);
  assert.equal(menus.settings.mealPrice, 800);
  assert.equal(menus.settings.latePrice, 1000);
  assert.equal(menus.settings.orderingOpen, true);
  assert.equal(menus.events[0].id, 'taz-2026-10-17');

  const weekdays = december().days.map((d) =>
    client.parseDate(d.date).toLocaleDateString('en-US', { weekday: 'long' })
  );
  assert.deepEqual(weekdays, [
    'Tuesday', 'Thursday', 'Tuesday', 'Thursday', 'Tuesday', 'Thursday'
  ]);
  assert.deepEqual(
    december().days.map((d) => d.date),
    december().days.map((d) => d.date).slice().sort()
  );
});

test('the order page and the archive list December without a hardcoded month', () => {
  const orderPage = fs.readFileSync(path.join(root, 'holy-trinity.html'), 'utf8');
  const archive = fs.readFileSync(path.join(root, 'menus.html'), 'utf8');
  assert.equal(orderPage.includes('2026-12'), false);
  assert.equal(archive.includes('2026-12'), false);
  assert.match(archive, /data\.months\.filter\(m => m\.published\)\.slice\(\)\.reverse\(\)/);

  const listed = menus.months.filter((m) => m.published).slice().reverse();
  assert.equal(listed[0].id, '2026-12');
  assert.deepEqual(listed[0].days.map((d) => d.meal), [
    'Hard Shell Tacos',
    'Spaghetti and Meatballs',
    'Personal Pita Pizza',
    'Corn Dogs and Chips',
    'Hot Dogs and Fries',
    'Chicken Nuggets and Fries'
  ]);

  withNow('2026-11-18T20:00:00.000Z', () => {
    assert.deepEqual(client.pickableMonths().map((m) => m.id), ['2026-11', '2026-12']);
  });
  withNow('2026-11-20T20:00:00.000Z', () => {
    assert.equal(client.todayISO(), '2026-11-20');
    assert.deepEqual(client.pickableMonths().map((m) => m.id), ['2026-12']);
    const month = december();
    assert.equal(client.isLate(month), false);
    assert.equal(client.priceFor(month), 800);
    assert.equal(client.monthStatus(month).open, true);
    for (const d of month.days) assert.equal(client.canOrder(month, d), true, d.date);
  });
  withNow('2026-12-01T16:59:00.000Z', () => {
    assert.equal(client.todayISO(), '2026-12-01');
    assert.equal(client.isLate(december()), true);
    assert.equal(client.priceFor(december()), 1000);
    assert.equal(client.cutoffPassed('2026-12-01'), false);
    assert.equal(client.canOrder(december(), day('2026-12-01')), true);
  });
  withNow('2026-12-01T17:00:00.000Z', () => {
    assert.equal(client.cutoffPassed('2026-12-01'), true);
    assert.equal(client.canOrder(december(), day('2026-12-01')), false);
    assert.equal(client.canOrder(december(), day('2026-12-17')), true);
    assert.equal(client.monthStatus(december()).open, true);
  });
  withNow('2026-12-17T17:00:00.000Z', () => {
    assert.equal(client.canOrder(december(), day('2026-12-17')), false);
    assert.equal(client.monthStatus(december()).open, false);
    assert.deepEqual(client.pickableMonths().map((m) => m.id), ['2026-12']);
  });
  withNow('2026-12-18T20:00:00.000Z', () => {
    assert.deepEqual(client.pickableMonths().map((m) => m.id), []);
  });
});

function orderBody(items, expectedTotal) {
  return {
    parent: { name: 'Test Parent', email: 'test.parent@example.com', phone: '555-0100' },
    students: [{ name: 'Test Student', grade: '3rd', allergies: '' }],
    items: items.map((item) => Object.assign({
      monthId: '2026-12',
      studentIndex: 0,
      double: false,
      addOns: [],
      removals: [],
      note: '',
      choice: '',
      meal: 'TAMPERED MEAL NAME'
    }, item)),
    expectedTotal
  };
}

async function postAt(utcIso, body) {
  return withNow(utcIso, () => handler({
    httpMethod: 'POST',
    body: JSON.stringify(body)
  }));
}

test('checkout accepts December meals at the pre-order price and the late price', async () => {
  const beforeCalls = stripeCalls.length;
  const noonNov30 = '2026-11-30T20:00:00.000Z';
  const items = [
    { date: '2026-12-01' },
    { date: '2026-12-03', removals: ['Breadsticks', 'Not a real side'] },
    { date: '2026-12-08', choice: 'Pepperoni' },
    { date: '2026-12-10' },
    { date: '2026-12-15' },
    { date: '2026-12-17' }
  ];

  const early = await postAt(noonNov30, orderBody(items, 4800));
  assert.equal(early.statusCode, 200);
  assert.equal(JSON.parse(early.body).url, 'https://checkout.stripe.test/c/session_mock');
  const session = stripeCalls.at(-1);
  assert.equal(session.metadata.business, 'lunch-bus');
  assert.equal(JSON.stringify(session).includes('TAMPERED'), false);
  assert.deepEqual(parseRows(session.metadata).map((r) => [r.date, r.meal, r.choice, r.removals, r.cents]), [
    ['2026-12-01', 'Hard Shell Tacos', '', [], 800],
    ['2026-12-03', 'Spaghetti and Meatballs', '', ['Breadsticks'], 800],
    ['2026-12-08', 'Personal Pita Pizza', 'Pepperoni', [], 800],
    ['2026-12-10', 'Corn Dogs and Chips', '', [], 800],
    ['2026-12-15', 'Hot Dogs and Fries', '', [], 800],
    ['2026-12-17', 'Chicken Nuggets and Fries', '', [], 800]
  ]);
  assert.deepEqual(session.line_items.map((li) => li.price_data.product_data.name), [
    'Tue, Dec 1: Hard Shell Tacos',
    'Thu, Dec 3: Spaghetti and Meatballs',
    'Tue, Dec 8: Personal Pita Pizza (Pepperoni)',
    'Thu, Dec 10: Corn Dogs and Chips',
    'Tue, Dec 15: Hot Dogs and Fries',
    'Thu, Dec 17: Chicken Nuggets and Fries'
  ]);
  assert.equal(session.line_items[1].price_data.product_data.description, 'Test Student, 3rd (no breadsticks)');

  const cheese = await postAt(noonNov30, orderBody([{ date: '2026-12-08', choice: 'Cheese' }], 800));
  assert.equal(cheese.statusCode, 200);
  assert.equal(parseRows(stripeCalls.at(-1).metadata)[0].choice, 'Cheese');

  const late = await postAt('2026-12-01T16:59:00.000Z', orderBody([{ date: '2026-12-01' }], 1000));
  assert.equal(late.statusCode, 200);
  assert.equal(parseRows(stripeCalls.at(-1).metadata)[0].cents, 1000);

  const stale = await postAt('2026-12-01T16:59:00.000Z', orderBody([{ date: '2026-12-03' }], 800));
  assert.equal(stale.statusCode, 409);
  assert.equal(stripeCalls.length, beforeCalls + 3);
});

test('checkout refuses a missing pizza topping, a non-service date, and a meal after 9 am', async () => {
  const beforeCalls = stripeCalls.length;
  const noonNov30 = '2026-11-30T20:00:00.000Z';

  const noTopping = await postAt(noonNov30, orderBody([{ date: '2026-12-08' }], 800));
  assert.equal(noTopping.statusCode, 400);
  assert.match(JSON.parse(noTopping.body).error, /Pick an option for Personal Pita Pizza/);

  const badTopping = await postAt(noonNov30, orderBody([{ date: '2026-12-08', choice: 'Sausage' }], 800));
  assert.equal(badTopping.statusCode, 400);

  const notServed = await postAt(noonNov30, orderBody([{ date: '2026-12-02' }], 800));
  assert.equal(notServed.statusCode, 400);
  assert.match(JSON.parse(notServed.body).error, /No lunch is served/);

  const tooLate = await postAt('2026-12-01T17:00:00.000Z', orderBody([{ date: '2026-12-01' }], 1000));
  assert.equal(tooLate.statusCode, 400);
  assert.match(JSON.parse(tooLate.body).error, /Tuesday, December 1/);

  const stillOpen = await postAt('2026-12-17T16:59:00.000Z', orderBody([{ date: '2026-12-17' }], 1000));
  assert.equal(stillOpen.statusCode, 200);
  assert.equal(parseRows(stripeCalls.at(-1).metadata)[0].date, '2026-12-17');

  const closes = await postAt('2026-12-17T17:00:00.000Z', orderBody([{ date: '2026-12-17' }], 1000));
  assert.equal(closes.statusCode, 400);
  assert.match(JSON.parse(closes.body).error, /Thursday, December 17/);

  assert.equal(stripeCalls.length, beforeCalls + 1);
});
