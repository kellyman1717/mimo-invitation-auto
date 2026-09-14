'use strict';
/**
 * Gmail reader for the OTP step, plus the dot-trick address generator.
 *
 * The IMAP work happens in lib/gmail.py (Python stdlib has imaplib + email
 * built in; doing it in Node would mean a new dependency and a few hundred
 * lines of MIME parsing). This module is the Node-side handle: it spawns that
 * process once, keeps the login alive, and speaks JSON lines to it.
 *
 * Gmail's dot trick: dots in the local part are ignored for delivery, so
 * j.o.h.ndoe@gmail.com, johndoe@gmail.com and johndoe+x@gmail.com all land in
 * one inbox. One mailbox therefore serves a whole batch of registrations —
 * each account gets a distinct address that Xiaomi treats as new, while every
 * OTP arrives in the same place.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

const GMAIL_PY = process.env.GMAIL_PY_PATH || path.join(__dirname, 'gmail.py');

const DOTLESS_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Insert dots into the local part of a Gmail address.
 *
 * The local part must be at least 2 chars to have anywhere to put a dot, and
 * Gmail ignores dots entirely, so every variant here delivers to the same
 * inbox as the configured address.
 *
 * @param {string} address e.g. "johndoe@gmail.com"
 * @param {number} [count] how many dots to insert (default: random 1..len-1)
 * @returns {string} e.g. "j.o.hndoe@gmail.com"
 */
function dotVariant(address, count = null) {
  const at = address.lastIndexOf('@');
  if (at < 1) throw new Error(`not an email address: ${address}`);
  const local = address.slice(0, at);
  const domain = address.slice(at + 1).toLowerCase();

  if (!DOTLESS_DOMAINS.has(domain)) {
    // Not Gmail: dots are significant, so a variant would be a different
    // mailbox and the OTP would never arrive. Refuse rather than mislead.
    throw new Error(
      `dot trick only works on gmail.com / googlemail.com, got "${domain}"`
    );
  }
  if (local.length < 2) {
    throw new Error(`local part too short for dots: "${local}"`);
  }

  // Gaps are the slots *between* characters: 1..local.length-1. Gap 0 would put
  // a dot in front of the address, and a gap that already holds a dot (the
  // address may be configured as "john.doe@gmail.com") would double it.
  const gaps = [];
  for (let i = 1; i < local.length; i++) {
    if (local[i] !== '.' && local[i - 1] !== '.') gaps.push(i);
  }
  // "a.b.c.d@gmail.com" has no dot-free gap left, so no variant exists. Failing
  // loudly beats returning the base address, which the caller would register as
  // a duplicate of the account already using it.
  if (!gaps.length) {
    throw new Error(`no room for more dots in "${local}" — it already has a dot at every gap`);
  }

  const n = count == null ? crypto.randomInt(1, gaps.length + 1) : Math.min(count, gaps.length);
  if (n < 1) return address;

  for (let i = gaps.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [gaps[i], gaps[j]] = [gaps[j], gaps[i]];
  }
  const chosen = new Set(gaps.slice(0, n));

  let out = '';
  for (let i = 0; i < local.length; i++) {
    if (chosen.has(i)) out += '.';
    out += local[i];
  }
  return `${out}@${domain}`;
}

/**
 * How many distinct dotted addresses a mailbox can produce.
 *
 * Counts the usable gaps (between characters, excluding any that already hold a
 * dot) and treats each as independently dotted or not. The all-empty
 * combination is the configured address itself, so it is excluded — a variant
 * must differ from the base to be worth registering.
 */
function dotVariantCount(address) {
  const at = address.lastIndexOf('@');
  if (at < 1) return 0;
  const local = address.slice(0, at);
  let gaps = 0;
  for (let i = 1; i < local.length; i++) {
    if (local[i] !== '.' && local[i - 1] !== '.') gaps++;
  }
  return Math.max(0, 2 ** gaps - 1);
}

class GmailBridge {
  /**
   * @param {object} o {user, password, verbose}
   */
  constructor(o = {}) {
    this.user = o.user;
    this.password = o.password;
    this.verbose = !!o.verbose;
    this.pyPath = o.pyPath || GMAIL_PY;
    this.child = null;
    this.pending = [];
    this.ready = false;
    this.failed = null;
  }

  get available() {
    return fs.existsSync(this.pyPath);
  }

  start(timeoutMs = 30000) {
    if (!this.available) {
      throw new Error(`gmail.py not found at ${this.pyPath} (set GMAIL_PY_PATH)`);
    }
    if (this.child) return Promise.resolve(this);

    // Credentials go through the environment: spawn() re-quotes argv on
    // Windows, and app passwords contain spaces.
    this.child = spawn('python', [this.pyPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: Object.assign({}, process.env, {
        GM_USER: this.user,
        GM_PASS: this.password,
      }),
    });

    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      const s = line.trim();
      if (s === 'READY') {
        this.ready = true;
        return;
      }
      // Progress lines belong to a still-running `wait`, not to a queued reply.
      if (s.startsWith('PROGRESS')) return;
      const waiter = this.pending.shift();
      if (!waiter) return;
      if (s.startsWith('ERROR')) waiter.reject(new Error(s.slice(6)));
      else waiter.resolve(s);
    });

    readline.createInterface({ input: this.child.stderr }).on('line', (l) => {
      const s = l.trim();
      if (!s) return;
      if (s.startsWith('FATAL')) this.failed = s.slice(6);
      if (this.verbose || s.startsWith('FATAL')) console.error('[gmail]', s);
    });

    this.child.on('exit', (code) => {
      this.child = null;
      this.ready = false;
      const err = new Error(this.failed || `gmail reader exited (code ${code})`);
      while (this.pending.length) this.pending.shift().reject(err);
    });

    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        if (this.ready) { clearInterval(tick); resolve(this); return; }
        if (this.failed || !this.child) {
          clearInterval(tick);
          reject(new Error(this.failed || 'gmail reader died during login'));
          return;
        }
        if (Date.now() - t0 > timeoutMs) {
          clearInterval(tick);
          this.stop();
          reject(new Error(`gmail login timed out after ${timeoutMs}ms`));
        }
      }, 150);
    });
  }

  _send(cmd) {
    if (!this.child || !this.ready) return Promise.reject(new Error('gmail reader not running'));
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(cmd + '\n');
    });
  }

  /** Newest-first message headers. */
  async list(limit = 20) {
    return JSON.parse(await this._send(`list ${limit}`));
  }

  /**
   * Wait for a message addressed to `to`.
   *
   * @returns {Promise<object|null>} the message, or null on timeout
   */
  async waitFor(to, { timeoutMs = 120000, intervalMs = 3000, sinceUid = 0 } = {}) {
    const raw = await this._send(`wait ${to} ${sinceUid} ${timeoutMs} ${intervalMs}`);
    return JSON.parse(raw);
  }

  /**
   * Same signature as CloudMail.waitForMail, so run.js can use either backend
   * without branching on which one is configured.
   *
   * @returns {Promise<object>} the message; throws on timeout
   */
  async waitForMail(toAddress, {
    timeoutMs = 120000,
    intervalMs = 3000,
    sinceId = 0,
    subjectIncludes = null,
    onPoll = null,
  } = {}) {
    // The Python side filters by recipient; subject filtering and the poll
    // callback stay here so both backends behave identically.
    const started = Date.now();
    let found = null;
    while (!found && Date.now() - started < timeoutMs) {
      const remaining = timeoutMs - (Date.now() - started);
      const msg = await this.waitFor(toAddress, {
        timeoutMs: remaining,
        intervalMs,
        sinceUid: sinceId,
      });
      if (!msg) break;
      if (subjectIncludes &&
          !String(msg.subject || '').toLowerCase().includes(subjectIncludes.toLowerCase())) {
        // Right recipient, wrong mail — advance the cursor past it and keep going.
        continue;
      }
      found = msg;
    }
    if (!found) {
      throw new Error(`timeout waiting for mail to ${toAddress} (baseline uid=${sinceId})`);
    }
    if (onPoll) onPoll(found);
    return found;
  }

  /**
   * Current highest UID, used as a "before this run" cursor.
   *
   * IMAP UIDs are monotonic per mailbox, so anything above this was delivered
   * after the call — the same role emailId plays for CloudMail.
   */
  async baseline() {
    const list = await this.list(1);
    return list.length ? list[0].uid : 0;
  }

  stop() {
    if (!this.child) return;
    try { this.child.stdin.write('quit\n'); } catch (_) {}
    try { this.child.kill(); } catch (_) {}
    this.child = null;
    this.ready = false;
  }
}

// Self-check for the dot trick. Run with `node lib/gmail.js`.
//
// The invariants here are the ones that broke during development: a dot placed
// before the first character, and a dot doubled next to one already present in
// the configured address. Both produced an address Gmail treats as the same
// mailbox but which is not a valid local part, so the bug would only surface as
// a failed registration much later.
if (require.main === module) {
  const assert = require('assert');

  const BASES = [
    'johndoe@gmail.com',
    'john.doe@gmail.com',
    'ab@gmail.com',
    'abc@gmail.com',
    'john.doe.smith@gmail.com',
    'kellyman9419@gmail.com',
  ];

  for (const base of BASES) {
    const at = base.lastIndexOf('@');
    const canonical = base.slice(0, at).replace(/\./g, '');
    const domain = base.slice(at + 1);
    const seen = new Set();

    for (let i = 0; i < 2000; i++) {
      const v = dotVariant(base);
      const vat = v.lastIndexOf('@');
      const local = v.slice(0, vat);

      assert.strictEqual(v.slice(vat + 1), domain, `domain changed: ${v}`);
      assert.ok(!local.startsWith('.'), `leading dot: ${v}`);
      assert.ok(!local.endsWith('.'), `trailing dot: ${v}`);
      assert.ok(!local.includes('..'), `doubled dot: ${v}`);
      // The whole point: stripping dots must give the configured mailbox.
      assert.strictEqual(local.replace(/\./g, ''), canonical, `different mailbox: ${v}`);
      assert.notStrictEqual(v, base, `returned the base address: ${v}`);
      seen.add(v);
    }
    const max = dotVariantCount(base);
    assert.ok(seen.size <= max, `${base}: ${seen.size} variants exceeds max ${max}`);
  }

  // Addresses the trick cannot serve must fail loudly, not silently return
  // something that would register a duplicate.
  assert.throws(() => dotVariant('user@yahoo.com'), /gmail/, 'non-gmail must be rejected');
  assert.throws(() => dotVariant('user@k9419.my.id'), /gmail/, 'non-gmail must be rejected');
  assert.throws(() => dotVariant('j@gmail.com'), /too short/, '1-char local part has no gap');
  assert.throws(() => dotVariant('a.b.c.d@gmail.com'), /no room/, 'no dot-free gap left');
  assert.strictEqual(dotVariantCount('a.b.c.d@gmail.com'), 0, 'count must agree with dotVariant');

  console.log('dot trick OK');
  for (const b of BASES) console.log(`  ${b.padEnd(28)} ${dotVariantCount(b)} addresses`);
  console.log('  rejected: non-gmail, 1-char local part, no free gap');
}

module.exports = { GmailBridge, dotVariant, dotVariantCount, GMAIL_PY, DOTLESS_DOMAINS };
