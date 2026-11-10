'use strict';
// The analyst: combines the detectors into bias, liquidity map, entry model,
// confluence score and a concrete trade plan (1.5R / 2R / 2.5R).

const { ny, tradingDay, SESSIONS, SILVER_BULLETS, inWin, fmtTime, sessionInfo } = require('./time');
const { TF_SECONDS } = require('./candles');
const { analyzeTF, findEqualLevels, findSwings } = require('./ict');
const { roundTick } = require('./instruments');
const { buildNarrative } = require('./narrative');

// Weights: ICT = 87.5 points, news / world events = 12.5 points (inside the 10–15% band).
const WEIGHTS = {
  htf: 16, room: 8, pd: 8, sweep: 12, mss: 12, array: 9, ote: 4, time: 8, smt: 4, open: 3.5, h1: 3,
  newsSentiment: 7.5, newsCalendar: 5,
};
const RR_TARGETS = [1.5, 2, 2.5];
const MIN_SCORE = 65; // below this the answer is "wait"
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const last = (a) => a[a.length - 1];

/* ----------------------------- key levels ----------------------------- */

function sessionRanges(S, step) {
  const map = new Map();
  for (const b of S) {
    const mins = ny(b.t).mins;
    for (const s of SESSIONS) {
      if (!inWin(mins, s)) continue;
      const day = tradingDay(b.t);
      const key = `${day}|${s.key}`;
      let r = map.get(key);
      if (!r) { r = { day, key: s.key, name: s.name, hi: -Infinity, lo: Infinity, t0: b.t, t1: b.t }; map.set(key, r); }
      if (b.h > r.hi) r.hi = b.h;
      if (b.l < r.lo) r.lo = b.l;
      r.t1 = b.t + step;
    }
  }
  const end = S.length ? last(S).t : 0;
  return [...map.values()].map((r) => ({ ...r, done: end >= r.t1 }));
}

function openAt(S, day, mins) {
  const b = S.find((x) => tradingDay(x.t) === day && ny(x.t).mins >= mins && ny(x.t).mins < mins + 60 && ny(x.t).h < 18);
  return b ? { price: b.o, t: b.t } : null;
}

function keyLevels(tf, S, step, tNow) {
  const D = tf.D || [];
  const W = tf.W || [];
  const today = tradingDay(tNow);
  const iToday = D.length && tradingDay(last(D).t) === today ? D.length - 1 : D.length;
  const cur = D[iToday] || null;
  const prev = D[iToday - 1] || null;
  const prev2 = D[iToday - 2] || null;
  const done = D.slice(0, iToday);
  const ipda = [20, 40, 60].map((n) => {
    const w = done.slice(-n);
    if (w.length < Math.min(n, 10)) return null;
    const hiC = w.reduce((a, b) => (b.h > a.h ? b : a));
    const loC = w.reduce((a, b) => (b.l < a.l ? b : a));
    return { n, days: w.length, hi: hiC.h, lo: loC.l, hiT: hiC.t, loT: loC.t };
  }).filter(Boolean);
  const wCur = W.length ? last(W) : null;
  const wPrev = W.length > 1 ? W[W.length - 2] : null;
  const opens = {
    daily: cur ? { price: cur.o, t: cur.t } : null,
    midnight: openAt(S, today, 0),
    o830: openAt(S, today, 510),
    o930: openAt(S, today, 570),
    weekly: wCur ? { price: wCur.o, t: wCur.t } : null,
  };
  const gaps = [];
  if (cur && prev && Math.abs(cur.o - prev.c) > 0) {
    gaps.push({ name: 'NDOG', top: Math.max(cur.o, prev.c), bot: Math.min(cur.o, prev.c), t: cur.t });
  }
  if (wCur && wPrev && Math.abs(wCur.o - wPrev.c) > 0) {
    gaps.push({ name: 'NWOG', top: Math.max(wCur.o, wPrev.c), bot: Math.min(wCur.o, wPrev.c), t: wCur.t });
  }
  return { today, cur, prev, prev2, ipda, wCur, wPrev, opens, gaps, sessions: sessionRanges(S, step) };
}

/* ----------------------------- liquidity ------------------------------ */

function buildPools(tf, A, KL, S, tNow) {
  const raw = [];
  const add = (side, price, label, t, strength) => {
    if (Number.isFinite(price) && t <= tNow) raw.push({ side, price, label, t, strength });
  };
  const { cur, prev, wCur, wPrev, ipda, sessions, today } = KL;
  if (prev && cur) { add('BSL', prev.h, 'PDH', cur.t, 3); add('SSL', prev.l, 'PDL', cur.t, 3); }
  if (wPrev && wCur) { add('BSL', wPrev.h, 'PWH', wCur.t, 3); add('SSL', wPrev.l, 'PWL', wCur.t, 3); }
  if (ipda[0]) {
    add('BSL', ipda[0].hi, `${ipda[0].days}-day high`, ipda[0].hiT + 86400, 3);
    add('SSL', ipda[0].lo, `${ipda[0].days}-day low`, ipda[0].loT + 86400, 3);
  }
  const days = [...new Set(sessions.map((s) => s.day))].sort().slice(-2);
  for (const s of sessions) {
    if (!s.done || !days.includes(s.day)) continue;
    const pre = s.day === today ? '' : 'Prev ';
    add('BSL', s.hi, `${pre}${s.name} high`, s.t1, 2);
    add('SSL', s.lo, `${pre}${s.name} low`, s.t1, 2);
  }
  const swingPools = (name, a, maxAge, strength, keep) => {
    if (!a) return;
    const step = TF_SECONDS[name];
    const list = a.swings.filter((s) => s.t >= tNow - maxAge).slice(-keep);
    for (const s of list) add(s.type === 'H' ? 'BSL' : 'SSL', s.price, `${name} swing ${s.type === 'H' ? 'high' : 'low'}`, s.t + (s.k + 1) * step, strength);
  };
  swingPools('H4', A.H4, 30 * 86400, 2, 10);
  swingPools('H1', A.H1, 10 * 86400, 2, 16);
  swingPools('M15', A.M15, 3 * 86400, 1, 24);
  if (A.M15) {
    const tol = 0.12 * A.M15.atrNow;
    const recent = A.M15.swings.filter((s) => s.t >= tNow - 4 * 86400);
    for (const e of findEqualLevels(recent, A.M15.candles, tol)) {
      add(e.type === 'H' ? 'BSL' : 'SSL', e.price, e.type === 'H' ? `Equal highs ×${e.count}` : `Equal lows ×${e.count}`, e.t + 4 * 900, 3);
    }
  }

  // when was each level first traded through?
  const H1 = tf.H1 || [];
  const fineStart = S.length ? S[0].t : Infinity;
  const breach = (p) => {
    const hit = (b) => (p.side === 'BSL' ? b.h > p.price : b.l < p.price);
    for (const b of H1) { if (b.t >= fineStart) break; if (b.t >= p.t && hit(b)) return b.t; }
    for (const b of S) if (b.t >= p.t && hit(b)) return b.t;
    return null;
  };
  for (const p of raw) p.takenT = breach(p);

  // merge levels sitting on (almost) the same price
  const tolM = 0.2 * ((A.M15 && A.M15.atrNow) || (A.H1 && A.H1.atrNow / 2) || 0);
  const pools = [];
  for (const side of ['BSL', 'SSL']) {
    const list = raw.filter((p) => p.side === side).sort((a, b) => a.price - b.price);
    let grp = [];
    const flush = () => {
      if (!grp.length) return;
      const best = grp.reduce((a, b) => (b.strength > a.strength ? b : a));
      const price = side === 'BSL' ? Math.max(...grp.map((g) => g.price)) : Math.min(...grp.map((g) => g.price));
      const labels = [...new Set(grp.sort((a, b) => b.strength - a.strength).map((g) => g.label))];
      const taken = grp.map((g) => g.takenT).filter((x) => x !== null);
      pools.push({
        side, price, label: labels.slice(0, 2).join(' + '), labels, strength: Math.min(3, best.strength + (labels.length > 1 ? 0.5 : 0)),
        t: Math.max(...grp.map((g) => g.t)), takenT: taken.length === grp.length ? Math.max(...taken) : null,
      });
      grp = [];
    };
    for (const p of list) {
      if (grp.length && p.price - grp[0].price > tolM) flush();
      grp.push(p);
    }
    flush();
  }
  return pools;
}

/** Where each pool got raided on a given timeframe, and whether price closed back (a sweep). */
function findSweeps(c, pools) {
  const out = [];
  if (!c.length) return out;
  for (const p of pools) {
    if (p.takenT !== null && p.takenT < c[0].t) continue;
    for (let i = 0; i < c.length; i++) {
      if (c[i].t < p.t) continue;
      const through = p.side === 'BSL' ? c[i].h > p.price : c[i].l < p.price;
      if (!through) continue;
      let reclaimI = -1;
      for (let j = i; j <= Math.min(c.length - 1, i + 3); j++) {
        if (p.side === 'BSL' ? c[j].c < p.price : c[j].c > p.price) { reclaimI = j; break; }
      }
      out.push({ pool: p, side: p.side, i, t: c[i].t, reclaimed: reclaimI >= 0, reclaimI });
      break;
    }
  }
  return out;
}

/* ------------------------------- bias --------------------------------- */

const trendWord = (t) => (t > 0 ? 'bullish' : t < 0 ? 'bearish' : 'undefined');

function computeBias(A, KL, price) {
  const votes = [];
  const vote = (label, v, detail) => votes.push({ label, v, detail });
  if (A.D) vote('Daily structure', 3 * A.D.trend, `Daily structure is ${trendWord(A.D.trend)}`);
  if (A.H4) vote('H4 structure', 3 * A.H4.trend, `H4 structure is ${trendWord(A.H4.trend)}`);
  if (A.H1) vote('H1 structure', 2 * A.H1.trend, `H1 structure is ${trendWord(A.H1.trend)}`);
  const { prev, prev2, wCur } = KL;
  if (prev && prev2) {
    let v = 0;
    const d = [];
    if (prev.c > prev2.h) { v += 2; d.push("yesterday closed above the prior day's high (continuation toward buy-side)"); }
    else if (prev.h > prev2.h) { v -= 2; d.push("yesterday raided the prior day's high and closed back inside (failed breakout — draw flips to PDL)"); }
    if (prev.c < prev2.l) { v -= 2; d.push("yesterday closed below the prior day's low (continuation toward sell-side)"); }
    else if (prev.l < prev2.l) { v += 2; d.push("yesterday raided the prior day's low and closed back inside (failed breakdown — draw flips to PDH)"); }
    vote('Previous-day candle', clamp(v, -2, 2), d.length ? d.join('; ') : 'yesterday was an inside day (no daily raid)');
  }
  let react = 0;
  const reacting = [];
  for (const name of ['D', 'H4']) {
    const a = A[name];
    if (!a) continue;
    const recent = a.candles.slice(-3);
    const zones = [...a.fvgs.filter((g) => !g.dead), ...a.obs.filter((b) => !b.dead)];
    for (const z of zones) {
      if (z.i >= a.candles.length - 3) continue;
      const touched = recent.some((b) => b.l <= z.top && b.h >= z.bot);
      const holding = z.actDir === 1 ? price >= z.bot : price <= z.top;
      if (touched && holding) { react += z.actDir; reacting.push(`${name} ${z.actDir === 1 ? 'bullish' : 'bearish'} ${z.kind}`); }
    }
  }
  if (reacting.length) vote('HTF PD array reaction', 2 * Math.sign(react), `price is reacting from ${[...new Set(reacting)].slice(0, 3).join(', ')}`);
  if (wCur) vote('Weekly open', price > wCur.o ? 1 : -1, `price is ${price > wCur.o ? 'above' : 'below'} the weekly open`);
  const sum = votes.reduce((a, b) => a + b.v, 0);
  const dir = sum >= 4 ? 1 : sum <= -4 ? -1 : 0;
  return {
    sum, max: 13, dir, votes,
    label: dir === 0 ? 'Neutral / mixed' : `${Math.abs(sum) >= 8 ? 'Strong ' : ''}${dir === 1 ? 'Bullish' : 'Bearish'}`,
  };
}

/* ---------------------- premium / discount ranges --------------------- */

function dealingRange(a) {
  if (!a || a.candles.length < 30) return null;
  const c = a.candles;
  const major = findSwings(c, 5);
  const sh = major.filter((s) => s.type === 'H').pop();
  const sl = major.filter((s) => s.type === 'L').pop();
  let from = Math.max(0, c.length - 72);
  if (sh && sl) from = Math.min(sh.i, sl.i);
  from = Math.max(from, c.length - 240);
  let hi = -Infinity; let lo = Infinity; let hiT = 0; let loT = 0;
  for (let i = from; i < c.length; i++) {
    if (c[i].h > hi) { hi = c[i].h; hiT = c[i].t; }
    if (c[i].l < lo) { lo = c[i].l; loT = c[i].t; }
  }
  return { hi, lo, eq: (hi + lo) / 2, hiT, loT, t: c[from].t };
}
const posIn = (r, p) => (r && r.hi > r.lo ? clamp((p - r.lo) / (r.hi - r.lo), 0, 1) : 0.5);

/* -------------------------------- SMT --------------------------------- */

function findSMT(a, corr, name, tfName) {
  if (!a || !corr || corr.length < 30) return null;
  const c = a.candles;
  const n = c.length;
  const step = TF_SECONDS[tfName];
  const near = (t, type) => {
    let best = null;
    for (const b of corr) {
      if (b.t < t - 2 * step || b.t > t + 2 * step) continue;
      const v = type === 'L' ? b.l : b.h;
      if (best === null || (type === 'L' ? v < best : v > best)) best = v;
    }
    return best;
  };
  const res = [];
  for (const type of ['L', 'H']) {
    const sw = a.swings.filter((s) => s.type === type && s.i >= n - 80).slice(-2);
    if (sw.length < 2) continue;
    const [s1, s2] = sw;
    const c1 = near(s1.t, type);
    const c2 = near(s2.t, type);
    if (c1 === null || c2 === null) continue;
    const mainDown = s2.price < s1.price;
    const corrDown = c2 < c1;
    if (mainDown === corrDown) continue;
    res.push({
      dir: type === 'L' ? 1 : -1, tf: tfName, t1: s1.t, t2: s2.t, p1: s1.price, p2: s2.price, age: n - 1 - s2.i,
      text: type === 'L'
        ? `${tfName}: this market made a ${mainDown ? 'lower' : 'higher'} low while ${name} made a ${corrDown ? 'lower' : 'higher'} low — bullish SMT divergence at the lows`
        : `${tfName}: this market made a ${mainDown ? 'lower' : 'higher'} high while ${name} made a ${corrDown ? 'lower' : 'higher'} high — bearish SMT divergence at the highs`,
    });
  }
  return res;
}

/* ---------------------------- entry model ----------------------------- */

function detectSetups(dir, tfName, a, sweeps, win, inst) {
  const c = a.candles;
  const n = c.length;
  const out = [];
  if (n < 30) return out;
  const side = dir === 1 ? 'SSL' : 'BSL';
  const adv = (b) => (dir === 1 ? b.l : b.h); // adverse extreme (where the stop goes)
  const fav = (b) => (dir === 1 ? b.h : b.l); // favourable extreme
  const worse = (x, y) => (dir === 1 ? x < y : x > y);
  const evs = sweeps.filter((e) => e.side === side && e.reclaimed && e.i >= n - win).sort((x, y) => y.i - x.i);
  const usedX = new Set();
  const minor = findSwings(c, 2); // the short-term swing whose break is the structure shift
  for (const ev of evs) {
    const ref = minor.filter((s) => s.type === (dir === 1 ? 'H' : 'L') && s.i < ev.i && s.i >= ev.i - 40).pop();
    if (!ref) continue;
    let m = -1;
    for (let j = ev.i; j < n; j++) if (dir * (c[j].c - ref.price) > 0) { m = j; break; }
    let x = ev.i;
    for (let j = ev.i; j <= (m < 0 ? n - 1 : m); j++) if (worse(adv(c[j]), adv(c[x]))) x = j;
    const ext = adv(c[x]);
    // all pools raided by this same swing
    const raided = evs.filter((e) => e.i >= ev.i - 3 && e.i <= x + 1).map((e) => e.pool);
    if (!raided.includes(ev.pool)) raided.push(ev.pool);
    const strength = Math.max(...raided.map((p) => p.strength));
    const swept = [...new Set(raided.sort((p, q) => q.strength - p.strength).map((p) => p.label))].slice(0, 3).join(', ');
    // CISD: close back through the open of the candle run that delivered into the raid
    let r = x;
    while (r > 0 && (dir === 1 ? c[r].c < c[r].o : c[r].c > c[r].o) && x - r < 12) r--;
    const cisdLevel = c[Math.min(r + 1, x)].o;
    let cisdI = -1;
    for (let j = x + 1; j < n; j++) if (dir * (c[j].c - cisdLevel) > 0) { cisdI = j; break; }
    const base = {
      dir, tf: tfName, sweepT: ev.t, sweepI: ev.i, swept, sweepStrength: strength, extreme: ext, extT: c[x].t,
      mssLevel: ref.price, mssRefT: ref.t, cisdLevel, cisd: cisdI >= 0, cisdT: cisdI >= 0 ? c[cisdI].t : null,
    };
    if (usedX.has(x)) continue;
    usedX.add(x);
    if (m < 0) {
      if (n - 1 - x <= 14) out.push({ ...base, state: 'await_mss', mss: false, age: n - 1 - x });
      continue;
    }
    let failed = false;
    for (let j = m + 1; j < n; j++) if (worse(adv(c[j]), ext)) { failed = true; break; }
    if (failed) continue;
    let e = x;
    for (let j = x; j < n; j++) if (dir === 1 ? fav(c[j]) > fav(c[e]) : fav(c[j]) < fav(c[e])) e = j;
    const H = fav(c[e]);
    const range = Math.abs(H - ext);
    if (range <= 0) continue;
    const mssEv = a.events.find((v) => v.i === m && v.dir === dir);
    const legFvgs = a.fvgs.filter((g) => g.dir === dir && g.i > x && g.i <= e + 1);
    const mssDisp = (mssEv && mssEv.disp) || legFvgs.some((g) => g.i <= m + 1);

    // candidate PD arrays to enter on (local = the swing that protects the array)
    const zones = [];
    const ex2 = (i1, i2) => (dir === 1 ? Math.min(c[i1].l, c[i2].l) : Math.max(c[i1].h, c[i2].h));
    for (const g of legFvgs) if (!g.inverted) zones.push({ type: 'FVG', top: g.top, bot: g.bot, from: g.i + 1, t: g.t, fresh: !g.tapped, local: ex2(g.i - 2, g.i - 1) });
    for (const b of a.obs) {
      if (b.dir === dir && !b.breaker && b.i >= x - 4 && b.i <= e) zones.push({ type: 'Order block', top: b.top, bot: b.bot, from: b.breakI + 1, t: b.t, fresh: !b.tapped, local: dir === 1 ? b.bot : b.top });
      if (b.dir === -dir && b.breaker && !b.dead && b.brI >= ev.i - 2 && b.brI <= e) zones.push({ type: 'Breaker', top: b.top, bot: b.bot, from: b.brI + 1, t: b.t, fresh: true, local: dir === 1 ? b.bot : b.top });
    }
    for (const g of a.fvgs) {
      if (g.dir === -dir && g.inverted && !g.dead && g.invI >= x && g.invI <= e) zones.push({ type: 'IFVG', top: g.top, bot: g.bot, from: g.invI + 1, t: g.t, fresh: true, local: dir === 1 ? g.bot : g.top });
    }
    const minRisk = Math.max(0.35 * a.atrNow, 6 * inst.tick);
    const maxRisk = 3 * a.atrNow;
    const buffer = Math.max(0.1 * a.atrNow, 2 * inst.tick);
    const cur = c[n - 1].c;
    let best = null;
    for (const z of zones) {
      const prox = roundTick(inst, dir === 1 ? z.top : z.bot);
      const retr = Math.abs(H - prox) / range;
      if (retr < 0.15 || retr > 0.95 || z.from > n) continue;
      const overlaps = [...new Set(zones.filter((o) => o !== z && o.type !== z.type && o.top >= z.bot && o.bot <= z.top).map((o) => o.type))];
      const ote = retr >= 0.62 && retr <= 0.79;
      const opts = [{ kind: 'raid', level: ext }];
      if (worse(ext, z.local)) opts.push({ kind: 'local', level: z.local });
      for (const o of opts) {
        const stop = roundTick(inst, o.level - dir * buffer);
        const risk = Math.abs(prox - stop);
        if (risk < minRisk || risk > 4.5 * a.atrNow || dir * (prox - stop) <= 0) continue;
        let held = true;
        if (o.kind === 'local') for (let j = z.from; j < n; j++) if (worse(adv(c[j]), o.level)) { held = false; break; }
        if (!held) continue;
        let fillI = -1;
        for (let j = z.from; j < n; j++) if (dir === 1 ? c[j].l <= prox : c[j].h >= prox) { fillI = j; break; }
        let maxR = 0;
        if (fillI >= 0) for (let j = fillI + 1; j < n; j++) maxR = Math.max(maxR, (dir * (fav(c[j]) - prox)) / risk);
        const curR = (dir * (cur - prox)) / risk;
        let state;
        if (fillI < 0) state = 'pending';
        else if (maxR >= 1.5) state = 'done';
        else if (n - 1 - fillI <= 2 || Math.abs(curR) <= 0.3) state = 'in_zone';
        else state = 'triggered';
        // a resting order far from price, or an old one, is not today's trade
        if (state === 'pending' && (n - 1 - m > win || Math.abs(cur - prox) > 6 * a.atrNow)) continue;
        let rank = (ote ? 3 : retr >= 0.5 ? 2 : 1) + (z.type === 'FVG' ? 1 : 0) + (z.fresh ? 0.5 : 0) + (o.kind === 'raid' ? 0.5 : 0);
        if (z.type === 'FVG' && overlaps.includes('Breaker')) rank += 1.5;
        else if (overlaps.length) rank += 0.5;
        if (risk > maxRisk) rank -= 2;
        if (state === 'done') rank -= 10;
        if (!best || rank > best.rank || (rank === best.rank && retr > best.retr)) best = { ...z, prox, retr, risk, stop, stopKind: o.kind, overlaps, ote, rank, state, fillI, maxR, curR };
      }
    }
    if (!best) continue;
    const mssMins = ny(c[m].t).mins;
    out.push({
      ...base, state: best.state, mss: true, mssT: c[m].t, mssDisp, mssType: mssEv ? mssEv.type : 'MSS',
      legHigh: H, legT: c[e].t, entry: best.prox, entryType: best.type, zoneTop: best.top, zoneBot: best.bot, zoneT: best.t,
      ce: roundTick(inst, (best.top + best.bot) / 2), retr: best.retr, ote: best.ote, overlaps: best.overlaps,
      unicorn: best.type === 'FVG' && best.overlaps.includes('Breaker'), stop: best.stop, stopKind: best.stopKind, risk: best.risk,
      fillT: best.fillI >= 0 ? c[best.fillI].t : null, maxR: best.maxR, curR: best.curR, age: n - 1 - m,
      silverBullet: (SILVER_BULLETS.find((w) => inWin(mssMins, w)) || {}).name || null,
      oteZone: [roundTick(inst, H - dir * 0.62 * range), roundTick(inst, H - dir * 0.79 * range)],
    });
  }
  return out;
}

/* ------------------------------ scoring ------------------------------- */

// The parts of the score that do not depend on reading candles. Shared with the
// screenshot mode so both modes judge time and news the same way.
function timeScore(session) {
  const kz = session.killzone;
  let pts = kz ? WEIGHTS.time * kz.quality * 0.88 : 2;
  if (kz && kz.quality > 0 && session.silverBullet) pts = WEIGHTS.time;
  return {
    pts,
    detail: `${session.nyTime} New York. ${kz ? kz.name : 'Outside the killzones'}${session.silverBullet ? ` — ${session.silverBullet.name}` : ''}${session.macro ? ` — macro window ${session.macro}` : ''}.`,
  };
}

function newsScores(dir, news, group) {
  const W = WEIGHTS;
  const sent = news && news.sentiment ? news.sentiment.score : 0;
  const sentiment = {
    pts: W.newsSentiment * (0.5 + 0.5 * clamp(dir * sent, -1, 1)),
    detail: news && news.sentiment ? `${news.sentiment.label} for ${group === 'gold' ? 'gold' : 'the Nasdaq'} (${sent > 0 ? '+' : ''}${sent.toFixed(2)}, ${news.sentiment.method}).` : 'News feed unavailable — scored neutral.',
  };
  const ev = news && news.nextEvent;
  let pts = W.newsCalendar; let detail = 'No high-impact USD release in the next hour.';
  if (ev && ev.minutes >= -5 && ev.minutes <= 30) { pts = 0; detail = `${ev.title} (${ev.impact} impact) ${ev.minutes <= 0 ? 'just released' : `in ${ev.minutes} min`} — stand aside until it prints.`; }
  else if (ev && ev.minutes > 30 && ev.minutes <= 60) { pts = 2.5; detail = `${ev.title} (${ev.impact} impact) in ${ev.minutes} min — expect a liquidity raid on the release.`; }
  else if (!news || !news.calendarOk) { pts = 2.5; detail = 'Economic calendar unavailable — scored half; check it by hand.'; }
  return { sentiment, calendar: { pts, detail }, eventBlock: pts === 0 };
}

/** Hours when no new position should be opened, whatever the chart says. */
function deadHours(session) {
  if (session.mins >= 960 && session.mins < 1080) return 'The trading day is closing (16:00–18:00 New York) — no new positions.';
  if (session.killzone && session.killzone.key === 'lunch') return 'New York lunch hour — price is usually choppy; wait for the PM session.';
  return null;
}

function scoreDirection(dir, setup, ctx) {
  const { bias, A, pools, price, session, smt, opens, news, range, inst } = ctx;
  const W = WEIGHTS;
  const items = [];
  const put = (key, label, max, pts, detail) => items.push({ key, label, max, pts: Math.round(clamp(pts, 0, max) * 10) / 10, detail });
  const word = dir === 1 ? 'long' : 'short';
  const ref = setup && setup.entry !== undefined ? setup.entry : price;

  put('htf', 'Higher-timeframe bias (D / H4 / H1)', W.htf, W.htf * clamp((dir * bias.sum) / 9, 0, 1),
    `Bias score ${bias.sum > 0 ? '+' : ''}${bias.sum} of ±${bias.max} → ${bias.label}. ${dir * bias.sum > 0 ? `Supports ${word}s.` : `Does not support ${word}s.`}`);

  // room to the draw on liquidity
  let room = 0; let roomDetail = 'No entry yet — room is measured once a setup forms.'; let rrMax = null; let draw = null;
  if (setup && setup.entry !== undefined) {
    const targets = pools.filter((p) => p.side === (dir === 1 ? 'BSL' : 'SSL') && p.takenT === null && dir * (p.price - setup.entry) > 0)
      .map((p) => ({ ...p, rr: (dir * (p.price - setup.entry)) / setup.risk }));
    targets.push({ label: `${setup.tf} ${dir === 1 ? 'high' : 'low'} of the displacement leg`, price: setup.legHigh, strength: 2, rr: (dir * (setup.legHigh - setup.entry)) / setup.risk });
    const strong = targets.filter((p) => p.strength >= 2 && p.rr <= 12);
    if (strong.length) {
      draw = strong.reduce((x, y) => (y.rr > x.rr ? y : x));
      rrMax = draw.rr;
      room = W.room * clamp(rrMax / 2.5, 0, 1);
      roomDetail = `Furthest clean draw: ${draw.label} at ${ctx.f(draw.price)} = ${rrMax.toFixed(1)}R from entry.`;
    } else {
      room = W.room * 0.5;
      roomDetail = 'No untouched higher-timeframe liquidity mapped in this direction (price discovery) — targets rely on R-multiples only.';
    }
    const tp1 = setup.entry + dir * 1.5 * setup.risk;
    const blockers = [];
    for (const name of ['H1', 'H4']) {
      const a = A[name];
      if (!a) continue;
      for (const z of [...a.fvgs.filter((g) => !g.dead && !g.filled), ...a.obs.filter((b) => !b.dead && !b.tapped)]) {
        if (z.actDir !== -dir) continue;
        const prox = dir === 1 ? z.bot : z.top;
        if (dir * (prox - setup.entry) > 0.3 * setup.risk && dir * (tp1 - prox) > 0) blockers.push(`${name} ${dir === 1 ? 'bearish' : 'bullish'} ${z.kind} at ${ctx.f(prox)}`);
      }
    }
    if (blockers.length) { room -= 3; roomDetail += ` Obstacle before 1.5R: ${blockers.slice(0, 2).join(', ')}.`; }
  }
  put('room', 'Draw on liquidity / room to target', W.room, room, roomDetail);

  const pos = posIn(range, ref);
  const cheap = dir === 1 ? 1 - pos : pos;
  put('pd', 'Premium / discount', W.pd, W.pd * clamp((cheap - 0.35) / 0.35, 0, 1),
    `${setup && setup.entry !== undefined ? 'Entry' : 'Price'} sits at ${(pos * 100).toFixed(0)}% of the H1 dealing range (${pos > 0.5 ? 'premium' : 'discount'}). ${dir === 1 ? 'Longs belong in discount (<50%).' : 'Shorts belong in premium (>50%).'}`);

  if (setup) {
    put('sweep', 'Liquidity sweep (stop raid)', W.sweep, setup.sweepStrength >= 3 ? W.sweep : setup.sweepStrength >= 2 ? 10 : 7,
      `${dir === 1 ? 'Sell-side' : 'Buy-side'} liquidity raided on ${setup.tf} at ${fmtTime(setup.sweepT)}: ${setup.swept}. Price closed back ${dir === 1 ? 'above' : 'below'} the level.`);
    put('mss', 'Market structure shift + displacement', W.mss, setup.mss ? (setup.mssDisp ? W.mss : 8) : setup.cisd ? 4 : 0,
      setup.mss
        ? `${setup.tf} closed ${dir === 1 ? 'above' : 'below'} ${ctx.f(setup.mssLevel)} at ${fmtTime(setup.mssT)} ${setup.mssDisp ? 'with displacement (energetic candle / FVG left behind)' : 'but without clear displacement'}.`
        : `Not yet. Needs a ${setup.tf} close ${dir === 1 ? 'above' : 'below'} ${ctx.f(setup.mssLevel)}.${setup.cisd ? ' Early sign: change in state of delivery (CISD) already printed.' : ''}`);
    if (setup.entry !== undefined) {
      let htfIn = null;
      for (const name of ['H1', 'H4', 'D']) {
        const a = A[name];
        if (!a || htfIn) continue;
        const z = [...a.fvgs.filter((g) => !g.dead), ...a.obs.filter((b) => !b.dead)].find((q) => q.actDir === dir && setup.entry <= q.top && setup.entry >= q.bot);
        if (z) htfIn = `${name} ${z.kind}`;
      }
      const conf = setup.overlaps.length > 0 || htfIn;
      put('array', 'Entry PD array', W.array, (setup.entryType === 'FVG' ? 7 : 5) + (conf ? 2 : 0),
        `${setup.entryType} ${ctx.f(setup.zoneBot)}–${ctx.f(setup.zoneTop)} on ${setup.tf}${setup.unicorn ? ' overlapping a breaker (Unicorn model)' : setup.overlaps.length ? ` overlapping ${setup.overlaps.join(' + ')}` : ''}${htfIn ? `, sitting inside the ${htfIn}` : ''}.`);
      put('ote', 'Optimal trade entry (62–79%)', W.ote, setup.ote ? W.ote : setup.retr >= 0.5 && setup.retr <= 0.9 ? 2 : 0,
        `Entry is a ${(setup.retr * 100).toFixed(0)}% retracement of the displacement leg. OTE zone: ${ctx.f(setup.oteZone[0])}–${ctx.f(setup.oteZone[1])}.`);
    } else {
      put('array', 'Entry PD array', W.array, 0, 'No entry array yet — it forms with the displacement after the structure shift.');
      put('ote', 'Optimal trade entry (62–79%)', W.ote, 0, 'Measured after the displacement leg prints.');
    }
  } else {
    put('sweep', 'Liquidity sweep (stop raid)', W.sweep, 0, `No recent raid of ${dir === 1 ? 'sell-side' : 'buy-side'} liquidity with a close back inside.`);
    put('mss', 'Market structure shift + displacement', W.mss, 0, 'No valid shift after a raid.');
    put('array', 'Entry PD array', W.array, 0, 'No entry array tied to a raid + shift.');
    put('ote', 'Optimal trade entry (62–79%)', W.ote, 0, 'No displacement leg to measure.');
  }

  const tm = timeScore(session);
  put('time', 'Time of day (killzone)', W.time, tm.pts, tm.detail);

  const s = (smt || []).filter((x) => x.dir === dir && x.age <= 40);
  const against = (smt || []).filter((x) => x.dir === -dir && x.age <= 40);
  const ind = ctx.indicators; // read from the trader's screenshot, when there is one
  const smtMax = ind ? W.smt / 2 : W.smt;
  put('smt', `SMT divergence vs ${inst.smtName}`, smtMax, s.length ? smtMax : 0,
    smt === null ? 'Correlated market data not available — SMT not scored.' : s.length ? s[0].text : against.length ? `Divergence points the other way: ${against[0].text}` : 'No divergence at the recent swings.');
  if (ind) {
    const yes = ind.filter((i) => i.dir === dir); const no = ind.filter((i) => i.dir === -dir);
    put('ind', 'Indicators on your chart', W.smt / 2, ind.length ? (W.smt / 2) * clamp((yes.length - no.length) / ind.length, 0, 1) : 0,
      ind.length ? `${yes.length} of ${ind.length} agree with a ${word}${yes.length ? ` (${yes.map((i) => i.name).join(', ')})` : ''}, ${no.length} against${no.length ? ` (${no.map((i) => i.name).join(', ')})` : ''}, ${ind.length - yes.length - no.length} neutral.` : 'The AI found no indicators on your screenshot.');
  }

  const o = opens.midnight || opens.daily;
  const oName = opens.midnight ? 'midnight open' : 'daily open (18:00)';
  put('open', 'Opening price (Power of 3)', W.open, o && dir * (o.price - ref) > 0 ? W.open : 0,
    o ? `${setup && setup.entry !== undefined ? 'Entry' : 'Price'} is ${ref < o.price ? 'below' : 'above'} the ${oName} ${ctx.f(o.price)}. ${dir === 1 ? 'Longs are best taken below the open (manipulation leg).' : 'Shorts are best taken above the open (manipulation leg).'}` : 'Opening price not available.');

  put('h1', 'H1 order flow', W.h1, A.H1 && A.H1.trend === dir ? W.h1 : 0, A.H1 ? `H1 structure is ${trendWord(A.H1.trend)}.` : 'n/a');

  const ictPts = items.reduce((x, y) => x + y.pts, 0);

  const nw = newsScores(dir, news, inst.group);
  put('newsSentiment', 'News / world-event tone', W.newsSentiment, nw.sentiment.pts, nw.sentiment.detail);
  put('newsCalendar', 'Economic calendar risk', W.newsCalendar, nw.calendar.pts, nw.calendar.detail);

  const total = Math.round(items.reduce((x, y) => x + y.pts, 0) * 10) / 10;
  return { dir, total, ictPts: Math.round(ictPts * 10) / 10, newsPts: Math.round((total - ictPts) * 10) / 10, items, rrMax, draw, eventBlock: nw.eventBlock };
}

const grade = (s) => (s >= 82 ? 'A+' : s >= 73 ? 'A' : s >= MIN_SCORE ? 'B' : s >= 50 ? 'C' : 'No trade');

/* ------------------------------- main --------------------------------- */

function analyze({ inst, tf, smt: smtTf, news, source, clock, indicators, livePrice }) {
  const order = ['M1', 'M5', 'M15', 'H1'];
  const baseName = order.find((k) => tf[k] && tf[k].length >= 30);
  if (!baseName) throw new Error('Not enough price data to analyse (need at least 30 intraday candles).');
  if (!tf.H1 || tf.H1.length < 30) throw new Error('Not enough history: at least 30 hourly candles are required.');
  const fine = tf[baseName];
  const tNow = last(fine).t;
  const price = last(fine).c;
  const f = (p) => Number(p).toLocaleString('en-US', { minimumFractionDigits: inst.decimals, maximumFractionDigits: inst.decimals });

  const A = {};
  const K = { D: 2, H4: 2, H1: 3, M15: 3, M5: 2, M1: 2 };
  for (const name of Object.keys(K)) if (tf[name] && tf[name].length >= 12) A[name] = analyzeTF(tf[name], { k: K[name] });

  const sName = ['M5', 'M15', 'H1'].find((k) => tf[k] && tf[k].length >= 30) || baseName;
  const S = tf[sName];
  const KL = keyLevels(tf, S, TF_SECONDS[sName], tNow);
  const pools = buildPools(tf, A, KL, S, tNow);
  const bias = computeBias(A, KL, price);
  const range = dealingRange(A.H1);
  const session = sessionInfo(tNow);
  const stale = Number.isFinite(clock) && clock - tNow > 45 * 60;

  let smt = null;
  if (smtTf) {
    smt = [];
    for (const name of ['M15', 'M5']) smt.push(...(findSMT(A[name], smtTf[name], inst.smtName, name) || []));
  }

  // entry model on every execution timeframe, both directions
  const wins = { M15: 40, M5: 72, M1: 120 };
  const sweepsByTf = {};
  const setups = [];
  for (const name of ['M15', 'M5', 'M1']) {
    if (!A[name]) continue;
    const sw = findSweeps(A[name].candles, pools);
    sweepsByTf[name] = sw;
    for (const dir of [1, -1]) setups.push(...detectSetups(dir, name, A[name], sw, wins[name], inst));
  }

  const ctx = { bias, A, pools, price, session, smt, opens: KL.opens, news, range, inst, f, indicators: Array.isArray(indicators) ? indicators : null };
  const stateRank = { in_zone: 3, pending: 2, triggered: 1.5, await_mss: 1, done: 0 };
  const tfRank = { M5: 0.3, M15: 0.2, M1: 0.1 };
  const scored = setups.map((s) => ({ setup: s, score: scoreDirection(s.dir, s, ctx) }));
  const live = scored.filter((x) => x.setup.state !== 'done');
  live.sort((x, y) => (y.score.total + stateRank[y.setup.state] + tfRank[y.setup.tf]) - (x.score.total + stateRank[x.setup.state] + tfRank[x.setup.tf]));
  const tradable = live.filter((x) => ['in_zone', 'pending', 'triggered'].includes(x.setup.state));
  const bestTrade = tradable[0] || null;
  const baseline = { 1: scoreDirection(1, null, ctx), [-1]: scoreDirection(-1, null, ctx) };

  let plan;
  const mkTargets = (s, sc) => RR_TARGETS.map((rr) => {
    const p = roundTick(inst, s.entry + s.dir * rr * s.risk);
    const sidePools = pools.filter((q) => q.side === (s.dir === 1 ? 'BSL' : 'SSL') && q.takenT === null && s.dir * (q.price - s.entry) > 0)
      .concat([{ label: `${s.tf} leg ${s.dir === 1 ? 'high' : 'low'}`, price: s.legHigh }])
      .sort((x, y) => s.dir * (x.price - y.price));
    const before = sidePools.filter((q) => s.dir * (p - q.price) >= 0);
    const beyond = sidePools.find((q) => s.dir * (q.price - p) > 0);
    let note;
    if (before.length) note = `takes out ${before.slice(-2).map((q) => `${q.label} (${f(q.price)})`).join(' and ')}`;
    else if (beyond) note = `inside the range — next liquidity is ${beyond.label} at ${f(beyond.price)}`;
    else note = 'no mapped liquidity beyond — R-multiple target only';
    return { rr, price: p, note, backed: sc.rrMax === null ? false : rr <= sc.rrMax + 0.15 };
  });

  if (bestTrade && bestTrade.score.total >= 50) {
    const s = bestTrade.setup;
    const sc = bestTrade.score;
    const tps = mkTargets(s, sc);
    const backed = tps.filter((t) => t.backed);
    const g = grade(sc.total);
    const counter = s.dir * bias.sum <= -4;
    let dead = deadHours(session) || (stale ? 'The market is closed or the data is not current — use this as the plan for the next open.' : null);
    // the screenshot shows a newer price than the delayed feed: re-check the plan against it
    if (Number.isFinite(livePrice)) {
      if (s.dir * (livePrice - s.stop) <= 0) dead = `On your chart price (${f(livePrice)}) has already traded through the stop of this setup (${f(s.stop)}). The idea is finished — wait for a new one.`;
      else if (s.state === 'pending' && s.dir * (livePrice - s.entry) <= 0.3 * s.risk) s.state = 'in_zone';
      else if (s.state !== 'pending' && s.dir * (livePrice - s.entry) >= 1.5 * s.risk) dead = dead || `On your chart price (${f(livePrice)}) is already past the first target of this setup. Do not chase it.`;
    }
    // the furthest mapped liquidity must leave room for at least the first target
    if (!dead && sc.rrMax !== null && sc.rrMax < 1.5) dead = `The furthest liquidity in this direction (${sc.draw.label}) is only ${sc.rrMax.toFixed(1)}R from the entry — no room for a 1.5R trade.`;
    const go = sc.total >= MIN_SCORE && !sc.eventBlock && s.state !== 'triggered' && !counter && !dead;
    plan = {
      action: go ? (s.dir === 1 ? 'LONG' : 'SHORT') : 'WAIT', dir: s.dir, grade: g, score: sc.total, ictPts: sc.ictPts, newsPts: sc.newsPts,
      state: s.state, tf: s.tf, model: s.unicorn ? 'ICT Unicorn (breaker + FVG)' : s.silverBullet ? 'ICT Silver Bullet' : 'ICT 2022 model (raid → MSS → FVG)',
      entry: s.entry, entryType: s.entryType, zone: [s.zoneBot, s.zoneTop], ce: s.ce, stop: s.stop, risk: roundTick(inst, s.risk),
      riskUsd: Math.round(s.risk * inst.pointValue * 100) / 100, targets: tps,
      preferred: (backed.length ? last(backed) : tps[0]).rr, setup: s, checklist: sc.items, draw: sc.draw,
      orderType: s.state === 'pending' ? `${s.dir === 1 ? 'Buy' : 'Sell'} limit` : `${s.dir === 1 ? 'Buy' : 'Sell'} at market / limit at entry`,
      reason: go ? null : dead || (counter ? `This ${s.dir === 1 ? 'long' : 'short'} goes against a ${bias.label.toLowerCase()} higher-timeframe bias — ICT trades with the daily draw, not against it.` : sc.eventBlock ? 'High-impact news is about to print.' : s.state === 'triggered' ? `The entry already filled and price is ${s.curR.toFixed(1)}R away — chasing it would ruin the risk:reward.` : `Confluence ${sc.total}/100 is below the ${MIN_SCORE}-point minimum.`),
    };
  } else {
    const dir = bias.dir !== 0 ? bias.dir : baseline[1].total >= baseline[-1].total ? 1 : -1;
    const watch = live.find((x) => x.setup.dir === dir && x.setup.state === 'await_mss') || live.find((x) => x.setup.state === 'await_mss') || null;
    const sc = watch ? watch.score : baseline[dir];
    plan = {
      action: 'WAIT', dir: watch ? watch.setup.dir : bias.dir, grade: 'No trade', score: sc.total, ictPts: sc.ictPts, newsPts: sc.newsPts,
      state: watch ? 'await_mss' : 'no_setup', setup: watch ? watch.setup : null, checklist: sc.items, targets: [],
      reason: bestTrade ? `Best setup only scores ${bestTrade.score.total}/100.` : watch ? 'Liquidity was raided but structure has not shifted yet.' : 'No raid → shift → entry sequence on the execution timeframes.',
    };
  }

  // what to wait for
  const above = pools.filter((p) => p.side === 'BSL' && p.takenT === null && p.price > price).sort((x, y) => x.price - y.price);
  const below = pools.filter((p) => p.side === 'SSL' && p.takenT === null && p.price < price).sort((x, y) => y.price - x.price);
  plan.wait = [];
  const ltf = A.M5 || A.M15;
  const ltfName = A.M5 ? 'M5' : 'M15';
  const scen = (d) => {
    const raid = (d === 1 ? below : above)[0];
    const tgt = (d === 1 ? above : below).find((p) => p.strength >= 2) || (d === 1 ? above : below)[0];
    const sw = ltf ? ltf.swings.filter((s) => s.type === (d === 1 ? 'H' : 'L')).pop() : null;
    if (!raid) return null;
    return {
      dir: d, raid: raid.price, raidLabel: raid.label, confirm: sw ? sw.price : null, target: tgt ? tgt.price : null, targetLabel: tgt ? tgt.label : null,
      text: `${d === 1 ? 'Long' : 'Short'} scenario: wait for price to raid ${raid.label} at ${f(raid.price)} inside a killzone, then a ${ltfName} close back ${d === 1 ? 'above' : 'below'} ${sw ? f(sw.price) : 'the last swing'} with displacement. Enter on the fair value gap that candle leaves, stop beyond the raid ${d === 1 ? 'low' : 'high'}${tgt ? `, draw on liquidity ${tgt.label} at ${f(tgt.price)}` : ''}.`,
    };
  };
  if (plan.action === 'WAIT') {
    const dirs = bias.dir !== 0 ? [bias.dir] : [1, -1];
    for (const d of dirs) { if (plan.state === 'await_mss' && plan.setup.dir === d) continue; const s = scen(d); if (s) plan.wait.push(s); }
  }

  /* ----------- chart payload (times, not indexes) ----------- */
  const LIMIT = { D: 200, H4: 300, H1: 400, M15: 500, M5: 500, M1: 500 };
  // keep the chart readable: only the zones closest to price, per side
  const nearest = (zs, n) => {
    const d = (z) => (price > z.top ? price - z.top : price < z.bot ? z.bot - price : 0);
    const pick = (dir) => zs.filter((z) => z.actDir === dir).sort((x, y) => d(x) - d(y)).slice(0, n);
    return [...pick(1), ...pick(-1)];
  };
  const chart = {};
  for (const name of Object.keys(A)) {
    const a = A[name];
    const c = a.candles.slice(-LIMIT[name]);
    const t0 = c[0].t;
    chart[name] = {
      candles: c, trend: a.trend, atr: a.atrNow,
      fvgs: nearest(a.fvgs.filter((g) => !g.dead && !(g.filled && !g.inverted)), 4)
        .map((g) => ({ t: Math.max(g.t, t0), top: g.top, bot: g.bot, ce: g.ce, dir: g.actDir, kind: g.kind, tapped: g.tapped })),
      obs: nearest(a.obs.filter((b) => !b.dead), 2)
        .map((b) => ({ t: Math.max(b.t, t0), top: b.top, bot: b.bot, dir: b.actDir, kind: b.kind, tapped: b.tapped })),
      events: a.events.filter((e) => e.t >= t0).slice(-10).map((e) => ({ t: e.t, type: e.type, dir: e.dir, level: e.level, swingT: e.swingT })),
      swings: a.swings.filter((s) => s.t >= t0).map((s) => ({ t: s.t, type: s.type, price: s.price })),
      bprs: a.bprs.filter((b) => b.t >= t0).slice(-4).map((b) => ({ t: b.t, top: b.top, bot: b.bot })),
      sweeps: (sweepsByTf[name] || []).filter((s) => s.t >= t0 && s.reclaimed).sort((x, y) => x.t - y.t).slice(-6).map((s) => ({ t: s.t, side: s.side, price: s.pool.price, label: s.pool.label })),
    };
  }

  const result = {
    meta: {
      symbol: inst.key, name: inst.name, source, price, asOf: tNow, asOfText: fmtTime(tNow), baseTf: baseName,
      tick: inst.tick, pointValue: inst.pointValue, decimals: inst.decimals, smtName: inst.smtName,
      timeframes: Object.keys(A), weights: { ict: 87.5, news: 12.5 }, stale, minScore: MIN_SCORE,
    },
    bias, session, range: range ? { ...range, pos: posIn(range, price) } : null,
    levels: {
      pdh: KL.prev ? KL.prev.h : null, pdl: KL.prev ? KL.prev.l : null, pwh: KL.wPrev ? KL.wPrev.h : null, pwl: KL.wPrev ? KL.wPrev.l : null,
      dayHigh: KL.cur ? KL.cur.h : null, dayLow: KL.cur ? KL.cur.l : null, opens: KL.opens, gaps: KL.gaps, ipda: KL.ipda,
      sessions: KL.sessions.filter((s) => s.day === KL.today || s.done).slice(-8),
    },
    pools: pools.filter((p) => p.takenT === null || p.takenT >= tNow - 2 * 86400)
      .map((p) => ({ side: p.side, price: p.price, label: p.label, strength: p.strength, t: p.t, takenT: p.takenT })),
    liquidity: { above: above.slice(0, 6), below: below.slice(0, 6) },
    smt, plan,
    alternatives: live.filter((x, i, arr) => x !== bestTrade && x.setup !== plan.setup && arr.findIndex((y) => y.setup.dir === x.setup.dir && y.setup.tf === x.setup.tf && y.setup.state === x.setup.state) === i).slice(0, 4).map((x) => ({
      dir: x.setup.dir, tf: x.setup.tf, state: x.setup.state, score: x.score.total, entry: x.setup.entry, stop: x.setup.stop, swept: x.setup.swept,
    })),
    baseline: { long: baseline[1].total, short: baseline[-1].total },
    news: news || null, chart,
  };
  result.narrative = buildNarrative(result, { A, KL, f, inst });
  return result;
}

module.exports = { analyze, WEIGHTS, RR_TARGETS, MIN_SCORE, timeScore, newsScores, deadHours, detectSetups, findSweeps, buildPools, computeBias, keyLevels, grade };
