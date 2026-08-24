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

## Starting it without the Terminal

Two double-clickable files sit on the Desktop (and in this folder):

| File | What it does |
| --- | --- |
| **Start Invoice App** | Starts the server and opens the app in your browser |
| **Stop Invoice App** | Stops it, for when the Terminal window has been closed or lost |

Starting opens a Terminal window that stays open while the app runs. **Closing that window, or
pressing Control-C in it, stops the app** — and the app is unreachable for everyone once it does.

The start file is safe to double-click twice: if the app is already running it just opens the
browser rather than starting a second copy. On a machine that has never run it, it installs what
it needs first.

If you ever move the project folder, the path inside those files has to be updated to match.

## Turning on automatic invoice reading

Copy `.env.example` to `.env` and add an Anthropic API key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Restart the server. The header will say "automatic invoice reading is on".

With a key, dropping in a **PDF or a photo** of an invoice reads the vendor, invoice number,
dates, totals, and every line item — including a suggested GL category per item. Without a key
the app still works fully: **CSV import** and **manual entry** need no key.

Get a key at https://console.anthropic.com. Reading an invoice costs a few cents; the exact
figure for every invoice is shown on the Dashboard.

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
| **Item prices** | Every product you have bought, with its latest price, the change since last time, its low/high, and total spend. Sortable by any column — including total spend cheapest-first or dearest-first. Click a row for full price history. |
| **Product trends** | A line graph of one product across every invoice that bought it — price per unit, quantity, or spend. See below. |
| **Vendors** | Spend and invoice count per vendor. Click one to search every item you have bought from them. |
| **Net sales** | Upload a photo of your monthly sales summary and every day on it is read off, checked against the report's own month total, and listed for review — or type a day in by hand. This is what every percentage is measured against. |
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


### Linking ingredients to dishes

On **Item prices**, every purchased product has an **Add to menu** button. Use it to say which
dish that ingredient goes into and how much of one purchased unit a single serving uses — `0.05`
of a case, for example.

Once a dish has ingredients linked, opening it on the **Menu** tab shows:

- each ingredient with the most recent price paid, and which vendor it came from
- the **plate cost** — what one serving costs to make
- **food cost %**, **margin**, and **margin %** against the menu price

Costs follow your invoices automatically: when a supplier raises a price, the plate cost and
margin move with it the next time you look. If an ingredient has never appeared on an invoice
there is no price to cost with, and the dish is marked as incomplete rather than being quietly
undercounted.


## Product trends

Pick any product you have bought and the **Product trends** tab draws it as a line graph over
every invoice that bought it. Search by name — English, Chinese, or item code — then click
**Chart it**.

Three things can be plotted, and they answer different questions:

| Line | Question it answers |
| --- | --- |
| **Price per unit** | Is this supplier putting their prices up? |
| **Quantity bought** | Are we using more of this than we used to? |
| **Spend** | What is this product costing us over time? |

Above the graph: how many times you bought it, the latest price, the change since the very first
purchase, the low and high paid, and the total spent.

**Reading it honestly** — the parts that stop a chart from lying:

- **Price never starts the axis at zero**, and the graph says so. A zero baseline flattens a 15%
  price rise into a line that looks flat. Quantity and spend do start at zero, where a zero
  baseline is the truthful choice.
- **Each vendor gets its own line.** If two suppliers sell you the same product, joining their
  prices into one line would draw a zigzag that looks like price volatility when it is really
  just two different suppliers. The legend names them, and the vendor filter isolates one.
- **Two invoices on the same day are one point.** Quantity and spend add up; the price is
  weighted by quantity, so a 40-case delivery is not averaged flat against a single case.
- **Mixed units are called out.** If the same product was invoiced in both cases and pounds, the
  price line is comparing two different things — and that usually means a line item was read with
  the wrong unit rather than anything real.

Hovering a point shows the figure, the date, the vendor, and how many invoice lines are behind
it. Clicking a point — or any row in the table underneath — opens that invoice.

The date range defaults to the product's whole history. Narrowing it re-draws from just that
window; **Every purchase** puts it back.

## Searching a vendor's items

Click any vendor on the **Vendors** tab to open their purchase history. The search box matches
product descriptions, SKUs, categories, and invoice numbers — in English or Chinese — and filters
as you type. A date range narrows it further.

Two views:

- **One row per product** — each distinct product once, with how many times you bought it, the
  low and high price paid, and total spend. Good for "what do we buy from them, and what does it
  cost us?"
- **Every line, by invoice** — each individual invoice line with its date, invoice number, and
  price. Good for "when exactly did we buy this, and what did it cost that day?" Clicking a line
  opens that invoice.


## Net sales

Every cost percentage and margin is measured against net sales, so this is the number the whole
system rests on. Two ways in:

**Upload a report.** Photograph or screenshot your **monthly sales summary** — the one sheet
listing every day of the month — and drop it on the **Net sales** tab. Every day on it becomes
one row, listed for review before anything is saved. A single end-of-day report works the same
way; so does a report split across several photos, since up to 20 files can go in at once.

What it looks for is **net sales** — after discounts and comps, but *before* sales tax. Gross
and tax are shown alongside for checking, but only net is stored. Weekly subtotals and the month
total are never treated as days.

**Three checks before you save:**

- **The days are added up against the report's own month total.** A green line means they match;
  an orange one names the difference. On thirty rows of handwriting this is what catches a
  misread figure.
- **Days missing from the read are listed** — if the reading returns 29 rows for a 31-day month,
  the two dates it skipped are named.
- **Days already recorded are flagged** with their current figure, so re-uploading a report never
  silently overwrites a number you have already checked.

Every figure is editable in the review table, and a row that is not a day can be removed with the
✕ beside it. A day the restaurant was closed is kept as a zero rather than dropped.

**A Toast .xlsx export can be dropped in as it comes.** Spreadsheets are read directly — exact
figures, instantly, with no API key and no reading charge. Photos and PDFs still go through
Claude; spreadsheets never do. A day-by-day sheet becomes one row per day; a summary sheet gives
its period total.

If a summary shows **only a month total** with no day-by-day breakdown — which is what Toast's
Sales Summary export gives — it is offered as a single entry dated the last day of the period.
Nothing is ever split across days automatically, since that would be inventing figures.

Such an entry is stored knowing the span it covers, and that matters: **a period entry and daily
figures for the same dates can never both be counted.** Saving days that fall inside a stored
period says so and offers to replace it, and the same happens the other way round. The Net sales
table marks a period entry with the range it covers.

A date range that stops short of the period's last day will not include any of it, so for
analysis inside a month, export the day-by-day report instead.

**Or type one in.** The single-day form is always there and needs no API key.

Reading a full month **from a photo** costs about 6¢, divided across the days it produced so the
Dashboard spend figures stay accurate. Reading a spreadsheet costs nothing.

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

```bash
npm run backup
```

That writes a dated copy of the database into `backups/`, with the invoice files beside it, and
prints what went in so you can see it worked. Pass a folder to send it elsewhere:

```bash
npm run backup ~/Dropbox/invoice-backups
```

**Do not back up by copying `data.db` on its own.** The database runs in WAL mode, so recent
writes live in `data.db-wal` until SQLite folds them in — which can be weeks. A copy of `data.db`
alone can open as an empty database. `npm run backup` uses SQLite's own `VACUUM INTO`, which
writes one complete file safely while the app is running, and then reopens it to count what it
contains before telling you it worked.

To restore, stop the app, and put the backup in place of all three database files:

```bash
rm -f data.db data.db-wal data.db-shm && cp backups/invoice-backup-YYYY-MM-DD-HHMM.db data.db
```

Then copy the matching `-files` folder back over `uploads/`.
