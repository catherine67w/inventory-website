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
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    // Some refusals carry detail the caller needs to act on, not just a message.
    Object.assign(err, data);
    throw err;
  }
  return data;
}

const money = (v) =>
  (Number(v) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

// For arithmetic on money. money() above formats for display and returns a
// string, so it must never be used mid-calculation.
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

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
        <div><strong>${u.all_time.read_automatically}</strong> invoice${u.all_time.read_automatically === 1 ? '' : 's'} read
          ${u.all_time.sales_cost ? `· <strong>${u.all_time.sales_days_read}</strong> sales day${u.all_time.sales_days_read === 1 ? '' : 's'} read` : ''}</div>
        <div class="muted small">${cost(u.all_time.invoice_cost)} invoices${u.all_time.sales_cost ? ` · ${cost(u.all_time.sales_cost)} sales reports` : ''}</div>
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
        ${(d.duplicates || []).length ? `<p class="warn-text small">
          This looks like an invoice already recorded:
          ${d.duplicates.map((x) => `<strong>${x.invoice_number ? '#' + esc(x.invoice_number) : 'no number'}</strong>
            · ${esc(x.invoice_date)} · ${money(x.total)} · ${x.item_count} line${x.item_count === 1 ? '' : 's'}`).join('; ')}.
          Saving it again would count that money twice. Discard this one unless it is genuinely a
          separate delivery.</p>` : ''}
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
          <td class="num nowrap">${r.status === 'review'
            ? `<button class="btn small ghost" data-approve="${r.id}">Approve</button>
               <button class="btn small ghost" data-merge="${r.id}"
                 title="This is another page of an invoice already here">Add to another</button>`
            : `<button class="btn small ghost" data-unapprove="${r.id}"
                 title="Put this back in review so it can be edited or merged">Un-approve</button>`}</td>
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
  // Approving is reversible: an invoice put back in review can be edited or
  // have another page merged into it, and analysis limited to approved
  // invoices stops counting it until it is approved again.
  const unapprove = e.target.closest('[data-unapprove]');
  if (unapprove) {
    e.stopPropagation();
    await api(`/api/invoices/${unapprove.dataset.unapprove}/status`, {
      method: 'POST', body: JSON.stringify({ status: 'review' }),
    });
    toast('Moved back to review.');
    loaders.invoices();
    return;
  }

  const merge = e.target.closest('[data-merge]');
  if (merge) {
    e.stopPropagation();
    openMerge(Number(merge.dataset.merge));
    return;
  }

  const row = e.target.closest('[data-invoice]');
  if (row) editInvoice(row.dataset.invoice);
});

/* ---------- merging the pages of one invoice ---------- */

// A long invoice gets photographed a page at a time, and each photo arrives as
// its own invoice. This folds one into another: the line items combine, the
// photo is kept as an extra page, and the money is only ever combined when
// explicitly asked for — both pages usually print the same grand total, and
// adding those together would double the invoice.

state.merge = { sourceId: null, data: null, targetId: null, mode: 'keep', filter: '' };

async function openMerge(sourceId) {
  const data = await api(`/api/invoices/${sourceId}/merge-candidates`);
  state.merge = { sourceId, data, targetId: null, mode: 'keep', filter: '' };
  renderMerge();
  $('#merge').classList.remove('hidden');
}

function renderMerge() {
  const { data, targetId, mode, filter } = state.merge;
  const source = data.source;

  const term = filter.trim().toLowerCase();
  const candidates = data.candidates.filter((c) => !term
    || c.vendor_name.toLowerCase().includes(term)
    || String(c.invoice_number || '').toLowerCase().includes(term)
    || c.invoice_date.includes(term));

  const target = data.candidates.find((c) => c.id === targetId);

  $('#merge-body').innerHTML = `
    <div class="merge-source">
      <div class="muted small">Moving these lines out of</div>
      <strong>${esc(source.invoice_number ? '#' + source.invoice_number : 'the untitled invoice')}
        · ${esc(source.invoice_date)}</strong>
      <div class="muted small">${source.item_count} line${source.item_count === 1 ? '' : 's'}
        worth ${money(source.items_sum)} · invoice total ${money(source.total)}</div>
    </div>

    <label class="grow block">Find the invoice these pages belong to
      <input type="search" id="merge-filter" value="${esc(filter)}" placeholder="vendor, invoice #, or date">
    </label>

    <div class="table-scroll merge-list"><table>
      <thead><tr><th></th><th>Date</th><th>Vendor</th><th>Invoice #</th>
        <th class="num">Lines</th><th class="num">Total</th></tr></thead>
      <tbody>${candidates.length ? candidates.map((c) => `
        <tr class="clickable ${c.id === targetId ? 'selected' : ''}" data-merge-target="${c.id}">
          <td><input type="radio" name="merge-target" ${c.id === targetId ? 'checked' : ''}></td>
          <td>${esc(c.invoice_date)}</td>
          <td>${esc(c.vendor_name)}${c.same_vendor ? '' : '<div class="muted small">different vendor</div>'}</td>
          <td>${esc(c.invoice_number || '—')}</td>
          <td class="num">${c.item_count}</td>
          <td class="num">${money(c.total)}</td>
        </tr>`).join('')
        : '<tr><td colspan="6" class="muted">No invoices match.</td></tr>'}
      </tbody>
    </table></div>

    ${target ? mergePreview(source, target, mode) : '<p class="muted small">Choose the invoice above.</p>'}

    <div class="modal-actions">
      <button class="btn" id="merge-go" ${target ? '' : 'disabled'}>Add the pages</button>
      <button class="btn ghost" id="merge-cancel">Cancel</button>
    </div>`;
}

// Spells out what the money will be afterwards, because this is the one action
// in the app that can silently double an invoice.
function mergePreview(source, target, mode) {
  // Everything here stays a number until the moment it is printed: money()
  // returns a formatted string, and doing arithmetic on one silently yields
  // zeroes and NaN rather than failing.
  const combinedLines = round2(source.items_sum + target.items_sum);
  const totals = { keep: target.total, source: source.total, sum: round2(target.total + source.total) };
  const chosen = totals[mode];
  const gap = round2(chosen - combinedLines);

  const option = (key, label, hint) => `
    <label class="merge-option ${mode === key ? 'on' : ''}">
      <input type="radio" name="merge-mode" value="${key}" ${mode === key ? 'checked' : ''}>
      <span><strong>${label} — ${money(totals[key])}</strong><br><span class="muted small">${hint}</span></span>
    </label>`;

  return `
    <div class="merge-preview">
      <div class="muted small">After merging, this invoice has</div>
      <strong>${source.item_count + target.item_count} lines worth ${money(combinedLines)}</strong>

      <div class="merge-options">
        ${option('keep', 'Keep the total already on it', 'The usual choice: every page of an invoice prints the same grand total.')}
        ${option('source', 'Use the total from the pages being added', 'When the page being added is the one showing the real grand total.')}
        ${option('sum', 'Add the two totals together', 'Only when each page totals its own items and neither shows a grand total. This doubles the money if that is not true.')}
      </div>

      <div class="sales-recon ${Math.abs(gap) <= 0.02 ? 'ok' : 'off'}">
        ${Math.abs(gap) <= 0.02
          ? `<span>Lines add up to <strong>${money(combinedLines)}</strong>, matching the invoice total. ✓</span>`
          : `<span>Lines add up to <strong>${money(combinedLines)}</strong> against a total of
             <strong>${money(chosen)}</strong> — ${gap > 0 ? `<strong>${money(gap)}</strong> still unaccounted for,
             so there may be another page` : `<strong>${money(-gap)}</strong> more than the total, which usually means
             a page was added twice`}.</span>`}
      </div>
    </div>`;
}

$('#merge-body').addEventListener('input', (e) => {
  if (e.target.id === 'merge-filter') {
    state.merge.filter = e.target.value;
    const cursor = e.target.selectionStart;
    renderMerge();
    const box = $('#merge-filter');
    box.focus();
    box.setSelectionRange(cursor, cursor);
  }
});

$('#merge-body').addEventListener('change', (e) => {
  if (e.target.name === 'merge-mode') {
    state.merge.mode = e.target.value;
    renderMerge();
  }
});

$('#merge-body').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-merge-target]');
  if (row) {
    state.merge.targetId = Number(row.dataset.mergeTarget);
    renderMerge();
    return;
  }

  if (e.target.closest('#merge-cancel')) { closeMerge(); return; }

  if (e.target.closest('#merge-go')) {
    const { sourceId, targetId, mode } = state.merge;
    if (!targetId) return;
    try {
      const out = await api(`/api/invoices/${sourceId}/merge`, {
        method: 'POST',
        body: JSON.stringify({ target_id: targetId, total_mode: mode }),
      });
      closeMerge();
      toast(`Pages added — that invoice now has ${out.invoice.item_count} lines.`);
      loaders.invoices();
    } catch (err) {
      toast(err.message, true);
    }
  }
});

function closeMerge() { $('#merge').classList.add('hidden'); }
$('#merge-close').addEventListener('click', closeMerge);

/* ---------- item prices ---------- */

state.itemSort = { sort: 'total_spend', dir: 'desc' };
state.itemSearchTicket = 0;

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
  const searchTerm = $('#item-q').value.trim();
  if (searchTerm) params.set('q', searchTerm);

  // Searches are fired as you type, so replies can arrive out of order. Only
  // the newest one is allowed to paint, or a slow earlier reply lands last and
  // shows results for a word you have already finished deleting.
  const ticket = ++state.itemSearchTicket;
  const rows = await api('/api/items?' + params);
  if (ticket !== state.itemSearchTicket) return;

  const dirLabel = state.itemSort.sort === 'total_spend'
    ? (state.itemSort.dir === 'asc' ? 'cheapest first' : 'most expensive first')
    : '';

  $('#items-table').innerHTML = rows.length ? `
    <div class="sort-bar">
      <span class="muted small">${searchTerm
        ? `<strong>${rows.length}</strong> match${rows.length === 1 ? '' : 'es'} for “${esc(searchTerm)}” · sorted by `
        : 'Sorted by '}
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
    // "Nothing bought yet" and "nothing matched your search" are different
    // facts, and telling someone the first when the second is true is a lie.
    : emptyRow(searchTerm || $('#item-from').value || $('#item-to').value
      ? `Nothing matches${searchTerm ? ` “${esc(searchTerm)}”` : ''}${
        $('#item-from').value || $('#item-to').value ? ' in that date range' : ''}.`
      : 'No purchased items yet.');
};

$('#item-apply').addEventListener('click', loaders.items);

// Filters as you type, one request after the typing stops rather than one per
// keystroke. The Apply button still works for anyone who reaches for it.
let itemSearchTimer;
$('#item-q').addEventListener('input', () => {
  clearTimeout(itemSearchTimer);
  itemSearchTimer = setTimeout(loaders.items, 250);
});

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

/* ---------- product trends ---------- */

state.trend = { description: '', metric: 'unit_price', vendorId: '', from: '', to: '', data: null };

const TREND_METRICS = {
  unit_price: {
    label: 'Price per unit',
    axis: 'Unit price',
    format: (v) => money(v),
    // A price chart forced to a zero baseline flattens the movement that
    // matters, so this one is padded around the range instead.
    zeroBased: false,
  },
  quantity: { label: 'Quantity bought', axis: 'Quantity', format: (v) => trimNumber(v), zeroBased: true },
  extended_price: { label: 'Spend', axis: 'Spend', format: (v) => money(v), zeroBased: true },
};

const TREND_COLORS = ['#1f6f5c', '#b4531f', '#3a5f8a', '#7a4b8f', '#8a6d1f'];

const trimNumber = (v) => {
  const rounded = Math.round(v * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
};

loaders.trends = async function loadTrends() {
  await loadTrendPicker();
  if (state.trend.description) renderTrend();
};

async function loadTrendPicker() {
  const q = $('#trend-q').value.trim();
  const rows = await api('/api/trends/products' + (q ? '?q=' + encodeURIComponent(q) : ''));

  if (!rows.length) {
    $('#trend-picker').innerHTML = emptyRow(q
      ? `Nothing bought matches “${esc(q)}”.`
      : 'No purchased products yet. Upload some invoices first.');
    return;
  }

  $('#trend-picker').innerHTML = `
    <div class="table-scroll"><table>
      <thead><tr>
        <th>Product</th><th class="num">Times bought</th><th>Bought between</th>
        <th class="num">Total spend</th><th></th>
      </tr></thead>
      <tbody>${rows.map((r) => `
        <tr class="clickable ${r.description === state.trend.description ? 'selected' : ''}"
            data-trend-pick="${esc(r.description)}">
          <td>${esc(r.description)}${r.vendor_count > 1
            ? `<div class="muted small">${r.vendor_count} vendors</div>` : ''}</td>
          <td class="num">${r.purchase_count}${r.purchase_count < 2
            ? '<div class="muted small">no trend yet</div>' : ''}</td>
          <td>${esc(r.first_date)} → ${esc(r.last_date)}</td>
          <td class="num">${money(r.total_spend)}</td>
          <td class="num"><button class="btn small">Chart it</button></td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
}

$('#trend-search').addEventListener('click', loadTrendPicker);
$('#trend-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadTrendPicker(); });

$('#trend-picker').addEventListener('click', (e) => {
  const row = e.target.closest('[data-trend-pick]');
  if (!row) return;
  // A new product starts from its own full history, not the last one's dates.
  state.trend = { ...state.trend, description: row.dataset.trendPick, vendorId: '', from: '', to: '' };
  renderTrend();
});

async function renderTrend() {
  const params = new URLSearchParams({ description: state.trend.description });
  if (state.trend.vendorId) params.set('vendor_id', state.trend.vendorId);
  if (state.trend.from) params.set('from', state.trend.from);
  if (state.trend.to) params.set('to', state.trend.to);

  const data = await api('/api/trends/product?' + params);
  state.trend.data = data;
  loadTrendPicker();

  const { points, summary, vendors, units } = data;
  const metric = TREND_METRICS[state.trend.metric];

  if (!points.length) {
    $('#trend-result').innerHTML = `<div class="card">
      <h2>${esc(data.description)}</h2>
      ${emptyRow('No purchases of this product in that date range.')}
      <button class="btn small ghost" data-trend-reset="1">Show every purchase</button>
    </div>`;
    return;
  }

  const change = summary.change_pct;
  const cards = [
    { label: 'Times bought', value: String(summary.purchases), sub: `${summary.first_date} → ${summary.last_date}` },
    { label: 'Latest price', value: summary.last_price === null ? '—' : money(summary.last_price), sub: 'per unit' },
    {
      label: 'Since first purchase',
      value: change === null ? '—' : `${change > 0 ? '+' : ''}${change.toFixed(1)}%`,
      sub: summary.first_price === null ? '' : `from ${money(summary.first_price)}`,
      cls: change === null ? '' : change > 0.5 ? 'warn' : change < -0.5 ? 'good' : '',
    },
    { label: 'Low / high', value: `${money(summary.min_price)} / ${money(summary.max_price)}`, sub: 'per unit' },
    { label: 'Total spend', value: money0(summary.total_spend), sub: `${trimNumber(summary.total_quantity)} ${esc(units[0] || 'units')} in total` },
  ];

  $('#trend-result').innerHTML = `
    <div class="card">
      <div class="trend-head">
        <h2>${esc(data.description)}</h2>
        <div class="trend-controls">
          ${Object.entries(TREND_METRICS).map(([key, m]) => `
            <button class="btn small ${key === state.trend.metric ? '' : 'ghost'}"
                    data-trend-metric="${key}">${m.label}</button>`).join('')}
        </div>
      </div>

      <div class="stat-row">${cards.map((c) => `
        <div class="stat">
          <div class="stat-label">${c.label}</div>
          <div class="stat-value ${c.cls || ''}">${c.value}</div>
          <div class="stat-sub">${c.sub}</div>
        </div>`).join('')}
      </div>

      ${units.length > 1 ? `<p class="warn-text small">This product was invoiced in more than one
        unit (${esc(units.join(', '))}). A price per ${esc(units[0])} and a price per
        ${esc(units[1])} are not the same measure, so read the price line with that in mind —
        it usually means a line item was read with the wrong unit.</p>` : ''}

      ${vendors.length > 1 ? `<p class="muted small">Bought from ${vendors.length} vendors —
        one line each, since their prices are separate trends rather than one.</p>` : ''}

      <div class="chart-wrap" id="trend-chart">${lineChart(points, state.trend.metric, vendors)}</div>

      <div class="filters inline trend-filters">
        <label>From <input type="date" id="trend-from" value="${esc(state.trend.from)}"></label>
        <label>To <input type="date" id="trend-to" value="${esc(state.trend.to)}"></label>
        <label>Vendor
          <select id="trend-vendor">
            <option value="">All vendors</option>
            ${(state.trend.vendorId ? state.trend.data.vendors : vendors).map((v) => `
              <option value="${v.id}" ${String(v.id) === String(state.trend.vendorId) ? 'selected' : ''}>
                ${esc(v.name)}</option>`).join('')}
          </select>
        </label>
        <button class="btn ghost" data-trend-apply="1">Apply</button>
        ${state.trend.from || state.trend.to || state.trend.vendorId
          ? '<button class="btn ghost" data-trend-reset="1">Every purchase</button>' : ''}
      </div>
    </div>

    <div class="card">
      <h2>The purchases behind the line</h2>
      <div class="table-scroll"><table>
        <thead><tr><th>Date</th><th>Vendor</th><th>Invoice #</th><th class="num">Qty</th>
          <th class="num">Unit price</th><th class="num">Spend</th></tr></thead>
        <tbody>${points.slice().reverse().map((p) => `
          <tr class="clickable" data-trend-invoice="${p.invoice_id}">
            <td>${esc(p.date)}</td><td>${esc(p.vendor_name)}</td>
            <td>${esc(p.invoice_number || '—')}</td>
            <td class="num">${trimNumber(p.quantity)} ${esc(p.unit || '')}</td>
            <td class="num">${money(p.unit_price)}</td>
            <td class="num">${money(p.extended_price)}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>
    </div>`;

  attachChartTooltip(metric);
}

// Groups one vendor's purchases by date. Two invoice lines on the same day are
// one point: quantity and spend add up, and the price is weighted by quantity
// so a 40-case delivery is not averaged flat against a single case.
function seriesFor(points, metric) {
  const byDate = new Map();
  for (const p of points) {
    const at = byDate.get(p.date) || { date: p.date, quantity: 0, extended_price: 0, weighted: 0, lines: [] };
    at.quantity += p.quantity;
    at.extended_price += p.extended_price;
    at.weighted += p.unit_price * (p.quantity || 1);
    at.lines.push(p);
    byDate.set(p.date, at);
  }

  return [...byDate.values()].map((at) => {
    const weight = at.lines.reduce((s, l) => s + (l.quantity || 1), 0);
    const value = metric === 'unit_price'
      ? (weight ? at.weighted / weight : 0)
      : at[metric];
    return { date: at.date, value, lines: at.lines };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

function lineChart(points, metricKey, vendors) {
  const metric = TREND_METRICS[metricKey];
  const W = 900;
  const H = 320;
  const PAD = { top: 18, right: 18, bottom: 42, left: 68 };

  const groups = vendors.length > 1
    ? vendors.map((v) => ({ name: v.name, points: points.filter((p) => p.vendor_id === v.id) }))
    : [{ name: vendors[0] ? vendors[0].name : '', points }];

  const series = groups
    .map((g, i) => ({ name: g.name, color: TREND_COLORS[i % TREND_COLORS.length], values: seriesFor(g.points, metricKey) }))
    .filter((s) => s.values.length);

  const all = series.flatMap((s) => s.values);
  const times = all.map((v) => Date.parse(v.date + 'T00:00:00Z'));
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const span = maxTime - minTime;

  const values = all.map((v) => v.value);
  let low = metric.zeroBased ? 0 : Math.min(...values);
  let high = Math.max(...values);
  if (high === low) { high = low + Math.max(1, Math.abs(low) * 0.1); }   // one flat line still needs a scale
  if (!metric.zeroBased) low = Math.max(0, low - (high - low) * 0.15);
  high += (high - low) * 0.12;

  const x = (date) => (span
    ? PAD.left + ((Date.parse(date + 'T00:00:00Z') - minTime) / span) * (W - PAD.left - PAD.right)
    : (PAD.left + W - PAD.right) / 2);
  const y = (value) => H - PAD.bottom - ((value - low) / (high - low)) * (H - PAD.top - PAD.bottom);

  const ticks = 4;
  const gridlines = Array.from({ length: ticks + 1 }, (_, i) => {
    const value = low + ((high - low) * i) / ticks;
    return `<line class="grid" x1="${PAD.left}" y1="${y(value).toFixed(1)}" x2="${W - PAD.right}" y2="${y(value).toFixed(1)}"/>
      <text class="axis" x="${PAD.left - 10}" y="${(y(value) + 4).toFixed(1)}" text-anchor="end">${metric.format(value)}</text>`;
  }).join('');

  // Enough date labels to read the span without them colliding.
  const dates = [...new Set(all.map((v) => v.date))].sort();
  const step = Math.ceil(dates.length / 6);
  const dateLabels = dates.filter((_, i) => i % step === 0 || i === dates.length - 1).map((d) =>
    `<text class="axis" x="${x(d).toFixed(1)}" y="${H - PAD.bottom + 20}" text-anchor="middle">${d.slice(5)}</text>`).join('');

  const lines = series.map((s) => {
    const path = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(v.date).toFixed(1)},${y(v.value).toFixed(1)}`).join(' ');
    const dots = s.values.map((v) => `<circle class="dot" cx="${x(v.date).toFixed(1)}" cy="${y(v.value).toFixed(1)}" r="4.5"
      fill="${s.color}" data-date="${v.date}" data-value="${v.value}" data-vendor="${esc(s.name)}"
      data-lines="${v.lines.length}" data-invoice="${v.lines[0].invoice_id}"/>`).join('');
    return `<path class="trend-line" d="${path}" stroke="${s.color}"/>${dots}`;
  }).join('');

  const single = all.length === 1;

  return `
    <svg viewBox="0 0 ${W} ${H}" class="line-chart" role="img"
         aria-label="${esc(metric.label)} for ${esc(state.trend.description)}">
      ${gridlines}
      <line class="axis-line" x1="${PAD.left}" y1="${H - PAD.bottom}" x2="${W - PAD.right}" y2="${H - PAD.bottom}"/>
      ${lines}
      ${dateLabels}
      <text class="axis-title" x="${PAD.left}" y="${PAD.top - 4}">${metric.axis}${
        metric.zeroBased ? '' : ' — scale does not start at zero'}</text>
    </svg>
    ${series.length > 1 ? `<div class="legend chart-legend">${series.map((s) =>
      `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : ''}
    ${single ? '<p class="muted small">One purchase so far — a line needs at least two.</p>' : ''}
    <div class="chart-tip hidden" id="trend-tip"></div>`;
}

// Hovering a point says what it was; clicking opens the invoice it came from.
function attachChartTooltip(metric) {
  const wrap = $('#trend-chart');
  const tip = $('#trend-tip');
  if (!wrap || !tip) return;

  wrap.addEventListener('mouseover', (e) => {
    const dot = e.target.closest('.dot');
    if (!dot) return;
    const lines = Number(dot.dataset.lines);
    tip.innerHTML = `<strong>${metric.format(Number(dot.dataset.value))}</strong>
      <div>${esc(dot.dataset.date)}</div>
      ${dot.dataset.vendor ? `<div class="muted">${esc(dot.dataset.vendor)}</div>` : ''}
      ${lines > 1 ? `<div class="muted">${lines} invoice lines that day</div>` : ''}`;
    const box = wrap.getBoundingClientRect();
    const dotBox = dot.getBoundingClientRect();
    tip.style.left = `${dotBox.left - box.left + dotBox.width / 2}px`;
    tip.style.top = `${dotBox.top - box.top}px`;
    tip.classList.remove('hidden');
  });

  wrap.addEventListener('mouseout', (e) => {
    if (e.target.closest('.dot')) tip.classList.add('hidden');
  });

  wrap.addEventListener('click', (e) => {
    const dot = e.target.closest('.dot');
    if (dot) editInvoice(dot.dataset.invoice);
  });
}

$('#trend-result').addEventListener('click', (e) => {
  const metricBtn = e.target.closest('[data-trend-metric]');
  if (metricBtn) {
    state.trend.metric = metricBtn.dataset.trendMetric;
    renderTrend();
    return;
  }

  if (e.target.closest('[data-trend-apply]')) {
    state.trend.from = $('#trend-from').value;
    state.trend.to = $('#trend-to').value;
    state.trend.vendorId = $('#trend-vendor').value;
    renderTrend();
    return;
  }

  if (e.target.closest('[data-trend-reset]')) {
    state.trend = { ...state.trend, from: '', to: '', vendorId: '' };
    renderTrend();
    return;
  }

  const row = e.target.closest('[data-trend-invoice]');
  if (row) editInvoice(row.dataset.trendInvoice);
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
      <tbody>${rows.map((r) => {
        // A row can stand for a whole period when the summary had no daily
        // breakdown; saying so stops it being read as one day's takings.
        const spans = r.period_start && r.period_start !== r.sale_date;
        return `
        <tr>
          <td>${esc(r.sale_date)}${spans ? `<div class="muted small">covers ${esc(r.period_start)} →</div>` : ''}</td>
          <td class="num">${money(r.net_sales)}</td>
          <td>${esc(r.note || '')}</td>
          <td class="num"><button class="btn small ghost" data-sale-delete="${r.sale_date}">Remove</button></td>
        </tr>`; }).join('')}
      </tbody>
      <tfoot><tr><td><strong>${rows.length} ${rows.some((r) => r.period_start && r.period_start !== r.sale_date) ? 'entr' + (rows.length === 1 ? 'y' : 'ies') : 'day' + (rows.length === 1 ? '' : 's')}</strong></td>
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


/* ---------- uploading sales reports ---------- */

state.salesDrafts = [];

const salesDrop = $('#sales-dropzone');
const salesInput = $('#sales-file-input');

$('#sales-browse-btn').addEventListener('click', () => salesInput.click());
salesInput.addEventListener('change', () => {
  if (salesInput.files.length) uploadSalesReports(salesInput.files);
});

['dragenter', 'dragover'].forEach((ev) =>
  salesDrop.addEventListener(ev, (e) => { e.preventDefault(); salesDrop.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) =>
  salesDrop.addEventListener(ev, (e) => { e.preventDefault(); salesDrop.classList.remove('drag'); }));
salesDrop.addEventListener('drop', (e) => {
  if (e.dataTransfer.files.length) uploadSalesReports(e.dataTransfer.files);
});

async function uploadSalesReports(fileList) {
  const form = new FormData();
  Array.from(fileList).slice(0, 20).forEach((f) => form.append('files', f));

  $('#sales-progress').classList.remove('hidden');
  $('#sales-progress-note').textContent =
    `Reading ${fileList.length} report${fileList.length === 1 ? '' : 's'}…`;

  try {
    const data = await api('/api/sales/upload', { method: 'POST', body: form });
    state.salesDrafts = data.results.concat(state.salesDrafts);
    renderSalesDrafts();
    const days = data.results.reduce((n, r) => n + r.entries.length, 0);
    toast(`Found ${days} day${days === 1 ? '' : 's'}. Check the figures, then save.`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('#sales-progress').classList.add('hidden');
    salesInput.value = '';
  }
}

function renderSalesDrafts() {
  $('#sales-drafts').innerHTML = state.salesDrafts.map((d, di) => {
    if (d.error) {
      return `<div class="draft failed">
        <div class="draft-head">
          <strong>${esc(d.original_name)}</strong>
          <div class="draft-actions">
            <button class="btn small ghost" data-sd-discard="${di}">Discard</button>
          </div>
        </div>
        <div class="draft-error">${esc(d.error)}</div>
      </div>`;
    }

    const period = d.period || { label: '', start_date: '', end_date: '', net_sales: 0 };
    const missing = d.missing_dates || [];
    const span = period.start_date && period.end_date
      ? `${period.start_date} → ${period.end_date}` : '';

    // A month summary with a total but no day-by-day breakdown. Splitting it
    // across days would be inventing figures, so it is offered as one entry.
    const totalOnly = !d.entries.length && period.net_sales > 0;

    return `<div class="draft">
      <div class="draft-head">
        <strong>${esc(d.original_name)}</strong>
        <span class="draft-meta">${d.entries.length} day${d.entries.length === 1 ? '' : 's'}${span ? ` · ${esc(span)}` : ''}</span>
        ${d.usage && d.usage.cost
          ? `<span class="draft-cost">read for ${cost(d.usage.cost)}</span>`
          : '<span class="draft-cost">read from the file — no charge</span>'}
        <div class="draft-actions">
          ${d.entries.length ? `<button class="btn small" data-sd-save="${di}">Save these days</button>` : ''}
          ${totalOnly ? `<button class="btn small" data-sd-save-period="${di}">Save as one entry</button>` : ''}
          <button class="btn small ghost" data-sd-discard="${di}">Discard</button>
        </div>
      </div>
      ${d.reading_note ? `<p class="draft-error">${esc(d.reading_note)}</p>` : ''}

      ${totalOnly ? `
        <div class="sales-recon">
          <span><strong>${money(period.net_sales)}</strong> net sales${span ? ` for ${esc(span)}` : ''}${
            d.gross_sales ? ` · gross ${money(d.gross_sales)}` : ''}${d.tax ? ` · tax ${money(d.tax)}` : ''}</span>
        </div>
        <p class="warn-text small">This report gives only the period total — there is no day-by-day
        breakdown in it, and splitting it across days would be inventing figures. It can be stored as
        a single entry dated ${esc(period.end_date || 'the last day')}, which any date range covering
        that day will count in full. A range that stops short of it will not include any of it.
        For day-level analysis, export the day-by-day sales report instead.</p>` : ''}

      ${missing.length ? `<p class="warn-text small">${missing.length}
        day${missing.length === 1 ? '' : 's'} inside ${esc(span || 'this range')} came back with no
        row: ${esc(missing.slice(0, 8).join(', '))}${missing.length > 8 ? `, and ${missing.length - 8} more` : ''}.
        If the restaurant was open those days, add them by hand after saving.</p>` : ''}

      ${d.entries.length ? `
        <div class="sales-recon" data-sd-recon="${di}"></div>
        <div class="table-scroll"><table class="sales-draft-table">
          <thead><tr>
            <th>Date</th><th class="num">Net sales</th><th class="num">Gross</th>
            <th class="num">Tax</th><th>Note</th><th></th>
          </tr></thead>
          <tbody>${d.entries.map((e, ei) => `
            <tr data-sd-row="${di}-${ei}">
              <td><input type="date" data-f="date" value="${esc(e.date)}"></td>
              <td class="num"><input type="number" step="0.01" data-f="net_sales" value="${e.net_sales}"></td>
              <td class="num muted small">${e.gross_sales ? money(e.gross_sales) : '—'}</td>
              <td class="num muted small">${e.tax ? money(e.tax) : '—'}</td>
              <td>
                ${e.existing_net_sales !== null
                  ? `<span class="warn-text small">already recorded as ${money(e.existing_net_sales)} — saving replaces it</span>`
                  : `<input type="text" data-f="note" value="${esc(e.note)}" placeholder="optional">`}
              </td>
              <td><button class="link small" data-sd-row-remove="${di}-${ei}" title="Not a day — remove this row">✕</button></td>
            </tr>`).join('')}
          </tbody>
        </table></div>`
        : (totalOnly ? '' : '<p class="muted small">No days were found on this report.</p>')}
    </div>`;
  }).join('');

  state.salesDrafts.forEach((d, di) => { if (!d.error) updateSalesRecon(di); });
}

// Checks the days read against the report's own printed total. On a month of
// 31 rows this is what catches a misread figure or a row that never came back.
function updateSalesRecon(di) {
  const box = $(`[data-sd-recon="${di}"]`);
  if (!box) return;

  const draft = state.salesDrafts[di];
  const period = draft.period || { net_sales: 0, label: '' };
  const rows = $$(`[data-sd-row^="${di}-"]`);
  const sum = rows.reduce((s, tr) => s + (Number(tr.querySelector('[data-f="net_sales"]').value) || 0), 0);

  const counted = `<strong>${rows.length} day${rows.length === 1 ? '' : 's'}</strong> totalling <strong>${money(sum)}</strong>`;

  if (!period.net_sales) {
    box.className = 'sales-recon';
    box.innerHTML = `<span>${counted}. No printed total on the report to check against.</span>`;
    return;
  }

  // Rounding on a month of figures lands within a cent or two either way.
  const diff = Math.round((sum - period.net_sales) * 100) / 100;
  const label = esc(period.label || 'report total');
  if (Math.abs(diff) <= 0.02) {
    box.className = 'sales-recon ok';
    box.innerHTML = `<span>${counted} — matches the ${label} of ${money(period.net_sales)}. ✓</span>`;
  } else {
    box.className = 'sales-recon off';
    box.innerHTML = `<span>${counted}, but the ${label} says ${money(period.net_sales)} —
      ${diff > 0 ? 'over by' : 'short by'} <strong>${money(Math.abs(diff))}</strong>.
      Check the figures against the report before saving.</span>`;
  }
}

// Editing a figure re-checks it against the report's total straight away.
$('#sales-drafts').addEventListener('input', (e) => {
  const tr = e.target.closest('[data-sd-row]');
  if (tr) updateSalesRecon(Number(tr.dataset.sdRow.split('-')[0]));
});

$('#sales-drafts').addEventListener('click', async (e) => {
  const discard = e.target.closest('[data-sd-discard]');
  if (discard) {
    state.salesDrafts.splice(Number(discard.dataset.sdDiscard), 1);
    renderSalesDrafts();
    return;
  }

  const removeRow = e.target.closest('[data-sd-row-remove]');
  if (removeRow) {
    const [di, ei] = removeRow.dataset.sdRowRemove.split('-').map(Number);
    state.salesDrafts[di].entries.splice(ei, 1);
    renderSalesDrafts();
    return;
  }

  const periodBtn = e.target.closest('[data-sd-save-period]');
  if (periodBtn) {
    const draft = state.salesDrafts[Number(periodBtn.dataset.sdSavePeriod)];
    const p = draft.period;
    const date = p.end_date || p.start_date;
    if (!date) return toast('The report does not print a date for its total, so it cannot be stored.', true);
    if (!confirm(`Store ${money(p.net_sales)} as a single entry on ${date}?\n\nOnly a date range that includes ${date} will count it.`)) return;
    const entry = {
      sale_date: date,
      period_start: p.start_date || date,
      net_sales: p.net_sales,
      note: `${p.label === 'Net sales' ? 'Period' : (p.label || 'Period')} total${p.start_date ? ` for ${p.start_date} to ${p.end_date}` : ''} — no daily breakdown on the report`,
    };
    if (await saveSalesEntries([entry], draft)) {
      state.salesDrafts.splice(Number(periodBtn.dataset.sdSavePeriod), 1);
      renderSalesDrafts();
      loaders.sales();
    }
    return;
  }

  const saveBtn = e.target.closest('[data-sd-save]');
  if (!saveBtn) return;

  const di = Number(saveBtn.dataset.sdSave);
  const draft = state.salesDrafts[di];
  const rows = $$(`[data-sd-row^="${di}-"]`).map((tr) => {
    const val = (f) => tr.querySelector(`[data-f="${f}"]`)?.value ?? '';
    return { sale_date: val('date'), net_sales: Number(val('net_sales')) || 0, note: val('note') };
  }).filter((r) => r.sale_date);

  if (!rows.length) return toast('Every row needs a date before it can be saved.', true);

  // Two rows on one date would silently overwrite each other on the way in.
  const dates = rows.map((r) => r.sale_date);
  const dupe = dates.find((d, i) => dates.indexOf(d) !== i);
  if (dupe) return toast(`${dupe} appears on two rows. Fix or remove one before saving.`, true);

  // A day the restaurant was closed is legitimately zero; an unread figure is not.
  const zero = rows.filter((r) => r.net_sales <= 0 && !/clos/i.test(r.note)).length;
  if (zero && !confirm(`${zero} day${zero === 1 ? ' has' : 's have'} no net sales figure. Save anyway?`)) return;

  const periodTotal = draft.period ? draft.period.net_sales : 0;
  const sum = rows.reduce((s, r) => s + r.net_sales, 0);
  const diff = Math.round((sum - periodTotal) * 100) / 100;
  if (periodTotal && Math.abs(diff) > 0.02 && !confirm(
    `These days add up to ${money(sum)}, but the report's own total is ${money(periodTotal)} — a difference of ${money(Math.abs(diff))}.\n\nSave anyway?`
  )) return;

  if (await saveSalesEntries(rows, draft)) {
    state.salesDrafts.splice(di, 1);
    renderSalesDrafts();
    loaders.sales();
  }
});

// Saves reviewed rows, stopping to ask when what is already stored overlaps
// them — a month total and that month's daily figures would otherwise both be
// counted. Returns true when the rows were saved.
async function saveSalesEntries(entries, draft) {
  const body = {
    entries,
    cost: draft && draft.usage ? draft.usage.cost : 0,
    source_file: draft ? draft.file : '',
  };

  try {
    const out = await api('/api/sales/batch', { method: 'POST', body: JSON.stringify(body) });
    toast(`Saved ${out.saved} day${out.saved === 1 ? '' : 's'}.`);
    return true;
  } catch (err) {
    if (!err.conflicts) { toast(err.message, true); return false; }

    const list = err.conflicts.map((c) => (c.spans
      ? `• ${c.period_start} to ${c.sale_date} — ${money(c.net_sales)} (covers a whole period)`
      : `• ${c.sale_date} — ${money(c.net_sales)}`)).join('\n');
    if (!confirm(`What you are saving overlaps figures already stored:\n\n${list}\n\nKeeping both would count that money twice. Replace them with what you are saving now?`)) {
      return false;
    }

    try {
      const out = await api('/api/sales/batch', {
        method: 'POST',
        body: JSON.stringify({ ...body, replace_overlapping: true }),
      });
      toast(`Saved ${out.saved} day${out.saved === 1 ? '' : 's'}, replacing ${out.removed}.`);
      return true;
    } catch (retryErr) {
      toast(retryErr.message, true);
      return false;
    }
  }
}

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
    sourceLink.textContent = (base.pages && base.pages.length) ? 'Page 1' : 'View original';
    sourceLink.classList.remove('hidden');
  } else {
    sourceLink.classList.add('hidden');
  }

  // Pages merged in later each get their own link, so every line item can be
  // checked against the photograph it came from.
  $('#editor-pages').innerHTML = (base.pages || []).map((p, i) =>
    `<a class="link" target="_blank" rel="noopener" href="/files/${esc(p.file)}">Page ${i + 2}</a>`).join('');
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
      try {
        await api('/api/invoices', { method: 'POST', body: JSON.stringify(payload) });
      } catch (err) {
        if (!err.duplicates) throw err;
        // Refused because this invoice is already on the books. Naming the
        // existing one lets the person decide, rather than guessing for them.
        const list = err.duplicates.map((x) =>
          `• ${x.invoice_number ? '#' + x.invoice_number : 'no number'} · ${x.invoice_date} · ${money(x.total)} · ${x.item_count} line${x.item_count === 1 ? '' : 's'} · ${x.status}`).join('\n');
        if (!confirm(`${err.vendor_name || 'This vendor'} already has an invoice that matches this one:\n\n${list}\n\nSaving this would count that money twice.\n\nSave anyway, as a genuinely separate invoice?`)) {
          return;
        }
        await api('/api/invoices', {
          method: 'POST',
          body: JSON.stringify({ ...payload, allow_duplicate: true }),
        });
      }
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
