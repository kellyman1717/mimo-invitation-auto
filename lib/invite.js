'use strict';
/**
 * MiMo Desktop invite-apply form submission.
 *
 * From HAR entry 185:
 *   GET  /api/user/invite/check  -> {whitelisted, status}
 *   POST /api/user/invite/apply  -> {answers:[{key,question,answer}]}
 *   GET  /api/user/xiaomi/me/basic -> {userId, nickname}
 */
const { Session } = require('./http');

const MIMO_SERVER = 'https://mimo-server-sgp.xiaomimimo.com';

const QUESTIONS = {
  email: 'Email address',
  role: 'Which best describes you?',
  products: 'Which AI products have you used?',
  project: 'Describe something you have built with AI, or what you most want to build with MiMo Desktop',
  attachments: 'Upload files',
  expectations: 'Which MiMo Desktop capabilities are you most looking forward to?',
  source: 'How did you hear about MiMo Desktop?',
  locale: 'locale',
  consentAtMs: 'consentAtMs',
  agreementVersion: 'agreementVersion',
};

class MiMoInvite {
  constructor(sessionOrOpts = {}) {
    this.session = sessionOrOpts.session || new Session(sessionOrOpts);
  }

  _hdr() {
    return {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: 'https://mimo-ai.xiaomimimo.com',
      referer: 'https://mimo-ai.xiaomimimo.com/',
    };
  }

  me() {
    const r = this.session.request(`${MIMO_SERVER}/api/user/xiaomi/me/basic`, {
      headers: { accept: 'application/json', referer: 'https://mimo-ai.xiaomimimo.com/' },
    });
    return this._json(r);
  }

  check() {
    const r = this.session.request(`${MIMO_SERVER}/api/user/invite/check`, {
      headers: { accept: 'application/json', referer: 'https://mimo-ai.xiaomimimo.com/' },
    });
    return this._json(r);
  }

  /**
   * @param {object} answers key -> answer value (already in wire format)
   */
  apply(answers) {
    const payload = {
      answers: Object.keys(answers).map((k) => ({
        key: k,
        question: QUESTIONS[k] || k,
        answer: answers[k],
      })),
    };
    const r = this.session.request(`${MIMO_SERVER}/api/user/invite/apply`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: this._hdr(),
    });
    return this._json(r);
  }

  _json(r) {
    let j;
    try { j = JSON.parse(r.text); } catch (_) {
      throw new Error(`non-json (${r.status}): ${r.text.slice(0, 300)}`);
    }
    return j;
  }
}

/** Default survey answers, matching the HAR payload shape. */
function defaultAnswers(email, { project } = {}) {
  return {
    email,
    role: { id: 'developer', other: '' },
    products: {
      ids: ['chatgpt', 'claude', 'deepseek', 'kimi', 'qwen', 'claude-code', 'codex', 'workbuddy'],
      other: '',
    },
    project:
      project ||
      "I'm already build a platform that user can orchestrate an AI agent so they worked more efficient",
    attachments: [],
    expectations: { ids: ['code', 'prototype', 'local-files'], other: '' },
    source: { id: 'x', other: '' },
    locale: 'en-US',
    consentAtMs: Date.now(),
    agreementVersion: 'privacy@2026-08-18;terms@2026-08-18',
  };
}

module.exports = { MiMoInvite, defaultAnswers, QUESTIONS, MIMO_SERVER };
