'use strict';
/**
 * Pluggable image-captcha solver for Xiaomi's `pass/getCode` challenge.
 *
 * Supported providers (pick with CAPTCHA_PROVIDER or {provider}):
 *   - capsolver  : https://api.capsolver.com
 *   - 2captcha   : https://2captcha.com
 *   - anticaptcha: https://api.anti-captcha.com
 *   - manual     : writes the image to disk and reads the answer from stdin
 *
 * The Xiaomi code challenge is a 5-char alphanumeric image (see HAR entry 149),
 * so the task type is a plain "ImageToTextTask" with no case sensitivity flag —
 * but we submit with `case=false` because Xiaomi accepts either case.
 */

const PROVIDERS = {
  local: {},
  capsolver: {
    create: 'https://api.capsolver.com/createTask',
    result: 'https://api.capsolver.com/getTaskResult',
    keyField: 'clientKey',
  },
  '2captcha': {
    create: 'https://2captcha.com/in.php',
    result: 'https://2captcha.com/res.php',
    keyField: 'key',
  },
  anticaptcha: {
    create: 'https://api.anti-captcha.com/createTask',
    result: 'https://api.anti-captcha.com/getTaskResult',
    keyField: 'clientKey',
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function providerFromEnv() {
  if (process.env.CAPSOLVER_API_KEY) return { provider: 'capsolver', apiKey: process.env.CAPSOLVER_API_KEY };
  if (process.env.TWOCAPTCHA_API_KEY) return { provider: '2captcha', apiKey: process.env.TWOCAPTCHA_API_KEY };
  if (process.env.ANTICAPTCHA_API_KEY) return { provider: 'anticaptcha', apiKey: process.env.ANTICAPTCHA_API_KEY };
  if (process.env.CAPTCHA_PROVIDER) return { provider: process.env.CAPTCHA_PROVIDER, apiKey: null };
  return { provider: 'manual', apiKey: null };
}

/** POST JSON, returns parsed body. Node 22 has global fetch. */
async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch (_) { return { raw: text }; }
}

async function getJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  try { return JSON.parse(text); } catch (_) { return { raw: text }; }
}

/**
 * @param {Buffer} imageBuffer raw captcha image bytes
 * @param {object} [o] {provider, apiKey, timeoutMs}
 * @returns {Promise<string>} solved text
 */
async function solveImage(imageBuffer, o = {}) {
  const env = providerFromEnv();
  const provider = o.provider || env.provider;
  const apiKey = o.apiKey || env.apiKey;

  if (provider === 'manual') return solveManual(imageBuffer);
  if (provider === 'local') return solveLocal(imageBuffer);

  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`unknown captcha provider: ${provider}`);
  if (!apiKey) throw new Error(`missing API key for provider "${provider}"`);

  const b64 = imageBuffer.toString('base64');

  if (provider === '2captcha') {
    return solve2Captcha(cfg, apiKey, b64, o);
  }
  if (provider === 'capsolver') {
    return solveCapsolverStyle(cfg, apiKey, b64, o, 'capsolver');
  }
  return solveCapsolverStyle(cfg, apiKey, b64, o, 'anticaptcha');
}

async function solve2Captcha(cfg, apiKey, b64, o) {
  const qs = new URLSearchParams({
    [cfg.keyField]: apiKey,
    method: 'base64',
    body: b64,
    json: '1',
    numeric: '0',
    min_len: '4',
    max_len: '8',
  });
  const inRes = await getJson(`${cfg.create}?${qs.toString()}`);
  if (inRes.status !== 1) throw new Error(`2captcha in.php error: ${JSON.stringify(inRes)}`);
  const id = inRes.request;

  const deadline = Date.now() + (o.timeoutMs || 120000);
  while (Date.now() < deadline) {
    await sleep(3000);
    const r = await getJson(`${cfg.result}?${new URLSearchParams({ [cfg.keyField]: apiKey, action: 'get', id, json: '1' })}`);
    if (r.status === 1) return r.request;
    if (r.request !== 'CAPCHA_NOT_READY') throw new Error(`2captcha error: ${JSON.stringify(r)}`);
  }
  throw new Error('2captcha timeout');
}

async function solveCapsolverStyle(cfg, apiKey, b64, o, kind) {
  const task =
    kind === 'capsolver'
      ? { type: 'ImageToTextTask', body: b64 }
      : { type: 'ImageToTextTask', body: b64 };

  const created = await postJson(cfg.create, { [cfg.keyField]: apiKey, task });
  if (created.errorId && created.errorId !== 0) throw new Error(`${kind} createTask: ${JSON.stringify(created)}`);

  // Some providers (and CapSolver's fast path) return the solution inline.
  if (created.status === 'ready' && created.solution) {
    const text = created.solution.text || (created.solution.answers || [])[0];
    if (text) return String(text);
  }

  const taskId = created.taskId;
  if (!taskId) throw new Error(`${kind} createTask returned no taskId: ${JSON.stringify(created)}`);

  const deadline = Date.now() + (o.timeoutMs || 120000);
  while (Date.now() < deadline) {
    await sleep(2000);
    const r = await postJson(cfg.result, { [cfg.keyField]: apiKey, taskId });
    if (r.errorId && r.errorId !== 0) throw new Error(`${kind} getTaskResult: ${JSON.stringify(r)}`);
    if (r.status === 'ready' && r.solution) {
      const text = r.solution.text || (r.solution.answers || [])[0];
      if (text) return String(text);
    }
  }
  throw new Error(`${kind} timeout`);
}

/**
 * Local OCR via tesseract.js — no API key, no network cost, but noticeably less
 * accurate than a paid solver on Xiaomi's noisy 5-char images. Good enough as a
 * default/fallback; switch to capsolver/2captcha for volume.
 */
async function solveLocal(imageBuffer) {
  const tesseract = require('tesseract.js');
  const { data } = await tesseract.recognize(imageBuffer, 'eng', {
    // Restrict to the character set Xiaomi actually uses: digits + lowercase letters.
    tessedit_char_whitelist: '0123456789abcdefghijklmnopqrstuvwxyz',
  });
  const text = (data.text || '').replace(/[^0-9a-z]/gi, '').toLowerCase();
  if (text.length < 4 || text.length > 8) {
    throw new Error(`local OCR produced implausible code: ${JSON.stringify(data.text)} -> "${text}"`);
  }
  return text;
}

async function solveManual(imageBuffer) {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(process.cwd(), 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `captcha-${Date.now()}.jpg`);
  fs.writeFileSync(file, imageBuffer);

  // Headless escape hatch: drop the answer in tmp/icode.txt instead of typing it.
  const answerFile = process.env.CAPTCHA_ANSWER_FILE || path.join(dir, 'icode.txt');
  if (fs.existsSync(answerFile)) {
    const code = fs.readFileSync(answerFile, 'utf8').trim();
    if (code) {
      fs.unlinkSync(answerFile);
      console.log(`[captcha] read "${code}" from ${answerFile}`);
      return code;
    }
  }

  console.log(`\n[captcha] image saved to: ${file}`);
  process.stdout.write('[captcha] enter the code: ');
  return new Promise((resolve) => {
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      if (buf.includes('\n')) {
        process.stdin.off('data', onData);
        process.stdin.pause();
        resolve(buf.trim());
      }
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

module.exports = { solveImage, PROVIDERS, providerFromEnv };
