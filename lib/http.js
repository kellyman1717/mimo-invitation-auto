'use strict';
/**
 * Minimal cookie-aware HTTP client built on curl.
 * Uses curl so TLS fingerprint (JA3/JA4) matches a real Chrome-ish client and
 * --http1.1 keeps the redirect/cookie semantics predictable.
 *
 * Proxy support: pass `proxy` (a "scheme://ip:port" string) or `pool` (a
 * ProxyBridge) to route through a proxy. With a pool, a request that fails at
 * the transport layer drops that proxy and retries through a fresh one.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

/**
 * Translate a proxy URL into curl flags.
 *
 * curl has no single "-x" for all schemes: socks needs --socks5-hostname so DNS
 * is resolved at the proxy (that is what "socks5h" means — resolving locally
 * leaks the hostname and breaks proxies that cannot see it).
 *
 * @returns {string[]} curl args, or [] for no proxy
 */
function proxyArgs(proxy) {
  if (!proxy) return [];
  const m = String(proxy).match(/^(socks5h|socks5|socks4a|socks4|https?):\/\/(.+)$/i);
  if (!m) return [];
  const scheme = m[1].toLowerCase();
  const hostport = m[2];
  if (scheme === 'socks5h' || scheme === 'socks5') return ['--socks5-hostname', hostport];
  if (scheme === 'socks4a') return ['--socks4a', hostport];
  if (scheme === 'socks4') return ['--socks4', hostport];
  return ['-x', `${scheme}://${hostport}`];
}

/** curl exit codes that mean "the proxy failed", not "the site said no". */
const PROXY_EXIT_CODES = new Set([5, 6, 7, 28, 35, 56, 97]);

class Session {
  constructor(opts = {}) {
    this.ua = opts.ua || UA;
    this.proxy = opts.proxy || null;
    this.pool = opts.pool || null;
    this.proxyAttempts = opts.proxyAttempts || 4;
    this._proxyQueue = [];
    this._refilling = false;
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

  _buildArgs(url, o, proxy) {
    const args = ['-sS', '--compressed', '--http1.1', '-b', this.cookieFile, '-c', this.cookieFile];
    args.push('-A', this.ua);
    args.push('-D', '-'); // headers to stdout
    if (o.follow !== false) args.push('-L', '--max-redirs', '10');
    if (o.method) args.push('-X', o.method);
    if (o.timeout) args.push('--max-time', String(o.timeout));
    if (proxy) {
      // Free proxies are often dead-but-not-refusing, and curl's default connect
      // timeout is the OS one (~21s on Windows). Without this, rotating past
      // three dead proxies costs a minute before the run even starts.
      args.push('--connect-timeout', String(o.connectTimeout || 12));
    }
    args.push(...proxyArgs(proxy));

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
    return args;
  }

  /**
   * @param {string} url
   * @param {object} o {method, headers, body, follow:true, referer, dump, timeout}
   */
  request(url, o = {}) {
    const attempts = o.retries == null ? this.proxyAttempts : o.retries;
    let last;

    for (let i = 1; i <= attempts; i++) {
      try {
        return this._curlOnce(url, o, this.proxy);
      } catch (e) {
        last = e;
        if (!e.isProxyError || !this.proxy) throw e;
        this._log(`proxy ${this.proxy} failed (curl exit ${e.code}), rotating (${i}/${attempts})`);
        if (this.pool && this.pool.drop) this.pool.drop(this.proxy).catch(() => {});

        // Rotate from the pre-fetched queue. Rotation is synchronous by design:
        // execFileSync cannot await pool.take() mid-request.
        const next = this._proxyQueue.shift();
        if (!next) {
          // Deliberately NOT clearing this.proxy: falling back to a direct
          // connection here would silently leak the real IP, which is the one
          // thing the proxy exists to prevent. Fail loudly instead.
          const err = new Error(
            `every proxy died (last: ${this.proxy}, curl exit ${e.code}) and no spare is queued. ` +
            `Prime more proxies before the run (proxy.spare in config.json), or the pool ran dry.`
          );
          err.isProxyError = true;
          err.code = e.code;
          err.cause = last;
          throw err;
        }
        this.proxy = next;
        this._refillQueue();
      }
    }
    throw last;
  }

  _curlOnce(url, o, proxy) {
    let out;
    try {
      out = execFileSync('curl', this._buildArgs(url, o, proxy),
        { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', windowsHide: true });
    } catch (e) {
      if (e.stdout && e.stdout.length) {
        out = e.stdout;
      } else {
        const err = new Error(`curl failed for ${url}: ${e.message}`);
        err.code = e.status;
        err.isProxyError = PROXY_EXIT_CODES.has(e.status);
        throw err;
      }
    }
    return this._parse(out, o.dump);
  }

  _log(msg) {
    if (this.verbose) console.error('[http]', msg);
  }

  /**
   * Pre-fetch proxies so a mid-run rotation needs no await.
   *
   * One proxy is pinned for the whole run and only swapped if it actually dies:
   * a registration flow that changes IP between steps looks worse than one that
   * keeps a single address, and the pool's per-IP rate limits are per-account
   * anyway.
   */
  async primeProxies(n = 3) {
    if (!this.pool) return;
    while (this._proxyQueue.length < n) {
      const p = await this.pool.take();
      if (!p) break;
      this._proxyQueue.push(p);
    }
    if (!this.proxy) this.proxy = this._proxyQueue.shift() || null;
  }

  /** Top the queue back up in the background, without blocking the request. */
  _refillQueue() {
    if (!this.pool || this._refilling) return;
    this._refilling = true;
    this.primeProxies(3).catch(() => {}).finally(() => { this._refilling = false; });
  }

  /**
   * Return every proxy this session holds to the pool.
   *
   * The pool counts a taken proxy as in-use until it is released, so skipping
   * this leaks a slot per account and a batch of 10 exhausts a pool of 24.
   * Safe to call more than once, and safe when no pool is attached.
   */
  async releaseProxies() {
    if (!this.pool || !this.pool.release) return;
    const held = [this.proxy, ...this._proxyQueue].filter(Boolean);
    this.proxy = null;
    this._proxyQueue = [];
    for (const p of held) {
      try { await this.pool.release(p); } catch (_) {}
    }
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

module.exports = { Session, UA, proxyArgs };
