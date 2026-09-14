'use strict';
/**
 * MiMo Desktop invite-apply form submission.
 *
 * From HAR entry 185:
 *   GET  /api/user/invite/check  -> {whitelisted, status}
 *   POST /api/user/invite/apply  -> {answers:[{key,question,answer}]}
 *   GET  /api/user/xiaomi/me/basic -> {userId, nickname}
 */
const crypto = require('crypto');
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

/**
 * Randomised `project` essay.
 *
 * The form is read by a human, so shuffling bare words would only produce
 * gibberish. Instead each slot in a template is filled from a dictionary of
 * interchangeable phrases — the sentence stays grammatical whatever gets picked,
 * and every submission still reads differently.
 *
 * Slots must be grammatically equivalent within a pool, and each template may
 * only place a slot where that pool's shape fits (see the templates below).
 * Overridden by `invite.project` in config.json.
 */
const WORDS = {
  build: [
    'an agent orchestration platform',
    'a RAG pipeline over internal docs',
    'a CLI that refactors legacy code',
    'a local-first notes app with an AI assistant',
    'a scraper that turns PDFs into summaries',
    'a support bot wired into our ticketing system',
    'an internal tool that drafts release notes',
    'a browser extension that cleans up messy pages',
    'a Slack bot that answers onboarding questions',
    'a log triage tool for on-call shifts',
    'a spreadsheet replacement for our ops team',
    'a code review bot that flags risky diffs',
    'a translation layer between two internal APIs',
    'a test generator that writes the boring cases',
    'a dashboard that explains why a metric moved',
    'a migration script that fixes schema drift',
    'a search box over our old support threads',
    'a scheduling agent that books rooms and calls',
    'a document classifier for incoming contracts',
    'a data cleaning pipeline for supplier feeds',
    'a meeting summariser that assigns action items',
    'a prompt library our whole team can share',
    'a local model runner for offline work',
    'a crawler that keeps our price table fresh',
    'an alerting rule engine that cuts the noise',
    'a form filler for repetitive government paperwork',
    'a changelog generator wired into CI',
    'a knowledge base that updates itself from chat',
    'a job queue with retries and dead letter handling',
    'a diff summariser for large generated files',
    'a screenshot-to-ticket pipeline for QA',
    'an invoice parser that handles messy scans',
    'a multi-agent setup where one plans and one codes',
    'a feedback clustering tool for support tickets',
    'a config validator that catches typos before deploy',
    'a batch rewriter for legacy documentation',
    'a sandbox runner so agents can execute code safely',
    'a retrieval layer that ranks by recency and trust',
    'a voice memo transcriber for field technicians',
    'a recommendation feed for our internal wiki',
    'a spreadsheet-to-API bridge for finance',
  ],
  domain: [
    'customer support',
    'internal tooling',
    'logistics',
    'data engineering',
    'developer tooling',
    'finance reporting',
    'e-commerce ops',
    'healthcare admin',
    'education',
    'manufacturing',
    'legal research',
    'recruiting',
    'content operations',
    'security',
    'analytics',
    'insurance claims',
    'field service',
    'supply chain',
    'media production',
    'real estate',
    'nonprofit work',
    'public sector',
    'gaming',
    'mobile apps',
    'infrastructure',
    'quality assurance',
    'customer onboarding',
    'pricing and billing',
    'fraud detection',
    'inventory management',
    'clinical scheduling',
    'academic research',
    'localisation',
    'community moderation',
    'warehouse automation',
    'energy monitoring',
    'travel booking',
    'restaurant operations',
    'fleet tracking',
    'subscription management',
  ],
  stack: [
    'Python and FastAPI',
    'TypeScript and Node',
    'Go',
    'Rust',
    'a Next.js frontend',
    'plain Python scripts',
    'Cloudflare Workers',
    'Django and Postgres',
    'a small Flask app',
    'Java and Spring',
    'Ruby on Rails',
    'Elixir and Phoenix',
    'C# and .NET',
    'Bun and SQLite',
    'a serverless setup on AWS',
    'Kubernetes and Helm',
    'a Vue frontend with a Go backend',
    'SvelteKit',
    'a Postgres extension',
    'Redis and a worker pool',
    'a monorepo with Turborepo',
    'Gradio',
    'a Telegram bot framework',
    'Streamlit',
    'Deno and Deno Deploy',
    'a Docker compose stack',
    'Terraform and a few lambdas',
    'React Native',
    'a Jupyter notebook that got out of hand',
    'shell scripts and cron',
    'Laravel',
    'a Rust CLI with a Python sidecar',
    'an Electron app',
    'SQLite and a tiny HTTP layer',
    'Nix',
  ],
  model: [
    'Claude',
    'GPT',
    'DeepSeek',
    'Qwen',
    'Kimi',
    'a mix of models',
    'whichever model is cheapest that week',
    'a local Llama',
    'Mistral',
    'Gemini',
    'a fine-tuned small model',
    'whatever fits in VRAM',
    'two models voting on the answer',
    'a two-tier setup: cheap drafts, a strong reviewer',
    'a model behind our own gateway',
  ],
  task: [
    'summarising tickets',
    'generating boilerplate',
    'reviewing pull requests',
    'classifying incoming mail',
    'writing SQL',
    'cleaning up messy CSV exports',
    'drafting first-pass documentation',
    'extracting fields from PDFs',
    'tagging support conversations',
    'rewriting error messages for humans',
    'suggesting test cases',
    'translating release notes',
    'grouping duplicate bug reports',
    'converting specs into tickets',
    'checking configs for mistakes',
    'naming things',
    'writing commit messages that make sense',
    'explaining stack traces',
    'filling in structured forms from free text',
    'summarising long email threads',
    'finding the relevant chunk of a big doc',
    'spotting outliers in a table',
    'drafting replies to routine questions',
    'mapping messy columns to a schema',
    'generating fixtures for tests',
    'reviewing copy for tone',
    'answering questions about our internal API',
    'turning screenshots into issue reports',
    'diffing two versions of a contract',
    'turning raw logs into a status summary',
    'writing the first draft of a migration plan',
    'labelling data at scale',
    'cleaning up user-submitted text',
    'suggesting better names for variables',
    'picking the right tool for a job',
  ],
  pain: [
    'context switching',
    'manual copy-paste between tools',
    'waiting on long reports',
    'rewriting the same glue code',
    'hunting through old threads for answers',
    'keeping configs in sync',
    'hand-checking data before a release',
    'writing the same boilerplate for new services',
    'chasing down stale documentation',
    'merging duplicate tickets',
    'reformatting data by hand',
    'waiting for a build to tell me what broke',
    'copying numbers between two systems',
    'explaining the same thing to new hires',
    'sifting through noisy alerts',
    'renaming things across a dozen files',
    'writing the same tests over and over',
    'digging through logs to find one request',
    'keeping three environments aligned',
    'turning a spreadsheet into a working service',
    're-reading the same spec for the tenth time',
    'fixing formatting the linter should catch',
    'manually tagging hundreds of rows',
    'tracking down who owns a service',
    'updating the same value in five places',
    'rebuilding the same status report',
    'splitting one long task into smaller tickets',
    'checking whether a dependency is safe to bump',
    'explaining a metric to someone in another team',
    'reconciling two sources that should agree',
    'writing release notes nobody wants to write',
    'tracking time in a tool nobody likes',
    'pasting the same prompt into a fresh chat',
    'reproducing a bug that only happens in prod',
    'formatting data for a one-off analysis',
  ],
  // Durations only — every template appends "a week", so entries must not carry
  // their own time unit: "most of a day a week" and "the better part of a
  // Friday a week" both read wrong. Keep to hours and vaguer quantities.
  amount: [
    'a few hours',
    'two hours',
    'a full afternoon',
    'an hour',
    'twenty minutes',
    'a whole afternoon',
    'a couple of evenings',
    'ten minutes',
    'an unreasonable amount of time',
    'a solid block of time',
    'more time than the work itself',
    'a few minutes',
    'a good hour',
    'a long stretch of time',
    'an hour or two',
    'the bulk of an afternoon',
    'more time than I can bill for',
    'a couple of hours',
  ],
  goal: [
    'read our whole repo and answer questions about it',
    'run a task end to end without me babysitting it',
    'switch models when one gets stuck',
    'keep working with no network',
    'pick up a ticket and open a draft PR',
    'remember what I decided last week',
    'take a rough idea and turn it into a working prototype',
    'ask a clarifying question instead of guessing',
    'show me the diff before it changes anything',
    'recover on its own when a step fails',
    'explain why it picked one approach over another',
    'hand off to a human when it is unsure',
    'keep a running log of what it tried',
    'work from our own docs instead of the open internet',
    'run the same task twice and get the same answer',
    'be told a rule once and remember it',
    'break a big job into steps I can review',
    'call our internal tools without a custom wrapper',
    'tell me what it needs before it starts',
    'stop before it spends real money',
    'learn from the corrections I give it',
    'keep its context across a long session',
    'read a screenshot and act on it',
    'write the test before the fix',
    'notice when it is going in circles',
    'hand me a summary I can forward to my manager',
    'work from a spec and ask about the gaps',
    'try a second approach before giving up',
    'tell the difference between our staging and prod data',
    'stay inside the permissions we gave it',
  ],
};

// {slot} placeholders are substituted from WORDS; keep each slot in a position
// where every phrase in its pool reads naturally. `{amount}` is a bare duration,
// so it always needs a cadence word next to it.
const TEMPLATES = [
  'I built {build} in {domain}, on {stack}. It calls {model} for {task}. The part I care about most is that it saves {amount} of {pain} every week.',
  'Most of my work is {domain}. I put together {build} on {stack} and wired {model} into it for {task}.',
  'I want to build {build} in {domain}. The hard part is {pain} — I spend {amount} a week on it, and I would rather have an agent that can {goal}.',
  'The main thing I have been working on is {build}, mostly in the {domain} space. It runs on {stack} and leans on {model} for {task}. Automating {pain} is the next thing I want to tackle.',
  'Day job is {domain}. I built {build} on {stack}, and it leans on {model} for {task}.',
  'What I most want to build is {build} in {domain}. Today {pain} eats {amount} a week, and I have not found a tool that can {goal}.',
  'I have shipped {build} on {stack}. It handles {domain} and uses {model} for {task}. What is still manual is {pain}.',
  'I work on {domain}. Mostly I build {build}, on {stack}, with {model} for {task}.',
  'My last project was {build} in {domain}. We used {model} for {task} and ran the whole thing on {stack}. It cut {pain} down to almost nothing.',
  'I am building {build} on {stack}. The goal is to get {model} to {goal}.',
  'Spent the last few months on {build} in {domain}. It uses {model} for {task}, and {stack} does the rest. I keep losing {amount} a week to {pain}.',
  'Right now I am prototyping {build}. It is {domain} work, {stack} underneath, and {model} for {task}. Once it can {goal} I will call it done.',
  'Half my job is {domain}. I wrote {build} on {stack} to handle {task} with {model}, mainly because {pain} was costing me {amount} a week.',
  'The thing I keep coming back to is {build}. It is {stack} on the back end, {model} for {task}, and a clear idea of what {domain} teams actually need.',
];

function pick(list) {
  return list[crypto.randomInt(list.length)];
}

/** Fills one random template from the dictionaries above. */
function randomProject() {
  return pick(TEMPLATES).replace(/\{(\w+)\}/g, (_, slot) => {
    const pool = WORDS[slot];
    if (!pool) throw new Error(`no word pool for slot "${slot}"`);
    return pick(pool);
  });
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
    // Blank means "auto-generate" — a whitespace-only override would otherwise
    // submit an empty answer to the form.
    project: (typeof project === 'string' && project.trim()) || randomProject(),
    attachments: [],
    expectations: { ids: ['code', 'prototype', 'local-files'], other: '' },
    source: { id: 'x', other: '' },
    locale: 'en-US',
    consentAtMs: Date.now(),
    agreementVersion: 'privacy@2026-08-18;terms@2026-08-18',
  };
}

// Self-check: templates resolve, pools are big enough, output varies.
// Run with `node lib/invite.js`.
if (require.main === module) {
  const assert = require('assert');

  for (const t of TEMPLATES) {
    const filled = t.replace(/\{(\w+)\}/g, (_, slot) => {
      assert.ok(WORDS[slot], `template uses unknown slot "${slot}"`);
      return pick(WORDS[slot]);
    });
    assert.ok(!filled.includes('{'), `unfilled slot left in: ${filled}`);
  }

  // `{amount}` holds a bare duration, so the template must supply the cadence.
  for (const t of TEMPLATES) {
    if (t.includes('{amount}')) {
      assert.ok(/(a week|every week)/.test(t), `{amount} used with no weekly cadence: ${t}`);
    }
  }
  // Every template appends "a week", so an entry may not carry a time unit of
  // its own: "most of a day a week" reads as a stutter.
  for (const a of WORDS.amount) {
    assert.ok(
      !/\b(every|each|per|day|week|month|morning|evening|night|Monday|Friday|sprint)\b/i.test(a),
      `amount entry carries its own time unit: "${a}"`
    );
  }

  // The same applies to any pool dropped next to a weekly cadence: "rebuilding
  // the same report every Monday" + "every week" reads as a stutter.
  for (const slot of ['pain', 'task', 'goal', 'build', 'domain', 'stack']) {
    for (const phrase of WORDS[slot]) {
      assert.ok(
        !/\b(every|each|per)\b|\bweekly\b|\bdaily\b/i.test(phrase),
        `"${slot}" entry carries its own cadence: "${phrase}"`
      );
    }
  }

  for (const [slot, pool] of Object.entries(WORDS)) {
    assert.ok(pool.length >= 15, `pool "${slot}" too small (${pool.length})`);
    assert.strictEqual(new Set(pool).size, pool.length, `pool "${slot}" has duplicates`);
  }

  // `task` and `pain` are gerunds ("summarising tickets"), so a template must
  // not place an action verb directly before one — "handling explaining stack
  // traces" is broken even though the pool entry is fine alone. This only
  // catches the verb-immediately-before case; the general grammar problem is
  // not mechanically decidable, so sample review covers the rest.
  const ACTION_VERB_BEFORE = /\b(handling|does|doing|uses?|using|makes?|making)\s+\{(task|pain)\}/i;
  for (const t of TEMPLATES) {
    assert.ok(
      !ACTION_VERB_BEFORE.test(t),
      `action verb placed directly before a gerund slot: ${t}`
    );
  }

  // An entry that *ends* in a preposition collides with one the template adds:
  // "a strong one for review" + " for reviewing copy" -> "for review for reviewing".
  // Check every slot pairing the templates actually produce, in both directions.
  for (const t of TEMPLATES) {
    const slots = [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    for (let i = 0; i + 1 < slots.length; i++) {
      const [a, b] = [slots[i], slots[i + 1]];
      if (!WORDS[a] || !WORDS[b]) continue;
      const between = t.slice(t.indexOf(`{${a}}`) + a.length + 2, t.indexOf(`{${b}}`));
      const tail = between.trim();
      if (!/^(for|to|with|in|on|of|at|by|from)$/i.test(tail)) continue;
      for (const pa of WORDS[a]) {
        assert.ok(
          !new RegExp(`\\b${tail}$`, 'i').test(pa),
          `"{${a}} ${tail} {${b}}" doubles the preposition: "${pa}"`
        );
      }
    }
  }

  // Pools are lowercase, so no template may open with a slot, or place one right
  // after a sentence-ending period — either would start a sentence lowercase.
  for (const t of TEMPLATES) {
    assert.ok(!t.startsWith('{'), `template starts with a slot (lowercase): ${t}`);
    assert.ok(!/[.!?]\s+\{\w+\}/.test(t), `slot follows sentence end (lowercase): ${t}`);
  }
  for (const t of TEMPLATES) {
    const filled = t.replace(/\{(\w+)\}/g, (_, s) => pick(WORDS[s]));
    assert.ok(/^[A-Z]/.test(filled), `sentence starts lowercase: ${filled}`);
    assert.ok(
      !/[.!?]\s+[a-z]/.test(filled.replace(/\b(i|a)\b/g, '$1')),
      `sentence starts lowercase mid-text: ${filled}`
    );
  }

  // A pool entry may carry its own preposition ("a tool for on-call shifts"), so
  // the slot must never be preceded by a duplicate one. Check every pairing.
  for (const t of TEMPLATES) {
    for (const m of t.matchAll(/(\w+) \{(\w+)\}/g)) {
      const [, prep, slot] = m;
      for (const phrase of WORDS[slot]) {
        assert.ok(
          !new RegExp(`^${prep}\\b`, 'i').test(phrase),
          `template says "${prep} {${slot}}" but entry starts with it: "${phrase}"`
        );
      }
    }
  }

  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(randomProject());
  assert.ok(seen.size > 490, `expected varied output, got ${seen.size}/500 unique`);
  const combos = TEMPLATES.length * Object.values(WORDS).reduce((n, p) => n * p.length, 1);
  console.log(`${TEMPLATES.length} templates, pools ${Object.values(WORDS).map((p) => p.length).join('/')}`);
  console.log(`~${combos.toExponential(1)} combinations, ${seen.size}/500 unique samples\n`);
  for (const s of [...seen].slice(0, 3)) console.log('-', s, '\n');
}

module.exports = { MiMoInvite, defaultAnswers, QUESTIONS, MIMO_SERVER, randomProject, WORDS, TEMPLATES };
