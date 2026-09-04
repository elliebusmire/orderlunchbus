const Stripe = require('stripe');
const menus = require('../../data/menus.json');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const MAX_ITEMS = 100; // Stripe Checkout caps line items at 100
const CHUNK = 450;     // Stripe metadata values cap at 500 characters

/* Netlify runs in UTC. Everything about deadlines is local to the school, so
   dates are formatted in its timezone. en-CA yields YYYY-MM-DD directly,
   which avoids parsing a locale string back into a Date. */
const SCHOOL_TZ = 'America/Los_Angeles';

const todayISO = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: SCHOOL_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());

/* Every value below is joined with ~ into a row and rows are joined with ;
   so any free text must lose those characters or it will shift the columns
   of the kitchen list. Applied to ALL user text, not just some of it. */
const clean = (value, max) =>
  String(value == null ? '' : value)
    .replace(/[~;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const LIMITS = { name: 60, grade: 12, allergies: 120, parentName: 80, email: 120, phone: 30 };

const looksLikeEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);

const shiftDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return isoOf(dt);
};

/* Split a long string across numbered metadata keys so a big family order
   still fits inside Stripe's per-value limit. */
function pack(prefix, text, into) {
  for (let i = 0, n = 0; i < text.length; i += CHUNK, n++) {
    into[`${prefix}_${n}`] = text.slice(i, i + CHUNK);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Use POST.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Order could not be read.' }) };
  }

  const { parent, students, items, expectedTotal } = body;

  /* The browser hides the buttons when ordering is paused. This is the check
     that actually stops a card being charged. */
  if (menus.settings.orderingOpen === false) {
    return {
      statusCode: 503,
      body: JSON.stringify({ error: 'Ordering is not open yet. Nothing has been charged.' })
    };
  }

  if (!parent || !parent.name || !parent.email) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Name and email are required.' }) };
  }
  const parentName = clean(parent.name, LIMITS.parentName);
  const parentEmail = clean(parent.email, LIMITS.email);
  const parentPhone = clean(parent.phone, LIMITS.phone);

  if (!looksLikeEmail(parentEmail)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'That email address does not look right.' }) };
  }

  if (!Array.isArray(students) || students.length === 0 || students.length > 12) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Add between one and twelve students.' }) };
  }

  if (!Array.isArray(items) || items.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Your order is empty.' }) };
  }
  if (items.length > MAX_ITEMS) {
    return { statusCode: 400, body: JSON.stringify({ error: `Orders are limited to ${MAX_ITEMS} meals at a time. Split it into two orders.` }) };
  }

  const s = menus.settings;
  const s_noteMax = s.noteMaxLength || 80;
  const lineItems = [];
  const rows = [];
  const seen = new Set();

  for (const item of items) {
    const month = menus.months.find((m) => m.id === item.monthId);
    if (!month || !month.published) {
      return { statusCode: 400, body: JSON.stringify({ error: 'That menu is not available.' }) };
    }
    /* The deadline sets the price. Availability is governed separately, per
       meal, so nobody can order food that is about to be cooked. */
    const lastOrder = shiftDays(item.date, -(s.lateCutoffDays || 2));
    if (todayISO() > lastOrder) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `It is too late to order the meal on ${item.date}. Orders close ${s.lateCutoffDays || 2} days before each meal.` })
      };
    }

    const late = todayISO() > month.ordersCloseOn;
    const basePrice = late ? s.latePrice : s.mealPrice;

    // The menu file is the authority on what is served that day, not the browser.
    const day = month.days.find((d) => d.date === item.date);
    if (!day) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No lunch is served on one of the dates you picked.' }) };
    }

    const idx = Number(item.studentIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= students.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'A meal is attached to a student we do not recognise.' }) };
    }

    const raw = students[idx] || {};
    const student = {
      name: clean(raw.name, LIMITS.name),
      grade: clean(raw.grade, LIMITS.grade),
      allergies: clean(raw.allergies, LIMITS.allergies)
    };

    if (!student.name) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Every meal needs a student name.' }) };
    }

    // Grade comes from a fixed list; anything else is dropped rather than trusted.
    if (student.grade && !s.grades.includes(student.grade)) student.grade = '';

    const key = `${idx}|${item.date}`;
    if (seen.has(key)) {
      return { statusCode: 400, body: JSON.stringify({ error: `${student.name} has two meals on the same day.` }) };
    }
    seen.add(key);

    // Only components this meal actually offers can be removed.
    const removals = (item.removals || []).filter((r) => (day.removals || []).includes(r));

    /* Free text is capped, stripped of the delimiters used in the row encoding,
       and rejected outright if it looks like an allergy report. A note field is
       not a safe channel for that: it is not on the allergy line of the kitchen
       list, so it must not become the place parents report one. */
    const note = clean(item.note, s_noteMax);
    if (note && /allerg|epi-?pen|anaphyla|intoleran|celiac|coeliac/i.test(note)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Allergy information belongs in the allergy field on your student, not in a meal request. Please move it there so it reaches the kitchen list.'
        })
      };
    }

    const double = item.double === true;
    const addOns = (item.addOns || []).filter((id) => s.addOns.some((a) => a.id === id));

    // If the day offers a choice, one of the listed options must come back.
    let choice = '';
    if (day.choices && day.choices.length) {
      if (!day.choices.includes(item.choice)) {
        return { statusCode: 400, body: JSON.stringify({ error: `Pick an option for ${day.meal} on ${item.date}.` }) };
      }
      choice = item.choice;
    }

    let cents = basePrice;
    if (double) cents += s.doublePortionPrice;
    addOns.forEach((id) => {
      cents += s.addOns.find((a) => a.id === id).price;
    });

    const extras = [];
    if (choice) extras.push(choice.toLowerCase());
    removals.forEach((r) => extras.push('no ' + r.toLowerCase()));
    if (double) extras.push('double portion');
    addOns.forEach((id) => extras.push(s.addOns.find((a) => a.id === id).label.toLowerCase()));

    const pretty = new Date(item.date + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric'
    });

    lineItems.push({
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: cents,
        product_data: {
          name: `${pretty}: ${day.meal}${choice ? ' (' + choice + ')' : ''}`,
          description: `${student.name}${student.grade ? ', ' + student.grade : ''}${extras.length ? ' (' + extras.join(', ') + ')' : ''}${note ? ' Request: ' + note : ''}`
        }
      }
    });

    rows.push([
      item.date,
      day.meal,
      choice,
      removals.join('+'),
      note,
      student.name,
      student.grade || '',
      student.allergies || '',
      double ? 'double' : 'regular',
      addOns.join('+'),
      cents
    ].join('~'));
  }

  const serverTotal = lineItems.reduce((sum, li) => sum + li.price_data.unit_amount, 0);
  if (typeof expectedTotal === 'number' && expectedTotal !== serverTotal) {
    return {
      statusCode: 409,
      body: JSON.stringify({
        error: 'Prices changed while you were ordering, most likely because the pre-order deadline just passed. Refresh the page to see current prices before paying.'
      })
    };
  }

  const metadata = {
    // Tags the payment as ours. The Stripe account is shared with another
    // business, and webhook endpoints receive every event on the account,
    // so each side has to recognise its own.
    business: s.businessTag || 'lunch-bus',
    parent_name: parentName,
    parent_email: parentEmail,
    parent_phone: parentPhone,
    meal_count: String(rows.length)
  };
  pack('rows', rows.join(';'), metadata);

  if (Object.keys(metadata).length > 45) {
    return { statusCode: 400, body: JSON.stringify({ error: 'That order is too large to process at once. Split it into two orders.' }) };
  }

  const site = process.env.URL || 'http://localhost:8888';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      customer_email: parentEmail,
      metadata,
      payment_intent_data: {
        metadata,
        // Card charges reject statement_descriptor; the suffix is appended to
        // the account prefix set in the Stripe Dashboard. 22 chars combined.
        ...(s.statementSuffix ? { statement_descriptor_suffix: s.statementSuffix } : {})
      },
      success_url: `${site}/thanks.html?session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}/index.html`
    });

    return { statusCode: 200, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    console.error('Stripe session failed', err);
    return { statusCode: 502, body: JSON.stringify({ error: 'Payment could not start.' }) };
  }
};
