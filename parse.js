// Extracts structured invoice data from an uploaded file.
//
// Images and PDFs go to Claude, which returns JSON matching INVOICE_SCHEMA.
// CSV/TSV files are parsed locally — no API key needed for that path.

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { NAMES } = require('./categories');

const MODEL = 'claude-opus-5';

// Claude Opus 5 list prices, US dollars per million tokens. Update these if
// Anthropic changes their pricing.
const PRICING = {
  input: 5.00,
  output: 25.00,
  cache_write: 6.25,
  cache_read: 0.50,
};

// Turns an API usage object into a dollar figure.
function costOf(usage = {}) {
  const dollars =
    ((usage.input_tokens || 0) * PRICING.input +
     (usage.output_tokens || 0) * PRICING.output +
     (usage.cache_creation_input_tokens || 0) * PRICING.cache_write +
     (usage.cache_read_input_tokens || 0) * PRICING.cache_read) / 1e6;
  return Math.round(dollars * 1e6) / 1e6; // keep sub-cent precision
}

const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const num = { type: 'number' };
const str = { type: 'string' };

const INVOICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'vendor_name', 'invoice_number', 'invoice_date', 'due_date',
    'subtotal', 'tax', 'freight', 'discount', 'total', 'items',
  ],
  properties: {
    vendor_name: { ...str, description: 'Supplier/distributor name as printed on the invoice.' },
    invoice_number: { ...str, description: 'Invoice number. Empty string if not printed.' },
    invoice_date: { ...str, description: 'Invoice date as YYYY-MM-DD. Empty string if absent.' },
    due_date: { ...str, description: 'Due date as YYYY-MM-DD. Empty string if absent.' },
    subtotal: { ...num, description: 'Subtotal before tax and fees. 0 if not printed.' },
    tax: { ...num, description: 'Sales tax. 0 if none.' },
    freight: { ...num, description: 'Freight, delivery, or fuel surcharge. 0 if none.' },
    discount: { ...num, description: 'Discounts or credits as a positive number. 0 if none.' },
    total: { ...num, description: 'Invoice grand total.' },
    items: {
      type: 'array',
      description: 'One entry per line item on the invoice.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'sku', 'category', 'quantity', 'unit', 'unit_price', 'extended_price'],
        properties: {
          description: { ...str, description: 'Product description as printed.' },
          sku: { ...str, description: 'Vendor item/SKU code. Empty string if absent.' },
          category: { type: 'string', enum: NAMES, description: 'Best-fit GL category for this product.' },
          quantity: { ...num, description: 'Quantity shipped/billed.' },
          unit: { ...str, description: 'Unit of measure, e.g. CS, LB, EA, GAL.' },
          unit_price: { ...num, description: 'Price per unit.' },
          extended_price: { ...num, description: 'Line total for this item.' },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You extract line-item data from restaurant supplier invoices.

Rules:
- Transcribe what is printed. Never invent a line item, price, or total that is not on the document.
- If a value is not printed, use an empty string for text fields and 0 for numeric fields.
- Money is a plain number: no currency symbols, no thousands separators. Credits and discounts are positive numbers in the discount field; a credit line item keeps its negative extended_price.
- Dates are YYYY-MM-DD. Resolve two-digit years to the 2000s.
- extended_price is the line total, not the unit price.
- Skip non-product rows such as subtotal, tax, freight, and balance-forward lines. Those belong in the top-level fields.
- Assign each line item the GL category that best fits the product. Use "Uncategorized" only when the description is too vague to place.`;

function fileToBlock(filePath, ext) {
  const data = fs.readFileSync(filePath).toString('base64');
  if (ext === '.pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  return { type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES[ext], data } };
}

// Checks the API key before we try to use it, so a bad key produces a sentence
// the user can act on instead of a low-level encoding error. Returns null when
// the key looks usable.
function apiKeyProblem() {
  const key = process.env.ANTHROPIC_API_KEY || '';
  if (!key) {
    return 'No API key set. Add ANTHROPIC_API_KEY to the .env file and restart, or enter invoices by hand.';
  }
  if ([...key].some((c) => c.charCodeAt(0) > 255)) {
    return 'The API key in .env is a row of dots, not the real key — the hidden version got copied. ' +
           'Anthropic shows a key only once, when you create it, so create a new key and use the Copy button in that dialog.';
  }
  if (!key.startsWith('sk-ant-')) {
    return 'The API key in .env does not look like an Anthropic key (it should start with "sk-ant-"). Check the .env file.';
  }
  if (key.length < 60) {
    return `The API key in .env is only ${key.length} characters — it was cut off during copying. ` +
           'A full key is around 100. Copy it again with the Copy button rather than selecting the text.';
  }
  return null;
}

async function parseWithClaude(filePath, ext) {
  const problem = apiKeyProblem();
  if (problem) {
    const err = new Error(problem);
    err.code = 'BAD_API_KEY';
    throw err;
  }

  const client = new Anthropic();

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: INVOICE_SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content: [
            fileToBlock(filePath, ext),
            { type: 'text', text: 'Extract this invoice, including every line item.' },
          ],
        },
      ],
    });
  } catch (err) {
    // Turn SDK and network failures into something actionable.
    if (err.status === 401 || err.status === 403) {
      throw new Error('Anthropic rejected the API key in .env. Check that it was copied in full, or create a new one.');
    }
    if (err.status === 400 && /credit|balance/i.test(err.message || '')) {
      throw new Error('Your Anthropic account is out of credit. Add credit at console.anthropic.com, then try again.');
    }
    if (err.status === 429) {
      throw new Error('Too many requests at once. Wait a moment and upload again.');
    }
    if (err.status >= 500) {
      throw new Error('Anthropic had a temporary problem. Try uploading again in a minute.');
    }
    if (/ByteString|character at index/i.test(err.message || '')) {
      throw new Error('The API key in .env contains characters that are not valid in a key — most likely the masked dots. Create a new key and copy it with the Copy button.');
    }
    throw new Error(`Could not read this invoice automatically: ${err.message}`);
  }

  if (response.stop_reason === 'refusal') {
    throw new Error('The extraction request was declined. Enter this invoice manually.');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('This invoice is longer than one extraction pass. Split the file or enter it manually.');
  }

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const u = response.usage || {};
  const usage = {
    input_tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
    output_tokens: u.output_tokens || 0,
    cost: costOf(u),
    model: MODEL,
  };

  try {
    return { parsed: JSON.parse(text), usage };
  } catch {
    throw new Error('Could not read the extraction result as JSON. Enter this invoice manually.');
  }
}

// --- CSV path -------------------------------------------------------------

function splitCsvLine(line, delim) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const HEADER_ALIASES = {
  description: ['description', 'item', 'product', 'item description', 'name'],
  sku: ['sku', 'item code', 'item #', 'code', 'product code'],
  category: ['category', 'gl', 'gl category', 'class'],
  quantity: ['quantity', 'qty', 'ship qty', 'units'],
  unit: ['unit', 'uom', 'pack', 'size'],
  unit_price: ['unit price', 'price', 'unit cost', 'cost'],
  extended_price: ['extended price', 'extended', 'ext price', 'amount', 'line total', 'total'],
};

function toNumber(v) {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function parseCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error('That file is empty.');

  const delim = (lines[0].match(/\t/g) || []).length > (lines[0].match(/,/g) || []).length ? '\t' : ',';
  const header = splitCsvLine(lines[0], delim).map((h) => h.toLowerCase());

  const col = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = header.findIndex((h) => aliases.includes(h));
    if (idx !== -1) col[field] = idx;
  }
  if (col.description === undefined) {
    throw new Error('No "description" column found. The header row needs at least a description and an amount.');
  }

  const items = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line, delim);
    const description = cells[col.description] || '';
    if (!description) continue;
    const quantity = col.quantity !== undefined ? toNumber(cells[col.quantity]) : 0;
    const unitPrice = col.unit_price !== undefined ? toNumber(cells[col.unit_price]) : 0;
    let extended = col.extended_price !== undefined ? toNumber(cells[col.extended_price]) : 0;
    if (!extended) extended = +(quantity * unitPrice).toFixed(2);
    const category = col.category !== undefined ? cells[col.category] : '';
    items.push({
      description,
      sku: col.sku !== undefined ? cells[col.sku] || '' : '',
      category: NAMES.includes(category) ? category : 'Uncategorized',
      quantity,
      unit: col.unit !== undefined ? cells[col.unit] || '' : '',
      unit_price: unitPrice || (quantity ? +(extended / quantity).toFixed(4) : 0),
      extended_price: extended,
    });
  }
  if (!items.length) throw new Error('No line items found in that file.');

  const subtotal = +items.reduce((s, i) => s + i.extended_price, 0).toFixed(2);
  return {
    vendor_name: '',
    invoice_number: '',
    invoice_date: '',
    due_date: '',
    subtotal,
    tax: 0,
    freight: 0,
    discount: 0,
    total: subtotal,
    items,
  };
}


/* ---------- sales reports ---------- */

const SALES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['entries', 'reading_note'],
  properties: {
    entries: {
      type: 'array',
      description: 'One entry per business day shown on the report.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['date', 'net_sales', 'gross_sales', 'tax', 'note'],
        properties: {
          date: { type: 'string', description: 'Business date as YYYY-MM-DD. Empty string if not printed.' },
          net_sales: { type: 'number', description: 'Net sales: after discounts and comps, BEFORE tax. 0 if not printed.' },
          gross_sales: { type: 'number', description: 'Gross sales before discounts, if printed. 0 otherwise.' },
          tax: { type: 'number', description: 'Sales tax, if printed. 0 otherwise.' },
          note: { type: 'string', description: 'Anything worth flagging about this day, else empty.' },
        },
      },
    },
    period: {
      type: 'object',
      additionalProperties: false,
      required: ['label', 'start_date', 'end_date', 'net_sales'],
      description: 'The printed period / month total row, if the report shows one.',
      properties: {
        label: { type: 'string', description: 'How the total row is labelled, e.g. "MONTH TOTAL". Empty if none.' },
        start_date: { type: 'string', description: 'First date the report covers, YYYY-MM-DD. Empty if not printed.' },
        end_date: { type: 'string', description: 'Last date the report covers, YYYY-MM-DD. Empty if not printed.' },
        net_sales: { type: 'number', description: 'The printed period total of NET sales. 0 if none is printed.' },
      },
    },
    reading_note: {
      type: 'string',
      description: 'Empty when the report was clear. Otherwise say briefly what was ambiguous.',
    },
  },
};

const SALES_PROMPT = `You read sales reports from restaurant point-of-sale systems. These are
often MONTHLY SUMMARIES: one page listing every business day of a month, sometimes with weekly
subtotals and a month total at the bottom.

The number that matters is NET SALES: revenue after discounts, comps, and voids, but BEFORE
sales tax. Report labels vary — "Net Sales", "Net Revenue", "Total Net", "Subtotal". Some
reports only show a grand total that includes tax; that is NOT net sales.

Rules:
- Transcribe what is printed. Never estimate, average, or infer a figure that is not shown.
- Return one entry per BUSINESS DAY, for every day printed. A month summary of 31 days must
  return 31 entries — do not stop early, do not summarise, do not sample.
- Subtotal rows are not days. Weekly subtotals, "WEEK 1", period totals and month totals must
  never appear in entries.
- Put the report's own grand total in "period": its label, the dates it covers, and its NET
  figure. Leave period.net_sales at 0 if the only total printed includes tax.
- If the report shows ONLY a month total with no day-by-day breakdown, return no entries and
  fill in period. Never split a month total across days yourself.
- Dates are YYYY-MM-DD. Reports often print only a day number ("14") or a weekday ("Tue 14");
  take the month and year from the report heading. Resolve two-digit years to the 2000s.
- A day printed with a blank, a dash or 0.00 because the restaurant was closed is still a day:
  return it with net_sales 0 and say "closed" in its note.
- If net sales is genuinely not printed but gross and tax both are, still return net_sales as 0
  and explain in reading_note. Do not calculate it yourself.
- Money is a plain number: no currency symbols or separators.
- Use reading_note to flag anything unclear — a blurred figure, an ambiguous label, a row you
  were unsure whether to treat as a day.`;

async function parseSalesWithClaude(filePath, ext) {
  const problem = apiKeyProblem();
  if (problem) {
    const err = new Error(problem);
    err.code = 'BAD_API_KEY';
    throw err;
  }

  const client = new Anthropic();
  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      // A full month is 31 rows, and a report may run to two pages of them.
      max_tokens: 16000,
      system: SALES_PROMPT,
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: SALES_SCHEMA },
      },
      messages: [{
        role: 'user',
        content: [
          fileToBlock(filePath, ext),
          { type: 'text', text: 'Read the net sales from this report. Include every business day printed on it.' },
        ],
      }],
    });
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      throw new Error('Anthropic rejected the API key in .env. Check that it was copied in full, or create a new one.');
    }
    if (err.status === 400 && /credit|balance/i.test(err.message || '')) {
      throw new Error('Your Anthropic account is out of credit. Add credit at console.anthropic.com, then try again.');
    }
    if (err.status === 429) throw new Error('Too many requests at once. Wait a moment and upload again.');
    if (err.status >= 500) throw new Error('Anthropic had a temporary problem. Try uploading again in a minute.');
    throw new Error(`Could not read this sales report: ${err.message}`);
  }

  if (response.stop_reason === 'refusal') {
    throw new Error('The request was declined. Enter these figures by hand.');
  }

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const u = response.usage || {};
  const usage = {
    input_tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
    output_tokens: u.output_tokens || 0,
    cost: costOf(u),
  };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Could not read the result as data. Enter these figures by hand.');
  }

  const seen = new Set();
  const entries = (Array.isArray(parsed.entries) ? parsed.entries : [])
    .map((e) => ({
      date: /^\d{4}-\d{2}-\d{2}$/.test(e.date || '') ? e.date : '',
      net_sales: toNumber(e.net_sales),
      gross_sales: toNumber(e.gross_sales),
      tax: toNumber(e.tax),
      note: String(e.note || '').trim(),
    }))
    // A row with neither a date nor a figure carries nothing worth reviewing.
    .filter((e) => e.date || e.net_sales)
    // One row per date: a month read twice off the same page would otherwise
    // show up as a duplicate day the reviewer has to spot by eye.
    .filter((e) => {
      if (!e.date) return true;
      if (seen.has(e.date)) return false;
      seen.add(e.date);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const p = parsed.period || {};
  const period = {
    label: String(p.label || '').trim(),
    start_date: /^\d{4}-\d{2}-\d{2}$/.test(p.start_date || '') ? p.start_date : '',
    end_date: /^\d{4}-\d{2}-\d{2}$/.test(p.end_date || '') ? p.end_date : '',
    net_sales: toNumber(p.net_sales),
  };

  return { entries, period, reading_note: String(parsed.reading_note || '').trim(), usage };
}

async function parseSalesFile(filePath, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase();
  if (ext !== '.pdf' && !IMAGE_TYPES[ext]) {
    throw new Error(`Unsupported file type "${ext}". Upload a photo, a screenshot, or a PDF.`);
  }
  return parseSalesWithClaude(filePath, ext);
}

// --- entry point ----------------------------------------------------------

function normalize(parsed) {
  const items = (Array.isArray(parsed.items) ? parsed.items : []).map((it) => {
    const quantity = toNumber(it.quantity);
    const unitPrice = toNumber(it.unit_price);
    let extended = toNumber(it.extended_price);
    if (!extended && quantity && unitPrice) extended = +(quantity * unitPrice).toFixed(2);
    return {
      description: String(it.description || '').trim(),
      sku: String(it.sku || '').trim(),
      category: NAMES.includes(it.category) ? it.category : 'Uncategorized',
      quantity,
      unit: String(it.unit || '').trim(),
      unit_price: unitPrice || (quantity ? +(extended / quantity).toFixed(4) : 0),
      extended_price: extended,
    };
  }).filter((it) => it.description);

  const subtotal = toNumber(parsed.subtotal) || +items.reduce((s, i) => s + i.extended_price, 0).toFixed(2);
  const tax = toNumber(parsed.tax);
  const freight = toNumber(parsed.freight);
  const discount = toNumber(parsed.discount);
  const total = toNumber(parsed.total) || +(subtotal + tax + freight - discount).toFixed(2);

  return {
    vendor_name: String(parsed.vendor_name || '').trim(),
    invoice_number: String(parsed.invoice_number || '').trim(),
    invoice_date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.invoice_date || '') ? parsed.invoice_date : '',
    due_date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.due_date || '') ? parsed.due_date : '',
    subtotal, tax, freight, discount, total, items,
  };
}

// Returns { data, usage } — usage is null for paths that cost nothing.
const FREE = { input_tokens: 0, output_tokens: 0, cost: 0, model: null };

async function parseFile(filePath, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase();
  if (ext === '.csv' || ext === '.tsv' || ext === '.txt') {
    return { data: normalize(parseCsv(filePath)), usage: FREE };
  }
  if (ext === '.pdf' || IMAGE_TYPES[ext]) {
    const { parsed, usage } = await parseWithClaude(filePath, ext);
    return { data: normalize(parsed), usage };
  }
  throw new Error(`Unsupported file type "${ext}". Upload a PDF, an image, or a CSV.`);
}

module.exports = { parseFile, parseSalesFile, apiKeyProblem, costOf, PRICING, MODEL };
