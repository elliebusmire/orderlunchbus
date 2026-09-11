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
| `netlify/functions/stripe-webhook.js` | On payment, splits the order into one row per meal and writes it to the sheet. |
| `netlify/functions/lib/rows.js` | The one description of how an order is packed into Stripe metadata. The webhook and the portal both read through it. |
| `thanks.html` | Where Stripe sends parents after paying. Shows exactly what went through, by student. |
| `portal.html`, `assets/orders.js` | My orders: sign in by email, see upcoming lunches, allergies on file, and receipts. |
| `netlify/functions/order-summary.js` | Feeds the order list on `thanks.html`. |
| `netlify/functions/portal-*.js` | Sign-in link, sign-in, order list and sign-out for My orders. |

## First-time setup

1. Push this to a new GitHub repo called `lunch-bus`.
2. In Netlify, add a new site from that repo. No build command needed.
3. Add these environment variables under Site settings, Environment variables:
   - `STRIPE_SECRET_KEY`, from the Lunch Bus Stripe account. The publishable key is not used anywhere.
   - `STRIPE_WEBHOOK_SECRET`
   - `GOOGLE_SERVICE_ACCOUNT_JSON` and `GOOGLE_SHEET_ID`, or `ZAPIER_WEBHOOK_URL` (see Writing orders to the sheet)
   - `SESSION_SECRET`, any random string of 32 or more characters. `openssl rand -hex 32` makes one. It signs the My orders sign-in links.
   - `RESEND_API_KEY` and `EMAIL_FROM` (see My orders)
4. In Stripe, go to Settings, then Payment methods, and switch on Apple Pay and Google Pay. Stripe Checkout renders them with no code changes, but only if they are enabled on the account. Card is on by default.
5. In Stripe, with the Lunch Bus account selected, add a webhook endpoint pointing at `https://orderlunchbus.com/.netlify/functions/stripe-webhook`, subscribed to `checkout.session.completed`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.
6. In Zapier, make a Catch Hook that appends a row to the Lunch Bus Orders sheet. Paste its URL into `ZAPIER_WEBHOOK_URL`.

## The Stripe account

Lunch Bus has its own Stripe account, in the same Stripe organization as Porchside Drop. Keys, webhooks, branding and receipts all belong to one account, so check the account picker says Lunch Bus before copying a key or adding a webhook.

Set these in the Lunch Bus account before taking a real order:

- **Settings, Business, Public details.** Business name Lunch Bus, statement descriptor `LUNCH BUS`, support email orderlunchbus@gmail.com. This is what parents see on their card statement.
- **Settings, Branding.** Logo and the Holy Trinity green. This heads the Stripe payment page and the emailed receipt.
- **Settings, Customer emails.** Switch on emails for successful payments. `thanks.html` tells parents a receipt is on its way, and Stripe only sends one in live mode if this is on.
- **Activation.** Business and bank details. Test mode works straight away; live payments wait for Stripe to approve the account.

Every checkout is still tagged with `metadata.business = "lunch-bus"`. The webhook and My orders only act on sessions carrying that tag, so a payment link or manual charge on the same account never reaches the kitchen sheet.

## Writing orders to the sheet

Two paths. The function prefers the first and falls back to the second.

**Direct to Google Sheets (recommended).** Set `GOOGLE_SERVICE_ACCOUNT_JSON` and `GOOGLE_SHEET_ID` and the webhook writes to the sheet itself. One API call per order however many meals it contains, no task quota, no monthly cost.

**Zapier catch hook (fallback).** Used only when the Google variables are absent. One task per meal per student, so a two-child full-month order costs 16 tasks against a 750/month plan.

### Setting up the service account

1. Go to console.cloud.google.com and create a project, or reuse one.
2. APIs & Services, Library, search for Google Sheets API, Enable.
3. APIs & Services, Credentials, Create credentials, Service account. Any name. No roles needed; access is granted by sharing the sheet, not by IAM.
4. Open the service account, Keys tab, Add key, Create new key, JSON. A file downloads.
5. Open the sheet and share it with the `client_email` from that file, with Editor access. This is the step people forget, and without it every write returns 403.
6. Base64 the key file so its multi-line private key survives a dashboard text field:

   ```
   base64 -i your-key.json | pbcopy
   ```

   Paste the result into `GOOGLE_SERVICE_ACCOUNT_JSON` in Netlify. Set `GOOGLE_SHEET_ID` to the long id from the sheet URL, between `/d/` and `/edit`. Set `GOOGLE_SHEET_TAB` only if the tab is not called `Sheet1`.

7. Redeploy. Environment variable changes do not reach a running site.

The service account key is a credential. It belongs in Netlify's environment variables and never in this repo.

### Switching between the two

Remove `GOOGLE_SERVICE_ACCOUNT_JSON` and the function falls back to Zapier on the next deploy. Nothing else changes, and the column order is identical either way.

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

## Pausing ordering

Two lines in `data/menus.json`:

```json
"orderingOpen": false,
"opensOn": "2026-09-08"
```

`orderingOpen` is the switch. `opensOn` is the date shown to parents, and it feeds the badge, the panel heading and the step 3 heading from one place so they can never disagree. Change the date and all three follow. Leave `opensOn` out and the copy falls back to "Ordering opens soon".

Opening is deliberately manual. The date does not flip the switch, because a site that starts taking payments on a schedule while Stripe is not ready is worse than one that opens a day late. On the morning of the 8th, set `orderingOpen` to `true` and commit.

The menu stays visible, every Add button is disabled, the student roster and the cart bar are hidden, and the checkout block is replaced by `closedTitle` and `closedMessage`. Set it back to `true` to reopen. Nothing else needs changing, and no other file is touched.

Use this whenever you cannot take money: before launch, between months, or if you need to stop mid-month. Prefer it to unpublishing a month, which leaves parents looking at an empty calendar with no explanation.

### The notify list

While paused, the page shows a "Coming soon" panel with an email capture form. Every submission is written to **two** places, because either one can be misconfigured silently and a lost list cannot be rebuilt.

**1. Netlify Forms.** Requires a setting that is off by default on every site created after April 2023. Without it the form returns success and Netlify discards the submission.

- In the Netlify UI go to Forms and select **Enable form detection**.
- **Redeploy the site.** Nothing is accepted until you do.
- Under Forms, add a notification so new emails reach your inbox.
- Free tier covers 100 submissions a month.

**2. The spreadsheet,** via `netlify/functions/notify.js`. Needs the same Google credentials as the order writer. Add a tab named `Notify` with these headers in row 1:

```
signed_up_at | email | source
```

Set `GOOGLE_NOTIFY_TAB` only if you name the tab something else. Duplicate emails are skipped, so signing up twice does not mean being emailed twice.

Verify both after your next deploy: submit your own address, then check the Netlify Forms tab and the `Notify` sheet tab. If only one has it, the other is misconfigured, and the time to find that out is now rather than the day you announce.

The form only appears while `orderingOpen` is `false`. When you reopen, it disappears and step 3 returns to the payment block.

The panel promises one email and nothing else. Keep that promise: it is the reason people give an address to a business that has not opened yet.

## My orders

Parents open `portal.html`, enter the email they used at checkout, and get a sign-in link that works for 30 minutes. Following it keeps them signed in on that device for 14 days. No accounts or passwords, and nothing stored outside Stripe: the page reads their orders straight from the Lunch Bus Stripe account.

They see every lunch from today on, grouped by date, with the allergies on file for each student, then each past payment with a link to its Stripe receipt. Real allergies print in red; "None" does not.

The form says the same thing whether or not an address has orders, so nobody can use it to check whether a family ordered.

Orders are matched on the email typed at checkout, which is lowercased before it reaches Stripe. A parent who used two addresses sees each address's orders separately.

### Sending the sign-in email

The link goes out through Resend, which is free at this volume.

1. Create an account at resend.com and add the domain `orderlunchbus.com`.
2. Add the DNS records Resend lists wherever orderlunchbus.com's DNS is managed, then wait for Resend to mark the domain verified.
3. Create an API key and put it in `RESEND_API_KEY`.
4. Set `EMAIL_FROM` to `Lunch Bus <orders@orderlunchbus.com>`. Replies go to `contactEmail` in `data/menus.json`.

Without these, My orders still loads but no sign-in email is sent, and the failure shows in the function log.

## Pricing, and the two ordering windows

The monthly deadline sets the price. It does not close ordering.

| When a parent orders | Price per meal |
|---|---|
| On or before `ordersCloseOn` | `mealPrice` |
| After `ordersCloseOn` | `latePrice` |

Availability is handled separately and per meal. A meal closes at `orderCutoffHour`, `orderCutoffDaysBefore` days before it is served, in school time. The current setting, `0` and `9`, closes each meal at 9 am on the morning it is served. The calendar and the checkout function read the same two numbers, and both use Pacific time whatever timezone a parent's phone is set to.

A parent who opens Stripe checkout at 8:55 can still finish paying a few minutes after 9, because a Stripe checkout stays open for at least 30 minutes. Those rows land in the sheet with their `ordered_at` time, so look for late arrivals before you finalize the day's count.

Each meal is priced at the moment it is ordered. A parent who pre-orders in September and adds a meal in October pays $8 for the first and $10 for the second, and the earlier ones are never repriced.

The browser sends its expected total with every checkout. If the server disagrees, most likely because the deadline passed while the parent had the page open, the order is refused with a message telling them to refresh. Nobody gets charged a price they were not shown.

Edit `settings` in `data/menus.json`. Amounts are in cents.

```json
"mealPrice": 800,
"latePrice": 1000,
"orderCutoffDaysBefore": 0,
"orderCutoffHour": 9,
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

- Confirm the email and phone in `contact.html` and in `settings` in `menus.json`.
- Work through The Stripe account section above, in the Lunch Bus account.
- Place an order with a test card (`4242 4242 4242 4242`) and confirm the sheet fills in, `thanks.html` lists the meals, and My orders sends a sign-in link and shows the order.
- Set `orderingOpen` to `true` in `data/menus.json` and commit. Until then every Add button stays disabled and checkout refuses orders.
- Check the page on a phone. Most parents will order from the pickup line.
