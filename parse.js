// Extracts structured invoice data from an uploaded file.
//
// Images and PDFs go to Claude, which returns JSON matching INVOICE_SCHEMA.
// CSV/TSV files are parsed locally — no API key needed for that path.

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { NAMES } = require('./categories');

const MODEL = 'claude-opus-5';

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

async function parseWithClaude(filePath, ext) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error(
      'Automatic extraction needs an Anthropic API key. Add ANTHROPIC_API_KEY to the .env file and restart, ' +
      'or enter this invoice manually.'
    );
    err.code = 'NO_API_KEY';
    throw err;
  }

  const client = new Anthropic();
  const response = await client.messages.create({
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

  if (response.stop_reason === 'refusal') {
    throw new Error('The extraction request was declined. Enter this invoice manually.');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('This invoice is longer than one extraction pass. Split the file or enter it manually.');
  }

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
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

async function parseFile(filePath, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase();
  if (ext === '.csv' || ext === '.tsv' || ext === '.txt') return normalize(parseCsv(filePath));
  if (ext === '.pdf' || IMAGE_TYPES[ext]) return normalize(await parseWithClaude(filePath, ext));
  throw new Error(`Unsupported file type "${ext}". Upload a PDF, an image, or a CSV.`);
}

module.exports = { parseFile, MODEL };
