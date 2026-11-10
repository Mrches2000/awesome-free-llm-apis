'use strict';
const { tradingDay, weekKey, minsSinceOpen } = require('./time');

/** Group consecutive candles sharing the same key into one candle. */
function aggregate(candles, keyFn) {
  const out = [];
  let cur = null;
  let curKey;
  for (const c of candles) {
    const k = keyFn(c.t);
    if (!cur || k !== curKey) {
      cur = { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0 };
      curKey = k;
      out.push(cur);
    } else {
      if (c.h > cur.h) cur.h = c.h;
      if (c.l < cur.l) cur.l = c.l;
      cur.c = c.c;
      cur.v += c.v || 0;
    }
  }
  return out;
}

const KEY = {
  M1: (t) => Math.floor(t / 60),
  M5: (t) => Math.floor(t / 300),
  M15: (t) => Math.floor(t / 900),
  H1: (t) => Math.floor(t / 3600),
  // 4h bars anchored to the 18:00 NY open: 18, 22, 02, 06, 10, 14
  H4: (t) => `${tradingDay(t)}#${Math.floor(minsSinceOpen(t) / 240)}`,
  D: (t) => tradingDay(t),
  W: (t) => weekKey(t),
};
const TF_SECONDS = { M1: 60, M5: 300, M15: 900, H1: 3600, H4: 14400, D: 86400, W: 604800 };
const TF_ORDER = ['M1', 'M5', 'M15', 'H1', 'H4', 'D', 'W'];

/** Rolling average true range, one value per candle. */
function atrSeries(c, n = 14) {
  const out = new Array(c.length).fill(0);
  const trs = [];
  let sum = 0;
  for (let i = 0; i < c.length; i++) {
    const pc = i ? c[i - 1].c : c[i].o;
    const tr = Math.max(c[i].h - c[i].l, Math.abs(c[i].h - pc), Math.abs(c[i].l - pc));
    trs.push(tr);
    sum += tr;
    if (i >= n) sum -= trs[i - n];
    out[i] = sum / Math.min(i + 1, n);
  }
  return out;
}

/** Remove bad rows, sort by time and drop duplicate timestamps. */
function clean(candles) {
  const ok = candles.filter((c) => [c.t, c.o, c.h, c.l, c.c].every((x) => Number.isFinite(x)) && c.h >= c.l);
  ok.sort((a, b) => a.t - b.t);
  const out = [];
  for (const c of ok) {
    if (out.length && out[out.length - 1].t === c.t) out[out.length - 1] = c;
    else out.push(c);
  }
  return out;
}

/** Median spacing between bars, in seconds. */
function detectStep(candles) {
  const d = [];
  for (let i = Math.max(1, candles.length - 300); i < candles.length; i++) d.push(candles[i].t - candles[i - 1].t);
  d.sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)] : 0;
}

module.exports = { aggregate, KEY, TF_SECONDS, TF_ORDER, atrSeries, clean, detectStep };
