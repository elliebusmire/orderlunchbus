/* November 2026 service-date regression tests.

   These tests read the menu and exercise date, cutoff, label, and checkout
   payload rules with a fake clock and a fake Stripe client. They do not call
   Stripe, Google Sheets, Zapier, or the network, and they do not read or
   write existing orders. */

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test, before } = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const menuPath = path.join(root, 'data', 'menus.json');

const stripeCalls = [];
const networkCalls = [];

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

const originalFetch = global.fetch;
global.fetch = async (url) => {
  networkCalls.push(String(url));
  throw new Error('network is disabled in date tests');
};

const { handler } = require('../netlify/functions/create-checkout');
const { parseRows } = require('../netlify/functions/lib/rows');
const { upcomingMeals } = require('../netlify/functions/lib/orders');
const { buildCalendar } = require('../netlify/functions/order-calendar');

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
        state, cutoffPassed, weekStartOf, parseDate, todayISO, shiftDays,
        dayLabel, canOrder, pickableMonths, priceFor, isLate
      };
    `,
    sandbox,
    { filename: 'assets/app.js' }
  );
  sandbox.__api.state.data = JSON.parse(fs.readFileSync(menuPath, 'utf8'));
  return sandbox.__api;
}

function loadDateLabel() {
  const src = fs.readFileSync(path.join(root, 'netlify', 'functions', 'lib', 'orders.js'), 'utf8');
  const start = src.indexOf('const dateLabel =');
  const end = src.indexOf('const todayInSchool');
  assert.ok(start > 0 && end > start, 'portal dateLabel helper moved');
  const sandbox = { Intl, get Date() { return global.Date; } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src.slice(start, end) + '\nglobalThis.dateLabel = dateLabel;', sandbox);
  return sandbox.dateLabel;
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

function utcShift(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

let client;
let dateLabel;
let menus;

before(() => {
  menus = JSON.parse(fs.readFileSync(menuPath, 'utf8'));
  client = loadClient();
  dateLabel = loadDateLabel();
});

function november() {
  return menus.months.find((m) => m.id === '2026-11');
}

function day(iso) {
  return november().days.find((d) => d.date === iso);
}

test('only the two requested November service dates move', () => {
  assert.equal(day('2026-11-09').meal, 'Corn Dogs and Fries');
  assert.equal(day('2026-11-18').meal, 'Hot Dogs and Fries');
  assert.equal(day('2026-11-10'), undefined);
  assert.equal(day('2026-11-19'), undefined);

  assert.deepEqual(november().days.map((d) => d.date), [
    '2026-11-03',
    '2026-11-05',
    '2026-11-09',
    '2026-11-12',
    '2026-11-17',
    '2026-11-18'
  ]);
  assert.deepEqual(
    november().days.map((d) => d.date),
    november().days.map((d) => d.date).slice().sort()
  );

  assert.deepEqual(day('2026-11-09'), {
    date: '2026-11-09',
    meal: 'Corn Dogs and Fries',
    description: 'Corn dogs with French fries and fresh fruit.',
    tags: ['contains wheat']
  });
  assert.deepEqual(day('2026-11-18'), {
    date: '2026-11-18',
    meal: 'Hot Dogs and Fries',
    description: 'Hot dog with French fries and fresh fruit.',
    tags: ['contains wheat']
  });

  assert.equal(day('2026-11-03').meal, 'Chicken or Steak Burrito');
  assert.deepEqual(day('2026-11-03').choices, ['Chicken', 'Steak']);
  assert.equal(day('2026-11-05').meal, 'Chicken Nuggets and Fries');
  assert.equal(day('2026-11-12').meal, 'Mac and Cheese Bowl');
  assert.equal(day('2026-11-17').meal, 'Breakfast for Lunch!');
  assert.deepEqual(day('2026-11-17').choices, ['Sausage', 'Bacon']);

  const october = menus.months.find((m) => m.id === '2026-10');
  assert.deepEqual(october.days.map((d) => d.date), [
    '2026-10-06', '2026-10-08', '2026-10-13', '2026-10-15',
    '2026-10-20', '2026-10-22', '2026-10-27', '2026-10-29'
  ]);
  assert.equal(menus.events[0].date, '2026-10-17');
  assert.equal(JSON.stringify(menus).includes('2026-11-10'), false);
  assert.equal(JSON.stringify(menus).includes('2026-11-19'), false);
});

test('prices, options, and the monthly deadline are unchanged', () => {
  const s = menus.settings;
  assert.equal(s.mealPrice, 800);
  assert.equal(s.latePrice, 1000);
  assert.equal(s.doublePortionPrice, 200);
  assert.equal(s.orderCutoffDaysBefore, 0);
  assert.equal(s.orderCutoffHour, 9);
  assert.deepEqual(s.addOns.map((a) => [a.id, a.price]), [['milk', 200], ['juice', 200]]);
  assert.equal(november().ordersCloseOn, '2026-10-31');
  assert.equal(november().published, true);
  assert.equal(day('2026-11-09').choices, undefined);
  assert.equal(day('2026-11-18').choices, undefined);
  assert.equal(day('2026-11-09').removals, undefined);
  assert.equal(day('2026-11-18').removals, undefined);
});

test('weekday labels are the Pacific calendar day in UTC, Pacific, Auckland, and Kiritimati', () => {
  const script = `
    const long = { weekday: 'long', month: 'long', day: 'numeric' };
    const local = (iso) => {
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString('en-US', long);
    };
    const checkoutLine = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric'
    });
    const cutoffText = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', {
      ...long, timeZone: 'UTC'
    });
    const portal = (iso) => {
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC'
      });
    };
    const pacific = (iso) => {
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d, 20)).toLocaleDateString('en-US', {
        ...long, timeZone: 'America/Los_Angeles'
      });
    };
    const dates = ['2026-11-03', '2026-11-05', '2026-11-09', '2026-11-12', '2026-11-17', '2026-11-18'];
    const out = {};
    for (const iso of dates) {
      const full = local(iso);
      if (full !== pacific(iso) || full !== cutoffText(iso)) process.exit(2);
      out[iso] = { full, line: checkoutLine(iso), portal: portal(iso) };
    }
    process.stdout.write(JSON.stringify(out));
  `;
  for (const TZ of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland', 'Pacific/Kiritimati']) {
    const res = spawnSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ },
      encoding: 'utf8'
    });
    assert.equal(res.status, 0, `${TZ}\n${res.stderr}\n${res.stdout}`);
    const out = JSON.parse(res.stdout);
    assert.equal(out['2026-11-09'].full, 'Monday, November 9');
    assert.equal(out['2026-11-09'].line, 'Mon, Nov 9');
    assert.equal(out['2026-11-09'].portal, 'Mon, Nov 9');
    assert.equal(out['2026-11-18'].full, 'Wednesday, November 18');
    assert.equal(out['2026-11-18'].line, 'Wed, Nov 18');
    assert.equal(out['2026-11-18'].portal, 'Wed, Nov 18');
    assert.equal(out['2026-11-03'].full, 'Tuesday, November 3');
    assert.equal(out['2026-11-05'].full, 'Thursday, November 5');
    assert.equal(out['2026-11-12'].full, 'Thursday, November 12');
    assert.equal(out['2026-11-17'].full, 'Tuesday, November 17');
  }

  assert.equal(dateLabel('2026-11-09'), 'Mon, Nov 9');
  assert.equal(dateLabel('2026-11-18'), 'Wed, Nov 18');
  assert.equal(dateLabel('2026-11-10'), 'Tue, Nov 10');
  assert.equal(dateLabel('2026-11-19'), 'Thu, Nov 19');
  assert.equal(client.dayLabel('2026-11-09'), 'Nov 9');
  assert.equal(
    client.parseDate('2026-11-09').toLocaleDateString('en-US', { weekday: 'short' }),
    'Mon'
  );
  assert.equal(
    client.parseDate('2026-11-18').toLocaleDateString('en-US', { weekday: 'short' }),
    'Wed'
  );
});

test('weeks, month span, and past days follow the new dates', () => {
  assert.equal(client.weekStartOf('2026-11-09'), '2026-11-09');
  assert.equal(client.weekStartOf('2026-11-12'), '2026-11-09');
  assert.equal(client.weekStartOf('2026-11-17'), '2026-11-16');
  assert.equal(client.weekStartOf('2026-11-18'), '2026-11-16');

  const weeks = new Map();
  for (const d of november().days) {
    const start = client.weekStartOf(d.date);
    if (!weeks.has(start)) weeks.set(start, []);
    weeks.get(start).push(d.date);
  }
  assert.deepEqual(weeks.get('2026-11-09'), ['2026-11-09', '2026-11-12']);
  assert.deepEqual(weeks.get('2026-11-16'), ['2026-11-17', '2026-11-18']);

  const days = november().days;
  assert.equal(client.dayLabel(days[0].date), 'Nov 3');
  assert.equal(client.dayLabel(days[days.length - 1].date), 'Nov 18');

  withNow('2026-11-07T20:00:00.000Z', () => {
    assert.equal(client.todayISO(), '2026-11-07');
    assert.equal('2026-11-05' < client.todayISO(), true);
    assert.equal('2026-11-09' < client.todayISO(), false);
    assert.equal('2026-11-18' < client.todayISO(), false);
    const ids = client.pickableMonths().map((m) => m.id);
    assert.deepEqual(ids, ['2026-11']);
  });

  withNow('2026-11-19T20:00:00.000Z', () => {
    assert.equal(client.todayISO(), '2026-11-19');
    assert.equal('2026-11-18' < client.todayISO(), true);
    assert.deepEqual(client.pickableMonths().map((m) => m.id), []);
  });
});

test('client date arithmetic matches the server and the 9am Pacific cutoff', () => {
  const checkoutSrc = fs.readFileSync(path.join(root, 'netlify', 'functions', 'create-checkout.js'), 'utf8');
  assert.match(checkoutSrc, /Date\.UTC\(y, m - 1, d \+ n\)/);
  assert.match(checkoutSrc, /require\('\.\.\/\.\.\/data\/menus\.json'\)/);
  for (const iso of ['2026-03-08', '2026-11-01', '2026-11-09', '2026-11-18', '2026-12-31']) {
    for (const n of [-2, -1, 0, 1, 2]) {
      assert.equal(client.shiftDays(iso, n), utcShift(iso, n), `${iso} ${n}`);
    }
  }

  const month = november();
  withNow('2026-11-07T20:00:00.000Z', () => {
    assert.equal(client.cutoffPassed('2026-11-09'), false);
    assert.equal(client.cutoffPassed('2026-11-18'), false);
    assert.equal(client.cutoffPassed('2026-11-05'), true);
    assert.equal(client.canOrder(month, day('2026-11-09')), true);
    assert.equal(client.isLate(month), true);
    assert.equal(client.priceFor(month), 1000);
  });
  withNow('2026-11-09T16:59:00.000Z', () => {
    assert.equal(client.todayISO(), '2026-11-09');
    assert.equal(client.cutoffPassed('2026-11-09'), false);
    assert.equal(client.cutoffPassed('2026-11-18'), false);
  });
  withNow('2026-11-09T17:00:00.000Z', () => {
    assert.equal(client.cutoffPassed('2026-11-09'), true);
    assert.equal(client.cutoffPassed('2026-11-18'), false);
  });
  withNow('2026-11-18T16:59:00.000Z', () => {
    assert.equal(client.cutoffPassed('2026-11-18'), false);
  });
  withNow('2026-11-18T17:00:00.000Z', () => {
    assert.equal(client.todayISO(), '2026-11-18');
    assert.equal(client.cutoffPassed('2026-11-18'), true);
  });

  const menusPage = fs.readFileSync(path.join(root, 'menus.html'), 'utf8');
  assert.match(menusPage, /timeZone: 'America\/Los_Angeles'/);
  assert.match(menusPage, /today < lastIso \|\| \(today === lastIso && now\.hour < cutoffHour\)/);
});

function orderBody(items, expectedTotal) {
  return {
    parent: { name: 'Test Parent', email: 'test.parent@example.com', phone: '555-0100' },
    students: [{ name: 'Test Student', grade: '3rd', allergies: '' }],
    items: items.map((item) => Object.assign({
      monthId: '2026-11',
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

test('checkout submits the new service dates, menu meals, and existing prices', async () => {
  const beforeCalls = stripeCalls.length;
  const noonNov7 = '2026-11-07T20:00:00.000Z';

  const moved = await postAt(noonNov7, orderBody([
    { date: '2026-11-18' },
    { date: '2026-11-09' }
  ], 2000));
  assert.equal(moved.statusCode, 200);
  assert.equal(JSON.parse(moved.body).url, 'https://checkout.stripe.test/c/session_mock');
  assert.equal(stripeCalls.length, beforeCalls + 1);
  const session = stripeCalls.at(-1);
  assert.equal(session.metadata.business, 'lunch-bus');
  assert.equal(session.customer_email, 'test.parent@example.com');
  const rows = parseRows(session.metadata);
  assert.deepEqual(rows.map((r) => [r.date, r.meal, r.cents]), [
    ['2026-11-18', 'Hot Dogs and Fries', 1000],
    ['2026-11-09', 'Corn Dogs and Fries', 1000]
  ]);
  assert.deepEqual(session.line_items.map((li) => li.price_data.product_data.name), [
    'Wed, Nov 18: Hot Dogs and Fries',
    'Mon, Nov 9: Corn Dogs and Fries'
  ]);
  assert.equal(session.line_items[0].price_data.unit_amount, 1000);
  assert.equal(JSON.stringify(session).includes('TAMPERED'), false);
  assert.equal(JSON.stringify(session).includes('2026-11-10'), false);
  assert.equal(JSON.stringify(session).includes('2026-11-19'), false);

  const early = await postAt('2026-10-31T19:00:00.000Z', orderBody([{ date: '2026-11-09' }], 800));
  assert.equal(early.statusCode, 200);
  assert.equal(parseRows(stripeCalls.at(-1).metadata)[0].cents, 800);

  const late = await postAt('2026-11-01T20:00:00.000Z', orderBody([{ date: '2026-11-09' }], 1000));
  assert.equal(late.statusCode, 200);
  assert.equal(parseRows(stripeCalls.at(-1).metadata)[0].cents, 1000);

  const stalePrice = await postAt(noonNov7, orderBody([{ date: '2026-11-09' }], 800));
  assert.equal(stalePrice.statusCode, 409);
  assert.equal(stripeCalls.length, beforeCalls + 3);

  const other = await postAt(noonNov7, orderBody([{
    date: '2026-11-17',
    choice: 'Bacon'
  }], 1000));
  assert.equal(other.statusCode, 200);
  assert.deepEqual(
    parseRows(stripeCalls.at(-1).metadata).map((r) => [r.date, r.meal, r.choice]),
    [['2026-11-17', 'Breakfast for Lunch!', 'Bacon']]
  );
});

test('old dates, cutoff boundaries, and malformed dates are refused before payment', async () => {
  const beforeCalls = stripeCalls.length;
  const noonNov7 = '2026-11-07T20:00:00.000Z';

  for (const date of ['2026-11-10', '2026-11-19', '2026-11-11']) {
    const res = await postAt(noonNov7, orderBody([{ date }], 1000));
    assert.equal(res.statusCode, 400, date);
    assert.match(JSON.parse(res.body).error, /No lunch is served/);
  }

  const tooLate = await postAt('2026-11-09T17:00:00.000Z', orderBody([{ date: '2026-11-09' }], 1000));
  assert.equal(tooLate.statusCode, 400);
  assert.match(JSON.parse(tooLate.body).error, /Monday, November 9/);
  assert.match(JSON.parse(tooLate.body).error, /9 am on the day it is served/);

  const stillOpen = await postAt('2026-11-09T16:59:00.000Z', orderBody([
    { date: '2026-11-09' },
    { date: '2026-11-18' }
  ], 2000));
  assert.equal(stillOpen.statusCode, 200);

  const hotDogCloses = await postAt('2026-11-18T17:00:00.000Z', orderBody([{ date: '2026-11-18' }], 1000));
  assert.equal(hotDogCloses.statusCode, 400);
  assert.match(JSON.parse(hotDogCloses.body).error, /Wednesday, November 18/);

  const hotDogOpen = await postAt('2026-11-18T16:59:00.000Z', orderBody([{ date: '2026-11-18' }], 1000));
  assert.equal(hotDogOpen.statusCode, 200);
  assert.equal(parseRows(stripeCalls.at(-1).metadata)[0].date, '2026-11-18');

  const garbage = await postAt(noonNov7, orderBody([{ date: '2026-11-09;2026-11-10' }], 1000));
  assert.equal(garbage.statusCode, 400);
  assert.match(JSON.parse(garbage.body).error, /cannot read/);

  assert.equal(stripeCalls.length, beforeCalls + 2);
  assert.deepEqual(networkCalls, []);
  assert.equal(originalFetch === global.fetch, false);
});

test('stored orders keep their original service dates', () => {
  const stored = {
    paymentStatus: 'paid',
    meals: [
      { date: '2026-11-10', student: 'Test Student', meal: 'Corn Dogs and Fries' },
      { date: '2026-11-19', student: 'Test Student', meal: 'Hot Dogs and Fries' }
    ]
  };
  const packed = parseRows({
    rows_0: '2026-11-10~Corn Dogs and Fries~~~~Test Student~3rd~~regular~~1000'
  });
  assert.equal(packed[0].date, '2026-11-10');
  assert.equal(packed[0].meal, 'Corn Dogs and Fries');

  const onNov7 = withNow('2026-11-07T20:00:00.000Z', () => upcomingMeals([stored]));
  assert.deepEqual(onNov7.map((m) => m.date), ['2026-11-10', '2026-11-19']);

  const onNov18 = withNow('2026-11-18T20:00:00.000Z', () => upcomingMeals([stored]));
  assert.deepEqual(onNov18.map((m) => m.date), ['2026-11-19']);

  const ics = buildCalendar({
    id: 'cs_test_historical',
    meals: stored.meals
  });
  assert.match(ics, /DTSTART;VALUE=DATE:20261110/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261119/);
  assert.doesNotMatch(ics, /DTSTART;VALUE=DATE:20261109/);
  assert.doesNotMatch(ics, /DTSTART;VALUE=DATE:20261118/);
  assert.equal(dateLabel('2026-11-10'), 'Tue, Nov 10');
  assert.equal(dateLabel('2026-11-19'), 'Thu, Nov 19');
});
