/* Lunch Bus ordering.
   Prices shown here are for display only. The Netlify function recalculates
   every line from data/menus.json before it talks to Stripe, so editing
   anything in the browser will not change what a parent is charged. */

const state = {
  data: null,
  monthId: null,
  students: [],
  activeStudent: 0,
  cart: [],
  pending: null
};

const money = (cents) => '$' + (cents / 100).toFixed(2).replace(/\.00$/, '');

const parseDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const dayLabel = (iso) =>
  parseDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

const isoOf = (d) => {
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

const todayISO = () => isoOf(new Date());

const shiftDays = (iso, n) => {
  const d = parseDate(iso);
  d.setDate(d.getDate() + n);
  return isoOf(d);
};

/* The deadline sets the price, not whether ordering is possible.
   Each meal separately stops being orderable a few days before it is served. */
const lastOrderDate = (dayDate) =>
  shiftDays(dayDate, -(state.data.settings.lateCutoffDays || 2));

const isLate = (month) => todayISO() > month.ordersCloseOn;

const priceFor = (month) =>
  isLate(month) ? state.data.settings.latePrice : state.data.settings.mealPrice;

const canOrder = (month, day) =>
  month.published && todayISO() <= lastOrderDate(day.date);

const monthHasOpenDays = (month) =>
  month.published && month.days.some((d) => canOrder(month, d));

async function boot() {
  const res = await fetch('data/menus.json');
  state.data = await res.json();

  const open = state.data.months.filter(monthHasOpenDays);
  const fallback = state.data.months.filter((m) => m.published);
  state.monthId = (open[0] || fallback[fallback.length - 1]).id;

  restore();
  renderStudents();
  renderMonth();
  renderCart();
  wireStudentForm();
  wireDialog();
}

/* ---------- persistence (in-memory for the session only) ---------- */

function restore() {
  if (state.students.length === 0) {
    state.students.push({ name: '', grade: '', allergies: '' });
  }
}

/* ---------- students ---------- */

function renderStudents() {
  const wrap = document.getElementById('studentChips');
  wrap.innerHTML = '';

  state.students.forEach((s, i) => {
    if (!s.name) return;
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.setAttribute('aria-pressed', String(i === state.activeStudent));
    b.textContent = s.grade ? `${s.name} (${s.grade})` : s.name;
    b.onclick = () => {
      state.activeStudent = i;
      renderStudents();
      renderMonth();
    };
    wrap.appendChild(b);
  });

  const hasStudent = state.students.some((x) => x.name);
  const form = document.getElementById('studentForm');
  if (!hasStudent) form.classList.add('open');

  const banner = document.getElementById('needsStudent');
  if (banner) banner.hidden = hasStudent;

  const add = document.createElement('button');
  add.className = 'chip add';
  add.type = 'button';
  add.textContent = state.students.some((s) => s.name) ? 'Add another student' : 'Add a student';
  add.onclick = () => document.getElementById('studentForm').classList.add('open');
  wrap.appendChild(add);
}

function wireStudentForm() {
  document.getElementById('saveStudent').onclick = () => {
    const name = document.getElementById('sName').value.trim();
    const grade = document.getElementById('sGrade').value;
    const allergies = document.getElementById('sAllergies').value.trim();
    if (!name) {
      document.getElementById('sName').focus();
      return;
    }
    const slot = state.students.findIndex((s) => !s.name);
    const student = { name, grade, allergies };
    if (slot >= 0) {
      state.students[slot] = student;
      state.activeStudent = slot;
    } else {
      state.students.push(student);
      state.activeStudent = state.students.length - 1;
    }
    document.getElementById('sName').value = '';
    document.getElementById('sAllergies').value = '';
    document.getElementById('studentForm').classList.remove('open');
    renderStudents();
    renderMonth();
  };

  const grade = document.getElementById('sGrade');
  state.data.settings.grades.forEach((g) => {
    const o = document.createElement('option');
    o.value = g;
    o.textContent = g;
    grade.appendChild(o);
  });
}

/* ---------- calendar ---------- */

function currentMonth() {
  return state.data.months.find((m) => m.id === state.monthId);
}

function renderMonth() {
  const month = currentMonth();
  const grid = document.getElementById('grid');
  const head = document.getElementById('monthName');
  const notice = document.getElementById('deadline');

  head.textContent = month.label;

  const s = state.data.settings;
  if (!monthHasOpenDays(month)) {
    notice.className = 'deadline closed';
    notice.textContent = `Ordering has closed for ${month.label}`;
  } else if (isLate(month)) {
    notice.className = 'deadline late';
    notice.textContent = `Pre-order deadline passed. Meals are now ${money(s.latePrice)} each.`;
  } else {
    notice.className = 'deadline';
    notice.textContent = `Pre-order by ${dayLabel(month.ordersCloseOn)} and pay ${money(s.mealPrice)} a meal`;
  }

  renderMonthSwitch();

  grid.innerHTML = '';
  if (month.days.length === 0) {
    grid.innerHTML = '<p class="empty-state">This month has not been published yet.</p>';
    return;
  }

  // Pad the first week so meals land under the right weekday column.
  const weekday = parseDate(month.days[0].date).getDay(); // 1 = Mon
  const firstWeekday = weekday >= 1 && weekday <= 5 ? weekday : 1;
  for (let i = 1; i < firstWeekday; i++) {
    const pad = document.createElement('div');
    pad.className = 'ticket empty';
    grid.appendChild(pad);
  }

  month.days.forEach((day) => grid.appendChild(ticket(day, month)));
}

function renderMonthSwitch() {
  const wrap = document.getElementById('monthSwitch');
  wrap.innerHTML = '';
  state.data.months
    .filter((m) => m.published)
    .forEach((m) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.setAttribute('aria-pressed', String(m.id === state.monthId));
      b.textContent = m.label.replace(' 2026', '') +
        (monthHasOpenDays(m) && isLate(m) ? ' (late)' : '');
      b.onclick = () => {
        state.monthId = m.id;
        renderMonth();
      };
      wrap.appendChild(b);
    });
}

function ticket(day, month) {
  const el = document.createElement('article');
  el.className = 'ticket';
  const isPast = day.date < todayISO();
  if (isPast) el.classList.add('past');

  const student = state.students[state.activeStudent];
  const already = state.cart.some(
    (c) => c.date === day.date && c.studentIndex === state.activeStudent
  );

  const tags = (day.tags || [])
    .map((t) => `<span class="tag${t === 'vegetarian' ? ' veg' : ''}">${t}</span>`)
    .join('');

  el.innerHTML = `
    <span class="daynum">${parseDate(day.date).getDate()}</span>
    <h3 class="mealname">${day.meal}</h3>
    <p class="mealdesc">${day.description}</p>
    <div class="tags">${tags}</div>
    <div class="ticket-actions"></div>
  `;

  const actions = el.querySelector('.ticket-actions');
  const btn = document.createElement('button');
  btn.className = 'add-btn';
  btn.type = 'button';

  if (isPast) {
    btn.disabled = true;
    btn.textContent = 'Already served';
  } else if (!canOrder(month, day)) {
    btn.disabled = true;
    btn.textContent = 'Too late to order';
  } else if (!student || !student.name) {
    btn.disabled = true;
    btn.textContent = 'Add a student above';
  } else if (already) {
    btn.disabled = true;
    btn.textContent = 'Added';
  } else {
    btn.textContent = `Add for ${money(priceFor(month))}`;
    btn.onclick = () => openDialog(day);
  }

  actions.appendChild(btn);
  if (already) {
    const note = document.createElement('p');
    note.className = 'added-note';
    note.textContent = `Added for ${student.name}`;
    actions.appendChild(note);
  }

  return el;
}

/* ---------- meal dialog ---------- */

function openDialog(day) {
  state.pending = day;
  const dlg = document.getElementById('mealDialog');
  const student = state.students[state.activeStudent];

  document.getElementById('dlgMeal').textContent = day.meal;
  document.getElementById('dlgWho').textContent =
    `${dayLabel(day.date)} for ${student.name}`;
  document.getElementById('dlgDesc').textContent = day.description;

  const opts = document.getElementById('dlgOptions');
  opts.innerHTML = '';

  if (day.choices && day.choices.length) {
    const head = document.createElement('p');
    head.innerHTML = `<strong>${day.choiceLabel || 'Pick one'}</strong>`;
    head.style.margin = '0.6rem 0 0';
    opts.appendChild(head);

    day.choices.forEach((choice, i) => {
      const row = document.createElement('div');
      row.className = 'opt-row';
      row.innerHTML = `
        <input type="radio" name="mealchoice" id="ch_${i}" value="${choice}" ${i === 0 ? 'checked' : ''}>
        <label for="ch_${i}">${choice}</label>
      `;
      opts.appendChild(row);
    });
  }

  if (day.removals && day.removals.length) {
    const head = document.createElement('p');
    head.innerHTML = '<strong>Leave anything off?</strong>';
    head.style.margin = '0.9rem 0 0';
    opts.appendChild(head);

    day.removals.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'opt-row';
      row.innerHTML = `
        <input type="checkbox" id="rm_${i}" data-group="removal" value="${r}">
        <label for="rm_${i}">No ${r.toLowerCase()}</label>
      `;
      opts.appendChild(row);
    });
  }

  opts.appendChild(
    optionRow('double', 'double', 'Double portion', state.data.settings.doublePortionPrice)
  );
  state.data.settings.addOns.forEach((a) => {
    opts.appendChild(optionRow('addon', a.id, a.label, a.price));
  });

  const noteWrap = document.createElement('div');
  noteWrap.style.marginTop = '1rem';
  noteWrap.innerHTML = `
    <label for="dlgNote">Special request (optional)</label>
    <textarea id="dlgNote" rows="2" maxlength="${state.data.settings.noteMaxLength}"
      placeholder="Sauce on the side"></textarea>
    <p style="font-size:0.78rem;color:var(--moss);margin:0.35rem 0 0">${state.data.settings.notePrompt}</p>
  `;
  opts.appendChild(noteWrap);

  dlg.showModal();
}

function optionRow(group, id, label, price) {
  const row = document.createElement('div');
  row.className = 'opt-row';
  row.innerHTML = `
    <input type="checkbox" id="opt_${id}" data-group="${group}" value="${id}">
    <label for="opt_${id}">${label} <strong>+${money(price)}</strong></label>
  `;
  return row;
}

function wireDialog() {
  const dlg = document.getElementById('mealDialog');

  document.getElementById('dlgCancel').onclick = () => dlg.close();

  document.getElementById('dlgAdd').onclick = () => {
    const double = document.querySelector('#dlgOptions input[value="double"]').checked;
    const addOns = Array.from(
      document.querySelectorAll('#dlgOptions input[data-group="addon"]:checked')
    ).map((i) => i.value);

    const picked = document.querySelector('#dlgOptions input[name="mealchoice"]:checked');
    const removals = Array.from(
      document.querySelectorAll('#dlgOptions input[data-group="removal"]:checked')
    ).map((i) => i.value);
    const noteEl = document.getElementById('dlgNote');
    const note = noteEl ? noteEl.value.trim() : '';

    state.cart.push({
      removals,
      note,
      date: state.pending.date,
      monthId: state.monthId,
      meal: state.pending.meal,
      choice: picked ? picked.value : '',
      studentIndex: state.activeStudent,
      double,
      addOns
    });

    dlg.close();
    renderMonth();
    renderCart();
  };
}

/* ---------- cart ---------- */

function lineTotal(item) {
  const s = state.data.settings;
  const month = state.data.months.find((m) => m.id === item.monthId);
  let cents = month ? priceFor(month) : s.mealPrice;
  if (item.double) cents += s.doublePortionPrice;
  item.addOns.forEach((id) => {
    const a = s.addOns.find((x) => x.id === id);
    if (a) cents += a.price;
  });
  return cents;
}

function cartTotal() {
  return state.cart.reduce((sum, i) => sum + lineTotal(i), 0);
}

function renderCart() {
  const bar = document.getElementById('cartbar');
  const review = document.getElementById('review');

  if (state.cart.length === 0) {
    bar.hidden = true;
    review.innerHTML =
      '<p class="cart-empty">Nothing added yet. Pick meals from the calendar above and they will appear here.</p>';
    return;
  }

  bar.hidden = false;
  document.getElementById('cartCount').textContent =
    `${state.cart.length} ${state.cart.length === 1 ? 'lunch' : 'lunches'}`;
  document.getElementById('cartTotal').textContent = money(cartTotal());

  review.innerHTML = '';

  state.students.forEach((student, si) => {
    const lines = state.cart.filter((c) => c.studentIndex === si);
    if (lines.length === 0) return;

    const group = document.createElement('div');
    group.className = 'review-group';
    group.innerHTML = `<h3>${student.name}${student.grade ? ', ' + student.grade : ''}</h3>`;

    lines
      .sort((a, b) => a.date.localeCompare(b.date))
      .forEach((item) => {
        const extras = [];
        if (item.choice) extras.push(item.choice.toLowerCase());
        (item.removals || []).forEach((r) => extras.push('no ' + r.toLowerCase()));
        if (item.double) extras.push('double portion');
        item.addOns.forEach((id) => {
          const a = state.data.settings.addOns.find((x) => x.id === id);
          if (a) extras.push(a.label.toLowerCase());
        });

        const row = document.createElement('div');
        row.className = 'review-line';
        row.innerHTML = `
          <span class="when">${dayLabel(item.date)}</span>
          <span class="what">${item.meal}
            ${extras.length ? `<span class="extras">${extras.join(', ')}</span>` : ''}
            ${item.note ? `<span class="extras">Request: ${item.note}</span>` : ''}
          </span>
          <span>${money(lineTotal(item))}</span>
        `;
        const rm = document.createElement('button');
        rm.className = 'remove';
        rm.type = 'button';
        rm.textContent = 'Remove';
        rm.onclick = () => {
          state.cart.splice(state.cart.indexOf(item), 1);
          renderMonth();
          renderCart();
        };
        row.appendChild(rm);
        group.appendChild(row);
      });

    review.appendChild(group);
  });

  const totals = document.createElement('div');
  totals.className = 'totals';
  totals.innerHTML = `<span>Total</span><span>${money(cartTotal())}</span>`;
  review.appendChild(totals);

  review.appendChild(contactBlock());
}

function contactBlock() {
  const box = document.createElement('div');
  box.innerHTML = `
    <h3 style="margin-top:2rem">Your information</h3>
    <p style="color:var(--moss);margin-top:0">The receipt lists every meal by student and by date.</p>
    <div class="contact-grid">
      <div class="field"><label for="pName">Your name</label><input type="text" id="pName" autocomplete="name"></div>
      <div class="field"><label for="pEmail">Email</label><input type="email" id="pEmail" autocomplete="email"></div>
      <div class="field"><label for="pPhone">Phone</label><input type="tel" id="pPhone" autocomplete="tel"></div>
    </div>
    <div id="checkoutError"></div>
  `;
  const go = document.createElement('button');
  go.className = 'btn primary';
  go.type = 'button';
  go.textContent = 'Continue to payment';
  go.onclick = () => checkout(go);
  box.appendChild(go);

  const note = document.createElement('p');
  note.className = 'pay-note';
  note.textContent = 'Payment is handled by Stripe on their secure page. Your card details never touch this site.';
  box.appendChild(note);

  return box;
}

/* ---------- checkout ---------- */

async function checkout(button) {
  const err = document.getElementById('checkoutError');
  err.innerHTML = '';

  const parent = {
    name: document.getElementById('pName').value.trim(),
    email: document.getElementById('pEmail').value.trim(),
    phone: document.getElementById('pPhone').value.trim()
  };

  if (!parent.name || !parent.email) {
    err.innerHTML = '<p class="error">Enter your name and email so the receipt reaches you.</p>';
    return;
  }

  button.disabled = true;
  button.textContent = 'Opening secure checkout';

  try {
    const res = await fetch('/.netlify/functions/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, students: state.students, items: state.cart, expectedTotal: cartTotal() })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Checkout could not start.');
    window.location = data.url;
  } catch (e) {
    err.innerHTML = `<p class="error">${e.message} Try again, or email ${state.data.settings.contactEmail}.</p>`;
    button.disabled = false;
    button.textContent = 'Continue to payment';
  }
}

document.getElementById('cartJump').onclick = () => {
  document.getElementById('review').scrollIntoView({ behavior: 'smooth' });
};

boot();
