// Makes a backup that actually contains the data.
//
// The database runs in WAL mode, which means recent writes live in data.db-wal
// rather than data.db itself. Copying data.db on its own can therefore produce
// an empty-looking database — so this uses SQLite's own VACUUM INTO, which
// writes one consistent file with everything in it, safely, while the app is
// still running.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || ROOT;
const SOURCE = path.join(DATA_DIR, 'data.db');
const UPLOADS = path.join(DATA_DIR, 'uploads');

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error('No data.db found. Run the app once first.');
    process.exit(1);
  }

  // A folder given on the command line wins, so backups can go to Dropbox or
  // a USB stick rather than staying on the same disk as the original.
  const target = process.argv[2] || path.join(ROOT, 'backups');
  fs.mkdirSync(target, { recursive: true });

  const name = `invoice-backup-${stamp()}`;
  const dbPath = path.join(target, `${name}.db`);
  if (fs.existsSync(dbPath)) {
    console.error(`${dbPath} already exists. Wait a minute and run it again.`);
    process.exit(1);
  }

  const db = new Database(SOURCE, { readonly: true });
  db.prepare('VACUUM INTO ?').run(dbPath);
  db.close();

  // Verify rather than assume: a backup nobody checked is not a backup.
  const check = new Database(dbPath, { readonly: true });
  const counts = {
    invoices: check.prepare('SELECT COUNT(*) AS n FROM invoices').get().n,
    line_items: check.prepare('SELECT COUNT(*) AS n FROM invoice_items').get().n,
    sales_days: check.prepare('SELECT COUNT(*) AS n FROM sales').get().n,
    menu_items: check.prepare('SELECT COUNT(*) AS n FROM menu_items').get().n,
  };
  check.close();

  let files = 0;
  if (fs.existsSync(UPLOADS)) {
    const filesDir = path.join(target, `${name}-files`);
    fs.cpSync(UPLOADS, filesDir, { recursive: true });
    files = fs.readdirSync(filesDir).filter((f) => f !== '.gitkeep').length;
  }

  const mb = (fs.statSync(dbPath).size / 1024 / 1024).toFixed(1);
  console.log(`Backed up to ${dbPath} (${mb} MB)`);
  console.log(`  ${counts.invoices} invoices, ${counts.line_items} line items, ` +
    `${counts.sales_days} sales days, ${counts.menu_items} menu items`);
  console.log(`  ${files} invoice file${files === 1 ? '' : 's'} alongside it`);

  if (!counts.invoices && !counts.sales_days) {
    console.log('\nNote: that backup is empty. If the app has data in it, something is wrong.');
  }
}

main();
