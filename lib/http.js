'use strict';
/**
 * Minimal cookie-aware HTTP client built on curl.
 * Uses curl so TLS fingerprint (JA3/JA4) matches a real Chrome-ish client and
 * --http1.1 keeps the redirect/cookie semantics predictable.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

class Session {
  constructor(opts = {}) {
    this.ua = opts.ua || UA;
    this.cookieFile =
      opts.cookieFile ||
      path.join(os.tmpdir(), 'mimo-cookies-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.txt');
    this.persistent = !!opts.cookieFile;
    fs.mkdirSync(path.dirname(this.cookieFile), { recursive: true });
    if (!this.persistent || !fs.existsSync(this.cookieFile)) fs.writeFileSync(this.cookieFile, '');
    this.defaultHeaders = {
      'accept-language': 'en-US,en;q=0.9,id-ID;q=0.8,id;q=0.7',
      'sec-ch-ua': '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    };
    this.lastUrl = null;
    this.verbose = !!opts.verbose;
  }

  getCookies() {
    const raw = fs.readFileSync(this.cookieFile, 'utf8');
    const out = new Map();
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const p = line.split('\t');
      if (p.length >= 7) out.set(p[5], p[6]);
    }
    return out;
  }

  cookieHeader() {
    return [...this.getCookies()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /**
   * @param {string} url
   * @param {object} o {method, headers, body, follow:true, referer, dump, timeout}
   */
  request(url, o = {}) {
    const args = ['-sS', '--compressed', '--http1.1', '-b', this.cookieFile, '-c', this.cookieFile];
    args.push('-A', this.ua);
    args.push('-D', '-'); // headers to stdout
    if (o.follow !== false) args.push('-L', '--max-redirs', '10');
    if (o.method) args.push('-X', o.method);
    if (o.timeout) args.push('--max-time', String(o.timeout));

    const headers = Object.assign({}, this.defaultHeaders);
    if (o.referer) headers['referer'] = o.referer;
    if (o.origin) headers['origin'] = o.origin;
    Object.assign(headers, o.headers || {});
    for (const [k, v] of Object.entries(headers)) {
      if (v == null) continue;
      args.push('-H', `${k}: ${v}`);
    }
    if (o.body != null) args.push('--data-binary', Buffer.isBuffer(o.body) ? o.body.toString('binary') : o.body);
    if (o.dump) args.push('-o', o.dump); else args.push('-o', '-');
    if (o.verbose) args.push('-v');
    args.push(url);

    let out;
    try {
      out = execFileSync('curl', args, { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', windowsHide: true });
    } catch (e) {
      if (e.stdout) out = e.stdout;
      else throw e;
    }
    return this._parse(out, o.dump);
  }

  _parse(buf, dumped) {
    // split all header blocks from body; on redirects there are multiple blocks
    const sep = Buffer.from('\r\n\r\n');
    const blocks = [];
    let rest = buf;
    while (true) {
      const i = rest.indexOf(sep);
      if (i < 0) break;
      const head = rest.slice(0, i).toString('utf8');
      if (!/^HTTP\//.test(head)) break;
      blocks.push(head);
      rest = rest.slice(i + 4);
    }
    const last = blocks.length ? blocks[blocks.length - 1] : '';
    const lines = last.split(/\r?\n/);
    const status = parseInt((lines[0].match(/HTTP\/[\d.]+ (\d+)/) || [])[1] || '0', 10);
    const headers = {};
    for (const l of lines.slice(1)) {
      const i = l.indexOf(':');
      if (i > 0) {
        const k = l.slice(0, i).toLowerCase();
        if (!(k in headers)) headers[k] = l.slice(i + 1).trim();
      }
    }
    let body;
    if (dumped) {
      body = fs.readFileSync(dumped);
    } else {
      // strip any trailing header blocks that got appended (shouldn't normally)
      body = rest;
    }
    return { status, headers, body, text: body.toString('utf8'), blocks };
  }

  destroy() {
    if (this.persistent) return; // keep on disk for debugging / resume
    try { fs.unlinkSync(this.cookieFile); } catch (_) {}
  }
}

module.exports = { Session, UA };
