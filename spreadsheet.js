// Reading .xlsx without a dependency.
//
// An .xlsx is a ZIP of XML files. Node can inflate, but has no ZIP reader, so
// the container is walked here: end-of-central-directory record, then the
// central directory, then each entry's local header. Only the two compression
// methods a spreadsheet actually uses are supported (stored and deflate).
//
// Spreadsheet files come from outside the building, so nothing here trusts the
// headers: every offset is bounds-checked, and entries are size-capped.

const fs = require('fs');
const zlib = require('zlib');

const MAX_ENTRY = 40 * 1024 * 1024;   // an inflated sheet larger than this is not a report
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

function findEndOfCentralDirectory(buf) {
  // The record is at the end, after a comment of up to 64 KB.
  const start = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function readEntries(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error('This file is not a readable spreadsheet.');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (offset >= buf.length) throw new Error('This spreadsheet appears to be damaged.');

  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CD_SIG) break;

    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (uncompressedSize <= MAX_ENTRY && localOffset + 30 <= buf.length) {
      entries.set(name, { method, compressedSize, localOffset });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readFile(buf, entry) {
  const { localOffset } = entry;
  const nameLength = buf.readUInt16LE(localOffset + 26);
  const extraLength = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buf.length) throw new Error('This spreadsheet appears to be damaged.');

  const data = buf.subarray(start, end);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY });
  throw new Error('This spreadsheet uses a compression this app cannot read. Save it again as .xlsx.');
}

/* ---------- the XML inside ---------- */

const AMP = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const unescapeXml = (s) => s.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m) =>
  AMP[m] || String.fromCodePoint(Number(m[2] === 'x' ? `0x${m.slice(3, -1)}` : m.slice(2, -1))));

// Shared strings hold every piece of text in the workbook; cells point at them
// by index. Rich text splits one string across several <t> runs.
function readSharedStrings(xml) {
  if (!xml) return [];
  return (xml.match(/<si[\s>][\s\S]*?<\/si>|<si\/>/g) || []).map((si) =>
    (si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
      .map((t) => unescapeXml(t.replace(/<t[^>]*>|<\/t>/g, '')))
      .join(''));
}

// Which cell styles mean "this number is a date". Built-in formats 14-22 and
// 45-47 are dates and times; custom ones are recognised by their format code.
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function readDateStyles(xml) {
  const dateStyles = new Set();
  if (!xml) return dateStyles;

  const dateFormatIds = new Set(BUILTIN_DATE_FORMATS);
  for (const fmt of xml.match(/<numFmt[^>]*\/>/g) || []) {
    const id = Number((fmt.match(/numFmtId="(\d+)"/) || [])[1]);
    const code = unescapeXml((fmt.match(/formatCode="([^"]*)"/) || [])[1] || '');
    // A date format has d/m/y outside quoted literal text; "General" and
    // currency formats do not.
    if (/[dmyh]/i.test(code.replace(/"[^"]*"/g, '')) && !/^[^dmy]*(General|@)/.test(code)) {
      dateFormatIds.add(id);
    }
  }

  const cellXfs = (xml.match(/<cellXfs[\s\S]*?<\/cellXfs>/) || [])[0] || '';
  (cellXfs.match(/<xf[^>]*\/?>/g) || []).forEach((xf, index) => {
    const id = Number((xf.match(/numFmtId="(\d+)"/) || [])[1]);
    if (dateFormatIds.has(id)) dateStyles.add(index);
  });
  return dateStyles;
}

// Excel counts days from 1899-12-30, and believes 1900 was a leap year, so
// serials below 61 sit one day out unless they are shifted back.
function serialToDate(serial) {
  if (!(serial > 0) || serial > 2_958_465) return null;
  const days = Math.floor(serial) + (serial < 61 ? 1 : 0);
  const ms = (days - 25_569) * 86_400_000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

const columnOf = (ref) => {
  let n = 0;
  for (const ch of (ref.match(/^[A-Z]+/) || [''])[0]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function readSheet(xml, shared, dateStyles) {
  const rows = [];
  for (const rowXml of xml.match(/<row[\s>][\s\S]*?<\/row>|<row[^>]*\/>/g) || []) {
    const cells = [];
    for (const cellXml of rowXml.match(/<c[\s>][\s\S]*?<\/c>|<c[^>]*\/>/g) || []) {
      const ref = (cellXml.match(/ r="([A-Z]+\d+)"/) || [])[1] || '';
      const type = (cellXml.match(/ t="([^"]+)"/) || [])[1] || 'n';
      const style = Number((cellXml.match(/ s="(\d+)"/) || [])[1]);
      const raw = (cellXml.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      const inline = (cellXml.match(/<is>([\s\S]*?)<\/is>/) || [])[1];

      let value = null;
      let date = null;
      if (type === 's' && raw !== undefined) {
        value = shared[Number(raw)] ?? '';
      } else if (type === 'inlineStr' && inline !== undefined) {
        value = (inline.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
          .map((t) => unescapeXml(t.replace(/<t[^>]*>|<\/t>/g, ''))).join('');
      } else if (type === 'str' && raw !== undefined) {
        value = unescapeXml(raw);              // the cached result of a formula
      } else if (raw !== undefined && raw !== '') {
        value = Number(raw);
        if (Number.isNaN(value)) value = unescapeXml(raw);
        else if (dateStyles.has(style)) date = serialToDate(value);
      }

      if (value !== null && value !== '') cells[ref ? columnOf(ref) : cells.length] = { value, date };
    }
    if (cells.length) rows.push(Array.from(cells, (c) => c || null));
  }
  return rows;
}

// Returns [{ name, rows }], each row an array of { value, date } or null.
function readWorkbook(filePath) {
  const buf = fs.readFileSync(filePath);
  const entries = readEntries(buf);
  const text = (name) => (entries.has(name) ? readFile(buf, entries.get(name)).toString('utf8') : '');

  const shared = readSharedStrings(text('xl/sharedStrings.xml'));
  const dateStyles = readDateStyles(text('xl/styles.xml'));

  // Sheet names live in the workbook, their contents in files the workbook's
  // relationships point at. Falling back to sheetN.xml covers odd writers.
  const workbook = text('xl/workbook.xml');
  const rels = text('xl/_rels/workbook.xml.rels');
  const target = {};
  for (const rel of rels.match(/<Relationship[^>]*\/>/g) || []) {
    const id = (rel.match(/Id="([^"]+)"/) || [])[1];
    const path = (rel.match(/Target="([^"]+)"/) || [])[1] || '';
    if (id) target[id] = 'xl/' + path.replace(/^\/?xl\//, '').replace(/^\//, '');
  }

  const sheets = [];
  // The space matters: it keeps <sheets>, <sheetPr> and <sheetView> out.
  (workbook.match(/<sheet\s[^>]*\/?>/g) || []).forEach((sheet, index) => {
    const name = unescapeXml((sheet.match(/name="([^"]*)"/) || [])[1] || `Sheet${index + 1}`);
    const relId = (sheet.match(/r:id="([^"]+)"/) || [])[1];
    const path = target[relId] || `xl/worksheets/sheet${index + 1}.xml`;
    if (!entries.has(path)) return;
    sheets.push({ name, rows: readSheet(text(path), shared, dateStyles) });
  });

  if (!sheets.length) throw new Error('No sheets could be read from this spreadsheet.');
  return sheets;
}

// Toast delivers a whole folder of CSVs as one zip, so the container reader
// above earns a second use: pulling those files out without unpacking to disk.
function readZipTextFiles(filePath) {
  const buf = fs.readFileSync(filePath);
  const out = new Map();
  for (const [name, entry] of readEntries(buf)) {
    if (name.endsWith('/')) continue;
    try {
      out.set(name, readFile(buf, entry).toString('utf8'));
    } catch {
      // A file this reader cannot inflate is skipped rather than failing the
      // whole archive — the one that matters may still be readable.
    }
  }
  return out;
}

module.exports = { readWorkbook, readZipTextFiles, serialToDate };
