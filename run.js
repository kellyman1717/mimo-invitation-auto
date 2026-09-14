#!/usr/bin/env node
'use strict';
/**
 * MiMo Desktop — create accounts and submit the invite form, full HTTP.
 *
 *   node run.js                 # one account, uses ./config.json
 *   node run.js -n 10           # ten accounts, one after another
 *   node run.js -n 10 --delay 5000
 *   node run.js --dry-mail      # stop right before sending the OTP email
 *   node run.js --no-submit     # create accounts, skip the invite form
 *   node run.js --proxy         # force the proxy pool on
 *
 * Exit codes: 0 if at least one account succeeded, 1 if none did.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { XiaomiRegister } = require('./lib/xiaomi');
const { CloudMail, extractCode } = require('./lib/mail');
const { solveImage } = require('./lib/captcha');
const { MiMoInvite, defaultAnswers } = require('./lib/invite');
const { ProxyBridge } = require('./lib/proxy');

const RESULTS_DIR = path.join(__dirname, 'results');
const ALL_ACCOUNTS = path.join(RESULTS_DIR, 'all_accounts.json');

// Codes the server returns when the captcha answer was wrong / unreadable.
const CAPTCHA_ERRORS = new Set([87001, 20003, 70008, 70009, 70014, 10031, 10017]);

function loadConfig() {
  const p = path.join(__dirname, 'config.json');
  if (!fs.existsSync(p)) {
    console.error('missing config.json — copy config.example.json and fill it in');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Parse argv. Unknown arguments are fatal: a typo like `-m 10` silently
 * creating one account is worse than an error message.
 *
 * Accepts -n 10, -n10, and --count=10.
 */
function parseArgs(argv) {
  const o = { count: 1, dryMail: false, noSubmit: false, proxy: false, delayMs: 8000 };

  const setCount = (raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`-n/--count needs a positive integer, got ${JSON.stringify(raw)}`);
    }
    o.count = n;
  };
  const setDelay = (raw) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`--delay needs a non-negative number of ms, got ${JSON.stringify(raw)}`);
    }
    o.delayMs = n;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-mail') o.dryMail = true;
    else if (a === '--no-submit') o.noSubmit = true;
    else if (a === '--proxy') o.proxy = true;
    else if (a === '-n' || a === '--count') setCount(argv[++i]);
    else if (/^-n\d+$/.test(a)) setCount(a.slice(2));
    else if (a.startsWith('--count=')) setCount(a.slice(8));
    else if (a === '--delay') setDelay(argv[++i]);
    else if (a.startsWith('--delay=')) setDelay(a.slice(8));
    else if (a === '-h' || a === '--help') { o.help = true; }
    else throw new Error(`unknown argument: ${a} (try --help)`);
  }
  return o;
}

const HELP = `Usage: node run.js [options]

  -n, --count <n>   how many accounts to create (default 1)
      --delay <ms>  pause between accounts (default 8000, plus jitter)
      --dry-mail    stop before sending the OTP email
      --no-submit   create accounts but skip the invite form
      --proxy       force the proxy pool on
  -h, --help        this message`;

function randomLocalPart(len = 12) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  const b = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += chars[b[i] % chars.length];
  return out;
}

function randomPassword(len = 14) {
  // Xiaomi requires 8-16 chars, mixed case + digit
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const pick = (s) => s[crypto.randomInt(s.length)];
  const chars = [pick(upper), pick(lower), pick(digits)];
  const all = upper + lower + digits;
  while (chars.length < len) chars.push(pick(all));
  // shuffle
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

const log = (...a) => console.log('[run]', ...a);

/** Logger with a "[3/10]" prefix, so parallel-ish output stays readable. */
function makeLog(index, total) {
  if (total <= 1) return log;
  const tag = `[${index}/${total}]`;
  return (...a) => console.log('[run]', tag, ...a);
}

/**
 * Append one account to results/all_accounts.json.
 *
 * Read-modify-write on every run: the file is small (a few hundred bytes per
 * account), and a locked append format would need a parser for no benefit.
 * A corrupt or missing file is treated as empty rather than fatal — losing the
 * aggregate is not worth losing the account we just created.
 */
function appendToAllAccounts(entry, logger = log) {
  let all = [];
  try {
    if (fs.existsSync(ALL_ACCOUNTS)) {
      const parsed = JSON.parse(fs.readFileSync(ALL_ACCOUNTS, 'utf8'));
      if (Array.isArray(parsed)) all = parsed;
      else if (parsed && Array.isArray(parsed.accounts)) all = parsed.accounts;
    }
  } catch (e) {
    logger(`WARNING: ${path.basename(ALL_ACCOUNTS)} unreadable (${e.message}), starting a new one`);
    all = [];
  }
  all.push(entry);
  fs.writeFileSync(ALL_ACCOUNTS, JSON.stringify(all, null, 2));
  return all.length;
}

/**
 * Create exactly one account and submit the invite form.
 *
 * Throws on failure — the caller decides whether to retry or move on. The
 * mailbox and proxy pool arrive pre-warmed in `ctx` because both are expensive
 * to set up and are shared across a batch.
 *
 * @returns {Promise<object>} the account record written to results/
 */
async function createOne(cfg, ctx) {
  // The session holds proxies taken from the shared pool; they must go back
  // whether this account succeeds or throws, or a batch slowly starves the pool.
  let session = null;
  try {
    return await createOneInner(cfg, ctx, (s) => { session = s; });
  } finally {
    if (session) await session.releaseProxies();
  }
}

async function createOneInner(cfg, ctx, onSession) {
  const { mail, bridge, index = 1, total = 1 } = ctx;
  const log = makeLog(index, total);

  // ---- identity -----------------------------------------------------------
  const domains = cfg.domains || ['k9419.my.id'];
  const domain = domains[crypto.randomInt(domains.length)];
  const email = `${randomLocalPart()}@${domain}`;
  const password = randomPassword((cfg.password && cfg.password.length) || 14);
  log('email    :', email);
  log('password :', password);

  // Baseline per account: the previous account's OTP is already in the inbox by
  // now, and `sinceId` should only exclude mail that predates this attempt.
  const baseline = Math.max(0, ...mail.listAll(0, 20).map((m) => m.emailId), 0);
  log('mail ready, baseline emailId =', baseline);

  // ---- xiaomi -------------------------------------------------------------
  // Persistent jar: the session established at the end is the account's login
  // token, so we keep it on disk (copied into results/ once we know the userId).
  const jar = path.join(__dirname, 'tmp', `session-${Date.now()}-${index}.cookies`);
  const xr = new XiaomiRegister({
    region: (cfg.xiaomi || {}).region,
    locale: (cfg.xiaomi || {}).locale,
    cookieFile: jar,
    pool: bridge,
  });
  onSession(xr.session);
  // One proxy pinned for the whole account — see Session.primeProxies for why.
  if (bridge) {
    await xr.session.primeProxies((cfg.proxy && cfg.proxy.spare) || 3);
    log('proxy: using', xr.session.proxy || '(none available — going direct)');
  }

  log('step 1: init login chain');
  const init = xr.initLogin();
  log('  sign =', init.sign, '| deviceId =', init.deviceId);

  log('step 2: pass2 config');
  const conf = xr.getConfig();
  log('  region =', conf.uRegion, '| registerMethods =', JSON.stringify(conf.registerMethods));

  if (ctx.dryMail) {
    log('--dry-mail: stopping before OTP send');
    return { email, password, userId: null, invite: 'dry-run', project: null, proxy: null };
  }

  // ---- captcha + OTP ------------------------------------------------------
  // The captcha is bound to the `ick` cookie issued by getCode, and a wrong
  // answer invalidates it — so every retry must re-fetch a fresh image.
  const maxAttempts = (cfg.captcha && cfg.captcha.maxAttempts) || 5;
  let sent = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`step 3.${attempt}: fetch captcha image`);
    const img = xr.getCaptchaImage();
    fs.writeFileSync(path.join(__dirname, 'tmp', `last-captcha-${index}.jpg`), img);

    log(`step 3.${attempt}: solve captcha`);
    const icode = await solveImage(img, cfg.captcha || {});
    log('  solved icode =', icode);

    // Xiaomi's challenge is always 5 chars, and a solver that reads 4 of them
    // is wrong by construction — measured 0 successes out of 5 such answers,
    // against ~50% for 5-char ones. Submitting it would only burn a round-trip
    // and invalidate `ick`, so skip straight to a fresh image.
    const wantLen = (cfg.captcha && cfg.captcha.length) || 5;
    if (!new RegExp(`^[a-z0-9]{${wantLen}}$`, 'i').test(icode)) {
      log(`  implausible answer ${JSON.stringify(icode)} (want ${wantLen} chars), refetching ${attempt}/${maxAttempts}…`);
      if (attempt === maxAttempts) throw new Error(`captcha solver never produced a usable answer (last: ${icode})`);
      continue;
    }

    log(`step 3.${attempt}: sendEmailRegTicket`);
    try {
      sent = xr.sendEmailRegTicket({ email, password, icode });
      log('  ->', JSON.stringify(sent).slice(0, 200));
      break;
    } catch (e) {
      if (!CAPTCHA_ERRORS.has(e.code)) throw e;
      log(`  captcha rejected (code ${e.code}), retrying ${attempt}/${maxAttempts}…`);
      if (attempt === maxAttempts) throw new Error(`captcha failed after ${maxAttempts} attempts`);
    }
  }

  log('step 6: waiting for OTP email…');
  const mailObj = await mail.waitForMail(email, {
    timeoutMs: 120000,
    intervalMs: 3000,
    sinceId: baseline,
    subjectIncludes: 'Xiaomi',
    onPoll: (m) => log('  got mail:', m.subject),
  });
  const ticket = extractCode(mailObj);
  if (!ticket) throw new Error('could not extract code from email: ' + (mailObj.subject || ''));
  log('  OTP =', ticket);

  log('step 7: verifyEmailRegTicket (creates account)');
  const verified = xr.verifyEmailRegTicket({ ticket, email, password });
  log('  ->', JSON.stringify(verified).slice(0, 300));

  // ---- session ------------------------------------------------------------
  log('step 8: establish mimo session');
  const loc = verified.location || verified._location;
  if (loc) {
    const r = xr.establishSession(loc);
    log('  sts ->', r.status, (r.headers.location || '').slice(0, 120));
    if (r.headers.location) {
      const r2 = xr.session.request(r.headers.location, { follow: true, headers: { accept: 'text/html' } });
      log('  session ->', r2.status);
    }
  }

  // ---- verify identity ----------------------------------------------------
  const invite = new MiMoInvite({ session: xr.session });
  let me;
  try {
    me = invite.me();
    log('  me/basic ->', JSON.stringify(me));
    if (me.code !== 0) throw new Error('not logged in: ' + JSON.stringify(me));
  } catch (e) {
    log('  me/basic failed:', e.message);
  }

  // Built here (not inside the branch) so the generated `project` text can be
  // recorded in the result files even when --no-submit skips the form.
  const answers = defaultAnswers(email, cfg.invite || {});

  if (ctx.noSubmit) {
    log('--no-submit: skipping invite form');
  } else {
    log('step 9: invite check + apply');
    const chk = invite.check();
    log('  check ->', JSON.stringify(chk));
    log('  project ->', answers.project);

    // 10003 = "request body could not be parsed". Seen on a free SOCKS proxy
    // that mangles the POST body; the payload itself is fine, so retrying is
    // the fix. The account already exists at this point, so giving up here
    // would waste it.
    let applied = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      applied = invite.apply(answers);
      if (applied.code === 0) break;
      if (applied.code !== 10003) break;
      log(`  apply body mangled (10003), retrying ${attempt}/3…`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
    log('  apply ->', JSON.stringify(applied));
    if (applied.code !== 0) throw new Error('invite apply failed: ' + JSON.stringify(applied));

    // `check` reports status:null before the application exists and 0 once it
    // is on file — the only server-side confirmation the API offers.
    const after = invite.check();
    log('  check after ->', JSON.stringify(after));
    if (!after.data || after.data.status == null) {
      throw new Error('invite application not registered: ' + JSON.stringify(after));
    }
  }

  // ---- persist ------------------------------------------------------------
  const userId = (me && me.data && me.data.userId) || null;
  const base = `account-${userId || Date.now()}`;

  // Keep the logged-in cookie jar next to the credentials so the account can be
  // reused without re-running registration.
  let cookieCopy = null;
  if (userId && fs.existsSync(jar)) {
    cookieCopy = path.join(RESULTS_DIR, `${base}.cookies.txt`);
    fs.copyFileSync(jar, cookieCopy);
  }

  const out = {
    email,
    password,
    userId,
    createdAt: new Date().toISOString(),
    invite: ctx.noSubmit ? 'skipped' : 'submitted',
    project: answers.project,
    proxy: xr.session.proxy || null,
    cookies: cookieCopy ? path.basename(cookieCopy) : null,
  };
  const file = path.join(RESULTS_DIR, `${base}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  fs.appendFileSync(path.join(RESULTS_DIR, 'accounts.txt'), `${email}:${password}\n`);

  const totalAccounts = appendToAllAccounts(Object.assign({}, out, { file: path.basename(file) }), log);
  log('DONE ->', file);
  log(`  ${path.basename(ALL_ACCOUNTS)} now holds ${totalAccounts} account(s)`);

  // The jar is copied into results/ on success; the tmp copy is scratch.
  try { fs.unlinkSync(jar); } catch (_) {}

  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`[run] ${e.message}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const cfg = loadConfig();
  const useProxy = opts.proxy || !!((cfg.proxy || {}).enabled);
  const total = opts.count;

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.mkdirSync(path.join(__dirname, 'tmp'), { recursive: true });

  // ---- proxy ---------------------------------------------------------------
  // Started once for the whole batch: scraping and validating takes ~10s, and
  // each account then just takes a proxy from the warm pool.
  let bridge = null;
  if (useProxy) {
    const pc = cfg.proxy || {};
    bridge = new ProxyBridge({
      path: pc.scriptPath,
      target: pc.validateTarget,
      want: pc.want || 8,
      minPool: pc.minPool || 3,
      verbose: pc.verbose || !!process.env.DEBUG,
    });
    if (!bridge.available) {
      log(`proxy: proxypool.py not found at ${bridge.path} — set proxy.scriptPath in config.json`);
      log('proxy: continuing WITHOUT a proxy');
      bridge = null;
    } else {
      log('proxy: warming pool (scrape + validate)…');
      try {
        await bridge.start();
        log('proxy: pool ready');
        global.__proxyBridge = bridge; // stopped in main().finally
      } catch (e) {
        log(`proxy: pool unavailable (${e.message})`);
        if (pc.required) throw new Error('proxy required but unavailable: ' + e.message);
        log('proxy: continuing WITHOUT a proxy');
        bridge = null;
      }
    }
  }

  // ---- mail ---------------------------------------------------------------
  // Logged in once for the batch. The inbox is a catch-all, so one session
  // serves every generated address; re-logging in per account would be 10x the
  // auth traffic for nothing.
  const mail = new CloudMail(cfg.mail);
  log('logging in to cloud-mail…');
  mail.login();
  log('mail ready');

  // ---- batch --------------------------------------------------------------
  if (total > 1) log(`creating ${total} accounts, ${opts.delayMs}ms between them`);
  const results = [];
  const failures = [];

  for (let i = 1; i <= total; i++) {
    const started = Date.now();
    try {
      const out = await createOne(cfg, {
        mail, bridge, index: i, total,
        dryMail: opts.dryMail, noSubmit: opts.noSubmit,
      });
      results.push(out);
      if (total > 1) {
        log(`[${i}/${total}] ok in ${((Date.now() - started) / 1000).toFixed(0)}s — ${out.email}`);
      }
    } catch (e) {
      failures.push({ index: i, error: e.message });
      console.error(`[run] [${i}/${total}] FAILED: ${e.message}`);
      if (process.env.DEBUG) console.error(e.stack);
      // Keep going: one bad account (dead proxy, captcha timeout) should not
      // throw away the rest of the batch.
    }

    if (i < total && opts.delayMs > 0) {
      // Jitter so a batch does not hammer the endpoints on a fixed cadence.
      const wait = opts.delayMs + crypto.randomInt(Math.max(1, Math.floor(opts.delayMs / 2)));
      log(`waiting ${(wait / 1000).toFixed(1)}s before the next account…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  // ---- summary ------------------------------------------------------------
  if (total > 1 || failures.length) {
    log('');
    log(`=== done: ${results.length}/${total} succeeded ===`);
    for (const f of failures) log(`  failed #${f.index}: ${f.error}`);
  }
  if (opts.dryMail) {
    log('(dry run — no accounts were created)');
  }

  // Exit non-zero only if nothing worked: a batch that produced 9/10 accounts
  // is a success, and the failures are already listed above.
  if (results.length === 0 && failures.length > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('\n[run] FAILED:', e.message);
    if (e.body) console.error('[run] body:', JSON.stringify(e.body));
    if (process.env.DEBUG) console.error(e.stack);
    process.exitCode = 1;
  })
  // The proxy pool is a child process; without this the event loop stays alive
  // after a successful run and the script never exits.
  .finally(() => {
    if (global.__proxyBridge) global.__proxyBridge.stop();
  });
