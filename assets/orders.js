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

  /* ---------- a list of meals, one line each ---------- */

  function mealLine(meal, showStudent) {
    const add = extras(meal);
    return el('div', { class: 'review-line' },
      el('span', { class: 'when' }, meal.dateLabel),
      el('span', { class: 'what' },
        mealTitle(meal),
        showStudent ? el('span', { class: 'extras' }, 'For ' + who(meal)) : null,
        add ? el('span', { class: 'extras' }, add) : null,
        meal.request ? el('span', { class: 'extras' }, 'Request: ' + meal.request) : null),
      el('span', {}, money(meal.amount)));
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

    box.replaceChildren(...[
      el('h2', { class: 'section-head' }, `${lunches(order.meals.length)} ordered`),
      paid ? null : el('p', { class: 'portal-pending' },
        'Your bank payment is still processing. These lunches are held for you and we will confirm by email once it clears.'),
      [...byStudent.entries()].map(([name, meals]) => el('div', { class: 'review-group' },
        el('h3', {}, name,
          el('span', { class: 'group-sum' },
            `${meals.length} ${meals.length === 1 ? 'meal' : 'meals'}, ${money(meals.reduce((s, m) => s + m.amount, 0))}`)),
        el('div', { class: allergyClass('review-line portal-allergy-line', meals[0]) }, allergyText(meals[0])),
        meals.map((m) => mealLine(m, false)))),
      el('div', { class: 'totals' }, el('span', {}, paid ? 'Total paid' : 'Total'), el('span', {}, money(order.total))),
      order.receiptUrl
        ? el('p', { class: 'portal-receipt' }, el('a', { href: order.receiptUrl, target: '_blank', rel: 'noopener' }, 'Open your Stripe receipt'))
        : null,
      el('p', {}, 'Check the allergies above. If anything is wrong, ',
        el('a', { href: 'contact.html' }, 'get in touch'), ' before the lunch date.')
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
          meals.map((m) => {
            const add = extras(m);
            return el('div', { class: 'portal-line' },
              el('h3', { class: 'mealname' }, mealTitle(m)),
              el('p', { class: 'mealdesc portal-who' }, who(m)),
              add ? el('p', { class: 'mealdesc' }, add) : null,
              m.request ? el('p', { class: 'mealdesc' }, 'Request: ' + m.request) : null,
              el('p', { class: allergyClass('portal-allergy', m) }, allergyText(m)));
          })));
    }

    function upcoming(meals) {
      if (!meals.length) {
        return el('p', { class: 'cart-empty' }, 'No lunches coming up. ',
          el('a', { href: 'index.html' }, 'Pick meals on the order page'), '.');
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
      return el('div', { class: 'review-group' },
        el('h3', {}, `Placed ${placed}`,
          el('span', { class: 'group-sum' }, `${lunches(order.meals.length)}, ${money(order.total)}`)),
        el('div', { class: 'review-line portal-order-meta' },
          el('span', { class: paid ? 'portal-paid' : 'portal-pending-tag' }, paid ? 'Paid' : 'Payment processing'),
          order.receiptUrl
            ? el('a', { href: order.receiptUrl, target: '_blank', rel: 'noopener' }, 'Open receipt')
            : null),
        el('details', {},
          el('summary', {}, `Show the ${lunches(order.meals.length)}`),
          order.meals.map((m) => mealLine(m, true))));
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

  const summary = document.getElementById('orderSummary');
  if (summary) showConfirmation(summary);

  const root = document.getElementById('portal');
  if (root) portal(root);
})();
