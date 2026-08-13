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
`);

function vendorId(name) {
  const clean = String(name || '').trim() || 'Unknown Vendor';
  const found = db.prepare('SELECT id FROM vendors WHERE name = ?').get(clean);
  if (found) return found.id;
  return db.prepare('INSERT INTO vendors (name) VALUES (?)').run(clean).lastInsertRowid;
}

module.exports = { db, vendorId };
