const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// On this Mac the data sits next to the app. On a server the app folder is
// replaced on every deploy, so DATA_DIR points at a disk that survives that —
// without it, deploying would wipe every invoice.
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS vendors (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  contact      TEXT DEFAULT '',
  terms        TEXT DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id      INTEGER NOT NULL REFERENCES vendors(id),
  invoice_number TEXT DEFAULT '',
  invoice_date   TEXT NOT NULL,
  due_date       TEXT DEFAULT '',
  subtotal       REAL NOT NULL DEFAULT 0,
  tax            REAL NOT NULL DEFAULT 0,
  freight        REAL NOT NULL DEFAULT 0,
  discount       REAL NOT NULL DEFAULT 0,
  total          REAL NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'review',
  source_file    TEXT DEFAULT '',
  notes          TEXT DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id     INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_no        INTEGER NOT NULL DEFAULT 0,
  description    TEXT NOT NULL DEFAULT '',
  sku            TEXT DEFAULT '',
  category       TEXT NOT NULL DEFAULT 'Uncategorized',
  quantity       REAL NOT NULL DEFAULT 0,
  unit           TEXT DEFAULT '',
  unit_price     REAL NOT NULL DEFAULT 0,
  extended_price REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sales (
  sale_date  TEXT PRIMARY KEY,
  net_sales  REAL NOT NULL DEFAULT 0,
  note       TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_invoices_date   ON invoices(invoice_date);
CREATE INDEX IF NOT EXISTS idx_invoices_vendor ON invoices(vendor_id);
CREATE INDEX IF NOT EXISTS idx_items_invoice   ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_items_desc      ON invoice_items(description);

CREATE TABLE IF NOT EXISTS menu_sections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  name_zh    TEXT DEFAULT '',
  note       TEXT DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id INTEGER NOT NULL REFERENCES menu_sections(id) ON DELETE CASCADE,
  code       TEXT DEFAULT '',
  name       TEXT NOT NULL,
  name_zh    TEXT DEFAULT '',
  price      REAL NOT NULL DEFAULT 0,
  price_large REAL,
  note       TEXT DEFAULT '',
  is_new     INTEGER NOT NULL DEFAULT 0,
  available  INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_menu_items_section ON menu_items(section_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Which purchased ingredients go into which menu item. Ingredients are matched
-- by the description printed on the invoice, which is how the Item prices
-- screen groups them too.
CREATE TABLE IF NOT EXISTS menu_item_ingredients (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_item_id INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  quantity     REAL NOT NULL DEFAULT 0,
  unit         TEXT DEFAULT '',
  note         TEXT DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mii_menu_item ON menu_item_ingredients(menu_item_id);
CREATE INDEX IF NOT EXISTS idx_mii_desc      ON menu_item_ingredients(description);
`);

// Columns added after the first release. Adding them here keeps existing
// databases working without anyone having to rebuild them.
for (const [column, definition] of [
  ['input_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['output_tokens', 'INTEGER NOT NULL DEFAULT 0'],
  ['extraction_cost', 'REAL NOT NULL DEFAULT 0'],
]) {
  const existing = db.prepare('PRAGMA table_info(invoices)').all().map((c) => c.name);
  if (!existing.includes(column)) {
    db.exec(`ALTER TABLE invoices ADD COLUMN ${column} ${definition}`);
  }
}

// A long invoice is photographed a page at a time, so one invoice can own
// several files. The first page stays in invoices.source_file; pages merged in
// afterwards land here, so the photograph behind every line item is kept.
db.exec(`
CREATE TABLE IF NOT EXISTS invoice_pages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id    INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  file          TEXT NOT NULL DEFAULT '',
  original_name TEXT DEFAULT '',
  added_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pages_invoice ON invoice_pages(invoice_id);
`);

// Sales days read from an uploaded report carry their share of what the
// reading cost, so the spend panel reflects everything, not just invoices.
// period_start is the first day a row covers. It equals sale_date for an
// ordinary day; on a month total taken from a summary with no daily breakdown
// it is the first of the month, which is what stops that row from being
// double-counted against daily figures for the same month later on.
for (const [column, definition] of [
  ['source_file', "TEXT DEFAULT ''"],
  ['extraction_cost', 'REAL NOT NULL DEFAULT 0'],
  ['period_start', "TEXT DEFAULT ''"],
]) {
  const existing = db.prepare('PRAGMA table_info(sales)').all().map((c) => c.name);
  if (!existing.includes(column)) {
    db.exec(`ALTER TABLE sales ADD COLUMN ${column} ${definition}`);
  }
}


// One-time seed of the printed menu. Runs only when the menu is empty, so
// edits made in the app are never overwritten.
function seedMenu() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM menu_sections').get().n;
  if (count > 0) return;

  const sections = require('./menu-data');
  const insertSection = db.prepare(
    'INSERT INTO menu_sections (name, name_zh, note, sort_order) VALUES (?, ?, ?, ?)');
  const insertItem = db.prepare(`
    INSERT INTO menu_items (section_id, code, name, name_zh, price, price_large, note, is_new, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  db.transaction(() => {
    sections.forEach((section, si) => {
      const id = insertSection.run(section.name, section.name_zh || '', section.note || '', si).lastInsertRowid;
      section.items.forEach((item, ii) => {
        insertItem.run(id, item.code || '', item.name, item.name_zh || '',
          item.price || 0, item.price_large ?? null, item.note || '', item.is_new ? 1 : 0, ii);
      });
    });
  })();
}

seedMenu();

function vendorId(name) {
  const clean = String(name || '').trim() || 'Unknown Vendor';
  const found = db.prepare('SELECT id FROM vendors WHERE name = ?').get(clean);
  if (found) return found.id;
  return db.prepare('INSERT INTO vendors (name) VALUES (?)').run(clean).lastInsertRowid;
}

module.exports = { DATA_DIR, db, vendorId };
