'use strict';
/**
 * Re-implementation of Xiaomi mcfe--mi-account `crypto.xxxx.chunk.js` (encryptAes).
 *
 * Reference implementation (from the HAR-traced bundle):
 *
 *   const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*'
 *   const rand  = randomString(16)            // AES key + IV seed, 16 chars
 *   const rsa   = new JSEncrypt()
 *   rsa.setPublicKey(PROD_PUBLIC_KEY)
 *   const a = rsa.encrypt(btoa(rand))         // base64(btoa(rand)) encrypted with RSA
 *   const iv     = Utf8.parse('0102030405060708')
 *   const key    = Utf8.parse(rand)
 *   const B      = btoa(Object.keys(params).join(','))
 *   for (const k of Object.keys(params)) {
 *     encrypted[k] = AES.encrypt(params[k], key, { iv, padding: Pkcs7 }).toString()
 *   }
 *   return { EUI: `${a}.${B}`, encryptedParams: encrypted }
 *
 * The `EUI` header is what makes the server able to decrypt: `a` is the RSA-wrapped
 * AES key and `B` tells it which fields (and in what order) were encrypted.
 */
const crypto = require('crypto');
const CryptoJS = require('crypto-js');

const PROD_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCYEVrK/4Mahiv0pUJgTybx4J9P5dUT/Y0PuwMbk+gMU+jrZnBiXGv6/hCH1avIhoBcE535F8nJQQN3UavZdFkYidsoXuEnat3+eVTp3FslyhRwIBDF09v4vDhRtxFOT+R7uH7h/mzmyA2/+lfIMWGIrffXprYizbV76+YQKhoqFQIDAQAB
-----END PUBLIC KEY-----`;

const PREVIEW_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC0gABHEoaFAcUPlaqKFn3mOOdQ7m5SIINJ0+dLo6hq4AcGAJKnYP+uM1Ge0++8SVxPBC2H+AYBiaeYC0UC5El9fAdGRWjRt2QdDqY0GeB3iPoEAiNvTPgcjKXjt7++fb0CQ2yY9My13py2glTTENCEhD64bjW8n1/9zUrq5XJv7wIDAQAB
-----END PUBLIC KEY-----`;

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
const IV = '0102030405060708';

function randomString(n) {
  let out = '';
  const buf = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) out += CHARS[buf[i] % CHARS.length];
  return out;
}

/**
 * Encrypts each value in `params` with AES-256-CBC (key = random 16-char string,
 * fixed IV) and RSA-wraps the key for the `eui` header.
 *
 * Note: JSEncrypt (jsencrypt's default) uses RSA/ECB/PKCS1Padding — equivalent to
 * node's crypto.publicEncrypt with padding RSA_PKCS1_PADDING.
 *
 * @param {Record<string,string>} params plaintext values, insertion order matters
 * @param {{preview?: boolean}} [opts]
 * @returns {{EUI: string, encryptedParams: Record<string,string>}}
 */
function encryptAes(params, opts = {}) {
  const rand = randomString(16);
  const pubkey = opts.preview ? PREVIEW_PUBLIC_KEY : PROD_PUBLIC_KEY;

  const wrappedKey = crypto.publicEncrypt(
    { key: pubkey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(rand, 'utf8').toString('base64')
  ).toString('base64');

  const fieldList = Buffer.from(Object.keys(params).join(','), 'utf8').toString('base64');

  const key = CryptoJS.enc.Utf8.parse(rand);
  const iv = CryptoJS.enc.Utf8.parse(IV);

  const encryptedParams = {};
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (v === undefined || v === null) continue;
    encryptedParams[k] = CryptoJS.AES.encrypt(String(v), key, {
      iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    }).toString(); // OpenSSL-formatted base64
  }

  return { EUI: `${wrappedKey}.${fieldList}`, encryptedParams };
}

module.exports = { encryptAes, PROD_PUBLIC_KEY, randomString, IV };
