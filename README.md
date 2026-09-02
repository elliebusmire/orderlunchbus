# Lunch Bus

Monthly hot lunch pre-ordering for Holy Trinity Catholic School. Static site, Netlify functions, Stripe Checkout, Zapier into Google Sheets. Same shape as Porchside Drop.

## What lives where

| File | What it does |
|---|---|
| `data/menus.json` | Every menu, every price, every deadline. This is the only file you touch most months. |
| `index.html` | The calendar and the cart. |
| `menus.html` | Archive of published menus, past and upcoming. |
| `faq.html`, `contact.html` | Plain content pages. Edit the text directly. |
| `assets/app.js` | Calendar rendering and cart. Display prices only. |
| `netlify/functions/create-checkout.js` | Recalculates every price from `menus.json` and creates the Stripe session. |
| `netlify/functions/stripe-webhook.js` | On payment, splits the order into one row per meal and posts each to Zapier. |

## First-time setup

1. Push this to a new GitHub repo called `lunch-bus`.
2. In Netlify, add a new site from that repo. No build command needed.
3. Add these environment variables under Site settings, Environment variables:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `ZAPIER_WEBHOOK_URL`
4. In Stripe, go to Settings, then Payment methods, and switch on Apple Pay and Google Pay. Stripe Checkout renders them with no code changes, but only if they are enabled on the account. Card is on by default.
5. In Stripe, add a webhook endpoint pointing at `https://yoursite.com/.netlify/functions/stripe-webhook`, subscribed to `checkout.session.completed`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
6. In Zapier, make a Catch Hook that appends a row to the Lunch Bus Orders sheet. Paste its URL into `ZAPIER_WEBHOOK_URL`.

## Set up the Google Sheet first

Put these headers in row 1 of Sheet1, in this order, before you connect Zapier. Zapier maps by field name and it is much less painful when the columns already exist.

```
order_id | ordered_at | parent_name | parent_email | parent_phone |
student_name | grade | allergies | service_date | meal | choice |
leave_off | special_request | portion | add_ons | line_total | payment_status
```

One row per meal per student. A parent buying eight lunches for two kids creates sixteen rows. To get a prep list for a given day, filter `service_date`. To see one family's whole order, filter `order_id`. On pizza and sandwich days, count the `choice` column to know how much pepperoni and how much turkey to buy.

## Publishing next month's menu

Open `data/menus.json`, add a block to `months`, commit. Netlify redeploys in under a minute.

```json
{
  "id": "2026-11",
  "label": "November 2026",
  "published": true,
  "ordersCloseOn": "2026-10-24",
  "days": [
    {
      "date": "2026-11-03",
      "meal": "Chicken Nuggets",
      "description": "Breaded nuggets with carrot sticks and ranch.",
      "tags": ["contains wheat"]
    }
  ]
}
```

Only list dates the truck actually comes. The calendar draws whatever is in `days` and ignores everything else, so you never have to declare which weekdays you serve. Set `published` to `false` while you are still drafting and nobody sees it.

### Meals with a choice

When a meal comes in two versions, add `choices` and the parent picks at order time. The pick lands in its own column in the sheet so you can count it.

```json
{
  "date": "2026-11-05",
  "meal": "Personal Pita Pizza",
  "description": "Pita crust pizza with carrots, ranch and fresh fruit.",
  "choiceLabel": "Pick a topping",
  "choices": ["Cheese", "Pepperoni"],
  "tags": ["contains wheat", "contains dairy"]
}
```

Leave `choices` out for meals that come one way. Both options cost the same. If you ever want to charge more for one, that is a different change and worth asking about.

### Customizations

Two things a parent can ask for, both free.

`removals` lists the components of that meal a parent can decline. Only what you list here can be unchecked, so a parent cannot invent a request the kitchen has not agreed to.

```json
"removals": ["Ranch", "Carrots"]
```

Every meal also gets a short free-text request box, capped at the `noteMaxLength` in `settings`. The checkout function strips the characters used in the row encoding, so a note cannot corrupt the sheet.

Notes that look like allergy reports are rejected at checkout with a message pointing the parent to the allergy field on their student. That is deliberate. The allergy field prints on the kitchen list beside every meal; a per-meal note does not carry the same weight, and a parent who types a severe allergy into a request box may believe they have told you when they have not.

Once `ordersCloseOn` passes, the month goes read-only on its own. The checkout function checks the same date, so a stale browser tab cannot sneak a late order through.

## Pricing, and the two ordering windows

The monthly deadline sets the price. It does not close ordering.

| When a parent orders | Price per meal |
|---|---|
| On or before `ordersCloseOn` | `mealPrice` |
| After `ordersCloseOn` | `latePrice` |

Availability is handled separately and per meal. A meal disappears from the calendar `lateCutoffDays` before it is served, so nobody can order food that is already being shopped for. Set that number to whatever lead time you actually need.

Each meal is priced at the moment it is ordered. A parent who pre-orders in September and adds a meal in October pays $8 for the first and $10 for the second, and the earlier ones are never repriced.

The browser sends its expected total with every checkout. If the server disagrees, most likely because the deadline passed while the parent had the page open, the order is refused with a message telling them to refresh. Nobody gets charged a price they were not shown.

Edit `settings` in `data/menus.json`. Amounts are in cents.

```json
"mealPrice": 800,
"latePrice": 1000,
"lateCutoffDays": 2,
"doublePortionPrice": 200,
"addOns": [
  { "id": "milk", "label": "Milk", "price": 200 },
  { "id": "juice", "label": "Juice box", "price": 200 }
]
```

## Running it locally

```
npm install
npx netlify dev
```

Use a Stripe test key and `npx stripe listen --forward-to localhost:8888/.netlify/functions/stripe-webhook` to exercise the whole path without real money.

## Before you go live

- Swap the placeholder email and phone in `contact.html` and in `settings` in `menus.json`.
- Decide whether Lunch Bus gets its own Stripe account. If it shares Porchside Drop's, parents will see Porchside on their card statement.
- Place a real order with a test card and confirm the sheet fills in correctly.
- Check the page on a phone. Most parents will order from the pickup line.
