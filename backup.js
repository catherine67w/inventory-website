// Making a backup, shared by the command line and the server.
//
// SQLite's own VACUUM INTO is used rather than copying data.db, because the
// database runs in WAL mode: recent writes live in data.db-wal until SQLite
// folds them in, which can be weeks. A plain copy of data.db can therefore
// open as an empty database. VACUUM INTO writes one complete, consistent file
// while the app is still running.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Older backups were named to the minute; new ones carry seconds so that two
// in the same minute are two distinct files rather than one silently reused.
const NAME_PATTERN = /^invoice-backup-\d{4}-\d{2}-\d{2}-\d{4,6}\.db$/;

function stamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function sourceDir() {
  return process.env.DATA_DIR || __dirname;
}

// Writes a backup into targetDir and reports what went into it. Counting the
// rows by reopening the finished file is the point: a backup nobody checked is
// not a backup.
function makeBackup(targetDir) {
  const source = path.join(sourceDir(), 'data.db');
  if (!fs.existsSync(source)) throw new Error('There is no database to back up yet.');
  fs.mkdirSync(targetDir, { recursive: true });

  const name = `invoice-backup-${stamp()}.db`;
  const file = path.join(targetDir, name);
  if (fs.existsSync(file)) fs.unlinkSync(file);   // same second: make a fresh one, never report a stale file as new

  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    db.prepare('VACUUM INTO ?').run(file);
  } finally {
    db.close();
  }
  return { name, file, counts: countRows(file), bytes: fs.statSync(file).size, reused: false };
}

function countRows(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const one = (sql) => db.prepare(sql).get().n;
    return {
      invoices: one('SELECT COUNT(*) AS n FROM invoices'),
      line_items: one('SELECT COUNT(*) AS n FROM invoice_items'),
      sales_days: one('SELECT COUNT(*) AS n FROM sales'),
      menu_items: one('SELECT COUNT(*) AS n FROM menu_items'),
    };
  } finally {
    db.close();
  }
}

// Newest first, so the list reads the way someone looking for "the latest one"
// expects it to.
function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => NAME_PATTERN.test(n))
    .sort()
    .reverse()
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, bytes: stat.size, made_at: stat.mtime.toISOString() };
    });
}

// Old backups are deleted oldest-first once there are more than `keep`. A disk
// quietly filling with backups would eventually stop the app writing at all.
function pruneBackups(dir, keep) {
  const extra = listBackups(dir).slice(Math.max(1, keep));
  for (const b of extra) {
    try { fs.unlinkSync(path.join(dir, b.name)); } catch { /* already gone */ }
  }
  return extra.length;
}

module.exports = { makeBackup, listBackups, pruneBackups, countRows, NAME_PATTERN, stamp };
