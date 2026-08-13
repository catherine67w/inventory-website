'use strict';

const state = {
  meta: { categories: [], groups: {}, extraction: { enabled: false } },
  vendors: [],
  drafts: [],
  editor: null, // { id | null, source_file, items: [] }
  analysis: null,
};

/* ---------- helpers ---------- */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
  });
  // The session cookie expired or the password changed — send them to sign in.
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('Signed out.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const money = (v) =>
  (Number(v) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const money0 = (v) =>
  (Number(v) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const pct = (v) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(1)}%`);

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const todayISO = () => new Date().toISOString().slice(0, 10);

function toast(message, isError = false) {
  const node = $('#toast');
  node.textContent = message;
  node.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.add('hidden'), 3600);
}

function emptyRow(message) {
  return `<div class="empty">${esc(message)}</div>`;
}

/* ---------- date presets ---------- */

function iso(d) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function presetRange(name) {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - day);

  switch (name) {
    case 'this-week':
      return [iso(startOfWeek), iso(now)];
    case 'last-week': {
      const end = new Date(startOfWeek); end.setDate(end.getDate() - 1);
      const start = new Date(end); start.setDate(start.getDate() - 6);
      return [iso(start), iso(end)];
    }
    case 'mtd':
      return [iso(new Date(now.getFullYear(), now.getMonth(), 1)), iso(now)];
    case 'last-month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return [iso(start), iso(end)];
    }
    case 'last-30': {
      const start = new Date(now); start.setDate(start.getDate() - 29);
      return [iso(start), iso(now)];
    }
    case 'last-90': {
      const start = new Date(now); start.setDate(start.getDate() - 89);
      return [iso(start), iso(now)];
    }
    case 'qtd': {
      const q = Math.floor(now.getMonth() / 3) * 3;
      return [iso(new Date(now.getFullYear(), q, 1)), iso(now)];
    }
    case 'ytd':
      return [iso(new Date(now.getFullYear(), 0, 1)), iso(now)];
    default:
      return [iso(now), iso(now)];
  }
}

/* ---------- navigation ---------- */

const loaders = {};

function showView(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${name}`));
  if (loaders[name]) loaders[name]();
}

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) showView(btn.dataset.view);
});

/* ---------- dashboard ---------- */

loaders.dashboard = async function loadDashboard() {
  const data = await api('/api/dashboard');
  const s = data.stats;

  $('#dashboard-period').textContent =
    `Month to date · ${data.period.from} to ${data.period.to}`;

  const cards = [
    { label: 'Purchases', value: money0(s.purchases), sub: `${s.invoice_count} invoice${s.invoice_count === 1 ? '' : 's'}` },
    { label: 'Net sales', value: money0(s.net_sales), sub: s.sales_days ? `${s.sales_days} day${s.sales_days === 1 ? '' : 's'} entered` : 'no sales entered yet' },
    { label: 'COGS', value: money0(s.cogs), sub: `food, beverage, alcohol` },
    { label: 'Food cost %', value: pct(s.food_cost_pct), sub: 'food purchases ÷ net sales', cls: s.food_cost_pct !== null && s.food_cost_pct > 35 ? 'warn' : '' },
    { label: 'Gross margin', value: pct(s.gross_margin_pct), sub: 'net sales − COGS', cls: 'good' },
    { label: 'Needs review', value: String(data.pending_review), sub: 'uploaded, not approved' },
  ];

  $('#dashboard-stats').innerHTML = cards.map((c) => `
    <div class="stat ${c.cls || ''}">
      <div class="label">${esc(c.label)}</div>
      <div class="value">${esc(c.value)}</div>
      <div class="sub">${esc(c.sub)}</div>
    </div>`).join('');

  $('#dashboard-categories').innerHTML = renderCategoryBars(s.by_category);

  $('#dashboard-recent').innerHTML = data.recent.length ? `
    <table><tbody>${data.recent.map((r) => `
      <tr class="clickable" data-invoice="${r.id}">
        <td>${esc(r.vendor_name)}<div class="muted small">${esc(r.invoice_date)}${r.invoice_number ? ' · #' + esc(r.invoice_number) : ''}</div></td>
        <td class="num">${money(r.total)}</td>
        <td><span class="pill ${r.status}">${r.status === 'approved' ? 'Approved' : 'Review'}</span></td>
      </tr>`).join('')}</tbody></table>`
    : emptyRow('No invoices yet — head to Upload to add your first one.');
};

function renderCategoryBars(rows) {
  if (!rows.length) return emptyRow('No purchases in this period.');
  const max = Math.max(...rows.map((r) => r.spend));
  return rows.map((r) => `
    <div class="bar-row">
      <div>
        <div class="bar-label"><span>${esc(r.category)}</span><span class="muted">${pct(r.pct_of_sales)} of sales</span></div>
        <div class="bar-track"><div class="bar-fill ${r.group}" style="width:${max ? (r.spend / max) * 100 : 0}%"></div></div>
      </div>
      <div class="bar-value">${money(r.spend)}</div>
    </div>`).join('');
}

/* ---------- upload ---------- */

const dropzone = $('#dropzone');
const fileInput = $('#file-input');

$('#browse-btn').addEventListener('click', () => fileInput.click());
dropzone.addEventListener('click', (e) => { if (e.target === dropzone || e.target.closest('.dropzone-inner') === e.target.parentElement) fileInput.click(); });
fileInput.addEventListener('change', () => { if (fileInput.files.length) uploadFiles(fileInput.files); });

['dragenter', 'dragover'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', (e) => {
  if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
});

async function uploadFiles(fileList) {
  const form = new FormData();
  Array.from(fileList).slice(0, 20).forEach((f) => form.append('files', f));

  $('#upload-progress').classList.remove('hidden');
  $('#progress-note').textContent =
    `Reading ${fileList.length} file${fileList.length === 1 ? '' : 's'}… this takes a few seconds per invoice.`;

  try {
    const data = await api('/api/upload', { method: 'POST', body: form });
    state.drafts = data.results.concat(state.drafts);
    renderDrafts();
    const ok = data.results.filter((r) => !r.error).length;
    toast(`${ok} of ${data.results.length} read automatically. Review, then save.`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('#upload-progress').classList.add('hidden');
    fileInput.value = '';
  }
}

function renderDrafts() {
  $('#draft-list').innerHTML = state.drafts.map((d, i) => {
    const p = d.parsed;
    const itemCount = p.items.length;
    return `
      <div class="draft ${d.error ? 'failed' : ''}">
        <div class="draft-head">
          <strong>${esc(p.vendor_name || d.original_name)}</strong>
          <span class="draft-meta">
            ${p.invoice_date ? esc(p.invoice_date) : 'no date read'}
            ${p.invoice_number ? ' · #' + esc(p.invoice_number) : ''}
            · ${itemCount} line item${itemCount === 1 ? '' : 's'}
            · ${money(p.total)}
          </span>
          <div class="draft-actions">
            <button class="btn small" data-draft-review="${i}">Review &amp; save</button>
            <button class="btn small ghost" data-draft-discard="${i}">Discard</button>
          </div>
        </div>
        ${d.error ? `<div class="draft-error">${esc(d.error)}</div>` : ''}
      </div>`;
  }).join('');
}

$('#draft-list').addEventListener('click', (e) => {
  const review = e.target.closest('[data-draft-review]');
  const discard = e.target.closest('[data-draft-discard]');
  if (review) {
    const draft = state.drafts[Number(review.dataset.draftReview)];
    openEditor({ ...draft.parsed, source_file: draft.file, _draftIndex: Number(review.dataset.draftReview) });
  }
  if (discard) {
    state.drafts.splice(Number(discard.dataset.draftDiscard), 1);
    renderDrafts();
  }
});

$('#manual-new').addEventListener('click', () => openEditor(null));
$('#invoices-new').addEventListener('click', () => openEditor(null));

/* ---------- invoices ---------- */

loaders.invoices = async function loadInvoices() {
  await refreshVendors();
  const select = $('#inv-vendor');
  const chosen = select.value;
  select.innerHTML = '<option value="">All vendors</option>' +
    state.vendors.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
  select.value = chosen;

  const params = new URLSearchParams();
  if ($('#inv-from').value) params.set('from', $('#inv-from').value);
  if ($('#inv-to').value) params.set('to', $('#inv-to').value);
  if ($('#inv-vendor').value) params.set('vendor_id', $('#inv-vendor').value);
  if ($('#inv-status').value !== 'all') params.set('status', $('#inv-status').value);
  if ($('#inv-q').value.trim()) params.set('q', $('#inv-q').value.trim());

  const rows = await api('/api/invoices?' + params);
  const total = rows.reduce((s, r) => s + r.total, 0);

  $('#invoice-table').innerHTML = rows.length ? `
    <div class="table-scroll"><table>
      <thead><tr>
        <th>Date</th><th>Vendor</th><th>Invoice #</th><th class="num">Lines</th>
        <th class="num">Total</th><th>Status</th><th></th>
      </tr></thead>
      <tbody>${rows.map((r) => `
        <tr class="clickable" data-invoice="${r.id}">
          <td>${esc(r.invoice_date)}</td>
          <td>${esc(r.vendor_name)}</td>
          <td>${esc(r.invoice_number || '—')}</td>
          <td class="num">${r.item_count}</td>
          <td class="num">${money(r.total)}</td>
          <td><span class="pill ${r.status}">${r.status === 'approved' ? 'Approved' : 'Review'}</span></td>
          <td class="num">${r.status === 'review'
            ? `<button class="btn small ghost" data-approve="${r.id}">Approve</button>` : ''}</td>
        </tr>`).join('')}
      </tbody>
      <tfoot><tr>
        <td colspan="4"><strong>${rows.length} invoice${rows.length === 1 ? '' : 's'}</strong></td>
        <td class="num"><strong>${money(total)}</strong></td><td colspan="2"></td>
      </tr></tfoot>
    </table></div>`
    : emptyRow('No invoices match those filters.');
};

$('#inv-apply').addEventListener('click', loaders.invoices);
$('#inv-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') loaders.invoices(); });
$('#inv-clear').addEventListener('click', () => {
  ['#inv-from', '#inv-to', '#inv-q'].forEach((s) => { $(s).value = ''; });
  $('#inv-vendor').value = '';
  $('#inv-status').value = 'all';
  loaders.invoices();
});

document.addEventListener('click', async (e) => {
  const approve = e.target.closest('[data-approve]');
  if (approve) {
    e.stopPropagation();
    await api(`/api/invoices/${approve.dataset.approve}/status`, {
      method: 'POST', body: JSON.stringify({ status: 'approved' }),
    });
    toast('Invoice approved.');
    loaders.invoices();
    return;
  }
  const row = e.target.closest('[data-invoice]');
  if (row) editInvoice(row.dataset.invoice);
});

/* ---------- item prices ---------- */

loaders.items = async function loadItems() {
  const params = new URLSearchParams();
  if ($('#item-from').value) params.set('from', $('#item-from').value);
  if ($('#item-to').value) params.set('to', $('#item-to').value);
  if ($('#item-q').value.trim()) params.set('q', $('#item-q').value.trim());

  const rows = await api('/api/items?' + params);

  $('#items-table').innerHTML = rows.length ? `
    <div class="table-scroll"><table>
      <thead><tr>
        <th>Product</th><th>Vendor</th><th>Unit</th><th class="num">Times bought</th>
        <th class="num">Latest price</th><th class="num">Change</th>
        <th class="num">Low / high</th><th class="num">Total spend</th>
      </tr></thead>
      <tbody>${rows.map((r) => {
        const change = r.previous_price ? ((r.latest_price - r.previous_price) / r.previous_price) * 100 : null;
        const cls = change === null ? 'flat' : change > 0.5 ? 'up' : change < -0.5 ? 'down' : 'flat';
        const arrow = change === null ? '—' : `${change > 0 ? '▲' : change < 0 ? '▼' : '='} ${Math.abs(change).toFixed(1)}%`;
        return `
        <tr class="clickable" data-item="${esc(r.description)}">
          <td>${esc(r.description)}</td>
          <td>${esc(r.vendor_name)}</td>
          <td>${esc(r.unit || '—')}</td>
          <td class="num">${r.purchase_count}</td>
          <td class="num">${money(r.latest_price)}<div class="muted small">${esc(r.latest_date || '')}</div></td>
          <td class="num"><span class="delta ${cls}">${arrow}</span></td>
          <td class="num">${money(r.min_price)} / ${money(r.max_price)}</td>
          <td class="num">${money(r.total_spend)}</td>
        </tr>`; }).join('')}
      </tbody>
    </table></div>`
    : emptyRow('No purchased items yet.');
};

$('#item-apply').addEventListener('click', loaders.items);
$('#item-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') loaders.items(); });

$('#items-table').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-item]');
  if (!row) return;
  const description = row.dataset.item;
  const history = await api('/api/items/history?description=' + encodeURIComponent(description));
  $('#history-title').textContent = description;
  $('#history-body').innerHTML = `
    <table>
      <thead><tr><th>Date</th><th>Vendor</th><th>Invoice #</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Extended</th></tr></thead>
      <tbody>${history.map((h) => `
        <tr><td>${esc(h.invoice_date)}</td><td>${esc(h.vendor_name)}</td><td>${esc(h.invoice_number || '—')}</td>
        <td class="num">${h.quantity} ${esc(h.unit || '')}</td>
        <td class="num">${money(h.unit_price)}</td><td class="num">${money(h.extended_price)}</td></tr>`).join('')}
      </tbody>
    </table>`;
  $('#history').classList.remove('hidden');
});

$('#history-close').addEventListener('click', () => $('#history').classList.add('hidden'));

/* ---------- vendors ---------- */

async function refreshVendors() {
  state.vendors = await api('/api/vendors');
  $('#vendor-options').innerHTML = state.vendors.map((v) => `<option value="${esc(v.name)}">`).join('');
  return state.vendors;
}

loaders.vendors = async function loadVendors() {
  const rows = await refreshVendors();
  $('#vendors-table').innerHTML = rows.length ? `
    <div class="table-scroll"><table>
      <thead><tr><th>Vendor</th><th>Contact</th><th>Terms</th><th class="num">Invoices</th>
      <th class="num">Total spend</th><th>Last invoice</th><th></th></tr></thead>
      <tbody>${rows.map((v) => `
        <tr>
          <td>${esc(v.name)}</td>
          <td>${esc(v.contact || '—')}</td>
          <td>${esc(v.terms || '—')}</td>
          <td class="num">${v.invoice_count}</td>
          <td class="num">${money(v.total_spend)}</td>
          <td>${esc(v.last_invoice || '—')}</td>
          <td class="num"><button class="btn small ghost" data-vendor-edit="${v.id}">Edit</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>`
    : emptyRow('No vendors yet. They are created automatically when you save an invoice.');
};

$('#vendor-new').addEventListener('click', async () => {
  const name = prompt('Vendor name');
  if (!name) return;
  await api('/api/vendors', { method: 'POST', body: JSON.stringify({ name }) });
  toast('Vendor added.');
  loaders.vendors();
});

$('#vendors-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-vendor-edit]');
  if (!btn) return;
  const vendor = state.vendors.find((v) => String(v.id) === btn.dataset.vendorEdit);
  const name = prompt('Vendor name', vendor.name);
  if (name === null) return;
  const contact = prompt('Contact (optional)', vendor.contact || '') ?? '';
  const terms = prompt('Payment terms (optional)', vendor.terms || '') ?? '';
  await api(`/api/vendors/${vendor.id}`, { method: 'PUT', body: JSON.stringify({ name, contact, terms }) });
  toast('Vendor updated.');
  loaders.vendors();
});

/* ---------- net sales ---------- */

loaders.sales = async function loadSales() {
  const params = new URLSearchParams();
  if ($('#sales-from').value) params.set('from', $('#sales-from').value);
  if ($('#sales-to').value) params.set('to', $('#sales-to').value);
  const rows = await api('/api/sales?' + params);
  const total = rows.reduce((s, r) => s + r.net_sales, 0);

  $('#sales-table').innerHTML = rows.length ? `
    <div class="table-scroll"><table>
      <thead><tr><th>Date</th><th class="num">Net sales</th><th>Note</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `
        <tr>
          <td>${esc(r.sale_date)}</td>
          <td class="num">${money(r.net_sales)}</td>
          <td>${esc(r.note || '')}</td>
          <td class="num"><button class="btn small ghost" data-sale-delete="${r.sale_date}">Remove</button></td>
        </tr>`).join('')}
      </tbody>
      <tfoot><tr><td><strong>${rows.length} day${rows.length === 1 ? '' : 's'}</strong></td>
      <td class="num"><strong>${money(total)}</strong></td><td colspan="2"></td></tr></tfoot>
    </table></div>`
    : emptyRow('No net sales entered yet.');
};

$('#sales-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/sales', {
    method: 'POST',
    body: JSON.stringify({
      sale_date: $('#sale-date').value,
      net_sales: $('#sale-amount').value,
      note: $('#sale-note').value,
    }),
  });
  $('#sale-amount').value = '';
  $('#sale-note').value = '';
  toast('Net sales saved.');
  loaders.sales();
});

$('#sales-bulk-save').addEventListener('click', async () => {
  const lines = $('#sales-bulk').value.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return;
  let saved = 0;
  const failed = [];
  for (const line of lines) {
    const [date, amount, ...rest] = line.split(',').map((p) => p.trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || amount === undefined) { failed.push(line); continue; }
    try {
      await api('/api/sales', {
        method: 'POST',
        body: JSON.stringify({ sale_date: date, net_sales: amount, note: rest.join(', ') }),
      });
      saved++;
    } catch { failed.push(line); }
  }
  $('#sales-bulk').value = failed.join('\n');
  toast(failed.length ? `Saved ${saved}; ${failed.length} line(s) left in the box to fix.` : `Saved ${saved} days.`, failed.length > 0);
  loaders.sales();
});

$('#sales-filter').addEventListener('click', loaders.sales);

$('#sales-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-sale-delete]');
  if (!btn) return;
  await api('/api/sales/' + btn.dataset.saleDelete, { method: 'DELETE' });
  toast('Day removed.');
  loaders.sales();
});

/* ---------- invoice editor ---------- */

function categoryOptions(selected) {
  return state.meta.categories
    .map((c) => `<option value="${esc(c.name)}"${c.name === selected ? ' selected' : ''}>${esc(c.name)}</option>`)
    .join('');
}

function lineRow(item, index) {
  return `
    <tr data-line="${index}">
      <td><input type="text" data-f="description" value="${esc(item.description)}"></td>
      <td><input type="text" data-f="sku" value="${esc(item.sku || '')}"></td>
      <td><select data-f="category">${categoryOptions(item.category)}</select></td>
      <td class="num"><input type="number" step="0.001" data-f="quantity" value="${item.quantity ?? 0}"></td>
      <td><input type="text" data-f="unit" value="${esc(item.unit || '')}"></td>
      <td class="num"><input type="number" step="0.0001" data-f="unit_price" value="${item.unit_price ?? 0}"></td>
      <td class="num"><input type="number" step="0.01" data-f="extended_price" value="${item.extended_price ?? 0}"></td>
      <td><button class="icon-btn" data-remove-line="${index}" title="Remove line">✕</button></td>
    </tr>`;
}

function renderEditorLines() {
  $('#ed-items').innerHTML = state.editor.items.map(lineRow).join('');
  updateBalanceNote();
}

function readEditorLines() {
  return $$('#ed-items tr').map((tr) => {
    const get = (f) => tr.querySelector(`[data-f="${f}"]`).value;
    return {
      description: get('description'),
      sku: get('sku'),
      category: get('category'),
      quantity: Number(get('quantity')) || 0,
      unit: get('unit'),
      unit_price: Number(get('unit_price')) || 0,
      extended_price: Number(get('extended_price')) || 0,
    };
  }).filter((i) => i.description.trim());
}

function updateBalanceNote() {
  const lines = readEditorLines();
  const lineSum = lines.reduce((s, i) => s + i.extended_price, 0);
  const subtotal = Number($('#ed-subtotal').value) || 0;
  const total = Number($('#ed-total').value) || 0;
  const computed = subtotal + (Number($('#ed-tax').value) || 0) + (Number($('#ed-freight').value) || 0) - (Number($('#ed-discount').value) || 0);

  const notes = [`Line items add up to ${money(lineSum)}.`];
  if (Math.abs(lineSum - subtotal) > 0.02) {
    notes.push(`That is ${money(Math.abs(lineSum - subtotal))} ${lineSum > subtotal ? 'above' : 'below'} the subtotal — check for a missed or duplicated line.`);
  }
  if (Math.abs(computed - total) > 0.02) {
    notes.push(`Subtotal + tax + freight − discount is ${money(computed)}, which does not match the total.`);
  }
  $('#ed-balance').textContent = notes.join(' ');
}

function openEditor(data) {
  const base = data || {
    vendor_name: '', invoice_number: '', invoice_date: todayISO(), due_date: '',
    subtotal: 0, tax: 0, freight: 0, discount: 0, total: 0, items: [], status: 'review',
  };

  state.editor = {
    id: base.id || null,
    source_file: base.source_file || '',
    draftIndex: base._draftIndex ?? null,
    items: (base.items || []).map((i) => ({ ...i })),
  };

  $('#editor-title').textContent = base.id ? `Invoice ${base.invoice_number || base.id}` : 'New invoice';
  $('#ed-vendor').value = base.vendor_name || '';
  $('#ed-number').value = base.invoice_number || '';
  $('#ed-date').value = base.invoice_date || todayISO();
  $('#ed-due').value = base.due_date || '';
  $('#ed-status').value = base.status === 'approved' ? 'approved' : 'review';
  $('#ed-subtotal').value = base.subtotal ?? 0;
  $('#ed-tax').value = base.tax ?? 0;
  $('#ed-freight').value = base.freight ?? 0;
  $('#ed-discount').value = base.discount ?? 0;
  $('#ed-total').value = base.total ?? 0;
  $('#ed-notes').value = base.notes || '';

  const sourceLink = $('#editor-source');
  if (state.editor.source_file) {
    sourceLink.href = '/files/' + state.editor.source_file;
    sourceLink.classList.remove('hidden');
  } else {
    sourceLink.classList.add('hidden');
  }
  $('#ed-delete').classList.toggle('hidden', !base.id);

  renderEditorLines();
  refreshVendors();
  $('#editor').classList.remove('hidden');
}

async function editInvoice(id) {
  const invoice = await api('/api/invoices/' + id);
  openEditor(invoice);
}

$('#ed-add-line').addEventListener('click', () => {
  state.editor.items = readEditorLines();
  state.editor.items.push({ description: '', sku: '', category: 'Uncategorized', quantity: 1, unit: '', unit_price: 0, extended_price: 0 });
  renderEditorLines();
});

$('#ed-items').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove-line]');
  if (!btn) return;
  const items = readEditorLines();
  items.splice(Number(btn.dataset.removeLine), 1);
  state.editor.items = items;
  renderEditorLines();
});

// Keep quantity × unit price in sync with the extended price as the user types.
$('#ed-items').addEventListener('input', (e) => {
  const field = e.target.dataset.f;
  const tr = e.target.closest('tr');
  if (!tr) return;
  const val = (f) => Number(tr.querySelector(`[data-f="${f}"]`).value) || 0;
  if (field === 'quantity' || field === 'unit_price') {
    tr.querySelector('[data-f="extended_price"]').value = (val('quantity') * val('unit_price')).toFixed(2);
  } else if (field === 'extended_price' && val('quantity')) {
    tr.querySelector('[data-f="unit_price"]').value = (val('extended_price') / val('quantity')).toFixed(4);
  }
  updateBalanceNote();
});

['#ed-subtotal', '#ed-tax', '#ed-freight', '#ed-discount', '#ed-total'].forEach((sel) =>
  $(sel).addEventListener('input', updateBalanceNote));

function closeEditor() {
  $('#editor').classList.add('hidden');
  state.editor = null;
}

$('#editor-close').addEventListener('click', closeEditor);
$('#ed-cancel').addEventListener('click', closeEditor);
$('#editor').addEventListener('click', (e) => { if (e.target === $('#editor')) closeEditor(); });

$('#ed-save').addEventListener('click', async () => {
  const vendor = $('#ed-vendor').value.trim();
  if (!vendor) return toast('Enter a vendor name.', true);
  if (!$('#ed-date').value) return toast('Enter an invoice date.', true);

  const payload = {
    vendor_name: vendor,
    invoice_number: $('#ed-number').value.trim(),
    invoice_date: $('#ed-date').value,
    due_date: $('#ed-due').value,
    status: $('#ed-status').value,
    subtotal: $('#ed-subtotal').value,
    tax: $('#ed-tax').value,
    freight: $('#ed-freight').value,
    discount: $('#ed-discount').value,
    total: $('#ed-total').value,
    notes: $('#ed-notes').value,
    source_file: state.editor.source_file,
    items: readEditorLines(),
  };

  try {
    if (state.editor.id) {
      await api('/api/invoices/' + state.editor.id, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('/api/invoices', { method: 'POST', body: JSON.stringify(payload) });
    }
    if (state.editor.draftIndex !== null) {
      state.drafts.splice(state.editor.draftIndex, 1);
      renderDrafts();
    }
    toast('Invoice saved.');
    closeEditor();
    const active = $('#tabs button.active').dataset.view;
    if (loaders[active]) loaders[active]();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#ed-delete').addEventListener('click', async () => {
  if (!state.editor.id) return;
  if (!confirm('Delete this invoice and all of its line items?')) return;
  await api('/api/invoices/' + state.editor.id, { method: 'DELETE' });
  toast('Invoice deleted.');
  closeEditor();
  loaders.invoices();
});

/* ---------- profit analysis ---------- */

$('#presets').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-preset]');
  if (!btn) return;
  $$('#presets button').forEach((b) => b.classList.toggle('active', b === btn));
  const [from, to] = presetRange(btn.dataset.preset);
  $('#an-from').value = from;
  $('#an-to').value = to;
  runAnalysis();
});

['#an-from', '#an-to'].forEach((sel) =>
  $(sel).addEventListener('change', () => $$('#presets button').forEach((b) => b.classList.remove('active'))));

$('#an-run').addEventListener('click', runAnalysis);
['#an-begin', '#an-end'].forEach((sel) => $(sel).addEventListener('input', () => {
  if (state.analysis) renderAnalysis(state.analysis);
}));

loaders.analysis = function () {
  if (!$('#an-from').value) {
    const [from, to] = presetRange('mtd');
    $('#an-from').value = from;
    $('#an-to').value = to;
  }
  if (!state.analysis) runAnalysis();
};

async function runAnalysis() {
  const from = $('#an-from').value;
  const to = $('#an-to').value;
  if (!from || !to) return toast('Pick a start and end date.', true);

  const params = new URLSearchParams({ from, to });
  if ($('#an-compare').checked) params.set('compare', '1');
  if ($('#an-approved').checked) params.set('statuses', 'approved');

  try {
    state.analysis = await api('/api/analytics?' + params);
    renderAnalysis(state.analysis);
  } catch (err) {
    toast(err.message, true);
  }
}

// `higherIsBetter` flips which direction is green: costs read well when they
// fall, sales and margin when they rise.
function deltaBadge(current, previous, higherIsBetter = false) {
  if (previous === null || previous === undefined || !previous) return '';
  const diff = ((current - previous) / Math.abs(previous)) * 100;
  if (!Number.isFinite(diff)) return '';
  const rising = diff > 0.5;
  const falling = diff < -0.5;
  const good = higherIsBetter ? rising : falling;
  const cls = !rising && !falling ? 'flat' : good ? 'down' : 'up';
  const arrow = rising ? '▲' : falling ? '▼' : '=';
  return `<span class="delta ${cls}">${arrow} ${Math.abs(diff).toFixed(1)}% vs prior</span>`;
}

function renderAnalysis(data) {
  const c = data.current;
  const p = data.previous;

  // Optional inventory adjustment: true COGS = beginning + purchases − ending.
  const begin = parseFloat($('#an-begin').value);
  const end = parseFloat($('#an-end').value);
  const adjusted = Number.isFinite(begin) || Number.isFinite(end);
  const cogs = adjusted ? (begin || 0) + c.cogs - (end || 0) : c.cogs;
  const grossProfit = c.net_sales - cogs;
  const marginPct = c.net_sales > 0 ? (grossProfit / c.net_sales) * 100 : null;
  const cogsPct = c.net_sales > 0 ? (cogs / c.net_sales) * 100 : null;

  const noSales = c.net_sales <= 0;

  const stats = [
    { label: 'Net sales', value: money0(c.net_sales), sub: `${c.sales_days} day${c.sales_days === 1 ? '' : 's'} entered`, delta: p ? deltaBadge(c.net_sales, p.net_sales, true) : '' },
    { label: 'Purchases', value: money0(c.purchases), sub: `${c.invoice_count} invoice${c.invoice_count === 1 ? '' : 's'}`, delta: p ? deltaBadge(c.purchases, p.purchases) : '' },
    { label: adjusted ? 'COGS (inventory adjusted)' : 'COGS', value: money0(cogs), sub: 'food + beverage + alcohol', delta: p && !adjusted ? deltaBadge(c.cogs, p.cogs) : '' },
    { label: 'COGS %', value: pct(cogsPct), sub: 'of net sales', delta: p && !adjusted ? deltaBadge(c.cogs_pct, p.cogs_pct) : '' },
    { label: 'Gross profit', value: money0(grossProfit), sub: 'net sales − COGS', cls: 'good' },
    { label: 'Gross margin', value: pct(marginPct), sub: 'gross profit ÷ net sales', cls: 'good', delta: p && !adjusted ? deltaBadge(c.gross_margin_pct, p.gross_margin_pct, true) : '' },
  ];

  const costLines = [
    ['Food cost %', c.food_cost_pct, c.group_spend.food, p?.food_cost_pct],
    ['N/A beverage cost %', c.beverage_cost_pct, c.group_spend.beverage, p?.beverage_cost_pct],
    ['Alcohol cost %', c.alcohol_cost_pct, c.group_spend.alcohol, p?.alcohol_cost_pct],
    ['Supplies & paper %', c.supplies_pct, c.group_spend.supplies, p?.supplies_pct],
  ];

  const maxTrend = Math.max(1, ...data.trend.flatMap((t) => [t.purchases, t.net_sales]));

  $('#analysis-body').innerHTML = `
    ${noSales ? `<div class="card"><strong>No net sales entered for ${esc(c.from)} to ${esc(c.to)}.</strong>
      <p class="muted">Spend totals below are accurate, but every percentage and the margin need net sales.
      Add them on the <button class="link" data-goto="sales">Net sales</button> tab.</p></div>` : ''}

    <div class="stat-row">
      ${stats.map((s) => `
        <div class="stat ${s.cls || ''}">
          <div class="label">${esc(s.label)}</div>
          <div class="value">${esc(s.value)}</div>
          <div class="sub">${esc(s.sub)} ${s.delta || ''}</div>
        </div>`).join('')}
    </div>

    <div class="grid-2">
      <div class="card">
        <h2>Cost percentages</h2>
        <table>
          <thead><tr><th>Measure</th><th class="num">Spend</th><th class="num">% of sales</th>${p ? '<th class="num">Prior period</th>' : ''}</tr></thead>
          <tbody>${costLines.map(([label, value, spend, prior]) => `
            <tr>
              <td>${esc(label)}</td>
              <td class="num">${money(spend)}</td>
              <td class="num"><strong>${pct(value)}</strong></td>
              ${p ? `<td class="num muted">${pct(prior)}</td>` : ''}
            </tr>`).join('')}
          </tbody>
        </table>
        ${adjusted ? `<p class="muted small">Inventory adjustment applies to total COGS above; the category lines are purchases.</p>` : ''}
      </div>

      <div class="card">
        <h2>Purchases vs net sales by week</h2>
        ${data.trend.length ? `
          <div class="trend">${data.trend.map((t) => `
            <div class="trend-col">
              <div class="trend-bars">
                <div class="trend-bar sales" style="height:${(t.net_sales / maxTrend) * 120}px" title="Net sales ${money(t.net_sales)}"></div>
                <div class="trend-bar" style="height:${(t.purchases / maxTrend) * 120}px" title="Purchases ${money(t.purchases)}"></div>
              </div>
              <div class="trend-label">${esc(t.bucket_start.slice(5))}</div>
            </div>`).join('')}</div>
          <div class="legend"><span class="k-sales">Net sales</span><span class="k-purch">Purchases</span></div>`
          : emptyRow('Not enough data to chart.')}
      </div>
    </div>

    <div class="card">
      <h2>Spend by category</h2>
      ${renderCategoryBars(c.by_category)}
    </div>

    <div class="grid-2">
      <div class="card">
        <h2>Spend by vendor</h2>
        ${c.by_vendor.length ? `<table>
          <thead><tr><th>Vendor</th><th class="num">Invoices</th><th class="num">Spend</th><th class="num">% of sales</th></tr></thead>
          <tbody>${c.by_vendor.map((v) => `
            <tr><td>${esc(v.vendor_name)}</td><td class="num">${v.invoice_count}</td>
            <td class="num">${money(v.spend)}</td><td class="num">${pct(v.pct_of_sales)}</td></tr>`).join('')}
          </tbody></table>` : emptyRow('No vendor spend in this period.')}
      </div>

      <div class="card">
        <h2>Top products by spend</h2>
        ${c.top_items.length ? `<table>
          <thead><tr><th>Product</th><th class="num">Qty</th><th class="num">Spend</th></tr></thead>
          <tbody>${c.top_items.map((i) => `
            <tr><td>${esc(i.description)}</td>
            <td class="num">${(i.quantity || 0).toFixed(1)} ${esc(i.unit || '')}</td>
            <td class="num">${money(i.spend)}</td></tr>`).join('')}
          </tbody></table>` : emptyRow('No products in this period.')}
      </div>
    </div>

    ${p ? `<div class="card">
      <h2>Period comparison</h2>
      <p class="muted small">Current: ${esc(c.from)} → ${esc(c.to)} · Prior: ${esc(p.from)} → ${esc(p.to)}</p>
      <table>
        <thead><tr><th>Measure</th><th class="num">Current</th><th class="num">Prior</th><th class="num">Change</th></tr></thead>
        <tbody>
          ${[
            ['Net sales', c.net_sales, p.net_sales, 'money'],
            ['Purchases', c.purchases, p.purchases, 'money'],
            ['COGS', c.cogs, p.cogs, 'money'],
            ['Gross profit', c.gross_profit, p.gross_profit, 'money'],
            ['Food cost %', c.food_cost_pct, p.food_cost_pct, 'pct'],
            ['Gross margin %', c.gross_margin_pct, p.gross_margin_pct, 'pct'],
          ].map(([label, cur, prior, kind]) => {
            const fmt = kind === 'money' ? money : pct;
            const diff = (cur ?? 0) - (prior ?? 0);
            const sign = diff > 0 ? '+' : '';
            return `<tr><td>${esc(label)}</td><td class="num">${fmt(cur)}</td>
              <td class="num muted">${fmt(prior)}</td>
              <td class="num">${prior === null || cur === null ? '—' : sign + (kind === 'money' ? money(diff) : diff.toFixed(1) + ' pts')}</td></tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>` : ''}`;
}

$('#analysis-body').addEventListener('click', (e) => {
  const goto = e.target.closest('[data-goto]');
  if (goto) showView(goto.dataset.goto);
});

/* ---------- boot ---------- */

$('#signout-btn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

(async function init() {
  try {
    const session = await api('/api/session');
    $('#signout-btn').classList.toggle('hidden', !session.password_required);
  } catch {
    /* leave the button hidden */
  }

  try {
    state.meta = await api('/api/meta');
  } catch {
    /* fall through to defaults */
  }
  $('#extraction-status').textContent = state.meta.extraction.enabled
    ? `automatic extraction on · ${state.meta.extraction.model}`
    : 'automatic extraction off — add an API key to .env';

  const [from, to] = presetRange('mtd');
  $('#an-from').value = from;
  $('#an-to').value = to;

  $('#sale-date').value = todayISO();

  showView('dashboard');
})();
