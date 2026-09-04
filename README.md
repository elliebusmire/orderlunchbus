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

## Sharing a Stripe account with another business

This account also runs Porchside Drop. Three things follow from that.

**Webhooks are account-wide.** Every endpoint on the account receives every `checkout.session.completed` event, whichever site created it. So each side must recognise its own. Lunch Bus tags every payment with `metadata.business = "lunch-bus"` and the webhook drops anything without that tag.

The other direction is not fixed by this repo. Porchside Drop's webhook function will start receiving Lunch Bus events, and unless it checks something first, it may write junk rows into the Porchside sheet. Add the same kind of guard there before taking a real Lunch Bus order.

**Card statements show the account prefix.** Card charges reject `statement_descriptor`, so we send `statement_descriptor_suffix` instead. Stripe joins it to the prefix set in Dashboard, Settings, Business, Public details, with a `*` and a space between. The combined result must be 22 characters or fewer.

| Account prefix | Result | |
|---|---|---|
| `PORCHSIDE` | `PORCHSIDE* LUNCH BUS` | 20 chars, fits |
| `EB VENTURES` | `EB VENTURES* LUNCH BUS` | 22 chars, fits |
| `ELLIE BUSMIRE` | 24 chars | too long, shorten the suffix |

Change `statementSuffix` in `data/menus.json` if your prefix is long.

**Receipt branding is account-level.** Logo and colour on the emailed receipt are shared and cannot be set per payment. The line items carry the date and meal name, so a parent can tell what they bought, but the header will match whatever the account is branded as.

To separate the books, filter by the `business` metadata key in the Stripe Dashboard or in a payments export.

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
