'use strict';
/**
 * Xiaomi (global) email-registration client, ported from the HAR trace to full HTTP.
 *
 * Chain (all plain HTTP, no browser):
 *   1. GET  mimo-server-sgp.../api/user/xiaomi/login?redirect=...   -> 302 -> serviceLogin
 *   2. GET  account.xiaomi.com/pass/serviceLogin?callback=...      -> 302 -> fe/service/login
 *   3. GET  global.account.xiaomi.com/pass/register?...            -> 302 -> fe/service/register
 *   4. GET  global.../pass2/config?key=login&key=register          -> region + captcha config
 *   5. GET  global.../pass/getCode?icodeType=register              -> captcha image
 *   6. POST global.../pass/sendEmailRegTicket  (EUI-encrypted)     -> send OTP to email
 *   7. read OTP from cloud-mail
 *   8. POST global.../pass/verifyEmailRegTicket (EUI-encrypted)    -> creates account + session
 *   9. GET  mimo-server-sgp.../api/sts?...                         -> mimo session cookie
 *
 * Steps 6 and 8 send `email`/`password` AES-encrypted and carry the RSA-wrapped
 * key in the `eui` header (see lib/crypto.js).
 */
const querystring = require('querystring');
const { Session } = require('./http');
const { encryptAes } = require('./crypto');

const GLOBAL = 'https://global.account.xiaomi.com';
const ACCOUNT = 'https://account.xiaomi.com';
const MIMO_SERVER = 'https://mimo-server-sgp.xiaomimimo.com';
const MIMO_WEB = 'https://mimo-ai.xiaomimimo.com';

const SID = 'mimosgp';
const CALLBACK_REDIRECT = `${MIMO_WEB}/desktop/invite/callback/`;

function parseJsonBody(text) {
  const s = String(text);
  const START = '&&&START&&&';
  const JSONP = '@json:';
  if (s.startsWith(START)) return JSON.parse(s.slice(START.length));
  if (s.startsWith(JSONP)) return JSON.parse(s.slice(JSONP.length));
  return JSON.parse(s);
}

class XiaomiRegister {
  constructor(opts = {}) {
    this.sid = opts.sid || SID;
    this.session = new Session({ cookieFile: opts.cookieFile });
    this.region = opts.region || 'ID';
    this.locale = opts.locale || 'en_US';
    this.sign = null;      // server-issued, from /api/user/xiaomi/login redirect
    this.callback = null;  // sts callback url
    this.followup = null;
    this.qs = null;        // double-encoded service params
    this.deviceId = null;
  }

  _hdr(extra = {}, referer = null) {
    const h = Object.assign(
      {
        accept: 'application/json, text/plain, */*',
        'x-requested-with': 'XMLHttpRequest',
      },
      extra
    );
    if (referer) {
      h.referer = referer;
      h.origin = GLOBAL;
    }
    return h;
  }

  /**
   * Step 1-3: walk the mimo -> xiaomi redirect chain and capture callback/followup/sign.
   */
  initLogin() {
    const redirect = encodeURIComponent(CALLBACK_REDIRECT);
    const r = this.session.request(
      `${MIMO_SERVER}/api/user/xiaomi/login?redirect=${redirect}`,
      { follow: false, headers: { accept: 'application/json' } }
    );
    if (r.status !== 302 || !r.headers.location) {
      throw new Error(`expected 302 from mimo login, got ${r.status}`);
    }
    const serviceLoginUrl = r.headers.location;
    const u = new URL(serviceLoginUrl);
    const callback = u.searchParams.get('callback');
    if (!callback) throw new Error('no callback param in serviceLogin redirect');

    // callback = https://mimo-server-sgp.../api/sts?sign=...&followup=...
    const cu = new URL(callback);
    this.callback = callback;
    this.sign = cu.searchParams.get('sign');
    this.followup = cu.searchParams.get('followup');

    // Follow to the login page so the account domain sets its cookies (deviceId etc.)
    const r2 = this.session.request(serviceLoginUrl, {
      follow: false,
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    if (r2.status === 200 || r2.status === 302) {
      // either is fine; just make sure cookies landed
    }
    const cookies = this.session.getCookies();
    this.deviceId = cookies.get('deviceId') || null;

    // Build the `qs` value the register page uses: "%3Fcallback%3D...%26sid%3D...%26_group%3DDEFAULT"
    const stsParams = `?callback=${encodeURIComponent(this.callback)}&sid=${this.sid}&_group=DEFAULT`;
    this.qs = encodeURIComponent(stsParams);

    return { sign: this.sign, callback: this.callback, deviceId: this.deviceId };
  }

  /** Step 4: region + captcha config. */
  getConfig(region = this.region) {
    const url = `${GLOBAL}/pass2/config?key=login&key=register&_locale=${this.locale}&sid=${this.sid}&_uRegion=${region}`;
    const r = this.session.request(url, {
      headers: this._hdr({}, `${GLOBAL}/fe/service/register`),
    });
    const j = parseJsonBody(r.text);
    this.config = j;
    this.region = j.uRegion || region;
    return j;
  }

  /** Step 5: fetch the captcha image. */
  getCaptchaImage() {
    const r = this.session.request(`${GLOBAL}/pass/getCode?icodeType=register&t=${Math.random()}`, {
      headers: { accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' },
      referer: `${GLOBAL}/fe/service/register`,
    });
    if (!r.body || r.body.length < 100) throw new Error('empty captcha image');
    return r.body;
  }

  registerReferer() {
    return `${GLOBAL}/fe/service/register?_group=DEFAULT&sid=${this.sid}&qs=${this.qs}&callback=${encodeURIComponent(this.callback)}&_locale=${this.locale}`;
  }

  /**
   * Step 6: send the email OTP.
   * @param {string} email plaintext address
   * @param {string} password plaintext password
   * @param {string} icode captcha solution (may be empty on first attempt)
   */
  sendEmailRegTicket({ email, password, icode = '' }) {
    const plain = { email, password };
    const { EUI, encryptedParams } = encryptAes(plain);
    const body = querystring.stringify({
      email: encryptedParams.email,
      password: encryptedParams.password,
      region: this.region,
      sid: this.sid,
      icode,
    });
    const r = this.session.request(`${GLOBAL}/pass/sendEmailRegTicket`, {
      method: 'POST',
      body,
      headers: this._hdr({
        eui: EUI,
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      }, this.registerReferer()),
    });
    return this._unwrap(r);
  }

  /**
   * Step 8: verify OTP and create the account.
   * Returns {ticket/location, ...} — a `location` means follow it to get the session.
   */
  verifyEmailRegTicket({ ticket, email, password }) {
    const { EUI, encryptedParams } = encryptAes({ email, password });
    const body = querystring.stringify({
      ticket,
      region: this.region,
      email: encryptedParams.email,
      env: 'web',
      qs: this.qs,
      isAcceptLicense: 'true',
      sid: this.sid,
      password: encryptedParams.password,
      policyName: 'globalmiaccount',
      callback: this.callback,
      deviceFingerprint: this.deviceFingerprint || undefined,
    });
    const r = this.session.request(`${GLOBAL}/pass/verifyEmailRegTicket`, {
      method: 'POST',
      body,
      headers: this._hdr({
        eui: EUI,
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      }, this.registerReferer()),
    });
    return this._unwrap(r, { keepLocation: true });
  }

  /** Establish the mimo session (step 9). */
  establishSession(location) {
    const u = new URL(location, GLOBAL);
    // sts -> 307 -> /api/user/xiaomi/login?...&userId=... -> 302 -> callback
    const r1 = this.session.request(u.toString(), {
      follow: false,
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    return r1;
  }

  _unwrap(r, { keepLocation = false } = {}) {
    let j;
    try { j = parseJsonBody(r.text); } catch (_) {
      throw new Error(`non-json response (${r.status}): ${r.text.slice(0, 300)}`);
    }
    if (j.code !== 0 && j.code !== 302 && j.code !== 70016) {
      const err = new Error(`xiaomi error ${j.code}: ${j.desc || j.description || j.message || ''}`);
      err.code = j.code;
      err.body = j;
      throw err;
    }
    if (keepLocation && j.location) j._location = j.location;
    return j;
  }
}

module.exports = { XiaomiRegister, parseJsonBody, MIMO_SERVER, MIMO_WEB, GLOBAL, ACCOUNT, CALLBACK_REDIRECT };
