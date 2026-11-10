'use strict';
// Low-level ICT detectors. Every function works on a plain candle array
// [{t,o,h,l,c,v}] and returns objects that reference candles by index (i) and time (t).

const { atrSeries } = require('./candles');

/** Fractal swing points: a high with k lower highs on each side (and vice versa). */
function findSwings(c, k = 2) {
  const out = [];
  for (let i = k; i < c.length - k; i++) {
    let isH = true;
    let isL = true;
    for (let j = 1; j <= k; j++) {
      if (!(c[i].h > c[i - j].h && c[i].h >= c[i + j].h)) isH = false;
      if (!(c[i].l < c[i - j].l && c[i].l <= c[i + j].l)) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) out.push({ type: 'H', i, t: c[i].t, price: c[i].h, k });
    if (isL) out.push({ type: 'L', i, t: c[i].t, price: c[i].l, k });
  }
  return out;
}

/**
 * Fair value gaps (3-candle imbalances) with their full life cycle:
 * fresh -> tapped -> CE hit -> filled, and inversion (IFVG) when a candle closes through.
 */
function findFVGs(c, atr, minFrac = 0.12) {
  const out = [];
  // typical bar spacing: a gap across a session halt or weekend is an opening gap, not an FVG
  const gaps = [];
  for (let i = Math.max(1, c.length - 200); i < c.length; i++) gaps.push(c[i].t - c[i - 1].t);
  gaps.sort((x, y) => x - y);
  const step = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  const intraday = step > 0 && step <= 3600;
  for (let i = 2; i < c.length; i++) {
    const a = c[i - 2];
    const d = c[i];
    if (intraday && d.t - a.t > 3 * step) continue;
    let g = null;
    if (d.l > a.h) g = { dir: 1, top: d.l, bot: a.h };
    else if (d.h < a.l) g = { dir: -1, top: a.l, bot: d.h };
    if (!g) continue;
    g.size = g.top - g.bot;
    if (g.size < minFrac * atr[i]) continue;
    g.ce = (g.top + g.bot) / 2;
    g.i = i;
    g.t = c[i - 1].t; // drawn from the displacement candle
    g.tCreated = c[i].t;
    g.tapped = false; g.ceHit = false; g.filled = false; g.inverted = false; g.dead = false;
    g.tapI = -1; g.invI = -1; g.endT = null;
    for (let j = i + 1; j < c.length; j++) {
      const b = c[j];
      if (!g.inverted) {
        if (g.dir === 1) {
          if (b.l <= g.top && !g.tapped) { g.tapped = true; g.tapI = j; }
          if (b.l <= g.ce) g.ceHit = true;
          if (b.l <= g.bot) g.filled = true;
          if (b.c < g.bot) { g.inverted = true; g.invI = j; g.invT = b.t; }
        } else {
          if (b.h >= g.bot && !g.tapped) { g.tapped = true; g.tapI = j; }
          if (b.h >= g.ce) g.ceHit = true;
          if (b.h >= g.top) g.filled = true;
          if (b.c > g.top) { g.inverted = true; g.invI = j; g.invT = b.t; }
        }
      } else if ((g.dir === 1 && b.c > g.top) || (g.dir === -1 && b.c < g.bot)) {
        g.dead = true; g.endT = b.t; break; // the inversion failed too
      }
    }
    // direction the zone currently acts in (an inverted bullish FVG is bearish resistance)
    g.actDir = g.inverted ? -g.dir : g.dir;
    g.kind = g.inverted ? 'IFVG' : 'FVG';
    out.push(g);
  }
  return out;
}

/**
 * Market structure from swing points: a close through the last swing in the trend
 * direction is a BOS, a close through the opposite swing is a shift (MSS when it
 * happens with displacement, CHoCH otherwise).
 */
function findStructure(c, swings, atr, fvgs) {
  const fvgAt = new Map();
  for (const g of fvgs) fvgAt.set(g.i, g.dir);
  const displaced = (i, dir) => {
    const body = Math.abs(c[i].c - c[i].o);
    const ref = atr[Math.max(0, i - 1)] || 0;
    if (body >= 1.2 * ref && body >= 0.6 * (c[i].h - c[i].l)) return true;
    return fvgAt.get(i) === dir || fvgAt.get(i + 1) === dir;
  };
  const events = [];
  let trend = 0;
  let hi = null;
  let lo = null;
  let p = 0;
  for (let i = 0; i < c.length; i++) {
    while (p < swings.length && swings[p].i + swings[p].k <= i) {
      const s = swings[p++];
      if (s.type === 'H') hi = s; else lo = s;
    }
    if (hi && c[i].c > hi.price) {
      const disp = displaced(i, 1);
      events.push({ type: trend === -1 ? (disp ? 'MSS' : 'CHoCH') : 'BOS', dir: 1, i, t: c[i].t, level: hi.price, swingI: hi.i, swingT: hi.t, disp });
      trend = 1; hi = null;
    } else if (lo && c[i].c < lo.price) {
      const disp = displaced(i, -1);
      events.push({ type: trend === 1 ? (disp ? 'MSS' : 'CHoCH') : 'BOS', dir: -1, i, t: c[i].t, level: lo.price, swingI: lo.i, swingT: lo.t, disp });
      trend = -1; lo = null;
    }
  }
  return { trend, events, lastHigh: hi, lastLow: lo };
}

/**
 * Order blocks: the last opposite-colour candle before the leg that broke structure.
 * A block that later gets closed through becomes a breaker block acting the other way.
 */
function findOrderBlocks(c, events, fvgs) {
  const out = [];
  const seen = new Set();
  for (const e of events) {
    // origin of the leg = extreme between the broken swing and the break candle
    let m = e.swingI;
    for (let j = e.swingI; j <= e.i; j++) {
      if (e.dir === 1 ? c[j].l < c[m].l : c[j].h > c[m].h) m = j;
    }
    let ob = -1;
    for (let j = m; j >= Math.max(0, m - 4); j--) {
      const opposite = e.dir === 1 ? c[j].c < c[j].o : c[j].c > c[j].o;
      if (opposite) { ob = j; break; }
    }
    if (ob < 0 || seen.has(`${ob}:${e.dir}`)) continue;
    seen.add(`${ob}:${e.dir}`);
    const b = {
      dir: e.dir, i: ob, t: c[ob].t, top: c[ob].h, bot: c[ob].l, open: c[ob].o,
      mid: (c[ob].h + c[ob].l) / 2, breakI: e.i, breakT: e.t, legI: m,
      hasFVG: fvgs.some((g) => g.dir === e.dir && g.i > ob && g.i <= e.i + 1),
      tapped: false, tapI: -1, breaker: false, brI: -1, dead: false, endT: null,
    };
    for (let j = e.i + 1; j < c.length; j++) {
      const x = c[j];
      if (!b.breaker) {
        if (b.dir === 1) {
          if (x.l <= b.top && !b.tapped) { b.tapped = true; b.tapI = j; }
          if (x.c < b.bot) { b.breaker = true; b.brI = j; b.brT = x.t; }
        } else {
          if (x.h >= b.bot && !b.tapped) { b.tapped = true; b.tapI = j; }
          if (x.c > b.top) { b.breaker = true; b.brI = j; b.brT = x.t; }
        }
      } else if ((b.dir === 1 && x.c > b.top) || (b.dir === -1 && x.c < b.bot)) {
        b.dead = true; b.endT = x.t; break;
      }
    }
    b.actDir = b.breaker ? -b.dir : b.dir;
    b.kind = b.breaker ? 'Breaker' : 'OB';
    out.push(b);
  }
  return out;
}

/** Balanced price ranges: overlap of a bullish and a bearish FVG printed close together. */
function findBPRs(fvgs, maxBars = 30) {
  const out = [];
  const live = fvgs.filter((g) => !g.dead);
  for (let a = 0; a < live.length; a++) {
    for (let b = a + 1; b < live.length; b++) {
      const x = live[a];
      const y = live[b];
      if (x.dir === y.dir || y.i - x.i > maxBars) continue;
      const top = Math.min(x.top, y.top);
      const bot = Math.max(x.bot, y.bot);
      if (top > bot) out.push({ top, bot, ce: (top + bot) / 2, i: y.i, t: y.t, dir: y.dir });
    }
  }
  return out;
}

/** Everything the chart and the analyst need for one timeframe. */
function analyzeTF(candles, opts = {}) {
  const k = opts.k || 2;
  const atr = atrSeries(candles, 14);
  const swings = findSwings(candles, k);
  const fvgs = findFVGs(candles, atr, opts.minFvg ?? 0.12);
  const structure = findStructure(candles, swings, atr, fvgs);
  const obs = findOrderBlocks(candles, structure.events, fvgs);
  const bprs = findBPRs(fvgs);
  return { candles, atr, atrNow: atr[atr.length - 1] || 0, swings, fvgs, obs, bprs, ...structure };
}

/**
 * Equal highs / equal lows: clusters of untouched swing points at (almost) the same
 * price. These are the resting-stop pools ICT calls "engineered liquidity".
 */
function findEqualLevels(swings, candles, tol) {
  const out = [];
  for (const type of ['H', 'L']) {
    const pts = swings.filter((s) => s.type === type).filter((s) => {
      for (let j = s.i + 1; j < candles.length; j++) {
        if (type === 'H' ? candles[j].h > s.price + tol : candles[j].l < s.price - tol) return false;
      }
      return true;
    });
    const used = new Set();
    for (let a = 0; a < pts.length; a++) {
      if (used.has(a)) continue;
      const grp = [pts[a]];
      for (let b = a + 1; b < pts.length; b++) {
        if (!used.has(b) && Math.abs(pts[b].price - pts[a].price) <= tol) { grp.push(pts[b]); used.add(b); }
      }
      if (grp.length >= 2) {
        const price = type === 'H' ? Math.max(...grp.map((g) => g.price)) : Math.min(...grp.map((g) => g.price));
        out.push({ type, price, count: grp.length, t: grp[grp.length - 1].t, firstT: grp[0].t });
      }
    }
  }
  return out;
}

module.exports = { findSwings, findFVGs, findStructure, findOrderBlocks, findBPRs, analyzeTF, findEqualLevels };
