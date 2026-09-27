/* Parent-facing order views.
   On thanks.html it shows the order that just went through.
   On portal.html it handles sign-in and lists every order for the family.
   Everything a parent typed is inserted as text, never as markup. */

(function () {
  const money = (cents) => '$' + (Number(cents || 0) / 100).toFixed(2).replace(/\.00$/, '');

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (value == null || value === false) return;
      if (key === 'class') node.className = value;
      else node.setAttribute(key, value);
    });
    children.flat().forEach((child) => {
      if (child == null || child === false || child === '') return;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  const parse = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  };

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 'es'}`;
  const lunches = (n) => plural(n, 'lunch');
  const items = (n) => `${n} item${n === 1 ? '' : 's'}`;

  /* Pickup and cancellation wording lives in data/menus.json with the event,
     so the confirmation page can never disagree with the order page. The
     text already in thanks.html stays if the file does not load. */
  async function fillEventCopy(eventId) {
    try {
      const data = await (await fetch('data/menus.json')).json();
      const ev = (data.events || []).find((e) => e.id === eventId);
      if (!ev) return;
      ['pickup', 'policy'].forEach((key) => {
        const node = document.querySelector(`[data-event="${key}"]`);
        if (node && ev[key]) node.textContent = ev[key];
      });
    } catch {
      /* Static copy stands. */
    }
  }

  const who = (meal) => (meal.grade ? `${meal.student}, ${meal.grade}` : meal.student);

  const mealTitle = (meal) => (meal.choice ? `${meal.meal} (${meal.choice})` : meal.meal);

  function extras(meal) {
    const list = [];
    (meal.leaveOff || []).forEach((r) => list.push('no ' + r.toLowerCase()));
    if (meal.double) list.push('double portion');
    (meal.addOns || []).forEach((a) => list.push(a.toLowerCase()));
    return list.join(', ');
  }

  const allergyText = (meal) => `Allergies: ${meal.allergies || 'none listed'}`;

  // Real allergies stand out in red; "None" and blanks stay quiet.
  const hasAllergy = (meal) => !/^(|none|no|n\/?a|nope|nothing)\.?$/i.test(String(meal.allergies || '').trim());
  const allergyClass = (base, meal) => base + (hasAllergy(meal) ? ' is-allergy' : '');

  /* Event orders hold one row per item, so four identical plates arrive as
     four rows. Folded into one line with a count for display. School orders
     never repeat a student on a date, so this leaves them as they were. */
  function collapse(meals) {
    const out = [];
    const byKey = new Map();
    meals.forEach((m) => {
      const key = JSON.stringify([m.date, m.student, m.meal, m.choice, m.leaveOff, m.request, m.double, m.addOns, m.amount, m.pickup]);
      if (byKey.has(key)) {
        byKey.get(key).count += 1;
      } else {
        const copy = Object.assign({}, m, { count: 1 });
        byKey.set(key, copy);
        out.push(copy);
      }
    });
    return out;
  }

  const counted = (meal, text) => (meal.count > 1 ? `${meal.count} \u00d7 ${text}` : text);

  /* ---------- a list of meals, one line each ---------- */

  function mealLine(meal, showStudent) {
    const add = extras(meal);
    return el('div', { class: 'review-line' },
      el('span', { class: 'when' }, meal.dateLabel),
      el('span', { class: 'what' },
        counted(meal, mealTitle(meal)),
        showStudent ? el('span', { class: 'extras' }, 'For ' + who(meal)) : null,
        showStudent && meal.pickup ? el('span', { class: 'extras' }, 'Pickup at ' + meal.pickup) : null,
        add ? el('span', { class: 'extras' }, add) : null,
        meal.request ? el('span', { class: 'extras' }, 'Request: ' + meal.request) : null),
      el('span', {}, money(meal.amount * (meal.count || 1))));
  }

  /* ---------- thanks.html ---------- */

  async function showConfirmation(box) {
    const session = new URLSearchParams(location.search).get('session');
    if (!session) return;

    let order;
    try {
      const res = await fetch('/.netlify/functions/order-summary?session=' + encodeURIComponent(session));
      if (!res.ok) return; // The static copy on the page still stands.
      order = (await res.json()).order;
    } catch {
      return;
    }

    const byStudent = new Map();
    order.meals.forEach((m) => {
      const key = who(m);
      if (!byStudent.has(key)) byStudent.set(key, []);
      byStudent.get(key).push(m);
    });

    const paid = order.paymentStatus === 'paid';
    const isEvent = order.kind === 'event';

    if (isEvent) showEventCopy(order.eventId);

    const heading = isEvent
      ? `${items(order.meals.length)} for pickup${order.eventName ? ' at ' + order.eventName : ''}`
      : `${lunches(order.meals.length)} ordered`;

    box.replaceChildren(...[
      el('h2', { class: 'section-head' }, heading),
      paid ? null : el('p', { class: 'portal-pending' },
        'Your bank payment is still processing. These lunches are held for you and we will confirm by email once it clears.'),
      [...byStudent.entries()].map(([name, meals]) => el('div', { class: 'review-group' },
        el('h3', {}, isEvent ? 'Pickup name: ' + name : name,
          el('span', { class: 'group-sum' },
            `${meals.length} ${isEvent ? (meals.length === 1 ? 'item' : 'items') : (meals.length === 1 ? 'meal' : 'meals')}, ${money(meals.reduce((s, m) => s + m.amount, 0))}`)),
        isEvent && meals[0].pickup ? el('div', { class: 'review-line portal-pickup-line' }, 'Pickup at ' + meals[0].pickup) : null,
        el('div', { class: allergyClass('review-line portal-allergy-line', meals[0]) }, allergyText(meals[0])),
        collapse(meals).map((m) => mealLine(m, false)))),
      order.taxCents > 0
        ? el('div', { class: 'portal-tax-line' },
          el('span', {}, order.taxLabel || 'Sales tax'), el('span', {}, money(order.taxCents)))
        : null,
      el('div', { class: 'totals' }, el('span', {}, paid ? 'Total paid' : 'Total'), el('span', {}, money(order.total))),
      order.receiptUrl
        ? el('p', { class: 'portal-receipt' }, el('a', { href: order.receiptUrl, target: '_blank', rel: 'noopener' }, 'Open your Stripe receipt'))
        : null,
      el('p', {}, 'Check the allergies above. If anything is wrong, ',
        el('a', { href: 'contact.html' }, 'get in touch'), isEvent ? ' before the meet.' : ' before the lunch date.')
    ].flat().filter(Boolean));
  }

  /* ---------- portal.html ---------- */

  function portal(root) {
    const render = (...nodes) => root.replaceChildren(...nodes.flat().filter(Boolean));

    function signIn(message) {
      const input = el('input', { type: 'email', id: 'portalEmail', autocomplete: 'email', placeholder: 'you@example.com', required: true });
      const button = el('button', { class: 'btn primary', type: 'submit' }, 'Email me a sign-in link');
      const status = el('div');
      const form = el('form', { novalidate: true },
        el('label', { for: 'portalEmail' }, 'Email you used at checkout'),
        el('div', { class: 'notify-row' }, input, button),
        status);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = input.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
          status.replaceChildren(el('p', { class: 'error', role: 'alert' }, 'Enter the email address you used at checkout.'));
          input.focus();
          return;
        }
        button.disabled = true;
        button.textContent = 'Sending';
        try {
          const res = await fetch('/.netlify/functions/portal-request-link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'The link did not send. Try again in a minute.');
          }
          const again = el('button', { class: 'btn ghost', type: 'button' }, 'Use a different email');
          again.addEventListener('click', () => signIn());
          render(el('div', { class: 'panel' },
            el('h3', {}, 'Check your email'),
            el('p', {}, `If ${email} has Lunch Bus orders, a sign-in link is on its way. It works for 30 minutes.`),
            el('p', {}, 'Nothing after a few minutes? Check your spam folder, or try the address your Stripe receipt went to.'),
            again));
        } catch (err) {
          status.replaceChildren(el('p', { class: 'error', role: 'alert' }, err.message));
          button.disabled = false;
          button.textContent = 'Email me a sign-in link';
        }
      });

      render(
        message ? el('p', { class: 'portal-notice' }, message) : null,
        el('div', { class: 'panel' },
          el('h3', {}, 'Sign in with your email'),
          el('p', {}, 'No password needed. We will send a link to the address you used when you paid.'),
          form));
    }

    function ticket(date, meals) {
      const d = parse(date);
      return el('article', { class: 'ticket portal-ticket' },
        el('span', { class: 'daynum' },
          el('span', { class: 'dow' }, d.toLocaleDateString('en-US', { weekday: 'short' })),
          d.getDate()),
        el('div', { class: 'portal-lines' },
          collapse(meals).map((m) => {
            const add = extras(m);
            return el('div', { class: 'portal-line' },
              el('h3', { class: 'mealname' }, counted(m, mealTitle(m))),
              el('p', { class: 'mealdesc portal-who' }, who(m)),
              m.pickup ? el('p', { class: 'mealdesc' }, 'Pickup at ' + m.pickup) : null,
              add ? el('p', { class: 'mealdesc' }, add) : null,
              m.request ? el('p', { class: 'mealdesc' }, 'Request: ' + m.request) : null,
              el('p', { class: allergyClass('portal-allergy', m) }, allergyText(m)));
          })));
    }

    function upcoming(meals) {
      if (!meals.length) {
        return el('p', { class: 'cart-empty' }, 'No lunches coming up. ',
          el('a', { href: 'holy-trinity.html' }, 'Pick meals on the order page'), '.');
      }
      const months = new Map();
      meals.forEach((m) => {
        const label = parse(m.date).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        if (!months.has(label)) months.set(label, new Map());
        const days = months.get(label);
        if (!days.has(m.date)) days.set(m.date, []);
        days.get(m.date).push(m);
      });
      return [...months.entries()].map(([label, days]) => el('div', { class: 'week' },
        el('h4', { class: 'week-label' }, label),
        el('div', { class: 'week-days' }, [...days.entries()].map(([date, list]) => ticket(date, list)))));
    }

    function orderGroup(order) {
      const placed = new Date(order.placedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const paid = order.paymentStatus === 'paid';
      const count = order.kind === 'event' ? items(order.meals.length) : lunches(order.meals.length);
      return el('div', { class: 'review-group' },
        el('h3', {}, order.kind === 'event' && order.eventName ? `${order.eventName}, placed ${placed}` : `Placed ${placed}`,
          el('span', { class: 'group-sum' }, `${count}, ${money(order.total)}`)),
        el('div', { class: 'review-line portal-order-meta' },
          el('span', { class: paid ? 'portal-paid' : 'portal-pending-tag' }, paid ? 'Paid' : 'Payment processing'),
          order.receiptUrl
            ? el('a', { href: order.receiptUrl, target: '_blank', rel: 'noopener' }, 'Open receipt')
            : null),
        el('details', {},
          el('summary', {}, `Show the ${count}`),
          collapse(order.meals).map((m) => mealLine(m, true))));
    }

    function signedIn(data) {
      const out = el('button', { class: 'remove', type: 'button' }, 'Sign out');
      out.addEventListener('click', async () => {
        await fetch('/.netlify/functions/portal-logout', { method: 'POST' }).catch(() => {});
        signIn('You are signed out.');
      });

      render(
        el('p', { class: 'portal-signedin' }, `Signed in as ${data.email}. `, out),
        el('h2', { class: 'section-head' }, 'Coming up'),
        upcoming(data.upcoming),
        el('h2', { class: 'section-head' }, 'Orders and receipts'),
        data.orders.length
          ? data.orders.map(orderGroup)
          : el('p', { class: 'cart-empty' }, 'No orders under this email yet.'),
        el('p', { class: 'portal-help' }, 'Something look wrong? ', el('a', { href: 'contact.html' }, 'Get in touch'),
          ' with the student name and the date, and we will sort it out.'));
    }

    async function load() {
      const params = new URLSearchParams(location.search);
      if (params.get('link') === 'expired') {
        history.replaceState(null, '', 'portal.html');
        return signIn('That sign-in link has expired. Enter your email for a new one.');
      }
      try {
        const res = await fetch('/.netlify/functions/portal-orders', { credentials: 'same-origin' });
        if (res.status === 401) return signIn();
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        signedIn(data);
      } catch (err) {
        render(el('p', { class: 'error', role: 'alert' }, err.message || 'Your orders did not load. Refresh the page in a moment.'));
      }
    }

    load();
  }

  function showEventCopy(eventId) {
    const lunchCopy = document.getElementById('lunchCopy');
    const eventCopy = document.getElementById('eventCopy');
    if (!eventCopy || !eventCopy.hidden) return;
    if (lunchCopy) lunchCopy.hidden = true;
    eventCopy.hidden = false;
    fillEventCopy(eventId);
  }

  const summary = document.getElementById('orderSummary');
  if (summary) {
    // Event checkouts return with for=event, so the right wording shows at once
    // and stays right even if the order details fail to load.
    const params = new URLSearchParams(location.search);
    if (params.get('for') === 'event') showEventCopy(params.get('event') || '');
    showConfirmation(summary);
  }

  const root = document.getElementById('portal');
  if (root) portal(root);
})();
