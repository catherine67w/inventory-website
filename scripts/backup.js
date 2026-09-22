// Command-line backup: writes a verified copy of the database, with the
// invoice files beside it.
//
//   npm run backup                 -> into ./backups
//   npm run backup <folder>        -> into that folder (Dropbox, iCloud, a stick)
//
// The reading and verifying live in ../backup.js, shared with the server's
// automatic backups so both behave identically.

const fs = require('fs');
const path = require('path');
const { makeBackup } = require('../backup');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || ROOT;
const UPLOADS = path.join(DATA_DIR, 'uploads');

function main() {
  const target = process.argv[2] || path.join(ROOT, 'backups');

  let made;
  try {
    made = makeBackup(target);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  let files = 0;
  if (fs.existsSync(UPLOADS)) {
    const filesDir = path.join(target, made.name.replace(/\.db$/, '-files'));
    fs.cpSync(UPLOADS, filesDir, { recursive: true });
    files = fs.readdirSync(filesDir).filter((f) => f !== '.gitkeep').length;
  }

  const c = made.counts;
  console.log(`Backed up to ${made.file} (${(made.bytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`  ${c.invoices} invoices, ${c.line_items} line items, ` +
    `${c.sales_days} sales days, ${c.menu_items} menu items`);
  console.log(`  ${files} invoice file${files === 1 ? '' : 's'} alongside it`);

  if (!c.invoices && !c.sales_days) {
    console.log('\nNote: that backup is empty. If the app has data in it, something is wrong.');
  }
}

main();
