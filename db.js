const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'data.db'));
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

module.exports = { db, vendorId };
