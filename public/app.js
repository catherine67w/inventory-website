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

// Sub-dollar amounts read better in cents.
const cost = (v) => {
  const n = Number(v) || 0;
  if (n === 0) return 'free';
  if (n < 1) return `${(n * 100).toFixed(1)}¢`;
  return money(n);
};

const tokens = (v) => (Number(v) || 0).toLocaleString('en-US');

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
    {
      label: 'Invoice reading',
      value: cost(data.usage.cost),
      sub: data.usage.read_automatically
        ? `${data.usage.read_automatically} read · ${cost(data.usage.average_cost)} each`
        : 'nothing read automatically yet',
    },
  ];

  $('#dashboard-stats').innerHTML = cards.map((c) => `
    <div class="stat ${c.cls || ''}">
      <div class="label">${esc(c.label)}</div>
      <div class="value">${esc(c.value)}</div>
      <div class="sub">${esc(c.sub)}</div>
    </div>`).join('');

  $('#dashboard-categories').innerHTML = renderCategoryBars(s.by_category);

  renderSpend();

  $('#dashboard-recent').innerHTML = data.recent.length ? `
    <table><tbody>${data.recent.map((r) => `
      <tr class="clickable" data-invoice="${r.id}">
        <td>${esc(r.vendor_name)}<div class="muted small">${esc(r.invoice_date)}${r.invoice_number ? ' · #' + esc(r.invoice_number) : ''}</div></td>
        <td class="num">${money(r.total)}</td>
        <td><span class="pill ${r.status}">${r.status === 'approved' ? 'Approved' : 'Review'}</span></td>
      </tr>`).join('')}</tbody></table>`
    : emptyRow('No invoices yet — head to Upload to add your first one.');
};

async function renderSpend() {
  const target = $('#dashboard-spend');
  if (!target) return;
  let u;
  try {
    u = await api('/api/usage');
  } catch {
    return;
  }

  const monthRows = u.by_month.filter((m) => m.read_automatically > 0);

  target.innerHTML = `
    <div class="spend-head">
      <div>
        <div class="spend-value">${cost(u.all_time.cost)}</div>
        <div class="muted small">spent on invoice reading, all time</div>
      </div>
      <div class="spend-side">
        <div><strong>${tokens(u.all_time.input_tokens + u.all_time.output_tokens)}</strong> tokens used</div>
        <div class="muted small">${u.all_time.read_automatically} invoice${u.all_time.read_automatically === 1 ? '' : 's'} read automatically</div>
      </div>
    </div>
    ${monthRows.length ? `
      <table>
        <thead><tr><th>Month</th><th class="num">Read</th><th class="num">Cost</th><th class="num">Average</th></tr></thead>
        <tbody>${monthRows.map((m) => `
          <tr>
            <td>${esc(m.month)}</td>
            <td class="num">${m.read_automatically}</td>
            <td class="num">${cost(m.cost)}</td>
            <td class="num">${cost(m.cost / m.read_automatically)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`
      : '<p class="muted small">No invoices have been read automatically yet. Typed-in and CSV invoices cost nothing.</p>'}
    <p class="muted small">Billed at $${u.pricing.input.toFixed(2)} per million tokens in and
      $${u.pricing.output.toFixed(2)} per million out. These are the real figures reported for
      each invoice, not estimates.</p>`;
}

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
    const u = d.usage || {};
    const costLine = u.cost > 0
      ? `<span class="draft-cost" title="${tokens(u.input_tokens)} tokens in, ${tokens(u.output_tokens)} out">
           read for ${cost(u.cost)}</span>`
      : '';
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
          ${costLine}
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
    openEditor({
      ...draft.parsed,
      source_file: draft.file,
      usage: draft.usage,
      _draftIndex: Number(review.dataset.draftReview),
    });
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

state.itemSort = { sort: 'total_spend', dir: 'desc' };

// Header cell that sorts. Clicking the active column flips direction.
function sortHeader(label, key, cls = '') {
  const active = state.itemSort.sort === key;
  const arrow = active ? (state.itemSort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  return `<th class="${cls} sortable${active ? ' active' : ''}" data-sort="${key}"
    title="Sort by ${label.toLowerCase()}">${label}${arrow}</th>`;
}

loaders.items = async function loadItems() {
  const params = new URLSearchParams();
  params.set('sort', state.itemSort.sort);
  params.set('dir', state.itemSort.dir);
  if ($('#item-from').value) params.set('from', $('#item-from').value);
  if ($('#item-to').value) params.set('to', $('#item-to').value);
  if ($('#item-q').value.trim()) params.set('q', $('#item-q').value.trim());

  const rows = await api('/api/items?' + params);

  const dirLabel = state.itemSort.sort === 'total_spend'
    ? (state.itemSort.dir === 'asc' ? 'cheapest first' : 'most expensive first')
    : '';

  $('#items-table').innerHTML = rows.length ? `
    <div class="sort-bar">
      <span class="muted small">Sorted by
        <strong>${esc(({
          total_spend: 'total spend', latest_price: 'latest price',
          purchase_count: 'times bought', description: 'product name', vendor: 'vendor',
        })[state.itemSort.sort])}</strong>${dirLabel ? ' — ' + dirLabel : ''}</span>
      <span class="spacer"></span>
      <button class="btn small ghost" data-quick-sort="asc">Total spend: cheapest first</button>
      <button class="btn small ghost" data-quick-sort="desc">Total spend: dearest first</button>
    </div>
    <div class="table-scroll"><table>
      <thead><tr>
        ${sortHeader('Product', 'description')}
        ${sortHeader('Vendor', 'vendor')}
        <th>Unit</th>
        ${sortHeader('Times bought', 'purchase_count', 'num')}
        ${sortHeader('Latest price', 'latest_price', 'num')}
        <th class="num">Change</th>
        <th class="num">Low / high</th>
        ${sortHeader('Total spend', 'total_spend', 'num')}
        <th></th>
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
          <td class="num"><button class="btn small ghost" data-link-item="${esc(r.description)}" data-link-unit="${esc(r.unit || '')}">Add to menu</button></td>
        </tr>`; }).join('')}
      </tbody>
    </table></div>`
    : emptyRow('No purchased items yet.');
};

$('#item-apply').addEventListener('click', loaders.items);

$('#items-table').addEventListener('click', (e) => {
  const quick = e.target.closest('[data-quick-sort]');
  if (quick) {
    state.itemSort = { sort: 'total_spend', dir: quick.dataset.quickSort };
    loaders.items();
    return;
  }

  const th = e.target.closest('th.sortable');
  if (!th) return;
  const key = th.dataset.sort;
  if (state.itemSort.sort === key) {
    state.itemSort.dir = state.itemSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    state.itemSort.sort = key;
    // Money and counts are most useful highest-first; names read A-Z.
    state.itemSort.dir = (key === 'description' || key === 'vendor') ? 'asc' : 'desc';
  }
  loaders.items();
});
$('#item-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') loaders.items(); });

$('#items-table').addEventListener('click', async (e) => {
  const linkBtn = e.target.closest('[data-link-item]');
  if (linkBtn) {
    e.stopPropagation();
    openLinkEditor(linkBtn.dataset.linkItem, linkBtn.dataset.linkUnit);
    return;
  }

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
        <tr class="clickable" data-vendor-items="${v.id}">
          <td>${esc(v.name)}</td>
          <td>${esc(v.contact || '—')}</td>
          <td>${esc(v.terms || '—')}</td>
          <td class="num">${v.invoice_count}</td>
          <td class="num">${money(v.total_spend)}</td>
          <td>${esc(v.last_invoice || '—')}</td>
          <td class="num">
            <button class="btn small ghost" data-vendor-items="${v.id}">Search items</button>
            <button class="btn small ghost" data-vendor-edit="${v.id}">Edit</button>
          </td>
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
  if (!btn) {
    const row = e.target.closest('[data-vendor-items]');
    if (row) openVendorItems(row.dataset.vendorItems);
    return;
  }
  e.stopPropagation();
  const vendor = state.vendors.find((v) => String(v.id) === btn.dataset.vendorEdit);
  const name = prompt('Vendor name', vendor.name);
  if (name === null) return;
  const contact = prompt('Contact (optional)', vendor.contact || '') ?? '';
  const terms = prompt('Payment terms (optional)', vendor.terms || '') ?? '';
  await api(`/api/vendors/${vendor.id}`, { method: 'PUT', body: JSON.stringify({ name, contact, terms }) });
  toast('Vendor updated.');
  loaders.vendors();
});


/* ---------- searching one vendor's items ---------- */

state.vendorItems = { id: null, timer: null, sort: 'total_spend', dir: 'desc' };

async function openVendorItems(vendorId) {
  state.vendorItems.id = vendorId;
  state.vendorItems.sort = 'total_spend';
  state.vendorItems.dir = 'desc';
  ['#vi-q', '#vi-from', '#vi-to'].forEach((s) => { $(s).value = ''; });
  $('#vi-mode').value = 'products';
  $('#vendor-items').classList.remove('hidden');
  await loadVendorItems();
}

async function loadVendorItems() {
  const id = state.vendorItems.id;
  if (!id) return;

  const params = new URLSearchParams();
  params.set('sort', state.vendorItems.sort || 'total_spend');
  params.set('dir', state.vendorItems.dir || 'desc');
  if ($('#vi-q').value.trim()) params.set('q', $('#vi-q').value.trim());
  if ($('#vi-from').value) params.set('from', $('#vi-from').value);
  if ($('#vi-to').value) params.set('to', $('#vi-to').value);

  let data;
  try {
    data = await api(`/api/vendors/${id}/items?` + params);
  } catch (err) {
    $('#vi-results').innerHTML = emptyRow(err.message);
    return;
  }

  $('#vi-title').textContent = data.vendor.name;

  const s = data.summary;
  const filtered = Boolean($('#vi-q').value.trim() || $('#vi-from').value || $('#vi-to').value);
  $('#vi-summary').innerHTML = `
    <p class="muted small">${filtered ? 'Matching ' : ''}${s.product_count} product${s.product_count === 1 ? '' : 's'}
      across ${s.line_count} invoice line${s.line_count === 1 ? '' : 's'} — <strong>${money(s.total)}</strong>.</p>`;

  const mode = $('#vi-mode').value;

  if (!s.line_count) {
    $('#vi-results').innerHTML = emptyRow(filtered
      ? 'Nothing from this vendor matches that.'
      : 'No invoice items recorded for this vendor yet.');
    return;
  }

  $('#vi-results').innerHTML = mode === 'products' ? `
    <div class="sort-bar">
      <span class="muted small">Total spend, ${state.vendorItems.dir === 'asc' ? 'cheapest first' : 'dearest first'}</span>
      <span class="spacer"></span>
      <button class="btn small ghost" data-vi-sort="asc">Cheapest first</button>
      <button class="btn small ghost" data-vi-sort="desc">Dearest first</button>
    </div>
    <div class="table-scroll"><table>
      <thead><tr>
        <th>Product</th><th>Category</th><th class="num">Times</th><th class="num">Qty</th>
        <th class="num">Low / high</th><th class="num">Total spend</th><th>Last bought</th>
      </tr></thead>
      <tbody>${data.products.map((p) => `
        <tr>
          <td>${esc(p.description)}</td>
          <td><span class="pill group">${esc(p.category)}</span></td>
          <td class="num">${p.times_bought}</td>
          <td class="num">${(p.total_quantity || 0).toFixed(1)} ${esc(p.unit || '')}</td>
          <td class="num">${money(p.min_price)} / ${money(p.max_price)}</td>
          <td class="num">${money(p.total_spend)}</td>
          <td>${esc(p.last_bought || '')}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>`
    : `
    <div class="table-scroll"><table>
      <thead><tr>
        <th>Date</th><th>Invoice #</th><th>Product</th><th>SKU</th>
        <th class="num">Qty</th><th class="num">Unit price</th><th class="num">Extended</th>
      </tr></thead>
      <tbody>${data.lines.map((l) => `
        <tr class="clickable" data-invoice="${l.invoice_id}">
          <td>${esc(l.invoice_date)}</td>
          <td>${esc(l.invoice_number || '—')}</td>
          <td>${esc(l.description)}</td>
          <td>${esc(l.sku || '—')}</td>
          <td class="num">${l.quantity} ${esc(l.unit || '')}</td>
          <td class="num">${money(l.unit_price)}</td>
          <td class="num">${money(l.extended_price)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    <p class="muted small">Click any line to open that invoice.</p>`;
}

// Debounced so it searches as you type without a request per keystroke.
$('#vi-q').addEventListener('input', () => {
  clearTimeout(state.vendorItems.timer);
  state.vendorItems.timer = setTimeout(loadVendorItems, 250);
});
['#vi-from', '#vi-to', '#vi-mode'].forEach((sel) =>
  $(sel).addEventListener('change', loadVendorItems));

function closeVendorItems() {
  $('#vendor-items').classList.add('hidden');
  state.vendorItems.id = null;
}

$('#vi-close').addEventListener('click', closeVendorItems);
$('#vi-done').addEventListener('click', closeVendorItems);
$('#vendor-items').addEventListener('click', (e) => {
  const sortBtn = e.target.closest('[data-vi-sort]');
  if (sortBtn) {
    state.vendorItems.dir = sortBtn.dataset.viSort;
    loadVendorItems();
    return;
  }
  if (e.target === $('#vendor-items')) closeVendorItems();
  // Opening an invoice from here replaces this modal with the invoice editor.
  if (e.target.closest('[data-invoice]')) closeVendorItems();
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


/* ---------- menu ---------- */

state.menu = { sections: [], summary: null };

loaders.menu = async function loadMenu() {
  const data = await api('/api/menu');
  state.menu = data;

  const s = data.summary;
  $('#menu-stats').innerHTML = [
    { label: 'Items on the menu', value: String(s.items), sub: `${s.sections} sections` },
    { label: 'Cheapest', value: money(s.cheapest), sub: 'lowest priced item' },
    { label: 'Dearest', value: money(s.dearest), sub: 'highest priced item' },
    { label: 'Average price', value: money(s.average), sub: 'across all items' },
    { label: 'Unavailable', value: String(s.unavailable), sub: 'marked off the menu', cls: s.unavailable ? 'warn' : '' },
  ].map((c) => `
    <div class="stat ${c.cls || ''}">
      <div class="label">${esc(c.label)}</div>
      <div class="value">${esc(c.value)}</div>
      <div class="sub">${esc(c.sub)}</div>
    </div>`).join('');

  const filter = $('#menu-section-filter');
  const chosen = filter.value;
  filter.innerHTML = '<option value="">All sections</option>' +
    data.sections.map((sec) => `<option value="${sec.id}">${esc(sec.name)}</option>`).join('');
  filter.value = chosen;

  renderMenu();
};

function renderMenu() {
  const q = $('#menu-q').value.trim().toLowerCase();
  const sectionId = $('#menu-section-filter').value;
  const hideUnavailable = $('#menu-hide-unavailable').checked;

  const matches = (item) => {
    if (hideUnavailable && !item.available) return false;
    if (!q) return true;
    return `${item.code} ${item.name} ${item.name_zh} ${item.note}`.toLowerCase().includes(q);
  };

  const sections = state.menu.sections
    .filter((sec) => !sectionId || String(sec.id) === sectionId)
    .map((sec) => ({ ...sec, items: sec.items.filter(matches) }))
    .filter((sec) => sec.items.length);

  const shown = sections.reduce((n, sec) => n + sec.items.length, 0);

  $('#menu-body').innerHTML = sections.length ? `
    ${q || sectionId || hideUnavailable
      ? `<p class="muted small">Showing ${shown} item${shown === 1 ? '' : 's'}.</p>` : ''}
    ${sections.map((sec) => `
      <div class="card menu-section">
        <div class="menu-section-head">
          <h2>${esc(sec.name)} ${sec.name_zh ? `<span class="zh">${esc(sec.name_zh)}</span>` : ''}</h2>
          <span class="muted small">${sec.items.length} item${sec.items.length === 1 ? '' : 's'}</span>
        </div>
        ${sec.note ? `<p class="muted small">${esc(sec.note)}</p>` : ''}
        <div class="menu-grid">
          ${sec.items.map((item) => `
            <div class="menu-item ${item.available ? '' : 'off'}" data-menu-item="${item.id}" title="Click to edit">
              <div class="mi-main">
                ${item.code ? `<span class="mi-code">${esc(item.code)}</span>` : ''}
                <span class="mi-name">${esc(item.name)}</span>
                ${item.is_new ? '<span class="mi-tag">New</span>' : ''}
                ${item.available ? '' : '<span class="mi-tag off">Unavailable</span>'}
              </div>
              ${item.name_zh ? `<div class="mi-zh">${esc(item.name_zh)}</div>` : ''}
              ${item.note ? `<div class="mi-note">${esc(item.note)}</div>` : ''}
              <div class="mi-price">${money(item.price)}${
                item.price_large ? ` <span class="mi-alt">/ ${money(item.price_large)}</span>` : ''}</div>
            </div>`).join('')}
        </div>
      </div>`).join('')}`
    : emptyRow(q || sectionId ? 'Nothing on the menu matches that.' : 'The menu is empty. Add an item to start.');
}

['#menu-q', '#menu-section-filter', '#menu-hide-unavailable'].forEach((sel) =>
  $(sel).addEventListener('input', renderMenu));

$('#menu-body').addEventListener('click', (e) => {
  const el = e.target.closest('[data-menu-item]');
  if (!el) return;
  const id = Number(el.dataset.menuItem);
  for (const sec of state.menu.sections) {
    const item = sec.items.find((i) => i.id === id);
    if (item) return openMenuItem(item);
  }
});

$('#menu-new-item').addEventListener('click', () => openMenuItem(null));

$('#menu-add-section').addEventListener('click', async () => {
  const name = prompt('Section name (English)');
  if (!name) return;
  const nameZh = prompt('Section name (Chinese, optional)', '') ?? '';
  try {
    await api('/api/menu/sections', { method: 'POST', body: JSON.stringify({ name, name_zh: nameZh }) });
    toast('Section added.');
    loaders.menu();
  } catch (err) {
    toast(err.message, true);
  }
});

function openMenuItem(item) {
  state.menuItem = item;
  $('#menu-editor-title').textContent = item ? (item.name || 'Menu item') : 'New menu item';
  $('#mi-section').innerHTML = state.menu.sections
    .map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('#mi-section').value = item ? item.section_id : (state.menu.sections[0]?.id || '');
  $('#mi-code').value = item ? item.code : '';
  $('#mi-name').value = item ? item.name : '';
  $('#mi-name-zh').value = item ? item.name_zh : '';
  $('#mi-price').value = item ? item.price : '';
  $('#mi-price-large').value = item && item.price_large != null ? item.price_large : '';
  $('#mi-note').value = item ? item.note : '';
  $('#mi-new').checked = Boolean(item && item.is_new);
  $('#mi-available').checked = item ? Boolean(item.available) : true;
  $('#mi-delete').classList.toggle('hidden', !item);
  $('#menu-editor').classList.remove('hidden');
  renderRecipe(item ? item.id : null);
}

function closeMenuItem() {
  $('#menu-editor').classList.add('hidden');
  state.menuItem = null;
}

$('#menu-editor-close').addEventListener('click', closeMenuItem);
$('#mi-cancel').addEventListener('click', closeMenuItem);
$('#menu-editor').addEventListener('click', (e) => {
  if (e.target === $('#menu-editor')) closeMenuItem();
});

$('#mi-save').addEventListener('click', async () => {
  const payload = {
    section_id: Number($('#mi-section').value),
    code: $('#mi-code').value.trim(),
    name: $('#mi-name').value.trim(),
    name_zh: $('#mi-name-zh').value.trim(),
    price: $('#mi-price').value || 0,
    price_large: $('#mi-price-large').value,
    note: $('#mi-note').value.trim(),
    is_new: $('#mi-new').checked,
    available: $('#mi-available').checked,
  };
  if (!payload.name) return toast('Give the item a name.', true);

  try {
    if (state.menuItem) {
      await api('/api/menu/items/' + state.menuItem.id, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await api('/api/menu/items', { method: 'POST', body: JSON.stringify(payload) });
    }
    toast('Menu item saved.');
    closeMenuItem();
    loaders.menu();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#mi-delete').addEventListener('click', async () => {
  if (!state.menuItem) return;
  if (!confirm(`Remove "${state.menuItem.name}" from the menu?`)) return;
  await api('/api/menu/items/' + state.menuItem.id, { method: 'DELETE' });
  toast('Item removed.');
  closeMenuItem();
  loaders.menu();
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
    // Usage arrives on a draft; on a saved invoice it comes back as columns.
    usage: base.usage || {
      input_tokens: base.input_tokens || 0,
      output_tokens: base.output_tokens || 0,
      cost: base.extraction_cost || 0,
    },
    items: (base.items || []).map((i) => ({ ...i })),
  };

  const u = state.editor.usage;
  $('#ed-usage').textContent = u && u.cost > 0
    ? `Read automatically for ${cost(u.cost)} — ${tokens(u.input_tokens)} tokens in, ${tokens(u.output_tokens)} out.`
    : '';

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
    usage: state.editor.usage,
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



/* ---------- linking purchased items to menu items ---------- */

state.link = { description: '', unit: '' };

async function openLinkEditor(description, purchasedUnit) {
  state.link = { description, unit: purchasedUnit || '' };

  const [flat, usage] = await Promise.all([
    api('/api/menu/flat'),
    api('/api/menu/usage?description=' + encodeURIComponent(description)),
  ]);

  $('#link-ingredient').textContent = description;

  $('#link-usage').innerHTML = usage.length ? `
    <p class="muted small">Already used in ${usage.length} menu item${usage.length === 1 ? '' : 's'}:
      ${usage.map((u) => esc((u.code ? u.code + ' ' : '') + u.name)).join(', ')}.</p>` : '';

  const used = new Set(usage.map((u) => u.menu_item_id));
  let currentSection = '';
  let html = '';
  for (const item of flat) {
    if (item.section_name !== currentSection) {
      if (currentSection) html += '</optgroup>';
      html += `<optgroup label="${esc(item.section_name)}">`;
      currentSection = item.section_name;
    }
    const label = `${item.code ? item.code + ' · ' : ''}${item.name} — ${money(item.price)}` +
      (used.has(item.id) ? ' (already added)' : '');
    html += `<option value="${item.id}"${used.has(item.id) ? ' disabled' : ''}>${esc(label)}</option>`;
  }
  if (currentSection) html += '</optgroup>';
  $('#link-menu-item').innerHTML = html;

  $('#link-qty').value = '';
  $('#link-unit').value = purchasedUnit || '';
  $('#link-note').value = '';
  $('#link-hint').textContent = purchasedUnit
    ? `You buy this by the ${purchasedUnit}. Enter how much of one ${purchasedUnit} goes into a single serving — 0.25 means a quarter.`
    : 'Enter how much of one purchased unit goes into a single serving.';

  $('#link-editor').classList.remove('hidden');
}

function closeLinkEditor() { $('#link-editor').classList.add('hidden'); }

$('#link-close').addEventListener('click', closeLinkEditor);
$('#link-cancel').addEventListener('click', closeLinkEditor);
$('#link-editor').addEventListener('click', (e) => {
  if (e.target === $('#link-editor')) closeLinkEditor();
});

$('#link-save').addEventListener('click', async () => {
  const menuItemId = $('#link-menu-item').value;
  if (!menuItemId) return toast('Pick a menu item.', true);
  const qty = Number($('#link-qty').value) || 0;
  if (qty <= 0 && !confirm('No quantity entered, so this will not add anything to the plate cost. Add it anyway?')) return;

  try {
    await api(`/api/menu/items/${menuItemId}/ingredients`, {
      method: 'POST',
      body: JSON.stringify({
        description: state.link.description,
        quantity: qty,
        unit: $('#link-unit').value.trim(),
        note: $('#link-note').value.trim(),
      }),
    });
    toast('Added to the menu item.');
    closeLinkEditor();
    if ($('#tabs button.active').dataset.view === 'items') loaders.items();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------- recipe panel inside the menu item editor ---------- */

async function renderRecipe(menuItemId) {
  const panel = $('#mi-recipe');
  if (!menuItemId) {
    panel.innerHTML = '<p class="muted small">Save this item first, then you can add ingredients to it.</p>';
    return;
  }

  let data;
  try {
    data = await api('/api/menu/items/' + menuItemId);
  } catch {
    panel.innerHTML = '';
    return;
  }

  const c = data.costing;
  const priceKnown = data.price > 0;

  panel.innerHTML = `
    <h3>What this dish costs</h3>
    ${data.ingredients.length ? `
      <div class="table-scroll">
        <table class="recipe-table">
          <thead><tr>
            <th>Purchased ingredient</th><th class="num">Qty</th><th>Unit</th>
            <th class="num">Latest price</th><th class="num">Cost</th><th></th>
          </tr></thead>
          <tbody>${data.ingredients.map((ing) => `
            <tr>
              <td>${esc(ing.description)}
                ${ing.last_bought ? `<div class="muted small">${esc(ing.vendor_name || '')} · ${esc(ing.last_bought)}</div>`
                  : '<div class="muted small warn-text">never purchased — no price to cost with</div>'}</td>
              <td class="num">${ing.quantity}</td>
              <td>${esc(ing.unit || '')}</td>
              <td class="num">${ing.latest_unit_price === null ? '—' : money(ing.latest_unit_price)}</td>
              <td class="num">${ing.line_cost === null ? '—' : money(ing.line_cost)}</td>
              <td class="num"><button class="icon-btn" data-remove-ingredient="${ing.id}" title="Remove">✕</button></td>
            </tr>`).join('')}
          </tbody>
          <tfoot><tr>
            <td colspan="4"><strong>Plate cost</strong></td>
            <td class="num"><strong>${money(c.cost)}</strong></td><td></td>
          </tr></tfoot>
        </table>
      </div>
      ${c.complete && priceKnown ? `
        <div class="recipe-summary">
          <div><span class="muted small">Menu price</span><strong>${money(data.price)}</strong></div>
          <div><span class="muted small">Food cost</span><strong class="${c.food_cost_pct > 35 ? 'warn-text' : 'ok-text'}">${c.food_cost_pct}%</strong></div>
          <div><span class="muted small">Margin</span><strong class="ok-text">${money(c.margin)}</strong></div>
          <div><span class="muted small">Margin %</span><strong class="ok-text">${c.margin_pct}%</strong></div>
        </div>`
        : `<p class="muted small">${
            !priceKnown ? 'Set a menu price to see the margin.'
            : `${c.ingredient_count - c.priced_count} ingredient${c.ingredient_count - c.priced_count === 1 ? ' has' : 's have'} never been purchased, so the cost is incomplete.`}</p>`}`
      : '<p class="muted small">No ingredients linked yet. Go to <strong>Item prices</strong> and use <em>Add to menu</em> on the products that go into this dish.</p>'}`;
}

$('#mi-recipe').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-remove-ingredient]');
  if (!btn) return;
  await api('/api/menu/ingredients/' + btn.dataset.removeIngredient, { method: 'DELETE' });
  toast('Ingredient removed.');
  renderRecipe(state.menuItem ? state.menuItem.id : null);
});

/* ---------- security ---------- */

loaders.security = async function loadSecurity() {
  const status = await api('/api/2fa/status');
  state.twofa = status;

  $('#security-status').innerHTML = `
    <div class="sec-list">
      <div class="sec-row on">
        <span class="sec-mark">✓</span>
        <div>
          <strong>Shared password</strong>
          <div class="muted small">Everyone signs in with the same password, set in the .env file on the Mac.</div>
        </div>
      </div>
      <div class="sec-row ${status.enabled ? 'on' : 'off'}">
        <span class="sec-mark">${status.enabled ? '✓' : '○'}</span>
        <div>
          <strong>Two-factor code</strong>
          <div class="muted small">${status.enabled
            ? 'A six-digit code from an authenticator app is required as well as the password.'
            : 'Not turned on. The password alone gets someone in.'}</div>
        </div>
      </div>
      <div class="sec-row on">
        <span class="sec-mark">✓</span>
        <div>
          <strong>Lockout after repeated failures</strong>
          <div class="muted small">${status.lockout.max_attempts} wrong attempts locks that device out
            for ${status.lockout.lock_minutes} minutes. Every failure is logged on the Mac.</div>
        </div>
      </div>
      <div class="sec-row on">
        <span class="sec-mark">✓</span>
        <div>
          <strong>Sessions expire</strong>
          <div class="muted small">Each device stays signed in for two weeks, then has to sign in again.
            Changing the password signs everyone out immediately.</div>
        </div>
      </div>
    </div>`;

  renderTwoFactor();
};

function renderTwoFactor() {
  const enabled = state.twofa.enabled;
  $('#twofa-body').innerHTML = enabled ? `
    <p class="muted small">Two-factor is <strong>on</strong>. Signing in needs the password and a
      current code from an authenticator app.</p>
    <div class="filters inline">
      <button class="btn ghost" id="twofa-show-qr">Add another phone</button>
      <button class="btn danger ghost" id="twofa-disable">Turn off</button>
    </div>
    <div id="twofa-qr"></div>`
    : `
    <p class="muted small">Add a second step to sign-in: a six-digit code from an authenticator app
      on a phone. Codes change every 30 seconds and work without a signal.</p>
    <button class="btn" id="twofa-begin">Set up two-factor</button>
    <div id="twofa-qr"></div>`;
}

function renderEnrolment(data, { adding = false } = {}) {
  $('#twofa-qr').innerHTML = `
    <div class="enrol">
      <img class="enrol-qr" src="${data.qr}" alt="QR code for the authenticator app" width="220" height="220">
      <div class="enrol-steps">
        <h3>${adding ? 'Add this phone' : 'Set it up'}</h3>
        <ol>
          <li>Install <strong>Google Authenticator</strong>, <strong>Authy</strong>, or the password
            manager you already use.</li>
          <li>Scan this QR code with it.</li>
          <li>If scanning does not work, type this key in by hand:
            <div class="enrol-secret">${esc(data.secret)}</div></li>
          ${adding ? '' : '<li>Enter the six-digit code it shows, to confirm it worked.</li>'}
        </ol>
        ${adding ? `
          <p class="muted small">Everyone shares one authenticator entry, so this is the same code
            your other phones already show. Nothing changes for anyone signed in.</p>`
          : `
          <form class="inline-form" id="twofa-confirm-form">
            <label>Six-digit code
              <input type="text" id="twofa-code" inputmode="numeric" maxlength="6" placeholder="000000" required>
            </label>
            <button class="btn" type="submit">Confirm and turn on</button>
          </form>
          <p class="muted small">Keep this page open until you have confirmed — the code is not
            active until then.</p>`}
      </div>
    </div>`;
}

$('#view-security').addEventListener('click', async (e) => {
  if (e.target.closest('#twofa-begin')) {
    try {
      renderEnrolment(await api('/api/2fa/begin', { method: 'POST' }));
    } catch (err) { toast(err.message, true); }
  }

  if (e.target.closest('#twofa-show-qr')) {
    try {
      renderEnrolment(await api('/api/2fa/qr', { method: 'POST' }), { adding: true });
    } catch (err) { toast(err.message, true); }
  }

  if (e.target.closest('#twofa-disable')) {
    const code = prompt('Enter a current six-digit code to turn two-factor off:');
    if (!code) return;
    try {
      await api('/api/2fa/disable', { method: 'POST', body: JSON.stringify({ code }) });
      toast('Two-factor turned off.');
      loaders.security();
    } catch (err) { toast(err.message, true); }
  }
});

$('#view-security').addEventListener('submit', async (e) => {
  if (!e.target.closest('#twofa-confirm-form')) return;
  e.preventDefault();
  const code = $('#twofa-code').value;
  try {
    await api('/api/2fa/enable', { method: 'POST', body: JSON.stringify({ code }) });
    toast('Two-factor is on. Everyone needs a code from now on.');
    loaders.security();
  } catch (err) {
    toast(err.message, true);
    $('#twofa-code').select();
  }
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
  const status = $('#extraction-status');
  if (state.meta.extraction.enabled) {
    status.textContent = 'automatic invoice reading is on';
    status.title = '';
  } else {
    status.textContent = 'automatic reading off — hover for why';
    status.title = state.meta.extraction.problem || 'No API key configured.';

    // Say so on the Upload tab too, before they spend time dragging files in.
    const notice = document.createElement('div');
    notice.className = 'card notice';
    notice.innerHTML = `<strong>Automatic reading is off.</strong>
      <p class="muted small">${esc(state.meta.extraction.problem || '')}</p>
      <p class="muted small">CSV files still import normally, and you can enter invoices by hand below.
      PDFs and photos will upload but their line items will not be filled in.</p>`;
    $('#dropzone').before(notice);
  }

  const [from, to] = presetRange('mtd');
  $('#an-from').value = from;
  $('#an-to').value = to;

  $('#sale-date').value = todayISO();

  showView('dashboard');
})();
