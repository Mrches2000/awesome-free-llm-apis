'use strict';
// Price sources: live (Yahoo Finance chart feed), CSV upload (e.g. TradingView export)
// and a built-in simulated market for trying the tool offline.

const { aggregate, KEY, clean, detectStep } = require('./candles');
const { ny } = require('./time');

const UA = process.env.ICT_USER_AGENT || 'Mozilla/5.0 (compatible; ict-analyzer/1.0)';
const cache = new Map();

function derive(tf) {
  if (tf.H1 && tf.H1.length) {
    tf.H4 = aggregate(tf.H1, KEY.H4);
    tf.D = aggregate(tf.H1, KEY.D);
    tf.W = aggregate(tf.H1, KEY.W);
  }
  return tf;
}

/* -------------------------------- live -------------------------------- */

const STEP = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 };

/**
 * The feed appends a "latest trade" row stamped with the current second. Fold any
 * off-grid row into the candle it belongs to so every bar sits on its interval.
 */
function alignBars(bars, step) {
  const out = [];
  for (const b of bars) {
    const t = Math.floor(b.t / step) * step;
    const prev = out[out.length - 1];
    if (prev && prev.t === t) {
      prev.h = Math.max(prev.h, b.h); prev.l = Math.min(prev.l, b.l); prev.c = b.c; prev.v += b.v || 0;
    } else out.push({ ...b, t });
  }
  return out;
}

async function yahooSeries(symbol, interval, days) {
  const key = `${symbol}|${interval}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 20000) return hit.value;
  const p2 = Math.floor(Date.now() / 1000) + 60;
  const p1 = p2 - days * 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&period1=${p1}&period2=${p2}&includePrePost=true`;
  let res;
  try { res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) }); }
  catch (err) { throw new Error(`Cannot reach the live price feed (${(err.cause && err.cause.code) || err.name}). Check your internet connection.`); }
  if (res.status === 429) throw new Error('The live price feed is rate-limiting this computer (HTTP 429). Wait a minute, or use a CSV export / demo data.');
  if (!res.ok) throw new Error(`Live price feed answered HTTP ${res.status} for ${symbol}.`);
  const j = await res.json();
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) throw new Error(`Live price feed returned no candles for ${symbol} (${interval}).`);
  const q = r.indicators.quote[0];
  const value = alignBars(clean(r.timestamp.map((t, i) => ({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }))), STEP[interval]);
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function loadLive(inst) {
  const [H1, M15, M5, M1] = await Promise.all([
    yahooSeries(inst.yahoo, '1h', 180), yahooSeries(inst.yahoo, '15m', 30),
    yahooSeries(inst.yahoo, '5m', 12), yahooSeries(inst.yahoo, '1m', 3).catch(() => []),
  ]);
  let smt = null;
  try {
    const [s15, s5] = await Promise.all([yahooSeries(inst.smt, '15m', 30), yahooSeries(inst.smt, '5m', 12)]);
    smt = { M15: s15, M5: s5 };
  } catch { /* SMT is optional */ }
  const rt = (x) => Number((Math.round(x / inst.tick) * inst.tick).toFixed(inst.decimals));
  for (const arr of [H1, M15, M5, M1]) for (const b of arr) { b.o = rt(b.o); b.h = rt(b.h); b.l = rt(b.l); b.c = rt(b.c); }
  return { tf: derive({ H1, M15, M5, M1 }), smt, source: 'live', note: 'Yahoo Finance futures data, delayed about 10 minutes.' };
}

/* --------------------------------- CSV -------------------------------- */

function parseCsv(text) {
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (rows.length < 31) throw new Error('The CSV needs a header row and at least 30 candles.');
  const delim = rows[0].includes(';') && !rows[0].includes(',') ? ';' : rows[0].includes('\t') ? '\t' : ',';
  const head = rows[0].split(delim).map((s) => s.trim().toLowerCase().replace(/^"|"$/g, ''));
  const col = (...names) => head.findIndex((hd) => names.includes(hd));
  const ix = { t: col('time', 'date', 'datetime', 'timestamp', 'date/time'), o: col('open', 'o'), h: col('high', 'h'), l: col('low', 'l'), c: col('close', 'c', 'last'), v: col('volume', 'vol', 'v') };
  if ([ix.t, ix.o, ix.h, ix.l, ix.c].some((i) => i < 0)) throw new Error('CSV columns not recognised. It needs: time, open, high, low, close (volume optional).');
  const toT = (s) => {
    const raw = s.replace(/^"|"$/g, '');
    if (/^\d+(\.\d+)?$/.test(raw)) { const n = Number(raw); return n > 1e11 ? Math.floor(n / 1000) : n; }
    const d = Date.parse(raw);
    return Number.isFinite(d) ? Math.floor(d / 1000) : NaN;
  };
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i].split(delim);
    out.push({ t: toT(p[ix.t] || ''), o: Number(p[ix.o]), h: Number(p[ix.h]), l: Number(p[ix.l]), c: Number(p[ix.c]), v: ix.v >= 0 ? Number(p[ix.v]) || 0 : 0 });
  }
  return clean(out);
}

function loadCsv(text) {
  const base = parseCsv(text);
  const step = detectStep(base);
  const map = [[60, 'M1'], [300, 'M5'], [900, 'M15'], [3600, 'H1']];
  const start = map.find(([s]) => s === step);
  if (!start) throw new Error(`The CSV timeframe is ${Math.round(step / 60)} minutes. Export a 1, 5, 15 or 60 minute chart.`);
  const tf = {};
  for (const [s, name] of map) if (s >= step) tf[name] = s === step ? base : aggregate(base, KEY[name]);
  return { tf: derive(tf), smt: null, source: 'csv', note: `Your CSV: ${base.length} candles of ${start[1]}. More history gives better higher-timeframe context (aim for 20+ days).` };
}

/* -------------------------------- demo -------------------------------- */

function rng(seed) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = () => Math.sqrt(-2 * Math.log(u() || 1e-9)) * Math.cos(2 * Math.PI * u());
  return { u, n };
}

function marketOpen(t) {
  const x = ny(t);
  if (x.dow === 6) return false;
  if (x.dow === 5 && x.h >= 17) return false;
  if (x.dow === 0 && x.h < 18) return false;
  return x.h !== 17;
}

function sessionVol(mins) {
  if (mins >= 510 && mins < 660) return 1.7; // NY AM
  if (mins >= 120 && mins < 300) return 1.05; // London
  if (mins >= 810 && mins < 960) return 1.2; // NY PM
  if (mins >= 720 && mins < 780) return 0.6; // lunch
  if (mins >= 1080 || mins < 120) return 0.5; // Asia
  return 0.8;
}

/** Simulated market. Deterministic for a given symbol and calendar day. */
function loadDemo(inst, now = Math.floor(Date.now() / 1000)) {
  const seed = [...inst.key].reduce((s, ch) => s * 31 + ch.charCodeAt(0), 7);
  const R = rng(seed);
  const day0 = Math.floor(now / 86400) * 86400;
  const tMinStart = day0 - 12 * 86400;
  const tStart = tMinStart - 130 * 86400;
  const tick = inst.tick;
  const rt = (p) => Math.round(p / tick) * tick;
  let p = inst.demoPrice;
  let q = inst.demoPrice * 0.27; // correlated market
  let drift = 0;
  const H1 = [];
  for (let t = tStart; t < tMinStart; t += 3600) {
    if (!marketOpen(t)) continue;
    if (R.u() < 0.03) drift = R.n() * 0.25;
    const sv = inst.demoVol * Math.sqrt(15) * sessionVol(ny(t).mins);
    const o = p; let h = p; let l = p;
    for (let k = 0; k < 4; k++) { p *= 1 + sv * (R.n() + drift * 0.3); h = Math.max(h, p); l = Math.min(l, p); }
    H1.push({ t, o: rt(o), h: rt(h), l: rt(l), c: rt(p), v: 1000 });
  }
  const M = []; const Q = [];
  let impulse = 0; let impDir = 0;
  for (let t = tMinStart; t <= now; t += 60) {
    if (!marketOpen(t)) continue;
    const mins = ny(t).mins;
    const sv = inst.demoVol * sessionVol(mins);
    if (R.u() < 0.0015) drift = R.n() * 0.25;
    if (impulse <= 0 && R.u() < 0.006 * sessionVol(mins)) { impulse = 3 + Math.floor(R.u() * 6); impDir = R.u() < 0.5 ? -1 : 1; }
    const z = R.n();
    const shock = z + drift * 0.08 + (impulse > 0 ? impDir * (1.6 + R.u()) : 0);
    impulse--;
    const o = p; p *= 1 + sv * shock;
    const wick = () => Math.abs(R.n()) * sv * o * 0.45;
    M.push({ t, o: rt(o), h: rt(Math.max(o, p) + wick()), l: rt(Math.min(o, p) - wick()), c: rt(p), v: Math.round(200 * sessionVol(mins) * (1 + Math.abs(shock))) });
    const qo = q; q *= 1 + sv * 0.8 * (0.85 * shock + 0.55 * R.n());
    Q.push({ t, o: qo, h: Math.max(qo, q) * (1 + sv * 0.2), l: Math.min(qo, q) * (1 - sv * 0.2), c: q, v: 0 });
  }
  const mm = clean(M);
  const tf = {
    H1: clean([...H1, ...aggregate(mm, KEY.H1)]), M15: aggregate(mm, KEY.M15), M5: aggregate(mm, KEY.M5),
    M1: mm.slice(-3 * 1380),
  };
  const qq = clean(Q);
  return {
    tf: derive(tf), smt: { M15: aggregate(qq, KEY.M15), M5: aggregate(qq, KEY.M5) }, source: 'demo',
    note: 'SIMULATED prices for trying the tool. These are not real market prices — do not trade from them.',
  };
}

module.exports = { loadLive, loadCsv, loadDemo, parseCsv, derive, alignBars };
