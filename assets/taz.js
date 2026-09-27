/* TAZ Swim Events ordering.
   Reads the events block of data/menus.json. Prices here are for display;
   netlify/functions/create-event-checkout.js recalculates every line from
   the same file before anything reaches Stripe. */

(function () {
  const SCHOOL_TZ = 'America/Los_Angeles';
  const MAX_QTY_PER_LINE = 20; // matches the checkout function

  const state = {
    data: null,
    event: null,
    lines: [],        // { key, itemId, picks: [[...]], qty }
    pendingItem: null,
    dlgQty: 1,
    customer: { name: '', email: '', phone: '', allergies: '', pickup: '' },
    submitting: false
  };

  const $ = (id) => document.getElementById(id);
  const money = (cents) => '$' + (cents / 100).toFixed(2).replace(/\.00$/, '');

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    });
    children.flat().forEach((c) => {
      if (c == null || c === false || c === '') return;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    });
    return node;
  }

  const parseDate = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  };

  const schoolNow = () => {
    const parts = {};
    new Intl.DateTimeFormat('en-CA', {
      timeZone: SCHOOL_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: 'numeric', hourCycle: 'h23'
    }).formatToParts(new Date()).forEach((p) => { parts[p.type] = p.value; });
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
  };

  const hourLabel = (h) => (h === 0 ? 'midnight' : h === 12 ? 'noon' : h < 12 ? `${h} am` : `${h - 12} pm`);
  const closesHour = (ev) => (ev.closesHour == null ? 12 : ev.closesHour);

  const isClosed = (ev) => {
    const now = schoolNow();
    return now.date > ev.closesOn || (now.date === ev.closesOn && now.hour >= closesHour(ev));
  };

  const isOpen = (ev) => ev.orderingOpen !== false && !isClosed(ev);

  const itemById = (id) => state.event.items.find((i) => i.id === id);

  const picksText = (item, picks) =>
    (item.options || []).map((g, gi) => g.choices.filter((c) => (picks[gi] || []).includes(c)).join(' & ')).join(' / ');

  const leaveOffText = (removals) => (removals || []).map((r) => 'no ' + r.toLowerCase()).join(', ');

  const needsDialog = (item) => (item.options && item.options.length) || (item.removals && item.removals.length);

  const lineCents = (line) => itemById(line.itemId).price * line.qty;
  const subtotal = () => state.lines.reduce((s, l) => s + lineCents(l), 0);
  // Same rounding as create-event-checkout.js, so the totals always agree.
  const tax = () => {
    const taxable = state.lines
      .filter((l) => itemById(l.itemId).taxable !== false)
      .reduce((s, l) => s + lineCents(l), 0);
    return Math.round((taxable * (state.event.taxRate || 0)) / 10000);
  };
  const total = () => subtotal() + tax();
  const units = () => state.lines.reduce((s, l) => s + l.qty, 0);
  const maxUnits = () => state.event.maxPerOrder || 40;

  /* ---------- boot ---------- */

  async function boot() {
    try {
      const res = await fetch('data/menus.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error();
      state.data = await res.json();
    } catch {
      $('eventCard').replaceChildren(el('p', { class: 'taz-empty' },
        'The menu did not load. Refresh the page, or email orderlunchbus@gmail.com.'));
      return;
    }

    const today = schoolNow().date;
    const upcoming = (state.data.events || [])
      .filter((e) => e.published && e.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));

    if (!upcoming.length) {
      $('eventCard').replaceChildren(el('div', { class: 'taz-empty' },
        el('p', {}, 'No TAZ meets are taking pre-orders right now. The next meet menu will appear here as soon as it is set.')));
      $('menuStep').hidden = true;
      $('stepPay').parentElement.hidden = true;
      return;
    }

    renderSwitch(upcoming);
    selectEvent(upcoming.find(isOpen) || upcoming[0]);
    wireDialog();
    $('cartJump').addEventListener('click', () => $('review').scrollIntoView({ behavior: 'smooth' }));
  }

  function renderSwitch(events) {
    const wrap = $('eventSwitch');
    wrap.replaceChildren();
    if (events.length < 2) return;
    events.forEach((ev) => {
      wrap.append(el('button', {
        class: 'chip', type: 'button', 'data-id': ev.id,
        onclick: () => {
          if (ev.id === state.event.id) return;
          if (state.lines.length && !window.confirm('Switching meets clears the food you have picked. Switch anyway?')) return;
          selectEvent(ev);
        }
      }, `${ev.name}, ${parseDate(ev.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`));
    });
  }

  function selectEvent(ev) {
    state.event = ev;
    state.lines = [];
    state.customer.pickup = '';
    $('eventSwitch').querySelectorAll('.chip').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.id === ev.id));
    });
    $('policy').textContent = ev.policy || '';
    renderEventCard();
    renderMenu();
    renderReview();
  }

  /* ---------- event card ---------- */

  function statusText(ev) {
    const d = parseDate(ev.closesOn).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    if (ev.orderingOpen === false) return { text: 'Pre-orders open soon', closed: true };
    if (isClosed(ev)) return { text: 'Pre-orders are closed. Order at the trailer.', closed: true };
    return { text: `Pre-order until ${hourLabel(closesHour(ev))} ${d}`, closed: false };
  }

  function renderEventCard() {
    const ev = state.event;
    const d = parseDate(ev.date);
    const st = statusText(ev);
    $('eventCard').replaceChildren(el('article', { class: 'taz-event' },
      el('div', { class: 'taz-stub' },
        el('span', { class: 'dow' }, d.toLocaleDateString('en-US', { weekday: 'short' })),
        el('span', { class: 'day' }, d.getDate()),
        el('span', { class: 'mon' }, d.toLocaleDateString('en-US', { month: 'short' }))),
      el('div', { class: 'taz-event-body' },
        el('h2', {}, ev.name),
        ev.host ? el('p', { class: 'host' }, ev.host) : null,
        ev.timeLabel ? el('p', {}, ev.timeLabel) : null,
        ev.location ? el('p', {}, ev.location) : null,
        (ev.pickupTimes && ev.pickupTimes.length)
          ? el('p', {}, `Pre-order pickup ${ev.pickupTimes[0]} to ${ev.pickupTimes[ev.pickupTimes.length - 1]}`)
          : null,
        el('p', { class: 'taz-status' + (st.closed ? ' closed' : '') }, st.text))));
  }

  /* ---------- menu ---------- */

  function renderMenu() {
    const ev = state.event;
    const open = isOpen(ev);
    const menu = $('menu');
    const card = (item) => {
      const inOrder = state.lines.filter((l) => l.itemId === item.id).reduce((s, l) => s + l.qty, 0);

      let label = `Add ${money(item.price)}`;
      let disabled = false;
      if (ev.orderingOpen === false) { label = 'Pre-orders open soon'; disabled = true; }
      else if (!open) { label = 'Pre-orders closed'; disabled = true; }
      else if (units() >= maxUnits()) { label = 'Order limit reached'; disabled = true; }
      else if (inOrder) { label = needsDialog(item) ? 'Add another' : 'Add one more'; }

      return el('article', { class: 'taz-item' },
        el('div', { class: 'taz-item-head' },
          el('h3', {}, item.name),
          el('span', { class: 'taz-price' }, money(item.price))),
        el('p', {}, item.description),
        (item.tags && item.tags.length)
          ? el('div', { class: 'tags' }, item.tags.map((t) => el('span', { class: 'tag' + (t === 'vegetarian' ? ' veg' : '') }, t)))
          : null,
        el('div', { class: 'ticket-actions' },
          el('button', {
            class: 'add-btn', type: 'button', disabled,
            onclick: () => addItem(item)
          }, label),
          inOrder ? el('p', { class: 'added-note' }, `${inOrder} in your order`) : null));
    };

    /* Items are grouped by their section, in the order the sections first
       appear in menus.json. With one section there is no heading at all. */
    const sections = [];
    ev.items.forEach((item) => {
      const name = item.section || '';
      let group = sections.find((s) => s.name === name);
      if (!group) { group = { name, items: [] }; sections.push(group); }
      group.items.push(item);
    });

    // Sections after the first (drinks, chips) are small add-ons, drawn as a
    // tighter two-column grid on phones so they don't take five screens.
    menu.replaceChildren(...sections.map((s, i) => el('div', { class: 'taz-section' },
      sections.length > 1 && s.name ? el('h3', { class: 'taz-section-head' }, s.name) : null,
      el('div', { class: 'taz-menu' + (i > 0 ? ' compact' : '') }, s.items.map(card)))));
  }

  function addItem(item) {
    if (!isOpen(state.event)) { refreshAll(); return; }
    if (needsDialog(item)) {
      openDialog(item);
      return;
    }
    // No choices to make, so one tap adds one. Quantity changes live in the review.
    addLine(item, [], [], 1);
  }

  function addLine(item, picks, removals, qty) {
    const room = maxUnits() - units();
    if (room <= 0) return false;
    const key = item.id + '|' + JSON.stringify(picks) + '|' + JSON.stringify(removals);
    const existing = state.lines.find((l) => l.key === key);
    if (existing) {
      existing.qty = Math.min(existing.qty + qty, MAX_QTY_PER_LINE, existing.qty + room);
    } else {
      state.lines.push({ key, itemId: item.id, picks, removals, qty: Math.min(qty, room) });
    }
    renderMenu();
    renderReview();
    return true;
  }

  /* ---------- dialog ---------- */

  function openDialog(item) {
    state.pendingItem = item;
    state.dlgQty = 1;
    $('dlgName').textContent = item.name;
    $('dlgDesc').textContent = `${item.description} ${money(item.price)} each.`;
    $('dlgError').textContent = '';

    const opts = $('dlgOptions');
    opts.replaceChildren();
    (item.options || []).forEach((group, gi) => {
      const need = group.pick || 1;
      opts.append(el('p', { style: 'margin:0.6rem 0 0' }, el('strong', {}, group.label)));
      group.choices.forEach((choice, ci) => {
        const id = `opt_${gi}_${ci}`;
        const input = el('input', {
          type: need === 1 ? 'radio' : 'checkbox',
          name: `group_${gi}`, id, value: choice, 'data-group': gi,
          checked: need === 1 && ci === 0
        });
        if (need > 1) input.addEventListener('change', () => limitGroup(gi, need));
        opts.append(el('div', { class: 'opt-row' }, input, el('label', { for: id }, choice)));
      });
    });

    if (item.removals && item.removals.length) {
      opts.append(el('p', { style: 'margin:0.9rem 0 0' }, el('strong', {}, 'Leave anything off?')));
      item.removals.forEach((r, ri) => {
        const id = `rm_${ri}`;
        opts.append(el('div', { class: 'opt-row' },
          el('input', { type: 'checkbox', id, value: r, 'data-removal': '1' }),
          el('label', { for: id }, 'No ' + r.toLowerCase())));
      });
    }

    updateDlgQty();
    $('itemDialog').showModal();
  }

  // Once a pick-two group has two ticked, the rest grey out until one is unticked.
  function limitGroup(gi, need) {
    const boxes = [...document.querySelectorAll(`#dlgOptions input[data-group="${gi}"]`)];
    const ticked = boxes.filter((b) => b.checked).length;
    boxes.forEach((b) => { if (!b.checked) b.disabled = ticked >= need; });
    $('dlgError').textContent = '';
  }

  function updateDlgQty() {
    const room = Math.min(MAX_QTY_PER_LINE, maxUnits() - units());
    state.dlgQty = Math.max(1, Math.min(state.dlgQty, room));
    $('dlgQty').textContent = state.dlgQty;
    $('dlgMinus').disabled = state.dlgQty <= 1;
    $('dlgPlus').disabled = state.dlgQty >= room;
  }

  function wireDialog() {
    const dlg = $('itemDialog');
    $('dlgCancel').addEventListener('click', () => dlg.close());
    $('dlgMinus').addEventListener('click', () => { state.dlgQty -= 1; updateDlgQty(); });
    $('dlgPlus').addEventListener('click', () => { state.dlgQty += 1; updateDlgQty(); });

    $('dlgAdd').addEventListener('click', () => {
      const item = state.pendingItem;
      if (!item) return;
      const picks = [];
      for (let gi = 0; gi < (item.options || []).length; gi++) {
        const group = item.options[gi];
        const need = group.pick || 1;
        const chosen = [...document.querySelectorAll(`#dlgOptions input[data-group="${gi}"]:checked`)].map((i) => i.value);
        if (chosen.length !== need) {
          $('dlgError').textContent = `${group.label} to add this.`;
          return;
        }
        picks.push(chosen);
      }
      const removals = [...document.querySelectorAll('#dlgOptions input[data-removal]:checked')].map((i) => i.value);
      addLine(item, picks, removals, state.dlgQty);
      dlg.close();
    });
  }

  /* ---------- review and pay ---------- */

  /* Every quantity change redraws the order, which would drop keyboard
     focus. Remember which control had it and put it back. */
  function keepFocus(fn) {
    const a = document.activeElement;
    const tag = a && a.dataset && a.dataset.focus;
    fn();
    if (tag) {
      const again = document.querySelector(`[data-focus="${CSS.escape(tag)}"]`);
      if (again && !again.disabled) again.focus();
    }
  }

  function stepper(line) {
    const atMax = line.qty >= MAX_QTY_PER_LINE || units() >= maxUnits();
    return el('div', { class: 'taz-stepper', role: 'group', 'aria-label': 'Quantity' },
      el('button', {
        class: 'taz-step', type: 'button', 'aria-label': 'One fewer', 'data-focus': line.key + '|minus',
        onclick: () => keepFocus(() => {
          line.qty -= 1;
          if (line.qty < 1) state.lines.splice(state.lines.indexOf(line), 1);
          renderMenu(); renderReview();
        })
      }, '\u2212'),
      el('output', {}, line.qty),
      el('button', {
        class: 'taz-step', type: 'button', 'aria-label': 'One more', disabled: atMax, 'data-focus': line.key + '|plus',
        onclick: () => keepFocus(() => { line.qty += 1; renderMenu(); renderReview(); })
      }, '+'));
  }

  function renderReview() {
    const ev = state.event;
    const review = $('review');
    const bar = $('cartbar');
    const closedBox = $('closedBox');

    if (!isOpen(ev)) {
      bar.hidden = true;
      review.replaceChildren();
      closedBox.hidden = false;
      if (ev.orderingOpen === false) {
        $('closedTitle').textContent = 'Pre-orders open soon';
        $('closedMessage').textContent = 'The menu is set. Check back here before the meet to order ahead.';
      } else {
        $('closedTitle').textContent = 'Pre-orders are closed';
        $('closedMessage').textContent = 'You can still buy food at the trailer on meet day. Walk-up orders are cooked in the order they come in.';
      }
      return;
    }
    closedBox.hidden = true;

    if (!state.lines.length) {
      bar.hidden = true;
      review.replaceChildren(el('p', { class: 'cart-empty' }, 'Nothing added yet. Tap Add on the menu above.'));
      return;
    }

    bar.hidden = false;
    $('cartCount').textContent = `${units()} ${units() === 1 ? 'item' : 'items'}`;
    $('cartTotal').textContent = money(total());

    const group = el('div', { class: 'review-group' },
      el('h3', {}, 'Your order', el('span', { class: 'group-sum' }, `${units()} ${units() === 1 ? 'item' : 'items'}`)),
      state.lines.map((line) => {
        const item = itemById(line.itemId);
        const picks = picksText(item, line.picks);
        const off = leaveOffText(line.removals);
        return el('div', { class: 'review-line' },
          el('span', { class: 'what' }, item.name,
            picks ? el('span', { class: 'extras', style: 'display:block' }, picks) : null,
            off ? el('span', { class: 'extras', style: 'display:block' }, off) : null),
          stepper(line),
          el('span', {}, money(lineCents(line))),
          el('button', {
            class: 'remove', type: 'button',
            onclick: () => { state.lines.splice(state.lines.indexOf(line), 1); renderMenu(); renderReview(); }
          }, 'Remove'));
      }));

    const limit = units() >= maxUnits()
      ? el('p', { class: 'portal-notice' }, `Pre-orders are limited to ${maxUnits()} items. Email ${state.data.settings.contactEmail} for a bigger order.`)
      : null;

    const taxLine = tax() > 0
      ? el('div', { class: 'taz-sums' },
        el('div', {}, el('span', {}, 'Subtotal'), el('span', {}, money(subtotal()))),
        el('div', {}, el('span', {}, state.event.taxLabel || 'Sales tax'), el('span', {}, money(tax()))))
      : null;

    review.replaceChildren(group, limit || '', taxLine || '',
      el('div', { class: 'totals' }, el('span', {}, 'Total'), el('span', {}, money(total()))),
      detailsBlock());
  }

  // Inputs are rebuilt on every render, so typed values live in state.
  function field(key, label, type, attrs) {
    const id = 'c_' + key;
    const input = el('input', Object.assign({ type, id, value: state.customer[key] }, attrs || {}));
    input.addEventListener('input', () => { state.customer[key] = input.value; });
    return el('div', { class: 'field' + (key === 'allergies' ? ' wide' : '') }, el('label', { for: id }, label), input);
  }

  function pickupChooser() {
    const times = state.event.pickupTimes || [];
    if (!times.length) return null;
    return el('fieldset', { class: 'taz-times', id: 'pickupTimes' },
      el('legend', {}, 'Pickup time'),
      el('div', { class: 'taz-time-row' }, times.map((t, i) => {
        const id = 'pt_' + i;
        const input = el('input', { type: 'radio', name: 'pickupTime', id, value: t, checked: state.customer.pickup === t });
        input.addEventListener('change', () => {
          state.customer.pickup = t;
          const err = $('checkoutError');
          if (err) err.replaceChildren();
        });
        return el('span', { class: 'taz-time' }, input, el('label', { for: id }, t));
      })),
      el('p', { class: 'taz-time-note' }, 'Your food is packed hot for this time. Come a little later and it will still be waiting.'));
  }

  function detailsBlock() {
    const error = el('div', { id: 'checkoutError', role: 'alert' });
    const go = el('button', { class: 'btn primary', type: 'button' }, 'Continue to payment');
    go.addEventListener('click', () => checkout(go, error));

    return el('div', {},
      el('h3', { style: 'margin-top:2rem' }, 'Pickup details'),
      el('p', { style: 'color:var(--moss);margin-top:0' }, 'We label your order with this name and call it out at the pre-order window.'),
      el('div', { class: 'contact-grid' },
        field('name', 'Name for pickup', 'text', { autocomplete: 'name', maxlength: 60 }),
        field('email', 'Email for your receipt', 'email', { autocomplete: 'email', maxlength: 120 }),
        field('phone', 'Phone (optional)', 'tel', { autocomplete: 'tel', maxlength: 30 }),
        field('allergies', 'Allergies for anyone eating this order', 'text', { maxlength: 120, placeholder: 'Dairy allergy, none' })),
      pickupChooser(),
      error,
      go,
      el('p', { class: 'pay-note' }, 'Payment is handled by Stripe on their secure page. Your card details never touch this site.'));
  }

  async function checkout(button, errBox) {
    if (state.submitting) return;
    errBox.replaceChildren();
    const c = state.customer;
    const showError = (msg) => errBox.replaceChildren(el('p', { class: 'error' }, msg));

    if (!isOpen(state.event)) { refreshAll(); return; }
    if (!c.name.trim()) { showError('Add the name we should call out at pickup.'); $('c_name').focus(); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email.trim())) { showError('Enter an email address so your receipt reaches you.'); $('c_email').focus(); return; }
    if ((state.event.pickupTimes || []).length && !state.event.pickupTimes.includes(c.pickup)) {
      showError('Choose a pickup time.');
      $('pt_0').focus();
      return;
    }

    state.submitting = true;
    button.disabled = true;
    button.textContent = 'Opening secure checkout';

    try {
      const res = await fetch('/.netlify/functions/create-event-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: state.event.id,
          customer: { name: c.name.trim(), email: c.email.trim(), phone: c.phone.trim(), allergies: c.allergies.trim(), pickup: c.pickup },
          lines: state.lines.map((l) => ({ itemId: l.itemId, picks: l.picks, removals: l.removals, qty: l.qty })),
          expectedTotal: total()
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) throw new Error(data.error || 'Checkout could not start.');
      window.location = data.url;
    } catch (e) {
      showError(`${e.message} Try again, or email ${state.data.settings.contactEmail}.`);
      state.submitting = false;
      button.disabled = false;
      button.textContent = 'Continue to payment';
    }
  }

  function refreshAll() {
    renderEventCard();
    renderMenu();
    renderReview();
  }

  /* A page left open past the cutoff updates itself instead of letting a
     parent fill in details for an order that will be refused. */
  let lastOpen = null;
  setInterval(() => {
    if (!state.event) return;
    const now = isOpen(state.event);
    if (lastOpen !== null && now !== lastOpen) refreshAll();
    lastOpen = now;
  }, 30000);

  /* Coming back with the browser Back button from Stripe restores this page
     from cache with the button still reading "Opening secure checkout". */
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) { state.submitting = false; if (state.event) renderReview(); }
  });

  boot();
})();
