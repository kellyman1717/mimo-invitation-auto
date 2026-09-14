'use strict';
/**
 * Bridge to the Python proxy pool (D:\Project\unikey-auto\proxypool.py).
 *
 * proxypool.py is the source of truth for scraping/validating/banning free
 * proxies — reimplementing that in Node would be a second, worse copy. So we
 * run it as a long-lived child process and talk to it over stdin/stdout:
 *
 *   node  -> python : "take" | "drop <proxy>" | "stats" | "quit"
 *   python -> node  : "<proxy>" | "none"
 *
 * The pool is warmed once at startup (scraping + validating takes ~10s) and the
 * child stays alive so every later take() is instant.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Where proxypool.py lives. Overridable so this repo stays portable.
const POOL_PATH =
  process.env.PROXYPOOL_PATH || 'D:\\Project\\unikey-auto\\proxypool.py';

// Target used to validate a proxy. Xiaomi's own config endpoint is the right
// choice: a proxy that cannot reach the registration host is useless here,
// however fast it is against a generic echo service.
const DEFAULT_TARGET = 'https://global.account.xiaomi.com/pass2/config';

// Config travels through the environment, not argv: spawn() re-quotes argv on
// Windows and a URL with '?' or '&' arrives mangled, so argv parsing is a trap.
const CHILD_SOURCE = `
import sys, os
sys.path.insert(0, os.environ["PP_DIR"])
from proxypool import ProxyPool, ProxyUnavailable

def log(m):
    print("LOG " + str(m), file=sys.stderr, flush=True)

pool = ProxyPool(
    target=os.environ["PP_TARGET"],
    want=int(os.environ["PP_WANT"]),
    min_pool=int(os.environ["PP_MIN"]),
    logger=log,
)
try:
    pool.warm()
except ProxyUnavailable as e:
    print("FATAL " + str(e), file=sys.stderr, flush=True)
    sys.exit(3)

print("READY", flush=True)
for line in sys.stdin:
    cmd = line.strip()
    if not cmd:
        continue
    if cmd == "quit":
        break
    if cmd == "take":
        try:
            print(pool.take(), flush=True)
        except ProxyUnavailable:
            print("none", flush=True)
    elif cmd == "stats":
        print(pool.stats(), flush=True)
    elif cmd.startswith("release "):
        pool.release(cmd[8:].strip())
        print("ok", flush=True)
    elif cmd.startswith("drop "):
        pool.drop(cmd[5:].strip(), "failed_use")
        print("ok", flush=True)
`;

class ProxyBridge {
  /**
   * @param {object} o {want, minPool, target, verbose, timeoutMs}
   */
  constructor(o = {}) {
    this.path = o.path || POOL_PATH;
    this.target = o.target || DEFAULT_TARGET;
    this.want = o.want || 8;
    this.minPool = o.minPool || 3;
    this.verbose = !!o.verbose;
    this.child = null;
    this.pending = [];
    this.ready = false;
    this.failed = null;
  }

  get available() {
    return fs.existsSync(this.path);
  }

  /** Spawn the pool and wait until it reports READY (or fails). */
  start(timeoutMs = 180000) {
    if (!this.available) {
      throw new Error(`proxypool.py not found at ${this.path} (set PROXYPOOL_PATH)`);
    }
    if (this.child) return Promise.resolve(this);

    this.child = spawn('python', ['-c', CHILD_SOURCE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: Object.assign({}, process.env, {
        PP_DIR: path.dirname(this.path),
        PP_TARGET: this.target,
        PP_WANT: String(this.want),
        PP_MIN: String(this.minPool),
      }),
    });

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', (line) => {
      const s = line.trim();
      if (s === 'READY') {
        this.ready = true;
        return;
      }
      const waiter = this.pending.shift();
      if (waiter) waiter.resolve(s);
    });

    readline.createInterface({ input: this.child.stderr }).on('line', (l) => {
      const s = l.trim();
      if (!s) return;
      if (s.startsWith('FATAL')) this.failed = s;
      if (this.verbose || s.startsWith('FATAL')) console.error('[proxy]', s);
    });

    this.child.on('exit', (code) => {
      this.child = null;
      this.ready = false;
      const err = this.failed || `proxy pool exited (code ${code})`;
      while (this.pending.length) this.pending.shift().reject(new Error(err));
    });

    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        if (this.ready) { clearInterval(tick); resolve(this); return; }
        if (this.failed || !this.child) { clearInterval(tick); reject(new Error(this.failed || 'proxy pool died')); return; }
        if (Date.now() - t0 > timeoutMs) {
          clearInterval(tick);
          this.stop();
          reject(new Error(`proxy pool warm-up timed out after ${timeoutMs}ms`));
        }
      }, 200);
    });
  }

  _send(cmd) {
    if (!this.child || !this.ready) return Promise.reject(new Error('proxy pool not running'));
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(cmd + '\n');
    });
  }

  /** @returns {Promise<string|null>} validated proxy, or null if none available */
  async take() {
    const r = await this._send('take');
    return r === 'none' ? null : r;
  }

  /** Report a proxy that failed in real use, so the pool bans it. */
  async drop(proxy) {
    if (!proxy) return;
    try { await this._send('drop ' + proxy); } catch (_) {}
  }

  /**
   * Hand a proxy back so the pool stops counting it as in-use.
   *
   * Without this, every take() permanently consumes a slot and the pool runs
   * dry after `want` accounts even though nothing is actually using them.
   */
  async release(proxy) {
    if (!proxy) return;
    try { await this._send('release ' + proxy); } catch (_) {}
  }

  stop() {
    if (!this.child) return;
    try { this.child.stdin.write('quit\n'); } catch (_) {}
    try { this.child.kill(); } catch (_) {}
    this.child = null;
    this.ready = false;
  }
}

module.exports = { ProxyBridge, DEFAULT_TARGET, POOL_PATH };
