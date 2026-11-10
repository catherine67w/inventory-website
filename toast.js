// Reading net sales straight out of Toast.
//
// Toast has no "daily totals" endpoint. The documented way to get net sales is
// to pull the orders for a business day and add up each check's amount, which
// already has discounts and service charges applied and excludes tax and tips
// — the same figure the Sales Summary export shows, and the one the food cost
// percentage is built on.
//
// Credentials are the restaurant's own read-only API credentials, made in
// Toast Web under Integrations → Toast API access. They are kept in the
// settings table rather than in this file, and never sent to the browser.

const crypto = require('crypto');

const DEFAULT_HOST = 'https://ws-api.toasttab.com';

// ordersBulk allows five requests per second per location, well below what one
// page at a time reaches, but a day of a busy restaurant is still several
// pages and there is no reason to crowd the limit.
const PAGE_SIZE = 100;
const MAX_PAGES = 200;          // 20,000 orders in a day is not a restaurant
const PAUSE_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const trimHost = (host) => String(host || DEFAULT_HOST).trim().replace(/\/+$/, '');

// Toast dates a business day yyyyMMdd, and a business day is not a calendar
// day: service that runs past midnight belongs to the day it started.
const businessDate = (isoDate) => String(isoDate || '').replace(/-/g, '');

async function request(url, options, what) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (err) {
    throw new Error(`Could not reach Toast (${what}): ${err.message}`);
  }

  const text = await response.text();
  if (!response.ok) {
    // Toast's error bodies carry a message worth passing on, but they can also
    // be HTML from something in front of the API, which is not worth showing.
    let detail = '';
    try {
      const body = JSON.parse(text);
      detail = body.message || body.error || '';
    } catch { /* not JSON */ }
    throw new Error(`Toast refused the request (${what}): ${response.status}`
      + (detail ? ` — ${detail}` : ''));
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Toast sent something unreadable (${what}).`);
  }
}

// Tokens last a day. One is kept per set of credentials and reused until it is
// close to expiring, so a month-long pull logs in once rather than per day.
const tokens = new Map();

// Keyed on the secret as well as the id: changing the secret has to mean a
// fresh login, or a corrected credential would go on using the old token.
const tokenKey = (hostname, clientId, clientSecret) =>
  `${trimHost(hostname)}::${clientId}::${crypto.createHash('sha256').update(String(clientSecret)).digest('hex')}`;

async function accessToken({ hostname, clientId, clientSecret }) {
  const key = tokenKey(hostname, clientId, clientSecret);
  const held = tokens.get(key);
  if (held && held.expires > Date.now() + 60_000) return held.token;

  const body = await request(`${trimHost(hostname)}/authentication/v1/authentication/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId,
      clientSecret,
      // Anything else here is rejected as a bad login rather than a bad field.
      userAccessType: 'TOAST_MACHINE_CLIENT',
    }),
  }, 'signing in');

  const token = body && body.token && body.token.accessToken;
  if (!token) throw new Error('Toast accepted the login but returned no token.');

  const seconds = Number((body.token || {}).expiresIn) || 86_400;
  tokens.set(key, { token, expires: Date.now() + seconds * 1000 });
  return token;
}

function forgetToken({ hostname, clientId, clientSecret }) {
  tokens.delete(tokenKey(hostname, clientId, clientSecret));
}

// Every order Toast recorded against one business day.
async function ordersForDay(credentials, isoDate) {
  const token = await accessToken(credentials);
  const headers = {
    Authorization: `Bearer ${token}`,
    'Toast-Restaurant-External-ID': credentials.restaurantGuid,
  };

  const orders = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${trimHost(credentials.hostname)}/orders/v2/ordersBulk`
      + `?businessDate=${businessDate(isoDate)}&page=${page}&pageSize=${PAGE_SIZE}`;
    const batch = await request(url, { headers }, `reading ${isoDate}`);
    if (!Array.isArray(batch) || !batch.length) break;
    orders.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    await sleep(PAUSE_MS);
  }
  return orders;
}

// Net sales for a day, by Toast's own definition: the sum of each check's
// amount, with voided and deleted orders and checks left out. Tax and tips are
// not part of check.amount, so neither is subtracted here.
function summarise(orders) {
  let netSales = 0;
  let counted = 0;
  let guests = 0;

  for (const order of orders) {
    if (!order || order.voided || order.deleted) continue;
    const checks = Array.isArray(order.checks) ? order.checks : [];
    const live = checks.filter((check) => check && !check.voided && !check.deleted);
    if (!live.length) continue;

    for (const check of live) netSales += Number(check.amount) || 0;
    counted += 1;
    guests += Number(order.numberOfGuests) || 0;
  }

  return {
    net_sales: Math.round(netSales * 100) / 100,
    orders: counted,
    guests,
  };
}

async function salesForDay(credentials, isoDate) {
  return { date: isoDate, ...summarise(await ordersForDay(credentials, isoDate)) };
}

// Each day is a separate call, so a range is walked a day at a time. A day that
// fails is reported rather than abandoning the days after it — a month-long
// pull should not be lost to one bad afternoon.
async function salesForRange(credentials, from, to, onDay = () => {}) {
  const days = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime()) || cursor > end) {
    throw new Error('Give a start date on or before the end date.');
  }

  while (cursor <= end) {
    const isoDate = cursor.toISOString().slice(0, 10);
    try {
      const day = await salesForDay(credentials, isoDate);
      days.push(day);
      onDay(day);
    } catch (err) {
      days.push({ date: isoDate, error: err.message });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    await sleep(PAUSE_MS);
  }
  return days;
}

module.exports = {
  DEFAULT_HOST, accessToken, forgetToken, ordersForDay, summarise, salesForDay, salesForRange,
};
