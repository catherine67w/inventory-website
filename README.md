# Invoice & Food Cost

An xtraCHEF-style invoice and cost management system for a single restaurant. Upload supplier
invoices, have the line items read out automatically, type in your own net sales, and analyze
profit margin over any date range you choose.

No Toast integration — net sales are entered by hand on purpose.

## Running it

```bash
npm install
npm start
```

Then open **http://localhost:4000**.

Data lives in `data.db` (SQLite) next to the app, and uploaded invoice files in `uploads/`.
Both are created on first run. Nothing leaves your machine except the invoice images you
choose to have read automatically.

## Turning on automatic invoice reading

Copy `.env.example` to `.env` and add an Anthropic API key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Restart the server. The header will say "automatic extraction on".

With a key, dropping in a **PDF or a photo** of an invoice reads the vendor, invoice number,
dates, totals, and every line item — including a suggested GL category per item. Without a key
the app still works fully: **CSV import** and **manual entry** need no key.

Get a key at https://console.anthropic.com. Extraction runs on Claude Opus 5 and costs a
fraction of a cent per invoice.

## Signing in

The app is protected by a shared password, set as `APP_PASSWORD` in `.env`. To change it,
edit that line and restart — everyone is signed out and uses the new one. Sessions last two
weeks per device.

**Two-factor codes** can be added on top from the **Security** tab. Everyone scans one QR code
into an authenticator app (Google Authenticator, Authy, or a password manager); after that,
signing in needs the password *and* the current six-digit code. Codes change every 30 seconds,
are generated on the phone with no signal needed, and each code works only once.

**Lockout:** five wrong attempts locks that device out for 15 minutes, and every failure is
logged in the terminal running the server. Restarting the server clears all lockouts.

**If the authenticator phone is lost**, turn two-factor off from the Mac:

```bash
npm run disable-2fa
```

That needs physical access to the machine, so it is a safety net rather than a way in. Everyone
signs in with the password alone afterwards until it is set up again.

Leaving `APP_PASSWORD` empty removes the gate entirely. Only do that if no one else can reach
the machine.

## Letting coworkers use it

While the app is running, anyone on the same Wi-Fi can reach it. Find the address with:

```bash
echo "http://$(scutil --get LocalHostName).local:4000"
```

Share that; they need the password, and there is nothing to install. The `.local` address is
stable even when the router hands out a different IP.

`npm start` runs the server under `caffeinate`, so the Mac will not fall asleep while it is up —
and stops holding sleep off the moment you quit the server. **Closing the laptop lid still puts it
to sleep**, which takes the site down for everyone, so leave it open and plugged in. Use
`npm run start:nocaffeine` if you ever want the server without the sleep block.

## How it fits together

| Tab | What it does |
| --- | --- |
| **Dashboard** | Month-to-date purchases, net sales, COGS, food cost %, gross margin, and anything waiting for review. |
| **Upload** | Drag in PDFs, photos, or CSVs. Each becomes a draft you review before it is saved — nothing is written to the books until you approve it. |
| **Invoices** | Every invoice, filterable by date, vendor, status, or a search across vendor / invoice # / product. Click any row to edit. |
| **Item prices** | Every product you have bought, with its latest price, the change since last time, its low/high, and total spend. Click for full price history. |
| **Vendors** | Spend and invoice count per vendor. |
| **Net sales** | Type net sales in by day, one at a time or pasted in bulk. This is what every percentage is measured against. |
| **Menu** | Every dish and drink with names, codes, and prices — see below. |
| **Profit analysis** | The custom date range analysis — see below. |


## Menu

The **Menu** tab holds every dish and drink with its English name, Chinese name, item code, and
price — seeded from the printed menu (138 items across 16 sections).

- **Search** matches English names, Chinese names, and item codes, so `lamb`, `羊肉`, and `L2`
  all find the lamb shoulder roll.
- **Two prices** on a line (soup bases, some lamb) are stored as a regular and a large/full-pot
  price and shown as `$10.00 / $29.00`.
- **Click any item to edit it** — prices change, and this is where you change them.
- **Mark an item unavailable** when it comes off the line rather than deleting it; it stays in
  the list, greyed out, and can be switched back on.
- **New section** adds a category; a section has to be empty before it can be deleted.

The seed data lives in `menu-data.js` and is loaded **only when the menu table is empty**, so
edits made in the app are never overwritten by a restart.

## Profit analysis

Pick **any** start and end date. The presets (this week, last week, month to date, last month,
last 30/90 days, quarter to date, year to date) just fill in the two date boxes for you — you can
always type your own range.

You get:

- Net sales, purchases, COGS, COGS %, gross profit, and gross margin
- Food cost %, N/A beverage cost %, alcohol cost %, and supplies % of sales
- Spend broken down by category, by vendor, and by product
- A purchases-vs-sales bar chart by week
- **Compare to previous period** — the same length of time immediately before your range, with
  every measure shown side by side and the change between them

Two options worth knowing:

- **Approved invoices only** limits the analysis to invoices you have signed off on, so drafts
  sitting in review do not move your numbers.
- **Inventory adjustment** (optional): enter beginning and ending inventory and COGS becomes
  `beginning + purchases − ending` instead of purchases alone. Leave both blank to analyze
  purchases as cost, which is what xtraCHEF shows by default.

## Categories and how costs roll up

Line items carry a GL category. Categories roll into groups, and the groups decide what counts
as cost of goods:

- **Food** (Produce, Meat & Seafood, Dairy & Eggs, Dry Goods, Frozen, Bakery, Other Food) → COGS
- **N/A Beverage** → COGS
- **Alcohol** (Beer, Wine, Liquor) → COGS
- **Supplies & Paper** (Paper & Disposables, Cleaning & Chemicals, Smallwares) → *not* COGS
- **Other** (Repairs & Maintenance, Uncategorized) → *not* COGS

Gross margin is `(net sales − COGS) ÷ net sales`. Supplies and repairs are tracked and reported
as a percentage of sales but kept out of COGS, which is the standard restaurant treatment. To
change the mapping, edit `categories.js`.

## CSV import format

A header row plus one row per line item. Column names are matched loosely — `qty` or `quantity`,
`amount` or `extended price`, and so on. Only a description column is strictly required.

```csv
Description,SKU,Category,Qty,Unit,Unit Price,Extended Price
Roma Tomatoes 25#,PR-101,Produce,4,CS,18.50,74.00
Chicken Breast B/S,MT-220,Meat & Seafood,3,CS,62.40,187.20
```

If a line total is missing it is calculated from quantity × unit price.

## Notes

- The invoice editor cross-checks your line items against the subtotal and the totals against
  each other, and tells you when they disagree — that catches most extraction and typing errors.
- Editing quantity or unit price recalculates the line total, and editing the line total
  recalculates unit price.
- Vendors are created automatically the first time you save an invoice for them.
- Deleting an invoice removes its line items and its uploaded file.

## Backing it up

Everything is in two places: `data.db` and `uploads/`. Copy both.

```bash
cp data.db ~/Dropbox/invoice-backup.db && cp -r uploads ~/Dropbox/invoice-uploads
```
