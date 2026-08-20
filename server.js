require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const { db, vendorId } = require('./db');
const { parseFile, apiKeyProblem, PRICING, MODEL } = require('./parse');
const { CATEGORIES, GROUPS, NAMES, groupOf } = require('./categories');

const app = express();
const PORT = process.env.PORT || 4000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');

app.use(express.json({ limit: '5mb' }));

// --- password gate --------------------------------------------------------
//
// A shared password, set as APP_PASSWORD in .env. Signing in stores a cookie
// holding an expiry plus an HMAC of it; the HMAC key is derived from the
// password, so changing the password signs everyone out. Leave APP_PASSWORD
// empty to run with no gate at all (only sensible on a machine nobody else
// can reach).

const PASSWORD = String(process.env.APP_PASSWORD || '');
const COOKIE_NAME = 'invcogs_session';
const SESSION_HOURS = 24 * 14;
const OPEN_PATHS = new Set(['/login.html', '/styles.css', '/api/login', '/api/session']);

const hmacKey = () => crypto.createHash('sha256').update('invoice-cogs::' + PASSWORD).digest();
const signExpiry = (exp) => crypto.createHmac('sha256', hmacKey()).update(String(exp)).digest('hex');

function issueToken() {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  return `${exp}.${signExpiry(exp)}`;
}

function tokenIsValid(token) {
  if (!token) return false;
  const [expText, signature] = String(token).split('.');
  const exp = Number(expText);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expected = Buffer.from(signExpiry(exp), 'hex');
  const given = Buffer.from(String(signature || ''), 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function passwordMatches(input) {
  const a = crypto.createHash('sha256').update(String(input)).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

app.use((req, res, next) => {
  if (!PASSWORD || OPEN_PATHS.has(req.path)) return next();
  if (tokenIsValid(readCookie(req, COOKIE_NAME))) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Signed out. Reload the page to sign in.' });
  return res.redirect('/login.html');
});

app.get('/api/session', (req, res) => {
  res.json({
    password_required: Boolean(PASSWORD),
    signed_in: !PASSWORD || tokenIsValid(readCookie(req, COOKIE_NAME)),
  });
});

app.post('/api/login', (req, res) => {
  if (!PASSWORD) return res.json({ ok: true });
  if (!passwordMatches(req.body.password || '')) {
    return res.status(401).json({ error: 'That password is not right.' });
  }
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${issueToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/files', express.static(UPLOAD_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      cb(null, stamp + path.extname(file.originalname).toLowerCase());
    },
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

// --- reference data -------------------------------------------------------

app.get('/api/meta', (req, res) => {
  const problem = apiKeyProblem();
  res.json({
    categories: CATEGORIES,
    groups: GROUPS,
    extraction: { enabled: !problem, problem, model: MODEL },
  });
});

// --- vendors --------------------------------------------------------------

app.get('/api/vendors', (req, res) => {
  res.json(db.prepare(`
    SELECT v.id, v.name, v.contact, v.terms,
           COUNT(i.id)                AS invoice_count,
           COALESCE(SUM(i.total), 0)  AS total_spend,
           MAX(i.invoice_date)        AS last_invoice
    FROM vendors v
    LEFT JOIN invoices i ON i.vendor_id = v.id
    GROUP BY v.id
    ORDER BY total_spend DESC, v.name
  `).all());
});

app.post('/api/vendors', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Vendor name is required.' });
  const id = vendorId(name);
  db.prepare('UPDATE vendors SET contact = ?, terms = ? WHERE id = ?')
    .run(String(req.body.contact || ''), String(req.body.terms || ''), id);
  res.json(db.prepare('SELECT * FROM vendors WHERE id = ?').get(id));
});

app.put('/api/vendors/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM vendors WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Vendor not found.' });
  db.prepare('UPDATE vendors SET name = ?, contact = ?, terms = ? WHERE id = ?').run(
    String(req.body.name || row.name).trim(),
    String(req.body.contact ?? row.contact),
    String(req.body.terms ?? row.terms),
    row.id,
  );
  res.json(db.prepare('SELECT * FROM vendors WHERE id = ?').get(row.id));
});

// --- invoices -------------------------------------------------------------

function invoiceFilters(q) {
  const where = [];
  const params = {};
  if (q.from) { where.push('i.invoice_date >= @from'); params.from = q.from; }
  if (q.to) { where.push('i.invoice_date <= @to'); params.to = q.to; }
  if (q.vendor_id) { where.push('i.vendor_id = @vendor_id'); params.vendor_id = q.vendor_id; }
  if (q.status && q.status !== 'all') { where.push('i.status = @status'); params.status = q.status; }
  if (q.q) {
    where.push(`(v.name LIKE @q OR i.invoice_number LIKE @q OR EXISTS (
      SELECT 1 FROM invoice_items it WHERE it.invoice_id = i.id AND it.description LIKE @q))`);
    params.q = `%${q.q}%`;
  }
  return { clause: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

app.get('/api/invoices', (req, res) => {
  const { clause, params } = invoiceFilters(req.query);
  res.json(db.prepare(`
    SELECT i.*, v.name AS vendor_name,
           (SELECT COUNT(*) FROM invoice_items it WHERE it.invoice_id = i.id) AS item_count
    FROM invoices i JOIN vendors v ON v.id = i.vendor_id
    ${clause}
    ORDER BY i.invoice_date DESC, i.id DESC
  `).all(params));
});

app.get('/api/invoices/:id', (req, res) => {
  const invoice = db.prepare(`
    SELECT i.*, v.name AS vendor_name
    FROM invoices i JOIN vendors v ON v.id = i.vendor_id WHERE i.id = ?
  `).get(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
  invoice.items = db.prepare('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY line_no, id').all(invoice.id);
  res.json(invoice);
});

function writeInvoice(payload, id = null) {
  const vid = vendorId(payload.vendor_name);
  const items = Array.isArray(payload.items) ? payload.items : [];
  const subtotal = payload.subtotal !== undefined && payload.subtotal !== ''
    ? money(payload.subtotal)
    : money(items.reduce((s, i) => s + (Number(i.extended_price) || 0), 0));
  const tax = money(payload.tax);
  const freight = money(payload.freight);
  const discount = money(payload.discount);
  const total = payload.total !== undefined && payload.total !== ''
    ? money(payload.total)
    : money(subtotal + tax + freight - discount);

  const usage = payload.usage || {};
  const fields = {
    vendor_id: vid,
    invoice_number: String(payload.invoice_number || ''),
    invoice_date: payload.invoice_date || new Date().toISOString().slice(0, 10),
    due_date: String(payload.due_date || ''),
    subtotal, tax, freight, discount, total,
    status: payload.status === 'approved' ? 'approved' : 'review',
    source_file: String(payload.source_file || ''),
    notes: String(payload.notes || ''),
    input_tokens: Math.max(0, Math.round(Number(usage.input_tokens) || 0)),
    output_tokens: Math.max(0, Math.round(Number(usage.output_tokens) || 0)),
    extraction_cost: Math.max(0, Number(usage.cost) || 0),
  };

  const run = db.transaction(() => {
    let invoiceId = id;
    if (invoiceId) {
      db.prepare(`
        UPDATE invoices SET vendor_id=@vendor_id, invoice_number=@invoice_number, invoice_date=@invoice_date,
          due_date=@due_date, subtotal=@subtotal, tax=@tax, freight=@freight, discount=@discount,
          total=@total, status=@status, notes=@notes, updated_at=datetime('now')
        WHERE id=@id
      `).run({ ...fields, id: invoiceId });
      db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(invoiceId);
    } else {
      invoiceId = db.prepare(`
        INSERT INTO invoices (vendor_id, invoice_number, invoice_date, due_date, subtotal, tax, freight,
                              discount, total, status, source_file, notes,
                              input_tokens, output_tokens, extraction_cost)
        VALUES (@vendor_id, @invoice_number, @invoice_date, @due_date, @subtotal, @tax, @freight,
                @discount, @total, @status, @source_file, @notes,
                @input_tokens, @output_tokens, @extraction_cost)
      `).run(fields).lastInsertRowid;
    }

    const insertItem = db.prepare(`
      INSERT INTO invoice_items (invoice_id, line_no, description, sku, category, quantity, unit, unit_price, extended_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    items.forEach((it, idx) => {
      const description = String(it.description || '').trim();
      if (!description) return;
      const quantity = Number(it.quantity) || 0;
      const unitPrice = Number(it.unit_price) || 0;
      const extended = it.extended_price !== undefined && it.extended_price !== ''
        ? money(it.extended_price)
        : money(quantity * unitPrice);
      insertItem.run(
        invoiceId, idx + 1, description, String(it.sku || ''),
        NAMES.includes(it.category) ? it.category : 'Uncategorized',
        quantity, String(it.unit || ''), unitPrice, extended,
      );
    });
    return invoiceId;
  });

  return run();
}

app.post('/api/invoices', (req, res) => {
  const id = writeInvoice(req.body);
  res.json({ id });
});

app.put('/api/invoices/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM invoices WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Invoice not found.' });
  writeInvoice(req.body, existing.id);
  res.json({ id: existing.id });
});

app.post('/api/invoices/:id/status', (req, res) => {
  const status = req.body.status === 'approved' ? 'approved' : 'review';
  const info = db.prepare("UPDATE invoices SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Invoice not found.' });
  res.json({ ok: true, status });
});

app.delete('/api/invoices/:id', (req, res) => {
  const row = db.prepare('SELECT source_file FROM invoices WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Invoice not found.' });
  db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id);
  if (row.source_file) {
    fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(row.source_file))).catch(() => {});
  }
  res.json({ ok: true });
});

// --- upload + extraction --------------------------------------------------

app.post('/api/upload', upload.array('files', 20), wrap(async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No files were uploaded.' });

  const results = [];
  for (const file of files) {
    const entry = { file: file.filename, original_name: file.originalname };
    try {
      const { data, usage } = await parseFile(file.path, file.originalname);
      entry.parsed = data;
      entry.usage = usage;
    } catch (err) {
      entry.error = err.message;
      entry.usage = { input_tokens: 0, output_tokens: 0, cost: 0, model: null };
      entry.parsed = {
        vendor_name: '', invoice_number: '', invoice_date: '', due_date: '',
        subtotal: 0, tax: 0, freight: 0, discount: 0, total: 0, items: [],
      };
    }
    results.push(entry);
  }
  res.json({ results });
}));

// --- net sales ------------------------------------------------------------

app.get('/api/sales', (req, res) => {
  const where = [];
  const params = {};
  if (req.query.from) { where.push('sale_date >= @from'); params.from = req.query.from; }
  if (req.query.to) { where.push('sale_date <= @to'); params.to = req.query.to; }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  res.json(db.prepare(`SELECT * FROM sales ${clause} ORDER BY sale_date DESC`).all(params));
});

app.post('/api/sales', (req, res) => {
  const date = String(req.body.sale_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'A date in YYYY-MM-DD form is required.' });
  }
  db.prepare(`
    INSERT INTO sales (sale_date, net_sales, note) VALUES (@sale_date, @net_sales, @note)
    ON CONFLICT(sale_date) DO UPDATE SET net_sales = @net_sales, note = @note
  `).run({ sale_date: date, net_sales: money(req.body.net_sales), note: String(req.body.note || '') });
  res.json(db.prepare('SELECT * FROM sales WHERE sale_date = ?').get(date));
});

app.delete('/api/sales/:date', (req, res) => {
  db.prepare('DELETE FROM sales WHERE sale_date = ?').run(req.params.date);
  res.json({ ok: true });
});

// --- item price tracking --------------------------------------------------

app.get('/api/items', (req, res) => {
  const params = {};
  const where = ["i.status = 'approved' OR i.status = 'review'"];
  if (req.query.from) { where.push('i.invoice_date >= @from'); params.from = req.query.from; }
  if (req.query.to) { where.push('i.invoice_date <= @to'); params.to = req.query.to; }
  if (req.query.q) { where.push('it.description LIKE @q'); params.q = `%${req.query.q}%`; }

  res.json(db.prepare(`
    SELECT it.description, v.name AS vendor_name, it.unit,
           COUNT(*)                          AS purchase_count,
           SUM(it.extended_price)            AS total_spend,
           MIN(it.unit_price)                AS min_price,
           MAX(it.unit_price)                AS max_price,
           (SELECT it2.unit_price FROM invoice_items it2
              JOIN invoices i2 ON i2.id = it2.invoice_id
             WHERE it2.description = it.description AND i2.vendor_id = v.id
             ORDER BY i2.invoice_date DESC, i2.id DESC LIMIT 1) AS latest_price,
           (SELECT i2.invoice_date FROM invoice_items it2
              JOIN invoices i2 ON i2.id = it2.invoice_id
             WHERE it2.description = it.description AND i2.vendor_id = v.id
             ORDER BY i2.invoice_date DESC, i2.id DESC LIMIT 1) AS latest_date,
           (SELECT it2.unit_price FROM invoice_items it2
              JOIN invoices i2 ON i2.id = it2.invoice_id
             WHERE it2.description = it.description AND i2.vendor_id = v.id
             ORDER BY i2.invoice_date DESC, i2.id DESC LIMIT 1 OFFSET 1) AS previous_price
    FROM invoice_items it
    JOIN invoices i ON i.id = it.invoice_id
    JOIN vendors  v ON v.id = i.vendor_id
    WHERE ${where.join(' AND ')}
    GROUP BY it.description, v.id, it.unit
    ORDER BY total_spend DESC
    LIMIT 400
  `).all(params));
});

app.get('/api/items/history', (req, res) => {
  const description = String(req.query.description || '');
  if (!description) return res.status(400).json({ error: 'A description is required.' });
  res.json(db.prepare(`
    SELECT i.invoice_date, i.id AS invoice_id, i.invoice_number, v.name AS vendor_name,
           it.quantity, it.unit, it.unit_price, it.extended_price
    FROM invoice_items it
    JOIN invoices i ON i.id = it.invoice_id
    JOIN vendors  v ON v.id = i.vendor_id
    WHERE it.description = ?
    ORDER BY i.invoice_date DESC, i.id DESC
  `).all(description));
});


// --- menu -----------------------------------------------------------------

app.get('/api/menu', (req, res) => {
  const sections = db.prepare(
    'SELECT * FROM menu_sections ORDER BY sort_order, id').all();
  const items = db.prepare(
    'SELECT * FROM menu_items ORDER BY sort_order, id').all();

  const bySection = new Map(sections.map((s) => [s.id, { ...s, items: [] }]));
  for (const item of items) {
    const section = bySection.get(item.section_id);
    if (section) section.items.push(item);
  }

  const list = [...bySection.values()];
  const prices = items.filter((i) => i.price > 0).map((i) => i.price);
  res.json({
    sections: list,
    summary: {
      sections: list.length,
      items: items.length,
      unavailable: items.filter((i) => !i.available).length,
      cheapest: prices.length ? Math.min(...prices) : 0,
      dearest: prices.length ? Math.max(...prices) : 0,
      average: prices.length ? money(prices.reduce((a, b) => a + b, 0) / prices.length) : 0,
    },
  });
});

app.post('/api/menu/sections', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'A section name is required.' });
  if (db.prepare('SELECT 1 FROM menu_sections WHERE name = ?').get(name)) {
    return res.status(409).json({ error: 'A section with that name already exists.' });
  }
  const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM menu_sections').get().n;
  const id = db.prepare('INSERT INTO menu_sections (name, name_zh, note, sort_order) VALUES (?, ?, ?, ?)')
    .run(name, String(req.body.name_zh || ''), String(req.body.note || ''), next).lastInsertRowid;
  res.json(db.prepare('SELECT * FROM menu_sections WHERE id = ?').get(id));
});

app.delete('/api/menu/sections/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM menu_sections WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Section not found.' });
  const items = db.prepare('SELECT COUNT(*) AS n FROM menu_items WHERE section_id = ?').get(row.id).n;
  if (items > 0 && req.query.force !== '1') {
    return res.status(409).json({ error: `That section still has ${items} item${items === 1 ? '' : 's'}.` });
  }
  db.prepare('DELETE FROM menu_sections WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

function itemFields(body) {
  const price = money(body.price);
  const large = body.price_large === '' || body.price_large === null || body.price_large === undefined
    ? null : money(body.price_large);
  return {
    code: String(body.code || '').trim(),
    name: String(body.name || '').trim(),
    name_zh: String(body.name_zh || '').trim(),
    price,
    price_large: large,
    note: String(body.note || '').trim(),
    is_new: body.is_new ? 1 : 0,
    available: body.available === false || body.available === 0 ? 0 : 1,
  };
}

app.post('/api/menu/items', (req, res) => {
  const fields = itemFields(req.body);
  if (!fields.name) return res.status(400).json({ error: 'An item name is required.' });
  const section = db.prepare('SELECT id FROM menu_sections WHERE id = ?').get(req.body.section_id);
  if (!section) return res.status(400).json({ error: 'Pick a section for this item.' });

  const next = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM menu_items WHERE section_id = ?').get(section.id).n;
  const id = db.prepare(`
    INSERT INTO menu_items (section_id, code, name, name_zh, price, price_large, note, is_new, available, sort_order)
    VALUES (@section_id, @code, @name, @name_zh, @price, @price_large, @note, @is_new, @available, @sort_order)
  `).run({ ...fields, section_id: section.id, sort_order: next }).lastInsertRowid;
  res.json(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id));
});

app.put('/api/menu/items/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Item not found.' });
  const fields = itemFields({ ...existing, ...req.body });
  if (!fields.name) return res.status(400).json({ error: 'An item name is required.' });
  const sectionId = req.body.section_id || existing.section_id;

  db.prepare(`
    UPDATE menu_items SET section_id=@section_id, code=@code, name=@name, name_zh=@name_zh,
      price=@price, price_large=@price_large, note=@note, is_new=@is_new, available=@available
    WHERE id=@id
  `).run({ ...fields, section_id: sectionId, id: existing.id });
  res.json(db.prepare('SELECT * FROM menu_items WHERE id = ?').get(existing.id));
});

app.delete('/api/menu/items/:id', (req, res) => {
  const info = db.prepare('DELETE FROM menu_items WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Item not found.' });
  res.json({ ok: true });
});

// --- extraction spend -----------------------------------------------------

function usageTotals(from, to) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(extraction_cost), 0) AS cost,
           COALESCE(SUM(input_tokens), 0)    AS input_tokens,
           COALESCE(SUM(output_tokens), 0)   AS output_tokens,
           COUNT(*)                          AS invoices,
           SUM(CASE WHEN extraction_cost > 0 THEN 1 ELSE 0 END) AS read_automatically
    FROM invoices WHERE invoice_date BETWEEN @from AND @to
  `).get({ from, to });
  return {
    from, to,
    cost: Math.round(row.cost * 1e6) / 1e6,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    invoices: row.invoices,
    read_automatically: row.read_automatically || 0,
    average_cost: row.read_automatically ? row.cost / row.read_automatically : 0,
  };
}

app.get('/api/usage', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const from = req.query.from || today.slice(0, 8) + '01';
  const to = req.query.to || today;
  const byMonth = db.prepare(`
    SELECT substr(invoice_date, 1, 7) AS month,
           COALESCE(SUM(extraction_cost), 0) AS cost,
           SUM(CASE WHEN extraction_cost > 0 THEN 1 ELSE 0 END) AS read_automatically
    FROM invoices
    GROUP BY month ORDER BY month DESC LIMIT 12
  `).all();
  res.json({
    period: usageTotals(from, to),
    all_time: usageTotals('0000-01-01', '9999-12-31'),
    by_month: byMonth.map((m) => ({ ...m, cost: Math.round(m.cost * 1e6) / 1e6 })),
    pricing: PRICING,
    model: MODEL,
  });
});

// --- analytics ------------------------------------------------------------

function periodStats(from, to, statuses) {
  const statusClause = statuses === 'approved' ? "AND i.status = 'approved'" : '';
  const params = { from, to };

  const byCategory = db.prepare(`
    SELECT it.category, SUM(it.extended_price) AS spend
    FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id
    WHERE i.invoice_date BETWEEN @from AND @to ${statusClause}
    GROUP BY it.category ORDER BY spend DESC
  `).all(params);

  const byVendor = db.prepare(`
    SELECT v.name AS vendor_name, v.id AS vendor_id,
           SUM(i.total) AS spend, COUNT(*) AS invoice_count
    FROM invoices i JOIN vendors v ON v.id = i.vendor_id
    WHERE i.invoice_date BETWEEN @from AND @to ${statusClause}
    GROUP BY v.id ORDER BY spend DESC
  `).all(params);

  const topItems = db.prepare(`
    SELECT it.description, SUM(it.extended_price) AS spend, SUM(it.quantity) AS quantity, it.unit
    FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id
    WHERE i.invoice_date BETWEEN @from AND @to ${statusClause}
    GROUP BY it.description, it.unit ORDER BY spend DESC LIMIT 20
  `).all(params);

  const invoiceTotals = db.prepare(`
    SELECT COALESCE(SUM(i.total), 0)    AS purchases,
           COALESCE(SUM(i.tax), 0)      AS tax,
           COALESCE(SUM(i.freight), 0)  AS freight,
           COUNT(*)                     AS invoice_count
    FROM invoices i
    WHERE i.invoice_date BETWEEN @from AND @to ${statusClause}
  `).get(params);

  const salesRow = db.prepare(`
    SELECT COALESCE(SUM(net_sales), 0) AS net_sales, COUNT(*) AS days
    FROM sales WHERE sale_date BETWEEN @from AND @to
  `).get(params);

  const groupSpend = { food: 0, beverage: 0, alcohol: 0, supplies: 0, other: 0 };
  for (const row of byCategory) groupSpend[groupOf(row.category)] += row.spend;

  const cogs = groupSpend.food + groupSpend.beverage + groupSpend.alcohol;
  const nonCogs = groupSpend.supplies + groupSpend.other;
  const netSales = salesRow.net_sales;
  const pct = (v) => (netSales > 0 ? +((v / netSales) * 100).toFixed(2) : null);

  return {
    from, to,
    net_sales: money(netSales),
    sales_days: salesRow.days,
    purchases: money(invoiceTotals.purchases),
    invoice_count: invoiceTotals.invoice_count,
    tax: money(invoiceTotals.tax),
    freight: money(invoiceTotals.freight),
    group_spend: Object.fromEntries(Object.entries(groupSpend).map(([k, v]) => [k, money(v)])),
    cogs: money(cogs),
    non_cogs: money(nonCogs),
    gross_profit: money(netSales - cogs),
    gross_margin_pct: pct(netSales - cogs),
    cogs_pct: pct(cogs),
    food_cost_pct: pct(groupSpend.food),
    beverage_cost_pct: pct(groupSpend.beverage),
    alcohol_cost_pct: pct(groupSpend.alcohol),
    supplies_pct: pct(groupSpend.supplies),
    by_category: byCategory.map((r) => ({ ...r, spend: money(r.spend), group: groupOf(r.category), pct_of_sales: pct(r.spend) })),
    by_vendor: byVendor.map((r) => ({ ...r, spend: money(r.spend), pct_of_sales: pct(r.spend) })),
    top_items: topItems.map((r) => ({ ...r, spend: money(r.spend) })),
  };
}

function shiftPeriod(from, to) {
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  const days = Math.round((end - start) / 86400000) + 1;
  const prevEnd = new Date(start.getTime() - 86400000);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(prevStart), to: iso(prevEnd) };
}

app.get('/api/analytics', (req, res) => {
  const from = req.query.from;
  const to = req.query.to;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    return res.status(400).json({ error: 'from and to dates are required (YYYY-MM-DD).' });
  }
  if (from > to) return res.status(400).json({ error: 'The start date is after the end date.' });

  const statuses = req.query.statuses === 'approved' ? 'approved' : 'all';
  const current = periodStats(from, to, statuses);

  let previous = null;
  if (req.query.compare === '1') {
    const p = shiftPeriod(from, to);
    previous = periodStats(p.from, p.to, statuses);
  }

  // Weekly trend across the window, for the chart.
  const trend = db.prepare(`
    SELECT strftime('%Y-%W', i.invoice_date) AS bucket,
           MIN(i.invoice_date) AS bucket_start,
           SUM(i.total) AS purchases
    FROM invoices i
    WHERE i.invoice_date BETWEEN @from AND @to
      ${statuses === 'approved' ? "AND i.status = 'approved'" : ''}
    GROUP BY bucket ORDER BY bucket_start
  `).all({ from, to });

  const trendSales = db.prepare(`
    SELECT strftime('%Y-%W', sale_date) AS bucket, SUM(net_sales) AS net_sales
    FROM sales WHERE sale_date BETWEEN @from AND @to GROUP BY bucket
  `).all({ from, to });
  const salesByBucket = Object.fromEntries(trendSales.map((r) => [r.bucket, r.net_sales]));

  res.json({
    current,
    previous,
    trend: trend.map((r) => ({
      bucket_start: r.bucket_start,
      purchases: money(r.purchases),
      net_sales: money(salesByBucket[r.bucket] || 0),
    })),
  });
});

app.get('/api/dashboard', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  const stats = periodStats(monthStart, today, 'all');
  const pending = db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE status = 'review'").get().n;
  const recent = db.prepare(`
    SELECT i.id, i.invoice_number, i.invoice_date, i.total, i.status, v.name AS vendor_name
    FROM invoices i JOIN vendors v ON v.id = i.vendor_id
    ORDER BY i.created_at DESC LIMIT 8
  `).all();
  res.json({
    period: { from: monthStart, to: today },
    stats,
    pending_review: pending,
    recent,
    usage: usageTotals(monthStart, today),
  });
});

// --- errors ---------------------------------------------------------------

app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  res.status(status).json({ error: err.message || 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`\n  Invoice + COGS system running at http://localhost:${PORT}`);
  console.log(`  Automatic extraction: ${process.env.ANTHROPIC_API_KEY ? `on (${MODEL})` : 'off — add ANTHROPIC_API_KEY to .env'}\n`);
});
