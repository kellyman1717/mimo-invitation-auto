'use strict';
/**
 * Cloud Mail (cloud-mail.<subdomain>.workers.dev) client — the self-hosted
 * cloudflare-mail fork that the HAR traces against.
 *
 * Flow (from HAR `2-cloud-mail...har`):
 *   POST /api/login            {email, password}   -> {code, data:{token}}
 *   GET  /api/my/loginUserInfo                    -> account + permKeys
 *   GET  /api/account/list?accountId=0&size=30    -> mailboxes
 *   GET  /api/allEmail/list?...&type=receive      -> all inbound mail (catch-all)
 *
 * The inbox is a catch-all: mail to any address on the domain lands here, so a
 * randomly-generated address needs no provisioning step.
 */
const { Session } = require('./http');

class CloudMail {
  constructor({ baseUrl, email, password, proxy, pool }) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.email = email;
    this.password = password;
    // The mailbox is the operator's own account on a different host than the
    // registration target, so it stays direct by default: a free proxy that
    // passes Xiaomi validation may still fail here, and failing mid-poll costs
    // the whole run. Pass `proxy` explicitly to route it too.
    this.session = new Session({ proxy, pool });
    this.token = null;
  }

  _api(path, o = {}) {
    const url = this.base + path;
    const headers = Object.assign(
      { accept: 'application/json, text/plain, */*', 'content-type': 'application/json' },
      o.headers || {}
    );
    if (this.token) headers['authorization'] = this.token;
    const res = this.session.request(url, Object.assign({}, o, { headers, follow: false }));
    if (res.status >= 300 && res.status < 400) {
      // cloud-mail rarely redirects; treat as-is
    }
    let json = null;
    try { json = JSON.parse(res.text); } catch (_) {}
    return { status: res.status, json, text: res.text, res };
  }

  login() {
    const r = this._api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email: this.email, password: this.password }),
    });
    if (!r.json || r.json.code !== 200) {
      throw new Error(`cloudmail login failed: ${r.status} ${r.text.slice(0, 200)}`);
    }
    this.token = r.json.data.token;
    return this.token;
  }

  /** Returns the catch-all mailbox id used for polling. */
  accountList(size = 30) {
    const r = this._api(`/api/account/list?accountId=0&size=${size}`);
    if (!r.json || r.json.code !== 200) throw new Error('account/list failed: ' + r.text.slice(0, 200));
    return r.json.data;
  }

  /**
   * Poll the catch-all inbox for the newest mail sent to `toAddress`.
   * @returns {Promise<object|null>} email object {emailId, subject, content, text, ...}
   */
  async waitForMail(toAddress, {
    timeoutMs = 120000,
    intervalMs = 3000,
    sinceId = 0,
    subjectIncludes = null,
    onPoll = null,
  } = {}) {
    const deadline = Date.now() + timeoutMs;
    const want = String(toAddress).toLowerCase();
    let seen = 0;
    while (Date.now() < deadline) {
      const list = this.listAll(0, 50);
      seen = Math.max(seen, ...list.map((m) => m.emailId), 0);
      for (const m of list) {
        if (m.emailId <= sinceId) continue; // ignore pre-existing mail
        if ((m.toEmail || '').toLowerCase() !== want) continue;
        if (subjectIncludes && !String(m.subject || '').toLowerCase().includes(subjectIncludes.toLowerCase())) continue;
        if (onPoll) onPoll(m);
        return m;
      }
      await sleep(intervalMs);
    }
    throw new Error(`timeout waiting for mail to ${toAddress} (newest id seen=${seen}, baseline=${sinceId})`);
  }

  /**
   * Newest-first list from the catch-all endpoint.
   *
   * NOTE: the `emailId` query param is a "less than" cursor — `emailId=0` means
   * "from the top". Passing a real id would *exclude* everything newer than it,
   * so we always fetch from the top and filter by id client-side.
   */
  listAll(_ignored = 0, size = 50) {
    const p = `?emailId=0&size=${size}&timeSort=0&type=receive&searchType=name`;
    const r = this._api('/api/allEmail/list' + p);
    if (!r.json || r.json.code !== 200) throw new Error('allEmail/list failed: ' + r.text.slice(0, 200));
    const list = (r.json.data && r.json.data.list) || [];
    return list.sort((a, b) => b.emailId - a.emailId);
  }

  /** Fetch a single email (full body) by id. */
  get(emailId) {
    const r = this._api(`/api/email/detail?emailId=${emailId}`);
    if (!r.json || r.json.code !== 200) throw new Error('email/detail failed: ' + r.text.slice(0, 200));
    return r.json.data;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Pulls a numeric verification code out of an email body.
 * Handles Xiaomi's "verification code is 376179" phrasing and bare 6-digit fallback.
 */
function extractCode(mail) {
  const body = String((mail && (mail.text || mail.content)) || '');
  const patterns = [
    /verification\s*code\s*(?:is|:)?\s*[:\s]*([0-9]{4,8})/i,
    /(?:code|kode)\s*(?:is|:)?\s*[:\s]*([0-9]{4,8})/i,
    /\b([0-9]{6})\b/,
  ];
  const plain = body.replace(/<[^>]*>/g, ' ');
  for (const re of patterns) {
    const m = plain.match(re);
    if (m) return m[1];
  }
  return null;
}

module.exports = { CloudMail, extractCode, sleep };
