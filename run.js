#!/usr/bin/env node
'use strict';
/**
 * MiMo Desktop — create one account and submit the invite form, full HTTP.
 *
 *   node run.js                 # uses ./config.json (copy from config.example.json)
 *   node run.js --dry-mail      # stop right before sending the OTP email
 *   node run.js --no-submit     # create account, skip the invite form
 *
 * Exit codes: 0 ok, 1 failure.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { XiaomiRegister } = require('./lib/xiaomi');
const { CloudMail, extractCode } = require('./lib/mail');
const { solveImage } = require('./lib/captcha');
const { MiMoInvite, defaultAnswers } = require('./lib/invite');

const RESULTS_DIR = path.join(__dirname, 'results');

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

async function main() {
  const cfg = loadConfig();
  const argv = process.argv.slice(2);
  const dryMail = argv.includes('--dry-mail');
  const noSubmit = argv.includes('--no-submit');

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.mkdirSync(path.join(__dirname, 'tmp'), { recursive: true });

  // ---- identity -----------------------------------------------------------
  const domains = cfg.domains || ['k9419.my.id'];
  const domain = domains[crypto.randomInt(domains.length)];
  const email = `${randomLocalPart()}@${domain}`;
  const password = randomPassword((cfg.password && cfg.password.length) || 14);
  log('email    :', email);
  log('password :', password);

  // ---- mail ---------------------------------------------------------------
  const mail = new CloudMail(cfg.mail);
  log('logging in to cloud-mail…');
  mail.login();
  // Baseline: ignore anything already in the inbox
  const baseline = Math.max(0, ...mail.listAll(0, 20).map((m) => m.emailId), 0);
  log('mail ready, baseline emailId =', baseline);

  // ---- xiaomi -------------------------------------------------------------
  // Persistent jar: the session established at the end is the account's login
  // token, so we keep it on disk (copied into results/ once we know the userId).
  const jar = path.join(__dirname, 'tmp', `session-${Date.now()}.cookies`);
  const xr = new XiaomiRegister({
    region: (cfg.xiaomi || {}).region,
    locale: (cfg.xiaomi || {}).locale,
    cookieFile: jar,
  });
  log('step 1: init login chain');
  const init = xr.initLogin();
  log('  sign =', init.sign, '| deviceId =', init.deviceId);

  log('step 2: pass2 config');
  const conf = xr.getConfig();
  log('  region =', conf.uRegion, '| registerMethods =', JSON.stringify(conf.registerMethods));

  if (dryMail) {
    log('--dry-mail: stopping before OTP send');
    log('email:', email, 'password:', password);
    return;
  }

  // ---- captcha + OTP ------------------------------------------------------
  // The captcha is bound to the `ick` cookie issued by getCode, and a wrong
  // answer invalidates it — so every retry must re-fetch a fresh image.
  const maxAttempts = (cfg.captcha && cfg.captcha.maxAttempts) || 5;
  let sent = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`step 3.${attempt}: fetch captcha image`);
    const img = xr.getCaptchaImage();
    fs.writeFileSync(path.join(__dirname, 'tmp', 'last-captcha.jpg'), img);

    log(`step 3.${attempt}: solve captcha`);
    const icode = await solveImage(img, cfg.captcha || {});
    log('  solved icode =', icode);

    // Xiaomi's challenge is 5 chars; a solver that returns junk (a stray word,
    // a truncated read) is wrong by construction. Submitting it would only burn
    // a round-trip and invalidate `ick`, so skip straight to a fresh image.
    if (!/^[a-z0-9]{4,6}$/i.test(icode)) {
      log(`  implausible answer ${JSON.stringify(icode)}, refetching ${attempt}/${maxAttempts}…`);
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

  if (noSubmit) {
    log('--no-submit: skipping invite form');
  } else {
    log('step 9: invite check + apply');
    const chk = invite.check();
    log('  check ->', JSON.stringify(chk));
    const answers = defaultAnswers(email, cfg.invite || {});
    const applied = invite.apply(answers);
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
    invite: noSubmit ? 'skipped' : 'submitted',
    cookies: cookieCopy ? path.basename(cookieCopy) : null,
  };
  const file = path.join(RESULTS_DIR, `${base}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  fs.appendFileSync(path.join(RESULTS_DIR, 'accounts.txt'), `${email}:${password}\n`);
  log('DONE ->', file);
  log(JSON.stringify(out));
}

main().catch((e) => {
  console.error('\n[run] FAILED:', e.message);
  if (e.body) console.error('[run] body:', JSON.stringify(e.body));
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
