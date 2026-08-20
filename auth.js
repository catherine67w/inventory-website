// Two-factor codes (TOTP, RFC 6238) and brute-force lockout.
//
// One shared authenticator entry backs the whole team, matching the shared
// password. Everyone scans the same QR code; the six-digit code changes every
// 30 seconds and is generated on their phone, offline.

const crypto = require('crypto');
const { db } = require('./db');

const STEP_SECONDS = 30;
const DIGITS = 6;
const DRIFT_STEPS = 1; // accept one step either side, for clock drift

/* ---------- settings ---------- */

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = @value
  `).run({ key, value: String(value) });
}

function deleteSetting(key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

/* ---------- base32, as authenticator apps expect ---------- */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of String(text).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* ---------- TOTP ---------- */

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function codeForStep(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigInt64BE(BigInt(step));
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

function currentStep(now = Date.now()) {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

// Returns the matching step number, or null. Comparison is constant-time, and a
// step that has already been used is refused so a code cannot be replayed.
function verifyCode(secret, input, { allowReplay = false } = {}) {
  const cleaned = String(input || '').replace(/\D/g, '');
  if (cleaned.length !== DIGITS) return null;

  const lastUsed = Number(getSetting('totp_last_step', '0'));
  const now = currentStep();

  for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift++) {
    const step = now + drift;
    const expected = Buffer.from(codeForStep(secret, step));
    const given = Buffer.from(cleaned);
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
      if (!allowReplay && step <= lastUsed) return null; // already used
      return step;
    }
  }
  return null;
}

function markStepUsed(step) {
  setSetting('totp_last_step', String(step));
}

/* ---------- enrolment ---------- */

const isEnabled = () => Boolean(getSetting('totp_secret'));

function secretUri(secret, label = 'Invoice & Food Cost', issuer = 'Invoice & Food Cost') {
  return `otpauth://totp/${encodeURIComponent(label)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}` +
    `&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

function beginEnrolment() {
  const secret = generateSecret();
  setSetting('totp_pending', secret);
  return secret;
}

// Confirms enrolment with a code from the app, so nobody locks themselves out
// with a QR code they never actually scanned.
function completeEnrolment(code) {
  const pending = getSetting('totp_pending');
  if (!pending) return { ok: false, error: 'Start the setup again — no pending code was found.' };
  const step = verifyCode(pending, code, { allowReplay: true });
  if (step === null) return { ok: false, error: 'That code is not right. Check the app and try the next one.' };
  setSetting('totp_secret', pending);
  deleteSetting('totp_pending');
  markStepUsed(step);
  return { ok: true };
}

function disable() {
  deleteSetting('totp_secret');
  deleteSetting('totp_pending');
  deleteSetting('totp_last_step');
}

/* ---------- brute-force lockout ---------- */
//
// Kept in memory: a restart clears it, which is fine — the point is to make
// guessing slow, and an attacker cannot restart the server.

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
const WINDOW_MINUTES = 15;
const attempts = new Map(); // ip -> { count, first, lockedUntil }

function clientKey(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

function lockoutState(req) {
  const record = attempts.get(clientKey(req));
  if (!record) return { locked: false, remaining: MAX_ATTEMPTS };
  if (record.lockedUntil && record.lockedUntil > Date.now()) {
    return {
      locked: true,
      minutes: Math.ceil((record.lockedUntil - Date.now()) / 60000),
      remaining: 0,
    };
  }
  if (record.lockedUntil && record.lockedUntil <= Date.now()) {
    attempts.delete(clientKey(req));
    return { locked: false, remaining: MAX_ATTEMPTS };
  }
  return { locked: false, remaining: Math.max(0, MAX_ATTEMPTS - record.count) };
}

function recordFailure(req) {
  const key = clientKey(req);
  const now = Date.now();
  const record = attempts.get(key) || { count: 0, first: now, lockedUntil: 0 };

  if (now - record.first > WINDOW_MINUTES * 60000) {
    record.count = 0;
    record.first = now;
  }
  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) record.lockedUntil = now + LOCK_MINUTES * 60000;
  attempts.set(key, record);

  console.warn(`[auth] failed sign-in from ${key} (${record.count}/${MAX_ATTEMPTS})` +
    (record.lockedUntil ? ` — locked for ${LOCK_MINUTES} minutes` : ''));
  return lockoutState(req);
}

function clearFailures(req) {
  attempts.delete(clientKey(req));
}

module.exports = {
  isEnabled, beginEnrolment, completeEnrolment, disable,
  verifyCode, markStepUsed, secretUri, getSetting, setSetting, codeForStep,
  lockoutState, recordFailure, clearFailures,
  MAX_ATTEMPTS, LOCK_MINUTES,
};
