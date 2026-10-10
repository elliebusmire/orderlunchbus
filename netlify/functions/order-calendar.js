/* Calendar file for thanks.html. One all-day "Hot lunch ordered" entry per
   date, with a reminder the evening before, so families know not to pack a
   lunch. Apple Calendar and Outlook open this file directly. Google Calendar
   gets per-date links built in the browser instead. */

const { getOrder } = require('./lib/orders');

const SITE = 'orderlunchbus.com';

const text = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  body
});

// RFC 5545 text escaping, then folding so no line runs past 75 octets.
const esc = (v) => String(v == null ? '' : v)
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

function fold(line) {
  const out = [];
  let rest = Buffer.from(line, 'utf8');
  let limit = 75;
  while (rest.length > limit) {
    let cut = limit;
    while (cut > 0 && (rest[cut] & 0xc0) === 0x80) cut -= 1; // never split a character
    out.push(rest.subarray(0, cut).toString('utf8'));
    rest = rest.subarray(cut);
    limit = 74; // continuation lines start with a space
  }
  out.push(rest.toString('utf8'));
  return out.join('\r\n ');
}

const compact = (iso) => iso.replace(/-/g, '');

const nextDay = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

const mealTitle = (meal) => (meal.choice ? `${meal.meal} (${meal.choice})` : meal.meal);

function buildCalendar(order) {
  const byDate = new Map();
  order.meals.forEach((m) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date)) return;
    if (!byDate.has(m.date)) byDate.set(m.date, []);
    byDate.get(m.date).push(m);
  });

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Lunch Bus//Hot lunch//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Lunch Bus hot lunch'
  ];

  [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([date, meals]) => {
    const names = [...new Set(meals.map((m) => m.student).filter(Boolean))];
    const summary = 'Hot lunch ordered' + (names.length ? ` (${names.join(', ')})` : '');
    const details = meals.map((m) => `${m.student}: ${mealTitle(m)}`)
      .concat('', 'No need to pack a lunch. Lunch Bus delivers by grade at Holy Trinity.')
      .join('\n');

    lines.push(
      'BEGIN:VEVENT',
      `UID:${order.id}-${compact(date)}@${SITE}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${compact(date)}`,
      `DTEND;VALUE=DATE:${compact(nextDay(date))}`,
      `SUMMARY:${esc(summary)}`,
      `DESCRIPTION:${esc(details)}`,
      'LOCATION:Holy Trinity Catholic School',
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${esc('Hot lunch tomorrow. No need to pack a lunch.')}`,
      'TRIGGER:-PT3H', // 9 pm the evening before
      'END:VALARM',
      'END:VEVENT'
    );
  });

  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

exports.handler = async (event) => {
  const id = (event.queryStringParameters && event.queryStringParameters.session) || '';
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(id)) return text(400, 'This link needs the session from checkout.');

  try {
    const order = await getOrder(id);
    if (!order || !order.meals.length) return text(404, 'We could not find that order.');
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="lunch-bus-hot-lunch.ics"',
        'Cache-Control': 'no-store'
      },
      body: buildCalendar(order)
    };
  } catch (err) {
    if (err.code === 'resource_missing') return text(404, 'We could not find that order.');
    console.error('Order calendar failed', err.message);
    return text(502, 'The calendar file did not load. Try again in a moment.');
  }
};

exports.buildCalendar = buildCalendar;
