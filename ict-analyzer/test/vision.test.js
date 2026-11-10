'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { INSTRUMENTS } = require('../lib/instruments');
const { loadDemo } = require('../lib/data');
const { analyze, RR_TARGETS } = require('../lib/analyze');
const { analyzeImages, buildResult, callVision, extractJson, buildPrompt, PROVIDERS } = require('../lib/vision');
const { sessionInfo } = require('../lib/time');

const NOW = Date.parse('2026-11-10T15:15:00Z') / 1000; // 10:15 New York, AM killzone
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const calmNews = { calendarOk: true, headlinesOk: true, events: [], headlines: [], nextEvent: null, sentiment: { score: 0, label: 'Neutral / mixed', method: 'test' } };

/** What a good model would return for a clean bullish raid → shift → FVG on gold. */
function longRead(over = {}) {
  return {
    readable: true, problems: '',
    chart: { instrument: 'MGC1!', timeframes: ['5'], last_price: 4090, visible_high: 4120, visible_low: 4060, period: '10 Nov' },
    swings: [{ type: 'high', price: 4110 }, { type: 'low', price: 4072 }, { type: 'high', price: 4086 }, { type: 'low', price: 4064 }, { type: 'high', price: 4096 }],
    indicators: [{ name: 'EMA 20', reading: 'price above', implication: 'bullish' }, { name: 'RSI 14', reading: '55', implication: 'neutral' }],
    candles: 'Strong green displacement off the low.',
    structure: { trend: 'bullish', events: [{ type: 'MSS', direction: 'bullish', level: 4086, when: '09:40' }] },
    liquidity: { above: [{ label: 'Equal highs', price: 4110 }, { label: 'Session high', price: 4118 }], below: [{ label: 'Old low', price: 4064 }], swept: [{ label: 'Old low', price: 4072, when: '09:30' }] },
    pd_arrays: [{ type: 'FVG', direction: 'bullish', low: 4074, high: 4078, note: '' }],
    dealing_range: { low: 4064, high: 4110 },
    bias: { direction: 'bullish', draw: 'equal highs 4110', why: 'raid of the low then displacement up' },
    setup: {
      direction: 'long', state: 'pending', model: 'ICT 2022', timeframe: '5m', raid: { label: 'Old low', price: 4064 }, shift_level: 4086,
      leg: { from: 4064, to: 4096 }, entry: 4074, entry_array: 'FVG', stop: 4062, stop_reason: 'below the raid low',
      target_liquidity: { label: 'Equal highs', price: 4110 }, wait_for: 'a retrace into 4074–4078',
    },
    scores: { htf: { pts: 12, why: 'x' }, sweep: { pts: 12, why: 'x' }, mss: { pts: 12, why: 'x' }, array: { pts: 8, why: 'x' }, open: { pts: 3.5, why: 'x' }, h1: { pts: 3, why: 'x' } },
    summary: 'Bullish after a raid.', confidence: 'high', ...over,
  };
}
const build = (raw, extra = {}) => buildResult(raw, { inst: INSTRUMENTS.MGC, now: NOW, news: calmNews, engine: null, modelName: 'test', count: 1, ...extra });

test('model replies are parsed even when wrapped or slightly broken', () => {
  assert.deepEqual(extractJson('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a": [1, 2,], "b": {"c": 3,},} thanks'), { a: [1, 2], b: { c: 3 } });
  assert.throws(() => extractJson('no json here'), /did not return an analysis/);
  assert.throws(() => extractJson('{"a": '), /did not return|cut off/);
});

test('the prompt carries the time, the market and the score maxima', () => {
  const p = buildPrompt({ inst: INSTRUMENTS.MNQ, session: sessionInfo(NOW), notes: 'EMA 20', count: 2, context: ['Feed last price 27,900.00'], news: calmNews });
  assert.match(p, /Micro E-mini Nasdaq-100 \(MNQ\)/);
  assert.match(p, /10:15 New York/);
  assert.match(p, /TRADER'S NOTE: EMA 20/);
  assert.match(p, /REFERENCE DATA/);
  assert.match(p, /max 16/);
  assert.match(p, /Do NOT give take-profit prices/);
});

test('a clean long read becomes a LONG with exact 1.5R / 2R / 2.5R targets', () => {
  const r = build(longRead());
  const p = r.plan;
  assert.equal(r.mode, 'image');
  assert.equal(p.action, 'LONG');
  assert.equal(p.entry, 4074);
  assert.equal(p.stop, 4062);
  assert.deepEqual(p.targets.map((t) => [t.rr, t.price]), [[1.5, 4092], [2, 4098], [2.5, 4104]]);
  assert.equal(p.preferred, 2.5); // equal highs at 4110 are 3R away
  assert.equal(p.riskUsd, 120);
  assert.equal(p.checklist.reduce((a, b) => a + b.max, 0), 100);
  assert.equal(p.checklist.filter((c) => c.key.startsWith('news')).reduce((a, b) => a + b.max, 0), 12.5);
  assert.ok(p.score >= r.meta.minScore);
  const item = (k) => p.checklist.find((c) => c.key === k);
  assert.equal(item('ote').pts, 4); // 69% retracement of 4064 → 4096
  assert.equal(item('pd').pts, 8); // entry at 22% of the dealing range
  assert.equal(item('room').pts, 8);
  assert.equal(item('smt').label, 'Indicators on your chart');
  assert.equal(item('smt').pts, 2); // 1 of 2 indicators agrees
  assert.equal(r.narrative.length, 10);
});

test('the program overrides a model that scores itself too kindly', () => {
  // a "short" entered at the bottom of the range: the program gives no premium/discount points
  const short = longRead({ bias: { direction: 'bearish' } });
  short.setup = { ...short.setup, direction: 'short', state: 'ready', entry: 4070, stop: 4082, raid: { label: 'High', price: 4081 }, shift_level: 4066, leg: { from: 4081, to: 4064 }, target_liquidity: { label: 'Old low', price: 4064 } };
  short.chart.last_price = 4070;
  const r = build(short);
  assert.equal(r.plan.checklist.find((c) => c.key === 'pd').pts, 0);
  assert.equal(r.plan.action, 'WAIT');
});

test('impossible or unsafe plans from the model are thrown out', () => {
  const wrongSide = longRead(); wrongSide.setup.stop = 4080; // stop above a long entry
  let r = build(wrongSide);
  assert.equal(r.plan.action, 'WAIT');
  assert.equal(r.plan.entry, undefined);
  assert.match(r.plan.reason, /wrong side/);

  const offChart = longRead(); offChart.setup.entry = 9999;
  r = build(offChart);
  assert.equal(r.plan.entry, undefined);
  assert.match(r.plan.reason, /not on the visible chart/);

  const stopped = longRead(); stopped.chart.last_price = 4061.5; // price already through the stop
  assert.match(build(stopped).plan.reason, /beyond the stop/);

  const noRaid = longRead(); noRaid.scores.sweep.pts = 0;
  r = build(noRaid);
  assert.equal(r.plan.action, 'WAIT');
  assert.match(r.plan.reason, /raid and a structure shift/);

  assert.throws(() => build(longRead({ readable: false, problems: 'blurry' })), /blurry/);
});

test('price data on the same market decides the bias; counter-bias trades are refused', () => {
  const engine = (sum) => ({ bias: { dir: Math.sign(sum), label: sum > 0 ? 'Strong Bullish' : 'Strong Bearish', sum, max: 13 }, price: 4090.5, priceMatches: true, sameMarket: true, lines: [], open: { name: 'midnight open', price: 4100 }, h1Trend: Math.sign(sum), plan: { action: 'WAIT', score: 40 } });
  const withBias = build(longRead(), { engine: engine(9) });
  assert.equal(withBias.plan.action, 'LONG');
  assert.equal(withBias.plan.checklist.find((c) => c.key === 'htf').pts, 16);
  assert.equal(withBias.plan.checklist.find((c) => c.key === 'open').pts, 3.5); // long below the midnight open
  const against = build(longRead(), { engine: engine(-9) });
  assert.equal(against.plan.action, 'WAIT');
  assert.match(against.plan.reason, /against the strong bearish higher-timeframe bias/);
});

test('news inside 30 minutes and lunch hour block a screenshot trade too', () => {
  const hot = build(longRead(), { news: { ...calmNews, nextEvent: { title: 'CPI', impact: 'High', minutes: 12, when: 'x' } } });
  assert.equal(hot.plan.action, 'WAIT');
  assert.match(hot.plan.reason, /news/);
  const lunch = build(longRead(), { now: Date.parse('2026-11-10T17:20:00Z') / 1000 });
  assert.match(lunch.plan.reason, /lunch/);
});

test('a raid without a shift is reported as a setup still building', () => {
  const raw = longRead();
  raw.setup = { direction: 'long', state: 'await_confirmation', raid: { label: 'Old low', price: 4064 }, shift_level: 4096, stop: 4063, wait_for: 'a close above 4096' };
  const r = build(raw);
  assert.equal(r.plan.action, 'WAIT');
  assert.equal(r.plan.state, 'await_mss');
  assert.deepEqual([r.plan.setup.mssLevel, r.plan.setup.extreme], [4096, 4063]);
  // a confirmation level on the wrong side of price is discarded
  raw.setup.shift_level = 4080;
  assert.equal(build(raw).plan.state, 'no_setup');
});

/* ---- the HTTP call, against a local stand-in for an OpenAI-compatible API ---- */
function mockApi(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const call = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
        calls.push(call);
        const out = handler(call, calls.length);
        res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.json || {}));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${srv.address().port}/v1`, calls, close: () => new Promise((r) => srv.close(r)) }));
  });
}
const reply = (obj) => ({ json: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`` } }] } });

test('the picture is sent as an image part; providers that reject response_format get a plain retry', async () => {
  const api = await mockApi((call, n) => (n === 1 ? { status: 400, json: { error: 'response_format not supported' } } : reply({ ok: true })));
  try {
    const out = await callVision({ baseUrl: api.base, apiKey: 'k-123', model: 'm', images: [PNG], prompt: 'hello' });
    assert.deepEqual(out, { ok: true });
    assert.equal(api.calls.length, 2);
    assert.equal(api.calls[0].url, '/v1/chat/completions');
    assert.equal(api.calls[0].auth, 'Bearer k-123');
    assert.ok(api.calls[0].body.response_format);
    assert.equal(api.calls[1].body.response_format, undefined);
    const parts = api.calls[1].body.messages[1].content;
    assert.equal(parts[0].type, 'text');
    assert.deepEqual(parts[1], { type: 'image_url', image_url: { url: PNG } });
  } finally { await api.close(); }
});

test('provider errors are explained in plain words', async () => {
  const api = await mockApi((call) => (call.body.model === 'limited' ? { status: 429 } : call.body.model === 'empty' ? { json: { choices: [{ finish_reason: 'length', message: { role: 'assistant', reasoning: 'hmm' } }] } } : { status: 401 }));
  try {
    await assert.rejects(callVision({ baseUrl: api.base, model: 'limited', images: [PNG], prompt: 'x' }), /too many requests/);
    await assert.rejects(callVision({ baseUrl: api.base, model: 'empty', images: [PNG], prompt: 'x' }), /thinking/);
    await assert.rejects(callVision({ baseUrl: api.base, model: 'nokey', images: [PNG], prompt: 'x' }), /refused the key/);
    await assert.rejects(callVision({ baseUrl: 'http://example.com/v1', model: 'm', images: [PNG], prompt: 'x' }), /https:\/\//);
  } finally { await api.close(); }
});

test('same market as the price data: exact engine levels plus the indicators from the picture', async () => {
  const inst = INSTRUMENTS.MGC;
  const d = loadDemo(inst, NOW);
  const run = (extra = {}) => analyze({ inst, tf: d.tf, smt: d.smt, news: calmNews, source: 'live', ...extra });
  const engineResult = run();
  const raw = longRead();
  raw.chart = { ...raw.chart, last_price: engineResult.meta.price, visible_high: engineResult.meta.price + 30, visible_low: engineResult.meta.price - 30 };
  raw.setup = { direction: 'none', state: 'none', wait_for: 'a raid' };
  const api = await mockApi(() => reply(raw));
  try {
    const seen = [];
    const r = await analyzeImages({ inst, images: [PNG], llm: { baseUrl: api.base, model: 'm' }, news: calmNews, engineResult, rerun: async (extra) => { seen.push(extra); return run(extra); }, now: NOW });
    assert.equal(r.mode, 'fusion');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].livePrice, engineResult.meta.price);
    assert.deepEqual(seen[0].indicators, [{ name: 'EMA 20', dir: 1 }, { name: 'RSI 14', dir: 0 }]);
    assert.ok(r.chart.M5, 'keeps the engine chart');
    assert.equal(r.vision.read.indicators.length, 2);
    const keys = r.plan.checklist.map((c) => c.key);
    assert.ok(keys.includes('ind') && keys.includes('smt'));
    assert.equal(r.plan.checklist.reduce((a, b) => a + b.max, 0), 100);
    assert.match(r.narrative[1].title, /Your screenshot/);
    assert.match(api.calls[0].body.messages[1].content[0].text, /REFERENCE DATA/);
    if (r.plan.entry !== undefined) assert.deepEqual(r.plan.targets.map((t) => t.rr), RR_TARGETS);
  } finally { await api.close(); }
});

test('screenshots are validated before anything is sent', async () => {
  const inst = INSTRUMENTS.MGC;
  const llm = { baseUrl: 'http://127.0.0.1:9/v1', model: 'm' };
  await assert.rejects(analyzeImages({ inst, images: [], llm }), /at least one/);
  await assert.rejects(analyzeImages({ inst, images: [PNG, PNG, PNG, PNG, PNG], llm }), /at most 4/);
  await assert.rejects(analyzeImages({ inst, images: ['data:text/html;base64,PGI+'], llm }), /PNG, JPEG or WebP/);
});

test('the no-key provider is the default and every preset is usable', () => {
  assert.equal(PROVIDERS[0].needsKey, false);
  for (const p of PROVIDERS.filter((x) => x.id !== 'custom')) {
    assert.match(p.baseUrl, /^https:\/\//);
    assert.ok(p.models.length > 0);
    if (p.needsKey) assert.match(p.keyUrl, /^https:\/\//);
  }
});
